// Secrets through the board (#273): an agent asks for values it must never see, the owner types
// them into a form on the board, and the board writes them into a sink the owner defined. The
// rules here: config.json's `secrets.sinks` (strict, like `time`), what a request may ask, the
// templates and how a value fills them, where a sink writes as the form shows it, and a request's
// life on its card. The writing is adapters/secret-sinks.ts, the request's life
// services/secrets.ts.
//
// A value is never kept: not on the card, in the payload, the database or its journal, a log, an
// error text, a temp file. It lives in the memory of the request that writes it, until the sink is
// written. A request names a sink and fills only that sink's declared parameters, each checked by
// its rule; where a value goes is the owner's config, never the request's.
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { cleanText } from './time.ts'
import type { Translator } from './types.ts'

export type SinkKind = 'file' | 'bitwarden' | 'env' | 'http'
export type FileFormat = 'json' | 'env' | 'netrc' | 'text'

/** What a parameter may be: a safe file or item name, one line of text, or a regex the whole value matches. */
export type ParamRule = { kind: 'name' } | { kind: 'text' } | { kind: 'regex'; source: string }

interface SinkBase {
  id: string
  kind: SinkKind
  /** What the owner calls it, for the form. */
  title: string
  /** The parameters a request fills, by name. */
  params: Record<string, ParamRule>
  /** The fields a template asks for (file, http); null: the request names them (bitwarden, env). */
  fields: string[] | null
  /** The sink as config.json has it: what the form's fingerprint is made of. */
  raw: unknown
  /** What does not check out: a sink with any problem takes no request and writes nothing. */
  problems: SecretProblem[]
}

export interface FileSink extends SinkBase {
  kind: 'file'
  /** Absolute, `~` expanded. */
  folder: string
  /** The file's name in it, a template of parameters. */
  name: string
  format: FileFormat
  /** json: a JSON value with templates in its strings; env: an object of variables; netrc and text: a string. */
  template: unknown
  /** json: the keys the template goes under, the rest of the file kept; null: the template is the file. */
  at: string[] | null
}

export interface BitwardenSink extends SinkBase {
  kind: 'bitwarden'
  /** The vault's folder the item is in, made when missing. */
  folder: string
  /** The item's name, a template of parameters. */
  item: string
  organization: string | null
  collection: string | null
}

export interface EnvSink extends SinkBase {
  kind: 'env'
  /** The variables a request may set; null: any that matches `pattern`. */
  vars: string[] | null
  pattern: string | null
}

export interface HttpSink extends SinkBase {
  kind: 'http'
  method: string
  /** Its origin has no template: a request cannot point it at another host. */
  url: string
  headers: Record<string, string>
  /** Basic auth from templates; null: none. */
  auth: { user: string; password: string } | null
  /** A JSON value with templates in its strings, or a text template; null: no body. */
  body: unknown
}

export type Sink = FileSink | BitwardenSink | EnvSink | HttpSink

export type SecretProblemWhy =
  | 'type'
  | 'unknown'
  | 'required'
  | 'kind'
  | 'id'
  | 'path'
  | 'name'
  | 'format'
  | 'template'
  | 'regex'
  | 'param'
  | 'field'
  | 'origin'
  | 'scheme'
  | 'method'
  | 'header'
  | 'platform'
  | 'env'

/** A value of `secrets` that does not check out: where (secrets.sinks.x.path), and why. */
export interface SecretProblem {
  at: string
  why: SecretProblemWhy
  value?: string
}

export interface SecretsConfig {
  sinks: Map<string, Sink>
  /** Problems outside any one sink (the section's own keys). */
  problems: SecretProblem[]
}

export const problemsText = (ps: readonly SecretProblem[], tr: Translator): string =>
  ps.map(p => `${p.at}: ${tr(`secret.problem.${p.why}`, { value: p.value ?? '' })}`).join('; ')

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const shown = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)))

export const SINK_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** A field's or a parameter's name, as a template writes it: {{name}}. */
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
/** A user environment variable's name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,39})\s*\}\}/g
/** Bitwarden's ids: a GUID. */
const BW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const METHODS = ['POST', 'PUT', 'PATCH']
const FORMATS: readonly FileFormat[] = ['json', 'env', 'netrc', 'text']
// Names Windows keeps for devices, whatever the extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** The parameters and fields a template names, in order, each once. */
export function placeholders(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER)) if (m[1] && !into.includes(m[1])) into.push(m[1])
  } else if (Array.isArray(value)) for (const v of value) placeholders(v, into)
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) {
      placeholders(k, into)
      placeholders(v, into)
    }
  return into
}

