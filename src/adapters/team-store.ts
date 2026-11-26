// What the peer network (#231) keeps on this computer, in the state folder: team-key.json (this
// board's Ed25519 key, 0600), team-inbox.json and team-outbox.json (the last 500 messages per peer),
// team-pins.json (the keys of the peers seen) and team-audit.jsonl (what happened, never a message's
// text). Files (#371): team-box.json (this board's X25519 key, 0600), team-blobs.json (the blobs it
// sends and how far each got) and team-files/ (their sealed bytes until the hub has them, and the
// copies of files left in drafts). Nothing here creates a file until it is asked to write: `board
// team join` and the running board with `team` set are the only callers.
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type Ack,
  compareMessageTime,
  type DeliveryState,
  type Envelope,
  type ErrorCode,
  type FileRef,
  GENERAL,
  generateKey,
  isMessageId,
  type KeyPair,
  type Message,
  type OutState,
  type ReactionOp,
  type Via,
  type WorkPost,
} from '../core/team.ts'
import { type BoxKeyPair, generateBoxKey } from '../core/team-box.ts'
import { readDirectory, validAlias, validCode } from '../core/team-directory.ts'
import type { DirectoryEntry } from '../core/team-wire.ts'
import type { Alg } from '../core/webauthn.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import {
  stateDir,
  teamAgentsFile,
  teamAuditFile,
  teamBlobsFile,
  teamBoxFile,
  teamDirectoryFile,
  teamDraftsFile,
  teamFilesDir,
  teamInboxFile,
  teamKeyFile,
  teamOutboxFile,
  teamPasskeysFile,
  teamPinsFile,
  teamReactionsFile,
  teamThreadsFile,
} from './paths.ts'

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

/**
 * Keeps the key `board team join` joined the hub with. When another key was saved meanwhile (two
 * joins, or the board's first start, raced) that one stays and this throws: the hub knows the
 * joined key, not the saved one, and nothing may claim otherwise (config.json is not written).
 */
export async function keepJoinedKey(joined: KeyPair): Promise<void> {
  const kept = await ensureKey(joined)
  if (kept.pub !== joined.pub)
    throw new Error(
      'another key was saved for this board while joining, so the hub knows a key this board does not use; config.json was not changed. Ask for a new invite and run `board team join` again',
    )
}

/**
 * Takes back a key `board team join` saved before its join went out, once the hub has settled that
 * the join did not land (#356). Only that very key: a key saved by anything else stays.
 */
export function forgetKey(pub: string): void {
  if (readKey()?.pub !== pub) return
  try {
    unlinkSync(teamKeyFile())
  } catch {}
}

// ---- The box key (#371)

/** This board's box key, or null while there is none. Creates nothing. */
export function readBoxKey(): BoxKeyPair | null {
  const k = readJson(teamBoxFile(), isKeyFile)
  return k ? { pkcs8: k.pkcs8, pub: k.pub } : null
}

/** This board's box key; made and saved with 0600 the first time. Two writers end with one key. */
export async function ensureBoxKey(): Promise<BoxKeyPair> {
  const have = readBoxKey()
  if (have) return have
  const fresh = await generateBoxKey()
  mkdirSync(stateDir(), { recursive: true })
  const kept = updateJson(
    teamBoxFile(),
    (cur: KeyFile | null) => cur ?? { v: 1 as const, pkcs8: fresh.pkcs8, pub: fresh.pub },
    isKeyFile,
    PRIVATE,
  )
  return { pkcs8: kept.pkcs8, pub: kept.pub }
}

// ---- Messages

/**
 * A file that came in (#371): `ref` as signed until it is fetched; then where it was saved, under
 * its name as the sender's board sealed it. `failed`: the hub had it no more, or it did not open.
 */
export interface InFile {
  state: 'pending' | 'ready' | 'failed'
  ref?: FileRef
  name?: string
  type?: string
  size?: number
  /** ready: the board's address for it, and the path on this computer. */
  url?: string
  path?: string
  /** failed: why (a hub code, `hash`, `key`, `data`, `big`). */
  why?: string
}

/** A file that went out (#371): what this board sealed, and its own copy to show. */
export interface OutFile {
  blob: string
  name: string
  type: string
  size: number
  url?: string
}

