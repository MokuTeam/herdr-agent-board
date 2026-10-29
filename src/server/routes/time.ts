// Time entries for the page (#233, core/time.ts, adapters/time-store.ts). GET /api/time?date=<d>
// [&client=<lane>] answers that day by client, as billed, with its entries and what an entry may
// be (the lanes that take time, their projects, the tags entries have). POST /api/time { op: add |
// edit | move | remove | restore | raise | trim, … } changes one as the owner, who may change any
// (raise and trim bring a line's time worked to its billed figure, up or down, and say the figure
// the page showed: one the line no longer bills is refused). Every op on an entry says the
// revision it read (`rev`, an integer) and is refused when the entry changed since; times are ISO
// with an offset, within a day ahead and a year back. An error says its `code` (the text key's last
// part) beside its words. Not local-only: the board through the remote page and a paired phone read
// and change them as they do the cards. While time is off both answer 409; nothing is written
// while the config does not check out or before a backup went through (services/time.ts, as for
// `board time`). The web board keeps one connection to the database for its life (keepTimeDb).
import { existsSync } from 'node:fs'
import { type BoardDb, DbError, dbFile, openDb } from '../../adapters/db.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  addEntry,
  editEntry,
  listEntries,
  moveEntry,
  raiseEntry,
  removeEntry,
  restoreEntry,
  TimeError,
  trimLine,
  usedTags,
} from '../../adapters/time-store.ts'
import { t } from '../../core/lang.ts'
import type { TimePayload } from '../../core/payload.ts'
import {
  addDays,
  clientDay,
  dateIn,
  isDate,
  plausible,
  problemsText,
  secondsOf,
  type TimeConfig,
  type TimeEntry,
  timeConfig,
  zoneOf,
} from '../../core/time.ts'
import type { Config } from '../../core/types.ts'
import { writeRefusal } from '../../services/time.ts'
import { json, type Route } from '../http.ts'

let keep = false
let kept: { path: string; db: BoardDb } | null = null

/** The web board keeps one connection for its life (server/app.ts); elsewhere each call opens and closes its own. */
export function keepTimeDb(on: boolean): void {
  keep = on
  if (!on) dropKept()
}

function dropKept(): void {
  try {
    kept?.db.close()
  } catch {}
  kept = null
}

/**
 * The database for one call: the kept connection (opened when there is none, or when the file it
 * had is gone), or one of its own. A failure that is not a time refusal drops the kept one, so the
 * next call opens it afresh.
 */
function withDb<T>(create: boolean, fn: (db: BoardDb | null) => T): T {
  if (!keep) {
    const db = openDb({ create })
    try {
      return fn(db)
    } finally {
      db?.close()
    }
  }
  const path = dbFile()
  if (kept && (kept.path !== path || !existsSync(path))) dropKept()
  if (!kept) {
    const db = openDb({ create })
    if (!db) return fn(null)
    kept = { path, db }
  }
  try {
    return fn(kept.db)
  } catch (err) {
    if (!(err instanceof TimeError)) dropKept()
    throw err
  }
}

export interface TimeDayView {
  date: string
  /** The board's zone, the one a day without a client of its own is in. */
  zone: string
  days: ReturnType<typeof clientDay>[]
  entries: (TimeEntry & { seconds: number })[]
  /** config.json's `time` does not check out: the figures may be wrong, and no entry is written. */
  problems: string | null
  /** The lanes that take time (null: every lane) and each one's projects (null: any). */
  clients: string[] | null
  projects: Record<string, string[] | null>
  /** Tags to offer: the ones held out of the totals first, then the ones entries have, most used first. */
  tags: string[]
}

const projectsOf = (conf: TimeConfig): Record<string, string[] | null> =>
  Object.fromEntries(Object.entries(conf.clients ?? {}).map(([id, c]) => [id, c.projects]))

/** One day by client, as billed (every client with entries that day, or the one asked). */
export function timeDay(cfg: Pick<Config, 'time'>, date: string, client?: string): TimeDayView | null {
  const conf = timeConfig(cfg.time)
  if (!conf) return null
  const { entries, used } = withDb(false, db =>
    db
      ? { entries: listEntries(db, { from: date, to: date, ...(client && { client }) }), used: usedTags(db) }
      : { entries: [], used: [] },
  )
  const clients = [...new Set(entries.map(e => e.client))].sort()
  return {
    date,
    zone: conf.zone,
    problems: conf.problems.length ? problemsText(conf.problems, t) : null,
    days: clients.map(c =>
      clientDay(
        conf,
        c,
        date,
        entries.filter(e => e.client === c),
      ),
    ),
    entries: entries.map(e => ({ ...e, seconds: secondsOf(e) })),
    clients: conf.clients ? Object.keys(conf.clients) : null,
    projects: projectsOf(conf),
    tags: [...new Set([...conf.excludeTags, ...used])],
  }
}

let readFailed = ''

/**
 * The payload's time line: today's billed seconds by lane (today in each client's own zone) and
 * the journal's last seq; null while time is off. No database yet: nothing logged, nothing read.
 * A database that cannot be read (damaged, newer, locked by a scanner) is no reason to stop the
 * board: the line is empty (seq -1) and the reason logged once.
 */
