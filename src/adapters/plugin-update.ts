// The node's files for an update of its plugin (#590, docs/design/nodes 6.2, 11.3): the archive its
// master sends, kept as it comes; the archive's entries (core/tar.ts) written into a fresh folder
// beside the plugin's; `bun install --production` there; and the swap of the two folders. On
// Windows (#699), where a folder whose files a process holds cannot be renamed, the board only
// prepares: a full copy of the plugin (backupPlugin), a pending record (writePending) and a guard
// process (startGuard) that outlives it. The guard writes the new copy into the plugin's folder
// file by file, commit stamp last (applyUpdate), and puts the copy before back (mirrorTree) when
// the board does not come back on the new commit. The decisions are services/node/update.ts's and
// services/node/update-guard.ts's; this only does what it is told.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ARCHIVE_COMMIT_FILE } from '../core/node-texts.ts'
import type { TarEntry } from '../core/tar.ts'
import { archiveStamp, headCommit } from './git.ts'
import { isRecord, readJson, renameWithRetry, replaceFile } from './json-store.ts'
import { run } from './process.ts'

/**
 * The commit a plugin folder holds: git's HEAD in a checkout, else the stamp an archive was
 * unpacked with (core/node-texts.ts ARCHIVE_COMMIT_FILE); '' for neither.
 */
export async function pluginCommit(root: string): Promise<string> {
  // A folder with no .git of its own may sit in another repository (a home folder kept in git):
  // its commit is the stamp, never that repository's.
  if (!existsSync(join(root, '.git'))) return archiveStamp(root) ?? ''
  return (await headCommit(root).catch(() => null)) ?? ''
}

/** The fresh copy and the one before it, beside the plugin's folder: `<name>.new`, `<name>.old`. */
export function besidePlugin(root: string): { fresh: string; old: string } {
  const up = dirname(root)
  const name = basename(root)
  return { fresh: join(up, `${name}.new`), old: join(up, `${name}.old`) }
}

/**
 * A request's body written to `file` as it comes, hashed on the way: its sha256 and size, or null
 * when it passes `max` bytes (the part written goes). Written beside `file` first, then renamed.
 */
export async function keepStream(
  body: ReadableStream<Uint8Array> | null,
  file: string,
  max: number,
): Promise<{ sha256: string; size: number } | null> {
  mkdirSync(dirname(file), { recursive: true })
  const part = `${file}.${process.pid}-${++parts}.part`
  const hash = createHash('sha256')
  const fd = openSync(part, 'w', 0o600)
  let size = 0
  let fits = true
  try {
    try {
      if (body)
        for await (const chunk of body) {
          size += chunk.length
          if (size > max) {
            fits = false
            break
          }
          hash.update(chunk)
          writeSync(fd, chunk)
        }
    } finally {
      closeSync(fd)
    }
    if (!fits) {
      rmSync(part, { force: true })
      return null
    }
    renameWithRetry(part, file)
  } catch (err) {
    // an upload cut short leaves nothing behind
    rmSync(part, { force: true })
    throw err
  }
  return { sha256: hash.digest('hex'), size }
}

let parts = 0

/** A kept archive's bytes and their sha256, or null when there is none. */
export function readKept(file: string): { bytes: Uint8Array; sha256: string } | null {
  try {
    const bytes = readFileSync(file)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    return null
  }
}

export function removeKept(file: string): void {
  rmSync(file, { force: true })
}

/** `dir` emptied of a copy left before, and the entries written into it: folders and files with their mode. */
export function writeTree(dir: string, entries: readonly TarEntry[]): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const e of entries) {
    const at = join(dir, ...e.path.split('/'))
    if (e.kind === 'folder') {
      mkdirSync(at, { recursive: true })
      continue
    }
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, e.data, { mode: e.mode })
  }
}

export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** What a program said, its last `most` characters, with a password or token in a URL taken out. */
export function saidTail(text: string, most = 600): string {
  return text
    .trim()
    .replace(/:\/\/[^\s/@]+@/g, '://***@')
    .slice(-most)
}

/** `bun install --production` in `dir` with this Bun: whether it ended well, and the end of what it said. */
export async function installProduction(dir: string, timeout: number): Promise<{ ok: boolean; detail: string }> {
  const r = await run(process.execPath, ['install', '--production'], { cwd: dir, timeout })
  return {
    ok: r.code === 0 && !r.killed,
    detail: (r.killed ? 'timed out; ' : '') + saidTail(`${r.stdout}\n${r.stderr}`),
  }
}

/**
 * Whether the new copy's web board loads (its modules, their syntax, the dependencies the install
 * gave): `src/server/app.ts` imported by this Bun in `dir`, nothing started. A copy that does not
 * load stays out, and the old one runs on.
 */
export async function loadsIn(dir: string, timeout: number): Promise<{ ok: boolean; detail: string }> {
  const file = join(dir, 'src', 'server', 'app.ts')
  if (!existsSync(file)) return { ok: true, detail: '' }
  const r = await run(process.execPath, ['-e', "await import('./src/server/app.ts'); process.exit(0)"], {
    cwd: dir,
    timeout,
  })
  return {
    ok: r.code === 0 && !r.killed,
    detail: (r.killed ? 'timed out; ' : '') + saidTail(`${r.stdout}\n${r.stderr}`),
  }
}

