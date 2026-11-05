// Writing a secret into its sink (#273, core/secrets.ts): a file from a template, a Bitwarden item,
// a user environment variable, an HTTP call. The values come in memory and go nowhere else: a
// file is written in place, with the user's rights only before anything is in it; Bitwarden and
// PowerShell get them on stdin, never as an argument, and Bitwarden's session in their env only;
// an HTTP call goes to the sink's own origin, follows no redirect, and its answer is reduced to a
// status. A program's failure is said by its step and exit code, never by what it printed (that
// can echo its input in any escaping); a runtime's error by its name and code.
// BOARD_BW_BIN_PATH and BOARD_POWERSHELL_BIN_PATH name other binaries (tests).
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join, relative, sep, win32 } from 'node:path'
import {
  type BitwardenSink,
  type EnvSink,
  type FileSink,
  fillDeep,
  fillText,
  type HttpSink,
  placeholders,
  type SecretField,
  type Sink,
  safeName,
  scrub,
} from '../core/secrets.ts'
import { isRecord } from './json-store.ts'
import { type RunResult, run, runTree } from './process.ts'

export interface WriteInput {
  sink: Sink
  params: Record<string, string>
  fields: readonly SecretField[]
  /** The typed values, by field. */
  values: Record<string, string>
  /** Bitwarden's session, from the owner's submit. */
  bwSession?: string
}

export type WriteResult =
  | { ok: true; target: string; status?: number }
  | { ok: false; error: string; vars?: Record<string, string>; status?: number }

const refuse = (error: string, vars?: Record<string, string>): WriteResult => ({
  ok: false,
  error,
  ...(vars && { vars }),
})
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const system32 = (file: string): string => join(process.env.SystemRoot || 'C:\\Windows', 'System32', file)
const RUN_MS = 60_000

/** Writes the values into the sink. Whatever goes wrong comes back as a reason, never as a throw with a value in it. */
export async function writeSink(input: WriteInput): Promise<WriteResult> {
  const secrets = [...Object.values(input.values), input.bwSession ?? '']
  try {
    switch (input.sink.kind) {
      case 'file':
        return await writeFile(input.sink, input)
      case 'bitwarden':
        return await writeBitwarden(input.sink, input)
      case 'env':
        return await writeEnv(input.sink, input)
      case 'http':
        return await writeHttp(input.sink, input)
    }
  } catch (err) {
    // a runtime's message can quote what it was given: its name and code only
    const e = err as { name?: unknown; code?: unknown }
    const what = [e?.name, e?.code].filter(x => typeof x === 'string' && x).join(' ')
    return refuse('secret.err.failed', { detail: scrub(what || 'error', secrets) })
  }
}

const onceFields = (fields: readonly SecretField[]): string[] => fields.filter(f => f.once).map(f => f.name)

/** A dotenv value: as it is when it needs no quotes, else in quotes that keep it literal; null when none can. */
export function envValue(v: string): string | null {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(v)) return v
  if (!v.includes("'")) return `'${v}'`
  if (!/["\\$`]/.test(v)) return `"${v}"`
  return null
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

/** The file's text with the template's variables set: each in place of its first line, its other lines gone, new ones at the end. */
function envContent(existing: string | null, set: Record<string, string>): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing === null ? [] : existing.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const done = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const key = ENV_LINE.exec(line)?.[1]
    if (key === undefined || !Object.hasOwn(set, key)) out.push(line)
    else if (!done.has(key)) {
      out.push(`${key}=${set[key]}`)
      done.add(key)
    }
  }
  for (const [key, value] of Object.entries(set)) if (!done.has(key)) out.push(`${key}=${value}`)
  return out.join(eol) + eol
}