/** A question that came in. `held`: from a key that changed under a pinned name, until it is trusted. */
export interface InboxItem {
  id: string
  from: string
  ts: string
  text: string
  receivedAt: number
  held: boolean
  /** The envelope carried the agent mark: the draft came from `board team draft`. */
  via?: Via
  /** With via: the sending session's name, as the sender's board wrote it (#216). */
  agent?: string
  /** The thread's key (#216, threadKey); absent on what came before threads: that pair's general. */
  thread?: string
  /** The id of the message it answers (#370), as the sender's board wrote it: a message's or a team post's. */
  replyTo?: string
  /** A team post's copy (#370): the post's id, the same on every member's copy. */
  post?: string
  /**
   * The handle of this board's agent the copy named (#832), as the sender wrote it: kept so that
   * agent's answer in the team chat or a channel is weighed by the sender's switches (#875).
   */
  at?: string
  /** When the signed ack went out (null: not yet, or the hub was away). */
  ackedAt: number | null
  /** A file in it (#371). */
  file?: InFile
}

/**
 * A question that went out, and how far it got. `env` is what is sent (again, on every reconnect)
 * and is never rebuilt; `msg` is the same message read, for the thread. `ack` is kept only when it verified.
 */
export interface OutboxItem {
  env: Envelope
  msg: Message
  state: OutState
  at: number
  ack?: Ack
  /** refused: the hub's error code. */
  code?: ErrorCode
  /** The thread's key (#216); absent on what went before threads: that pair's general. */
  thread?: string
  /** A team post goes as one copy per member; every copy keeps the first copy's id here (#216). */
  post?: string
  /** Who sent it here: a session through `board team post` (agent), or the Team panel (ui) (#216). */
  by?: 'ui' | 'agent'
  /** by agent: the session, as the board resolved it (with --session, the caller's own word). */
  session?: SessionRef
  /** An agent's draft the owner sent: a person's step, outside the agents' limits and loop count. */
  pressed?: boolean
  /** The post's text where this copy's differs (an older board's gets the title in front). */
  text?: string
  /**
   * The message it answers (#370), on every copy, as the wire names it (a message's id, or a team
   * post's): kept here too, since a copy to a board without `replies` goes without it.
   */
  replyTo?: string
  /** A file in the post (#371); its blob goes up before this copy is sent. */
  file?: OutFile
}

