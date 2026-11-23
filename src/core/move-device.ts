// A session moved to another device (#616, `board move --device`), as a profile move moves one to
// another Claude profile (core/move.ts): its conversation goes to the device, its folder is made
// there from git, and it is resumed there with its name, lane and schedule entries. The master
// carries it (services/nodes/move-device.ts) between the two boards, each of which does its own half:
// the source puts the session to sleep and packs it (services/move-out.ts), the target makes the
// folder, writes the files and resumes it (services/move-in.ts). This file holds what both halves
// and the master agree on, with no I/O: the pack as it crosses a link, what a folder needs to
// travel, where each file lands, and the words of a refusal.
//
// The folder travels by git: a checkout with a remote a device can clone, on a branch that is
// pushed. What is not committed yet (changed, new and deleted files, untracked ones included) goes
// with the session as a small bundle of those files (#616 part 2), within caps, applied on the
// target's checkout at the same commit. Ignored files (node_modules, a venv, build output, caches,
// .env) never travel; the target rebuilds what it needs, and a secret goes through #604's path.
import { type GitIdentity, identityOf } from './git-access.ts'
import { checkBranch } from './launch/names.ts'
import { MOVE_USAGE } from './move.ts'
import { DEVICE_ID, LOCAL } from './node-key.ts'
import { repoAddress, subdirTravels } from './portable.ts'
import { SESSION_ID } from './resume.ts'

export { LOCAL }

/** `board move`'s arguments with `--device`: the sessions, the device id (`local`: this computer), and `--dry-run`. */
export interface DeviceMoveArgs {
  targets: string[]
  device: string
  dryRun: boolean
}

/** `board move`: a profile move or a device move, never both; throws with the usage. */
export function parseMoveAny(
  args: readonly string[],
): { targets: string[]; profile: string; device?: undefined } | (DeviceMoveArgs & { profile?: undefined }) {
  const targets: string[] = []
  let profile: string | undefined
  let device: string | undefined
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i])
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--profile' || arg === '--device') {
      const value = args[++i]
      if (value === undefined || value.startsWith('-'))
        throw new Error(`${arg} needs ${arg === '--profile' ? 'a profile' : 'a device'} id. ${MOVE_USAGE}`)
      if (arg === '--profile') profile = value
      else device = value
    } else if (arg.startsWith('--')) throw new Error(`unexpected "${arg}". ${MOVE_USAGE}`)
    else if (arg.trim()) targets.push(arg)
  }
  if (!targets.length) throw new Error(`which sessions? ${MOVE_USAGE}`)
  if (profile !== undefined && device !== undefined) throw new Error(`--profile or --device, not both. ${MOVE_USAGE}`)
  if (device !== undefined) {
    if (device !== LOCAL && !DEVICE_ID.test(device)) throw new Error(`"${device}" is not a device id. ${MOVE_USAGE}`)
    return { targets, device, dryRun }
  }
  if (dryRun) throw new Error(`--dry-run is for a move to another device. ${MOVE_USAGE}`)
  if (!profile) throw new Error(`to which profile or device? ${MOVE_USAGE}`)
  return { targets, profile }
}

/** Why a folder does not travel: the card and `board move` say it in one line (moveWhyText). */
export type MoveWhy =
  | { kind: 'not-claude' }
  | { kind: 'no-transcript' }
  | { kind: 'profile' } // the board cannot tell which profile's folder holds its conversation
  | { kind: 'no-checkout' } // the folder is in no git checkout
  | { kind: 'no-remote' } // the checkout has no remote another device can clone (a folder of this computer)
  | { kind: 'unreadable' } // git could not say what is not committed
  | { kind: 'detached' } // HEAD is on no branch
  | { kind: 'changes' } // changes in the tree or the index, untracked files included
  | { kind: 'unpushed'; branch: string } // the branch is not its remote branch
  | { kind: 'name'; name: string } // a branch or folder name a device does not take
  | { kind: 'change-odd'; path: string; why: 'link' | 'conflict' | 'submodule' | 'name' } // a change that cannot travel as a file
  | { kind: 'too-many-changes'; n: number }
  | { kind: 'change-too-large'; path: string; size: number }
  | { kind: 'changes-too-large'; size: number }

