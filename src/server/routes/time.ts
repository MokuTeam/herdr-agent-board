// Time entries for the page (#233, core/time.ts, adapters/time-store.ts): GET /api/time?date=<d>
// [&client=<lane>] answers that day by client, as billed, with its entries. Not local-only: the
// board through the remote page and a paired phone read it as they read the cards. While time is
// off it answers 409.
import { openDb } from '../../adapters/db.ts'
import { listEntries } from '../../adapters/time-store.ts'
import { t } from '../../core/lang.ts'
import type { TimePayload } from '../../core/payload.ts'
import { clientDay, dateIn, isDate, secondsOf, type TimeEntry, timeConfig } from '../../core/time.ts'
import type { Config } from '../../core/types.ts'
import { json, type Route } from '../http.ts'

export interface TimeDayView {
  date: string
  /** The board's zone, the one a day without a client of its own is in. */
  zone: string
  days: ReturnType<typeof clientDay>[]
  entries: (TimeEntry & { seconds: number })[]
}

/** One day by client, as billed (every client with entries that day, or the one asked). */
export function timeDay(cfg: Pick<Config, 'time'>, date: string, client?: string): TimeDayView | null {
  const conf = timeConfig(cfg.time)
  if (!conf) return null
  const db = openDb({ create: false })
  let entries: TimeEntry[] = []
  try {
    entries = db ? listEntries(db, { from: date, to: date, ...(client && { client }) }) : []
  } finally {
    db?.close()
  }
  const clients = [...new Set(entries.map(e => e.client))].sort()
  return {
    date,
    zone: conf.zone,
    days: clients.map(c =>
      clientDay(
        conf,
        c,
        date,
        entries.filter(e => e.client === c),
      ),
    ),
    entries: entries.map(e => ({ ...e, seconds: secondsOf(e) })),
  }
}

/**
 * The payload's time line: today's billed seconds by lane and the journal's last seq; null while
 * time is off. No database yet: nothing logged, nothing read.
 */
export function timeToday(cfg: Pick<Config, 'time'>, now: number = Date.now()): TimePayload | null {
  const conf = timeConfig(cfg.time)
  if (!conf) return null
  const date = dateIn(now, conf.zone)
  let db: ReturnType<typeof openDb>
  try {
    db = openDb({ create: false })
  } catch {
    // a damaged or newer file: the board goes on without the totals; the backup's line says why
    return { seq: -1, date, today: {} }
  }
  if (!db) return { seq: 0, date, today: {} }
  try {
    const entries = listEntries(db, { from: date, to: date })
    const today: Record<string, number> = {}
    for (const c of new Set(entries.map(e => e.client)))
      today[c] = clientDay(
        conf,
        c,
        date,
        entries.filter(e => e.client === c),
      ).billedSeconds
    return { seq: db.lastChange().seq, date, today }
  } finally {
    db.close()
  }
}

export function timeRoutes(cfg: Config): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/time',
      async handle(_req, ctx) {
        const url = ctx.url
        const conf = timeConfig(cfg.time)
        if (!conf) return json(409, { ok: false, error: t('time.err.off') })
        const date = url.searchParams.get('date') || dateIn(Date.now(), conf.zone)
        if (!isDate(date)) return json(400, { ok: false, error: t('time.err.usage') })
        const client = url.searchParams.get('client') || undefined
        try {
          return json(200, timeDay(cfg, date, client))
        } catch (err) {
          return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
  ]
}
