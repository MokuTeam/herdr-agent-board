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
// outside the profile's folder.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
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
} from '../core/profile-sync/paths.ts'
import { type Manifest, type ProfileFacts, type ProfilePlan, profileDir } from '../core/profile-sync/plan.ts'
import {
  mergeClaudeJson,
  mergeHistory,
  mergeSettings,
  rewriteCwd,
  rewriteHistory,
} from '../core/profile-sync/rewrite.ts'
import {
  type CarryTo,
  cutSecrets,
  MERGED,
  oneMachine,
  secretFile,
  shareClaudeJson,
  shareSettings,
} from '../core/profile-sync/secrets.ts'
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

/** A folder's clone: its top folder, its remote (origin, else the first), whether it is a worktree; null when it is in none. */
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
  const remote = (remotes.find(m => m[1] === 'origin') ?? remotes[0])?.[2] ?? null
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

/** A file starts with no NUL: text, which the sync looks through (secrets, paths). */
const isText = (data: Buffer): boolean => !data.subarray(0, 8192).includes(0)

/**
 * What this side has (Manifest): its profiles' files and hashes, the last sync's hashes with
 * `peer`, its projects and (with `clones`, the server) the clones under its home. As the source
 * (`to`: the target's system and home), also what it would hold back: the secrets in the files
 * changed since the last sync, and what settings.json and .claude.json keep or cannot send.
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
    const last = synced[p.name] ?? {}
    const files: ProfileFacts['files'] = {}
    for (const [rel, f] of walked.files) {
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
      if (o.to && !MERGED.has(rel) && last[rel] !== hash) {
        try {
          const data = readFileSync(f.abs)
          if (isText(data)) {
            const kinds = Object.keys(cutSecrets(data.toString('utf8')).found)
            if (kinds.length) findings.push({ profile: p.name, rel, kinds })
          }
        } catch {}
      }
    }
    profiles.push({ name: p.name, dir: p.dir, files, synced: last, secretFiles: walked.secretFiles })
    let cj: unknown = null
    try {
      cj = parsed(readText(p.claudeJson))
    } catch {}
    if (o.to) {
      let settings: unknown = null
      try {
        settings = parsed(readText(join(p.dir, 'settings.json')))
      } catch {}
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

/** How the source sends: to whom (system, home), and the projects' paths moved. */
export interface PackCtx {
  to: CarryTo
  moves: readonly Move[]
}

const TRANSCRIPT = /^projects\/[^/]+\/.+\.jsonl$/

/** A file of a profile on this side by its path in the profile: .claude.json wherever it lies, the rest in the folder. */
export const fileOf = (p: SideProfile, rel: string): string =>
  rel === '.claude.json' ? p.claudeJson : join(p.dir, ...rel.split('/'))

/**
 * A file as it goes: .claude.json and settings.json their shared part, history.jsonl and the
 * transcripts with their paths moved, any text with its secrets cut; its hash here (as recorded
 * after the sync), and the secrets cut by kind. Null when it is gone since the scan.
 */
export function prepare(
  p: SideProfile,
  rel: string,
  ctx: PackCtx,
): { body: Buffer; hash: string; found: Record<string, number> } | null {
  let data: Buffer
  try {
    data = readFileSync(fileOf(p, rel))
  } catch {
    return null
  }
  const from = ctx.to.from
  const to = ctx.to.platform
  const hash = hashOf(rel, data)
  if (!isText(data)) return { body: data, hash, found: {} }
  let text = noBom(data.toString('utf8'))
  if (rel === '.claude.json')
    text = JSON.stringify(shareClaudeJson(parsed(text), ctx.to, path => moved(path, ctx.moves, from, to)).value)
  else if (rel === 'settings.json') text = JSON.stringify(shareSettings(parsed(text), ctx.to).value)
  else if (rel === 'history.jsonl') text = rewriteHistory(text, ctx.moves, from, to).text
  else if (TRANSCRIPT.test(rel)) text = rewriteCwd(text, ctx.moves, from, to).text
  const cut = cutSecrets(text)
  return { body: Buffer.from(cut.text, 'utf8'), hash, found: cut.found }
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

/** A file written whole beside its place, then moved in (only the board's user reads it). */
function writeWhole(abs: string, data: Buffer | string): void {
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
  const part = `${abs}.agent-board-sync`
  writeFileSync(part, data, { mode: 0o600 })
  renameSync(part, abs)
}

export interface Target {
  /** A file written (merged by key, for those merged); its new hash recorded. */
  write(profile: string, rel: string, body: Buffer, merge: boolean): void
  /** A file deleted (ticked), its hash forgotten. */
  remove(profile: string, rel: string): void
  /** A file the same on both sides: its hash recorded. */
  same(profile: string, rel: string, hash: string): void
  /** Gone on both sides: its hash forgotten. */
  forget(profile: string, rel: string): void
  /** The hashes recorded; the profiles it made. */
  finish(): { created: string[] }
}

/** This side as the target of a sync with `peer`: the plan's profiles, those it lacks made (0700). */
export function openTarget(o: {
  peer: string
  home: string
  platform: Platform
  profiles: readonly ProfilePlan[]
}): Target {
  const here = new Map(sideProfiles(o.home).map(p => [p.name, p]))
  const created: string[] = []
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
  for (const p of o.profiles) if (p.create) profileOf(p.name)
  return {
    write(profile, rel, body, merge) {
      if (!writable(rel)) throw new Error(`refused: ${rel}`)
      const p = profileOf(profile)
      const abs = fileOf(p, rel)
      let data: Buffer | string = body
      if (merge && MERGED.has(rel)) {
        let own = ''
        try {
          own = readText(abs)
        } catch {}
        const shared = body.toString('utf8')
        if (rel === 'history.jsonl') data = mergeHistory(own, shared)
        else {
          const s = parsed(shared)
          if (!isRecord(s)) throw new Error(`${rel}: not JSON`)
          const merged = rel === '.claude.json' ? mergeClaudeJson(parsed(own), s) : mergeSettings(parsed(own), s)
          data = `${JSON.stringify(merged, null, 2)}\n`
        }
      }
      writeWhole(abs, data)
      note(profile, rel, hashOf(rel, data))
    },
    remove(profile, rel) {
      if (!writable(rel) || MERGED.has(rel)) throw new Error(`refused: ${rel}`)
      rmSync(fileOf(profileOf(profile), rel), { force: true })
      note(profile, rel, null)
    },
    same(profile, rel, hash) {
      note(profile, rel, hash)
    },
    forget(profile, rel) {
      note(profile, rel, null)
    },
    finish() {
      flush()
      return { created }
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
