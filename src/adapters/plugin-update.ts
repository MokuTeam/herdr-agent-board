// The node's files for an update of its plugin (#590, docs/design/nodes 6.2, 11.3): the archive its
// master sends, kept as it comes; the archive's entries (core/tar.ts) written into a fresh folder
// beside the plugin's; `bun install --production` there; and the swap of the two folders. The
// decisions are services/node/update.ts's; this only does what it is told.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { TarEntry } from '../core/tar.ts'
import { archiveStamp, headCommit } from './git.ts'
import { renameWithRetry } from './json-store.ts'
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
