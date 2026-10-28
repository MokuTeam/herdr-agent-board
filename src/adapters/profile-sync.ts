// One side of the profile sync (the board-on-own-server spec's "Next step: syncing the Claude
// profiles"), on this computer for the local board and on the server for the board's user
// (entrypoints/profile-sync.ts): its Claude profiles, each file's hash (kept by size and time, so
// an unchanged file is not read again), the hashes of the last sync with the other side (in the
// board's state folder, one file per other side), its projects with their paths and git remotes,
// the clones under its home (the server's), what it would hold back; a file made ready to send
// (its secrets cut, its paths moved to the target's); the writes, merges and deletions on the
// target, with each file's new hash recorded as it goes; and the frames both sides speak, packed
// with gzip, over ssh's stdin and stdout.
//
// The target never writes a secret file or a file of one machine only, whatever comes, nor
// outside the profile's folder; nor a file that changed there since the preview, nor over its own
// copy a file a secret was cut from, nor what the owner did not tick; it merges into a JSON file
// only when it reads as one (a copy kept before its first merge), and keeps each file's mode.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Writable } from 'node:stream'
import { createGzip } from 'node:zlib'
import {
  type CloneFact,
  type Move,
  moved,
  nativePath,
  type Platform,
  type ProjectFact,
  pathKey,
  projectFolder,
  remoteKey,
} from '../core/profile-sync/paths.ts'
import {
  type Manifest,
  type ProfileFacts,
  type ProfilePlan,
  profileDir,
  type Ticks,
} from '../core/profile-sync/plan.ts'
import {
  mergeClaudeJson,
  mergeHistory,
  mergeSettings,
  rewriteCwd,
  rewriteHistory,
} from '../core/profile-sync/rewrite.ts'
import {
  type Allow,
  boardCommand,
  type CarryTo,
  cutSecrets,
  cutSecretsInFile,
  fileGroup,
  historyFile,
  MERGED,
  oneMachine,
  ownEnvName,
  secretFile,
  shareClaudeJson,
  shareSettings,
  withhold,
} from '../core/profile-sync/secrets.ts'
import type { Skipped, SkipWhy } from '../core/profile-sync/view.ts'
import { CHECKOUT } from '../core/server-install.ts'
import { isRecord, replaceFile } from './json-store.ts'
import { stateDir } from './paths.ts'
import { run } from './process.ts'
import { findProfileDirs } from './profiles.ts'

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/** A profile of this side: its name, its folder, and where its .claude.json lies. */
export interface SideProfile {
  name: string
  dir: string
  claudeJson: string
}

/**
 * A profile's .claude.json: the one in its folder when there is one; the default profile's is
 * else ~/.claude.json, where Claude keeps it when CLAUDE_CONFIG_DIR is not set.
 */
export const claudeJsonOf = (dir: string, name: string, home: string): string =>
  name !== 'default' || existsSync(join(dir, '.claude.json')) ? join(dir, '.claude.json') : join(home, '.claude.json')

/** This side's profiles (adapters/profiles.ts findProfileDirs): default (~/.claude), and <name> for each ~/.claude-<name>. */
export function sideProfiles(home: string): SideProfile[] {
  const own = join(home, '.claude')
  return findProfileDirs(home).map(dir => {
    const name = dir === own ? 'default' : basename(dir).replace(/^\.claude-/, '')
    return { name, dir, claudeJson: claudeJsonOf(dir, name, home) }
  })
}

interface Walked {
  files: Map<string, { abs: string; size: number; mtime: number }>
  secretFiles: string[]
}

/** A profile's files at every level, but the one machine's own, the secret files (listed) and links. */
export function walkProfile(p: SideProfile): Walked {
  const files: Walked['files'] = new Map()
  const secretFiles: string[] = []
  const visit = (abs: string, rel: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (oneMachine(r) || e.isSymbolicLink()) continue
      const a = join(abs, e.name)
      if (e.isDirectory()) {
        visit(a, r)
        continue
      }
      // the profile's own .claude.json is taken below, wherever it lies
      if (!e.isFile() || r === '.claude.json') continue
      if (secretFile(r)) {
        secretFiles.push(r)
        continue
      }
      try {
        const st = statSync(a)
        files.set(r, { abs: a, size: st.size, mtime: st.mtimeMs })
      } catch {}
    }
  }
  visit(p.dir, '')
  try {
    const st = statSync(p.claudeJson)
    files.set('.claude.json', { abs: p.claudeJson, size: st.size, mtime: st.mtimeMs })
  } catch {}
  return { files, secretFiles }
}