export function timeToday(cfg: Pick<Config, 'time'>, now: number = Date.now()): TimePayload | null {
  const conf = timeConfig(cfg.time)
  if (!conf) return null
  const date = dateIn(now, conf.zone)
  const problems = conf.problems.length > 0
  try {
    return withDb(false, db => {
      if (!db) return { seq: 0, date, today: {}, ...(problems && { problems }) }
      // a client in its own zone may be a day ahead or behind the board's
      const entries = listEntries(db, { from: addDays(date, -1), to: addDays(date, 1) })
      const today: Record<string, number> = {}
      for (const c of new Set(entries.map(e => e.client))) {
        const own = dateIn(now, zoneOf(conf, c))
        const mine = entries.filter(e => e.client === c && e.date === own)
        if (mine.length) today[c] = clientDay(conf, c, own, mine).billedSeconds
      }
      const seq = db.lastChange().seq
      readFailed = ''
      return { seq, date, today, ...(problems && { problems }) }
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (why !== readFailed) console.error(`time: today's totals not read: ${why}`)
    readFailed = why
    return { seq: -1, date, today: {}, ...(problems && { problems }) }
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

/** A time the body gives: undefined when it gives none; refused when it is not ISO with an offset, or not one an entry may have. */
function when(v: unknown, now: number): number | undefined {
  if (v === undefined) return undefined
  const at = typeof v === 'string' && ISO.test(v) ? Date.parse(v) : Number.NaN
  if (Number.isNaN(at)) throw new TimeError('time.err.when', { value: String(v) })
  if (!plausible(at, now)) throw new TimeError('time.err.whenRange', { value: String(v) })
  return at
}

/** The revision the change read: required, an integer. */
function revOf(b: Record<string, unknown>): number {
  if (typeof b.rev !== 'number' || !Number.isInteger(b.rev)) throw new TimeError('time.err.rev')
  return b.rev
}

/** The billed figure a raise or a trim was asked for (the button's), when the body says it: whole seconds. */
function billedOf(b: Record<string, unknown>): { billed?: number } {
  if (b.billed === undefined) return {}
  if (typeof b.billed !== 'number' || !Number.isInteger(b.billed) || b.billed < 0) throw new TimeError('time.err.usage')
  return { billed: b.billed }
}

const MAX_TAGS = 20
function tagsOf(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > MAX_TAGS || !v.every(x => typeof x === 'string'))
    throw new TimeError('time.err.tags', { n: MAX_TAGS })
  return v
}

/** One change as the owner; the entry after it. */
function change(db: BoardDb, conf: TimeConfig, b: Record<string, unknown>, now: number): TimeEntry {
  const id = text(b.id) ?? ''
  switch (b.op) {
    case 'add': {
      const start = when(b.start, now)
      const stop = when(b.stop, now)
      if (start === undefined || stop === undefined) throw new TimeError('time.err.noDuration')
      return addEntry(
        db,
        conf,
        {
          client: text(b.client) ?? '',
          project: text(b.project) ?? '',
          description: text(b.description) ?? '',
          tags: tagsOf(b.tags) ?? [],
          start,
          stop,
          startGiven: true,
        },
        'user',
        now,
      ).entry
    }
    case 'edit': {
      const rev = revOf(b)
      const start = when(b.start, now)
      const stop = when(b.stop, now)
      const description = text(b.description)
      const project = text(b.project)
      const tags = tagsOf(b.tags)
      return editEntry(
        db,
        conf,
        id,
        {
          ...(description !== undefined && { description }),
          ...(project !== undefined && { project }),
          ...(start !== undefined && { start }),
          ...(stop !== undefined && { stop }),
          // the tags as the page's field holds them: the whole set
          ...(tags !== undefined && { tags }),
        },
        'user',
        { expect: rev },
      )
    }
    case 'move': {
      const rev = revOf(b)
      const date = text(b.date) ?? ''
      if (!isDate(date)) throw new TimeError('time.err.usage')
      const today = dateIn(now, conf.zone)
      if (date > addDays(today, 1) || date < addDays(today, -366))
        throw new TimeError('time.err.whenRange', { value: date })
      return moveEntry(db, conf, id, date, 'user', { expect: rev })
    }
    case 'remove':
      return removeEntry(db, id, 'user', { expect: revOf(b) })
    case 'restore':
      return restoreEntry(db, id, 'user', { expect: revOf(b) })
    case 'raise':
      return raiseEntry(db, conf, id, 'user', { expect: revOf(b), ...billedOf(b) })
    case 'trim':
      return trimLine(db, conf, id, 'user', { expect: revOf(b), ...billedOf(b) })
    default:
      throw new TimeError('time.err.usage')
  }
}

/** A refusal for the page: its words, and its code (notYours, changedSince…) for the page's own words. */
const refusal = (err: TimeError) => ({ ok: false, error: err.message, code: err.key.split('.').at(-1) })

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
    {
      method: 'POST',
      path: '/api/time',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const conf = timeConfig(cfg.time)
        if (!conf) return json(409, { ok: false, error: t('time.err.off') })
        const refused = writeRefusal(cfg, conf)
        if (refused) return json(409, refusal(refused))
        const raw = await ctx.rawBody()
        const b = isRecord(raw) ? raw : {}
        try {
          const entry = withDb(true, db => {
            if (!db) throw new TimeError('time.err.noDb')
            return change(db, conf, b, Date.now())
          })
          return json(200, { ok: true, entry: { ...entry, seconds: secondsOf(entry) } })
        } catch (err) {
          if (err instanceof TimeError) {
            const status = err.key === 'time.err.gone' ? 404 : err.key === 'time.err.changedSince' ? 409 : 400
            return json(status, refusal(err))
          }
          if (err instanceof DbError) return json(503, { ok: false, error: err.message })
          return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
  ]
}
