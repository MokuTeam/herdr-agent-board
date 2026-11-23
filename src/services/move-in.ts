// The target's half of a session moved to another device (#616, core/move-device.ts): the board the
// session goes to makes its folder from git, takes its files by hash, writes them into the profile
// and resumes it there by the archive's Return path (launches.start with `resume`), with its name,
// lane and profile; once the master saw the start on its way it settles the schedule entries.
// The same code on a node (through its door, server/routes/node.ts) and on the master (in process).
//
// The folder: on a node the clone under `node.workRoot` by the repository's address, as a placed
// start has it (services/node/launch.ts); on the master, which has no work folder of its own, the
// folder the session had here before it left (its card's `moved`), when it is a checkout of the
// same repository. Then fetched, and the branch found: the checkout itself when it is on it, else
// the worktree that has it, else a new worktree beside the checkout. Only fast-forwarded: a checkout
// there with changes, or with commits of its own on the branch, is refused, nothing of it lost.
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { readCard, writeCard } from '../adapters/cards.ts'
import { checkoutFacts } from '../adapters/git.ts'
import { grantTrust } from '../adapters/move-files.ts'
import {
  type BlobStore,
  blobStore,
  checkoutChangeList,
  fileHash,
  inHead,
  installBlock,
  installSessionFiles,
  restoreFromHead,
} from '../adapters/move-pack.ts'
import {
  addWorktree,
  cloneRepo,
  fastForward,
  fetchRepo,
  type RepoDone,
  repoIdentity,
  repoState,
  setRepoIdentity,
  worktreeWith,
} from '../adapters/node-repo.ts'
import { stateDir } from '../adapters/paths.ts'
import { restoreEntry } from '../adapters/schedule-store.ts'
import { sameIdentity } from '../core/git-access.ts'
import { UNSAFE_CHARS, worktreePath } from '../core/launch/names.ts'
import { claudeStateFile } from '../core/move.ts'
import { MAX_PACK_FILE_BYTES, type MovePack, movePackOf } from '../core/move-device.ts'
import type { NodeConfig } from '../core/nodes.ts'
import type { ProfileSet } from '../core/profiles.ts'
import type { Card, LaunchView } from '../core/types.ts'
import type { StartResult } from './launch/launches.ts'
import { cloneUrl } from './node/launch.ts'
import { expandHome, loggedIn } from './node/status.ts'

/** The git a move-in needs (adapters/node-repo.ts, adapters/git.ts), handed in so tests can stand in. */
export interface MoveRepoOps {
  clone(url: string, dir: string): Promise<RepoDone>
  fetch(dir: string): Promise<RepoDone>
  state: typeof repoState
  worktreeWith(dir: string, branch: string): Promise<string | null>
  addWorktree(dir: string, path: string, branch: string): Promise<RepoDone>
  fastForward(dir: string, branch: string): Promise<RepoDone>
  identity: typeof repoIdentity
  setIdentity: typeof setRepoIdentity
  /** HEAD and what is not committed in a checkout (adapters/move-pack.ts). */
  changes: typeof checkoutChangeList
  inHead(dir: string, path: string): Promise<boolean>
  restore(dir: string, path: string): Promise<boolean>
  /** The checkout a folder of this computer is in: its root and its remote's address. */
  checkout(dir: string): Promise<{ root: string; address: string | null } | null>
}

export interface MoveInDeps {
  /** This board as a node: its work folder. null on the master. */
  node(): NodeConfig | null
  profiles(): ProfileSet
  /** The board's own launches.start for a resume of `session` (the archive's Return path). */
  start(body: unknown, session: string): Promise<StartResult>
  launch(id: string): LaunchView | undefined
  workspaces(): Promise<{ id: string; label: string | undefined }[]>
  /** The lanes this board has: a session of a lane it lacks comes in as `other`, as from the archive. */
  lanes(): ReadonlySet<string>
  log(text: string): void
  repo?: MoveRepoOps
  blobs?: BlobStore
  home?: string
  platform?: string
  exists?: (file: string) => boolean
}

/** A refusal: `why` is one line for the owner. */
export type MoveInRefusal = { ok: false; error: 'pack' | 'profile' | 'repo' | 'files' | 'launch'; why: string }

export type MoveInCheck = { ok: true; cwd: string; missing: string[] } | MoveInRefusal
export type MoveInCommit = { ok: true; cwd: string; launch: string; notes: string[] } | MoveInRefusal

