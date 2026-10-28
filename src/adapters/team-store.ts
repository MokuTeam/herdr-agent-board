// What the peer network (#231) keeps on this computer, in the state folder: team-key.json (this
// board's Ed25519 key, 0600), team-inbox.json and team-outbox.json (the last 500 messages per peer),
// team-pins.json (the keys of the peers seen) and team-audit.jsonl (what happened, never a message's
// text). Nothing here creates a file until it is asked to write: `board team join` and the running
// board with `team` set are the only callers.
import { appendFileSync, mkdirSync } from 'node:fs'
import {
  type Ack,
  type DeliveryState,
  type Envelope,
  type ErrorCode,
  generateKey,
  type KeyPair,
  type OutState,
} from '../core/team.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir, teamAuditFile, teamInboxFile, teamKeyFile, teamOutboxFile, teamPinsFile } from './paths.ts'

/** Messages kept per peer, in each direction. */
export const KEEP_PER_PEER = 500
const PRIVATE = { mode: 0o600 }

// ---- The key

type KeyFile = { v: 1; pkcs8: string; pub: string }
const isKeyFile = (v: unknown): v is KeyFile =>
  isRecord(v) && v.v === 1 && typeof v.pkcs8 === 'string' && typeof v.pub === 'string'

/** This board's key, or null while there is none. Creates nothing. */
export function readKey(): KeyPair | null {
  const k = readJson(teamKeyFile(), isKeyFile)
  return k ? { pkcs8: k.pkcs8, pub: k.pub } : null
}

/**
 * This board's key; made (or `candidate`, one `board team join` made before it knew the hub would
 * take it), and saved with 0600, the first time. Two writers end with one key.
 */
export async function ensureKey(candidate?: KeyPair): Promise<KeyPair> {
  const have = readKey()
  if (have) return have
  const fresh = candidate ?? (await generateKey())
  mkdirSync(stateDir(), { recursive: true })
  const kept = updateJson(
    teamKeyFile(),
    (cur: KeyFile | null) => cur ?? { v: 1 as const, pkcs8: fresh.pkcs8, pub: fresh.pub },
    isKeyFile,
    PRIVATE,
  )
  return { pkcs8: kept.pkcs8, pub: kept.pub }
}

// ---- Messages

/** A question that came in. `held`: from a key that changed under a pinned name, until it is trusted. */
export interface InboxItem {
  id: string
  from: string
  ts: string
  text: string
  receivedAt: number
  held: boolean
  /** When the signed ack went out (null: not yet, or the hub was away). */
  ackedAt: number | null
}

/** A question that went out, and how far it got. `ack` is kept only when it verified. */
export interface OutboxItem {
  env: Envelope
  state: OutState
  at: number
  ack?: Ack
  /** refused: the hub's error code. */
  code?: ErrorCode
}

/** A map with no prototype: a key such as `__proto__` is a key like any other, never the prototype. */
function bare<T>(m: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, m)
}

type Lists<T> = { v: 1; peers: Record<string, T[]> }
const isLists = <T>(v: unknown): v is Lists<T> => isRecord(v) && v.v === 1 && isRecord(v.peers)

function readLists<T>(file: string): Record<string, T[]> {
  return bare(readJson(file, (v): v is Lists<T> => isLists<T>(v))?.peers ?? {})
}

function changeLists<T, R>(file: string, fn: (peers: Record<string, T[]>) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    file,
    (cur: Lists<T> | null) => {
      const peers = bare(cur?.peers ?? {})
      result = fn(peers)
      for (const [p, list] of Object.entries(peers))
        if (list.length > KEEP_PER_PEER) peers[p] = list.slice(-KEEP_PER_PEER)
      return { v: 1 as const, peers }
    },
    (v): v is Lists<T> => isLists<T>(v),
    PRIVATE,
  )
  return result as R
}

export const readInbox = (peer: string): InboxItem[] => readLists<InboxItem>(teamInboxFile())[peer] ?? []

