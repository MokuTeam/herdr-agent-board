// Time entries for the page (#233, core/time.ts, adapters/time-store.ts). GET /api/time?date=<d>
// [&client=<lane>] answers that day by client, as billed, with its entries and what an entry may
// be (the lanes that take time, their projects). POST /api/time { op: add | edit | move | remove |
// restore, … } changes one as the owner, who may change any; an edit or a move says the revision
// it read (`rev`) and is refused when the entry changed since. Not local-only: the board through
// the remote page and a paired phone read and change them as they do the cards. While time is off
// both answer 409; nothing is written before the database has a backup target and a passphrase.
import { readKey } from '../../adapters/backup-store.ts'
import { type BoardDb, DbError, openDb } from '../../adapters/db.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  addEntry,
  editEntry,
  listEntries,
  moveEntry,
  removeEntry,
  restoreEntry,
  TimeError,
} from '../../adapters/time-store.ts'
import { activeTargets, backupConfig } from '../../core/backup.ts'
import { t } from '../../core/lang.ts'
import type { TimePayload } from '../../core/payload.ts'
import {
  addDays,
  clientDay,
  dateIn,
  isDate,
  problemsText,
  secondsOf,
  type TimeConfig,
  type TimeEntry,
  timeConfig,
  zoneOf,
} from '../../core/time.ts'
import type { Config } from '../../core/types.ts'
import { json, type Route } from '../http.ts'

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
}

const projectsOf = (conf: TimeConfig): Record<string, string[] | null> =>
  Object.fromEntries(Object.entries(conf.clients ?? {}).map(([id, c]) => [id, c.projects]))

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
  let db: ReturnType<typeof openDb> = null
  try {
    db = openDb({ create: false })
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
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (why !== readFailed) console.error(`time: today's totals not read: ${why}`)
    readFailed = why
    return { seq: -1, date, today: {}, ...(problems && { problems }) }
  } finally {
    db?.close()
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const instant = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : at
}
const tagsOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

/** One change as the owner; the entry after it. */
function change(db: BoardDb, conf: TimeConfig, b: Record<string, unknown>): TimeEntry {
  const id = text(b.id) ?? ''
  const rev = typeof b.rev === 'number' && Number.isInteger(b.rev) ? b.rev : undefined
  const o = rev !== undefined ? { expect: rev } : {}
  switch (b.op) {
    case 'add': {
      const start = instant(b.start)
      const stop = instant(b.stop)
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
          newProject: b.newProject === true,
        },
        'user',
      ).entry
    }
    case 'edit': {
      const start = instant(b.start)
      const stop = instant(b.stop)
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
          ...(tags !== undefined && { tags }),
          newProject: b.newProject === true,
        },
        'user',
        o,
      )
    }
    case 'move': {
      const date = text(b.date) ?? ''
      if (!isDate(date)) throw new TimeError('time.err.usage')
      return moveEntry(db, conf, id, date, 'user', o)
    }
    case 'remove':
      return removeEntry(db, id, 'user')
    case 'restore':
      return restoreEntry(db, id, 'user')
    default:
      throw new TimeError('time.err.usage')
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
    {
      method: 'POST',
      path: '/api/time',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const conf = timeConfig(cfg.time)
        if (!conf) return json(409, { ok: false, error: t('time.err.off') })
        if (!activeTargets(backupConfig(cfg.backup)).length || !readKey())
          return json(409, { ok: false, error: t('time.err.noBackup') })
        const raw = await ctx.rawBody()
        const b = isRecord(raw) ? raw : {}
        let db: BoardDb | null = null
        try {
          db = openDb()
          if (!db) return json(500, { ok: false, error: t('time.err.noDb') })
          const entry = change(db, conf, b)
          return json(200, { ok: true, entry: { ...entry, seconds: secondsOf(entry) } })
        } catch (err) {
          if (err instanceof TimeError) {
            const status = err.key === 'time.err.gone' ? 404 : err.key === 'time.err.changedSince' ? 409 : 400
            return json(status, { ok: false, error: err.message })
          }
          if (err instanceof DbError) return json(503, { ok: false, error: err.message })
          return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        } finally {
          db?.close()
        }
      },
    },
  ]
}
