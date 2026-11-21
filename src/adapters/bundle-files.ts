// Walking a Claude profile folder for its bundle (design: docs/design/nodes, 9.1): `skills/`,
// `agents/`, `commands/` and `CLAUDE.md` as files hashed by content, the files of the folder a hook
// that travels names (its script), `settings.json`, and only `mcpServers` and the owner's answers to
// notices (core/bundle.ts ACKNOWLEDGMENTS) out of `.claude.json`. A data file beside a script that
// the script names is read only to say whether it holds a secret (#603). Nothing else of the folder
// is opened: no credentials, no transcripts, no per-project memory.
// core/bundle.ts classifies what this finds. On a node: the blobs it was sent, its backups, and
// writing a file by a temporary name (services/node/bundle.ts applies).

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  acknowledgmentsOf,
  type BundleContext,
  type BundleFile,
  classifySettings,
  dataFile,
  namedIn,
  type ProfileParts,
  type SkipWhy,
  secretKeysIn,
} from '../core/bundle.ts'

/** A file over this many bytes stays on the master, with a line in the report. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
/** Folders that are never walked into, wherever they are. */
export const SKIP_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git', '.venv', '__pycache__'])
/** Names never read, wherever a link leads: Claude's credentials and state, ssh keys. */
export const DENIED: ReadonlySet<string> = new Set(['.credentials.json', '.claude.json', '.ssh'])
/** The folders and the file of a profile that travel. */
export const PROFILE_FOLDERS = ['skills', 'agents', 'commands'] as const
export const PROFILE_FILES = ['CLAUDE.md'] as const

/** A walked file: what the manifest lists, and where its bytes are for sending. */
export interface WalkedFile extends BundleFile {
  /** The file read, a link's target for a link. */
  source: string
  size: number
}

export interface ProfileRead extends ProfileParts {
  files: WalkedFile[]
}

/**
 * Nothing is built from a folder that is not there, or whose settings.json or .claude.json does
 * not parse: an empty part would remove what the node has.
 */
export type ReadResult =
  | { ok: true; parts: ProfileRead }
  | { ok: false; why: 'no-folder' | 'settings' | 'claude-json'; file: string }

export interface ReadOptions extends Pick<BundleContext, 'to' | 'home' | 'boardDir' | 'programs'> {
  /**
   * The profile's .claude.json: `<dir>/.claude.json` for a profile CLAUDE_CONFIG_DIR names, but
   * `~/.claude.json`, beside the folder, for the default one. Asked for, as a wrong guess would
   * send no servers and so remove the node's.
   */
  claudeJson: string
  /** The platform the folder is on; the running one when not given. */
  platform?: string
}

/**
 * A file's mode for the manifest. Windows keeps no executable bit, so there a file that starts
 * with `#!` is 0755 (a hook script the node runs) and any other 0644.
 */
export function modeOf(st: Pick<Stats, 'mode'>, head: Uint8Array, platform: string): number {
  if (platform !== 'win32') return st.mode & 0o777
  return head[0] === 0x23 && head[1] === 0x21 ? 0o755 : 0o644
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function parseJson(file: string): { ok: true; value: unknown } | { ok: false } {
  if (!existsSync(file)) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }
  } catch {
    return { ok: false }
  }
}

/**
 * What of the profile folder `dir` a bundle is built from. Links are followed and their target's
 * content travels, except a link to the profile folder or a folder above it, into a part of it
 * that is never sent, to a name in DENIED, or back to a folder the walk is in. Every file or folder
 * left out is in `skipped` with the reason.
 */
