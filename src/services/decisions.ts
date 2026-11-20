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
import { stateDir } from '../adapters/paths.ts'
import { addEntry, getEntry, removeEntry } from '../adapters/schedule-store.ts'
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
} from '../core/decisions.ts'
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
  thread?: { id: string; key: string }
  now: number
  by?: string
  schedule?: DecisionSchedule
}

/**
 * A question with its options: an open one of the same card before it is withdrawn (replaced) and
 * its default taken back; the default goes into the schedule; then the card, then the row (a queue
 * built between the two finds the card's id with no row yet, which it leaves alone).
 */
export function askDecision(db: BoardDb, a: AskInput): { id: string; defaultAt: number | null } {
  const schedule = a.schedule ?? fileSchedule
  const by = a.by ?? 'agent'
  const prev = cardDecisionOf(readCard(a.key)?.decision)
  if (prev) closeRow(db, prev.id, { answer: null, answeredBy: 'withdrawn', via: 'replaced', at: a.now }, by, schedule)
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
        ? { answer: answerText(prompt), answeredBy: 'owner', via: answeringOf(card) ?? 'prompt', at: now }
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

// An answer on its way holds the question this long at most: a board that stopped halfway never
// keeps its default waiting for good.
const ANSWERING_MS = 60_000

/** How the card says its answer is being typed in, while it does. */
export function answeringOf(card: Card | null | undefined, now = Date.now()): 'button' | 'text' | null {
  const v = isRecord(card?.decision) ? card.decision.answering : undefined
  if (!isRecord(v) || typeof v.at !== 'number' || now - v.at >= ANSWERING_MS) return null
  return v.via === 'button' || v.via === 'text' ? v.via : null
}

/**
 * The owner's answer is on its way into the session (the page's click or text): the card says so,
 * so the hook records it as given by the button (or the text), and the default waits meanwhile.
 * One at a time: false when another answer is on its way already. `null` undoes it (it could not
 * be typed in).
 */
export function markAnswering(key: string, id: string, via: 'button' | 'text' | null, now = Date.now()): boolean {
  let taken = false
  updateCard(key, c => {
    const cd = cardDecisionOf(c?.decision)
    if (!c || cd?.id !== id) return undefined
    if (via && answeringOf(c, now)) return undefined
    const raw = { ...(c.decision as Record<string, unknown>) }
    if (via) raw.answering = { via, at: now }
    else delete raw.answering
    taken = true
    return { ...c, decision: raw }
  })
  return taken
}

/**
 * The scheduler, before a default goes (and again right before it is typed): 'go'; 'wait' while
 * the owner's answer is being typed in; 'drop' once the question is answered, withdrawn, replaced
 * or held (the owner's prompt cleared the card's ask: no prompt from the owner since, or it does
 * not go), or defaults are off in the live config.
 */
export function defaultDue(entry: ScheduleEntry, cfg?: { decisions?: unknown }): 'go' | 'wait' | 'drop' {
  const id = typeof entry.decision === 'string' ? entry.decision : ''
  // Defaults turned off (or decisions altogether) since it was asked: nothing decides by itself.
  if (cfg && !decisionsConfig(cfg.decisions)?.defaults) return 'drop'
  const card = readCard(entry.key)
  const cd = cardDecisionOf(card?.decision)
  if (!id || !card?.ask || cd?.id !== id || cd.held !== undefined || cd.defaultAt === undefined) return 'drop'
  if (answeringOf(card)) return 'wait'
  const row = readDecisionsDb(db => getDecision(db, id), null)
  return row && row.answeredAt !== null ? 'drop' : 'go'
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
    if (!row) return
    const label = row.recommend ? (row.options[row.recommend - 1] ?? '') : ''
    closeCardDecision(
      db,
      entry.key,
      { answer: label, answeredBy: 'default', via: 'default', at: now },
      { id, ask: true },
    )
    if (row.thread) threadDefault(db, row, label, now)
  })
}

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
    if (card?.ask && cardDecisionOf(card.decision)?.id === row.id) {
      // Its default taken out of the schedule by hand (the Schedule row's delete, `board unschedule`):
      // held, so the card no longer counts down to a default that will not come.
      if (row.entry && row.defaultAt !== null && row.held === null && !getEntry(row.entry)) {
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
  const items_ = orderQueue(
    cardsWaiting(items, cards).map(w => viewOf(w.card?.key ?? '', w.who, cards.get(w.card?.key ?? ''), w.text)),
  )
  const seen = o.seen ?? seenAt()
  const defaulted = readDecisionsDb(db => {
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
