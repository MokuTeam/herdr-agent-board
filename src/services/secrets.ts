// A secret request's life (#273, core/secrets.ts): an agent asks (`board secret request`), the
// request goes on its card, the card goes under "needs the user", the owner's submit on the board
// writes the sink (adapters/secret-sinks.ts), and the agent learns ok, declined or expired. Only
// the owner's submit writes: a request is no write, and nothing returns a value.
//
// Every step leaves an audit line in secrets/audit.jsonl in the state folder: who asked, the sink,
// the field names, the parameters, when, what came of it. Never a value: the values are in the
// submit's memory only, until the sink is written.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { allCards, readCard, updateCard } from '../adapters/cards.ts'
import { isRecord } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import { writeSink } from '../adapters/secret-sinks.ts'
import { t } from '../core/lang.ts'
import {
  checkRequest,
  fingerprintOf,
  MAX_PENDING,
  pendingOf,
  problemsText,
  pruned,
  requestsOf,
  type SecretField,
  type SecretRequest,
  type SecretsConfig,
  scrub,
  secretsConfig,
  statusOf,
  valueProblem,
  WRITING_MS,
  writingNow,
} from '../core/secrets.ts'
import type { SetupCheck } from '../core/setup.ts'
import { cleanText } from '../core/time.ts'
import type { Config, Translator } from '../core/types.ts'

export const secretsOf = (cfg: Pick<Config, 'secrets'>): SecretsConfig =>
  secretsConfig(cfg.secrets, { home: homedir() })

export const auditFile = (): string => join(stateDir(), 'secrets', 'audit.jsonl')
const AUDIT_MAX = 1 << 20

/** Who did it: the agent that asked, the owner on the board, the board itself (expired). */
type Who = 'agent' | 'owner' | 'board'

/** One line of the audit, never a value. A line that cannot be written is said on stderr, without it. */
export function audit(
  op: string,
  r: SecretRequest,
  who: Who,
  extra: Record<string, unknown> = {},
  now = Date.now(),
): void {
  const line = {
    at: new Date(now).toISOString(),
    op,
    id: r.id,
    sink: r.sink,
    fields: r.fields.map(f => f.name),
    params: r.params,
    asked: r.by,
    who,
    ...extra,
  }
  try {
    const file = auditFile()
    mkdirSync(join(stateDir(), 'secrets'), { recursive: true })
    try {
      // a megabyte, then the one before it moves aside
      if (statSync(file).size > AUDIT_MAX) renameSync(file, `${file}.1`)
    } catch {}
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  } catch (err) {
    console.error(`secrets audit: ${(err as Error).message}`)
  }
}

export type Ask = { ok: true; request: SecretRequest } | { ok: false; error: string }

export interface AskInput {
  title: string
  sink: string
  params: Record<string, string>
  fields: SecretField[]
  expiresMs: number
}

/** An agent's request on its card, once the sink takes it. */
export function askSecret(
  cfg: Pick<Config, 'secrets'>,
  by: { key: string; name: string },
  input: AskInput,
  now = Date.now(),
): Ask {
  const conf = secretsOf(cfg)
  const sink = conf.sinks.get(input.sink)
  if (!sink) {
    const known = [...conf.sinks.keys()].join(', ')
    return { ok: false, error: known ? t('secret.err.noSink', { sink: input.sink, known }) : t('secret.err.noSinks') }
  }
  const title = cleanText(input.title, 200)
  if (!title) return { ok: false, error: t('secret.err.title') }
  const check = checkRequest(sink, input.params, input.fields)
  if (!check.ok) return { ok: false, error: t(check.error, check.vars) }
  if (pendingOf(requestsOf(readCard(by.key)?.secrets), now).length >= MAX_PENDING)
    return { ok: false, error: t('secret.err.pendingMany', { n: MAX_PENDING }) }
  const request: SecretRequest = {
    id: randomBytes(6).toString('hex'),
    title,
    sink: sink.id,
    params: check.params,
    fields: check.fields,
    by,
    at: now,
    expires: now + input.expiresMs,
    status: 'pending',
  }
  updateCard(by.key, saved => ({
    ...(saved ?? { key: by.key }),
    secrets: [...pruned(requestsOf(saved?.secrets), now), request],
  }))
  audit('asked', request, 'agent', { expires: new Date(request.expires).toISOString() }, now)
  return { ok: true, request }
}

