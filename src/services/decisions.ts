// Decisions (#487, core/decisions.ts): what `board ask` and `board thread ask` write with options,
// what the page's click and Hold do, the scheduler's check before a default goes, and the queue. The
// open question lives on the session's card (card.decision, beside card.ask, which every reader of
// "needs the user" goes on reading); the database keeps the record (adapters/decision-store.ts).
// Only reached while config.json's `decisions` is on, or for a card that has a decision.
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readCard, updateCard, writeCard } from '../adapters/cards.ts'
import type { BoardDb } from '../adapters/db.ts'
import {
  type AnsweredBy,
  closeDecision,
  closedDecisions,
  type DecisionRow,
  getDecision,
  holdDecision,
  insertDecision,
  openDecisions,
  type Via,
} from '../adapters/decision-store.ts'
import { isRecord, readJson, replaceFile } from '../adapters/json-store.ts'
import { knobMs } from '../adapters/pacing.ts'
import { stateDir } from '../adapters/paths.ts'
import { addEntry, getEntry, readLog, removeEntry } from '../adapters/schedule-store.ts'
import { entriesOf, getThread } from '../adapters/work-thread-store.ts'
import {
  type AskSpec,
  answerText,
  type CardDecision,
  cardDecisionOf,
  DECISIONS_FROM,
  DecisionError,
  type DecisionsPayload,
  type DecisionView,
  type DefaultedView,
  decisionsConfig,
  defaultLine,
  durationWords,
  orderQueue,
  ownerPrompt,
  type ReservedDecision,
} from '../core/decisions.ts'
import { parseNodeKey } from '../core/nodes.ts'
import { cardsWaiting } from '../core/owner-watch.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { Card, Item } from '../core/types.ts'
import { type Party, threadsConfig } from '../core/work-threads.ts'
import { beforeAsk, openAsk, postEntry, withThreadsDb } from './work-threads.ts'

/** The board's database for one call (the web board's kept connection, else one of its own). */
export function withDecisionsDb<T>(fn: (db: BoardDb) => T): T {
  return withThreadsDb(true, db => {
    if (!db) throw new DecisionError('db', 'no database')
    return fn(db)
  })
}

/** The same for reading: null when there is no database yet. */
export const readDecisionsDb = <T>(fn: (db: BoardDb) => T, none: T): T =>
  withThreadsDb(false, db => (db ? fn(db) : none))

export const GONE = 'this question is no longer open'

/** The schedule as decisions use it; the tests give their own. */
export interface DecisionSchedule {
  add(e: Parameters<typeof addEntry>[0]): { id: string }
  remove(id: string): void
}
const fileSchedule: DecisionSchedule = {
  add: e => addEntry(e),
  remove: id => {
    removeEntry(id, 'cancelled')
  },
}

const removeQuietly = (schedule: DecisionSchedule, id: string | null | undefined): void => {
  if (!id) return
  try {
    schedule.remove(id)
  } catch {}
}

export interface AskInput {
  key: string
  name?: string
  lane?: string | null
  spec: AskSpec
  /** The card's ask: the question, or a thread's waitingOn. */
  ask: string
  thread?: { id: string; key: string; ask?: string }
  now: number
  by?: string
  schedule?: DecisionSchedule
  /** Its id and default, reserved before (reserveDecision). */
  reserved?: ReservedDecision
  /**
   * A node's session (#781), asked through the node's uplink: the master holds its question for the
   * prefixed key (core/nodes.ts nodeKey). Only services/nodes/uplink.ts sets it.
   */
  device?: boolean
}

/**
 * A question's id and its default in the schedule, before anything else is written: at the
 * session's cap this refuses with nothing changed. `board thread ask` takes it before it writes the
 * thread's question (releaseDecision gives it back when that write fails); `board ask` through
 * askDecision. A device's key is taken only from its node's uplink (#781, `device`).
 */
export function reserveDecision(
  a: Pick<AskInput, 'key' | 'name' | 'spec' | 'now' | 'schedule' | 'device'>,
): ReservedDecision {
  if (parseNodeKey(a.key) && !a.device) throw new DecisionError('device', "a device's session asks on its own board")
  const schedule = a.schedule ?? fileSchedule
  const id = randomBytes(4).toString('hex')
  const { spec } = a
  const label = spec.recommend ? spec.options[spec.recommend - 1] : undefined
  const defaultAt = spec.defaultMs && label ? a.now + spec.defaultMs : null
  const entry =
    defaultAt !== null && spec.defaultMs && label
      ? schedule.add({
          key: a.key,
          ...(a.name && { name: a.name }),
          text: defaultLine(spec.defaultMs, label),
          at: defaultAt,
          next: defaultAt,
          by: 'decisions',
          from: { ...DECISIONS_FROM },
          decision: id,
        }).id
      : null
  return { id, entry, defaultAt }
}