/** A template's text with each {{name}} as `values` has it (through `encode`); a name it lacks stays as written. */
export function fillText(template: string, values: Record<string, string>, encode = (v: string) => v): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(values, name) ? encode(values[name] as string) : whole,
  )
}

/** A JSON template filled: every string in it (keys too) through fillText; numbers, booleans and null as they are. */
export function fillDeep(template: unknown, values: Record<string, string>): unknown {
  if (typeof template === 'string') return fillText(template, values)
  if (Array.isArray(template)) return template.map(v => fillDeep(v, values))
  if (isObject(template))
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [fillText(k, values), fillDeep(v, values)]))
  return template
}

/** A file or item name (a dotfile too): no folder in it, no way out of the sink's folder, nothing Windows refuses. */
export function safeName(name: string): boolean {
  return (
    /^[A-Za-z0-9._][A-Za-z0-9 ._-]{0,79}$/.test(name) &&
    !name.includes('..') &&
    !/[ .]$/.test(name) &&
    !RESERVED.test(name)
  )
}

/** One line of text: no control characters, 1 to 100 characters. */
const oneLine = (v: string): boolean =>
  v.length > 0 && v.length <= 100 && ![...v].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)

/** Whether a parameter's value passes its rule (and is one line, whatever the rule). */
export function paramOk(rule: ParamRule, value: string): boolean {
  if (!oneLine(value)) return false
  if (rule.kind === 'name') return safeName(value)
  if (rule.kind === 'text') return value.trim() === value
  try {
    return new RegExp(`^(?:${rule.source})$`).test(value)
  } catch {
    return false
  }
}

interface ParseOptions {
  /** The user's home, for `~`. */
  home: string
  platform?: string
}

const KEYS: Record<SinkKind, readonly string[]> = {
  file: ['kind', 'title', 'params', 'path', 'folder', 'name', 'format', 'template', 'at'],
  bitwarden: ['kind', 'title', 'params', 'folder', 'item', 'organization', 'collection'],
  env: ['kind', 'title', 'vars'],
  http: ['kind', 'title', 'params', 'method', 'url', 'headers', 'auth', 'body'],
}

function unknownKeys(
  o: Record<string, unknown>,
  known: readonly string[],
  at: string,
  problems: SecretProblem[],
): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) problems.push({ at: `${at}.${k}`, why: 'unknown' })
}

