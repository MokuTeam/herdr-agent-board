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
// stays beside it as `<name>.old` until the next update.
//
// A plugin that is a git checkout (a `.git` folder, or the `.git` file of a worktree; set up by hand)
// is never unpacked over, moved or removed (#793): the archive is dropped and the checkout is updated
// in place with git, on every platform alike (no guard: git rewrites the files where they are, as the
// board's own update from git does, services/self-update.ts). It must be clean, with no commit of its
// own that its remotes lack; the remote is fetched, the lock files and `bun install` come first when
// they change (the old code still runs), then a branch is fast-forwarded to the commit, or a
// detached HEAD checks it out. Anything else (changes, own commits, a commit the remote lacks, a
// branch that does not lead to it) is refused with the reason and the checkout left as it was. A
// `<name>.old` or `<name>.new` that holds a `.git` (a checkout an older board moved there) is kept:
// the update is refused and says so, and the owner moves it away.
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
// record. While a record exists, in any phase (a guard at work, one that died, a go that never
// landed, a board restarted half way that reports no commit), the node answers `busy` to an
// archive and to an update, so a second update never removes `.old` or `.new` from under a guard;
// a record that is never settled is left for a person. A node whose board has no guard to give (an
// older one) answers `platform`.
//
// The installer (entrypoints/install.ts) copies the board's skills into the Claude profiles and
// registers its hooks, so code that came without it leaves those as the old board had them. An
// update that restarts the board writes `<dir>/installer.json` (`{ from, to, at }`) first, on every
// platform and by every path. The board that comes back (`started`, once it stayed up a while)
// runs the installer when it runs `to`, with a dated copy of each settings.json before it, and
// removes the file; on another commit (a rolled back update) it removes the file and runs nothing.
// On Windows that board waits for the guard's record to be settled first (taken as applied, or
// gone): while the guard may still roll back, the file stays. A failing installer is logged, never
// thrown. A board that wires no installer writes and reads no such file.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pause } from '../../adapters/pacing.ts'
import {
  aliveAt,
  backupPlugin,
  besidePlugin,
  claimPending,
  holdsGit,
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
import { bunInstall, gitIn } from '../../adapters/self-update.ts'
import { ARCHIVE_COMMIT_FILE } from '../../core/node-texts.ts'
import { firstLines, lockChanges, planFor } from '../../core/self-update.ts'
import { readTar, type TarEntry } from '../../core/tar.ts'
import type { GitResult, StepResult } from '../self-update.ts'

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
  /** Whether a folder holds a `.git` (a checkout, or a worktree's `.git` file): never unpacked over, moved or removed (#793). */
  holdsGit?: (dir: string) => boolean
  /** git in the plugin's folder (adapters/self-update.ts gitIn), for a checkout's update. */
  git?: (args: string[], timeoutMs?: number) => Promise<GitResult>
  /** A checkout's `bun install` with its lockfile as it is (adapters/self-update.ts bunInstall). */
  installCheckout?: () => Promise<StepResult>
  /** The installer of the code now in the plugin's folder (adapters/self-update.ts runInstaller), run once by the board that comes back on an update's commit; without it an update leaves no file for it. */
  installer?: () => Promise<StepResult>
  /** A dated copy of each settings.json, before the installer writes them (adapters/self-update.ts backupSettings); the files copied. */
  backupSettings?: () => string[]
  log(text: string): void
}

export interface NodeUpdate {
  /** `PUT /api/node/update/blob`: the archive's bytes, kept with their sha256. */
  blob(body: ReadableStream<Uint8Array> | null, told: number | null): Promise<Answer>
  /** `POST /api/node/update`: `{ commit, sha256 }`. */
  update(body: unknown): Promise<Answer>
  /** An update is under way, or done and the board about to restart. */
  busy(): boolean
  /**
   * The board has started: on Windows, one that came back on the commit an update put in place says
   * so (the guard stands down). Then, on every platform, the installer an update left to run.
   */
  started(): Promise<void>
}

