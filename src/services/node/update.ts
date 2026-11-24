// A node's update to its master's commit (#590, docs/design/nodes 6.2, 6.5, 11.3): the door's
// `PUT /api/node/update/blob` keeps the plugin's archive as it comes, then `POST /api/node/update`
// with `{ commit, sha256 }` checks it, unpacks it beside the plugin's folder, runs
// `bun install --production` there, writes the commit's stamp, swaps the two folders and lets the
// board come back on the new code. herdr and every agent pane are left alone: only the board's own
// process restarts (entrypoints/run.ts starts it again from the plugin's folder).
//
// Until the swap nothing of the plugin's folder changes, so a failure at any step before it (a wrong
// sha256, an archive with a path outside, an install without the network, a web board that does not
// load) leaves the old copy in place and working. The swap moves the folder's entries, not the
// folder (adapters/plugin-update.ts swapIn), and puts them back when a move fails. The copy before
// stays beside it as `<name>.old` until the next update. A plugin that is a git checkout (set up by
// hand) is updated the same way: after it the folder is the archive's content with the stamp, and
// the checkout, its own commits too, is in `<name>.old` until the next update removes it.
//
// On Windows (#699) a folder whose files a running process holds open cannot be renamed, and a
// board that writes its own files can be restarted by run.ts half way (it watches src), so the
// last step is the guard's. The board makes a full copy of the plugin in `<name>.old`, writes the
// pending record (`<dir>/pending.json`, phase `ready`), starts the guard (adapters/plugin-update.ts
// startGuard, services/node/update-guard.ts), waits until the guard says it runs, says `go` and
// answers; it writes nothing into the plugin's folder. The guard puts the new copy in place file
// by file with the commit stamp last, touches a code file (run.ts restarts the board on it), and
// puts the copy before back when the board is not back on the new commit within its wait. The
// board that is back (`started`, once its start is whole and it stayed up a while) takes the
// record. A node whose board has no guard to give (an older one) answers `platform`.
import { join } from 'node:path'
import { pause } from '../../adapters/pacing.ts'
import {
  aliveAt,
  backupPlugin,
  besidePlugin,
  claimPending,
  installProduction,
  keepStream,
  loadsIn,
  markGo,
  readKept,
  readPending,
  removeAlive,
  removeKept,
  removePending,
  removeTree,
  swapIn,
  writePending,
  writeTree,
} from '../../adapters/plugin-update.ts'
import { ARCHIVE_COMMIT_FILE } from '../../core/node-texts.ts'
import { readTar, type TarEntry } from '../../core/tar.ts'

/** The archive, at most this many bytes: the board's checkout is about 20 MB as a tar, and the door's server takes 128 MB at most. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
/** `bun install --production` may take this long. */
const INSTALL_MS = 10 * 60_000
/** The new copy's web board loads within this long. */
const LOAD_MS = 60_000

export interface Answer {
  status: number
  body: Record<string, unknown>
}

export interface NodeUpdateDeps {
  /** The plugin's folder (adapters/paths.ts pluginRoot). */
  root: string
  /** `<state>/node/update`: where the archive is kept while it waits. */
  dir: string
  /** The commit this board runs, as its status says it (git in the plugin's folder, else the stamp). */
  commit(): Promise<string>
  platform?: string
  /** Whether something starts the board again when it ends (run.ts, over IPC); without it the node does not update itself. */
  canRestart: boolean
  /** The swap is done: the board comes back on the new code. `old`: where the copy before it went. */
  restart(old: string): void
  install?: (dir: string) => Promise<{ ok: boolean; detail: string }>
  /** Whether the new copy's web board loads (adapters/plugin-update.ts loadsIn), before it goes in. */
  check?: (dir: string) => Promise<{ ok: boolean; detail: string }>
  /** The archive's entries written into a folder (adapters/plugin-update.ts writeTree). */
  unpack?: (dir: string, entries: readonly TarEntry[]) => void
  swap?: (root: string, fresh: string, old: string) => void
  /** Windows: a full copy of the plugin's folder in `old` (adapters/plugin-update.ts backupPlugin). */
  backup?: (root: string, old: string) => Promise<void>
  /**
   * Windows: starts the guard process that puts the new copy in place on `go`, and `old` back when
   * the board does not come back on the new commit (the pending record in `file`). Throws when it
   * cannot start; without it a Windows node does not update itself.
   */
  guard?: (file: string, old: string) => void
  /** Windows: the board says go (the record's phase): the guard puts the new copy in place. */
  go?: (file: string) => void
  /** Windows: when the guard last said it runs (adapters/plugin-update.ts aliveAt). */
  alive?: (file: string) => number | null
  /** Windows: how long the guard may take to say it runs (15 s). */
  ackMs?: number
  log(text: string): void
}