function textOf(
  o: Record<string, unknown>,
  key: string,
  at: string,
  problems: SecretProblem[],
  required = true,
): string {
  const v = o[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (v === undefined) {
    if (required) problems.push({ at: `${at}.${key}`, why: 'required' })
  } else problems.push({ at: `${at}.${key}`, why: 'type', value: shown(v) })
  return ''
}

function paramsOf(v: unknown, at: string, problems: SecretProblem[]): Record<string, ParamRule> {
  const out: Record<string, ParamRule> = {}
  if (v === undefined) return out
  if (!isObject(v)) {
    problems.push({ at, why: 'type', value: shown(v) })
    return out
  }
  for (const [name, rule] of Object.entries(v)) {
    const place = `${at}.${name}`
    if (!FIELD_NAME.test(name)) problems.push({ at: place, why: 'name', value: name })
    else if (rule === 'name' || rule === 'text') out[name] = { kind: rule }
    else if (typeof rule === 'string' && rule) {
      try {
        new RegExp(rule)
        out[name] = { kind: 'regex', source: rule }
      } catch {
        problems.push({ at: place, why: 'regex', value: rule })
      }
    } else problems.push({ at: place, why: 'type', value: shown(rule) })
  }
  return out
}

/** `~/x` from the home; any other path must be absolute already. */
function absolute(path: string, home: string, platform: string): string | null {
  const p = platform === 'win32' ? win32 : posix
  const expanded = path === '~' ? home : /^~[\\/]/.test(path) ? p.join(home, path.slice(2)) : path
  return p.isAbsolute(expanded) ? p.normalize(expanded) : null
}

/** Templated parts that may name parameters only: a field (a secret) in a file's name or a URL ends up in places no secret goes. */
function paramsOnly(value: unknown, params: Record<string, ParamRule>, at: string, problems: SecretProblem[]): void {
  for (const name of placeholders(value))
    if (!Object.hasOwn(params, name)) problems.push({ at, why: 'param', value: name })
}

function fieldsOf(
  parts: unknown[],
  params: Record<string, ParamRule>,
  at: string,
  problems: SecretProblem[],
): string[] {
  const names = placeholders(parts).filter(n => !Object.hasOwn(params, n))
  if (!names.length) problems.push({ at, why: 'field' })
  return names
}

function fileSink(base: SinkBase, o: Record<string, unknown>, at: string, opts: ParseOptions): FileSink {
  const { problems, params } = base
  const platform = opts.platform ?? process.platform
  const p = platform === 'win32' ? win32 : posix
  let folder = ''
  let name = ''
  if (o.path !== undefined && (o.folder !== undefined || o.name !== undefined))
    problems.push({ at: `${at}.path`, why: 'path', value: 'path, or folder and name' })
  if (o.path !== undefined) {
    const path = textOf(o, 'path', at, problems)
    const full = path ? absolute(path, opts.home, platform) : null
    if (path && !full) problems.push({ at: `${at}.path`, why: 'path', value: path })
    if (full) {
      folder = p.dirname(full)
      name = p.basename(full)
    }
  } else {
    const raw = textOf(o, 'folder', at, problems)
    const full = raw ? absolute(raw, opts.home, platform) : null
    if (raw && !full) problems.push({ at: `${at}.folder`, why: 'path', value: raw })
    folder = full ?? ''
    name = textOf(o, 'name', at, problems)
  }
  // the name: parameters only; as written (no template) it must be a safe name already
  paramsOnly(name, params, `${at}.name`, problems)
  if (name && !placeholders(name).length && !safeName(name))
    problems.push({ at: `${at}.name`, why: 'name', value: name })
  const format = (o.format ?? 'text') as FileFormat
  if (!FORMATS.includes(format)) problems.push({ at: `${at}.format`, why: 'format', value: shown(o.format) })
  const template = o.template
  if (template === undefined) problems.push({ at: `${at}.template`, why: 'required' })
  else if ((format === 'json' && !isObject(template)) || (format === 'env' && !isObject(template)))
    problems.push({ at: `${at}.template`, why: 'template', value: format })
  else if ((format === 'netrc' || format === 'text') && typeof template !== 'string')
    problems.push({ at: `${at}.template`, why: 'template', value: format })
  if (format === 'env' && isObject(template))
    for (const k of Object.keys(template))
      if (!ENV_NAME.test(k) || typeof template[k] !== 'string')
        problems.push({ at: `${at}.template.${k}`, why: 'env', value: k })
  let path: string[] | null = null
  if (o.at !== undefined) {
    if (format !== 'json') problems.push({ at: `${at}.at`, why: 'format', value: format })
    else if (!Array.isArray(o.at) || !o.at.length || !o.at.every(k => typeof k === 'string' && k))
      problems.push({ at: `${at}.at`, why: 'type', value: shown(o.at) })
    else {
      path = o.at as string[]
      paramsOnly(path, params, `${at}.at`, problems)
    }
  }
  const fields = fieldsOf([template ?? ''], params, `${at}.template`, problems)
  return { ...base, kind: 'file', folder, name, format, template, at: path, fields }
}

function bitwardenSink(base: SinkBase, o: Record<string, unknown>, at: string): BitwardenSink {
  const { problems, params } = base
  const folder = textOf(o, 'folder', at, problems)
  paramsOnly(folder, {}, `${at}.folder`, problems)
  const item = textOf(o, 'item', at, problems)
  paramsOnly(item, params, `${at}.item`, problems)
  const id = (key: string): string | null => {
    const v = textOf(o, key, at, problems, false)
    if (v && !BW_ID.test(v)) problems.push({ at: `${at}.${key}`, why: 'id', value: v })
    return v || null
  }
  const organization = id('organization')
  const collection = id('collection')
  if (!!organization !== !!collection)
    problems.push({ at: `${at}.${organization ? 'collection' : 'organization'}`, why: 'required' })
  return { ...base, kind: 'bitwarden', folder, item, organization, collection }
}

function envSink(base: SinkBase, o: Record<string, unknown>, at: string, opts: ParseOptions): EnvSink {
  const { problems } = base
  // A user environment variable is Windows' (HKCU\Environment): elsewhere there is none to set.
  if ((opts.platform ?? process.platform) !== 'win32') problems.push({ at, why: 'platform' })
  let vars: string[] | null = null
  let pattern: string | null = null
  const v = o.vars
  if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string')) {
    vars = v as string[]
    for (const name of vars) if (!ENV_NAME.test(name)) problems.push({ at: `${at}.vars`, why: 'env', value: name })
  } else if (typeof v === 'string' && v) {
    try {
      new RegExp(v)
      pattern = v
    } catch {
      problems.push({ at: `${at}.vars`, why: 'regex', value: v })
    }
  } else problems.push({ at: `${at}.vars`, why: v === undefined ? 'required' : 'type', value: shown(v) })
  return { ...base, kind: 'env', vars, pattern, fields: null }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function httpSink(base: SinkBase, o: Record<string, unknown>, at: string): HttpSink {
  const { problems, params } = base
  const method = (typeof o.method === 'string' ? o.method.trim().toUpperCase() : 'POST') || 'POST'
  if (!METHODS.includes(method)) problems.push({ at: `${at}.method`, why: 'method', value: shown(o.method) })
  const url = textOf(o, 'url', at, problems)
  if (url) {
    // the origin is the owner's as written: no template before the path
    const origin = /^[a-z]+:\/\/[^/?#]*/i.exec(url)?.[0] ?? ''
    let parsed: URL | null = null
    try {
      parsed = origin ? new URL(origin) : null
    } catch {}
    if (!parsed || placeholders(origin).length || parsed.username || parsed.password)
      problems.push({ at: `${at}.url`, why: 'origin', value: url })
    else if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCAL_HOSTS.includes(parsed.hostname)))
      problems.push({ at: `${at}.url`, why: 'scheme', value: url })
    paramsOnly(url, params, `${at}.url`, problems)
  }
  const headers: Record<string, string> = {}
  if (o.headers !== undefined) {
    if (!isObject(o.headers)) problems.push({ at: `${at}.headers`, why: 'type', value: shown(o.headers) })
    else
      for (const [k, v] of Object.entries(o.headers)) {
        if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v))
          problems.push({ at: `${at}.headers.${k}`, why: 'header', value: k })
        else headers[k] = v
      }
  }
  let auth: HttpSink['auth'] = null
  if (o.auth !== undefined) {
    if (isObject(o.auth) && typeof o.auth.user === 'string' && typeof o.auth.password === 'string')
      auth = { user: o.auth.user, password: o.auth.password }
    else problems.push({ at: `${at}.auth`, why: 'type', value: shown(o.auth) })
  }
  const body = o.body ?? null
  if (body !== null && typeof body !== 'string' && !isObject(body) && !Array.isArray(body))
    problems.push({ at: `${at}.body`, why: 'type', value: shown(body) })
  const fields = fieldsOf([headers, auth ?? '', body ?? ''], params, `${at}.body`, problems)
  return { ...base, kind: 'http', method, url, headers, auth, body, fields }
}

