// The bundle on a node (#506, docs/design/nodes 6.2, 7.2, 9.3): what the node has of each profile's
// bundle, the blobs its master sends, and the commit that applies a manifest. The routes are the
// master door's own (server/routes/node.ts); without `node` in config.json there is no door, so
// nothing here runs and nothing under `<state>/node/` is written.
//
// A commit follows 9.3 in order: settings.json and config.json parse, or nothing is written (409
// settings-parse); every path stays in the profile folder, or nothing is written (409 path); every
// blob is here (409 missing-blob); every file about to be replaced or removed is copied into
// `bundle-backups/<profile>/<seq>/` (the last 10 kept); only what the last applied manifest owns is
// replaced or removed, so a file of the node's own that differs is kept and said; settings.json's
// keys and the profile's `mcpServers` likewise; files are written by a temporary name; then the
// board's install puts its hooks back with this node's Bun and folder; the board's slice goes into
// config.json through the config writer; and the manifest is recorded. The same manifest twice
// writes nothing.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  anythingAt,
  backUp,
  backupFolder,
  createBlobStore,
  editJson,
  fileSha,
  linkOnTheWay,
  MAX_BLOB_BYTES,
  pruneBackups,
  removeFile,
  rewriteKeeping,
  writeWhole,
} from '../../adapters/bundle-files.ts'
import { configFile, type EditResult, editNodeSlice, readConfigFile } from '../../adapters/config-file.ts'
import { hooksInstalled, installInto, readSettings } from '../../adapters/hook-settings.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { registerBoardMcp, registeredLine } from '../../adapters/mcp-register.ts'
import { ROOT } from '../../adapters/paths.ts'
import {
  appliedMcp,
  appliedSettings,
  appliedSlice,
  type BundleManifest,
  bundlePath,
  canonical,
  manifestOf,
  nodeMode,
  owned,
  recorded,
  toRemove,
  withProfileDirFilled,
} from '../../core/bundle.ts'
import { type GitIdentity, identityOf } from '../../core/git-access.ts'
import { boardMcpOff } from '../../core/mcp-register.ts'
import { claudeStateFile } from '../../core/move.ts'
import type { Profile } from '../../core/profiles.ts'
import { boardFiles } from '../../core/setup.ts'
import { wakeSwitch } from '../../core/wake/config.ts'

/** What the node last applied of a profile's bundle: the master's version as sent, and the manifest. */
export interface BundleRecord {
  seq: number
  hash: string
  /** What the bundle owns here: the manifest without the files kept as the node's own (core/bundle.ts recorded). */
  manifest: BundleManifest
  /**
   * Every file of the manifest as committed, kept ones too, by path: what the node has been sent.
   * The master sends only blobs it does not find here, so a file kept as the node's own does not
   * travel again with each sync.
   */
  sent: Record<string, string>
  at: number
}

/** A route's answer: its status and JSON body. */
export interface Answer {
  status: number
  body: Record<string, unknown>
}

export interface NodeBundleDeps {
  /** `<state>/node`. */
  dir: string
  /** This board's shown profiles: a profile id in a path is one of these. */
  profiles(): readonly Profile[]
  home?: string
  platform?: string
  /** config.json as it is: its object (null when there is none), or the file that does not parse. */
  readConfig(): { ok: true; raw: Record<string, unknown> | null } | { ok: false; file: string }
  /** config.json changed under its lock by the config writer (adapters/config-file.ts editNodeSlice). */
  writeSlice(change: (raw: Record<string, unknown>) => Record<string, unknown>): EditResult
  /** The board's install into a profile folder (adapters/hook-settings.ts installInto, this node's paths). */
  install(dir: string): { ok: boolean; error: string }
  /** The board's hooks of this copy are in the folder's settings.json already. */
  installed(dir: string): boolean
  /**
   * The owner's git identity a commit carries (#609, services/node/git-access.ts): set as this node's
   * global one unless its owner set another. `master`: the caller's id in masters.json.
   */
  identity?(given: GitIdentity, master: string | undefined): Promise<string>
  now?: () => number
  log(text: string): void
}

export interface NodeBundle {
  /** A profile's applied version, for the status; null before the first commit. */
  version(profile: string): { seq: number; hash: string } | null
  /** GET /api/node/bundle/<profile>: what the node has. */
  have(profile: string): Answer
  /** PUT /api/node/bundle/<profile>/blob/<sha256>. */
  putBlob(profile: string, sha: string, bytes: Uint8Array): Answer
  /** POST /api/node/bundle/<profile>/commit, one at a time; `master`: the caller's id in masters.json. */
  commit(profile: string, body: unknown, master?: string): Promise<Answer>
}