export function readProfile(dir: string, opts: ReadOptions): ReadResult {
  const platform = opts.platform ?? process.platform
  let isFolder = false
  try {
    isFolder = statSync(dir).isDirectory()
  } catch {}
  if (!isFolder) return { ok: false, why: 'no-folder', file: dir }
  const settingsFile = join(dir, 'settings.json')
  const settings = parseJson(settingsFile)
  if (!settings.ok) return { ok: false, why: 'settings', file: settingsFile }
  const state = parseJson(opts.claudeJson)
  if (!state.ok) return { ok: false, why: 'claude-json', file: opts.claudeJson }
  const mcpServers =
    state.value && typeof state.value === 'object' && !Array.isArray(state.value)
      ? (state.value as Record<string, unknown>).mcpServers
      : undefined
  const ctx: BundleContext = { from: platform, to: opts.to, profileDir: dir }
  if (opts.home) ctx.home = opts.home
  if (opts.boardDir) ctx.boardDir = opts.boardDir
  if (opts.programs) ctx.programs = opts.programs
  const scripts = classifySettings(settings.value, ctx).scripts

  const files: WalkedFile[] = []
  const skipped: { path: string; why: SkipWhy }[] = []
  const followed: string[] = []
  const fold = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s
  }
  const real = (p: string): string | null => {
    try {
      return fold(realpathSync(p))
    } catch {
      return null
    }
  }
  const root = real(dir) ?? fold(dir)
  // The parts that travel, by where they are under the profile folder's real path.
  const sent = [...PROFILE_FOLDERS, ...PROFILE_FILES, ...scripts].map(p => `${root}/${fold(p)}`)
  const within = (p: string, folder: string): boolean => p === folder || p.startsWith(`${folder}/`)
  // The profile folder, a folder above it, or a part of it that is never sent.
  const fenced = (target: string): boolean =>
    within(root, target) || (within(target, root) && !sent.some(s => within(target, s)))

  const visit = (full: string, path: string, stack: readonly string[]): void => {
    const link = lstatSync(full).isSymbolicLink()
    const here = real(full)
    if (!here) {
      skipped.push({ path, why: 'link-broken' })
      return
    }
    if (DENIED.has(basename(full)) || DENIED.has(basename(here))) {
      skipped.push({ path, why: 'denied' })
      return
    }
    if (fenced(here)) {
      skipped.push({ path, why: 'link-into-profile' })
      return
    }
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_FOLDERS.has(basename(full))) {
        skipped.push({ path, why: 'skipped-folder' })
        return
      }
      if (stack.includes(here)) {
        skipped.push({ path, why: 'link-loop' })
        return
      }
      if (link) followed.push(path)
      for (const name of readdirSync(full).sort()) guarded(join(full, name), `${path}/${name}`, [...stack, here])
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) {
        skipped.push({ path, why: 'too-big' })
        return
      }
      const bytes = readFileSync(full)
      if (link) followed.push(path)
      const source = link ? realpathSync(full) : full
      files.push({ path, sha256: sha256(bytes), mode: modeOf(st, bytes, platform), source, size: st.size })
    }
  }
  // A file gone or locked while the walk reads it is a line of the report, not a failed build.
  const guarded = (full: string, path: string, stack: readonly string[]): void => {
    try {
      visit(full, path, stack)
    } catch {
      skipped.push({ path, why: 'unreadable' })
    }
  }

  const kindOf = (full: string): 'folder' | 'file' | 'other' | null => {
    try {
      const st = statSync(full)
      return st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other'
    } catch {
      return existsLink(full) ? 'other' : null
    }
  }
  const existsLink = (full: string): boolean => {
    try {
      return lstatSync(full).isSymbolicLink()
    } catch {
      return false
    }
  }
  for (const part of PROFILE_FOLDERS) {
    const full = join(dir, part)
    const kind = kindOf(full)
    // `skills` that is a file is nothing Claude reads; a broken link is reported.
    if (kind === 'folder' || (kind === 'other' && existsLink(full))) guarded(full, part, [])
  }
  for (const part of PROFILE_FILES) {
    const full = join(dir, part)
    const kind = kindOf(full)
    if (kind === 'file' || (kind === 'other' && existsLink(full))) guarded(full, part, [])
  }
  const taken = new Set(files.map(f => f.path))
  for (const path of scripts) {
    if (taken.has(path)) continue
    const full = join(dir, ...path.split('/'))
    if (kindOf(full) !== 'file') skipped.push({ path, why: 'missing' })
    else guarded(full, path, [])
  }
  const beside = besideScripts(dir, scripts, files)
  const acks = acknowledgmentsOf(state.value)
  return {
    ok: true,
    parts: {
      files,
      skipped,
      followed,
      settings: settings.value,
      mcpServers,
      ...(acks.length > 0 && { acks }),
      ...(beside.length > 0 && { beside }),
    },
  }
}

