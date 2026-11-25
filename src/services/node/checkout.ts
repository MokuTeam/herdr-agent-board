// A repository as a folder of this computer (#504, docs/design/nodes 8.4): `<workRoot>/<host>/<path>`,
// cloned when missing, fetched, and moved to the branch asked for only when nothing of this
// computer's own would be lost. A node does it for a start its master sends (services/node/launch.ts);
// a master does it for a start a node's session asked for that it runs itself (#760,
// services/nodes/placer.ts). The address is checked here by the board's own rule
// (core/portable.ts repoAddress), never taken from the other side's word as a folder name.
import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import {
  cloneRepo,
  fetchRepo,
  moveTo,
  type RepoDone,
  type RepoState,
  repoIdentity,
  repoState,
  setRepoIdentity,
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

export interface Checkouts {
  /** The repository as a folder below `workRoot`, or why it cannot be one. */
  folderOf(
    workRoot: string,
    source: RepoSource,
  ): Promise<{ ok: true; cwd: string; label: string } | { ok: false; why: string }>
}

export function createCheckouts(d: { repo?: RepoOps; home?: string } = {}): Checkouts {
  const repo = d.repo ?? realRepoOps
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

  /** The repository as a folder of this node, or the refusal. */
  async function folderOf(
    workRoot: string,
    source: RepoSource,
  ): Promise<{ ok: true; cwd: string; label: string } | { ok: false; why: string }> {
    const address = repoAddress(source.url)
    if (!address) return { ok: false, why: 'address' }
    const segments = address.split('/')
    const root = expandHome(workRoot, d.home ?? homedir())
    const checkout = join(root, ...segments)
    // The address rule keeps it below the work folder; checked here too, as the folder is made from it.
    const below = relative(root, checkout)
    if (!below || below.startsWith('..') || isAbsolute(below)) return { ok: false, why: 'address' }
    return oneAtATime(checkout, async () => {
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