/** A profile id that may name a file: letters, digits, `.`, `_` and `-`, not starting with a dot. */
const PROFILE_ID = /^[A-Za-z0-9_][\w.-]{0,63}$/
const HASH = /^[0-9a-f]{64}$/
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

function recordOf(raw: unknown): BundleRecord | null {
  if (!isRecord(raw) || !Number.isInteger(raw.seq) || typeof raw.hash !== 'string') return null
  const manifest = manifestOf(raw.manifest)
  if (!manifest) return null
  const sent: Record<string, string> = {}
  if (isRecord(raw.sent)) {
    for (const [path, sha] of Object.entries(raw.sent)) if (typeof sha === 'string' && HASH.test(sha)) sent[path] = sha
  } else for (const f of manifest.files) sent[f.path] = f.sha256
  return { seq: raw.seq as number, hash: raw.hash, manifest, sent, at: typeof raw.at === 'number' ? raw.at : 0 }
}

/** A JSON object file: its value (undefined when there is none), or not one. */
function readObject(file: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  let text: string
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return existsSync(file) ? { ok: false } : { ok: true, value: undefined }
  }
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? { ok: true, value } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export function createNodeBundle(deps: NodeBundleDeps): NodeBundle {
  const home = deps.home ?? homedir()
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const blobs = createBlobStore(join(deps.dir, 'blobs'))
  const recordFile = (profile: string): string => join(deps.dir, 'bundle', `${profile}.json`)
  let queue: Promise<unknown> = Promise.resolve()

  const profileOf = (id: string): Profile | null =>
    PROFILE_ID.test(id) ? (deps.profiles().find(p => p.id === id && !p.hidden) ?? null) : null

  function record(profile: string): BundleRecord | null {
    const read = readObject(recordFile(profile))
    return read.ok ? recordOf(read.value) : null
  }

  /** The blobs every recorded manifest names: the rest may go. */
  function referenced(): Set<string> {
    const keep = new Set<string>()
    for (const p of deps.profiles()) {
      if (!PROFILE_ID.test(p.id)) continue
      for (const sha of Object.values(record(p.id)?.sent ?? {})) keep.add(sha)
    }
    return keep
  }

  async function apply(profile: Profile, body: unknown): Promise<Answer> {
    const b = isRecord(body) ? body : {}
    const seq = b.seq
    const hash = b.hash
    const next = manifestOf(b.manifest)
    if (!Number.isInteger(seq) || (seq as number) < 1 || typeof hash !== 'string' || !HASH.test(hash) || !next)
      return { status: 400, body: { error: 'bundle' } }
    const dir = profile.dir
    // 1. settings.json and config.json parse, or nothing is written.
    const settings = readSettings(dir)
    if (settings.error || (settings.text !== null && !isRecord(settings.settings)))
      return { status: 409, body: { error: 'settings-parse', file: settings.file } }
    const config = deps.readConfig()
    if (!config.ok) return { status: 409, body: { error: 'settings-parse', file: config.file } }
    // Every path stays in the profile folder: one that would leave it refuses the whole manifest.
    for (const f of next.files)
      if (bundlePath(f.path) === null || linkOnTheWay(dir, f.path))
        return { status: 409, body: { error: 'path', path: f.path.slice(0, 200) } }
    // 2. Every blob is here.
    const missing = [...new Set(next.files.map(f => f.sha256))].filter(sha => !blobs.has(sha))
    if (missing.length) return { status: 409, body: { error: 'missing-blob', missing } }

    const had = record(profile.id)
    const previous = had?.manifest ?? null
    const filledPrev = previous && withProfileDirFilled(previous, dir)
    const filledNext = withProfileDirFilled(next, dir)
    const gone = toRemove(filledPrev, filledNext)
    // The profile's .claude.json, only when the bundle has or had servers: it is Claude's own state.
    const claudeFile = claudeStateFile(dir, home, platform)
    const touchMcp = Object.keys(next.mcp).length > 0 || gone.mcp.length > 0
    const claude = touchMcp ? readObject(claudeFile) : null
    if (claude && !claude.ok) return { status: 409, body: { error: 'settings-parse', file: claudeFile } }
    // The owner's answers to notices the bundle's settings turn on (#602): the keys that file does
    // not have yet. One it has stays as it is, and no other key of it is touched.
    const acks = next.acks ?? []
    // A file that does not parse leaves them out, said in the log: they are no reason to refuse the rest.
    const ackState = acks.length ? (claude ?? readObject(claudeFile)) : null
    if (ackState && !ackState.ok)
      deps.log(`node bundle ${profile.id}: .claude.json does not parse: the acknowledgments are left out`)
    const lacking = (v: Record<string, unknown> | undefined): string[] => acks.filter(k => !v || !Object.hasOwn(v, k))
    const acksMissing = ackState?.ok ? lacking(ackState.value) : []

    // 4. What is the bundle's to change: a file that is there, not owned and different is the node's.
    const ownedBefore = new Set(owned(previous).files)
    const kept: { path: string; why: 'not-owned' | 'folder' }[] = []
    const writes: { path: string; sha: string; there: boolean }[] = []
    for (const f of next.files) {
      const target = join(dir, ...f.path.split('/'))
      const sha = fileSha(target)
      if (sha === f.sha256) continue
      if (sha === null && anythingAt(target)) kept.push({ path: f.path, why: 'folder' })
      else if (sha !== null && !ownedBefore.has(f.path)) kept.push({ path: f.path, why: 'not-owned' })
      else writes.push({ path: f.path, sha: f.sha256, there: sha !== null })
    }
    const removes = gone.files.filter(
      p => bundlePath(p) !== null && !linkOnTheWay(dir, p) && fileSha(join(dir, ...p.split('/'))) !== null,
    )
    const newSettings = appliedSettings(settings.settings ?? undefined, filledPrev, filledNext)
    const settingsChanged = canonical(newSettings) !== canonical(settings.settings ?? {})
    const claudeValue = claude?.ok ? claude.value : undefined
    const newServers = touchMcp ? appliedMcp(claudeValue?.mcpServers, filledPrev, filledNext) : {}
    const mcpChanged = touchMcp && canonical(newServers) !== canonical(claudeValue?.mcpServers ?? {})
    const sliceChanged =
      canonical(appliedSlice(config.raw ?? {}, previous?.board ?? null, next.board)) !== canonical(config.raw ?? {})
    const mine = recorded(
      previous,
      next,
      kept.map(k => k.path),
    )
    const sent = Object.fromEntries(next.files.map(f => [f.path, f.sha256]))
    const sameRecord =
      had !== null &&
      had.seq === seq &&
      had.hash === hash &&
      canonical(had.manifest) === canonical(mine) &&
      canonical(had.sent) === canonical(sent)
    const hooksIn = deps.installed(dir)
    if (
      !writes.length &&
      !removes.length &&
      !settingsChanged &&
      !mcpChanged &&
      !acksMissing.length &&
      !sliceChanged &&
      sameRecord &&
      hooksIn
    )
      return { status: 200, body: { ok: true, applied: [], removed: [], kept, backup: null } }

    // 3. A copy of every file about to be replaced or removed, one folder per commit.
    const backups = join(deps.dir, 'bundle-backups', profile.id)
    const folder = backupFolder(backups, seq as number)
    let backedUp = false
    const copy = (name: string, from: string): void => {
      backUp(folder, name, from)
      backedUp = true
    }
    for (const w of writes) if (w.there) copy(w.path, join(dir, ...w.path.split('/')))
    for (const p of removes) copy(p, join(dir, ...p.split('/')))
    if (settingsChanged && settings.text !== null) copy('settings.json', settings.file)
    if ((mcpChanged || acksMissing.length) && existsSync(claudeFile)) copy('.claude.json', claudeFile)
    if (backedUp) pruneBackups(backups)

    // 5. Each file by a temporary name and a rename.
    for (const w of writes) {
      const bytes = blobs.read(w.sha)
      writeWhole(join(dir, ...w.path.split('/')), bytes, nodeMode(w.path, bytes))
    }
    for (const p of removes) removeFile(dir, join(dir, ...p.split('/')))
    // What fails from here has written some of it: `partial`, and the next commit finishes it (a file
    // written already is the manifest's and becomes owned then).
    const partial = (status: number, error: string, detail: string): Answer => {
      deps.log(`node bundle ${profile.id}: ${error}: ${detail}`)
      return { status, body: { error, detail, partial: true } }
    }
    if (settingsChanged) rewriteKeeping(settings.file, asJson(newSettings))
    if (mcpChanged) {
      // Read again right before: Claude's running sessions write this file all the time.
      const fresh = readObject(claudeFile)
      if (!fresh.ok) return partial(409, 'settings-parse', claudeFile)
      const servers = appliedMcp(fresh.value?.mcpServers, filledPrev, filledNext)
      rewriteKeeping(claudeFile, asJson({ ...(fresh.value ?? {}), mcpServers: servers }))
    }
    // 6. The board's own hooks, with this node's Bun and folder.
    if (settingsChanged || !hooksIn) {
      const out = deps.install(dir)
      if (!out.ok) return partial(500, 'install', out.error)
    }
    // The board's slice, those keys only, under config.json's lock.
    if (sliceChanged) {
      const r = deps.writeSlice(raw => appliedSlice(raw, previous?.board ?? null, next.board))
      if (!r.ok) return partial(500, 'config', r.error)
    }
    if (acksMissing.length) {
      const done = editJson(claudeFile, value => {
        const missing = lacking(value)
        if (!missing.length) return null
        const out: Record<string, unknown> = { ...(value ?? {}) }
        for (const k of missing) out[k] = true
        return out
      })
      // Left as it is and said; the next bundle tries again.
      if (done === 'parse')
        deps.log(`node bundle ${profile.id}: .claude.json does not parse: the acknowledgments are left out`)
      if (done === 'busy')
        deps.log(
          `node bundle ${profile.id}: .claude.json was rewritten each time it was read: the acknowledgments are left out`,
        )
    }
    // 7. The manifest, as the master's version was sent: what the bundle owns here from now on.
    const rec: BundleRecord = { seq: seq as number, hash, manifest: mine, sent, at: now() }
    writeWhole(recordFile(profile.id), asJson(rec), 0o600)
    blobs.prune(referenced())
    const applied = [...writes.map(w => w.path), ...removes].sort()
    deps.log(`node bundle ${profile.id}: bundle ${seq} applied, ${applied.length} file(s), ${kept.length} kept`)
    return { status: 200, body: { ok: true, applied, removed: removes, kept, backup: backedUp ? folder : null } }
  }

  /**
   * After a commit that went through, the owner's git identity it carries (#609): the same manifest
   * twice finds it the same and runs nothing more than a read. What came of it joins the answer.
   */
  async function withIdentity(a: Answer, body: unknown, master: string | undefined): Promise<Answer> {
    if (a.status !== 200 || !deps.identity || !isRecord(body) || !isRecord(body.manifest)) return a
    const git = isRecord(body.manifest.git) ? identityOf(body.manifest.git.name, body.manifest.git.email) : null
    if (!git) return a
    return { ...a, body: { ...a.body, git: await deps.identity(git, master) } }
  }

  return {
    version(profile) {
      if (!PROFILE_ID.test(profile)) return null
      const r = record(profile)
      return r ? { seq: r.seq, hash: r.hash } : null
    },
    have(id) {
      const profile = profileOf(id)
      if (!profile) return { status: 404, body: { error: 'profile' } }
      const r = record(profile.id)
      return { status: 200, body: { seq: r?.seq ?? 0, hash: r?.hash ?? '', files: r?.sent ?? {} } }
    },
    putBlob(id, sha, bytes) {
      if (!profileOf(id)) return { status: 404, body: { error: 'profile' } }
      if (bytes.length > MAX_BLOB_BYTES) return { status: 413, body: { error: 'too-big' } }
      if (!HASH.test(sha) || sha256(bytes) !== sha) return { status: 400, body: { error: 'hash' } }
      blobs.put(sha, bytes)
      return { status: 200, body: { ok: true } }
    },
    commit(id, body, master) {
      const profile = profileOf(id)
      if (!profile) return Promise.resolve({ status: 404, body: { error: 'profile' } })
      const run = queue.then(() =>
        apply(profile, body)
          .then(a => withIdentity(a, body, master))
          .catch((err): Answer => {
            deps.log(`node bundle ${profile.id}: ${messageOf(err)}`)
            return { status: 500, body: { error: 'server' } }
          }),
      )
      queue = run
      return run
    },
  }
}