/** A reserved default given back: the question it was for was not written. */
export const releaseDecision = (r: ReservedDecision, schedule: DecisionSchedule = fileSchedule): void =>
  removeQuietly(schedule, r.entry)

/**
 * A question with its options: the default goes into the schedule first (refused at the session's
 * cap, which leaves everything as it was); then an open one of the same card is withdrawn (replaced)
 * and its default taken back; then the card, then the row (a queue built between the two finds the
 * card's id with no row yet, which it leaves alone). A node's session (#781) asks through its
 * node's uplink: the card written here is the master's copy for the prefixed key.
 */
export function askDecision(db: BoardDb, a: AskInput): { id: string; defaultAt: number | null } {
  const schedule = a.schedule ?? fileSchedule
  const by = a.by ?? 'agent'
  const { id, entry, defaultAt } = a.reserved ?? reserveDecision(a)
  const { spec } = a
  const prev = cardDecisionOf(readCard(a.key)?.decision)
  if (prev) {
    try {
      closeRow(db, prev.id, { answer: null, answeredBy: 'withdrawn', via: 'replaced', at: a.now }, by, schedule)
    } catch (err) {
      removeQuietly(schedule, entry)
      throw err
    }
  }
  const decision: CardDecision = {
    id,
    options: spec.options,
    ...(spec.recommend && { recommend: spec.recommend }),
    ...(defaultAt !== null && { defaultAt, defaultMs: spec.defaultMs as number }),
    ...(a.thread && { thread: a.thread }),
  }
  writeCard(a.key, { ask: a.ask, askSince: a.now, by, decision } as Parameters<typeof writeCard>[1])
  try {
    insertDecision(
      db,
      {
        id,
        session: a.key,
        name: a.name ?? '',
        lane: a.lane ?? null,
        thread: a.thread?.id ?? null,
        question: spec.question,
        options: spec.options,
        recommend: spec.recommend,
        defaultMs: spec.defaultMs,
        defaultAt,
        entry,
        askedAt: a.now,
      },
      by,
    )
  } catch (err) {
    // No record: the question stays a plain ask, with nothing deciding by itself.
    removeQuietly(schedule, entry)
    updateCard(a.key, c => {
      if (!c || cardDecisionOf(c.decision)?.id !== id) return undefined
      const { decision, ...rest } = c
      return rest
    })
    throw err
  }
  return { id, defaultAt }
}

/** Closes a row and takes its default back; whether this call closed it. */
function closeRow(
  db: BoardDb,
  id: string,
  close: { answer: string | null; answeredBy: AnsweredBy; via: Via; at: number },
  by: string,
  schedule: DecisionSchedule,
): boolean {
  const row = getDecision(db, id)
  const closed = closeDecision(db, id, close, by)
  if (closed) removeQuietly(schedule, row?.entry)
  return closed
}

/**
 * The card's open decision taken off it (with its ask, when `ask`) and its row closed. The hook, the
 * board's own clearing of an answered ask, `board doing / done / clear`.
 */
export function closeCardDecision(
  db: BoardDb,
  key: string,
  close: { answer: string | null; answeredBy: AnsweredBy; via: Via; at: number },
  o: { by?: string; ask?: boolean; id?: string; schedule?: DecisionSchedule } = {},
): boolean {
  const cd = cardDecisionOf(readCard(key)?.decision)
  const id = o.id ?? cd?.id
  if (!id) return false
  const closed = closeRow(db, id, close, o.by ?? 'board', o.schedule ?? fileSchedule)
  updateCard(key, c => {
    if (!c || cardDecisionOf(c.decision)?.id !== id) return undefined
    const { decision, ask, askSince, ...rest } = c
    return o.ask ? rest : { ...rest, ...(ask !== undefined && { ask }), ...(askSince !== undefined && { askSince }) }
  })
  return closed
}

/**
 * The hook cleared the card's ask on a prompt (the same prompts as on main): its open decision is
 * the owner's answer when the owner typed it (by the page's button or text, when the card said so),
 * else withdrawn: another session's message, a teammate's, a background result.
 */