/** A checkout's fetch may take this long. */
const FETCH_MS = 120_000
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
  const gitInside = d.holdsGit ?? holdsGit
  const git = d.git ?? ((args: string[], ms?: number) => gitIn(d.root, args, ms))
  const installCheckout = d.installCheckout ?? (() => bunInstall(d.root))
  const pendingFile = join(d.dir, 'pending.json')
  /** A checkout's lock files taken from the commit while bun install runs: `{ from, to, files }`, put back by the next update when the board died in between. */
  const locksFile = join(d.dir, 'git-locks.json')
  /** An update that restarts the board leaves `{ from, to, at }` here: the board that comes back on `to` runs the installer. */
  const markFile = join(d.dir, 'installer.json')
  let busy = false
  /** An archive is coming in: an update, or a second archive, waits for it. */
  let uploading = false
  /** An update under way here, or (Windows) a pending record in any phase. Nothing is read off Windows. */
  const recorded = (): boolean => platform === 'win32' && existsSync(pendingFile)
  const taken = (): boolean => busy || uploading || recorded()

  /** Why this node does not update itself at all, or null. */
  function cannot(): Answer | null {
    if (platform === 'win32' && !d.guard) return refuse(409, 'platform')
    if (!d.canRestart) return refuse(409, 'restart')
    return null
  }

  /** An update about to restart the board leaves word for the installer; a file that cannot be written is said, not thrown. */
  function markInstaller(from: string, to: string): void {
    if (!d.installer) return
    try {
      mkdirSync(d.dir, { recursive: true })
      writeFileSync(markFile, `${JSON.stringify({ from, to, at: Date.now() })}\n`)
    } catch (err) {
      d.log(
        `node: ${markFile} could not be written, so the installer will not run after the update: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Windows: whether the guard's record is settled, so the installer may go: none at all, or one taken here as applied on the running commit. */
  async function settled(): Promise<boolean> {
    const p = readPending(pendingFile)
    // a record that does not parse is still a record
    if (!p) return !existsSync(pendingFile)
    // Only a copy the guard put in place, and only the commit it was given.
    if (p.phase !== 'applied') return false
    if (p.commit !== (await d.commit())) return false
    // The guard may roll back at this very moment: the record goes to one of the two.
    const mine = claimPending(pendingFile)
    if (!mine) return false
    if (mine.phase !== 'applied' || mine.commit !== p.commit) {
      writePending(pendingFile, mine)
      return false
    }
    d.log(
      `node: back on ${short(mine.commit)} after the update; the copy before stays in ${mine.old} until the next update`,
    )
    return true
  }

  /**
   * The installer an update left word for, run by the board that came back on its commit; the file
   * goes either way. Nothing is read but whether the file is there when no update left one.
   */
  async function runMarked(installer: () => Promise<StepResult>): Promise<void> {
    // The board that handed an update over is about to restart: the file is for the next one.
    if (busy || !existsSync(markFile)) return
    try {
      let to = ''
      try {
        const j: unknown = JSON.parse(readFileSync(markFile, 'utf8'))
        const at = j && typeof j === 'object' ? (j as Record<string, unknown>).to : undefined
        if (typeof at === 'string') to = at
      } catch (err) {
        d.log(`node: ${markFile} could not be read: ${err instanceof Error ? err.message : String(err)}`)
      }
      const now = await d.commit()
      if (!to || now !== to) {
        d.log(
          `node: the board runs ${short(now) || 'no commit'}, not ${short(to) || 'the update'}: the installer after the update did not run`,
        )
        return
      }
      let copies: string[] = []
      try {
        copies = d.backupSettings?.() ?? []
      } catch (err) {
        d.log(
          `node: the installer after the update to ${short(to)} did not run: settings.json not copied: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      const r = await installer()
      if (!r.ok) {
        d.log(`node: the installer after the update to ${short(to)} failed: ${firstLines(r.detail, 2) || 'no output'}`)
        return
      }
      d.log(
        `node: the installer ran after the update to ${short(to)}; settings.json copied to ${copies.join(', ') || 'nothing (none there)'}`,
      )
    } catch (err) {
      d.log(`node: the installer after the update did not run: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      try {
        rmSync(markFile, { force: true })
      } catch {}
    }
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

  /** The lock files back as HEAD has them, and the dependencies with them. */
  async function putLocksBack(files: string[], said: (r: GitResult) => string): Promise<void> {
    const r = await git(['checkout', 'HEAD', '--', ...files])
    if (!r.ok) d.log(`node: could not put ${files.join(', ')} back: ${said(r)}`)
    const again = await installCheckout()
    if (!again.ok) d.log(`node: bun install after putting the lock files back failed: ${firstLines(again.detail, 2)}`)
  }

  /**
   * Lock files a board that ended during its checkout's install left taken from the commit: put back,
   * but only while HEAD is where that update started and each file is still as the commit has it (a
   * change of someone's since is left alone). The record goes either way.
   */
  async function mendLocks(said: (r: GitResult) => string): Promise<void> {
    if (!existsSync(locksFile)) return
    try {
      const j: unknown = JSON.parse(readFileSync(locksFile, 'utf8'))
      const { from, to, files } = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>
      const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : []
      if (typeof from === 'string' && typeof to === 'string' && COMMIT.test(to) && list.length) {
        const head = (await git(['rev-parse', 'HEAD'])).out.trim()
        if (head === from && (await git(['diff', '--quiet', to, '--', ...list])).ok) {
          d.log(`node: putting back ${list.join(', ')} left from an update by git that did not finish`)
          await putLocksBack(list, said)
        }
      }
    } catch (err) {
      d.log(`node: ${locksFile} could not be read: ${err instanceof Error ? err.message : String(err)}`)
    }
    rmSync(locksFile, { force: true })
  }

  /**
   * A checkout updated in place with git (#793): nothing of it is moved or removed. A refusal says
   * why and leaves the checkout as it was; the answer is the same as the archive's otherwise.
   */
  async function byGit(commit: string): Promise<Answer> {
    const no = (status: number, error: string, detail: string): Answer => {
      d.log(`node: the update by git to ${short(commit)} is refused (${error}): ${firstLines(detail, 1)}`)
      return refuse(status, error, detail)
    }
    const said = (r: GitResult): string => firstLines(r.err || r.out) || 'git failed'
    removeKept(kept)
    d.log(`node: updating to ${short(commit)}: the plugin is a git checkout, updated in place with git`)
    await mendLocks(said)
    /** A refusal when the tree has changes, else null. */
    const dirty = async (): Promise<Answer | null> => {
      const status = await git(['status', '--porcelain', '--untracked-files=no'])
      if (!status.ok) return no(500, 'git', said(status))
      if (status.out.trim())
        return no(409, 'git-dirty', `the checkout has changes; commit or stash them:\n${firstLines(status.out)}`)
      return null
    }
    const changes = await dirty()
    if (changes) return changes
    // `HEAD` on a detached HEAD, else the branch's name; a git that fails says so
    const branchOf = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branchOf.ok || !branchOf.out.trim()) return no(500, 'git', said(branchOf))
    const branch = branchOf.out.trim() === 'HEAD' ? null : branchOf.out.trim()
    const remote = (branch && (await git(['config', `branch.${branch}.remote`])).out.trim()) || 'origin'
    const fetched = await git(['fetch', '--quiet', remote], FETCH_MS)
    if (!fetched.ok) return no(409, 'git-fetch', `git fetch ${remote}: ${said(fetched)}`)
    // HEAD's commits that no remote branch has: a move away from them could lose them.
    const own = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'])
    if (!own.ok) return no(500, 'git', said(own))
    if (!/^\d+$/.test(own.out.trim())) return no(500, 'git', `git rev-list did not count: ${own.out.trim()}`)
    const ahead = Number(own.out.trim())
    if (ahead > 0)
      return no(409, 'git-ahead', `${ahead} commit(s) of the checkout are on no remote; push them or update by hand`)
    const has = await git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
    if (!has.ok) return no(409, 'git-commit', `${short(commit)} is not on ${remote} after a fetch; push it first`)
    const from = (await git(['rev-parse', 'HEAD'])).out.trim()
    if (branch && !(await git(['merge-base', '--is-ancestor', 'HEAD', commit])).ok)
      return no(409, 'git-diverged', `the branch ${branch} does not lead to ${short(commit)}; update by hand`)
    // The dependencies first, while the old code runs: no code file changes yet.
    const diff = await git(['diff', '--name-only', from, commit])
    if (!diff.ok) return no(500, 'git', said(diff))
    let locks: string[] = []
    if (planFor(diff.out.split(/\r?\n/).filter(Boolean)).install) {
      const ns = await git(['diff', '--name-status', from, commit, '--', 'package.json', 'bun.lock', 'packages'])
      if (!ns.ok) return no(500, 'git', said(ns))
      const lc = lockChanges(ns.out)
      if (lc === 'lockfiles') return no(409, 'git-locks', 'a lock file is added or removed; update by hand')
      locks = lc
    }
    const putBack = async (): Promise<void> => {
      if (!locks.length) return
      await putLocksBack(locks, said)
      rmSync(locksFile, { force: true })
    }
    if (locks.length) {
      // a change made while the fetch ran is not written over
      const late = await dirty()
      if (late) return late
      mkdirSync(d.dir, { recursive: true })
      writeFileSync(locksFile, `${JSON.stringify({ from, to: commit, files: locks })}\n`)
      const co = await git(['checkout', commit, '--', ...locks])
      if (!co.ok) {
        await putBack()
        return no(500, 'install', said(co))
      }
      const installed = await installCheckout()
      if (!installed.ok) {
        await putBack()
        return no(500, 'install', firstLines(installed.detail))
      }
    }
    const moved = branch
      ? await git(['merge', '--ff-only', '--quiet', commit])
      : await git(['checkout', '--quiet', '--detach', commit])
    if (!moved.ok) {
      await putBack()
      return no(500, 'git', said(moved))
    }
    rmSync(locksFile, { force: true })
    d.log(
      `node: updated by git to ${short(commit)}${branch ? ` (${branch} fast-forwarded)` : ' (detached)'}; the board restarts on it`,
    )
    markInstaller(from, commit)
    d.restart(d.root)
    return { status: 200, body: { ok: true, commit, restarting: true } }
  }

  return {
    busy: () => busy || recorded(),
    async started() {
      // Only Windows has such a record; nothing of it is read elsewhere.
      if (platform === 'win32' && !(await settled())) return
      if (d.installer) await runMarked(d.installer)
    },
    async blob(body, told) {
      const no = cannot()
      if (no) {
        await body?.cancel().catch(() => {})
        return no
      }
      if (taken()) {
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
      if (taken()) return refuse(409, 'busy')
      busy = true
      let done = false
      const { fresh, old } = besidePlugin(d.root)
      try {
        const from = await d.commit()
        if (from === commit) {
          removeKept(kept)
          return { status: 200, body: { ok: true, current: true, commit } }
        }
        // A checkout is never unpacked over (#793): git updates it where it is.
        if (gitInside(d.root)) {
          const r = await byGit(commit)
          done = r.status === 200
          return r
        }
        // A copy before or a new copy that holds a .git is someone's checkout: kept, never removed.
        for (const at of [old, fresh])
          if (gitInside(at)) {
            removeKept(kept)
            d.log(
              `node: the update to ${short(commit)} is refused: ${at} holds a .git and is kept; move it away by hand`,
            )
            return refuse(409, 'kept-old', `${at} holds a git checkout (.git) and is kept; move it away by hand`)
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
        // An archive never carries a checkout's .git (git archive has none): one that does is refused.
        if (read.entries.some(e => e.path === '.git' || e.path.startsWith('.git/'))) {
          removeKept(kept)
          return refuse(422, 'archive', 'the archive holds a .git')
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
          dropFresh(fresh)
          return refuse(500, 'unpack', err instanceof Error ? err.message : String(err))
        }
        removeKept(kept)
        const installed = await install(fresh)
        if (!installed.ok) {
          dropFresh(fresh)
          d.log(`node: the update to ${short(commit)} stopped: bun install --production failed`)
          return refuse(500, 'install', installed.detail)
        }
        // A copy whose web board does not load would leave this node with no door to be mended through.
        const loads = await check(fresh)
        if (!loads.ok) {
          dropFresh(fresh)
          d.log(`node: the update to ${short(commit)} stopped: its web board does not load`)
          return refuse(500, 'loads', loads.detail)
        }
        if (platform === 'win32' && d.guard) {
          const no = await handOver(d.guard, { commit, from, fresh, old })
          if (no) return no
          // before the go: the guard may put the copy in place and restart the board at once
          markInstaller(from, commit)
          try {
            go(pendingFile)
          } catch (err) {
            rmSync(markFile, { force: true })
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
          dropFresh(fresh)
          return refuse(500, 'swap', err instanceof Error ? err.message : String(err))
        }
        done = true
        d.log(
          `node: updated to ${short(commit)}; the board restarts on it, the copy before stays in ${old} until the next update`,
        )
        markInstaller(from, commit)
        d.restart(old)
        return { status: 200, body: { ok: true, commit, restarting: true } }
      } finally {
        // Done: still busy until the board has restarted, so a second update waits for the new code.
        if (!done) busy = false
      }
    },
  }
}