/** A session on this board, as the team keeps it (#216). */
export interface SessionRef {
  key: string
  name?: string
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
export const readAllInbox = (): Record<string, InboxItem[]> => readLists<InboxItem>(teamInboxFile())

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

/** Changes the file of a message that came in (#371); false when there is no such message with a file. */
export function setInFile(peer: string, id: string, file: InFile): boolean {
  return changeLists<InboxItem, boolean>(teamInboxFile(), peers => {
    const i = (peers[peer] ?? []).find(x => x.id === id)
    if (!i?.file) return false
    i.file = file
    return true
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
    const list = peers[item.msg.to] ?? []
    if (!list.some(i => i.msg.id === item.msg.id)) peers[item.msg.to] = [...list, item]
  })
}

const RANK: Record<OutState, number> = { queued: 0, delivered: 1, acked: 2, expired: 2, refused: 2 }

/** What the hub says of an outgoing message; a state never goes back (acked, expired and refused are final). */
export function setOutState(id: string, state: DeliveryState, at: number, ack?: Ack): void {
  const rank = RANK
  changeLists<OutboxItem, void>(teamOutboxFile(), peers => {
    for (const list of Object.values(peers))
      for (const i of list)
        if (i.msg.id === id && rank[state] > rank[i.state]) {
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
        if (i.msg.id === id && i.state === 'queued') {
          i.state = 'refused'
          i.code = code
          i.at = at
          hit = true
        }
    return hit
  })
}

/** Removes all inbox messages of `thread`, returning how many went. Creates or writes nothing when none match. */
export function dropThreadInbox(thread: string): number {
  if (!Object.values(readAllInbox()).some(list => list.some(i => i.thread === thread))) return 0
  return changeLists<InboxItem, number>(teamInboxFile(), peers => {
    let n = 0
    for (const [p, list] of Object.entries(peers)) {
      const kept = list.filter(i => i.thread !== thread)
      n += list.length - kept.length
      if (kept.length) peers[p] = kept
      else delete peers[p]
    }
    return n
  })
}

/** Removes all outbox items of `thread`, returning how many went. Creates or writes nothing when none match. */
export function dropThreadOutbox(thread: string): number {
  if (!Object.values(readAllOutbox()).some(list => list.some(o => o.thread === thread))) return 0
  return changeLists<OutboxItem, number>(teamOutboxFile(), peers => {
    let n = 0
    for (const [p, list] of Object.entries(peers)) {
      const kept = list.filter(o => o.thread !== thread)
      n += list.length - kept.length
      if (kept.length) peers[p] = kept
      else delete peers[p]
    }
    return n
  })
}

// ---- Reactions (#687)

/** One reactor's latest state on a message in a thread (`by` is `'me'` or a peer id). */
export interface ReactionEntry {
  thread: string
  /** Wire message id (a pair message id, or a team post id). */
  target: string
  by: string
  emoji: string
  op: ReactionOp
  ts: string
  id: string
  held?: boolean
}

/** An outgoing reaction copy waiting to be delivered/acked through the hub. */
export interface ReactionOutboxItem {
  env: Envelope
  id: string
  to: string
  state: OutState
  at: number
  code?: ErrorCode
}

export const KEEP_REACTION_ENTRIES = 5000
export const KEEP_REACTION_OUTBOX = 500

type ReactionsFile = { v: 1; entries: ReactionEntry[]; outbox: ReactionOutboxItem[] }
const isReactions = (v: unknown): v is ReactionsFile =>
  isRecord(v) && v.v === 1 && Array.isArray(v.entries) && Array.isArray(v.outbox)

const readReactionsFile = (): ReactionsFile | null => readJson(teamReactionsFile(), isReactions)

/** Reaction entries kept on this board. Creates nothing. */
export const readReactions = (): ReactionEntry[] => readReactionsFile()?.entries ?? []

/** Outgoing reaction copies kept on this board. Creates nothing. */
export const readReactionOutbox = (): ReactionOutboxItem[] => readReactionsFile()?.outbox ?? []

function changeReactions<R>(fn: (file: ReactionsFile) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamReactionsFile(),
    (cur: ReactionsFile | null) => {
      const f: ReactionsFile = cur
        ? { v: 1, entries: [...cur.entries], outbox: [...cur.outbox] }
        : { v: 1, entries: [], outbox: [] }
      result = fn(f)
      if (f.entries.length > KEEP_REACTION_ENTRIES) {
        // Prune oldest removed entries first, then oldest remaining entries.
        const excess = f.entries.length - KEEP_REACTION_ENTRIES
        const removes = f.entries
          .map((e, i) => ({ e, i }))
          .filter(x => x.e.op === 'remove')
          .sort((a, b) => compareMessageTime({ ts: a.e.ts, id: a.e.id }, { ts: b.e.ts, id: b.e.id }))
        const drop = new Set(removes.slice(0, excess).map(x => x.i))
        if (drop.size < excess) {
          const rest = f.entries
            .map((e, i) => ({ e, i }))
            .filter(x => !drop.has(x.i))
            .sort((a, b) => compareMessageTime({ ts: a.e.ts, id: a.e.id }, { ts: b.e.ts, id: b.e.id }))
          for (const x of rest.slice(0, excess - drop.size)) drop.add(x.i)
        }
        f.entries = f.entries.filter((_, i) => !drop.has(i))
      }
      if (f.outbox.length > KEEP_REACTION_OUTBOX) {
        const settled = f.outbox
          .map((o, i) => ({ o, i }))
          .filter(x => x.o.state !== 'queued' && x.o.state !== 'delivered')
          .sort((a, b) => a.o.at - b.o.at)
        const excess = f.outbox.length - KEEP_REACTION_OUTBOX
        const drop = new Set(settled.slice(0, excess).map(x => x.i))
        f.outbox = f.outbox.filter((_, i) => !drop.has(i))
      }
      return f
    },
    isReactions,
    PRIVATE,
  )
  return result as R
}

/**
 * Applies a reaction entry using LWW convergence on `(ts, id)`.
 * Returns whether the entry won (`applied`) and whether the visible active state flipped (`changed`).
 */
export function applyReaction(entry: ReactionEntry): { applied: boolean; changed: boolean } {
  return changeReactions(f => {
    const idx = f.entries.findIndex(
      e => e.thread === entry.thread && e.target === entry.target && e.by === entry.by && e.emoji === entry.emoji,
    )
    const existing = idx >= 0 ? f.entries[idx] : undefined
    if (existing && compareMessageTime({ ts: entry.ts, id: entry.id }, { ts: existing.ts, id: existing.id }) <= 0)
      return { applied: false, changed: false }
    const wasActive = existing?.op === 'add' && !existing.held
    const nowActive = entry.op === 'add' && !entry.held
    if (idx >= 0) f.entries[idx] = entry
    else f.entries.push(entry)
    return { applied: true, changed: wasActive !== nowActive }
  })
}

/** Saves outgoing reaction copies (once per id). */
export function addReactionOutbox(items: ReactionOutboxItem[]): void {
  if (!items.length) return
  changeReactions(f => {
    const ids = new Set(f.outbox.map(o => o.id))
    for (const item of items) {
      if (ids.has(item.id)) continue
      ids.add(item.id)
      f.outbox.push(item)
    }
  })
}

/** Updates an outgoing reaction copy's delivery state; false when no such reaction copy exists (writes nothing). */
export function setReactionOutState(id: string, state: DeliveryState, at: number): boolean {
  if (!readReactionOutbox().some(i => i.id === id)) return false
  return changeReactions(f => {
    let hit = false
    for (const i of f.outbox)
      if (i.id === id && RANK[state] > RANK[i.state]) {
        i.state = state
        i.at = at
        hit = true
      }
    return hit
  })
}

/** Refuses an outgoing reaction copy; false when no queued reaction copy matches (writes nothing). */
export function refuseReactionOut(id: string, code: ErrorCode, at: number): boolean {
  if (!readReactionOutbox().some(i => i.id === id && i.state === 'queued')) return false
  return changeReactions(f => {
    let hit = false
    for (const i of f.outbox)
      if (i.id === id && i.state === 'queued') {
        i.state = 'refused'
        i.code = code
        i.at = at
        hit = true
      }
    return hit
  })
}

/** Releases held reactions from `peer` once their key is trusted; writes nothing when none are held. */
export function releaseHeldReactions(peer: string): number {
  if (!readReactions().some(e => e.by === peer && e.held === true)) return 0
  return changeReactions(f => {
    let n = 0
    for (const e of f.entries) {
      if (e.by === peer && e.held) {
        delete e.held
        n++
      }
    }
    return n
  })
}

/** Removes all reactions on `thread`, returning how many went. Creates or writes nothing when none match. */
export function dropThreadReactions(thread: string): number {
  if (!readReactions().some(e => e.thread === thread)) return 0
  return changeReactions(f => {
    const before = f.entries.length
    f.entries = f.entries.filter(e => e.thread !== thread)
    return before - f.entries.length
  })
}

// ---- Drafts

/** What an agent drafted for a person to send; nothing leaves the board until the person presses Send. */
export interface Draft {
  id: string
  /** A peer id, or `team` for a team thread (#216). */
  to: string
  text: string
  createdAt: number
  /** Where it goes (#216): an existing thread's id, or a new one's title and link. Absent: general. */
  thread?: { id?: string; title?: string; link?: string }
  /** Why the board held it instead of sending it (#216): off, lane, lane_name, secret, loop. */
  reason?: string
  /** The session that wrote it. */
  session?: SessionRef
  /** The line of its thread it answers (#373), as `board team reply --to` named it. */
  replyTo?: string
  /** A file the agent attached (#371): the board's own copy, taken when the draft was made. */
  file?: DraftFile
  /** A shared thread's entry (#394): its id (the message's when sent) and its `work`. */
  work?: WorkPost
}
export interface DraftFile {
  path: string
  name: string
  size: number
}
type DraftsFile = { v: 1; drafts: Record<string, Draft> }
const isDrafts = (v: unknown): v is DraftsFile => isRecord(v) && v.v === 1 && isRecord(v.drafts)

/** The drafts, oldest first. Creates nothing. */
export const readDrafts = (): Draft[] =>
  Object.values(bare(readJson(teamDraftsFile(), isDrafts)?.drafts ?? {})).sort((a, b) => a.createdAt - b.createdAt)

function changeDrafts<R>(fn: (drafts: Record<string, Draft>) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamDraftsFile(),
    (cur: DraftsFile | null) => {
      const drafts = bare(cur?.drafts ?? {})
      result = fn(drafts)
      return { v: 1 as const, drafts }
    },
    isDrafts,
    PRIVATE,
  )
  return result as R
}

