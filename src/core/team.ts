// The peer network (#231), its pure rules: config.json's `team`, the bytes that are signed, the
// envelopes and frames of the wire protocol v1, and the Ed25519 signatures over them. The board
// (services/team-hub.ts) and the hub (hub/) both import this file, so there is one set of signed
// bytes and one set of limits.
//
// config.json's `team` turns it on; a setup without it sees nothing of this anywhere:
//   "team": { "hub": "ws://100.64.0.7:7443", "name": "anna" }
// Only an object with a ws:// or wss:// hub counts.
import { createHash } from 'node:crypto'
import {
  BLOB_CHUNK,
  type BoxClaim,
  CAPS,
  DELIVERY_STATES,
  type DeliveryState,
  type Envelope,
  ERROR_CODES,
  type ErrorCode,
  type FileRef,
  type Frame,
  GENERAL,
  type HubFiles,
  KINDS,
  MAX_CAP,
  MAX_CAPS,
  MAX_ENVELOPE_BYTES,
  MAX_FILE_META,
  MAX_LINK,
  MAX_MEMBERS,
  MAX_NAME,
  MAX_TEXT,
  MAX_TITLE,
  MAX_WORK_LINE,
  MAX_WORK_N,
  type Message,
  type RosterPeer,
  TEAM_PROTOCOL,
  type ThreadRef,
  VIAS,
  type Via,
  WORK_CAP,
  WORK_STATUSES,
  WORK_TYPES,
  type WorkBody,
  type WorkParty,
  type WorkSet,
} from './team-wire.ts'

export * from './team-wire.ts'

export interface TeamConfig {
  hub: string
  name: string | null
}

/**
 * A hub address without the trailing slashes and without the `/v1` the board adds itself, so
 * `ws://h:7443`, `ws://h:7443/` and `ws://h:7443/v1` are one hub. Null unless it is a ws:// or wss:// URL.
 */
export function normalizeHub(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const hub = raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
  try {
    const url = new URL(hub)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  } catch {
    return null
  }
  return hub
}

/** config.json's `team` as the board uses it, or null while it is not on. */
export function teamConfig(raw: unknown): TeamConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const hub = normalizeHub(r.hub)
  if (hub === null) return null
  const name = typeof r.name === 'string' && validName(r.name) ? r.name : null
  return { hub, name }
}

/** Controls (C0, DEL, C1), line and paragraph separators, and the bidi controls that reorder what is around them. */
const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu

/** `s` without what validName counts unprintable (#394: a shared thread's line, before it goes out). */
export const withoutUnprintable = (s: string): string => s.replace(new RegExp(UNPRINTABLE), '')

/** Whether `s` has anything unprintable in it, as validName counts it. */
export const hasUnprintable = (s: string): boolean => new RegExp(UNPRINTABLE).test(s)

export const validName = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= MAX_NAME && !new RegExp(UNPRINTABLE).test(v)

/** A thread's title (#216): trimmed, 1 to MAX_TITLE characters, nothing unprintable. */
export const validTitle = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= MAX_TITLE && !new RegExp(UNPRINTABLE).test(v)