/** The request with this id and the card it is on, wherever it is. */
export function findRequest(id: string): { key: string; request: SecretRequest } | null {
  for (const [key, card] of allCards()) {
    const request = requestsOf(card.secrets).find(r => r.id === id)
    if (request) return { key, request }
  }
  return null
}

/** One of this session's requests. */
export const ownRequest = (key: string, id: string): SecretRequest | null =>
  requestsOf(readCard(key)?.secrets).find(r => r.id === id) ?? null

/**
 * The request changed under its card's lock while `ok` says so of it as saved; null when it is
 * not there or `ok` refused (another submit settled it first).
 */
function change(
  key: string,
  id: string,
  ok: (r: SecretRequest) => boolean,
  patch: (r: SecretRequest) => SecretRequest,
  now: number,
): SecretRequest | null {
  let out: SecretRequest | null = null
  updateCard(key, saved => {
    const list = requestsOf(saved?.secrets)
    const at = list.findIndex(r => r.id === id)
    const r = list[at]
    if (!saved || !r || !ok(r)) return undefined
    out = patch(r)
    const next = [...list]
    next[at] = out
    return { ...saved, secrets: pruned(next, now) }
  })
  return out
}

/** Settles a pending request (declined, cancelled, expired, ok): null when it was not pending any more. */
function settle(
  key: string,
  id: string,
  status: SecretRequest['status'],
  now: number,
  target?: string,
): SecretRequest | null {
  return change(
    key,
    id,
    // a write under way is the submit's to settle: no decline, cancel or expiry cuts across it
    r => r.status === 'pending' && (status === 'ok' || !writingNow(r, now)),
    r => {
      const { writing: _, ...rest } = r
      return { ...rest, status, done: now, ...(target && { target }) }
    },
    now,
  )
}

/** A pending request past its time, said expired on its card and in the audit; the request as it is now. */
export function expireIfDue(key: string, r: SecretRequest, now = Date.now()): SecretRequest {
  if (r.status !== 'pending' || statusOf(r, now) !== 'expired') return r
  const done = settle(key, r.id, 'expired', now)
  if (done) audit('expired', done, 'board', {}, now)
  return done ?? ownRequest(key, r.id) ?? r
}

/** The agent takes its own request back. */
export function cancelSecret(key: string, id: string, now = Date.now()): SecretRequest | null {
  const r = ownRequest(key, id)
  if (!r) return null
  const done = settle(key, id, 'cancelled', now)
  if (done) audit('cancelled', done, 'agent', {}, now)
  return done ?? expireIfDue(key, r, now)
}

/** What a route answers: its status, and a body that never holds a value. */
export interface Answer {
  status: number
  body: { ok: boolean; error?: string; target?: string; httpStatus?: number }
}

const no = (status: number, error: string): Answer => ({ status, body: { ok: false, error } })

/** The owner declines on the board. */
export function declineSecret(id: string, now = Date.now()): Answer {
  const found = findRequest(id)
  if (!found) return no(404, t('secret.err.gone'))
  const r = expireIfDue(found.key, found.request, now)
  const done = r.status === 'pending' ? settle(found.key, id, 'declined', now) : null
  if (!done) {
    const again = ownRequest(found.key, id) ?? r
    return no(
      409,
      again.status === 'pending' && writingNow(again, now)
        ? t('secret.err.busy')
        : t(`secret.err.was.${statusOf(again, now)}`),
    )
  }
  audit('declined', done, 'owner', {}, now)
  return { status: 200, body: { ok: true } }
}

export interface Submit {
  /** By field name; every field the request asks, no other. */
  values: unknown
  /** What the form showed (fingerprintOf). */
  fingerprint: unknown
  /** Bitwarden's session, for a Bitwarden sink. */
  session?: unknown
}

/**
 * The owner's submit: the request still pending, its sink the same as the form showed, every
 * value given and fit for the sink; then one write at a time (a second device's submit waits for
 * the first), and the request is ok, or stays pending with why it failed.
 */