/**
 * The fresh copy in the plugin's place, by its entries: each of the plugin folder's moved into
 * `old` (an older copy there goes first), then each of `fresh`'s into the plugin folder. The
 * folder itself stays: the panes herdr started in it (the board's, wake's) keep a folder that
 * exists, which a moved and later removed folder would not be. A rename that fails puts back what
 * was moved, so the plugin's folder holds the copy it held.
 */
export function swapIn(
  root: string,
  fresh: string,
  old: string,
  rename: (from: string, to: string) => void = renameWithRetry,
): void {
  rmSync(old, { recursive: true, force: true })
  mkdirSync(old, { recursive: true })
  const moved: string[] = []
  const placed: string[] = []
  const back = (): void => {
    for (const name of placed.reverse()) renameSync(join(root, name), join(fresh, name))
    for (const name of moved.reverse()) renameSync(join(old, name), join(root, name))
  }
  try {
    for (const name of readdirSync(root)) {
      rename(join(root, name), join(old, name))
      moved.push(name)
    }
    for (const name of readdirSync(fresh)) {
      rename(join(fresh, name), join(root, name))
      placed.push(name)
    }
  } catch (err) {
    back()
    throw err
  }
  rmSync(fresh, { recursive: true, force: true })
}

/**
 * One code file's times set to now, in `dir`'s src folder: the watchers of run.ts and wake-run.ts
 * restart their process when the plugin's code changes. A watcher that follows the folder it was
 * given (inotify on Linux follows src into the old copy) sees it there, one that follows the path
 * (macOS) in the new copy: both are touched.
 */
export function touchCode(dir: string): void {
  const file = join(dir, 'src', 'adapters', 'paths.ts')
  if (!existsSync(file)) return
  const now = new Date()
  try {
    utimesSync(file, now, now)
  } catch {}
}

/** Where an update on Windows is (the record's `phase`). */
export type UpdatePhase = 'ready' | 'go' | 'applied' | 'restoring'
const PHASES: readonly string[] = ['ready', 'go', 'applied', 'restoring']

/** What an update on Windows leaves for the guard and for the board that starts on the new code (#699). */
export interface PendingUpdate {
  /** The commit the update puts in place. */
  commit: string
  /** The commit the plugin was on. */
  from: string
  /** The plugin's folder. */
  root: string
  /** The full copy of the plugin before the update (`<name>.old`). */
  old: string
  /** The new copy, unpacked and installed, beside the plugin's folder (`<name>.new`). */
  fresh: string
  /**
   * `ready`: the guard runs, the board has not said go. `go`: the guard puts the copy in place.
   * `applied`: it is in place (`at` is the time it was) and the board is to come back on it.
   * `restoring`: the copy before is being put back (a try that failed is tried again).
   */
  phase: UpdatePhase
  at: number
}

export function writePending(file: string, p: PendingUpdate): void {
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, `${JSON.stringify(p)}\n`)
}

export function readPending(file: string): PendingUpdate | null {
  const raw = readJson(file, isRecord)
  if (!raw) return null
  const { commit, from, root, old, fresh, phase, at } = raw
  if (typeof commit !== 'string' || typeof from !== 'string' || typeof root !== 'string') return null
  if (typeof old !== 'string' || typeof fresh !== 'string') return null
  if (typeof phase !== 'string' || !PHASES.includes(phase)) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  return { commit, from, root, old, fresh, phase: phase as UpdatePhase, at }
}

export function removePending(file: string): void {
  rmSync(file, { force: true })
}

/** The record's phase changed; nothing when there is no record. */
export function setPhase(file: string, phase: UpdatePhase): void {
  const p = readPending(file)
  if (p) writePending(file, { ...p, phase })
}

/** The board says go: the guard puts the new copy in place. */
export const markGo = (file: string): void => setPhase(file, 'go')

/**
 * The pending record taken for good: renamed away first, so of the board that confirms and the
 * guard that rolls back only one gets it. Null when there is none, or someone else took it.
 */
export function claimPending(file: string): PendingUpdate | null {
  const mine = `${file}.rollback`
  try {
    renameSync(file, mine)
  } catch {
    return null
  }
  const p = readPending(mine)
  rmSync(mine, { force: true })
  return p
}

const aliveFile = (file: string): string => `${file}.alive`

/** The guard says it runs: its pid and the time, beside the record. */
export function writeAlive(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(aliveFile(file), `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`)
}

/** When the guard last said it runs; null when it has not. */
export function aliveAt(file: string): number | null {
  const raw = readJson(aliveFile(file), isRecord)
  return raw && typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null
}

export function removeAlive(file: string): void {
  rmSync(aliveFile(file), { force: true })
}

/**
 * A full copy of the plugin's folder in `old` (what was there goes first): the rollback's source.
 * Made off the event loop; a checkout's `.git` is not copied here (applyUpdate moves it).
 */