/** A thread's link (#216): an http(s) URL of at most MAX_LINK characters, no spaces, nothing unprintable. */
export function validLink(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_LINK || /\s/.test(v) || new RegExp(UNPRINTABLE).test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Caps as a board keeps them (#216): words of lowercase letters, digits and `._/-`, at most
 * MAX_CAP long, at most MAX_CAPS of them, duplicates dropped. Anything else counts as no caps.
 */
export function cleanCaps(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_CAPS) return undefined
  const ok = v.filter((c): c is string => typeof c === 'string' && c.length <= MAX_CAP && /^[a-z0-9._/-]+$/.test(c))
  const out = [...new Set(ok)]
  return out.length ? out : undefined
}

/** What this board says it understands, in `hello`. */
export const OUR_CAPS: string[] = [...CAPS]

/**
 * The caps of this board's `hello`: `files` only with a box key (#371), `work` only while shared
 * threads are on (#394), after the others; off, exactly what a board without #394 says.
 */
export function ourCaps({ files, work }: { files: boolean; work: boolean }): string[] {
  const caps = files ? [...OUR_CAPS] : OUR_CAPS.filter(c => c !== 'files')
  return work ? [...caps, WORK_CAP] : caps
}

/** Whether a roster peer's board keeps shared threads (#394): its caps say `work`. */
export const hasWork = (p: { caps?: string[] | undefined } | undefined): boolean => !!p?.caps?.includes(WORK_CAP)

/** Whether a roster peer's board understands threads (#216). */
export const hasThreads = (p: { caps?: string[] | undefined } | undefined): boolean => !!p?.caps?.includes('threads')

/** Whether a roster peer's board understands channels (#355). */
export const hasChannels = (p: { caps?: string[] | undefined } | undefined): boolean => !!p?.caps?.includes('channels')

/** Whether a roster peer's board understands replies to a message (#370). */
export const hasReplies = (p: { caps?: string[] | undefined } | undefined): boolean => !!p?.caps?.includes('replies')
/** Whether a roster peer's board takes files (#371); its box must verify too before one goes to it. */
export const hasFiles = (p: { caps?: string[] | undefined } | undefined): boolean => !!p?.caps?.includes('files')
/**
 * Whether a roster peer is an assistant's bridge (#386, docs/design/assistant-bridge): it says so
 * with the `assistant` cap. A board never says it of itself; the panel only ticks "All lanes" by
 * default for such a peer, and the owner still turns its agents on.
 */
export const hasAssistant = (p: { caps?: string[] | undefined } | undefined): boolean =>
  !!p?.caps?.includes('assistant')

/** A channel's member list as the wire takes it: 2 to MAX_MEMBERS peer ids, each once, sorted. */
export function channelMembers(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_MEMBERS || !v.every(isPeerId)) return null
  const sorted = [...v].sort()
  return new Set(sorted).size === sorted.length ? sorted : null
}