export interface NodeUpdate {
  /** `PUT /api/node/update/blob`: the archive's bytes, kept with their sha256. */
  blob(body: ReadableStream<Uint8Array> | null, told: number | null): Promise<Answer>
  /** `POST /api/node/update`: `{ commit, sha256 }`. */
  update(body: unknown): Promise<Answer>
  /** An update is under way, or done and the board about to restart. */
  busy(): boolean
  /** The board has started: on Windows, one that came back on the commit an update put in place says so (the guard stands down). */
  started(): Promise<void>
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const SHA256 = /^[0-9a-f]{64}$/
const short = (sha: string): string => sha.slice(0, 12)
interface PutIn {
  commit: string
  from: string
  fresh: string
  old: string
}
const refuse = (status: number, error: string, detail?: string): Answer => ({
  status,
  body: { ok: false, error, ...(detail && { detail }) },
})

export function createNodeUpdate(d: NodeUpdateDeps): NodeUpdate {
  const platform = d.platform ?? process.platform
  const kept = join(d.dir, 'plugin.tar')
  const install = d.install ?? (dir => installProduction(dir, INSTALL_MS))
  const check = d.check ?? (dir => loadsIn(dir, LOAD_MS))
  const unpack = d.unpack ?? writeTree
  const swap = d.swap ?? swapIn
  const backup = d.backup ?? backupPlugin
  const go = d.go ?? markGo
  const alive = d.alive ?? aliveAt
  const ackMs = d.ackMs ?? 15_000
  const pendingFile = join(d.dir, 'pending.json')
  let busy = false
  /** An archive is coming in: an update, or a second archive, waits for it. */
  let uploading = false

  /** Why this node does not update itself at all, or null. */
  function cannot(): Answer | null {
    if (platform === 'win32' && !d.guard) return refuse(409, 'platform')
    if (!d.canRestart) return refuse(409, 'restart')
    return null
  }

  /** The new copy beside the plugin dropped; a folder that cannot be removed is said, not thrown. */
  function dropFresh(fresh: string): void {
    try {
      removeTree(fresh)
    } catch (err) {
      d.log(`node: ${fresh} could not be removed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Windows: the copy before, the record, and a guard that says it runs. A refusal when that did
   * not come to be (the plugin's folder is untouched then), else null.
   */
  async function handOver(guard: (file: string, old: string) => void, o: PutIn): Promise<Answer | null> {
    const { commit, from, fresh, old } = o
    try {
      await backup(d.root, old)
    } catch (err) {
      dropFresh(fresh)
      return refuse(500, 'swap', err instanceof Error ? err.message : String(err))
    }
    const t0 = Date.now()
    let why: string
    try {
      removeAlive(pendingFile)
      writePending(pendingFile, { commit, from, root: d.root, old, fresh, phase: 'ready', at: t0 })
      guard(pendingFile, old)
      for (;;) {
        const at = alive(pendingFile)
        if (at !== null && at >= t0) return null
        if (Date.now() >= t0 + ackMs) break
        await pause(250)
      }
      why = `no answer within ${Math.round(ackMs / 1000)} s`
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    }
    removePending(pendingFile)
    removeAlive(pendingFile)
    dropFresh(fresh)
    return refuse(500, 'swap', `the guard that puts the copy before back did not start: ${why}`)
  }

  return {
    busy: () => busy,
    async started() {
      // Nothing is read on a platform that has no such record.
      if (platform !== 'win32') return
      // Only a copy the guard put in place, and only the commit it was given.
      const p = readPending(pendingFile)
      if (p?.phase !== 'applied') return
      if (p.commit !== (await d.commit())) return
      // The guard may roll back at this very moment: the record goes to one of the two.
      const mine = claimPending(pendingFile)
      if (!mine) return
      if (mine.phase !== 'applied' || mine.commit !== p.commit) {
        writePending(pendingFile, mine)
        return
      }
      d.log(
        `node: back on ${short(mine.commit)} after the update; the copy before stays in ${mine.old} until the next update`,
      )
    },
    async blob(body, told) {
      const no = cannot()
      if (no) {
        await body?.cancel().catch(() => {})
        return no
      }
      if (busy || uploading) {
        await body?.cancel().catch(() => {})
        return refuse(409, 'busy')
      }
      if (told !== null && told > MAX_ARCHIVE_BYTES) {
        await body?.cancel().catch(() => {})
        return refuse(413, 'too-big')
      }
      uploading = true
      try {
        const got = await keepStream(body, kept, MAX_ARCHIVE_BYTES)
        if (!got) return refuse(413, 'too-big')
        return { status: 200, body: { ok: true, sha256: got.sha256, size: got.size } }
      } catch (err) {
        return refuse(500, 'blob', err instanceof Error ? err.message : String(err))
      } finally {
        uploading = false
      }
    },
    async update(body) {
      const no = cannot()
      if (no) return no
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
      const commit = typeof b.commit === 'string' ? b.commit : ''
      const sha256 = typeof b.sha256 === 'string' ? b.sha256 : ''
      if (!COMMIT.test(commit) || !SHA256.test(sha256)) return refuse(400, 'update')
      if (busy || uploading) return refuse(409, 'busy')
      busy = true
      let done = false
      const { fresh, old } = besidePlugin(d.root)
      try {
        const from = await d.commit()
        if (from === commit) {
          removeKept(kept)
          return { status: 200, body: { ok: true, current: true, commit } }
        }
        const archive = readKept(kept)
        if (!archive) return refuse(409, 'blob')
        if (archive.sha256 !== sha256) {
          removeKept(kept)
          return refuse(409, 'sha256')
        }
        const read = readTar(archive.bytes)
        if ('error' in read) {
          removeKept(kept)
          d.log(`node: the update to ${short(commit)} is refused: ${read.error}`)
          return refuse(422, 'archive', read.error)
        }
        // `git archive <commit>` names its commit: an archive of another one is not this update.
        if (read.comment !== null && read.comment !== commit) {
          removeKept(kept)
          return refuse(422, 'archive', 'the archive is of another commit')
        }
        d.log(`node: updating to ${short(commit)}: unpacking beside the plugin`)
        // The commit's stamp beside the code: with no .git there, the status reads its commit from it.
        const stamp: TarEntry = {
          kind: 'file',
          path: ARCHIVE_COMMIT_FILE,
          mode: 0o644,
          data: new TextEncoder().encode(`${commit}\n`),
        }
        try {
          unpack(fresh, [...read.entries.filter(e => e.path !== ARCHIVE_COMMIT_FILE), stamp])
        } catch (err) {
          removeTree(fresh)
          return refuse(500, 'unpack', err instanceof Error ? err.message : String(err))
        }
        removeKept(kept)
        const installed = await install(fresh)
        if (!installed.ok) {
          removeTree(fresh)
          d.log(`node: the update to ${short(commit)} stopped: bun install --production failed`)
          return refuse(500, 'install', installed.detail)
        }
        // A copy whose web board does not load would leave this node with no door to be mended through.
        const loads = await check(fresh)
        if (!loads.ok) {
          removeTree(fresh)
          d.log(`node: the update to ${short(commit)} stopped: its web board does not load`)
          return refuse(500, 'loads', loads.detail)
        }
        if (platform === 'win32' && d.guard) {
          const no = await handOver(d.guard, { commit, from, fresh, old })
          if (no) return no
          try {
            go(pendingFile)
          } catch (err) {
            removePending(pendingFile)
            removeAlive(pendingFile)
            dropFresh(fresh)
            return refuse(500, 'swap', err instanceof Error ? err.message : String(err))
          }
          done = true
          d.log(
            `node: the update to ${short(commit)} is handed to the guard, which puts it in place and restarts the board on it; the copy before stays in ${old} until the next update`,
          )
          return { status: 200, body: { ok: true, commit, restarting: true } }
        }
        try {
          swap(d.root, fresh, old)
        } catch (err) {
          removeTree(fresh)
          return refuse(500, 'swap', err instanceof Error ? err.message : String(err))
        }
        done = true
        d.log(
          `node: updated to ${short(commit)}; the board restarts on it, the copy before stays in ${old} until the next update`,
        )
        d.restart(old)
        return { status: 200, body: { ok: true, commit, restarting: true } }
      } finally {
        // Done: still busy until the board has restarted, so a second update waits for the new code.
        if (!done) busy = false
      }
    },
  }
}