/** What the source reads of the session's folder, handed in so the rule stays pure. */
export interface FolderFacts {
  /** The checkout the folder is in, or null when in none. */
  checkout: {
    root: string
    /** The remote's URL without a password, or null when the checkout has none. */
    url: string | null
    clean: boolean
    /** The branch HEAD is on, '' when detached. */
    branch: string
    /** The branch equals its remote branch, as last fetched. */
    pushed: boolean
    /** HEAD's commit. */
    head: string
  } | null
  /** What is not committed, read only when the checkout is not clean; absent: not read (refused as changes). */
  changes?: ChangeFacts | null
  /** The folder below the checkout's root, '/' between, '' for the root; null when it is not below it. */
  subdir: string | null
  identity: GitIdentity | null
}

/** What git says is not committed in a checkout (adapters/move-pack.ts checkoutChangeList). */
export interface ChangeFacts {
  /** Changed, added and untracked files that are there, by their path in the checkout ('/' between). */
  files: { path: string; size: number }[]
  /** Tracked files that are gone from the tree. */
  deleted: string[]
  /** What cannot travel as a file: a link, a conflict, a submodule. */
  odd: { path: string; why: 'link' | 'conflict' | 'submodule' }[]
}

/** At most this many changed files travel, this large each and together; more is refused with the reason. */
export const MAX_CHANGES = 2000
export const MAX_CHANGE_BYTES = 5 * 1024 * 1024
export const MAX_CHANGES_BYTES = 20 * 1024 * 1024

/**
 * Whether a path in the checkout may be written or removed there: plain segments ('/' between), none
 * of them `.`, `..` or `.git` (any case), no backslash, colon or control character.
 */