/** Keeps a draft; false when `max` are waiting already (the file is not written then). */
export const addDraft = (draft: Draft, max: number): boolean =>
  changeDrafts(drafts => {
    if (Object.keys(drafts).length >= max) return false
    drafts[draft.id] = draft
    return true
  })

/** Removes a draft and gives it back, null when there is none (a second Send finds nothing). */
export const takeDraft = (id: string): Draft | null =>
  changeDrafts(drafts => {
    const d = Object.hasOwn(drafts, id) ? drafts[id] : undefined
    delete drafts[id]
    return d ?? null
  })

/** Removes all held drafts (and their attached draft files) for `thread`, returning how many went. */
export function dropThreadDrafts(thread: string): number {
  const matches = (d: Draft): boolean => `${d.to}/${d.thread?.id ?? GENERAL}` === thread
  if (!readDrafts().some(matches)) return 0
  const dropped = changeDrafts(drafts => {
    const removed: Draft[] = []
    for (const [id, d] of Object.entries(drafts)) {
      if (!matches(d)) continue
      removed.push(d)
      delete drafts[id]
    }
    return removed
  })
  for (const d of dropped) if (d.file) dropDraftFile(d.file.path)
  return dropped.length
}

// ---- Threads (#216)

/** An archived channel (#854): deleted by its creator; read-only here and kept out of the active list unless restored. */
export interface ChannelArchive {
  at: number
  by: string
  restored?: boolean
}