export function closeOnPrompt(card: Card | null, prompt: unknown, now: number): void {
  const id = cardDecisionOf(card?.decision)?.id
  if (!id) return
  const owner = ownerPrompt(prompt)
  withDecisionsDb(db =>
    closeRow(
      db,
      id,
      owner
        ? { answer: answerText(prompt), answeredBy: 'owner', via: answeringOf(card, now) ?? 'prompt', at: now }
        : { answer: null, answeredBy: 'withdrawn', via: 'cleared', at: now },
      owner ? 'owner' : 'board',
      fileSchedule,
    ),
  )
}

/** The open decision `id` of the card `key`, as the page saw it; refused when it is not open any more (#139). */
export function openOf(db: BoardDb, key: string, id: string): { card: Card; decision: CardDecision; row: DecisionRow } {
  const card = readCard(key)
  const decision = cardDecisionOf(card?.decision)
  const row = getDecision(db, id)
  if (!card?.ask || decision?.id !== id || !row || row.answeredAt !== null) throw new DecisionError('gone', GONE)
  return { card, decision, row }
}

/** Hold: the default is taken back, the question stays. */
export function holdOpen(db: BoardDb, key: string, id: string, now: number, schedule = fileSchedule): void {
  const { row } = openOf(db, key, id)
  if (!holdDecision(db, id, now, 'owner')) throw new DecisionError('gone', GONE)
  removeQuietly(schedule, row.entry)
  updateCard(key, c => {
    const cd = cardDecisionOf(c?.decision)
    if (!c || cd?.id !== id) return undefined
    const { defaultAt, ...rest } = cd
    return { ...c, decision: { ...rest, held: now } }
  })
}

// An answer on its way holds the question this long after its mark was last renewed (the route
// renews it while the board's send still runs, a wake included): a board that stopped halfway never
// keeps its default waiting for good. BOARD_DECISION_ANSWERING_MS: tests only.
export const answeringMs = (): number => knobMs('BOARD_DECISION_ANSWERING_MS', 60_000)

/** How the card says its answer is being typed in, while it does. */
export function answeringOf(card: Card | null | undefined, now: number): 'button' | 'text' | null {
  const v = isRecord(card?.decision) ? card.decision.answering : undefined
  if (!isRecord(v) || typeof v.at !== 'number' || now - v.at >= answeringMs()) return null
  return v.via === 'button' || v.via === 'text' ? v.via : null
}

/**
 * The owner's answer is on its way into the session (the page's click or text): the card says so,
 * so the hook records it as given by the button (or the text), and the default waits meanwhile.
 * One at a time: false when another answer is on its way already. `null` undoes it (it could not
 * be typed in); `renew` stamps the mark this call holds again, while the send still runs.
 */
export function markAnswering(
  key: string,
  id: string,
  via: 'button' | 'text' | null,
  now: number,
  o: { renew?: boolean } = {},
): boolean {
  let taken = false
  updateCard(key, c => {
    const cd = cardDecisionOf(c?.decision)
    if (!c || cd?.id !== id) return undefined
    if (via && !o.renew && answeringOf(c, now)) return undefined
    if (o.renew && isRecord(c.decision) && (!isRecord(c.decision.answering) || c.decision.answering.via !== via))
      return undefined
    const raw = { ...(c.decision as Record<string, unknown>) }
    if (via) raw.answering = { via, at: now }
    else delete raw.answering
    taken = true
    return { ...c, decision: raw }
  })
  return taken
}

/**
 * Whether the thread still asks the decision's own question: its open ask is the entry the decision
 * was asked with (one asked before that was kept: by the session that asked). Another session's
 * question on the same thread, or none, is not this decision's to answer.
 */
export function ownThreadAsk(db: BoardDb, thread: NonNullable<CardDecision['thread']>, key: string): boolean {
  const head = getThread(db, thread.id)
  const ask = head ? openAsk(head, entriesOf(db, head.id)) : null
  if (!ask) return false
  return thread.ask ? ask.id === thread.ask : ask.author.kind === 'session' && ask.author.key === key
}

// A node's card takes a while to show the master a decision the master just wrote for it (the node
// writes it once the uplink answers, its payload comes every few seconds): until then a card without
// it is not taken for one that dropped it.
export const NODE_SETTLE_MS = 60_000