/** A text without the byte order mark an editor on Windows may have put first. */
const noBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
const readText = (abs: string): string => noBom(readFileSync(abs, 'utf8'))
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf])
const BOM16 = Buffer.from([0xff, 0xfe])
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A file's text and how it is written: UTF-8 (with its BOM or not), UTF-16 with its BOM, or bytes not UTF-8 read one character a byte. */
interface Decoded {
  text: string
  enc: 'utf8' | 'utf16le' | 'latin1'
  bom: boolean
}

/**
 * A file read as text, so that written back with no change it is the same bytes: UTF-8 when it
 * is (its BOM kept apart), UTF-16 after its BOM (PowerShell's own), else one character a byte
 * (ANSI, cp1251: nothing garbled, a token, being ASCII, still found). Null: not text (a NUL in it).
 */
function decodeText(data: Buffer): Decoded | null {
  if (data.length % 2 === 0 && data.subarray(0, 2).equals(BOM16)) {
    const text = data.subarray(2).toString('utf16le')
    if (Buffer.from(text, 'utf16le').equals(data.subarray(2))) return { text, enc: 'utf16le', bom: true }
  }
  if (data.subarray(0, 8192).includes(0)) return null
  const bom = data.subarray(0, 3).equals(BOM8)
  try {
    return { text: UTF8.decode(bom ? data.subarray(3) : data), enc: 'utf8', bom }
  } catch {
    return { text: data.toString('latin1'), enc: 'latin1', bom: false }
  }
}

const encodeText = (text: string, d: Decoded): Buffer =>
  d.enc === 'utf16le'
    ? Buffer.concat([BOM16, Buffer.from(text, 'utf16le')])
    : d.enc === 'latin1'
      ? Buffer.from(text, 'latin1')
      : Buffer.concat([d.bom ? BOM8 : Buffer.alloc(0), Buffer.from(text, 'utf8')])

/** The secrets in a file, by kind: in its text as its kind reads it; in a file not text (`whole`: none can be cut from it). */
function secretsOf(rel: string, data: Buffer): { kinds: string[]; whole: boolean } {
  const d = decodeText(data)
  if (!d) return { kinds: Object.keys(cutSecrets(data.toString('latin1')).found), whole: true }
  const r = d.enc === 'latin1' ? cutSecrets(d.text) : cutSecretsInFile(rel, d.text)
  return { kinds: Object.keys(r.found), whole: false }
}

/** A file merged by key is hashed by its shared part (its secrets and the machine's own state left out), the others as they are. */
export function hashOf(rel: string, data: Buffer | string): string {
  const json = (): unknown => parsed(noBom(String(data)))
  if (rel === '.claude.json') return sha(JSON.stringify(shareClaudeJson(json(), null).value))
  if (rel === 'settings.json') return sha(JSON.stringify(shareSettings(json(), null).value))
  return sha(data)
}

// ---------------------------------------------------------------------------------------------
// The hashes of the last sync, and the files' hashes kept by size and time

const syncDir = (): string => join(stateDir(), 'profile-sync')
const peerFile = (peer: string): string => join(syncDir(), `${peer.replace(/[^A-Za-z0-9._-]/g, '_') || 'peer'}.json`)
const hashFile = (): string => join(syncDir(), 'hashes.json')

type Synced = Record<string, Record<string, string>>

/** The hashes of the last sync with `peer`, by profile and file. */
export function readSynced(peer: string): Synced {
  try {
    const v = JSON.parse(readFileSync(peerFile(peer), 'utf8'))
    return isRecord(v) && isRecord(v.profiles) ? (v.profiles as Synced) : {}
  } catch {
    return {}
  }
}

