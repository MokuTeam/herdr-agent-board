// A MokuPilot day's thread watches follow it to its next conversation (#403). A day that starts a
// new conversation (a new day, or MokuPilot rotating a long one) has a new Claude session id, and
// watches are kept by session. After each refresh the web board looks at the day's card: when its
// session is not the one it saw last, it reads the day's earlier conversations from MokuPilot's
// day folder (adapters/mokupilot-day.ts dayPredecessors) and moves their watches to it
// (services/work-threads.ts carryWatches). No day card on the board: nothing is read or written.
// One that is still a card of its own (a session that runs on, not the day's) keeps its watches.
// A day folder that does not name the card's session yet, or a carry that failed, is looked at
// again on the next refreshes, TRIES of them at most; the first failure is logged.

import type { BoardDb } from '../adapters/db.ts'
import { dayPredecessors } from '../adapters/mokupilot-day.ts'
import type { Item } from '../core/types.ts'
import type { ThreadsConfig } from '../core/work-threads.ts'
import { carryWatches, type EventSchedule } from './work-threads.ts'

export interface DayWatchCtx {
  db: BoardDb | null
  cfg: ThreadsConfig
  /** The board's items as the last refresh collected them; null when it failed. */
  items: readonly Item[] | null
  now: number
  /** The tests' day folder and schedule. */
  predecessors?: (session: string) => string[] | null
  schedule?: EventSchedule
  log?: (line: string) => void
}

/** How many refreshes a day's card is looked at again for, about a minute at the default 2 s. */
export const TRIES = 30

/** The web board's tick: called after each refresh; how many watches it moved. */
export function dayWatchTick(): (ctx: DayWatchCtx) => number {
  let seen = ''
  let trying = { key: '', n: 0 }
  return ctx => {
    if (!ctx.items) return 0
    const day = ctx.items.find(i => i.day && i.session)
    if (!day || day.key === seen) return 0
    if (trying.key !== day.key) trying = { key: day.key, n: 0 }
    if (++trying.n >= TRIES) seen = day.key
    if (!ctx.db) return 0
    const log = ctx.log ?? (() => {})
    try {
      const live = new Set(ctx.items.filter(i => i !== day).flatMap(i => [i.key, i.session ?? '']))
      const found = (ctx.predecessors ?? dayPredecessors)(day.key)
      if (!found) return 0
      seen = day.key
      const from = found.filter(s => !live.has(s))
      if (!from.length) return 0
      const name = day.name || day.key.slice(0, 8)
      const to = { kind: 'session' as const, key: day.key, name }
      const moved = carryWatches(
        { db: ctx.db, cfg: ctx.cfg, actor: to, now: ctx.now, ...(ctx.schedule && { schedule: ctx.schedule }) },
        to,
        from,
      )
      if (moved) log(`day watches: ${moved} moved to ${name}`)
      return moved
    } catch (err) {
      seen = trying.n >= TRIES ? day.key : ''
      if (trying.n === 1) log(`day watches: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }
}