/**
 * A node session's open decision (#781) against its card as the node shows it: 'open' while that
 * card carries the same decision; 'gone' once it no longer does (an answer typed in at the node, a
 * `board doing`, another question); 'unknown' while the card is not seen, or just asked.
 */
export function nodeDecisionState(
  item: Pick<Item, 'decision'> | undefined,
  id: string,
  askedAt: number,
  now: number,
): 'open' | 'gone' | 'unknown' {
  if (!item) return 'unknown'
  if (cardDecisionOf(item.decision)?.id === id) return 'open'
  return now - askedAt < NODE_SETTLE_MS ? 'unknown' : 'gone'
}

/**
 * The scheduler, before a default goes (and again right before it is typed): 'go'; 'wait' while
 * the owner's answer is being typed in; 'drop' once the question is answered, withdrawn, replaced
 * or held (the owner's prompt cleared the card's ask: no prompt from the owner since, or it does
 * not go), or defaults are off in the live config. An entry for a node's session (#781) goes only
 * with `o.item` (the master's view of the nodes' cards), while that card still carries the
 * decision: without it, as before, it is not this board's to decide.
 */
export function defaultDue(
  entry: ScheduleEntry,
  cfg: { decisions?: unknown } | undefined,
  now: number,
  o: { item?: (key: string) => Item | undefined } = {},
): 'go' | 'wait' | 'drop' {
  const id = typeof entry.decision === 'string' ? entry.decision : ''
  const node = parseNodeKey(entry.key) !== null
  if (node && !o.item) return 'drop'
  // Defaults turned off (or decisions altogether) since it was asked: nothing decides by itself.
  if (cfg && !decisionsConfig(cfg.decisions)?.defaults) return 'drop'
  const card = readCard(entry.key)
  const cd = cardDecisionOf(card?.decision)
  if (!id || !card?.ask || cd?.id !== id || cd.held !== undefined || cd.defaultAt === undefined) return 'drop'
  if (answeringOf(card, now)) return 'wait'
  if (node && o.item) {
    const askedAt = typeof card.askSince === 'number' ? card.askSince : 0
    const state = nodeDecisionState(o.item(entry.key), id, askedAt, now)
    if (state === 'gone') return 'drop'
    // Just asked and not on the node's card yet: it goes once the card shows it, or drops.
    if (state === 'unknown' && o.item(entry.key)) return 'wait'
  }
  const row = readDecisionsDb(db => getDecision(db, id), null)
  if (row && row.answeredAt !== null) return 'drop'
  // A thread's question the thread no longer asks (another session asked on it since): not its default.
  const thread = cd.thread
  if (thread && !readDecisionsDb(db => ownThreadAsk(db, thread, entry.key), true)) return 'drop'
  return 'go'
}

/**
 * The default went in: the row closed as the default's, the card's ask and decision gone. A
 * thread's question gets the board's line in the thread too, which puts it back as an answer would.
 */
export function defaulted(entry: ScheduleEntry, now: number): void {
  const id = typeof entry.decision === 'string' ? entry.decision : ''
  if (!id) return
  withDecisionsDb(db => {
    const row = getDecision(db, id)
    if (row) defaultedRow(db, row, now)
  })
}

/**
 * The scheduler's record of a default it typed in: tried twice; past that the board's tidy-up finds
 * it typed by the scheduler's log (settleLeftOvers). Whether it was written.
 */
