// The source's half of a session moved to another device (#616, core/move-device.ts): the board the
// session runs on checks that its folder travels (git only), puts it to sleep as a profile move
// does (services/move.ts: one at work is refused with the reason, never waited for), and packs it:
// its files with their hashes, its name, lane, profile and schedule entries. The master carries the
// pack to the target; once the target's start is on its way it finishes here: the card is marked
// moved, which hides it while it sleeps (services/board.ts), the entries that went are removed and
// its pane closes. A move that fails after the sleep is called off: one that was awake is woken again.
// The same code on a node (through its door, server/routes/node.ts) and on the master (in process).
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { writeCard } from '../adapters/cards.ts'
import { cwdOf } from '../adapters/claude-home.ts'
import { checkoutFacts, checkoutIdentity, gitInfo } from '../adapters/git.ts'
import { asPane, HerdrError, herdr, paneProcesses } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { findTranscript, trustsFolder } from '../adapters/move-files.ts'
import { checkoutChangeList, fileHash, type ListedFile, listSessionFiles } from '../adapters/move-pack.ts'
import { type MemRow, memoryTable, nothingUnder } from '../adapters/pane-facts.ts'
import { listEntries, removeEntry } from '../adapters/schedule-store.ts'
import { isSidebarPane } from '../core/board-pane.ts'
import { itemProfile } from '../core/item-profile.ts'
import { claudeStateFile } from '../core/move.ts'
import { entriesToCarry, type MovePack, type MoveWhy, moveWhyText, packFolder } from '../core/move-device.ts'
import { projectFolderName, SESSION_ID } from '../core/resume.ts'
import type { Item } from '../core/types.ts'
import { wake } from './actions.ts'
import type { Deps } from './deps.ts'
import { type SleepOutcome, sleepMany } from './sleep.ts'

export type PackResult =
  | { ok: true; pack: MovePack; key: string; wasAwake: boolean }
  | { ok: false; why: string; kind?: MoveWhy['kind'] | 'gone' | 'busy'; sleep?: SleepOutcome }

export interface MoveOut {
  /**
   * The session `key` checked, put to sleep and packed; `from`: this board's id as the master names
   * it. `dryRun`: only checked and listed, nothing put to sleep or kept (the list shown before a move).
   */
  pack(key: string, from: string, dryRun?: boolean): Promise<PackResult>
  /** The file `n` of the pack of `session` on this computer, while its move is on its way; null when none. */
  file(session: string, n: number): string | null
  /** The move called off: the session woken again when it was awake before. */
  abort(session: string): Promise<{ ok: true; woken: boolean }>
  /** The move done: marked moved, its entries that went removed, its pane closed. */
  finish(session: string, to: string): Promise<{ ok: true; notes: string[] } | { ok: false; why: string }>
}

export interface MoveOutDeps {
  deps: Deps
  items(): Item[]
  log(text: string): void
  home?: string
  platform?: string
  /** Process table check where herdr omits child processes under a shell (Windows); null elsewhere. */
  processTable?: (() => Promise<readonly MemRow[] | null>) | null
  /** git's facts of a folder (adapters/git.ts), handed in so tests can stand in. */
  git?: {
    checkout: typeof checkoutFacts
    info: typeof gitInfo
    identity: typeof checkoutIdentity
    changes?: typeof checkoutChangeList
  }
}

interface Packed {
  item: Item
  /** The pane snapshotted at pack time so finish() only closes it if terminal_id and label still match. */
  pane: { id: string; terminal: string | null; label: string } | null
  files: ListedFile[]
  entries: string[]
  wasAwake: boolean
  cwd: string
  at: number
  /** What was not committed and went with it: a changed file's hash, null for one deleted. */
  changes: Record<string, string | null>
}

/** A pack is kept this long for the master to fetch its files. */
const PACK_KEPT_MS = 60 * 60_000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const paneGone = (err: unknown): boolean => err instanceof HerdrError && err.code === 'pane_not_found'