function writeSynced(peer: string, profiles: Synced): void {
  mkdirSync(syncDir(), { recursive: true })
  replaceFile(peerFile(peer), `${JSON.stringify({ v: 1, peer, at: new Date().toISOString(), profiles })}\n`)
}

/** Changes to the hashes of the last sync with `peer`: a file's new hash, or none (null: deleted, or gone on both sides). */
export function recordSynced(
  peer: string,
  changes: readonly { profile: string; rel: string; hash: string | null }[],
): void {
  if (changes.length === 0) return
  const all = readSynced(peer)
  for (const c of changes) {
    all[c.profile] ??= {}
    const p = all[c.profile] as Record<string, string>
    if (c.hash === null) delete p[c.rel]
    else p[c.rel] = c.hash
  }
  writeSynced(peer, all)
}

type HashCache = Record<string, [size: number, mtime: number, hash: string]>

function readHashCache(): HashCache {
  try {
    const v = JSON.parse(readFileSync(hashFile(), 'utf8'))
    return isRecord(v) ? (v as HashCache) : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------------------------
// Projects and clones

/**
 * A folder's clone: its top folder, its remote (origin, else the first) as a key only (no user, no
 * token: it goes to the other side), whether it is a worktree; null when it is in none.
 */
async function gitFacts(
  path: string,
  platform: Platform,
): Promise<{ top: string; remote: string | null; worktree: boolean } | null> {
  const r = await run(
    'git',
    ['-C', path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
    { timeout: 20_000 },
  )
  if (r.code !== 0) return null
  const [top = '', gitDir = '', common = ''] = r.stdout.trim().split(/\r?\n/)
  if (!top) return null
  const urls = await run('git', ['-C', path, 'config', '--get-regexp', '^remote\\..*\\.url$'], { timeout: 20_000 })
  const remotes = urls.stdout
    .split(/\r?\n/)
    .map(l => /^remote\.(.+)\.url\s+(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
  const remote = remoteKey((remotes.find(m => m[1] === 'origin') ?? remotes[0])?.[2] ?? null)
  return {
    top: nativePath(top, platform),
    remote,
    worktree: pathKey(gitDir, platform) !== pathKey(common, platform),
  }
}

/** The `cwd`s near the start of a transcript (its first 256 KB). */
function cwdsIn(abs: string): string[] {
  let fd: number
  try {
    fd = openSync(abs, 'r')
  } catch {
    return []
  }
  try {
    const buf = Buffer.alloc(256 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const out = new Set<string>()
    for (const m of buf.toString('utf8', 0, n).matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try {
        out.add(JSON.parse(`"${m[1]}"`))
      } catch {}
      if (out.size > 20) break
    }
    return [...out]
  } finally {
    closeSync(fd)
  }
}

/**
 * Where a project folder's project is: the path among its transcripts' `cwd`s (the newest three)
 * and .claude.json's projects whose Claude name is the folder's; null when none is.
 */
function projectPath(folderAbs: string, folder: string, known: readonly string[], platform: Platform): string | null {
  let transcripts: { abs: string; at: number }[] = []
  try {
    transcripts = readdirSync(folderAbs)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const abs = join(folderAbs, f)
        return { abs, at: statSync(abs).mtimeMs }
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 3)
  } catch {}
  const candidates = [...transcripts.flatMap(t => cwdsIn(t.abs)), ...known].map(p => nativePath(p, platform))
  return candidates.find(c => projectFolder(c) === folder) ?? null
}

/** The clones under a home, down to `depth` folders (hidden folders, node_modules and the board's own checkout passed by). */
export function findClones(home: string, depth = 4): string[] {
  const out: string[] = []
  const visit = (dir: string, d: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (d > 0 && entries.some(e => e.name === '.git')) {
      out.push(dir)
      return
    }
    if (d >= depth) return
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      if (d === 0 && e.name === CHECKOUT) continue
      visit(join(dir, e.name), d + 1)
    }
  }
  visit(home, 0)
  return out.sort()
}

// ---------------------------------------------------------------------------------------------
// A side's scan

/**
 * What this side has (Manifest): its profiles' files and hashes, the last sync's hashes with
 * `peer`, settings.json's and .claude.json's shared parts (for the keys a merge adds or changes),
 * its projects and (with `clones`, the server) the clones under its home, their remotes as keys.
 * As the source (`to`: the target's system and home), also what it would hold back: the secrets
 * in the files changed since the last sync (history.jsonl's too), and what settings.json and
 * .claude.json keep or cannot send.
 */
export async function scanSide(o: {
  home: string
  platform: Platform
  peer: string
  to: CarryTo | null
  clones: boolean
}): Promise<Manifest> {
  const synced = readSynced(o.peer)
  const cache = readHashCache()
  const nextCache: HashCache = {}
  const profiles: ProfileFacts[] = []
  const projects: ProjectFact[] = []
  const findings: Manifest['findings'] = []
  const held: Manifest['held'] = []
  const cantGo: Manifest['cantGo'] = []
  for (const p of sideProfiles(o.home)) {
    const walked = walkProfile(p)
    let turns = 0
    const last = synced[p.name] ?? {}
    const files: ProfileFacts['files'] = {}
    for (const [rel, f] of walked.files) {
      // the board serves its pages meanwhile: a turn of its own every 100 files
      if (++turns % 100 === 0) await new Promise(resolve => setImmediate(resolve))
      let hash: string
      try {
        if (rel === '.claude.json' || rel === 'settings.json') hash = hashOf(rel, readFileSync(f.abs))
        else {
          const c = cache[f.abs]
          hash = c && c[0] === f.size && c[1] === f.mtime ? c[2] : sha(readFileSync(f.abs))
          nextCache[f.abs] = [f.size, f.mtime, hash]
        }
      } catch {
        continue
      }
      files[rel] = [hash, f.size]
      // settings.json's and .claude.json's secrets are held key by key (below); history.jsonl's are cut
      if (o.to && rel !== 'settings.json' && rel !== '.claude.json' && last[rel] !== hash) {
        try {
          const found = secretsOf(rel, readFileSync(f.abs))
          if (found.kinds.length)
            findings.push({ profile: p.name, rel, kinds: found.kinds, ...(found.whole && { whole: true }) })
        } catch {}
      }
    }
    let cj: unknown = null
    try {
      cj = parsed(readText(p.claudeJson))
    } catch {}
    let settings: unknown = null
    try {
      settings = parsed(readText(join(p.dir, 'settings.json')))
    } catch {}
    const statusLine = isRecord(settings) && isRecord(settings.statusLine) ? settings.statusLine.command : null
    profiles.push({
      name: p.name,
      dir: p.dir,
      files,
      synced: last,
      secretFiles: walked.secretFiles,
      views: { settings: shareSettings(settings, null).value, claudeJson: shareClaudeJson(cj, null).value },
      boardStatusLine: typeof statusLine === 'string' && boardCommand(statusLine),
    })
    if (o.to) {
      const s = shareSettings(settings, o.to)
      const c = shareClaudeJson(cj, o.to)
      for (const what of [...s.held, ...c.held]) held.push({ profile: p.name, what })
      for (const what of [...s.cantGo, ...c.cantGo]) cantGo.push({ profile: p.name, what })
    }
    // its projects: each folder under projects/, its path, its clone
    const known = isRecord(cj) && isRecord(cj.projects) ? Object.keys(cj.projects) : []
    const folders = new Map<string, { files: number; bytes: number }>()
    for (const [rel, [, size]] of Object.entries(files)) {
      const parts = rel.split('/')
      if (parts[0] !== 'projects' || parts.length < 3) continue
      const f = folders.get(parts[1] as string) ?? { files: 0, bytes: 0 }
      f.files++
      f.bytes += size
      folders.set(parts[1] as string, f)
    }
    for (const [folder, count] of folders) {
      const path = projectPath(join(p.dir, 'projects', folder), folder, known, o.platform)
      const there = path !== null && existsSync(path)
      const git = there ? await gitFacts(path, o.platform) : null
      projects.push({
        profile: p.name,
        folder,
        path,
        state: path === null ? 'unknown' : !there ? 'gone' : git ? 'git' : 'plain',
        remote: git?.remote ?? null,
        top: git?.top ?? null,
        worktree: git?.worktree ?? false,
        files: count.files,
        bytes: count.bytes,
      })
    }
  }
  const clones: CloneFact[] = []
  if (o.clones)
    for (const dir of findClones(o.home)) {
      const git = await gitFacts(dir, o.platform)
      if (git?.remote && !git.worktree) clones.push({ path: git.top, remote: git.remote })
    }
  try {
    mkdirSync(syncDir(), { recursive: true })
    replaceFile(hashFile(), JSON.stringify(nextCache))
  } catch {}
  return { v: 1, platform: o.platform, home: o.home, profiles, projects, clones, findings, held, cantGo }
}

// ---------------------------------------------------------------------------------------------
// The source: a file made ready to send

/** How the source sends: to whom (system, home), the projects' paths moved, the groups ticked. */
export interface PackCtx {
  to: CarryTo
  moves: readonly Move[]
  allow: Allow
}

const TRANSCRIPT = /^projects\/[^/]+\/.+\.jsonl$/

/** A file of a profile on this side by its path in the profile: .claude.json wherever it lies, the rest in the folder. */
export const fileOf = (p: SideProfile, rel: string): string =>
  rel === '.claude.json' ? p.claudeJson : join(p.dir, ...rel.split('/'))

/** A file made ready to send: its body, its hash here (recorded after the sync), the secrets cut by kind. */
export interface Prepared {
  body: Buffer
  hash: string
  found: Record<string, number>
  /** A secret was cut from a file sent whole: the target writes it only where it has none. */
  cut: boolean
  /** Its execute bit, which the target gives a file it makes. */
  exec: boolean
}

/**
 * A file as it goes: .claude.json and settings.json their shared part (without the groups not
 * ticked: then its hash is of what went, so it is offered again), history.jsonl and the
 * transcripts with their paths moved, any text with its secrets cut as its kind reads (written
 * back as it was written: its BOM, UTF-16, bytes not UTF-8 one for one). Null when it is gone
 * since the scan, for a file not text with a secret in it (nothing can be cut from it), and for a
 * secret file, a file of one machine only or a path outside the profile, whoever asks for it.
 */
export function prepare(p: SideProfile, rel: string, ctx: PackCtx): Prepared | null {
  if (!writable(rel)) return null
  const abs = fileOf(p, rel)
  let data: Buffer
  let exec = false
  try {
    data = readFileSync(abs)
    exec = process.platform !== 'win32' && (statSync(abs).mode & 0o111) !== 0
  } catch {
    return null
  }
  const from = ctx.to.from
  const to = ctx.to.platform
  let hash = hashOf(rel, data)
  if (rel === '.claude.json' || rel === 'settings.json') {
    const json = parsed(noBom(data.toString('utf8')))
    const here = rel === '.claude.json' ? shareClaudeJson(json, null).value : shareSettings(json, null).value
    const kept = withhold(rel, here, ctx.allow)
    if (kept.withheld.length) hash = sha(JSON.stringify(kept.value))
    const goes =
      rel === '.claude.json'
        ? shareClaudeJson(json, ctx.to, path => moved(path, ctx.moves, from, to)).value
        : shareSettings(json, ctx.to).value
    const cut = cutSecretsInFile(rel, JSON.stringify(withhold(rel, goes, ctx.allow).value))
    return { body: Buffer.from(cut.text, 'utf8'), hash, found: cut.found, cut: false, exec: false }
  }
  const d = decodeText(data)
  if (!d)
    return Object.keys(cutSecrets(data.toString('latin1')).found).length
      ? null
      : { body: data, hash, found: {}, cut: false, exec }
  let text = d.text
  if (d.enc !== 'latin1') {
    if (rel === 'history.jsonl') text = rewriteHistory(text, ctx.moves, from, to).text
    else if (TRANSCRIPT.test(rel)) text = rewriteCwd(text, ctx.moves, from, to).text
  }
  const c = d.enc === 'latin1' ? cutSecrets(text) : cutSecretsInFile(rel, text)
  const found = Object.keys(c.found).length > 0
  // history.jsonl is merged line by line: it goes as plain UTF-8, its BOM the target's own
  const body = c.text === d.text ? data : MERGED.has(rel) ? Buffer.from(c.text, 'utf8') : encodeText(c.text, d)
  return { body, hash, found: c.found, cut: found && !MERGED.has(rel), exec }
}

// ---------------------------------------------------------------------------------------------
// The target: writes, merges and deletions, each file's new hash recorded as it goes

/** A path in a profile that may be written there: inside it, no `..`, no secret file, nothing of one machine. */
export const writable = (rel: string): boolean =>
  rel !== '' &&
  !rel.startsWith('/') &&
  !rel.includes('\\') &&
  !rel.includes('\0') &&
  !/^[a-zA-Z]:/.test(rel) &&
  !rel.split('/').some(part => part === '' || part === '.' || part === '..') &&
  !secretFile(rel) &&
  !oneMachine(rel)

/**
 * A file written whole beside its place, `mode` (only the board's user reads it, unless the file
 * there had its own), then moved in; when `still` says no (the file changed meanwhile), not moved.
 */
function writeWhole(abs: string, data: Buffer | string, mode: number, still: () => boolean = () => true): boolean {
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
  const part = `${abs}.agent-board-sync`
  writeFileSync(part, data, { mode })
  if (process.platform !== 'win32') chmodSync(part, mode)
  if (!still()) {
    rmSync(part, { force: true })
    return false
  }
  renameSync(part, abs)
  return true
}

const statOf = (abs: string): Stats | null => {
  try {
    return statSync(abs)
  } catch {
    return null
  }
}

/** A file's bytes; null when it is not there; 'unreadable' when it is there but cannot be read (a folder, no right). */
function bytesOf(abs: string): Buffer | null | 'unreadable' {
  try {
    return readFileSync(abs)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
}

/** How a file is written: merged by key, or whole with the target's hash at Look (`expect`, null: none there), cut, its execute bit. */
export interface WriteOpts {
  merge: boolean
  expect?: string | null
  cut?: boolean
  exec?: boolean
}

export interface Target {
  /** A file written (merged by key, for those merged), its new hash recorded; or why it was left as it was. */
  write(profile: string, rel: string, body: Buffer, opts: WriteOpts): SkipWhy | null
  /** A file deleted (ticked) when it is as it was at Look (`expect`), its hash forgotten; or why it was not. */
  remove(profile: string, rel: string, expect: string | null): SkipWhy | null
  /** A file the same on both sides: its hash recorded. */
  same(profile: string, rel: string, hash: string): void
  /** Gone on both sides: its hash forgotten. */
  forget(profile: string, rel: string): void
  /** The hashes recorded (again: the same); the profiles it made, what it left as it was. */
  finish(): { created: string[]; skipped: Skipped[] }
}

/**
 * This side as the target of a sync with `peer`: the plan's profiles, those it lacks made (0700);
 * the groups the owner ticked (`allow`), whatever the source sent.
 */
export function openTarget(o: {
  peer: string
  home: string
  platform: Platform
  profiles: readonly ProfilePlan[]
  allow: Ticks
}): Target {
  const here = new Map(sideProfiles(o.home).map(p => [p.name, p]))
  const created: string[] = []
  const skipped: Skipped[] = []
  const profileOf = (name: string): SideProfile => {
    const p = here.get(name)
    if (p) return p
    const plan = o.profiles.find(x => x.name === name)
    if (!plan || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`no profile ${name} in this sync`)
    const dir = profileDir(o.home, name, o.platform)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const made = { name, dir, claudeJson: claudeJsonOf(dir, name, o.home) }
    here.set(name, made)
    created.push(name)
    return made
  }
  let pending: { profile: string; rel: string; hash: string | null }[] = []
  let flushed = Date.now()
  const note = (profile: string, rel: string, hash: string | null): void => {
    pending.push({ profile, rel, hash })
    if (pending.length >= 200 || Date.now() - flushed > 5000) flush()
  }
  const flush = (): void => {
    recordSynced(o.peer, pending)
    pending = []
    flushed = Date.now()
  }
  const skip = (profile: string, rel: string, why: SkipWhy): SkipWhy => {
    skipped.push({ profile, rel, why })
    return why
  }
  /** Session history, a hook's or the status line's script: only when its group was ticked. */
  const ticked = (rel: string): boolean => {
    const g = fileGroup(rel)
    return (!historyFile(rel) || o.allow.history) && (g === null || o.allow[g])
  }
  /** The mode a file is written with: the one there had, else 0600 (0700 with the source's execute bit). */
  const modeOf = (st: Stats | null, exec: boolean): number => (st ? st.mode & 0o777 : exec ? 0o700 : 0o600)

  /**
   * A file merged by key into the target's own, read right before: its env never given a name
   * that is each side's own; a copy of it kept before its first merge; written beside it, then
   * read again, and merged again if a Claude session wrote it meanwhile. The merged text, or
   * 'unreadable' when the target's is not a JSON object (nor empty), or cannot be read.
   */
  function mergeInto(abs: string, rel: string, body: Buffer): string | 'unreadable' {
    const shared = body.toString('utf8')
    let s: Record<string, unknown> = {}
    if (rel !== 'history.jsonl') {
      const v = parsed(shared)
      if (!isRecord(v)) throw new Error(`${rel}: not JSON`)
      s = withhold(rel, v, o.allow).value
      if (rel === 'settings.json' && isRecord(s.env))
        s = { ...s, env: Object.fromEntries(Object.entries(s.env).filter(([name]) => !ownEnvName(name))) }
    }
    for (let round = 0; ; round++) {
      const before = bytesOf(abs)
      if (before === 'unreadable') return 'unreadable'
      const own = before ? decodeText(before) : { text: '', enc: 'utf8' as const, bom: false }
      if (own?.enc !== 'utf8') return 'unreadable'
      let data: string
      if (rel === 'history.jsonl') data = mergeHistory(own.text, shared)
      else {
        const mine = own.text.trim() === '' ? {} : parsed(own.text)
        if (!isRecord(mine)) return 'unreadable'
        data = `${JSON.stringify(rel === '.claude.json' ? mergeClaudeJson(mine, s) : mergeSettings(mine, s), null, 2)}\n`
      }
      const bak = `${abs}.bak-profile-sync`
      if (before && before.length > 0 && !existsSync(bak)) writeFileSync(bak, before, { mode: 0o600 })
      const moved = writeWhole(abs, own.bom ? `﻿${data}` : data, modeOf(statOf(abs), false), () => {
        if (round >= 2) return true
        const now = bytesOf(abs)
        return now === before || (Buffer.isBuffer(now) && Buffer.isBuffer(before) && now.equals(before))
      })
      if (moved) return data
    }
  }

  for (const p of o.profiles) if (p.create) profileOf(p.name)
  return {
    // a file merged by key is merged whatever comes with it: never replaced whole (its own secrets)
    write(profile, rel, body, opts) {
      if (!writable(rel)) throw new Error(`refused: ${rel}`)
      if (!ticked(rel)) return skip(profile, rel, 'group')
      const abs = fileOf(profileOf(profile), rel)
      if (MERGED.has(rel)) {
        const data = mergeInto(abs, rel, body)
        if (data === 'unreadable') return skip(profile, rel, data)
        note(profile, rel, hashOf(rel, data))
        return null
      }
      const st = statOf(abs)
      if (opts.cut === true && st) return skip(profile, rel, 'cut')
      // as at Look, or left as it is (a name in another case is the same file where case is not told apart)
      const now = st ? bytesOf(abs) : null
      const hash = now === null ? null : now === 'unreadable' ? '' : sha(now)
      if (hash !== (opts.expect ?? null)) return skip(profile, rel, 'changed')
      writeWhole(abs, body, modeOf(st, opts.exec === true))
      note(profile, rel, sha(body))
      return null
    },
    remove(profile, rel, expect) {
      if (!writable(rel) || MERGED.has(rel)) throw new Error(`refused: ${rel}`)
      if (!ticked(rel)) return skip(profile, rel, 'group')
      const abs = fileOf(profileOf(profile), rel)
      const now = bytesOf(abs)
      if (now !== null) {
        if (now === 'unreadable' || sha(now) !== expect) return skip(profile, rel, 'changed')
        rmSync(abs, { force: true })
      }
      note(profile, rel, null)
      return null
    },
    same(profile, rel, hash) {
      note(profile, rel, hash)
    },
    forget(profile, rel) {
      note(profile, rel, null)
    },
    finish() {
      flush()
      return { created: [...created], skipped: [...skipped] }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The frames: a header (4 bytes of its length, then JSON with the body's `size`), then the body

export interface Frame {
  head: Record<string, unknown>
  body: Buffer
}

export function frame(head: Record<string, unknown>, body: Uint8Array | null = null): Buffer {
  const h = Buffer.from(JSON.stringify({ ...head, size: body?.length ?? 0 }), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(h.length)
  return body?.length ? Buffer.concat([len, h, body]) : Buffer.concat([len, h])
}

/** Frames from a stream of bytes in any pieces (a body's pieces joined once, when all are there). */
export class FrameReader {
  private parts: Buffer[] = []
  private have = 0
  private head: Record<string, unknown> | null = null
  private take(n: number): Buffer {
    const all = this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts, this.have)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.parts = rest.length ? [rest] : []
    this.have = rest.length
    return out
  }
  push(chunk: Buffer): Frame[] {
    this.parts.push(chunk)
    this.have += chunk.length
    const out: Frame[] = []
    for (;;) {
      if (this.head === null) {
        if (this.have < 4) break
        const first = this.parts[0] as Buffer
        const len = (first.length >= 4 ? first : Buffer.concat(this.parts, this.have)).readUInt32BE(0)
        if (this.have < 4 + len) break
        const h = this.take(4 + len)
        const head = JSON.parse(h.subarray(4).toString('utf8'))
        if (!isRecord(head)) throw new Error('a frame without its header')
        this.head = head
      }
      const size = Number(this.head.size) || 0
      if (this.have < size) break
      out.push({ head: this.head, body: size ? Buffer.from(this.take(size)) : Buffer.alloc(0) })
      this.head = null
    }
    return out
  }
}

/** The frames of a stream (gunzipped already), one at a time. */
export async function* framesOf(input: AsyncIterable<Buffer | string>): AsyncGenerator<Frame> {
  const reader = new FrameReader()
  for await (const chunk of input)
    for (const f of reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) yield f
}

/** Frames sent gzipped into a stream, each waiting while the stream is full. */
export interface FrameSink {
  send(head: Record<string, unknown>, body?: Uint8Array | null): Promise<void>
  /** The last frame sent and the stream ended. */
  end(): Promise<void>
}

/** `stop`: settles when the other end is gone, so a full stream is not waited on for ever. */
export function frameSink(out: Writable, stop: Promise<unknown> | null = null): FrameSink {
  const gz = createGzip({ level: 6 })
  gz.pipe(out)
  let gone = false
  void stop?.then(() => {
    gone = true
  })
  const drained = (): Promise<unknown> =>
    Promise.race([new Promise<void>(resolve => gz.once('drain', () => resolve())), ...(stop ? [stop] : [])])
  return {
    async send(head, body = null) {
      if (gone) throw new Error('the other end is gone')
      if (!gz.write(frame(head, body))) await drained()
      if (gone) throw new Error('the other end is gone')
    },
    // once gzip's last bytes are handed to the stream (pipe then ends it): a process's stdout may
    // never say it finished, and its bytes are written before the process exits anyway
    end: async () => {
      await Promise.race([
        new Promise<void>(resolve => {
          gz.once('end', () => resolve())
          gz.once('error', () => resolve())
          gz.end()
        }),
        ...(stop ? [stop] : []),
      ])
    },
  }
}