/** An outgoing signed channel notice (#854) waiting to be delivered/acked through the hub. */
export interface ChannelNoticeOutboxItem {
  env: Envelope
  id: string
  to: string
  state: OutState
  at: number
  code?: ErrorCode
}

export const KEEP_CHANNEL_NOTICES = 200

/** A thread as this board keeps it: in a pair (scope: the peer's id) or the team (scope: `team`). */
export interface ThreadRecord {
  scope: string
  /** A UUID, or `general` for the thread with no topic. */
  id: string
  title: string | null
  link: string | null
  /** The session that gets notices of new messages in it; null: the listener's. */
  handler: SessionRef | null
  muted: boolean
  /** `me`, or the peer that started it. */
  by: string
  createdAt: number
  lastAt: number
  /**
   * A channel (#355): a team thread for these boards only (peer ids, this board's among them),
   * sent to them alone. Absent: the whole team's.
   */
  members?: string[]
  /** Deleted by its creator (#854): kept locally as read-only archive until removed or restored. */
  archived?: ChannelArchive
}
type ThreadsFile = { v: 1; threads: Record<string, ThreadRecord>; notices?: ChannelNoticeOutboxItem[] }
const isThreads = (v: unknown): v is ThreadsFile =>
  isRecord(v) && v.v === 1 && isRecord(v.threads) && (v.notices === undefined || Array.isArray(v.notices))

/** Every thread by its key. Creates nothing. */
export const readThreads = (): Record<string, ThreadRecord> =>
  bare(readJson(teamThreadsFile(), isThreads)?.threads ?? {})

/** Changes the threads under their lock: `fn` edits the map in place. */
export function changeThreads<R>(fn: (threads: Record<string, ThreadRecord>) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamThreadsFile(),
    (cur: ThreadsFile | null) => {
      const threads = bare(cur?.threads ?? {})
      result = fn(threads)
      return {
        v: 1 as const,
        threads,
        ...(cur?.notices?.length && { notices: cur.notices }),
      }
    },
    isThreads,
    PRIVATE,
  )
  return result as R
}

/** Outgoing channel notices kept on this board (#854). Creates nothing. */
export const readChannelNotices = (): ChannelNoticeOutboxItem[] => readJson(teamThreadsFile(), isThreads)?.notices ?? []

function changeChannelNotices<R>(fn: (notices: ChannelNoticeOutboxItem[]) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamThreadsFile(),
    (cur: ThreadsFile | null) => {
      const threads = bare(cur?.threads ?? {})
      const notices = [...(cur?.notices ?? [])]
      result = fn(notices)
      if (notices.length > KEEP_CHANNEL_NOTICES) {
        const settled = notices
          .map((n, i) => ({ n, i }))
          .filter(x => x.n.state !== 'queued' && x.n.state !== 'delivered')
          .sort((a, b) => a.n.at - b.n.at)
        const excess = notices.length - KEEP_CHANNEL_NOTICES
        const drop = new Set(settled.slice(0, excess).map(x => x.i))
        const trimmed = notices.filter((_, i) => !drop.has(i))
        return { v: 1 as const, threads, ...(trimmed.length && { notices: trimmed }) }
      }
      return { v: 1 as const, threads, ...(notices.length && { notices }) }
    },
    isThreads,
    PRIVATE,
  )
  return result as R
}

/** Saves outgoing signed channel notices (once per id). */
export function addChannelNotices(items: ChannelNoticeOutboxItem[]): void {
  if (!items.length) return
  changeChannelNotices(notices => {
    const ids = new Set(notices.map(n => n.id))
    for (const item of items) {
      if (ids.has(item.id)) continue
      ids.add(item.id)
      notices.push(item)
    }
  })
}