export function createMoveOut(o: MoveOutDeps): MoveOut {
  const { deps } = o
  const home = o.home ?? homedir()
  const platform = o.platform ?? process.platform
  const processTable = o.processTable === undefined ? (platform === 'win32' ? memoryTable : null) : o.processTable
  const git = o.git ?? { checkout: checkoutFacts, info: gitInfo, identity: checkoutIdentity }
  const changes = git.changes ?? checkoutChangeList
  const packs = new Map<string, Packed>()
  const drop = (): void => {
    const now = Date.now()
    for (const [s, p] of packs) if (now - p.at > PACK_KEPT_MS) packs.delete(s)
  }

  const no = (why: MoveWhy): PackResult => ({ ok: false, why: moveWhyText(why), kind: why.kind })

  /**
   * The folder's facts as core/move-device.ts packFolder reads them, and what is not committed there
   * with each file's place on this computer (#616 part 2).
   */
  async function folderOf(cwd: string) {
    const [facts, info, identity] = await Promise.all([git.checkout(cwd), git.info(cwd), git.identity(cwd)])
    const branch = info && info.branch !== 'HEAD' ? info.branch : ''
    const rel = facts ? relativeSub(facts.root, cwd) : null
    const list = facts ? await changes(facts.root) : null
    const folder = packFolder({
      checkout: facts && {
        root: facts.root,
        url: facts.remote?.address ? facts.remote.url : null,
        clean: facts.clean,
        branch,
        pushed: facts.headPushed && !!branch,
        head: list?.head ?? '',
      },
      subdir: rel,
      identity,
      changes: list?.changes ?? null,
    })
    return { folder, root: facts?.root ?? '', changed: list?.changes.files ?? [] }
  }

  /** The changes of the folder's checkout, each changed file with its hash and its place here. */
  async function changedFiles(root: string, files: readonly { path: string }[]): Promise<ListedFile[]> {
    const out: ListedFile[] = []
    for (const f of files) {
      const abs = join(root, ...f.path.split('/'))
      const st = statSync(abs)
      out.push({
        kind: 'change',
        path: f.path,
        size: st.size,
        sha256: await fileHash(abs),
        mode: process.platform !== 'win32' && st.mode & 0o111 ? 0o755 : 0o644,
        abs,
      })
    }
    return out
  }

  return {
    async pack(key, from, dryRun = false) {
      drop()
      const items = o.items()
      const item = items.find(i => i.key === key)
      if (!item) return { ok: false, why: 'no such session on the board', kind: 'gone' }
      if (item.agent !== 'claude' || !item.session || !SESSION_ID.test(item.session)) return no({ kind: 'not-claude' })
      const session = item.session
      // One move of a session at a time: a second would take the first's pack, and its call-off.
      if (packs.has(session)) return { ok: false, why: 'a move of it is on its way already', kind: 'busy' }
      const list = deps.profiles().list
      const profile = itemProfile(item, list)
      const dir = profile?.dir ?? item.profileFolder
      if (!profile || !dir) return no({ kind: 'profile' })
      // The card's path may be from a read before the file moved: the one on disk now.
      const known = item.transcript && existsSync(item.transcript) ? item.transcript : null
      const transcript = known || findTranscript(dir, session, item.cwd)
      if (!transcript) return no({ kind: 'no-transcript' })
      // Claude resumes a session from the folder whose project folder holds its conversation. A
      // session moved here before has the source device's folder in its first lines (#621): the
      // folder it runs in (its card's) is taken first when the transcript lies under it.
      const recorded = await cwdOf(transcript)
      const under = basename(dirname(transcript))
      const cwd =
        [item.cwd, recorded].find(c => !!c && projectFolderName(c) === under && existsSync(c)) || recorded || item.cwd
      if (!cwd) return no({ kind: 'no-checkout' })
      // A dry run says now what the move would say: one at work is not taken.
      if (dryRun && !item.sleeping && item.status === 'working')
        return { ok: false, why: 'it is not free: try again when it is', kind: 'busy' }
      const first = await folderOf(cwd)
      if (!first.folder.ok) return no(first.folder.why)
      // Asleep first, as a profile move: its transcript is final before it is copied.
      let wasAwake = false
      if (!item.sleeping && !dryRun) {
        const [s] = await sleepMany(deps, items, [key], { by: 'user' })
        if (!s || (s.result !== 'asleep' && s.result !== 'already'))
          return { ok: false, why: 'it is not free: try again when it is', kind: 'busy', ...(s && { sleep: s }) }
        wasAwake = s.result === 'asleep'
      }
      const wakeBack = async (): Promise<void> => {
        if (wasAwake) await wake(deps, { ...item, pane: null, sleeping: true }).catch(() => {})
      }
      // Its last turn may have written in the folder: what travels is checked again once it is asleep.
      const again = wasAwake ? await folderOf(cwd) : first
      const after = again.folder
      if (!after.ok) {
        await wakeBack()
        return no(after.why)
      }
      const listed = await listSessionFiles(dir, session, cwd)
      if (!listed.ok) {
        await wakeBack()
        return listed.error === 'no-transcript' ? no({ kind: 'no-transcript' }) : { ok: false, why: listed.error }
      }
      let changed: ListedFile[]
      try {
        changed = await changedFiles(again.root, again.changed)
      } catch (err) {
        await wakeBack()
        return { ok: false, why: `its changes could not be read: ${messageOf(err)}` }
      }
      const all = [...listed.files, ...changed]
      const carried = entriesToCarry(listEntries(), key)
      let trusted = false
      try {
        trusted = trustsFolder(claudeStateFile(dir, home), cwd)
      } catch {}
      let pane: Packed['pane'] = null
      if (!dryRun && item.pane) {
        try {
          const got = await herdr<{ pane?: unknown }>(['pane', 'get', item.pane], 10_000)
          const live = asPane(got?.pane)
          if (live) pane = { id: item.pane, terminal: live.terminal_id || null, label: live.label ?? '' }
        } catch (err) {
          // Transient read failure still prevents closing by pane id alone (no terminal_id match).
          if (!paneGone(err)) pane = { id: item.pane, terminal: null, label: '' }
        }
      }
      if (!dryRun)
        packs.set(session, {
          item,
          pane,
          files: all,
          entries: carried.map(e => e.id),
          wasAwake,
          cwd,
          at: Date.now(),
          changes: Object.fromEntries([
            ...changed.map(f => [f.path, f.sha256] as const),
            ...after.folder.deleted.map(p => [p, null] as const),
          ]),
        })
      const pack: MovePack = {
        v: 1,
        session,
        name: item.name,
        category: item.category,
        profile: profile.id,
        workspace: item.workspace ?? '',
        cwd,
        folder: after.folder,
        files: all.map(({ abs: _abs, ...f }) => f),
        entries: carried,
        trusted,
        from,
      }
      if (!dryRun) o.log(`move: ${item.name} packed, ${pack.files.length} file(s)`)
      return { ok: true, pack, key, wasAwake }
    },

    file(session, n) {
      return packs.get(session)?.files[n]?.abs ?? null
    },

    async abort(session) {
      const p = packs.get(session)
      packs.delete(session)
      if (!p?.wasAwake) return { ok: true, woken: false }
      const r = await wake(deps, { ...p.item, pane: null, sleeping: true }).catch(() => ({ ok: false }))
      deps.wake.forget()
      return { ok: true, woken: r.ok }
    },

    async finish(session, to) {
      const p = packs.get(session)
      if (!p) return { ok: false, why: 'no move of it is on its way here' }
      packs.delete(session)
      const notes: string[] = []
      // What of the checkout went with it, so a move back here takes these same changes as its own.
      const changed = Object.keys(p.changes).length
      writeCard(p.item.key, { moved: { to, cwd: p.cwd, at: Date.now(), ...(changed && { changes: p.changes }) } })
      if (changed) notes.push(`its ${changed} uncommitted change(s) went with it and stay here too`)
      for (const id of p.entries) removeEntry(id, 'cancelled')
      // Its pane, when wake left it as a shell: nobody is in it now, and only when it is still the same pane.
      const pane = p.pane
      if (pane) {
        try {
          const got = await herdr<{ pane?: unknown }>(['pane', 'get', pane.id], 10_000)
          const live = asPane(got?.pane)
          if (live && !live.agent) {
            const samePane = !!pane.terminal && live.terminal_id === pane.terminal && (live.label ?? '') === pane.label
            if (!samePane) {
              notes.push('its pane was left (its pane changed)')
            } else {
              // Only a shell nobody uses: a program started in it since (a server, the owner's own) keeps it.
              const procs = await paneProcesses(pane.id, 10_000)
              const others = procs ? procs.foreground.filter(pr => pr.pid !== procs.shell) : null
              if (platform !== 'win32') {
                if (procs && !others?.length) {
                  await herdr(['pane', 'close', pane.id])
                  notes.push('its pane closed')
                }
              } else {
                const winClear = processTable
                  ? await processTable()
                      .then(rows => (rows ? nothingUnder(rows, procs?.shell ?? -1) === true : false))
                      .catch(() => false)
                  : true
                if (procs && !others?.length && winClear) {
                  let closeTab = false
                  if (live.workspace_id && live.tab_id) {
                    const answer = await herdr(['pane', 'list', '--workspace', live.workspace_id], 10_000).catch(
                      () => null,
                    )
                    const raw = isRecord(answer) && Array.isArray(answer.panes) ? answer.panes : []
                    const inTab = raw
                      .map(asPane)
                      .filter((x): x is NonNullable<ReturnType<typeof asPane>> => !!x && x.tab_id === live.tab_id)
                    if (
                      inTab.some(x => x.pane_id === pane.id) &&
                      inTab.every(x => x.pane_id === pane.id || isSidebarPane(x, platform))
                    )
                      closeTab = true
                  }
                  await herdr(closeTab && live.tab_id ? ['tab', 'close', live.tab_id] : ['pane', 'close', pane.id])
                  notes.push('its pane closed')
                }
              }
            }
          } else if (live?.agent) {
            notes.push('its pane was left (an agent runs in it)')
          }
        } catch (err) {
          if (!paneGone(err)) notes.push(`its pane was left (${messageOf(err)})`)
        }
      }
      deps.wake.forget()
      return { ok: true, notes }
    },
  }
}

/** The folder below a checkout's root with '/' between, '' for the root; null when it is not below (as the placer reads it). */
function relativeSub(root: string, cwd: string): string | null {
  const below = relative(root, cwd)
  if (!below) return ''
  if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return null
  return below.split(sep).join('/')
}