export async function backupPlugin(root: string, old: string): Promise<void> {
  await rm(old, { recursive: true, force: true })
  const git = join(root, '.git')
  await cp(root, old, { recursive: true, verbatimSymlinks: true, filter: src => src !== git })
}

/** `file` replaced by `data` through a temp file beside it, renamed over it (a `.tmp` name no watcher takes for code). */
function replaceBytes(file: string, data: Uint8Array, mode: number): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, { mode })
    renameWithRetry(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

const kindOf = (path: string): 'dir' | 'file' | 'link' | null => {
  try {
    const st = lstatSync(path)
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

type Write = (file: string, data: Uint8Array, mode: number) => void

/**
 * Entries of `to` that `from` lacks, or has as another kind, removed (recursively into folders both
 * have). By the names `from` lists: on a case-insensitive disk (NTFS) a look up of `from/Foo.ts`
 * would find `foo.ts`, and a name that changes only in case would stay as it was.
 */
function pruneTree(from: string, to: string, keep: ReadonlySet<string>): void {
  const names = new Set(readdirSync(from))
  for (const name of readdirSync(to)) {
    if (keep.has(name)) continue
    const there = join(to, name)
    if (!names.has(name)) {
      rmSync(there, { recursive: true, force: true })
      continue
    }
    const kind = kindOf(there)
    if (kindOf(join(from, name)) !== kind) rmSync(there, { recursive: true, force: true })
    else if (kind === 'dir') pruneTree(join(from, name), there, new Set())
  }
}

function fillEntry(src: string, dst: string, write: Write): void {
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    const target = readlinkSync(src)
    if (kindOf(dst) === 'link' && readlinkSync(dst) === target) return
    rmSync(dst, { recursive: true, force: true })
    symlinkSync(target, dst)
  } else if (st.isDirectory()) {
    fillTree(src, dst, write, new Set())
  } else {
    const data = readFileSync(src)
    if (kindOf(dst) === 'file') {
      const have = lstatSync(dst)
      if (have.size === data.length && readFileSync(dst).equals(data)) return
    }
    write(dst, data, st.mode & 0o777)
  }
}

function fillTree(from: string, to: string, write: Write, skip: ReadonlySet<string>): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) if (!skip.has(name)) fillEntry(join(from, name), join(to, name), write)
}

/** Both are files with the same bytes. */
function same(a: string, b: string): boolean {
  if (kindOf(a) !== 'file' || kindOf(b) !== 'file') return false
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/**
 * `to` made to hold exactly `from`'s tree, file by file: what `from` lacks is removed first, then
 * each file that is missing or different is written through a temp file and renamed over. `to`
 * itself and the folders both have stay (a running board holds its files, which Windows will not
 * let be renamed away, but does let be replaced), a file that is the same is not touched.
 * `last`: top level names (the commit stamp) written after everything else, and taken out first
 * when they differ, so a copy that is half done has no stamp and reads as no commit. `keep`: top
 * level names of `to` that stay whatever `from` holds.
 */
export function mirrorTree(
  from: string,
  to: string,
  write: Write = replaceBytes,
  o: { last?: readonly string[]; keep?: readonly string[] } = {},
): void {
  const last = new Set(o.last ?? [])
  mkdirSync(to, { recursive: true })
  for (const name of last) {
    if (kindOf(join(to, name)) !== null && !same(join(from, name), join(to, name)))
      rmSync(join(to, name), { recursive: true, force: true })
  }
  pruneTree(from, to, new Set(o.keep ?? []))
  fillTree(from, to, write, last)
  for (const name of last) if (kindOf(join(from, name)) !== null) fillEntry(join(from, name), join(to, name), write)
}

/**
 * The new copy `fresh` put into the plugin's folder (the guard's work): a checkout's `.git` moves
 * into the copy before first (the new copy has none), then the files go in with the commit stamp
 * last.
 */
export function applyUpdate(fresh: string, root: string, old: string, write?: Write): void {
  const git = join(root, '.git')
  if (kindOf(git) !== null) {
    rmSync(join(old, '.git'), { recursive: true, force: true })
    mkdirSync(old, { recursive: true })
    renameWithRetry(git, join(old, '.git'))
  }
  mirrorTree(fresh, root, write, { last: [ARCHIVE_COMMIT_FILE] })
}

/** The copy before put back into the plugin's folder (the guard's rollback); a `.git` there stays. */
export function restorePlugin(old: string, root: string): void {
  mirrorTree(old, root, undefined, { last: [ARCHIVE_COMMIT_FILE], keep: ['.git'] })
}

/**
 * The guard (entrypoints/node-update-guard.ts) started by `script`, a process of its own that
 * outlives this board: it waits for the board's go, puts the new copy in place and puts the copy
 * before back when the board does not come back on it. Its folder is the state's, never the
 * plugin's, which a process would hold on Windows. Throws when it did not start.
 */
export function startGuard(script: string, file: string): void {
  if (!existsSync(script)) throw new Error(`no guard at ${script}`)
  const child = spawn(process.execPath, [script, file], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
    cwd: dirname(file),
  })
  child.on('error', () => {})
  if (child.pid === undefined) throw new Error('the process did not start')
  child.unref()
}
