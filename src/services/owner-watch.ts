// `board thread watch --owner` (#434, core/owner-watch.ts): after each refresh the web board compares
// what waits on the owner now (cards with an ask, threads in status owner) with what each watching
// session was told, and leaves one line for it in the schedule, as a thread event does
// (services/work-threads.ts): one pending entry `by: 'asks'` at a time, typed in as "[board
// reminder from asks] ...", going to a MokuPilot day session's inbox. A change before it goes out
// replaces it (taken back, never changed in place), told from what the session heard before it,
// so a question asked and settled meanwhile says nothing; the next one after it waits out
// threads.events.gapSec. What a session was told is kept in owner-watch.json in the state folder,
// which only the web board writes. A watch seen for the first time starts from what waits then;
// an unwatched session's pending line is taken back. A refresh that failed compares nothing: an
// empty board is not everything settled. No `owner` watch: one query, nothing read or written.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { allCards } from '../adapters/cards.ts'
import type { BoardDb } from '../adapters/db.ts'
import { isRecord, readJson, replaceFile } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import { entriesOf, listThreads, watchesOf } from '../adapters/work-thread-store.ts'
import {
  ASKS_FROM,
  cardsWaiting,
  OWNER,
  ownerLine,
  sameTold,
  type Told,
  threadsWaiting,
  toldOf,
  waitingFor,
} from '../core/owner-watch.ts'
import type { Card, Item } from '../core/types.ts'
import type { Party, ThreadEntry, ThreadHead, ThreadsConfig } from '../core/work-threads.ts'
import { type EventSchedule, fileSchedule, openAsk } from './work-threads.ts'

/**
 * One watching session: what it was told, when its last line was due (`at`) and the one before
 * (`prevAt`, which a line taken back before it went out gives back), and what it had heard before
 * a pending line (`base`).
 */
interface Heard {
  told: Told
  at: number
  prevAt?: number
  base?: Told
}
type State = Record<string, Heard>

export const ownerWatchFile = (): string => join(stateDir(), 'owner-watch.json')

const isTold = (v: unknown): v is Told =>
  isRecord(v) && Object.values(v).every(w => isRecord(w) && typeof w.who === 'string' && typeof w.text === 'string')
const isState = (v: unknown): v is State =>
  isRecord(v) &&
  Object.values(v).every(
    r =>
      isRecord(r) &&
      isTold(r.told) &&
      typeof r.at === 'number' &&
      (r.prevAt === undefined || typeof r.prevAt === 'number') &&
      (r.base === undefined || isTold(r.base)),
  )

// What the sessions were told, as last written: the web board is the file's one writer, so it is
// read once, and a board with no `owner` watch reads it no more after that.
let memory: { file: string; state: State } | null = null
function load(file: string): State {
  if (memory?.file !== file) memory = { file, state: readJson(file, isState) ?? {} }
  return memory.state
}
function store(file: string, state: State): void {
  if (Object.keys(state).length) replaceFile(file, JSON.stringify(state), undefined, 0o600)
  else rmSync(file, { force: true })
  memory = { file, state }
}
/** The tests' restart of the web board: the file is read again. */
export function forgetOwnerWatch(): void {
  memory = null
}

export interface OwnerWatchCtx {
  db: BoardDb
  cfg: Pick<ThreadsConfig, 'gapSec'>
  /** The board's items as the last refresh collected them; null when it failed (nothing is compared). */
  items: readonly Item[] | null
  now: number
  /** The cards by key: read from their folder when not given. */
  cards?: () => ReadonlyMap<string, Card>
  /** The tests' schedule and file. */
  schedule?: EventSchedule
  file?: string
  log?: (line: string) => void
  /** Resolves a session key to the full board key (`@<node>:<key>` for node sessions) when scheduling. */
  resolveKey?: (key: string) => string
}

/** The pending line of a session: one not claimed yet. */
const pendingOf = (schedule: EventSchedule, session: string) =>
  schedule.list().find(e => e.key === session && e.by === 'asks' && !e.claim)