/** Names beside a script that are never a script's data file: the profile's own settings and state. */
const NOT_BESIDE: ReadonlySet<string> = new Set(['settings.json', 'settings.local.json', ...DENIED])

/**
 * The data files (core/bundle.ts dataFile) beside each script a hook runs that the script's text
 * names (namedIn), by path in the profile folder (#603), each with whether it holds a secret
 * (secretKeysIn). Read to be classified, never kept: no value leaves this function.
 */
function besideScripts(
  dir: string,
  scripts: readonly string[],
  files: readonly WalkedFile[],
): { path: string; script: string; secret: boolean }[] {
  const out: { path: string; script: string; secret: boolean }[] = []
  const walked = new Map(files.map(f => [f.path, f]))
  for (const script of scripts) {
    const f = walked.get(script)
    if (!f) continue
    let text: string
    try {
      text = readFileSync(f.source, 'utf8')
    } catch {
      continue
    }
    const at = script.lastIndexOf('/')
    const folder = at < 0 ? '' : script.slice(0, at)
    let names: string[] = []
    try {
      names = readdirSync(join(dir, ...folder.split('/').filter(Boolean))).sort()
    } catch {
      continue
    }
    for (const name of names) {
      const path = folder ? `${folder}/${name}` : name
      if (path === script || NOT_BESIDE.has(name) || !dataFile(name) || !namedIn(text, name)) continue
      if (out.some(b => b.path === path)) continue
      const full = join(dir, ...path.split('/'))
      try {
        const st = statSync(full)
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
        out.push({ path, script, secret: secretKeysIn(readFileSync(full, 'utf8')).length > 0 })
      } catch {}
    }
  }
  return out
}

// ------------------------------------------------------------------ the node's side (9.3)

/** A blob over this many bytes is refused at the door (6.2). */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024
/** Backup folders kept per profile, the newest by seq (9.3, item 3). */
export const BACKUPS_KEPT = 10

/**
 * `bytes` written to `file` by a temporary name beside it and a rename, so a reader never sees half
 * of it; its folder made first. `mode` on POSIX (the umask may have taken bits off).
 */
export function writeWhole(file: string, bytes: Uint8Array | string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, bytes, mode === undefined ? undefined : { mode })
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** The blobs a node was sent, by their SHA-256, in `<state>/node/blobs/`. */
export interface BlobStore {
  has(sha: string): boolean
  read(sha: string): Buffer
  /** Stores `bytes` as `sha`; false when they are not that hash. One already there is not written again. */
  put(sha: string, bytes: Uint8Array): boolean
  /** Removes every blob not in `keep`. */
  prune(keep: ReadonlySet<string>): void
}

const SHA256 = /^[0-9a-f]{64}$/

export function createBlobStore(dir: string): BlobStore {
  const path = (sha: string): string => {
    if (!SHA256.test(sha)) throw new Error(`not a SHA-256: ${sha.slice(0, 80)}`)
    return join(dir, sha)
  }
  return {
    has: sha => SHA256.test(sha) && existsSync(path(sha)),
    read: sha => readFileSync(path(sha)),
    put(sha, bytes) {
      if (sha256(bytes) !== sha) return false
      if (!existsSync(path(sha))) writeWhole(path(sha), bytes, 0o600)
      return true
    },
    prune(keep) {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      // A temporary name is a write that stopped half way: puts are synchronous, so none is under way.
      for (const name of names)
        if ((SHA256.test(name) && !keep.has(name)) || name.endsWith('.tmp')) rmSync(join(dir, name), { force: true })
    },
  }
}

/** A file's SHA-256 (hex), or null when there is no file there (a folder, nothing). */
export function fileSha(file: string): string | null {
  try {
    if (!lstatSync(file).isFile()) return null
    return sha256(readFileSync(file))
  } catch {
    return null
  }
}

