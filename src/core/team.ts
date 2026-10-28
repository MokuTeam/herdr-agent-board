// The peer network (#231), its pure rules: config.json's `team`, the canonical form of what is
// signed, the envelopes and frames of the wire protocol v1, and the Ed25519 signatures over them.
// The board (services/team-hub.ts) and the hub (hub/) both import this file, so there is one
// canonical form and one set of limits.
//
// config.json's `team` turns it on; a setup without it sees nothing of this anywhere:
//   "team": { "hub": "ws://100.64.0.7:7443", "name": "anna" }
// Only an object with a ws:// or wss:// hub counts.
import { createHash } from 'node:crypto'
import {
  DELIVERY_STATES,
  type DeliveryState,
  type Envelope,
  ERROR_CODES,
  type ErrorCode,
  type Frame,
  KINDS,
  MAX_ENVELOPE_BYTES,
  MAX_NAME,
  MAX_TEXT,
  type RosterPeer,
  TEAM_PROTOCOL,
} from './team-wire.ts'

export * from './team-wire.ts'

export interface TeamConfig {
  hub: string
  name: string | null
}

/** config.json's `team` as the board uses it, or null while it is not on. */
export function teamConfig(raw: unknown): TeamConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.hub !== 'string') return null
  let url: URL
  try {
    url = new URL(r.hub)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  const name = typeof r.name === 'string' && validName(r.name) ? r.name : null
  return { hub: r.hub, name }
}

/** Controls (C0, DEL, C1), line and paragraph separators, and the bidi controls that reorder what is around them. */
const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu

export const validName = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= MAX_NAME && !new RegExp(UNPRINTABLE).test(v)

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

// ---- Canonical form

/**
 * The canonical JSON of a value (RFC 8785 for this domain): object keys sorted by UTF-16 code
 * units, no whitespace, strings and finite numbers as JSON.stringify writes them. Undefined,
 * functions, non-finite numbers and the like are refused with a TypeError.
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

export type Purpose = 'auth' | 'join' | 'envelope' | 'ack'

/** What is signed: the purpose binds a signature to one use, so none works as another. */
export const signedBytes = (purpose: Purpose, obj: unknown): Uint8Array =>
  new TextEncoder().encode(`hab-team/${TEAM_PROTOCOL} ${purpose}\n${canonicalJson(obj)}`)

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

// ---- Envelopes and frames

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PEER = /^[A-Za-z0-9_-]{43}$/
const SIG = /^[A-Za-z0-9_-]{86}$/

export const isPeerId = (v: unknown): v is string => isStr(v) && PEER.test(v)
export const isSig = (v: unknown): v is string => isStr(v) && SIG.test(v)

/** An envelope's shape, or the error code for what is wrong with it. The signature is checked elsewhere. */
export function checkEnvelope(v: unknown): { ok: true; env: Envelope } | { ok: false; code: ErrorCode } {
  if (!isRecord(v)) return { ok: false, code: 'bad_frame' }
  if (v.v !== TEAM_PROTOCOL) return { ok: false, code: 'version' }
  const body = v.body
  if (
    !isStr(v.id) ||
    !UUID.test(v.id) ||
    !isPeerId(v.from) ||
    !isStr(v.to) ||
    !isStr(v.kind) ||
    !(v.reply_to === null || isStr(v.reply_to)) ||
    !isStr(v.ts) ||
    Number.isNaN(Date.parse(v.ts)) ||
    typeof v.ttl_s !== 'number' ||
    !Number.isFinite(v.ttl_s) ||
    !isRecord(body) ||
    !isStr(body.text) ||
    !isSig(v.sig)
  )
    return { ok: false, code: 'bad_frame' }
  if (!KINDS.some(k => k === v.kind)) return { ok: false, code: 'kind' }
  if (v.to === '*') return { ok: false, code: 'broadcast' }
  if (!isPeerId(v.to)) return { ok: false, code: 'bad_frame' }
  if (body.text.length < 1 || body.text.length > MAX_TEXT || Object.keys(body).length !== 1)
    return { ok: false, code: 'bad_frame' }
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_ENVELOPE_BYTES) return { ok: false, code: 'too_big' }
  if (Object.keys(v).some(k => !ENVELOPE_FIELDS.includes(k))) return { ok: false, code: 'bad_frame' }
  // Only the signed fields (and the signature) are kept: what the hub stores and relays, and the
  // board keeps, is this rebuilt envelope.
  const env: Envelope = {
    v: TEAM_PROTOCOL,
    id: v.id,
    from: v.from,
    to: v.to,
    kind: v.kind as Envelope['kind'],
    reply_to: v.reply_to,
    ts: v.ts,
    ttl_s: v.ttl_s,
    body: { text: body.text },
    sig: v.sig,
  }
  return { ok: true, env }
}

const ENVELOPE_FIELDS = ['v', 'id', 'from', 'to', 'kind', 'reply_to', 'ts', 'ttl_s', 'body', 'sig']

/** The envelope without its signature, as signed. */
export function envelopeBytes(env: Omit<Envelope, 'sig'> | Envelope): Uint8Array {
  return signedBytes('envelope', {
    v: env.v,
    id: env.id,
    from: env.from,
    to: env.to,
    kind: env.kind,
    reply_to: env.reply_to ?? null,
    ts: env.ts,
    ttl_s: env.ttl_s,
    body: env.body,
  })
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
      return typeof v.v === 'number' && isStr(v.peer) && isStr(v.client)
        ? { t: 'hello', v: v.v, peer: v.peer, client: v.client }
        : null
    case 'challenge':
      return isStr(v.hub) && isStr(v.nonce) ? { t: 'challenge', hub: v.hub, nonce: v.nonce } : null
    case 'auth':
      return isStr(v.sig) ? { t: 'auth', sig: v.sig } : null
    case 'join':
      return isStr(v.invite) && isStr(v.name) && isStr(v.sig)
        ? { t: 'join', invite: v.invite, name: v.name, sig: v.sig }
        : null
    case 'welcome':
      return isStr(v.peer) && isStr(v.name) && isStr(v.hub)
        ? { t: 'welcome', peer: v.peer, name: v.name, hub: v.hub }
        : null
    case 'roster':
      return Array.isArray(v.peers) && v.peers.every(isRosterPeer) ? { t: 'roster', peers: v.peers } : null
    case 'presence':
      return isStr(v.peer) && typeof v.online === 'boolean' && typeof v.at === 'number'
        ? { t: 'presence', peer: v.peer, online: v.online, at: v.at }
        : null
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
    default:
      return null
  }
}

const isRosterPeer = (v: unknown): v is RosterPeer =>
  isRecord(v) &&
  isPeerId(v.peer) &&
  isStr(v.name) &&
  typeof v.online === 'boolean' &&
  (v.last_seen === null || typeof v.last_seen === 'number')

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