export function recordDefault(
  entry: ScheduleEntry,
  now: number,
  log: (line: string) => void,
  write: (entry: ScheduleEntry, now: number) => void = defaulted,
): boolean {
  for (let tries = 0; tries < 2; tries++) {
    try {
      write(entry, now)
      return true
    } catch (err) {
      log(`decision ${String(entry.decision)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return false
}

function defaultedRow(db: BoardDb, row: DecisionRow, at: number): void {
  const label = row.recommend ? (row.options[row.recommend - 1] ?? '') : ''
  const closed = closeCardDecision(
    db,
    row.session,
    { answer: label, answeredBy: 'default', via: 'default', at },
    { id: row.id, ask: true },
  )
  if (closed && row.thread) threadDefault(db, row, label, at)
}

/** Whether the scheduler's log says the default `entry` was typed in. */
const typed = (entry: string): boolean => readLog(300).some(r => isRecord(r) && r.id === entry && r.result === 'sent')

function threadDefault(db: BoardDb, row: DecisionRow, label: string, now: number): void {
  try {
    const head = getThread(db, row.thread as string)
    if (!head) return
    const entries = entriesOf(db, head.id)
    const ask = openAsk(head, entries)
    if (!ask) return
    const before = beforeAsk(head, entries, ask)
    const actor: Party = { kind: 'session', key: row.session, name: row.name || row.session.slice(0, 8) }
    // The thread's own config, on, as the asker's thread ask needed it.
    const cfg = threadsConfig(true)
    if (!cfg) return
    postEntry({ db, cfg, actor, now }, head, {
      type: 'system',
      // This board's own line: a shared thread's peers get none of it (#394).
      private: true,
      text: `no answer in ${durationWords(row.defaultMs ?? 0)}: went with the recommendation "${label}"`,
      replyTo: ask.id,
      set: {
        status: before.status,
        ...(before.status === 'waiting' && before.waitingOn && { waitingOn: before.waitingOn }),
      },
    })
  } catch {}
}

// ------------------------------------------------------------------ the queue

const SEEN = (): string => join(stateDir(), 'decisions.json')
const isSeen = (v: unknown): v is { seenAt: number } => isRecord(v) && typeof v.seenAt === 'number'

/** When the owner last opened the Decisions panel (0: never). */
export const seenAt = (file = SEEN()): number => readJson(file, isSeen)?.seenAt ?? 0

/** The owner opened the panel: what went by default before now is seen. */
export function markSeen(now: number, file = SEEN()): void {
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, JSON.stringify({ seenAt: now }), undefined, 0o600)
}

// A row a card does not point at is withdrawn once it is this old: a `board ask` writes the card
// before the row, and one being written is never taken for one left behind.
const SETTLE_MS = 10_000
const LEFT_MS = 86_400_000

/**
 * Open rows no card points at any more (an ask cleared by `board doing`, by a Codex session's
 * hook, by another session's message): withdrawn, so the record never shows them open. An open
 * one whose default left the schedule by hand: held.
 */
function settleLeftOvers(db: BoardDb, cards: ReadonlyMap<string, Card>, now: number): void {
  for (const row of openDecisions(db)) {
    if (now - row.askedAt < SETTLE_MS) continue
    const card = cards.get(row.session)
    // A card written a moment ago may be the hook's on its way to closing the row itself; one not
    // read at all (a read that failed, a session gone) is left for a day.
    if (card ? now - (Number(card.updatedAt) || 0) < SETTLE_MS : now - row.askedAt < LEFT_MS) continue
    // Its default left the schedule. Typed in, by the log, with its record not written (the
    // scheduler's write failed): the default's, never held or withdrawn. Stamped now, when it is
    // recorded, so it counts as unseen whatever the panel marked meanwhile.
    const gone = row.entry !== null && row.defaultAt !== null && row.held === null && !getEntry(row.entry)
    if (gone && row.entry && typed(row.entry)) {
      try {
        defaultedRow(db, row, now)
      } catch {}
      continue
    }
    if (card?.ask && cardDecisionOf(card.decision)?.id === row.id) {
      // Its default taken out of the schedule by hand (the Schedule row's delete, `board unschedule`):
      // held, so the card no longer counts down to a default that will not come.
      if (gone) {
        try {
          if (holdDecision(db, row.id, now, 'board'))
            updateCard(row.session, c => {
              const cd = cardDecisionOf(c?.decision)
              if (!c || cd?.id !== row.id) return undefined
              const { defaultAt, ...rest } = cd
              return { ...c, decision: { ...rest, held: now } }
            })
        } catch {}
      }
      continue
    }
    try {
      closeDecision(db, row.id, { answer: null, answeredBy: 'withdrawn', via: 'cleared', at: now }, 'board')
      removeQuietly(fileSchedule, row.entry)
    } catch {}
  }
}

/**
 * Node sessions' open decisions (#781) their node's card no longer carries (answered at the node,
 * withdrawn by `board doing`, replaced by a plain ask): withdrawn here, with this board's copy of
 * the card's ask, and their default taken back. A card the master does not see is left as it is.
 */
export function settleNodeDecisions(
  db: BoardDb,
  items: readonly Item[],
  cards: ReadonlyMap<string, Card>,
  now: number,
  schedule: DecisionSchedule = fileSchedule,
): void {
  const byKey = new Map(items.map(i => [i.key, i]))
  for (const [key, card] of cards) {
    if (!parseNodeKey(key)) continue
    const cd = cardDecisionOf(card.decision)
    if (!cd || !card.ask) continue
    const askedAt = typeof card.askSince === 'number' ? card.askSince : 0
    if (nodeDecisionState(byKey.get(key), cd.id, askedAt, now) !== 'gone') continue
    try {
      closeCardDecision(
        db,
        key,
        { answer: null, answeredBy: 'withdrawn', via: 'cleared', at: now },
        { id: cd.id, ask: true, schedule },
      )
    } catch {}
  }
}

/**
 * Node sessions' cards (#781) as this board shows them: a decision only while this board holds it
 * open, as this board has it (held, answering, its default); none while decisions are off here.
 */
export function nodeItemsDecisions<T extends Pick<Item, 'key' | 'decision'>>(
  items: readonly T[],
  cards: ReadonlyMap<string, Card>,
  on: boolean,
): T[] {
  return items.map(item => {
    if (item.decision === undefined) return item
    const { decision, ...rest } = item
    const held = cards.get(item.key)
    const kept = on && held?.ask ? cardDecisionOf(held.decision) : null
    return (kept && kept.id === cardDecisionOf(decision)?.id ? { ...rest, decision: kept } : rest) as T
  })
}

/** One waiting card as the queue shows it. */
function viewOf(key: string, who: string, card: Card | undefined, question: string): DecisionView {
  const cd = card?.ask ? cardDecisionOf(card.decision) : null
  const lane = typeof card?.category === 'string' && card.category ? card.category : undefined
  return {
    key,
    id: cd?.id ?? null,
    who,
    ...(lane && { lane }),
    question,
    options: cd?.options ?? [],
    recommend: cd?.recommend ?? null,
    askedAt: typeof card?.askSince === 'number' ? card.askSince : null,
    defaultAt: cd?.defaultAt ?? null,
    held: cd?.held !== undefined,
    ...(cd?.thread && { thread: cd.thread.key }),
    ...(!card?.ask && { board: true }),
  }
}

const defaultedOf = (db: BoardDb, since: number): DefaultedView[] =>
  closedDecisions(db, { by: 'default', since, limit: 20 }).map(r => ({
    id: r.id,
    key: r.session,
    who: r.name || r.session.slice(0, 8),
    question: r.question,
    answer: r.answer ?? '',
    at: r.answeredAt ?? 0,
  }))

/** The payload's queue: owner-watch's set (cards with an ask, the board's own asks), with their options. */
export function decisionsPayload(
  items: readonly Item[],
  cards: ReadonlyMap<string, Card>,
  o: { now: number; defaults: boolean; seen?: number },
): DecisionsPayload {
  // A node's card (#781) is in the queue only while this board holds a question of it: its plain asks
  // stay on its card, as before.
  const own = items.filter(i => !parseNodeKey(i.key) || cardDecisionOf(cards.get(i.key)?.decision))
  const items_ = orderQueue(
    cardsWaiting(own, cards).map(w => viewOf(w.card?.key ?? '', w.who, cards.get(w.card?.key ?? ''), w.text)),
  )
  const seen = o.seen ?? seenAt()
  const defaulted = readDecisionsDb(db => {
    // Only a master with nodes' cards in view has any (#781).
    if (items.some(i => parseNodeKey(i.key))) settleNodeDecisions(db, items, cards, o.now)
    settleLeftOvers(db, cards, o.now)
    return defaultedOf(db, seen)
  }, [] as DefaultedView[])
  return { items: items_, defaulted, defaults: o.defaults }
}

/** `board decisions`: the same from the cards alone (no herdr), for a day assistant. */
export function decisionsFromCards(cards: ReadonlyMap<string, Card>): DecisionView[] {
  // A session's name as its open question's row has it (the card keeps only a name the owner gave).
  const names = new Map(readDecisionsDb(db => openDecisions(db), [] as DecisionRow[]).map(r => [r.session, r.name]))
  const list: DecisionView[] = []
  for (const [key, card] of cards) {
    if (typeof card.ask !== 'string' || !card.ask.trim()) continue
    const who = (typeof card.name === 'string' && card.name) || names.get(key) || key.slice(0, 8)
    list.push(viewOf(key, who, card, card.ask.trim()))
  }
  return orderQueue(list)
}

/** `board decisions --done`, the sheet's record: the closed ones, newest first. */
export const decisionsDone = (o: { session?: string; limit?: number } = {}): DecisionRow[] =>
  readDecisionsDb(db => closedDecisions(db, o), [] as DecisionRow[])