export interface MoveIn {
  /** Whether the session can come here, its folder made ready, and the blobs still missing. */
  check(raw: unknown): Promise<MoveInCheck>
  /** One file's bytes, kept by their hash until the commit. */
  put(sha: string, body: ReadableStream<Uint8Array> | null): Promise<{ ok: true } | { ok: false; why: string }>
  /** The files written and the session resumed: its launch's id. */
  commit(raw: unknown): Promise<MoveInCommit>
  /** The start is on its way: the schedule entries put in, the blobs dropped. */
  settle(raw: unknown): { ok: true; entries: number } | MoveInRefusal
  /** A launch's state by its id, for the master's wait; null once the board forgot it. */
  launchState(id: string): string | null
}

/** Blobs of a move that never committed go after a day. */
const BLOBS_KEPT_MS = 24 * 3600_000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createMoveIn(d: MoveInDeps): MoveIn {
  const repo: MoveRepoOps = d.repo ?? {
    clone: cloneRepo,
    fetch: fetchRepo,
    state: repoState,
    worktreeWith,
    addWorktree,
    fastForward,
    identity: repoIdentity,
    setIdentity: setRepoIdentity,
    changes: checkoutChangeList,
    inHead,
    restore: restoreFromHead,
    checkout: async dir => {
      const f = await checkoutFacts(dir)
      return f && { root: f.root, address: f.remote?.address ?? null }
    },
  }
  const blobs = d.blobs ?? blobStore(join(stateDir(), 'move-in'))
  const home = d.home ?? homedir()
  const platform = d.platform ?? process.platform
  const exists = d.exists ?? existsSync
  /** One move at a time in a checkout: two clones or worktrees in one folder would fail each other. */
  const chains = new Map<string, Promise<unknown>>()
  function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = next.catch(() => {})
    chains.set(key, tail)
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return next
  }

  const refuse = (error: MoveInRefusal['error'], why: string): MoveInRefusal => ({ ok: false, error, why })

  function packOf(raw: unknown): MovePack | MoveInRefusal {
    const p = movePackOf(raw)
    return 'field' in p ? refuse('pack', `the move's description does not check out (${p.field})`) : p
  }

  function profileOf(p: MovePack): { dir: string } | MoveInRefusal {
    const profile = d.profiles().list.find(x => x.id === p.profile)
    if (!profile) return refuse('profile', `no profile "${p.profile}" here`)
    // On a node, as for a start from the master (services/node/launch.ts); on the master, as Return does: not asked.
    if (d.node() && loggedIn(profile.dir, platform, exists) === false)
      return refuse('profile', `the profile "${p.profile}" is not logged in here`)
    return { dir: profile.dir }
  }

  /** The checkout the session's repository has here, cloned on a node when missing; or why none. */
  async function checkoutRoot(p: MovePack): Promise<{ ok: true; root: string } | MoveInRefusal> {
    const node = d.node()
    if (node) {
      const root = expandHome(node.workRoot, home)
      const checkout = join(root, ...p.folder.address.split('/'))
      // The address rule keeps it below the work folder; checked here too, as the folder is made from it.
      const below = relative(root, checkout)
      if (!below || below.startsWith('..') || isAbsolute(below)) return refuse('repo', 'the address')
      if (!statSync(checkout, { throwIfNoEntry: false })?.isDirectory()) {
        mkdirSync(join(checkout, '..'), { recursive: true })
        const cloned = await repo.clone(cloneUrl(p.folder.address, p.folder.url), checkout)
        if (!cloned.ok) return refuse('repo', `cloning ${p.folder.address} failed: ${cloned.why}`)
      }
      return { ok: true, root: checkout }
    }
    // The master: the folder the session had here before it left.
    const card = readCard(p.session) as (Card & { moved?: { cwd?: unknown } }) | null
    const before = typeof card?.moved?.cwd === 'string' ? card.moved.cwd : ''
    if (!before || !statSync(before, { throwIfNoEntry: false })?.isDirectory())
      return refuse('repo', `no checkout of ${p.folder.address} on this computer is known for it`)
    const c = await repo.checkout(before)
    if (!c || c.address !== p.folder.address)
      return refuse('repo', `${before} is no longer a checkout of ${p.folder.address}`)
    return { ok: true, root: c.root }
  }

  /** The session's folder here at its branch, as the source left it; or why not. */
  function folderFor(
    p: MovePack,
  ): Promise<{ ok: true; cwd: string; at: string; own: Record<string, string | null> } | MoveInRefusal> {
    return oneAtATime(p.folder.address, async () => {
      const got = await checkoutRoot(p)
      if (!got.ok) return got
      const root = got.root
      const fetched = await repo.fetch(root)
      if (!fetched.ok) return refuse('repo', `fetching ${p.folder.address} failed: ${fetched.why}`)
      const branch = p.folder.branch
      const st = await repo.state(root, branch)
      if (!st.ok) return refuse('repo', `${root}: ${st.why}`)
      if (!st.state.target) return refuse('repo', `the remote has no branch ${branch}`)
      let at = st.state.branch === branch ? root : await repo.worktreeWith(root, branch)
      if (!at) {
        const path = worktreePath(root, branch)
        if (exists(path)) return refuse('repo', `${path} is there already and is not on ${branch}`)
        const made = await repo.addWorktree(root, path, branch)
        if (!made.ok) return refuse('repo', `a worktree for ${branch} could not be made: ${made.why}`)
        at = path
      }
      const there = await repo.state(at, branch)
      if (!there.ok) return refuse('repo', `${at}: ${there.why}`)
      // Changes there only when they are the ones that went with the session from here (a move back).
      let own: Record<string, string | null> = {}
      if (!there.state.clean) {
        const left = await leftHere(p.session, at)
        if (!left.ok) return left
        own = left.changes
      }
      if (there.state.head !== there.state.target) {
        const ff = await repo.fastForward(at, branch)
        if (!ff.ok) return refuse('repo', `${at} has commits of its own on ${branch}: ${ff.why}`)
        // A branch ahead of the remote "fast-forwards" to itself: it has commits the source never had.
        const now = await repo.state(at, branch)
        if (!now.ok || now.state.head !== now.state.target)
          return refuse('repo', `${at} has commits of its own on ${branch}`)
      }
      // Changes apply on the commit they were made on, nothing else.
      if (p.files.some(f => f.kind === 'change') || p.folder.deleted.length) {
        const now = await repo.state(at, branch)
        if (!now.ok || now.state.head !== p.folder.head)
          return refuse(
            'repo',
            `${at} is at ${(now.ok ? now.state.head : '?').slice(0, 8)}, and the changes were made on ${p.folder.head.slice(0, 8)}: push or pull so both are at one commit`,
          )
      }
      const cwd = p.folder.subdir ? join(at, ...p.folder.subdir.split('/')) : at
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
        return refuse('repo', `no folder ${p.folder.subdir} in ${at}`)
      // On a node the author the source gives goes into the clone's own config, as for a placed start (#611).
      const given = p.folder.identity
      if (d.node() && given && !sameIdentity(await repo.identity(at), given)) {
        const set = await repo.setIdentity(at, given)
        if (!set.ok) return refuse('repo', `the git identity could not be set: ${set.why}`)
      }
      return { ok: true, cwd, at, own }
    })
  }

  /**
   * The changes of the checkout at `at`, when each is one that went from here with `session` and is
   * as it was then (its card's `moved.changes`, services/move-out.ts finish): a move back takes them
   * as its own and replaces them. Anything else there is the checkout's own, and refused.
   */
  async function leftHere(
    session: string,
    at: string,
  ): Promise<{ ok: true; changes: Record<string, string | null> } | MoveInRefusal> {
    const moved = (readCard(session) as (Card & { moved?: { changes?: unknown } }) | null)?.moved
    const went = moved && typeof moved.changes === 'object' && moved.changes !== null ? moved.changes : {}
    const sent = went as Record<string, unknown>
    const list = await repo.changes(at)
    if (!list) return refuse('repo', `${at} has changes of its own`)
    const odd = list.changes.odd[0]
    if (odd) return refuse('repo', `${at} has changes of its own (${odd.path})`)
    const own: Record<string, string | null> = {}
    for (const f of list.changes.files) {
      const was = Object.hasOwn(sent, f.path) ? sent[f.path] : undefined
      if (typeof was !== 'string' || (await fileHash(join(at, ...f.path.split('/')))) !== was)
        return refuse('repo', `${at} has changes of its own (${f.path})`)
      own[f.path] = was
    }
    for (const path of list.changes.deleted) {
      if (!Object.hasOwn(sent, path) || sent[path] !== null)
        return refuse('repo', `${at} has changes of its own (${path})`)
      own[path] = null
    }
    return { ok: true, changes: own }
  }

  /**
   * The session's uncommitted changes written into the checkout at `at`: what it left here before and
   * no longer has put back as HEAD has it, each changed file through a temp file renamed into place,
   * each deleted one removed. '' when done, else why not.
   */
  async function applyChanges(p: MovePack, at: string, own: Record<string, string | null>): Promise<string> {
    const incoming = p.files.filter(f => f.kind === 'change')
    const comes = new Set([...incoming.map(f => f.path), ...p.folder.deleted])
    const place = (path: string): string => join(at, ...path.split('/'))
    try {
      for (const path of Object.keys(own)) {
        if (comes.has(path)) continue
        if (await repo.inHead(at, path)) {
          if (!(await repo.restore(at, path))) return `${path} could not be put back as HEAD has it`
        } else rmSync(place(path), { force: true })
      }
      for (const f of incoming) {
        const to = place(f.path)
        mkdirSync(dirname(to), { recursive: true })
        const tmp = `${to}.${process.pid}.move.tmp`
        copyFileSync(blobs.path(f.sha256), tmp)
        if (process.platform !== 'win32') chmodSync(tmp, f.mode)
        renameSync(tmp, to)
      }
      for (const path of p.folder.deleted) rmSync(place(path), { force: true })
      return ''
    } catch (err) {
      return messageOf(err)
    }
  }

  async function workspaceFor(label: string): Promise<{ id: string; label: string } | { create: string }> {
    try {
      const found = (await d.workspaces()).find(w => w.label === label)
      if (found) return { id: found.id, label }
    } catch {}
    return { create: label }
  }

  return {
    async check(raw) {
      const p = packOf(raw)
      if ('ok' in p) return p
      const profile = profileOf(p)
      if ('ok' in profile) return profile
      const folder = await folderFor(p)
      if (!folder.ok) return folder
      blobs.sweep(BLOBS_KEPT_MS)
      const missing = [...new Set(p.files.map(f => f.sha256))].filter(sha => !blobs.has(sha))
      return { ok: true, cwd: folder.cwd, missing }
    },

    put: (sha, body) => blobs.put(sha, body, MAX_PACK_FILE_BYTES),

    async commit(raw) {
      const p = packOf(raw)
      if ('ok' in p) return p
      const profile = profileOf(p)
      if ('ok' in profile) return profile
      const missing = p.files.filter(f => !blobs.has(f.sha256))
      if (missing.length) return refuse('files', `${missing.length} of its files did not arrive`)
      const folder = await folderFor(p)
      if (!folder.ok) return folder
      const cwd = folder.cwd
      const changed = await applyChanges(p, folder.at, folder.own)
      if (changed) return refuse('repo', `its uncommitted changes could not be written in ${folder.at}: ${changed}`)
      const t = p.files.find(f => f.kind === 'transcript')
      const block = t ? installBlock(profile.dir, cwd, p.session, blobs.path(t.sha256)) : 'no transcript'
      if (block) return refuse('files', block)
      const put = installSessionFiles(profile.dir, cwd, p.session, p.files, sha => blobs.path(sha))
      if (!put.ok) return refuse('files', put.error)
      const notes: string[] = []
      if (p.trusted) {
        try {
          const r = grantTrust(claudeStateFile(profile.dir, home, platform), cwd, platform)
          if (r === 'copied') notes.push('folder trust given')
        } catch (err) {
          notes.push(`folder trust not given (${messageOf(err)}): Claude will ask once`)
        }
      }
      // As the archive's Return names it: what herdr and a tab take.
      const name =
        p.name
          .replace(new RegExp(UNSAFE_CHARS.source, 'g'), '')
          .replace(/^[\s/-]+/, '')
          .trim()
          .slice(0, 60) || p.session.slice(0, 8)
      const category = d.lanes().has(p.category) ? p.category : 'other'
      let started: StartResult
      try {
        started = await d.start(
          {
            name,
            cwd,
            category,
            workspace: await workspaceFor((p.workspace || p.category || p.name).slice(0, 40)),
            message: '',
            profile: p.profile,
          },
          p.session,
        )
      } catch (err) {
        started = { ok: false, field: 'launch', error: messageOf(err) }
      }
      if (!started.ok) return refuse('launch', `its resume did not start: ${started.error}`)
      // Its name and lane, and no mark of a move away from here before (a move back), once its resume
      // is on its way: a start that failed leaves the mark, and the folder it names, for the next try.
      writeCard(p.session, {
        ...(p.name && { name: p.name }),
        ...(p.category && { category: d.lanes().has(p.category) ? p.category : 'other' }),
        moved: '',
      })
      d.log(`move: ${p.name || p.session} from ${p.from} resumed in ${cwd}`)
      return { ok: true, cwd, launch: started.id, notes }
    },

    settle(raw) {
      const p = packOf(raw)
      if ('ok' in p) return p
      let n = 0
      for (const e of p.entries) {
        try {
          restoreEntry({ ...e, key: p.session, ...(p.name && { name: p.name }) })
          n++
        } catch (err) {
          d.log(`move: an entry of ${p.session} was not put back: ${messageOf(err)}`)
        }
      }
      for (const f of p.files) blobs.drop(f.sha256)
      return { ok: true, entries: n }
    },

    launchState: id => d.launch(id)?.state ?? null,
  }
}