/**
 * The deps on a running node: its state folder, its shown profiles, config.json through the config
 * writer, the install as the Profiles panel runs it (this Bun, this copy's files, wake's hooks while
 * wake is on).
 */
export function nodeBundleDeps(o: {
  dir: string
  profiles: () => readonly Profile[]
  log: (text: string) => void
}): NodeBundleDeps {
  const files = boardFiles(ROOT)
  return {
    dir: o.dir,
    profiles: o.profiles,
    readConfig() {
      const raw = readConfigFile()
      if (!raw && existsSync(configFile())) return { ok: false, file: configFile() }
      return { ok: true, raw }
    },
    writeSlice: change => editNodeSlice(change),
    install(dir) {
      const paths = { bun: process.execPath, ...files, binDir: join(homedir(), '.local', 'bin') }
      const raw = readConfigFile()
      const wake = wakeSwitch({ exists: existsSync(configFile()), raw })
      const out = installInto(dir, paths, { wake })
      // The board's MCP server in the profile's user scope (#814), pointing at this node's own board.
      const id = o.profiles().find(p => p.dir === dir)?.id ?? dir
      if (out.ok && !boardMcpOff(raw))
        for (const r of registerBoardMcp({
          on: true,
          only: ['claude'],
          port: isRecord(raw) ? raw.port : undefined,
          bun: paths.bun,
          cli: paths.cli,
          profiles: [{ id, dir }],
        }))
          if (r.action === 'failed') o.log(`node bundle ${id}: ${registeredLine(r)}`)
      return out
    },
    installed: dir => hooksInstalled(dir, files),
    log: o.log,
  }
}
