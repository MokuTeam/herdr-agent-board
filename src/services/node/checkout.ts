// A repository as a folder of this computer (#504, docs/design/nodes 8.4): a checkout of it this
// computer already has (#816: `node.repos`, else one its sessions or Claude ran in), else
// `<workRoot>/<host>/<path>`, cloned when missing, fetched, and moved to the branch asked for only
// when nothing of this computer's own would be lost. The owner's own checkout is only fetched and
// fast-forwarded when clean on the branch asked for; anything else gets a worktree of its own
// outside it. A node does it for a start its master sends (services/node/launch.ts);
// a master does it for a start a node's session asked for that it runs itself (#760,
// services/nodes/placer.ts). The address is checked here by the board's own rule
// (core/portable.ts repoAddress), never taken from the other side's word as a folder name.
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import {
  addWorktreeFrom,
  checkoutRemotes,
  cloneRepo,
  fetchRepo,
  isAncestor,
  moveTo,
  type RepoDone,
  type RepoState,
  repoIdentity,
  repoState,
  setRepoIdentity,
  worktreeWith,
} from '../../adapters/node-repo.ts'
import { type GitIdentity, sameIdentity } from '../../core/git-access.ts'
import { repoAddress } from '../../core/portable.ts'
import { expandHome } from './status.ts'

/** The git a start needs (adapters/node-repo.ts), handed in so tests can stand in. */
export interface RepoOps {
  clone(url: string, dir: string): Promise<RepoDone>
  fetch(dir: string): Promise<RepoDone>
  state(dir: string, ref: string): ReturnType<typeof repoState>
  move(dir: string, state: RepoState): Promise<RepoDone>
  identity(dir: string): Promise<GitIdentity | null>
  setIdentity(dir: string, id: GitIdentity): Promise<RepoDone>
  /** The rest is for an owner's own checkout (#816); absent: the real git. */
  remotes?: typeof checkoutRemotes
  isAncestor?: typeof isAncestor
  worktreeWith?: typeof worktreeWith
  addWorktree?: typeof addWorktreeFrom
}

export const realRepoOps: RepoOps = {
  clone: cloneRepo,
  fetch: fetchRepo,
  state: repoState,
  move: moveTo,
  identity: repoIdentity,
  setIdentity: setRepoIdentity,
}

/** A repository a start runs in, as the master sends it (6.4). */
export interface RepoSource {
  kind: 'repo'
  url: string
  ref: string
  subdir: string
  worktree: { branch: string } | null
  /** The author git gives in the master's checkout; absent when it gives none. */
  identity?: GitIdentity
}

/**
 * The URL to clone an address from: the master's own when it is https or ssh for that same address
 * (a token in it is gone already: the master sends no login), else `https://<address>.git`.
 */
export function cloneUrl(address: string, sent: string): string {
  const https = /^https:\/\//i.test(sent)
  const ssh = /^ssh:\/\//i.test(sent) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]{2,}:(?!\/\/)/.test(sent)
  return (https || ssh) && repoAddress(sent) === address ? sent : `https://${address}.git`
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** What a node's config and the start add to where a repository runs (#816). */
export interface Place {
  /** `node.repos`: checkouts of this computer by address. */
  repos?: Record<string, string>
  /** `node.worktreeRoot`; absent: `<workRoot>/worktree`. */
  worktreeRoot?: string
  /** The session's name: the folder of a worktree with no branch of its own. */
  name?: string
}

/**
 * Where a repository runs. `own`: an owner's own checkout this computer already had, which the
 * board did not clone; `worktreeDone`: the worktree the start asked for is made already (`cwd` is
 * in it), so the launch pipeline makes none.
 */
export type Folder =
  | { ok: true; cwd: string; label: string; own?: true; worktreeDone?: true }
  | { ok: false; why: string }

export interface Checkouts {
  /** The repository as a folder of this computer, or why it cannot be one. */
  folderOf(workRoot: string, source: RepoSource, place?: Place): Promise<Folder>
}

/** At most this many folders are asked which repository they are in, per start. */
export const MAX_KNOWN = 200
/** How long what a folder said about its remotes is believed. */
const REMOTES_MS = 60_000

/** Two paths name one folder (real paths where they exist). */
function sameFolder(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return resolve(p)
    }
  }
  const [x, y] = [real(a), real(b)]
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Whether `inner` is `outer` or below it. */
function within(outer: string, inner: string): boolean {
  const r = relative(resolve(outer), resolve(inner))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** A branch or a session name as one folder name: what git and every file system take. */
export function folderName(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'task'
  )
}