/**
 * config.json's `secrets`: `{ sinks: { <id>: <sink> } }`. Each sink is read on its own: one with a
 * problem is kept with its problems (the doctor and the form say them) and takes nothing.
 */
export function secretsConfig(raw: unknown, opts: ParseOptions): SecretsConfig {
  const sinks = new Map<string, Sink>()
  const problems: SecretProblem[] = []
  if (raw === undefined || raw === null) return { sinks, problems }
  if (!isObject(raw)) return { sinks, problems: [{ at: 'secrets', why: 'type', value: shown(raw) }] }
  unknownKeys(raw, ['sinks'], 'secrets', problems)
  if (raw.sinks === undefined) return { sinks, problems }
  if (!isObject(raw.sinks))
    return { sinks, problems: [...problems, { at: 'secrets.sinks', why: 'type', value: shown(raw.sinks) }] }
  for (const [id, v] of Object.entries(raw.sinks)) {
    const at = `secrets.sinks.${id}`
    const own: SecretProblem[] = []
    if (!SINK_ID.test(id)) own.push({ at, why: 'id', value: id })
    const o = isObject(v) ? v : {}
    if (!isObject(v)) own.push({ at, why: 'type', value: shown(v) })
    const kind = o.kind as SinkKind
    const known = Object.hasOwn(KEYS, kind)
    if (isObject(v) && !known)
      own.push({ at: `${at}.kind`, why: o.kind === undefined ? 'required' : 'kind', value: shown(o.kind) })
    const title = typeof o.title === 'string' ? cleanText(o.title, 200) : ''
    if (o.title !== undefined && typeof o.title !== 'string')
      own.push({ at: `${at}.title`, why: 'type', value: shown(o.title) })
    const params = known && kind !== 'env' ? paramsOf(o.params, `${at}.params`, own) : {}
    const base: SinkBase = { id, kind: known ? kind : 'file', title, params, fields: null, raw: v, problems: own }
    if (!known) {
      sinks.set(id, { ...base, kind: 'env', vars: null, pattern: null })
      continue
    }
    unknownKeys(o, KEYS[kind], at, own)
    const sink =
      kind === 'file'
        ? fileSink(base, o, at, opts)
        : kind === 'bitwarden'
          ? bitwardenSink(base, o, at)
          : kind === 'env'
            ? envSink(base, o, at, opts)
            : httpSink(base, o, at)
    sinks.set(id, sink)
  }
  return { sinks, problems }
}