/** What the file holds once the values are in, from what it holds now (null: no file), or why not. */
function contentOf(sink: FileSink, input: WriteInput, path: string, existing: string | null): string | WriteResult {
  const all = { ...input.params, ...input.values }
  const once = onceFields(input.fields)
  switch (sink.format) {
    case 'json': {
      const filled = fillDeep(sink.template, all)
      if (!sink.at) {
        if (once.length && existing !== null) return refuse('secret.err.onceThere', { what: path })
        return `${JSON.stringify(filled, null, 2)}\n`
      }
      let data: unknown = {}
      if (existing?.trim()) {
        try {
          data = JSON.parse(existing.replace(/^\uFEFF/, ''))
        } catch {
          return refuse('secret.err.notJson', { path })
        }
      }
      if (!isObject(data)) return refuse('secret.err.notJson', { path })
      // the file's own keys only, read and made as data: never an object's prototype or maker
      const keys = sink.at.map(k => fillText(k, input.params))
      const last = keys.pop() as string
      const put = (o: Record<string, unknown>, k: string, v: unknown): void => {
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
      }
      let node: Record<string, unknown> = data
      for (const k of keys) {
        const next = Object.hasOwn(node, k) ? node[k] : undefined
        if (next === undefined) put(node, k, {})
        else if (!isObject(next)) return refuse('secret.err.notJson', { path })
        node = node[k] as Record<string, unknown>
      }
      if (once.length && Object.hasOwn(node, last))
        return refuse('secret.err.onceThere', { what: [...keys, last].join(' › ') })
      put(node, last, filled)
      return `${JSON.stringify(data, null, 2)}\n`
    }
    case 'env': {
      const set: Record<string, string> = {}
      const template = sink.template as Record<string, string>
      const before =
        existing === null ? new Set<string>() : new Set(existing.split(/\r?\n/).map(l => ENV_LINE.exec(l)?.[1]))
      for (const [key, value] of Object.entries(template)) {
        if (placeholders(value).some(n => once.includes(n)) && before.has(key))
          return refuse('secret.err.onceThere', { what: key })
        const quoted = envValue(fillText(value, all))
        if (quoted === null) return refuse('secret.err.valueQuotes', { name: key })
        set[key] = quoted
      }
      return envContent(existing, set)
    }
    default:
      if (once.length && existing !== null) return refuse('secret.err.onceThere', { what: path })
      return fillText(sink.template as string, all)
  }
}

/** One write to a path at a time in this process: two requests to one JSON file never lose each other's. */
const writing = new Map<string, Promise<unknown>>()
function oneAtATime<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  const run = (writing.get(key) ?? Promise.resolve()).then(fn, fn)
  const done = run.catch(() => {})
  writing.set(key, done)
  void done.then(() => {
    if (writing.get(key) === done) writing.delete(key)
  })
  return run
}

async function writeFile(sink: FileSink, input: WriteInput): Promise<WriteResult> {
  const name = fillText(sink.name, input.params)
  const path = join(sink.folder, name)
  const rel = relative(sink.folder, path)
  if (!safeName(name) || rel !== name || rel.includes(sep)) return refuse('secret.err.paramBad', { name })
  return oneAtATime(path, async () => {
    let folder: ReturnType<typeof statSync> | null = null
    try {
      folder = statSync(sink.folder)
    } catch {}
    if (!folder?.isDirectory()) return refuse('secret.err.noFolder', { folder: sink.folder })
    let there: ReturnType<typeof lstatSync> | null = null
    try {
      there = lstatSync(path)
    } catch {}
    // a link could point anywhere, and a folder is no file to write
    if (there && (there.isSymbolicLink() || !there.isFile())) return refuse('secret.err.notFile', { path })
    // what would be refused is refused before the file's rights change
    const first = contentOf(sink, input, path, there ? readFileSync(path, 'utf8') : null)
    if (typeof first !== 'string') return first
    // The rights first, while the file is empty or still holds what it held: the value goes into a
    // file only the user can read. Windows: the user alone, and read back so.
    const made = !there
    if (made) closeSync(openSync(path, 'wx', 0o600))
    const rights = process.platform === 'win32' ? await userOnly(path, !made) : chmodRights(path)
    if (!rights.ok) {
      if (made) rmSync(path, { force: true })
      return refuse('secret.err.rights', { path })
    }
    // read again: setting the rights took a moment, and the file is what it is now
    const content = made ? first : contentOf(sink, input, path, readFileSync(path, 'utf8'))
    if (typeof content !== 'string') return content
    const fd = openSync(path, 'w')
    try {
      writeSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return { ok: true, target: sink.at ? `${path} › ${sink.at.map(k => fillText(k, input.params)).join(' › ')}` : path }
  })
}

/**
 * Windows: the file's rights the user's alone. An existing file's own entries go first (`/reset`:
 * `/inheritance:r` drops only inherited ones, so an Everyone:(R) put on it by hand would stay),
 * then inheritance off and full control to the user by SID, then the rights read back: one entry,
 * the user's, or no write.
 */
async function userOnly(path: string, existed: boolean): Promise<{ ok: boolean }> {
  const who = await run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  const m = /^"((?:[^"]|"")*)","(S-1-[\d-]+)"/m.exec(who.stdout)
  if (who.code !== 0 || !m?.[1] || !m[2]) return { ok: false }
  const icacls = system32('icacls.exe')
  if (existed && (await run(icacls, [path, '/reset'])).code !== 0) return { ok: false }
  if ((await run(icacls, [path, '/inheritance:r', '/grant:r', `*${m[2]}:F`])).code !== 0) return { ok: false }
  const shown = await run(icacls, [path])
  const aces = shown.stdout
    .split(/\r?\n/)
    .map(line => (line.startsWith(path) ? line.slice(path.length) : line).trim())
    .filter(line => /:\(/.test(line))
  const name = m[1].replaceAll('""', '"').toLowerCase()
  const only = aces.length === 1 && (aces[0] ?? '').toLowerCase() === `${name}:(f)`
  return { ok: shown.code === 0 && only }
}