export function changePathOk(path: string): boolean {
  if (!path || path.length > 4096 || /[\\:\p{Cc}]/u.test(path)) return false
  return path
    .split('/')
    .every(s => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git' && s.length <= 255)
}

/** The folder as a pack carries it: the repository's address, the branch, the folder below it. */
export interface PackFolder {
  url: string
  /** As core/portable.ts repoAddress makes it: the name a node gives its checkout. */
  address: string
  branch: string
  subdir: string
  identity?: GitIdentity
  /** The commit the session left the checkout at: the changes apply on it. */
  head: string
  /** Tracked files the session's checkout no longer has (its changed files travel as files of kind `change`). */
  deleted: string[]
}

/** The folder as it travels, or why it does not: cheapest first, as the portability rule (8.4). */
export function packFolder(f: FolderFacts): { ok: true; folder: PackFolder } | { ok: false; why: MoveWhy } {
  const c = f.checkout
  if (!c) return { ok: false, why: { kind: 'no-checkout' } }
  const address = c.url ? repoAddress(c.url) : null
  if (!c.url || !address || f.subdir === null) return { ok: false, why: { kind: 'no-remote' } }
  if (!c.branch) return { ok: false, why: { kind: 'detached' } }
  if (!c.head || f.changes === null) return { ok: false, why: { kind: 'unreadable' } }
  if (checkBranch(c.branch)) return { ok: false, why: { kind: 'name', name: c.branch } }
  if (!subdirTravels(f.subdir)) return { ok: false, why: { kind: 'name', name: f.subdir } }
  if (!c.pushed) return { ok: false, why: { kind: 'unpushed', branch: c.branch } }
  let deleted: string[] = []
  if (!c.clean) {
    const ch = f.changes
    if (!ch) return { ok: false, why: { kind: 'changes' } }
    const odd = ch.odd[0]
    if (odd) return { ok: false, why: { kind: 'change-odd', path: odd.path, why: odd.why } }
    const bad = [...ch.files.map(x => x.path), ...ch.deleted].find(p => !changePathOk(p))
    if (bad !== undefined) return { ok: false, why: { kind: 'change-odd', path: bad, why: 'name' } }
    const n = ch.files.length + ch.deleted.length
    if (n > MAX_CHANGES) return { ok: false, why: { kind: 'too-many-changes', n } }
    const big = ch.files.find(x => x.size > MAX_CHANGE_BYTES)
    if (big) return { ok: false, why: { kind: 'change-too-large', path: big.path, size: big.size } }
    const size = ch.files.reduce((s, x) => s + x.size, 0)
    if (size > MAX_CHANGES_BYTES) return { ok: false, why: { kind: 'changes-too-large', size } }
    deleted = [...ch.deleted]
  }
  return {
    ok: true,
    folder: {
      url: c.url,
      address,
      branch: c.branch,
      subdir: f.subdir,
      ...(f.identity && { identity: f.identity }),
      head: c.head,
      deleted,
    },
  }
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`

/** One line for a refusal, in the words `board move` prints and the card shows. */
export function moveWhyText(why: MoveWhy): string {
  switch (why.kind) {
    case 'not-claude':
      return 'not a Claude session'
    case 'no-transcript':
      return 'its conversation is not on disk yet'
    case 'profile':
      return 'its profile is not known'
    case 'no-checkout':
      return 'its folder is not a git checkout, and a folder travels only through git'
    case 'no-remote':
      return 'its checkout has no remote another device can clone'
    case 'unreadable':
      return 'git could not say what is not committed in its checkout'
    case 'detached':
      return 'its checkout is on no branch (detached HEAD)'
    case 'changes':
      return 'its checkout has changes that are not committed (untracked files count): commit or stash them first'
    case 'change-odd':
      return {
        link: `${why.path} is a link, which does not travel: commit it first`,
        conflict: `${why.path} has a merge conflict: resolve it first`,
        submodule: `${why.path} is a submodule with changes, which do not travel: commit them first`,
        name: `"${why.path}" is a name another device does not take: commit it first`,
      }[why.why]
    case 'too-many-changes':
      return `${why.n} files are not committed, more than the ${MAX_CHANGES} a move takes: commit some first`
    case 'change-too-large':
      return `${why.path} (${mb(why.size)}) is larger than the ${mb(MAX_CHANGE_BYTES)} a changed file may be: commit it first`
    case 'changes-too-large':
      return `the changes come to ${mb(why.size)}, more than the ${mb(MAX_CHANGES_BYTES)} a move takes: commit some first`
    case 'unpushed':
      return `its branch ${why.branch} is not pushed: push it first`
    case 'name':
      return `"${why.name}" is a name another device does not take`
  }
}

/**
 * Where a file of the pack lands: the session's in a profile folder, Claude's own layout
 * (adapters/move-files.ts); a `change` in the session's checkout, by its path there.
 */
export type PackFileKind = 'transcript' | 'side' | 'history' | 'change'

/** One file of the session in a pack: by kind, its path below that kind's folder ('/' between). */
export interface PackFile {
  kind: PackFileKind
  /** '' for the transcript; else below the session's side folder, its file history or its checkout. */
  path: string
  size: number
  sha256: string
  /** 0o755 when any execute bit was set, else 0o644. */
  mode: number
}

/** A schedule entry of the session as it travels: a reminder or a repeating one, nothing of the old board's panes. */
export interface PackEntry {
  id: string
  text: string
  next: number
  cron?: string
  name?: string
  by?: string
  noWake?: boolean
  idle?: boolean
}

/** What the source gives and the target takes: the session, its files, its folder. */
export interface MovePack {
  v: 1
  session: string
  name: string
  category: string
  /** The profile id it is to run in on the target (the master maps it per device). */
  profile: string
  workspace: string
  /** The folder it ran in on the source, for the notes and a move back. */
  cwd: string
  folder: PackFolder
  files: PackFile[]
  entries: PackEntry[]
  /** The source profile trusted its folder: the target trusts its own copy of it. */
  trusted: boolean
  /** The device it comes from, as the master names it. */
  from: string
}

/**
 * At most this many files in a pack, this large each (under the 128 MiB a Bun listener takes as one
 * request's body, the door's included) and together.
 */
export const MAX_PACK_FILES = 20_000
export const MAX_PACK_FILE_BYTES = 120 * 1024 * 1024
export const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024
/** At most this many schedule entries travel with a session, the schedule's own cap per session. */
export const MAX_PACK_ENTRIES = 50

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SHA = /^[0-9a-f]{64}$/
const KINDS: ReadonlySet<unknown> = new Set(['transcript', 'side', 'history', 'change'])
const HEAD = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const line = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max && !/\p{Cc}/u.test(v) ? v : null

/** Whether a path below a kind's folder may be written there: plain segments, no way up (core/portable.ts subdirTravels). */
export function packPathOk(kind: PackFileKind, path: string): boolean {
  if (kind === 'change') return changePathOk(path)
  return kind === 'transcript' ? path === '' : path !== '' && subdirTravels(path)
}

/** A pack as it came over a link, checked field by field; or the field at fault. Never trusted as a path. */
export function movePackOf(raw: unknown): MovePack | { field: string } {
  if (!isObject(raw) || raw.v !== 1) return { field: 'v' }
  if (typeof raw.session !== 'string' || !SESSION_ID.test(raw.session)) return { field: 'session' }
  const name = line(raw.name ?? '', 200)
  if (name === null) return { field: 'name' }
  const category = line(raw.category ?? '', 64)
  if (category === null) return { field: 'category' }
  const profile = line(raw.profile, 255)
  if (!profile) return { field: 'profile' }
  const workspace = line(raw.workspace ?? '', 60)
  if (workspace === null) return { field: 'workspace' }
  const cwd = line(raw.cwd ?? '', 4096)
  if (cwd === null) return { field: 'cwd' }
  const from = line(raw.from ?? '', 64)
  if (from === null) return { field: 'from' }
  const f = raw.folder
  if (!isObject(f)) return { field: 'folder' }
  const url = line(f.url, 2048)
  const address = url ? repoAddress(url) : null
  if (!url || !address || f.address !== address) return { field: 'folder.url' }
  if (typeof f.branch !== 'string' || checkBranch(f.branch)) return { field: 'folder.branch' }
  if (typeof f.subdir !== 'string' || !subdirTravels(f.subdir)) return { field: 'folder.subdir' }
  if (typeof f.head !== 'string' || !HEAD.test(f.head)) return { field: 'folder.head' }
  const deleted = Array.isArray(f.deleted) ? f.deleted : null
  if (!deleted || deleted.length > MAX_CHANGES || !deleted.every(p => typeof p === 'string' && changePathOk(p)))
    return { field: 'folder.deleted' }
  let identity: GitIdentity | null = null
  if (f.identity !== undefined && f.identity !== null) {
    identity = isObject(f.identity) ? identityOf(f.identity.name, f.identity.email) : null
    if (!identity) return { field: 'folder.identity' }
  }
  if (!Array.isArray(raw.files) || raw.files.length > MAX_PACK_FILES) return { field: 'files' }
  const files: PackFile[] = []
  let total = 0
  let transcripts = 0
  let changes = 0
  let changeBytes = 0
  const seen = new Set<string>()
  for (const x of raw.files) {
    if (!isObject(x) || !KINDS.has(x.kind) || typeof x.path !== 'string') return { field: 'files' }
    const kind = x.kind as PackFileKind
    if (!packPathOk(kind, x.path)) return { field: 'files' }
    const size = x.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_PACK_FILE_BYTES)
      return { field: 'files' }
    if (typeof x.sha256 !== 'string' || !SHA.test(x.sha256)) return { field: 'files' }
    const where = `${kind}/${x.path}`
    if (seen.has(where)) return { field: 'files' }
    seen.add(where)
    total += size
    if (kind === 'transcript') transcripts++
    if (kind === 'change') {
      changes++
      changeBytes += size
      if (size > MAX_CHANGE_BYTES) return { field: 'files' }
    }
    files.push({ kind, path: x.path, size, sha256: x.sha256, mode: x.mode === 0o755 ? 0o755 : 0o644 })
  }
  if (transcripts !== 1 || total > MAX_PACK_BYTES) return { field: 'files' }
  if (changes + deleted.length > MAX_CHANGES || changeBytes > MAX_CHANGES_BYTES) return { field: 'files' }
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_PACK_ENTRIES) return { field: 'entries' }
  const entries: PackEntry[] = []
  for (const e of raw.entries) {
    if (!isObject(e)) return { field: 'entries' }
    const id = line(e.id, 32)
    const text = typeof e.text === 'string' && e.text.length <= 20_000 ? e.text : null
    if (!id || text === null || typeof e.next !== 'number' || !Number.isFinite(e.next)) return { field: 'entries' }
    const cron = e.cron === undefined ? undefined : line(e.cron, 200)
    const ename = e.name === undefined ? undefined : line(e.name, 200)
    const by = e.by === undefined ? undefined : line(e.by, 200)
    if (cron === null || ename === null || by === null) return { field: 'entries' }
    entries.push({
      id,
      text,
      next: e.next,
      ...(cron && { cron }),
      ...(ename && { name: ename }),
      ...(by && { by }),
      ...(e.noWake === true && { noWake: true }),
      ...(e.idle === true && { idle: true }),
    })
  }
  return {
    v: 1,
    session: raw.session,
    name,
    category,
    profile,
    workspace,
    cwd,
    folder: {
      url,
      address,
      branch: f.branch,
      subdir: f.subdir,
      ...(identity && { identity }),
      head: f.head,
      deleted: deleted as string[],
    },
    files,
    entries,
    trusted: raw.trusted === true,
    from,
  }
}

/** The schedule entries that travel: reminders and repeating ones; a restart, a sleep or a call report is this board's own. */
export function entriesToCarry(
  entries: readonly { id: string; key: string; text: string; next: number; kind?: string; [k: string]: unknown }[],
  key: string,
): PackEntry[] {
  return entries
    .filter(e => e.key === key && !e.kind && !e.receipt)
    .slice(0, MAX_PACK_ENTRIES)
    .map(e => ({
      id: e.id,
      text: e.text,
      next: e.next,
      ...(typeof e.cron === 'string' && e.cron && { cron: e.cron }),
      ...(typeof e.name === 'string' && e.name && { name: e.name }),
      ...(typeof e.by === 'string' && e.by && { by: e.by }),
      ...(e.noWake === true && { noWake: true }),
      ...(e.idle === true && { idle: true }),
    }))
}

/**
 * The profile id a session runs in on `to`, from the one it has on `from`: a device's `profiles`
 * maps the master's ids to the node's (7.1). Between two nodes the master's id is the way between.
 */
export function profileOn(
  devices: Readonly<Record<string, { profiles: Readonly<Record<string, string>> }>>,
  from: string,
  to: string,
  profile: string,
): string {
  const own = (device: string): Readonly<Record<string, string>> =>
    device === LOCAL ? {} : (devices[device]?.profiles ?? {})
  // Back to the master's id: the first master id the source's map sends to this one.
  const back = Object.entries(own(from)).find(([, there]) => there === profile)?.[0]
  const master = from === LOCAL ? profile : (back ?? profile)
  if (to === LOCAL) return master
  return Object.hasOwn(own(to), master) ? (own(to)[master] ?? master) : master
}

/** The uncommitted changes a pack carries, as one key: what the owner saw listed is what moves. */
export function changesKey(p: Pick<MovePack, 'files' | 'folder'>): string {
  const parts = [
    ...p.files.filter(f => f.kind === 'change').map(f => `${f.path}\u0000${f.sha256}`),
    ...p.folder.deleted.map(d => `${d}\u0000-`),
  ].sort()
  return parts.join('\u0001')
}
