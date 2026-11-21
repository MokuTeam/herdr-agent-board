// A start from the master on a node (#504, docs/design/nodes 6.4, 8.4): `POST /api/node/launch` on
// the master door. The master picked the device, the profile (already mapped to this node's) and
// the session id; the node turns the source into a folder and hands it to its own launch pipeline
// (services/launch/launches.ts), from where the launch is the node's own: its card rides in the
// node's payload with trust dialogs and failures as today.
//
// - `id` is the session id and the launch's identity. The same id again answers the launch it
//   has, from memory while it is being made and from a file per accepted id under
//   `<state>/node/launches/` for the 10 minutes a retry can come in, so a restart of this board in
//   between does not start a second session.
// - `source.kind: "repo"`: the address is checked here again by the board's own rule
//   (core/portable.ts repoAddress), never taken from the master's word as a folder name. The
//   checkout is `<workRoot>/<host>/<path>`, cloned when missing (`https://<address>.git`, or the
//   URL the master sent when it is https or ssh for the same address), fetched, and moved to the
//   branch asked for only when nothing of the node's own would be lost: else 409 `repo`. The
//   author the master's checkout gives (`source.identity`, #611) is set in the checkout's own config
//   when git there gives another, so a session here commits as it would there; one that cannot be
//   set is 409 `repo` too. None sent (none there, an older master): the node's own applies.
// - `source.kind: "path"`: a start pinned to this node by hand, with a folder of this node.
// - Below the hard floor (512 MB available) 409 `full`; a profile this node does not have, or one
//   not logged in, 409 `profile`. The master then tries its next device.
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { replaceFile } from '../../adapters/json-store.ts'
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
import { nodeDir } from '../../adapters/node-store.ts'
import { memAvailableMb } from '../../adapters/sysload.ts'
import { type GitIdentity, identityOf, sameIdentity } from '../../core/git-access.ts'
import { checkBranch } from '../../core/launch/names.ts'
import type { NodeConfig } from '../../core/nodes.ts'
import type { NodeTurn } from '../../core/placement.ts'
import { repoAddress, subdirTravels } from '../../core/portable.ts'
import type { ProfileSet } from '../../core/profiles.ts'
import type { LaunchView } from '../../core/types.ts'
import type { StartResult } from '../launch/launches.ts'
import { expandHome, loggedIn } from './status.ts'

/** Below this much memory available the node takes no start, whatever the master thought (6.3). */
export const FLOOR_MB = 512
/** How long an accepted id is remembered: a retry after a lost answer comes well inside it. */
export const REMEMBER_MS = 10 * 60_000

/** What a start from the master asks for (6.4), checked. */
export interface NodeLaunchRequest {
  id: string
  name: string
  category: string
  profile: string
  agent: string
  model: string
  message: string
  /** The master's workspace label, so its sessions of one workspace stay together here too; '' for none. */
  workspace: string
  source:
    | {
        kind: 'repo'
        url: string
        ref: string
        subdir: string
        worktree: { branch: string } | null
        /** The author git gives in the master's checkout; absent when it gives none. */
        identity?: GitIdentity
      }
    | { kind: 'path'; cwd: string; worktree: { branch: string } | null }
}

export type NodeLaunchAnswer =
  | { status: 202; body: { launch: { id: string; state: string } } }
  | { status: 409; body: { error: NodeTurn; detail?: string } }
  | { status: 400; body: { error: 'body' | 'launch'; field: string; detail?: string } }
  | { status: 503; body: { error: 'node' } }

/** The git a start needs (adapters/node-repo.ts), handed in so tests can stand in. */
export interface RepoOps {
  clone(url: string, dir: string): Promise<RepoDone>
  fetch(dir: string): Promise<RepoDone>
  state(dir: string, ref: string): ReturnType<typeof repoState>
  move(dir: string, state: RepoState): Promise<RepoDone>
  identity(dir: string): Promise<GitIdentity | null>
  setIdentity(dir: string, id: GitIdentity): Promise<RepoDone>
}