function chmodRights(path: string): { ok: boolean } {
  try {
    chmodSync(path, 0o600)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** The Bitwarden CLI: BOARD_BW_BIN_PATH as it is, else `bw` from PATH. */
export function bwBin(env: Record<string, string | undefined> = process.env): string | null {
  return env.BOARD_BW_BIN_PATH || Bun.which('bw')
}

/** Only words and ids go on bw's command line: through cmd.exe (npm's bw.cmd) nothing in them is read as a command. */
const SAFE_ARG = /^[A-Za-z0-9-]+$/

async function bw(bin: string, args: string[], session: string, input?: string): Promise<RunResult> {
  if (!args.every(a => SAFE_ARG.test(a))) throw new Error('bw: unexpected argument')
  const env = { ...process.env, BW_SESSION: session, BW_NOINTERACTION: 'true' }
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
  const [file, argv] = viaCmd ? [system32('cmd.exe'), ['/d', '/c', bin, ...args]] : [bin, args]
  const r = await runTree(file, argv, { env, timeout: RUN_MS, ...(input !== undefined && { input }) })
  // a program the timeout ended has failed, whatever its code says
  return r.killed ? { ...r, code: 'timeout', stderr: 'timed out' } : r
}

/** What bw printed as JSON, or null. */
function jsonOut(r: RunResult): unknown {
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/** How a program ended, in words that hold nothing it printed. */
const codeOf = (r: RunResult): string =>
  r.killed || r.code === 'timeout' ? 'timed out' : r.code === 'ENOENT' ? 'not found' : `exit ${String(r.code)}`

/** bw's own `encode`: the JSON as base64, which `create` and `edit` read from stdin. */
const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

async function writeBitwarden(sink: BitwardenSink, input: WriteInput): Promise<WriteResult> {
  const session = (input.bwSession ?? '').trim()
  if (!session) return refuse('secret.err.bwSession')
  const bin = bwBin()
  if (!bin) return refuse('secret.err.bwMissing')
  // what bw says on a failure can echo what it was given, in any escaping: the step and the code only
  const failed = (step: string, r: RunResult): WriteResult =>
    refuse('secret.err.bwFailed', { step, detail: r.code === 'ENOENT' ? 'bw not found' : codeOf(r) })
  const status = await bw(bin, ['status'], session)
  const st = jsonOut(status)
  if (!isRecord(st)) return failed('status', status)
  if (st.status !== 'unlocked') return refuse('secret.err.bwLocked')
  const sync = await bw(bin, ['sync'], session)
  if (sync.code !== 0) return failed('sync', sync)
  const listed = await bw(bin, ['list', 'folders'], session)
  const folders = jsonOut(listed)
  if (!Array.isArray(folders)) return failed('list folders', listed)
  let folderId = folders.find(f => isRecord(f) && f.name === sink.folder)?.id
  if (typeof folderId !== 'string') {
    const made = await bw(bin, ['create', 'folder'], session, encoded({ name: sink.folder }))
    const out = jsonOut(made)
    if (!isRecord(out) || typeof out.id !== 'string') return failed('create folder', made)
    folderId = out.id
  }
  if (!SAFE_ARG.test(folderId as string)) return refuse('secret.err.bwFailed', { step: 'folder', detail: 'id' })
  const name = fillText(sink.item, input.params)
  const found = await bw(bin, ['list', 'items', '--folderid', folderId as string], session)
  const items = jsonOut(found)
  if (!Array.isArray(items)) return failed('list items', found)
  const same = items.filter(i => isRecord(i) && i.name === name)
  if (same.length > 1) return refuse('secret.err.bwTwice', { item: name })
  const old = same[0] as Record<string, unknown> | undefined
  const item: Record<string, unknown> = old
    ? { ...old }
    : {
        type: 1,
        name,
        folderId,
        notes: null,
        favorite: false,
        reprompt: 0,
        login: { username: null, password: null, totp: null, uris: [] },
        fields: [],
        ...(sink.organization && { organizationId: sink.organization, collectionIds: [sink.collection] }),
      }
  const login: Record<string, unknown> = isRecord(item.login) ? { ...item.login } : {}
  const custom: Record<string, unknown>[] = Array.isArray(item.fields)
    ? item.fields.filter(isRecord).map(f => ({ ...f }))
    : []
  for (const f of input.fields) {
    const value = input.values[f.name] ?? ''
    // an empty value leaves that part as it is (no TOTP, say)
    if (!value) continue
    const part = f.name.toLowerCase()
    const had =
      part === 'notes'
        ? !!item.notes
        : part === 'uri'
          ? Array.isArray(login.uris) && login.uris.length > 0
          : ['username', 'password', 'totp'].includes(part)
            ? !!login[part]
            : custom.some(c => c.name === f.name && !!c.value)
    if (f.once && had) return refuse('secret.err.onceThere', { what: `${name} › ${f.name}` })
    if (part === 'notes') item.notes = value
    else if (part === 'uri') login.uris = [{ match: null, uri: value }]
    else if (['username', 'password', 'totp'].includes(part)) login[part] = value
    else {
      const at = custom.find(c => c.name === f.name)
      if (at) at.value = value
      else custom.push({ name: f.name, value, type: f.hidden ? 1 : 0 })
    }
  }
  item.login = login
  item.fields = custom
  const id = typeof old?.id === 'string' ? old.id : null
  if (id !== null && !SAFE_ARG.test(id)) return refuse('secret.err.bwFailed', { step: 'item', detail: 'id' })
  const wrote = await bw(bin, id ? ['edit', 'item', id] : ['create', 'item'], session, encoded(item))
  const out = jsonOut(wrote)
  if (!isRecord(out) || typeof out.id !== 'string') return failed(id ? 'edit item' : 'create item', wrote)
  return { ok: true, target: `Bitwarden: ${sink.folder} › ${name}` }
}

/** Windows PowerShell 5.1 by its full path; BOARD_POWERSHELL_BIN_PATH another (tests). */
export function powershellBin(env: Record<string, string | undefined> = process.env): string {
  return (
    env.BOARD_POWERSHELL_BIN_PATH ||
    win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  )
}

// The names and the values come on stdin as JSON, each value as base64 of its UTF-8 (the console's
// code page never touches it); the script itself holds none of them. A name that `check` lists and
// the user already has stops it before anything is set.
export const ENV_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  "$taken = @($in.check | Where-Object { $null -ne [Environment]::GetEnvironmentVariable($_, 'User') })",
  "if ($taken.Count) { 'taken:' + ($taken -join ','); exit 3 }",
  "foreach ($p in $in.set.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p.Value)), 'User') }",
  "'ok'",
].join('; ')

async function writeEnv(_sink: EnvSink, input: WriteInput): Promise<WriteResult> {
  if (process.platform !== 'win32' && !process.env.BOARD_POWERSHELL_BIN_PATH) return refuse('secret.err.envPlatform')
  const set: Record<string, string> = {}
  for (const f of input.fields) set[f.name] = Buffer.from(input.values[f.name] ?? '', 'utf8').toString('base64')
  const stdin = JSON.stringify({ check: onceFields(input.fields), set })
  const r = await runTree(
    powershellBin(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ENV_SCRIPT],
    {
      input: stdin,
      timeout: RUN_MS,
    },
  )
  const said = r.killed ? '' : r.stdout.trim()
  if (said.startsWith('taken:')) return refuse('secret.err.onceThere', { what: said.slice(6) })
  if (r.code !== 0 || said !== 'ok')
    return refuse('secret.err.envFailed', {
      detail: codeOf(r),
    })
  return { ok: true, target: input.fields.map(f => f.name).join(', ') }
}

const originOf = (url: string): string => /^[a-z]+:\/\/[^/?#]*/i.exec(url)?.[0] ?? ''

async function writeHttp(sink: HttpSink, input: WriteInput): Promise<WriteResult> {
  const all = { ...input.params, ...input.values }
  const url = fillText(sink.url, input.params, encodeURIComponent)
  const host = new URL(originOf(sink.url)).host
  // the parameters went into the path and the query, each encoded: the host is still the sink's
  if (new URL(url).origin !== new URL(originOf(sink.url)).origin) return refuse('secret.err.paramBad', { name: 'url' })
  const headers = new Headers()
  for (const [k, v] of Object.entries(sink.headers)) headers.set(k, fillText(v, all))
  if (sink.auth) {
    const pair = `${fillText(sink.auth.user, all)}:${fillText(sink.auth.password, all)}`
    headers.set('authorization', `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`)
  }
  let body: string | undefined
  if (typeof sink.body === 'string') {
    body = fillText(sink.body, all)
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
  } else if (sink.body !== null) {
    body = JSON.stringify(fillDeep(sink.body, all))
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: sink.method,
      headers,
      body: body ?? null,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return refuse('secret.err.httpFailed', { host })
  }
  // what the server answers is not read: it could echo the values
  await res.body?.cancel().catch(() => {})
  if (res.status >= 200 && res.status < 300) return { ok: true, target: `${sink.method} ${url}`, status: res.status }
  return { ok: false, error: 'secret.err.httpStatus', vars: { status: String(res.status), host }, status: res.status }
}