/** The sinks a request can go to now: those without a problem. */
export const usableSinks = (conf: SecretsConfig): string[] =>
  [...conf.sinks.values()].filter(s => !s.problems.length).map(s => s.id)

/** A field as a request asks it: masked unless shown, and `once`: written only where none is there yet. */
export interface SecretField {
  name: string
  hidden: boolean
  once?: true
}

/** `name`, `name:hidden`, `name:shown`, with `:once` anywhere after the name; null when it is none of those. */
export function parseField(spec: string): SecretField | null {
  const [name = '', ...flags] = spec.split(':').map(s => s.trim())
  if (!name || flags.some(f => !['hidden', 'shown', 'once'].includes(f))) return null
  if (flags.includes('hidden') && flags.includes('shown')) return null
  return { name, hidden: !flags.includes('shown'), ...(flags.includes('once') && { once: true as const }) }
}

/** What a Bitwarden field name means for the item: its login's parts, else a custom field. */
export const BW_PARTS = ['username', 'password', 'totp', 'notes', 'uri'] as const

export const MAX_FIELDS = 12

export type RequestCheck =
  | { ok: true; params: Record<string, string>; fields: SecretField[] }
  | { ok: false; error: string; vars?: Record<string, string> }

/**
 * What a request may ask of `sink`: each declared parameter given and passing its rule, no other;
 * the fields a template names (all of them, masked, when the request names none), or for a sink
 * without a template the fields the request names, each a name the sink takes.
 */
export function checkRequest(sink: Sink, params: Record<string, string>, asked: SecretField[]): RequestCheck {
  if (sink.problems.length) return { ok: false, error: 'secret.err.sinkBroken', vars: { sink: sink.id } }
  for (const name of Object.keys(params))
    if (!Object.hasOwn(sink.params, name)) return { ok: false, error: 'secret.err.paramUnknown', vars: { name } }
  for (const [name, rule] of Object.entries(sink.params)) {
    const value = params[name]
    if (value === undefined) return { ok: false, error: 'secret.err.paramMissing', vars: { name } }
    if (!paramOk(rule, value)) return { ok: false, error: 'secret.err.paramBad', vars: { name } }
  }
  // a file's name filled in must still be one name inside the folder
  if (sink.kind === 'file' && !safeName(fillText(sink.name, params)))
    return { ok: false, error: 'secret.err.paramBad', vars: { name: placeholders(sink.name).join(', ') } }
  const names = asked.map(f => f.name)
  if (new Set(names).size !== names.length) return { ok: false, error: 'secret.err.fieldTwice' }
  if (asked.length > MAX_FIELDS) return { ok: false, error: 'secret.err.fieldsMany', vars: { n: String(MAX_FIELDS) } }
  let fields = asked
  if (sink.fields) {
    if (!asked.length) fields = sink.fields.map(name => ({ name, hidden: true }))
    else {
      const missing = sink.fields.filter(n => !names.includes(n))
      const extra = names.filter(n => !sink.fields?.includes(n))
      if (missing.length || extra.length)
        return { ok: false, error: 'secret.err.fieldsTemplate', vars: { fields: sink.fields.join(', ') } }
    }
  } else if (!asked.length) return { ok: false, error: 'secret.err.fieldsNone' }
  for (const f of fields) {
    const good =
      sink.kind === 'env'
        ? ENV_NAME.test(f.name) &&
          (sink.vars ? sink.vars.includes(f.name) : new RegExp(`^(?:${sink.pattern})$`).test(f.name))
        : FIELD_NAME.test(f.name)
    if (!good) return { ok: false, error: 'secret.err.fieldBad', vars: { name: f.name } }
  }
  // the other side's state is no one's to read: once cannot be kept there
  if (sink.kind === 'http' && fields.some(f => f.once)) return { ok: false, error: 'secret.err.onceHttp' }
  return { ok: true, params, fields }
}