export async function submitSecret(
  cfg: Pick<Config, 'secrets'>,
  id: string,
  input: Submit,
  now = Date.now(),
): Promise<Answer> {
  const found = findRequest(id)
  if (!found) return no(404, t('secret.err.gone'))
  const { key } = found
  const r = expireIfDue(key, found.request, now)
  if (r.status !== 'pending') return no(409, t(`secret.err.was.${r.status}`))
  const sink = secretsOf(cfg).sinks.get(r.sink)
  if (!sink) return no(409, t('secret.err.sinkGone', { sink: r.sink }))
  const check = checkRequest(sink, r.params, r.fields)
  if (!check.ok) return no(409, t(check.error, check.vars))
  if (input.fingerprint !== fingerprintOf(sink, r.params, r.fields)) return no(409, t('secret.err.changed'))
  if (!isRecord(input.values)) return no(400, t('secret.err.values'))
  const given = input.values
  const values: Record<string, string> = {}
  for (const name of Object.keys(given))
    if (!r.fields.some(f => f.name === name)) return no(400, t('secret.err.values'))
  for (const f of r.fields) {
    const raw = given[f.name]
    if (typeof raw !== 'string') return no(400, t('secret.err.values'))
    // what a paste brings around it (a line break, a space) is no part of a key
    const value = raw.trim()
    const problem = valueProblem(sink, f.name, value)
    if (problem) return no(400, t(problem, { name: f.name }))
    values[f.name] = value
  }
  const session = typeof input.session === 'string' ? input.session : ''
  if (sink.kind === 'bitwarden' && !session.trim()) return no(400, t('secret.err.bwSession'))
  // Bitwarden leaves a part left empty as it is, but an item with nothing new is no write
  if (!Object.values(values).some(Boolean))
    return no(400, t('secret.err.valueEmpty', { name: r.fields[0]?.name ?? '' }))
  const claimed = change(
    key,
    id,
    x => x.status === 'pending' && !(x.writing && now - x.writing < WRITING_MS),
    x => ({ ...x, writing: now }),
    now,
  )
  if (!claimed) {
    const again = ownRequest(key, id)
    return no(409, again?.status === 'pending' ? t('secret.err.busy') : t(`secret.err.was.${again?.status ?? 'gone'}`))
  }
  const result = await writeSink({ sink, params: r.params, fields: r.fields, values, bwSession: session })
  const at = Date.now()
  if (result.ok) {
    const done = settle(key, id, 'ok', at, result.target)
    audit(
      'written',
      done ?? r,
      'owner',
      { target: result.target, ...(result.status && { httpStatus: result.status }) },
      at,
    )
    return {
      status: 200,
      body: { ok: true, target: result.target, ...(result.status && { httpStatus: result.status }) },
    }
  }
  change(
    key,
    id,
    x => x.status === 'pending',
    ({ writing: _, ...x }) => x,
    at,
  )
  audit('failed', r, 'owner', { error: result.error, ...(result.status && { httpStatus: result.status }) }, at)
  // the reason in words, the values scrubbed from it once more
  const error = scrub(t(result.error, { ...result.vars }), Object.values(values).concat(session))
  return {
    status: result.status ? 502 : 400,
    body: { ok: false, error, ...(result.status && { httpStatus: result.status }) },
  }
}

/** `board doctor`'s line for the sinks, once config.json has `secrets`: how many, or what does not check out. */
export function secretsChecks(cfg: Pick<Config, 'secrets'>, tr: Translator): SetupCheck[] {
  if (cfg.secrets === undefined) return []
  const conf = secretsOf(cfg)
  const problems = [...conf.problems, ...[...conf.sinks.values()].flatMap(s => s.problems)]
  const base = { id: 'secrets', title: tr('secret.doctor.title'), fix: '', code: '' }
  return [
    problems.length
      ? { ...base, level: 'error', detail: tr('secret.doctor.problems', { problems: problemsText(problems, tr) }) }
      : { ...base, level: 'ok', detail: tr('secret.doctor.ok', { n: conf.sinks.size }) },
  ]
}