/** Whether there is anything at all at `file`, a broken link too. */
export function anythingAt(file: string): boolean {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a link is on the way from the profile folder `dir` to `path` (forward slashes, in the
 * folder), the file itself included: a write through it would land outside the folder. The folder
 * itself may be a link (a profile kept elsewhere); what is below it may not.
 */
export function linkOnTheWay(dir: string, path: string): boolean {
  let at = dir
  for (const part of path.split('/')) {
    at = join(at, part)
    try {
      if (lstatSync(at).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

/** Copies `from` to `<folder>/<name>` (forward slashes in `name`), its folders made. */
export function backUp(folder: string, name: string, from: string): void {
  const to = join(folder, ...name.split('/'))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/**
 * A new backup folder for the commit of `seq` in `dir`: `<seq>`, or `<seq>-1`, `-2`... when one of
 * that name is there already (the master's record was lost and its seq started over). Not made yet.
 */
export function backupFolder(dir: string, seq: number): string {
  for (let n = 0; ; n++) {
    const at = join(dir, n ? `${seq}-${n}` : String(seq))
    if (!existsSync(at)) return at
  }
}

/**
 * Keeps the `kept` newest backup folders of a profile by when they were made, removes the older
 * ones: the one a commit just wrote is always kept, whatever its seq.
 */
export function pruneBackups(dir: string, kept = BACKUPS_KEPT): void {
  let folders: { name: string; at: number }[] = []
  try {
    folders = readdirSync(dir)
      .filter(n => /^\d+(-\d+)?$/.test(n))
      .map(name => ({ name, at: statSync(join(dir, name)).mtimeMs }))
  } catch {
    return
  }
  const old = folders.sort((a, b) => b.at - a.at).slice(kept)
  for (const { name } of old) rmSync(join(dir, name), { recursive: true, force: true })
}

/**
 * A file of the profile rewritten whole, as it was in all else: through a link to where it really
 * is (a settings.json kept in dotfiles), with the mode it had (`~/.claude.json` is 0600).
 */
export function rewriteKeeping(file: string, text: string): void {
  let target = file
  let mode: number | undefined
  try {
    target = realpathSync(file)
    mode = statSync(target).mode & 0o777
  } catch {}
  writeWhole(target, text, mode)
}

/** What came of editJson: written, nothing to change, the file not JSON, or rewritten by another each time. */
export type JsonEdit = 'written' | 'same' | 'parse' | 'busy'

/**
 * A JSON object file changed by `change` (given its value, undefined when there is none; null back:
 * nothing to change), written beside it and renamed, through a link to where it really is, with the
 * mode it had (0600 for a new one). Claude's running sessions rewrite their state file whenever
 * they like: when the file is no longer what was read by the time the new text is ready, it is
 * read and changed again, up to `tries` times, and then left as it is ('busy').
 */
export function editJson(
  file: string,
  change: (value: Record<string, unknown> | undefined) => Record<string, unknown> | null,
  tries = 3,
): JsonEdit {
  let target = file
  try {
    target = realpathSync(file)
  } catch {}
  const readText = (): string | null => {
    try {
      return readFileSync(target, 'utf8')
    } catch {
      return null
    }
  }
  for (let n = 0; n < tries; n++) {
    const before = readText()
    let value: unknown
    try {
      value = before === null ? undefined : JSON.parse(before.replace(/^\uFEFF/, ''))
    } catch {
      return 'parse'
    }
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) return 'parse'
    const next = change(value as Record<string, unknown> | undefined)
    if (next === null) return 'same'
    let mode = 0o600
    try {
      mode = statSync(target).mode & 0o777
    } catch {}
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode })
      chmodSync(tmp, mode)
      // Rewritten meanwhile: this text would lose what was written, so again from the new one.
      if (readText() !== before) {
        rmSync(tmp, { force: true })
        continue
      }
      renameSync(tmp, target)
      return 'written'
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }
  return 'busy'
}

/** Removes `file` and then each folder above it that it left empty, up to `dir` (kept). */
export function removeFile(dir: string, file: string): void {
  rmSync(file, { force: true })
  const stop = resolve(dir)
  let at = dirname(resolve(file))
  while (at !== stop && at.startsWith(stop)) {
    try {
      if (readdirSync(at).length) return
      rmdirSync(at)
    } catch {
      return
    }
    at = dirname(at)
  }
}