/** Updates an outgoing channel notice's delivery state; false when no such notice exists (writes nothing). */
export function setChannelNoticeState(id: string, state: DeliveryState, at: number): boolean {
  if (!readChannelNotices().some(n => n.id === id)) return false
  return changeChannelNotices(notices => {
    let hit = false
    for (const n of notices)
      if (n.id === id && RANK[state] > RANK[n.state]) {
        n.state = state
        n.at = at
        hit = true
      }
    return hit
  })
}

/** Refuses an outgoing channel notice; false when no queued notice matches (writes nothing). */
export function refuseChannelNotice(id: string, code: ErrorCode, at: number): boolean {
  if (!readChannelNotices().some(n => n.id === id && n.state === 'queued')) return false
  return changeChannelNotices(notices => {
    let hit = false
    for (const n of notices)
      if (n.id === id && n.state === 'queued') {
        n.state = 'refused'
        n.code = code
        n.at = at
        hit = true
      }
    return hit
  })
}

// ---- What agents may do (#216)

/**
 * One peer's (or the team's) switches: agents talk with it, the lanes it may hear about, muted (the
 * team), and its own loop pause (#360: agent messages in a row before the next waits for the owner;
 * the board's default while unset). `allLanes` (#386): every lane is shared with it, also lanes
 * added later; only exactly `true` counts (core/team-agents.ts allLanes), and without it `lanes`
 * means what it always did.
 */
export interface PeerAgents {
  on: boolean
  lanes: string[]
  allLanes?: true
  muted?: boolean
  loop?: number
}
export interface AgentSettings {
  /** Limit direct peer addressing to marked masters (#867). Absent on existing boards. */
  mastersOnly?: true
  /** The owner's global off: overrides every peer. */
  off: boolean
  /** The session that gets notices of new threads and of threads nobody handles. */
  listener: SessionRef | null
  peers: Record<string, PeerAgents>
  /** Routing paused for a peer until then (too many agent messages in an hour). */
  paused: Record<string, number>
}
type AgentsFile = { v: 1 } & AgentSettings
const isAgents = (v: unknown): v is AgentsFile => isRecord(v) && v.v === 1 && isRecord(v.peers)

const freshAgents = (): AgentSettings => ({ off: false, listener: null, peers: bare({}), paused: bare({}) })

/** The settings; everything off while there is no file. Creates nothing. */
export function readAgents(): AgentSettings {
  const f = readJson(teamAgentsFile(), isAgents)
  return f ? readAgentsFrom(f) : freshAgents()
}

/** Changes the settings under their lock: `fn` edits them in place. */
export function changeAgents<R>(fn: (s: AgentSettings) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamAgentsFile(),
    (cur: AgentsFile | null) => {
      const s = cur ? readAgentsFrom(cur) : freshAgents()
      result = fn(s)
      return { v: 1 as const, ...s }
    },
    isAgents,
    PRIVATE,
  )
  return result as R
}

function readAgentsFrom(f: AgentsFile): AgentSettings {
  return {
    off: f.off === true,
    ...(f.mastersOnly === true && { mastersOnly: true }),
    listener: isRecord(f.listener) && typeof f.listener.key === 'string' ? f.listener : null,
    peers: bare(f.peers),
    paused: bare(isRecord(f.paused) ? (f.paused as Record<string, number>) : {}),
  }
}

// ---- Agent directories (#832)

/**
 * What went to a peer last: the list, its mark (core/team-directory.ts), the message, how far it
 * got (`sent`: no word from the hub yet; `queued`: the hub has it; `acked`: the peer's board
 * took it; `expired`: it never did), when, and how many in a row expired unread.
 */
export interface DirectorySent {
  mark: string
  list: DirectoryEntry[]
  id: string
  state: 'sent' | 'queued' | 'acked' | 'expired'
  at: number
  misses: number
}
/** A peer's directory as it came: its list, and the time and id of the message that brought it. */
export interface DirectoryGot {
  list: DirectoryEntry[]
  ts: string
  id: string
}
export interface DirectoryState {
  sent: Record<string, DirectorySent>
  got: Record<string, DirectoryGot>
  /** This board's handles, by session key: kept, so an address stays the session's. */
  handles: Record<string, string>
  aliases: Record<string, string>
}
type DirectoryFile = { v: 1 } & Partial<DirectoryState>
const isDirectoryFile = (v: unknown): v is DirectoryFile => isRecord(v) && v.v === 1
const SENT_STATES: readonly DirectorySent['state'][] = ['sent', 'queued', 'acked', 'expired']