export interface NodeLaunchDeps {
  node: () => NodeConfig | null
  /** The node's own launches.start, with the session id the master picked. */
  start: (body: unknown, session: string) => Promise<StartResult>
  /** The node's launch by its id now, for the answer to an id it has. */
  launch: (id: string) => LaunchView | undefined
  profiles: () => ProfileSet
  /** herdr's workspaces here, for the master's workspace by its label. */
  workspaces: () => Promise<{ id: string; label: string | undefined }[]>
  memAvailableMb?: () => Promise<number | null>
  repo?: RepoOps
  /** Where the accepted ids are kept; `<state>/node/launches` by default. */
  dir?: string
  now?: () => number
  home?: string
  platform?: string
  exists?: (file: string) => boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
function worktreeOf(v: unknown): { branch: string } | null | undefined {
  if (v === undefined || v === null) return null
  if (!isObject(v) || typeof v.branch !== 'string' || checkBranch(v.branch.trim())) return undefined
  return { branch: v.branch.trim() }
}

/** The body as 6.4 has it, or the field at fault. */
export function launchRequestOf(raw: unknown): NodeLaunchRequest | { field: string } {
  if (!isObject(raw)) return { field: 'body' }
  const b = raw
  if (typeof b.id !== 'string' || !UUID.test(b.id)) return { field: 'id' }
  for (const [key, max] of [
    ['name', 200],
    ['category', 64],
    ['profile', 255],
    ['agent', 32],
    ['model', 200],
    ['message', 20_000],
    ['workspace', 60],
  ] as const)
    if (b[key] !== undefined && b[key] !== null && !text(b[key], max)) return { field: key }
  const s = b.source
  if (!isObject(s)) return { field: 'source' }
  const worktree = worktreeOf(s.worktree)
  if (worktree === undefined) return { field: 'source.worktree' }
  let source: NodeLaunchRequest['source']
  if (s.kind === 'repo') {
    if (!text(s.url, 2048) || !s.url) return { field: 'source.url' }
    const ref = s.ref === undefined || s.ref === null ? '' : s.ref
    if (typeof ref !== 'string' || (ref && checkBranch(ref))) return { field: 'source.ref' }
    const subdir = s.subdir === undefined || s.subdir === null ? '' : s.subdir
    if (typeof subdir !== 'string' || !subdirTravels(subdir)) return { field: 'source.subdir' }
    // Both or neither, each one line of sane length (core/git-access.ts identityOf).
    let identity: GitIdentity | null = null
    if (s.identity !== undefined && s.identity !== null) {
      identity = isObject(s.identity) ? identityOf(s.identity.name, s.identity.email) : null
      if (!identity) return { field: 'source.identity' }
    }
    source = { kind: 'repo', url: s.url, ref, subdir, worktree, ...(identity && { identity }) }
  } else if (s.kind === 'path') {
    if (!text(s.cwd, 4096) || !s.cwd) return { field: 'source.cwd' }
    source = { kind: 'path', cwd: s.cwd, worktree }
  } else return { field: 'source.kind' }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: b.id,
    name: str(b.name),
    category: str(b.category),
    profile: str(b.profile),
    agent: str(b.agent),
    model: str(b.model),
    message: str(b.message),
    workspace: str(b.workspace).trim(),
    source,
  }
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

export interface NodeLaunch {
  answer(raw: unknown): Promise<NodeLaunchAnswer>
}

export function createNodeLaunch(d: NodeLaunchDeps): NodeLaunch {
  const now = d.now ?? Date.now
  const dir = d.dir ?? join(nodeDir(), 'launches')
  const repo: RepoOps = d.repo ?? {
    clone: cloneRepo,
    fetch: fetchRepo,
    state: repoState,
    move: moveTo,
    identity: repoIdentity,
    setIdentity: setRepoIdentity,
  }
  const platform = d.platform ?? process.platform
  /** Starts being made, by id: a second request for one waits for the first's answer. */
  const making = new Map<string, Promise<NodeLaunchAnswer>>()
  /** One start at a time in a checkout: two clones into one folder would fail each other. */
  const checkouts = new Map<string, Promise<unknown>>()

  const recordOf = (id: string): string => join(dir, `${id}.json`)

  /** Whether the id was accepted inside REMEMBER_MS; older records go. */
  function remembered(id: string): boolean {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return false
    }
    let found = false
    for (const name of names) {
      const file = join(dir, name)
      try {
        if (now() - statSync(file).mtimeMs > REMEMBER_MS) unlinkSync(file)
        else if (name === `${id}.json`) found = true
      } catch {}
    }
    return found
  }