/** `s` for a terminal: whatever is not printable is written as \u{hex}, so it cannot move the cursor or reorder text. */
export const printable = (s: string): string =>
  s.replace(UNPRINTABLE, c => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`)

// ---- Encoding

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/**
 * The bytes of a base64url string, or null when it is not one: no padding, no other characters,
 * and the canonical form only (the unused bits of the last character are zero), so one key or
 * signature has one spelling and `b64u(unb64u(s)) === s`.
 */
export function unb64u(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const bytes = new Uint8Array(Buffer.from(s, 'base64url'))
  return b64u(bytes) === s ? bytes : null
}

// ---- What is signed

/**
 * The canonical JSON of a value (RFC 8785 for this domain): object keys sorted by UTF-16 code
 * units, no whitespace, strings and finite numbers as JSON.stringify writes them. Undefined,
 * functions, non-finite numbers and the like are refused with a TypeError. Only for what the
 * verifier rebuilds from values it already knows (auth, join, ack); an envelope's payload is
 * signed as the string it is (#217) and never goes through this.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('canonicalJson: a number that is not finite')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  throw new TypeError(`canonicalJson: cannot write a ${typeof v}`)
}

export type Purpose = 'auth' | 'join' | 'envelope' | 'ack' | 'box'

/** The purpose binds a signature to one use, so none works as another. */
const domain = (purpose: Purpose): string => `hab-team/${TEAM_PROTOCOL} ${purpose}\n`

/** What is signed of values both sides know: the purpose, then their canonical JSON. */
export const signedBytes = (purpose: Exclude<Purpose, 'envelope'>, obj: unknown): Uint8Array =>
  new TextEncoder().encode(`${domain(purpose)}${canonicalJson(obj)}`)

export interface AuthParts {
  hub: string
  nonce: string
  peer: string
}
export interface JoinParts extends AuthParts {
  invite: string
  name: string
}
export interface AckParts {
  by: string
  id: string
  to: string
  ts: string
}

export const authBytes = (p: AuthParts): Uint8Array => signedBytes('auth', { hub: p.hub, nonce: p.nonce, peer: p.peer })
export const joinBytes = (p: JoinParts): Uint8Array =>
  signedBytes('join', { hub: p.hub, invite: p.invite, name: p.name, nonce: p.nonce, peer: p.peer })
export const ackBytes = (p: AckParts): Uint8Array => signedBytes('ack', { by: p.by, id: p.id, to: p.to, ts: p.ts })
/** What a board signs of its box key (#371): the key and the peer it is for. */
export const boxBytes = (p: { box: string; peer: string }): Uint8Array =>
  signedBytes('box', { box: p.box, peer: p.peer })

/** Whether `claim` is `peer`'s own box key: a 32-byte key, signed by the peer's Ed25519 key (#371). */
export async function verifyBox(peer: string, claim: BoxClaim | undefined): Promise<boolean> {
  if (!claim || unb64u(claim.key)?.length !== 32) return false
  return verify(peer, boxBytes({ box: claim.key, peer }), claim.sig)
}

// ---- Envelopes and frames

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PEER = /^[A-Za-z0-9_-]{43}$/
const SIG = /^[A-Za-z0-9_-]{86}$/

/** A message or draft id: the UUID v4 this board makes. */
export const isMessageId = (v: unknown): v is string => isStr(v) && UUID.test(v)
export const isPeerId = (v: unknown): v is string => isStr(v) && PEER.test(v)
export const isSig = (v: unknown): v is string => isStr(v) && SIG.test(v)
/** A thread id: a UUID v4, or GENERAL for the thread with no topic (#216). */
export const isThreadId = (v: unknown): v is string => v === GENERAL || isMessageId(v)
/** A SHA-256 as base64url (#371). */
export const isHash = (v: unknown): v is string => unb64u(v)?.length === 32
/** A whole number of bytes from 0 to `max`. */
const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max

/** `board`: everything a board reads is held to the whitelist. `relay`: the hub's check, `text` only (#216). */
export type CheckMode = 'board' | 'relay'

const WIRE_FIELDS = ['from', 'payload', 'sig']
const MESSAGE_FIELDS = ['v', 'id', 'from', 'to', 'kind', 'reply_to', 'ts', 'ttl_s', 'body']

/**
 * An envelope's shape on the wire: exactly `from`, `payload` and `sig`, the payload a string of
 * well-formed text (so one string has one set of bytes) within the size limit. The payload is not
 * read here, and the signature is checked elsewhere.
 */
export function checkEnvelope(v: unknown): { ok: true; env: Envelope } | { ok: false; code: ErrorCode } {
  if (!isRecord(v)) return { ok: false, code: 'bad_frame' }
  if (Object.keys(v).length !== WIRE_FIELDS.length || Object.keys(v).some(k => !WIRE_FIELDS.includes(k)))
    return { ok: false, code: 'bad_frame' }
  if (!isPeerId(v.from) || !isStr(v.payload) || !isSig(v.sig) || !v.payload.isWellFormed())
    return { ok: false, code: 'bad_frame' }
  if (new TextEncoder().encode(v.payload).length > MAX_ENVELOPE_BYTES) return { ok: false, code: 'too_big' }
  return { ok: true, env: { from: v.from, payload: v.payload, sig: v.sig } }
}

/**
 * The strict checks on a payload: read it as JSON, and hold it to the field set, the types, the
 * body keys, the kind whitelist and the via whitelist. Only for a payload whose signature verified.
 * `from` is the key it was signed with, and the message must say the same. On a refusal the id is
 * given back when the (signed) payload has one, so the sender can be told which message it was.
 */
export function checkMessage(
  payload: string,
  from: string,
  mode: CheckMode = 'board',
): { ok: true; msg: Message } | { ok: false; code: ErrorCode; id?: string } {
  let v: unknown
  try {
    v = JSON.parse(payload)
  } catch {
    return { ok: false, code: 'bad_frame' }
  }
  if (!isRecord(v)) return { ok: false, code: 'bad_frame' }
  const id = isStr(v.id) ? { id: v.id } : {}
  const no = (code: ErrorCode) => ({ ok: false as const, code, ...id })
  if (v.v !== TEAM_PROTOCOL) return no('version')
  const body = v.body
  if (
    !isStr(v.id) ||
    !UUID.test(v.id) ||
    v.from !== from ||
    !isStr(v.to) ||
    !isStr(v.kind) ||
    !(v.reply_to === null || isStr(v.reply_to)) ||
    !isStr(v.ts) ||
    Number.isNaN(Date.parse(v.ts)) ||
    typeof v.ttl_s !== 'number' ||
    !Number.isFinite(v.ttl_s) ||
    !isRecord(body) ||
    !isStr(body.text)
  )
    return no('bad_frame')
  // A copy with a file may come without a caption (#371); the relay checks only the file's shape.
  const hasFile = readFileRef(body.file) !== null
  if (!KINDS.some(k => k === v.kind)) return no('kind')
  if (v.to === '*') return no('broadcast')
  if (!isPeerId(v.to)) return no('bad_frame')
  if (body.text.length < (hasFile ? 0 : 1) || body.text.length > MAX_TEXT) return no('bad_frame')
  // A board reads the body as `text`, `via` when it is exactly "agent", `agent` (only with `via`),
  // `thread` (#216), `replyTo` and `post` (#370), `file` (#371); any other key or value is not a
  // body. The hub relays: it holds `text` to its limits and passes the rest on as signed, so a new
  // body field needs no new hub (the boards that do not know it never get it: the sender asks the
  // roster's caps first).
  const extras = readBodyExtras(body)
  if (mode === 'board' && !extras.ok) return no('bad_frame')
  if (Object.keys(v).some(k => !MESSAGE_FIELDS.includes(k))) return no('bad_frame')
  // Only the signed fields are kept; what the board keeps is this rebuilt message.
  const msg: Message = {
    v: TEAM_PROTOCOL,
    id: v.id,
    from,
    to: v.to,
    kind: v.kind as Message['kind'],
    reply_to: v.reply_to,
    ts: v.ts,
    ttl_s: v.ttl_s,
    body: { text: body.text, ...extras.extras },
  }
  return { ok: true, msg }
}

const BODY_KEYS = ['text', 'via', 'agent', 'thread', 'replyTo', 'post', 'file', 'work']
const THREAD_KEYS = ['id', 'title', 'link', 'group', 'members']

/**
 * The body's fields besides `text`, as a board accepts them: `via` exactly "agent"; `agent` a
 * name, only with `via`; `thread` with an id (a UUID, or GENERAL with no title), a title for a
 * UUID, an optional http(s) link and `group: true` for a team thread; `replyTo` and `post` message
 * ids (#370). ok is false when anything is
 * off or a key is unknown; `extras` then holds only the fields that were well formed (the hub's audit).
 */
function readBodyExtras(body: Record<string, unknown>): {
  ok: boolean
  extras: Omit<Message['body'], 'text'>
} {
  const extras: Omit<Message['body'], 'text'> = {}
  let ok = Object.keys(body).every(k => BODY_KEYS.includes(k))
  if (Object.hasOwn(body, 'via')) {
    if (VIAS.some(x => x === body.via)) extras.via = body.via as Via
    else ok = false
  }
  if (Object.hasOwn(body, 'agent')) {
    if (extras.via && validName(body.agent)) extras.agent = body.agent
    else ok = false
  }
  if (Object.hasOwn(body, 'thread')) {
    const t = readThread(body.thread)
    if (t) extras.thread = t
    else ok = false
  }
  // A reply (#370): the answered message's id, and a team copy's post id, each a message id.
  for (const k of ['replyTo', 'post'] as const) {
    if (!Object.hasOwn(body, k)) continue
    const v = body[k]
    if (isMessageId(v)) extras[k] = v
    else ok = false
  }
  if (Object.hasOwn(body, 'file')) {
    const f = readFileRef(body.file)
    if (f) extras.file = f
    else ok = false
  }
  // A shared thread's entry (#394): only in a topic, each field held to its limits.
  if (Object.hasOwn(body, 'work')) {
    const w = readWork(body.work)
    const t = extras.thread
    if (w && t && t.id !== GENERAL) extras.work = w
    else ok = false
  }
  return { ok, extras }
}

const WORK_KEYS = ['n', 'type', 'set', 'head', 'auto', 'share', 'unshare', 'hist']
const WORK_SET_KEYS = ['status', 'summary', 'title', 'waitingOn', 'assignee']
const WORK_HEAD_KEYS = ['key', 'title', 'status', 'summary', 'rev']
/** A thread's key as its sharer minted it: a lane id, a dash, a number (core/work-threads.ts THREAD_KEY). */
const WORK_KEY = /^[a-z0-9_-]{1,64}-\d{1,9}$/
const isWorkStatus = (v: unknown): v is (typeof WORK_STATUSES)[number] => WORK_STATUSES.some(s => s === v)
/** A line of a shared thread: trimmed, nothing unprintable, at most MAX_WORK_LINE; may be empty. */
const isWorkLine = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length <= MAX_WORK_LINE && !new RegExp(UNPRINTABLE).test(v)
const isWorkN = (v: unknown, min: number): v is number => isCount(v, MAX_WORK_N) && v >= min
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every(k => keys.includes(k))

function readWorkParty(v: unknown): WorkParty | null | undefined {
  if (v === null) return null
  if (!isRecord(v) || !onlyKeys(v, ['peer', 'agent']) || !isPeerId(v.peer)) return undefined
  if (Object.hasOwn(v, 'agent') && !validName(v.agent)) return undefined
  return { peer: v.peer, ...(typeof v.agent === 'string' && { agent: v.agent }) }
}

/**
 * A shared thread's entry as a board accepts it (#394, 11.4): exactly its known keys, the counter
 * a whole number, the type and statuses from their lists, every line within its limit and
 * printable, the head's revision at least the entry's counter, the flags `true` only. Null for
 * anything else.
 */
export function readWork(v: unknown): WorkBody | null {
  if (!isRecord(v) || !onlyKeys(v, WORK_KEYS)) return null
  if (!isWorkN(v.n, 1) || !WORK_TYPES.some(t => t === v.type)) return null
  for (const flag of ['auto', 'share', 'unshare', 'hist'] as const)
    if (Object.hasOwn(v, flag) && v[flag] !== true) return null
  const h = v.head
  if (!isRecord(h) || Object.keys(h).length !== WORK_HEAD_KEYS.length || !onlyKeys(h, WORK_HEAD_KEYS)) return null
  if (typeof h.key !== 'string' || !WORK_KEY.test(h.key) || !validTitle(h.title) || !isWorkStatus(h.status)) return null
  if (!isWorkLine(h.summary) || !isWorkN(h.rev, v.n)) return null
  const work: WorkBody = {
    n: v.n,
    type: v.type as WorkBody['type'],
    head: {
      key: h.key,
      title: h.title,
      status: h.status as WorkBody['head']['status'],
      summary: h.summary,
      rev: h.rev,
    },
  }
  if (Object.hasOwn(v, 'set')) {
    const s = v.set
    if (!isRecord(s) || !onlyKeys(s, WORK_SET_KEYS)) return null
    const set: WorkSet = {}
    if (Object.hasOwn(s, 'status')) {
      if (!isWorkStatus(s.status)) return null
      set.status = s.status
    }
    for (const k of ['summary', 'waitingOn'] as const) {
      if (!Object.hasOwn(s, k)) continue
      const line = s[k]
      if (!isWorkLine(line)) return null
      set[k] = line
    }
    if (Object.hasOwn(s, 'title')) {
      if (!validTitle(s.title)) return null
      set.title = s.title
    }
    if (Object.hasOwn(s, 'assignee')) {
      const a = readWorkParty(s.assignee)
      if (a === undefined) return null
      set.assignee = a
    }
    work.set = set
  }
  for (const flag of ['auto', 'share', 'unshare', 'hist'] as const) if (v[flag] === true) work[flag] = true
  return work
}

const FILE_KEYS = ['blob', 'size', 'hash', 'eph', 'key', 'meta']
/** A wrapped file key: a nonce, the 32-byte key, the tag (team-box.ts). */
const WRAPPED_BYTES = 12 + 32 + 16

/** A file as a board accepts it (#371): exactly its six fields, each well formed. */
export function readFileRef(v: unknown): FileRef | null {
  if (!isRecord(v) || Object.keys(v).length !== FILE_KEYS.length || !FILE_KEYS.every(k => Object.hasOwn(v, k)))
    return null
  if (!isMessageId(v.blob) || !isCount(v.size) || v.size < 1 || !isHash(v.hash) || unb64u(v.eph)?.length !== 32)
    return null
  if (unb64u(v.key)?.length !== WRAPPED_BYTES || !isStr(v.meta) || v.meta.length > MAX_FILE_META) return null
  const meta = unb64u(v.meta)
  if (!meta || meta.length < 12 + 16 + 1) return null
  return { blob: v.blob, size: v.size, hash: v.hash, eph: v.eph as string, key: v.key as string, meta: v.meta }
}

function readThread(v: unknown): ThreadRef | null {
  if (!isRecord(v) || Object.keys(v).some(k => !THREAD_KEYS.includes(k))) return null
  if (!isThreadId(v.id)) return null
  const general = v.id === GENERAL
  if (general ? Object.hasOwn(v, 'title') : !validTitle(v.title)) return null
  if (Object.hasOwn(v, 'link') && !validLink(v.link)) return null
  if (Object.hasOwn(v, 'group') && v.group !== true) return null
  // A channel (#355): a team topic with its member list, sorted as sent.
  const members = Object.hasOwn(v, 'members') ? channelMembers(v.members) : undefined
  if (
    members === null ||
    (members && (general || v.group !== true || members.join() !== (v.members as string[]).join()))
  )
    return null
  const t: ThreadRef = { id: v.id }
  if (!general) t.title = v.title as string
  if (Object.hasOwn(v, 'link')) t.link = v.link as string
  if (v.group === true) t.group = true
  if (members) t.members = members
  return t
}

/** What an envelope's signature covers: the domain prefix, then the payload string as it is, nothing rebuilt. */
export const envelopeBytes = (payload: string): Uint8Array =>
  new TextEncoder().encode(`${domain('envelope')}${payload}`)

/** The envelope of a message, signed by `key`: the message is written once, and what was written is what is signed. */
export async function sealEnvelope(key: KeyPair, msg: Message): Promise<Envelope> {
  const payload = JSON.stringify(msg)
  return { from: key.pub, payload, sig: await sign(key.pkcs8, envelopeBytes(payload)) }
}

export type Opened =
  | { ok: true; env: Envelope; msg: Message }
  | { ok: false; code: ErrorCode; from?: string; id?: string }

/**
 * Takes an envelope in, in this order: its shape on the wire (the payload still a string), who it
 * claims to be from (when `from` is given, the key the caller knows the sender by: the hub's
 * connection), the signature over the payload exactly as it came, and only then the payload is
 * parsed and held to checkMessage. A payload changed by one byte, or written with its keys in
 * another order, fails at the signature. On a refusal `from` is given back once the shape passed.
 */
export async function openEnvelope(v: unknown, from?: string, mode: CheckMode = 'board'): Promise<Opened> {
  const wire = checkEnvelope(v)
  if (!wire.ok) return wire
  const env = wire.env
  if ((from !== undefined && env.from !== from) || !(await verify(env.from, envelopeBytes(env.payload), env.sig)))
    return { ok: false, code: 'bad_sig', from: env.from }
  const checked = checkMessage(env.payload, env.from, mode)
  return checked.ok ? { ok: true, env, msg: checked.msg } : { ...checked, from: env.from }
}

/** A frame's shape, or null for what is no frame. Envelopes inside are checked by checkEnvelope. */
export function parseFrame(text: string): Frame | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v) || !isStr(v.t)) return null
  switch (v.t) {
    case 'hello':
      if (typeof v.v !== 'number' || !isStr(v.peer) || !isStr(v.client)) return null
      return withBox(withCaps({ t: 'hello' as const, v: v.v, peer: v.peer, client: v.client }, v.caps), v.box)
    case 'challenge':
      return isStr(v.hub) && isStr(v.nonce) ? { t: 'challenge', hub: v.hub, nonce: v.nonce } : null
    case 'auth':
      return isStr(v.sig) ? { t: 'auth', sig: v.sig } : null
    case 'join':
      return isStr(v.invite) && isStr(v.name) && isStr(v.sig)
        ? { t: 'join', invite: v.invite, name: v.name, sig: v.sig }
        : null
    case 'welcome': {
      if (!isStr(v.peer) || !isStr(v.name) || !isStr(v.hub)) return null
      const f: Frame = { t: 'welcome', peer: v.peer, name: v.name, hub: v.hub }
      const files = hubFiles(v.files)
      if (files) f.files = files
      return f
    }
    case 'roster':
      return Array.isArray(v.peers) && v.peers.every(isRosterPeer)
        ? { t: 'roster', peers: v.peers.map(rosterPeer) }
        : null
    case 'presence':
      if (!isStr(v.peer) || typeof v.online !== 'boolean' || typeof v.at !== 'number') return null
      return withBox(withCaps({ t: 'presence' as const, peer: v.peer, online: v.online, at: v.at }, v.caps), v.box)
    case 'send':
    case 'deliver':
      return isRecord(v.env) ? { t: v.t, env: v.env as unknown as Envelope } : null
    case 'state': {
      if (!isStr(v.id) || !DELIVERY_STATES.some(s => s === v.state) || typeof v.at !== 'number') return null
      const f: Frame = { t: 'state', id: v.id, state: v.state as DeliveryState, at: v.at }
      if (isRecord(v.ack) && isStr(v.ack.by) && isStr(v.ack.ts) && isStr(v.ack.sig))
        f.ack = { by: v.ack.by, ts: v.ack.ts, sig: v.ack.sig }
      return f
    }
    case 'ack':
      return isStr(v.id) && isStr(v.ts) && isStr(v.sig) ? { t: 'ack', id: v.id, ts: v.ts, sig: v.sig } : null
    case 'error': {
      if (!isStr(v.message) || !ERROR_CODES.some(c => c === v.code)) return null
      const f: Frame = { t: 'error', code: v.code as ErrorCode, message: v.message }
      if (isStr(v.id)) f.id = v.id
      return f
    }
    case 'ping':
    case 'pong':
      return { t: v.t }
    case 'blob_open':
      return isMessageId(v.id) &&
        isCount(v.size) &&
        isHash(v.hash) &&
        Array.isArray(v.to) &&
        v.to.every(isPeerId) &&
        typeof v.ttl_s === 'number' &&
        Number.isFinite(v.ttl_s)
        ? { t: 'blob_open', id: v.id, size: v.size, hash: v.hash, to: [...v.to], ttl_s: v.ttl_s }
        : null
    case 'blob_have':
      return isMessageId(v.id) && isCount(v.have) ? { t: 'blob_have', id: v.id, have: v.have } : null
    case 'blob_put':
    case 'blob_data':
      return isMessageId(v.id) && isCount(v.at) && isChunk(v.data) ? { t: v.t, id: v.id, at: v.at, data: v.data } : null
    case 'blob_get':
      return isMessageId(v.id) && isCount(v.at) ? { t: 'blob_get', id: v.id, at: v.at } : null
    case 'blob_ready':
    case 'blob_done':
      return isMessageId(v.id) ? { t: v.t, id: v.id } : null
    default:
      return null
  }
}

/** A chunk of a blob as a frame carries it: base64url of 1 to BLOB_CHUNK bytes (decoded by the reader). */
const isChunk = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && v.length <= Math.ceil((BLOB_CHUNK * 4) / 3) && /^[A-Za-z0-9_-]+$/.test(v)

/** A hub's file limits from its welcome (#371), or undefined. */
function hubFiles(v: unknown): HubFiles | undefined {
  return isRecord(v) && isCount(v.max) && isCount(v.quota) && v.max > 0 ? { max: v.max, quota: v.quota } : undefined
}

/** A box claim's shape (#371): a 32-byte key and a signature; whether it verifies is the reader's check. */
const boxClaim = (v: unknown): BoxClaim | undefined =>
  isRecord(v) && unb64u(v.key)?.length === 32 && isSig(v.sig) ? { key: v.key as string, sig: v.sig } : undefined

/** `o` with `box` when `raw` has a box claim's shape; without the key otherwise. */
function withBox<T extends object>(o: T, raw: unknown): T & { box?: BoxClaim } {
  const box = boxClaim(raw)
  return box ? { ...o, box } : o
}

const isRosterPeer = (v: unknown): v is RosterPeer =>
  isRecord(v) &&
  isPeerId(v.peer) &&
  isStr(v.name) &&
  typeof v.online === 'boolean' &&
  (v.last_seen === null || typeof v.last_seen === 'number')

/** A roster entry as kept: its known fields, caps only when they read as caps (#216), a box of a box's shape (#371). */
const rosterPeer = (p: RosterPeer): RosterPeer =>
  withBox(withCaps({ peer: p.peer, name: p.name, online: p.online, last_seen: p.last_seen }, p.caps), p.box)

/** `o` with `caps` when `raw` reads as caps; without the key otherwise. */
function withCaps<T extends object>(o: T, raw: unknown): T & { caps?: string[] } {
  const caps = cleanCaps(raw)
  return caps ? { ...o, caps } : o
}

// ---- Keys and signatures (WebCrypto Ed25519)

export interface KeyPair {
  /** PKCS#8, base64url. */
  pkcs8: string
  /** The raw 32-byte public key, base64url: the peer id. */
  pub: string
}

export const peerIdOf = (raw: Uint8Array): string => b64u(raw)

/** sha256 of the raw public key, the first 16 bytes as hex in groups of four. */
export function fingerprint(peer: string): string {
  const raw = unb64u(peer)
  if (!raw) return ''
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, 32)
  return hex.match(/.{4}/g)?.join(' ') ?? ''
}

export async function generateKey(): Promise<KeyPair> {
  const k = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey))
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
  return { pkcs8: b64u(pkcs8), pub: peerIdOf(pub) }
}

/** Signs bytes with a PKCS#8 key (base64url); the signature is base64url, 86 characters. */
export async function sign(pkcs8: string, bytes: Uint8Array): Promise<string> {
  const der = unb64u(pkcs8)
  if (!der) throw new TypeError('sign: the key is no base64url')
  const key = await crypto.subtle.importKey('pkcs8', der as BufferSource, 'Ed25519', false, ['sign'])
  return b64u(new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes as BufferSource)))
}

/** Whether `sig` is `peer`'s signature over the bytes; false for anything malformed. */
export async function verify(peer: string, bytes: Uint8Array, sig: string): Promise<boolean> {
  const raw = unb64u(peer)
  const s = unb64u(sig)
  if (!raw || !s || raw.length !== 32 || s.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'Ed25519', false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, s as BufferSource, bytes as BufferSource)
  } catch {
    return false
  }
}