function directoryFrom(f: DirectoryFile | null): DirectoryState {
  const sent = bare<DirectorySent>({})
  const got = bare<DirectoryGot>({})
  const handles = bare<string>({})
  const aliases = bare<string>({})
  for (const [peer, s] of Object.entries(isRecord(f?.sent) ? f.sent : {})) {
    const list = isRecord(s) ? readDirectory(s.list, true) : null
    if (!list || !isRecord(s) || typeof s.mark !== 'string' || typeof s.id !== 'string') continue
    const state = SENT_STATES.find(x => x === s.state) ?? 'sent'
    const at = typeof s.at === 'number' ? s.at : 0
    const misses = typeof s.misses === 'number' && s.misses >= 0 ? Math.floor(s.misses) : 0
    sent[peer] = { mark: s.mark, list, id: s.id, state, at, misses }
  }
  for (const [peer, g] of Object.entries(isRecord(f?.got) ? f.got : {})) {
    const list = isRecord(g) ? readDirectory(g.list, true) : null
    if (list && isRecord(g) && typeof g.ts === 'string' && typeof g.id === 'string')
      got[peer] = { list, ts: g.ts, id: g.id }
  }
  for (const [key, h] of Object.entries(isRecord(f?.handles) ? f.handles : {})) if (validCode(h)) handles[key] = h
  for (const [key, alias] of Object.entries(isRecord(f?.aliases) ? f.aliases : {}))
    if (validAlias(alias)) aliases[key] = alias
  return { sent, got, handles, aliases }
}

/** The directories sent and received, and the handles; empty while there is no file. Creates nothing. */
export const readDirectoryState = (): DirectoryState => directoryFrom(readJson(teamDirectoryFile(), isDirectoryFile))

/** Changes them under their lock: `fn` edits them in place. */
export function changeDirectoryState<R>(fn: (d: DirectoryState) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamDirectoryFile(),
    (cur: DirectoryFile | null) => {
      const d = directoryFrom(cur)
      result = fn(d)
      return { v: 1 as const, ...d }
    },
    isDirectoryFile,
    PRIVATE,
  )
  return result as R
}

// ---- The owner's passkeys (#224)

/** A passkey of the owner for this board (RP ID `localhost`), as core/webauthn.ts checks it. */
export interface OwnerPasskey {
  id: string
  jwk: JsonWebKey
  alg: Alg
  counter: number
  transports: string[]
  /** The browser and system it was added on, as the panel shows it. */
  label: string
  addedAt: number
  usedAt: number | null
}
export interface OwnerKeys {
  /** The WebAuthn user id (base64url), made with the first passkey. */
  userId: string | null
  passkeys: OwnerPasskey[]
  /**
   * The owner's switch "Confirm with a passkey" (#367): off, the gated actions go at once, as
   * before #224. A file from before the switch has no field: on when it holds a passkey (the
   * owner had chosen one), off when not; the first change writes that down.
   */
  required: boolean
}
type KeysFile = { v: 1 } & OwnerKeys
const isKeys = (v: unknown): v is KeysFile => isRecord(v) && v.v === 1 && Array.isArray(v.passkeys)

const isPasskey = (p: unknown): p is OwnerPasskey =>
  isRecord(p) &&
  typeof p.id === 'string' &&
  isRecord(p.jwk) &&
  (p.alg === -7 || p.alg === -257) &&
  typeof p.counter === 'number' &&
  Array.isArray(p.transports) &&
  typeof p.label === 'string' &&
  typeof p.addedAt === 'number' &&
  (p.usedAt === null || typeof p.usedAt === 'number')

function keysFrom(f: KeysFile | null): OwnerKeys {
  const passkeys = (f?.passkeys ?? []).filter(isPasskey)
  return {
    userId: typeof f?.userId === 'string' ? f.userId : null,
    passkeys,
    required: typeof f?.required === 'boolean' ? f.required : passkeys.length > 0,
  }
}

/** The owner's passkeys; none while there is no file. Creates nothing. */
export const readOwnerKeys = (): OwnerKeys => keysFrom(readJson(teamPasskeysFile(), isKeys))

/** Changes them under their lock: `fn` edits them in place. */
export function changeOwnerKeys<R>(fn: (k: OwnerKeys) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamPasskeysFile(),
    (cur: KeysFile | null) => {
      const k = keysFrom(cur)
      result = fn(k)
      return { v: 1 as const, ...k }
    },
    isKeys,
    PRIVATE,
  )
  return result as R
}