/** Saves a message by its id: true when it is new, false when it was there (a redelivery changes nothing). */
export function addInbox(item: InboxItem): boolean {
  return changeLists<InboxItem, boolean>(teamInboxFile(), peers => {
    const list = peers[item.from] ?? []
    if (list.some(i => i.id === item.id)) return false
    peers[item.from] = [...list, item]
    return true
  })
}

/** Notes that the ack for `id` from `peer` went out. */
export function markAcked(peer: string, id: string, at: number): void {
  changeLists<InboxItem, void>(teamInboxFile(), peers => {
    for (const i of peers[peer] ?? []) if (i.id === id) i.ackedAt = at
  })
}

/** Lets the held messages of `peer` through; how many were held. */
export function releaseHeld(peer: string): number {
  return changeLists<InboxItem, number>(teamInboxFile(), peers => {
    let n = 0
    for (const i of peers[peer] ?? []) {
      if (!i.held) continue
      i.held = false
      n++
    }
    return n
  })
}

export const readOutbox = (peer: string): OutboxItem[] => readLists<OutboxItem>(teamOutboxFile())[peer] ?? []
export const readAllOutbox = (): Record<string, OutboxItem[]> => readLists<OutboxItem>(teamOutboxFile())

/** Saves a message that goes out (once per id). */
export function addOutbox(item: OutboxItem): void {
  changeLists<OutboxItem, void>(teamOutboxFile(), peers => {
    const list = peers[item.env.to] ?? []
    if (!list.some(i => i.env.id === item.env.id)) peers[item.env.to] = [...list, item]
  })
}

const RANK: Record<OutState, number> = { queued: 0, delivered: 1, acked: 2, expired: 2, refused: 2 }

/** What the hub says of an outgoing message; a state never goes back (acked, expired and refused are final). */
export function setOutState(id: string, state: DeliveryState, at: number, ack?: Ack): void {
  const rank = RANK
  changeLists<OutboxItem, void>(teamOutboxFile(), peers => {
    for (const list of Object.values(peers))
      for (const i of list)
        if (i.env.id === id && rank[state] > rank[i.state]) {
          i.state = state
          i.at = at
          if (ack) i.ack = ack
        }
  })
}

/** The hub refused the message `id` (an error naming it) while it was still queued: final, never sent again. */
export function refuseOut(id: string, code: ErrorCode, at: number): boolean {
  return changeLists<OutboxItem, boolean>(teamOutboxFile(), peers => {
    let hit = false
    for (const list of Object.values(peers))
      for (const i of list)
        if (i.env.id === id && i.state === 'queued') {
          i.state = 'refused'
          i.code = code
          i.at = at
          hit = true
        }
    return hit
  })
}

// ---- Pins

/** A peer's key as first seen (trusted) or as it appeared under a name already pinned (changed). */
export interface Pin {
  name: string
  status: 'trusted' | 'changed'
  at: number
}
type PinsFile = { v: 1; pins: Record<string, Pin> }
const isPins = (v: unknown): v is PinsFile => isRecord(v) && v.v === 1 && isRecord(v.pins)

export const readPins = (): Record<string, Pin> => bare(readJson(teamPinsFile(), isPins)?.pins ?? {})

/** Changes the pins under their lock: `fn` edits the map in place. */
export function changePins<R>(fn: (pins: Record<string, Pin>) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamPinsFile(),
    (cur: PinsFile | null) => {
      const pins = bare(cur?.pins ?? {})
      result = fn(pins)
      return { v: 1 as const, pins }
    },
    isPins,
    PRIVATE,
  )
  return result as R
}

// ---- The log

/** One line of what happened: a kind of event, the peer, short facts. Never a message's text. */
export function audit(
  action: string,
  peer: string | null,
  detail: Record<string, string | number | boolean> = {},
): void {
  mkdirSync(stateDir(), { recursive: true })
  appendFileSync(teamAuditFile(), `${JSON.stringify({ at: Date.now(), action, peer, ...detail })}\n`, PRIVATE)
}
