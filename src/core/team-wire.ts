// The peer network's wire constants and types (#231): protocol version, limits, kinds, error codes,
// the envelope, the delivery states and the frames. Nothing here imports node: or uses Buffer, so
// the page (web/src/models/team.ts) can import it without bundling a crypto shim; src/core/team.ts
// re-exports all of it.

export const TEAM_PROTOCOL = 1
/** What a message may be; anything else is dropped (and logged) by the hub and the board. */
export const KINDS = ['question'] as const
export type Kind = (typeof KINDS)[number]

export const MAX_ENVELOPE_BYTES = 16 * 1024
export const MAX_TEXT = 4000
export const MAX_NAME = 40
export const DEFAULT_TTL_S = 86_400
export const MIN_TTL_S = 60
export const MAX_TTL_S = 604_800

export const ERROR_CODES = [
  'version',
  'unknown_peer',
  'revoked',
  'bad_sig',
  'invite_invalid',
  'name_taken',
  'bad_frame',
  'too_big',
  'not_member',
  'dup_id',
  'kind',
  'broadcast',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface Envelope {
  v: number
  id: string
  from: string
  to: string
  kind: Kind
  reply_to: string | null
  ts: string
  ttl_s: number
  body: { text: string }
  sig: string
}

export interface Ack {
  by: string
  ts: string
  sig: string
}

export type DeliveryState = 'queued' | 'delivered' | 'acked' | 'expired'
export const DELIVERY_STATES: readonly DeliveryState[] = ['queued', 'delivered', 'acked', 'expired']

export interface RosterPeer {
  peer: string
  name: string
  online: boolean
  last_seen: number | null
}

export type Frame =
  | { t: 'hello'; v: number; peer: string; client: string }
  | { t: 'challenge'; hub: string; nonce: string }
  | { t: 'auth'; sig: string }
  | { t: 'join'; invite: string; name: string; sig: string }
  | { t: 'welcome'; peer: string; name: string; hub: string }
  | { t: 'roster'; peers: RosterPeer[] }
  | { t: 'presence'; peer: string; online: boolean; at: number }
  | { t: 'send'; env: Envelope }
  | { t: 'deliver'; env: Envelope }
  | { t: 'state'; id: string; state: DeliveryState; at: number; ack?: Ack }
  | { t: 'ack'; id: string; ts: string; sig: string }
  | { t: 'error'; code: ErrorCode; id?: string; message: string }
  | { t: 'ping' }
  | { t: 'pong' }