/** What a typed value may not be for this sink and field: a key of the reason, or null. */
export function valueProblem(sink: Sink, field: string, value: string): string | null {
  if (sink.kind === 'bitwarden') return null
  if (!value) return 'secret.err.valueEmpty'
  if (sink.kind === 'file' && sink.format === 'netrc' && /\s/.test(value)) return 'secret.err.valueSpace'
  if (sink.kind === 'file' && sink.format === 'env' && /[\r\n\0]/.test(value)) return 'secret.err.valueLine'
  if (sink.kind === 'env' && (/\0/.test(value) || value.length > 32_000)) return 'secret.err.valueEnv'
  if (sink.kind === 'http' && /[\r\n]/.test(value) && placeholders([sink.headers, sink.auth ?? '']).includes(field))
    return 'secret.err.valueLine'
  return null
}

/** Where a sink writes for these parameters, as the form shows the owner (`kind` in the board's words). */
export interface SecretTarget {
  kind: SinkKind
  /** The file, the vault's folder and item, the variables, the method and URL. */
  where: string
  /** More of it: where in the file, the organization, what is kept. */
  detail: string
}

export function targetOf(
  sink: Sink,
  params: Record<string, string>,
  fields: readonly SecretField[],
  tr: Translator,
  platform: string = process.platform,
): SecretTarget {
  const p = platform === 'win32' ? win32 : posix
  switch (sink.kind) {
    case 'file': {
      const where = p.join(sink.folder, fillText(sink.name, params))
      const at = sink.at ? sink.at.map(k => fillText(k, params)).join(' › ') : ''
      const detail = at ? tr('secret.target.fileAt', { at }) : tr(`secret.target.file.${sink.format}`)
      return { kind: 'file', where, detail }
    }
    case 'bitwarden': {
      const where = tr('secret.target.bw', { folder: sink.folder, item: fillText(sink.item, params) })
      return { kind: 'bitwarden', where, detail: sink.organization ? tr('secret.target.bwOrg') : '' }
    }
    case 'env':
      return { kind: 'env', where: fields.map(f => f.name).join(', '), detail: tr('secret.target.env') }
    case 'http': {
      const url = fillText(sink.url, params, encodeURIComponent)
      return { kind: 'http', where: `${sink.method} ${url}`, detail: tr('secret.target.http') }
    }
  }
}

/**
 * What the form showed, as one short hash: the sink as config.json has it and the parameters. A
 * submit names it, and is refused when the sink changed since (the owner saw another place).
 */
export function fingerprintOf(sink: Sink, params: Record<string, string>, fields: readonly SecretField[]): string {
  return createHash('sha256')
    .update(JSON.stringify([sink.id, sink.raw, params, fields]))
    .digest('hex')
    .slice(0, 16)
}

/**
 * A text that may hold a typed value (a program's error, a server's answer) without any: each
 * value (and its trimmed form) replaced, one line, 300 characters at most.
 */
export function scrub(text: string, values: readonly string[]): string {
  let out = text
  const all = [...new Set(values.flatMap(v => [v, v.trim()]).filter(v => v.length > 0))].sort(
    (a, b) => b.length - a.length,
  )
  for (const v of all) out = out.split(v).join('•••')
  return cleanText(out, 300)
}

/** A request on its card, never with a value. */
export interface SecretRequest {
  id: string
  title: string
  sink: string
  params: Record<string, string>
  fields: SecretField[]
  /** Who asked: the session's key and name. */
  by: { key: string; name: string }
  at: number
  expires: number
  status: 'pending' | 'ok' | 'declined' | 'expired' | 'cancelled'
  /** When it was settled. */
  done?: number
  /** Where the values went (ok). */
  target?: string
  /** A submit writing it now, since then: another one waits for it (a minute at most). */
  writing?: number
}