  const accepted = (id: string): NodeLaunchAnswer => ({
    status: 202,
    body: { launch: { id, state: d.launch(id)?.state ?? 'starting' } },
  })
  const turn = (error: NodeTurn, detail?: string): NodeLaunchAnswer => ({
    status: 409,
    body: detail ? { error, detail } : { error },
  })

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
    node: NodeConfig,
    source: Extract<NodeLaunchRequest['source'], { kind: 'repo' }>,
  ): Promise<{ ok: true; cwd: string; label: string } | { ok: false; why: string }> {
    const address = repoAddress(source.url)
    if (!address) return { ok: false, why: 'address' }
    const segments = address.split('/')
    const root = expandHome(node.workRoot, d.home ?? homedir())
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

  async function workspaceFor(label: string): Promise<{ id: string; label: string } | { create: string }> {
    try {
      const found = (await d.workspaces()).find(w => w.label === label)
      if (found) return { id: found.id, label }
    } catch {}
    return { create: label }
  }

  async function make(node: NodeConfig, r: NodeLaunchRequest): Promise<NodeLaunchAnswer> {
    const free = await (d.memAvailableMb ?? memAvailableMb)()
    // null: the system could not say. The master took a status that could not say as no room;
    // the node refuses only what it knows is below its floor.
    if (free !== null && free < FLOOR_MB) return turn('full')
    const profile = d.profiles().list.find(p => p.id === r.profile)
    if (!profile) return turn('profile', 'missing')
    if (loggedIn(profile.dir, platform, d.exists ?? existsSync) === false) return turn('profile', 'login')
    let cwd: string
    let label: string
    if (r.source.kind === 'repo') {
      const got = await folderOf(node, r.source)
      if (!got.ok) return turn('repo', got.why)
      cwd = got.cwd
      label = got.label
    } else {
      cwd = r.source.cwd
      label = basename(cwd)
    }
    const workspace = await workspaceFor((r.workspace || label || r.name).slice(0, 40))
    mkdirSync(dir, { recursive: true })
    replaceFile(recordOf(r.id), JSON.stringify({ id: r.id }))
    let started: StartResult
    try {
      started = await d.start(
        {
          name: r.name,
          cwd,
          category: r.category,
          workspace,
          message: r.message,
          worktree: r.source.worktree,
          profile: r.profile,
          ...(r.agent && { agent: r.agent }),
          model: r.model,
        },
        r.id,
      )
    } catch (err) {
      started = { ok: false, field: 'launch', error: err instanceof Error ? err.message : String(err) }
    }
    if (!started.ok) {
      try {
        unlinkSync(recordOf(r.id))
      } catch {}
      return { status: 400, body: { error: 'launch', field: started.field, detail: started.error } }
    }
    return accepted(r.id)
  }

  return {
    async answer(raw) {
      const node = d.node()
      if (!node) return { status: 503, body: { error: 'node' } }
      const r = launchRequestOf(raw)
      if ('field' in r) return { status: 400, body: { error: 'body', field: r.field } }
      const held = making.get(r.id)
      if (held) return held
      if (d.launch(r.id) || remembered(r.id)) return accepted(r.id)
      const next = make(node, r).finally(() => making.delete(r.id))
      making.set(r.id, next)
      return next
    },
  }
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