// ---- Pins

/**
 * A peer's key as first seen (trusted) or as it appeared under a name already pinned (changed).
 * `box` (#371): the box key trusted for it, first seen or accepted with Trust; a different one
 * makes the pin `changed` as a new key does, and nothing is sealed to it until Trust.
 */
export interface Pin {
  name: string
  status: 'trusted' | 'changed'
  at: number
  box?: string
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

// ---- Files that go out (#371)

/** A blob this board sends: for whom, how far it got, and the hub's code when it refused it. */
export interface OutBlob {
  id: string
  to: string[]
  size: number
  hash: string
  ttl_s: number
  state: 'uploading' | 'up' | 'refused'
  code?: ErrorCode
  at: number
}
type BlobsFile = { v: 1; blobs: Record<string, OutBlob> }
const isBlobs = (v: unknown): v is BlobsFile => isRecord(v) && v.v === 1 && isRecord(v.blobs)

/** The blobs this board sends, oldest first. Creates nothing. */
export const readBlobs = (): OutBlob[] =>
  Object.values(bare(readJson(teamBlobsFile(), isBlobs)?.blobs ?? {})).sort((a, b) => a.at - b.at)

/** Blobs kept in the list at most; the oldest settled ones go first. */
const KEEP_BLOBS = 200

/** Changes the list of blobs under its lock: `fn` edits the map in place. */
export function changeBlobs<R>(fn: (blobs: Record<string, OutBlob>) => R): R {
  mkdirSync(stateDir(), { recursive: true })
  let result: R | undefined
  updateJson(
    teamBlobsFile(),
    (cur: BlobsFile | null) => {
      const blobs = bare(cur?.blobs ?? {})
      result = fn(blobs)
      const settled = Object.values(blobs)
        .filter(b => b.state !== 'uploading')
        .sort((a, b) => a.at - b.at)
      for (const b of settled.slice(0, Math.max(0, Object.keys(blobs).length - KEEP_BLOBS))) delete blobs[b.id]
      return { v: 1 as const, blobs }
    },
    isBlobs,
    PRIVATE,
  )
  return result as R
}

const filesIn = (sub: 'out' | 'drafts'): string => join(teamFilesDir(), sub)
const fileAt = (sub: 'out' | 'drafts', id: string): string => {
  if (!isMessageId(id)) throw new TypeError('a team file is named by a UUID')
  return join(filesIn(sub), id)
}

/** Keeps the sealed bytes of a blob until the hub has them all (0600). */
export function keepSealed(id: string, bytes: Uint8Array): void {
  mkdirSync(filesIn('out'), { recursive: true, mode: 0o700 })
  writeFileSync(fileAt('out', id), bytes, PRIVATE)
}

/** The sealed bytes of a blob, or null once they are gone. */
export function readSealed(id: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(fileAt('out', id)))
  } catch {
    return null
  }
}

export function dropSealed(id: string): void {
  try {
    unlinkSync(fileAt('out', id))
  } catch {}
}

/** Copies a file an agent attached to a draft into the board's own folder (0600); its path there. */
export function keepDraftFile(draft: string, from: string): string {
  mkdirSync(filesIn('drafts'), { recursive: true, mode: 0o700 })
  const to = fileAt('drafts', draft)
  copyFileSync(from, to)
  return to
}

/** Removes a draft's copy of its file; only a path in the board's own drafts folder. */
export function dropDraftFile(path: string): void {
  const name = path.slice(filesIn('drafts').length + 1)
  if (!path.startsWith(filesIn('drafts')) || !isMessageId(name)) return
  try {
    unlinkSync(path)
  } catch {}
}

// ---- The log

/** The log is moved aside to `team-audit.jsonl.1` (replacing the one before) when it passes this. */
export const AUDIT_MAX_BYTES = 1024 * 1024

function rotateAudit(): void {
  const file = teamAuditFile()
  try {
    if (statSync(file).size < AUDIT_MAX_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    // No log yet, or another writer moved it first: the append below starts a fresh one.
  }
}

/** One line of what happened: a kind of event, the peer, short facts. Never a message's text. */
export function audit(
  action: string,
  peer: string | null,
  detail: Record<string, string | number | boolean> = {},
): void {
  mkdirSync(stateDir(), { recursive: true })
  rotateAudit()
  appendFileSync(teamAuditFile(), `${JSON.stringify({ at: Date.now(), action, peer, ...detail })}\n`, PRIVATE)
}