/** Who put a thread on the owner: its open question's author, else that of the last entry that set the status. */
function putBy(head: ThreadHead, entries: readonly ThreadEntry[]): { ask: string; by: Party | null } {
  const open = openAsk(head, entries)
  if (open) return { ask: open.text, by: open.author }
  const set = entries.findLast(e => e.set?.status === 'owner')
  return { ask: '', by: set?.author ?? null }
}

/** Tells every `owner` watcher what changed since it was last told; the sessions given a line. */
export function tellOwnerWatchers(ctx: OwnerWatchCtx): string[] {
  const file = ctx.file ?? ownerWatchFile()
  const all = watchesOf(ctx.db)
  const owners = all.filter(w => w.target === OWNER)
  if (!owners.length && memory?.file === file && !Object.keys(memory.state).length) return []
  const before = load(file)
  const schedule = ctx.schedule ?? fileSchedule
  const state: State = {}
  const told: string[] = []
  const log = ctx.log ?? (() => {})
  // An unwatched session's line that has not gone out yet goes with its watch.
  for (const session of Object.keys(before)) {
    if (owners.some(w => w.session === session)) continue
    try {
      const targetKey = ctx.resolveKey ? ctx.resolveKey(session) : session
      const pending =
        pendingOf(schedule, targetKey) ?? (targetKey !== session ? pendingOf(schedule, session) : undefined)
      if (pending) schedule.takeBack(pending.id)
    } catch (err) {
      log(`owner watch: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (owners.length && ctx.items) {
    const heads = listThreads(ctx.db, { status: 'owner' })
    const waiting = [
      ...cardsWaiting(ctx.items, (ctx.cards ?? allCards)()),
      ...threadsWaiting(heads.map(head => ({ head, ...putBy(head, entriesOf(ctx.db, head.id)) }))),
    ]
    for (const w of owners) {
      const had = before[w.session]
      try {
        const now = toldOf(waitingFor(waiting, w.session, all))
        if (!had) {
          state[w.session] = { told: now, at: 0 }
          continue
        }
        if (sameTold(had.told, now)) {
          state[w.session] = had
          continue
        }
        const targetKey = ctx.resolveKey ? ctx.resolveKey(w.session) : w.session
        const pending =
          pendingOf(schedule, targetKey) ?? (targetKey !== w.session ? pendingOf(schedule, w.session) : undefined)
        // Replaced, not changed in place; one claimed meanwhile goes as it is, and this one follows it.
        const replaced = pending ? schedule.takeBack(pending.id) : false
        const base = replaced && had.base ? had.base : had.told
        const prevAt = replaced ? (had.prevAt ?? 0) : had.at
        const text = ownerLine(base, now)
        if (!text) {
          // Asked and settled before the line went out: nothing to say, nothing pending, no gap to wait.
          state[w.session] = { told: now, at: prevAt }
          continue
        }
        // Until the line is in the schedule, the session has heard what it heard before it.
        state[w.session] = { told: base, at: prevAt }
        const next = replaced && pending ? pending.next : Math.max(ctx.now, prevAt + ctx.cfg.gapSec * 1000)
        schedule.add({
          key: targetKey,
          ...(w.name && { name: w.name }),
          text,
          at: next,
          next,
          by: 'asks',
          from: { ...ASKS_FROM },
          ...(w.wake ? {} : { noWake: true }),
          ...(w.idle && { idle: true }),
        })
        state[w.session] = { told: now, at: next, prevAt, base }
        told.push(w.session)
      } catch (err) {
        // One session's schedule full (or its line refused) never keeps the others from theirs.
        state[w.session] ??= had ?? { told: {}, at: 0 }
        log(`owner watch: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    // No fresh items: what each watcher was told stays as it was.
    for (const w of owners) if (before[w.session]) state[w.session] = before[w.session] as Heard
  }
  if (JSON.stringify(state) !== JSON.stringify(before)) {
    try {
      store(file, state)
    } catch (err) {
      log(`owner watch: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return told
}
