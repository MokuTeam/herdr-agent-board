// The peer network's wire constants and types (#231): protocol version, limits, kinds, error codes,
// the envelope, the delivery states and the frames. Nothing here imports node: or uses Buffer, so
// the page (web/src/models/team.ts) can import it without bundling a crypto shim; src/core/team.ts
// re-exports all of it.

export const TEAM_PROTOCOL = 1
/** What a message may be; anything else is dropped (and logged) by the hub and the board. */
export const KINDS = ['question'] as const
export type Kind = (typeof KINDS)[number]

/** Who asked for a message a person sent: `agent`, an agent drafted it and a person pressed Send. Signed with the body. */
export const VIAS = ['agent'] as const
export type Via = (typeof VIAS)[number]
/** Drafts an agent made that nobody has sent or discarded yet; the next one is refused. */
export const MAX_DRAFTS = 20

/**
 * What a board understands beyond protocol v1, said in `hello` and passed on by the hub in the
 * roster (#216). `threads`: topic threads, team threads and the agent's session name in the body
 * (Message.body.thread, .agent). A board sends those only to a peer whose caps say so; a peer
 * without them (an older board, or any peer while the hub is older) gets the plain body.
 * `channels` (#355): a team thread with a member list (ThreadRef.members), sent only to them; a
 * member whose board does not say so gets the post as a plain message in their pair's general.
 */
export const CAPS = ['threads', 'channels'] as const
export type Cap = (typeof CAPS)[number]
export const MAX_CAPS = 8
export const MAX_CAP = 32
/** The thread with no topic, in a pair or the team; today's flat thread with a peer is its pair's. */
export const GENERAL = 'general'
export const MAX_TITLE = 80
export const MAX_LINK = 300
/** A channel's members, its creator among them, at most (#355). */
export const MAX_MEMBERS = 32

/**
 * The thread a message belongs to (#216): `id` a UUID or GENERAL; a title for a topic; `group` for
 * the team's. `members` (#355): a channel, a team topic for these boards only (peer ids, sorted, the
 * sender's and the recipient's among them).
 */
export interface ThreadRef {
  id: string
  title?: string
  link?: string
  group?: true
  members?: string[]
}

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

/** What a sender signs: a question, as the fields of the message. It travels as the JSON text of this object. */
export interface Message {
  v: number
  id: string
  from: string
  to: string
  kind: Kind
  reply_to: string | null
  ts: string
  ttl_s: number
  /** `agent`: the sending session's name, only with `via`; `thread`: only to a peer with the `threads` cap. */
  body: { text: string; via?: Via; agent?: string; thread?: ThreadRef }
}

/**
 * A message on the wire (#217): `payload` is the JSON text of a Message exactly as its sender signed
 * it, and every hop passes it on byte for byte, never rebuilt. `sig` is the sender's signature over
 * it; `from` says whose key to check with, so the check comes before the payload is read (it must
 * be the message's own `from`).
 */
export interface Envelope {
  from: string
  payload: string
  sig: string
}

export interface Ack {
  by: string
  ts: string
  sig: string
}

export type DeliveryState = 'queued' | 'delivered' | 'acked' | 'expired'
export const DELIVERY_STATES: readonly DeliveryState[] = ['queued', 'delivered', 'acked', 'expired']

/**
 * How far a message of this board's got: the hub's states, and `refused`, which only this board
 * keeps: the hub answered the send with an error naming the message (the code is kept with it).
 * It is final; the message is not sent again.
 */
export type OutState = DeliveryState | 'refused'
export const OUT_STATES: readonly OutState[] = [...DELIVERY_STATES, 'refused']

export interface RosterPeer {
  peer: string
  name: string
  online: boolean
  last_seen: number | null
  /** What the peer's board said it understands (#216); absent from an older hub. */
  caps?: string[]
}

export type Frame =
  | { t: 'hello'; v: number; peer: string; client: string; caps?: string[] }
  | { t: 'challenge'; hub: string; nonce: string }
  | { t: 'auth'; sig: string }
  | { t: 'join'; invite: string; name: string; sig: string }
  | { t: 'welcome'; peer: string; name: string; hub: string }
  | { t: 'roster'; peers: RosterPeer[] }
  | { t: 'presence'; peer: string; online: boolean; at: number; caps?: string[] }
  | { t: 'send'; env: Envelope }
  | { t: 'deliver'; env: Envelope }
  | { t: 'state'; id: string; state: DeliveryState; at: number; ack?: Ack }
  | { t: 'ack'; id: string; ts: string; sig: string }
  | { t: 'error'; code: ErrorCode; id?: string; message: string }
  | { t: 'ping' }
  | { t: 'pong' }