export function createCheckouts(
  d: {
    repo?: RepoOps
    home?: string
    /**
     * Folders this computer already works in, most telling first (#816): its sessions', live and
     * archived, and the ones Claude was used in. Asked only for a start by a repository's address.
     */
    known?: () => string[]
  } = {},
): Checkouts {
  const repo = d.repo ?? realRepoOps
  const remotesOf = repo.remotes ?? checkoutRemotes
  const remotesSeen = new Map<string, { at: number; got: Awaited<ReturnType<typeof checkoutRemotes>> }>()
  /** One start at a time in a checkout: two clones into one folder would fail each other. */
  const checkouts = new Map<string, Promise<unknown>>()

  function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = checkouts.get(key) ?? Promise.resolve()
    const next = before.then(fn, fn)
    const tail = next.catch(() => {})
    checkouts.set(key, tail)
    void tail.then(() => {
      if (checkouts.get(key) === tail) checkouts.delete(key)
    })
    return next
  }

  const home = (): string => d.home ?? homedir()

  async function remotes(dir: string): Promise<Awaited<ReturnType<typeof checkoutRemotes>>> {
    const seen = remotesSeen.get(dir)
    if (seen && Date.now() - seen.at < REMOTES_MS) return seen.got
    const got = await remotesOf(dir).catch(() => null)
    remotesSeen.set(dir, { at: Date.now(), got })
    return got
  }

  /**
   * The main checkout of `address` this computer already has, other than the board's own clone
   * `managed`: `place.repos` first, then the known folders in their order. null: none.
   */
  async function ownCheckout(address: string, managed: string, place: Place): Promise<string | null> {
    const want = address.toLowerCase()
    const named = Object.entries(place.repos ?? {})
      .filter(([a]) => a.toLowerCase() === want)
      .map(([, folder]) => expandHome(folder, home()))
    let others: string[] = []
    try {
      others = d.known?.() ?? []
    } catch {}
    const asked = new Set<string>()
    for (const folder of [...named, ...others]) {
      if (asked.size >= MAX_KNOWN) break
      if (!folder || !isAbsolute(folder) || asked.has(folder)) continue
      asked.add(folder)
      if (!existsDir(folder)) continue
      const got = await remotes(folder)
      if (!got || sameFolder(got.root, managed) || !existsDir(got.root)) continue
      if (got.addresses.some(a => a.toLowerCase() === want)) return got.root
    }
    return null
  }

  /**
   * A start in an owner's own checkout (#816): fetched; the checkout itself only when no worktree
   * is asked for and it is clean on the branch asked for (fast-forwarded when it is behind and has
   * no commits of its own); otherwise a worktree of the start's own, from the remote branch, below
   * the worktree folder and never inside the checkout. The master's git author is not written
   * into the owner's checkout: its own config stands.
   */
  async function inOwn(own: string, workRoot: string, source: RepoSource, place: Place): Promise<Folder> {
    const label = basename(own)
    const subdirOf = (at: string): string => (source.subdir ? join(at, ...source.subdir.split('/')) : at)
    const fetched = await repo.fetch(own)
    if (!fetched.ok) return { ok: false, why: fetched.why }
    const st = await repo.state(own, source.ref)
    if (!st.ok) return { ok: false, why: st.why }
    const s = st.state
    if (!s.target) return { ok: false, why: `no branch ${s.ref}` }
    if (!source.worktree && s.clean && s.branch === s.ref) {
      let there = s.head === s.target
      if (!there && s.head && (await (repo.isAncestor ?? isAncestor)(own, s.head, s.target)))
        there = (await repo.move(own, s)).ok
      if (there) {
        const cwd = subdirOf(own)
        return existsDir(cwd) ? { ok: true, cwd, label, own: true } : { ok: false, why: 'no such folder' }
      }
    }
    const base = place.worktreeRoot
      ? expandHome(place.worktreeRoot, home())
      : join(expandHome(workRoot, home()), 'worktree')
    const parent = join(base, label)
    if (within(own, parent)) return { ok: false, why: `worktree folder ${parent} is inside ${own}` }
    const branch = source.worktree?.branch ?? null
    let path = join(parent, folderName(branch ?? place.name ?? 'task'))
    const add = repo.addWorktree ?? addWorktreeFrom
    if (branch) {
      const at = await (repo.worktreeWith ?? worktreeWith)(own, branch)
      if (at && !sameFolder(at, path)) return { ok: false, why: `branch ${branch} is checked out at ${at}` }
      if (!at) {
        if (existsDir(path)) return { ok: false, why: `${path} is there already and is not on ${branch}` }
        mkdirSync(parent, { recursive: true })
        const made = await add(own, path, branch, `refs/remotes/origin/${s.ref}`)
        if (!made.ok) return { ok: false, why: `worktree: ${made.why}` }
      }
    } else {
      for (let n = 2; existsDir(path); n++) {
        if (n > 50) return { ok: false, why: `${path} is there already` }
        path = join(parent, `${folderName(place.name ?? 'task')}-${n}`)
      }
      mkdirSync(parent, { recursive: true })
      const made = await add(own, path, null, `refs/remotes/origin/${s.ref}`)
      if (!made.ok) return { ok: false, why: `worktree: ${made.why}` }
    }
    const cwd = subdirOf(path)
    if (!existsDir(cwd)) return { ok: false, why: 'no such folder' }
    return { ok: true, cwd, label, own: true, worktreeDone: true }
  }

  /** The repository as a folder of this node, or the refusal. */
  async function folderOf(workRoot: string, source: RepoSource, place: Place = {}): Promise<Folder> {
    const address = repoAddress(source.url)
    if (!address) return { ok: false, why: 'address' }
    const segments = address.split('/')
    const root = expandHome(workRoot, home())
    const checkout = join(root, ...segments)
    // The address rule keeps it below the work folder; checked here too, as the folder is made from it.
    const below = relative(root, checkout)
    if (!below || below.startsWith('..') || isAbsolute(below)) return { ok: false, why: 'address' }
    const own = await ownCheckout(address, checkout, place)
    if (own) return oneAtATime(own, () => inOwn(own, workRoot, source, place))
    return oneAtATime(checkout, async (): Promise<Folder> => {
      let st = await repo.state(checkout, source.ref)
      if (!st.ok && !existsDir(checkout)) {
        mkdirSync(join(checkout, '..'), { recursive: true })
        const cloned = await repo.clone(cloneUrl(address, source.url), checkout)
        if (!cloned.ok) return { ok: false, why: cloned.why }
      } else if (st.ok) {
        const fetched = await repo.fetch(checkout)
        if (!fetched.ok) return { ok: false, why: fetched.why }
      } else return { ok: false, why: st.why }
      st = await repo.state(checkout, source.ref)
      if (!st.ok) return { ok: false, why: st.why }
      const s = st.state
      if (!s.target) return { ok: false, why: `no branch ${s.ref}` }
      // At the branch's remote commit already: a new worktree starts from it whatever the tree
      // holds. Otherwise the checkout moves, which only a clean one may.
      const there = s.branch === s.ref && s.head === s.target
      if (!there || !source.worktree) {
        if (!s.clean) return { ok: false, why: 'changes' }
        if (!there) {
          const moved = await repo.move(checkout, s)
          if (!moved.ok) return { ok: false, why: moved.why }
        }
      }
      const cwd = source.subdir ? join(checkout, ...source.subdir.split('/')) : checkout
      if (!existsDir(cwd)) return { ok: false, why: 'no such folder' }
      // Last, so a start turned away for anything else writes nothing. Two starts of one repository
      // with different authors on the master: the later one's stays.
      const given = source.identity
      if (given && !sameIdentity(await repo.identity(checkout), given)) {
        const set = await repo.setIdentity(checkout, given)
        if (!set.ok) return { ok: false, why: `identity not set: ${set.why}` }
      }
      return { ok: true, cwd, label: segments.at(-1) ?? '' }
    })
  }

  return { folderOf }
}