export const DEFAULT_EXPIRES_MS = 30 * 60_000
export const MAX_EXPIRES_MS = 24 * 3_600_000
/** A claim older than this is a submit that died midway. */
export const WRITING_MS = 2 * 60_000
const KEPT_MS = 24 * 3_600_000
const KEPT_MAX = 20

/** `30m`, `2h`, `90s`, `1d`: ms, between a minute and a day; null for anything else. */
export function parseExpires(text: string): number | null {
  const m = /^(\d{1,5})\s*(s|m|h|d)$/i.exec(text.trim())
  if (!m) return null
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'm').toLowerCase() as 's' | 'm' | 'h' | 'd']
  const ms = Number(m[1]) * unit
  return ms >= 60_000 && ms <= MAX_EXPIRES_MS ? ms : null
}

const STATUSES = ['pending', 'ok', 'declined', 'expired', 'cancelled']

/** A card's requests as far as they are requests; anything else in the list is left out. */
export function requestsOf(v: unknown): SecretRequest[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (r): r is SecretRequest =>
      isObject(r) &&
      typeof r.id === 'string' &&
      typeof r.sink === 'string' &&
      typeof r.title === 'string' &&
      Number.isFinite(r.expires) &&
      STATUSES.includes(r.status as string) &&
      Array.isArray(r.fields) &&
      isObject(r.params),
  )
}

/** Its status now: a pending one past its time has expired, whether or not anyone said so yet. */
export const statusOf = (r: SecretRequest, now: number): SecretRequest['status'] =>
  r.status === 'pending' && now >= r.expires ? 'expired' : r.status

export const pendingOf = (list: readonly SecretRequest[], now: number): SecretRequest[] =>
  list.filter(r => statusOf(r, now) === 'pending')

/** The list as kept: settled ones for a day, the newest twenty. */
export function pruned(list: readonly SecretRequest[], now: number): SecretRequest[] {
  return list.filter(r => statusOf(r, now) === 'pending' || (r.done ?? r.expires) > now - KEPT_MS).slice(-KEPT_MAX)
}

/** The agent's one line: what came of its request. */
export function statusLine(r: SecretRequest, now: number): string {
  const status = statusOf(r, now)
  if (status === 'ok') return `ok · ${r.id} · ${r.target ?? r.sink} · ${new Date(r.done ?? now).toISOString()}`
  if (status === 'pending') return `pending · ${r.id} · ${r.sink} · until ${new Date(r.expires).toISOString()}`
  return `${status} · ${r.id} · ${r.sink}`
}

/** A pending request as the page shows it: where the values go, never one of them. */
export interface SecretView {
  id: string
  title: string
  sink: string
  sinkTitle: string
  kind: SinkKind
  where: string
  detail: string
  /** What the form sends back with the values: the sink as shown. */
  fingerprint: string
  fields: SecretField[]
  params: Record<string, string>
  at: number
  expires: number
  /** Why it cannot be written now (the sink is gone or does not check out): the form offers Decline only. */
  problem?: string
}

/** The card's pending requests for the payload, each with where it would write now. */
export function secretViews(
  conf: SecretsConfig,
  card: Record<string, unknown> | null | undefined,
  tr: Translator,
  now = Date.now(),
): SecretView[] {
  return pendingOf(requestsOf(card?.secrets), now).map(r => {
    const sink = conf.sinks.get(r.sink)
    const base = {
      id: r.id,
      title: r.title,
      sink: r.sink,
      fields: r.fields,
      params: r.params,
      at: r.at,
      expires: r.expires,
    }
    if (!sink)
      return {
        ...base,
        sinkTitle: '',
        kind: 'file',
        where: '',
        detail: '',
        fingerprint: '',
        problem: tr('secret.err.sinkGone', { sink: r.sink }),
      }
    const check = checkRequest(sink, r.params, r.fields)
    const target = targetOf(sink, r.params, r.fields, tr)
    return {
      ...base,
      sinkTitle: sink.title,
      kind: sink.kind,
      where: target.where,
      detail: target.detail,
      fingerprint: fingerprintOf(sink, r.params, r.fields),
      ...(!check.ok && { problem: tr(check.error, check.vars) }),
    }
  })
}
