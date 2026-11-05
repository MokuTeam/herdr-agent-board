// The calendar (#328) at work: a source's events fetched into its copy, the web board's timer that
// keeps each source fresh on its own interval, and the events of a window read from every source
// at once (the panel, `board cal list`). core/calendar.ts has the rules, the adapters the files,
// the database and the network.
//
// Off (no `calendar` in config.json, or `on: false`): createCalendarSync keeps no timer and reads
// nothing; configChanged starts or stops it as the config changes. A fetch that fails keeps the
// last good copy and says why beside it; the next try waits longer each time it fails again
// (twice the interval, four times… up to an hour).
import { existsSync } from 'node:fs'
import {
  copiesStamp,
  makeSecretDir,
  readCopy,
  readIcsAddress,
  removeCopy,
  type SourceCopy,
  writeCopy,
} from '../adapters/calendar-cache.ts'
import { FetchError, fetchIcs, McpClient } from '../adapters/calendar-fetch.ts'
import { CalError, lastCalendarChange, listBoardEvents } from '../adapters/calendar-store.ts'
import { type BoardDb, dbFile, openDb } from '../adapters/db.ts'
import {
  BOARD_SOURCE,
  byStart,
  type CalEvent,
  type CalendarConfig,
  type CalSource,
  calendarConfig,
  eventOf,
  fetchedSources,
  inWindow,
  problemsText,
  syncWindow,
  writesToProvider,
} from '../core/calendar.ts'
import { googleEvents, googleListArgs, type NextPage } from '../core/calendar-google.ts'
import { icsEvents } from '../core/calendar-ics.ts'
import { t } from '../core/lang.ts'
import type { CalendarPayload } from '../core/payload.ts'
import { localZone } from '../core/time.ts'
import type { Config } from '../core/types.ts'

export const calendarOf = (cfg: Pick<Config, 'calendar'>): CalendarConfig | null => calendarConfig(cfg.calendar)

// ------------------------------------------------------------------ the database

let keep = false
let kept: { path: string; db: BoardDb } | null = null

/** The web board keeps one connection while the calendar is on (server/app.ts); a command opens and closes its own. */
export function keepCalendarDb(on: boolean): void {
  keep = on
  if (!on) dropKept()
}

function dropKept(): void {
  try {
    kept?.db.close()
  } catch {}
  kept = null
}

/** The database for one call (null: there is none and `create` is false). */
export function withCalendarDb<T>(create: boolean, fn: (db: BoardDb | null) => T): T {
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
    if (!(err instanceof CalError)) dropKept()
    throw err
  }
}

// ------------------------------------------------------------------ fetching

/** Strings in a generic list tool's arguments with `{from}` and `{to}` filled in (ISO, UTC). */
export function fillWindow(v: unknown, from: number, to: number): unknown {
  const iso = (at: number) => new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')
  if (typeof v === 'string') return v.replaceAll('{from}', iso(from)).replaceAll('{to}', iso(to))
  if (Array.isArray(v)) return v.map(x => fillWindow(x, from, to))
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillWindow(x, from, to)]))
  return v
}

/** A generic tool's events: its structured content, or its text as JSON; a list, or `{ events: [...] }`. */
function genericEvents(structured: unknown, text: string, source: string): CalEvent[] {
  const listOf = (v: unknown): unknown[] | null =>
    Array.isArray(v)
      ? v
      : v && typeof v === 'object' && Array.isArray((v as { events?: unknown }).events)
        ? (v as { events: unknown[] }).events
        : null
  let list = listOf(structured)
  if (!list) {
    try {
      list = listOf(JSON.parse(text))
    } catch {}
  }
  if (!list) throw new FetchError(t('cal.err.noEventsInAnswer'))
  return list.map(e => eventOf(e, source)).filter((e): e is CalEvent => e !== null)
}

/** The most pages one calendar is read in: 250 events each. */
const MAX_PAGES = 20

/** A source's events in [from, to) from its provider. */
export async function fetchSource(
  source: CalSource,
  from: number,
  to: number,
  zone: string,
  o: { address?: string } = {},
): Promise<CalEvent[]> {
  if (source.kind === 'ics') {
    const url = o.address ?? readIcsAddress(source.id)
    if (!url) throw new CalError('cal.err.noAddress', { source: source.id })
    const text = await fetchIcs(url)
    return icsEvents(text, { source: source.id, from, to, zone, account: source.account })
  }
  if (source.kind !== 'mcp' || !source.url) throw new CalError('cal.err.notFetched', { source: source.id })
  const client = new McpClient(source.url)
  try {
    if (source.preset === 'google-workspace') {
      const out: CalEvent[] = []
      for (const calendar of source.calendars) {
        let page: NextPage | null = null
        for (let n = 0; n < MAX_PAGES; n++) {
          const answer = await client.call('get_events', googleListArgs(source, calendar, from, to, page))
          if (answer.isError) throw new FetchError(firstLine(answer.text))
          const read = googleEvents(answer.text, source)
          if (!read.events.length && !/^\s*(Successfully|No events)/i.test(answer.text))
            throw new FetchError(firstLine(answer.text) || t('cal.err.noEventsInAnswer'))
          // the answer says how many it has: far fewer read means its form changed, and the last
          // good copy stays rather than an empty one
          if (read.said !== null && read.said > 0 && read.events.length < Math.ceil(read.said / 2))
            throw new FetchError(t('cal.err.unreadAnswer', { read: read.events.length, said: read.said }))
          // one calendar's events, several calendars: an id unique within the source
          out.push(
            ...(source.calendars.length > 1 && calendar !== 'primary'
              ? read.events.map(e => ({ ...e, id: `${calendar}/${e.id}` }))
              : read.events),
          )
          page = read.next
          if (!page) break
        }
      }
      return dedupe(out)
    }
    if (!source.list) throw new CalError('cal.err.notFetched', { source: source.id })
    const answer = await client.call(
      source.list.tool,
      fillWindow(source.list.args, from, to) as Record<string, unknown>,
    )
    if (answer.isError) throw new FetchError(firstLine(answer.text))
    return dedupe(genericEvents(answer.structured, answer.text, source.id)).filter(e => inWindow(e, from, to, zone))
  } finally {
    await client.close()
  }
}

const firstLine = (s: string): string => (s.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 300)

/** One event per id: the last one given wins. */
function dedupe(events: CalEvent[]): CalEvent[] {
  return [...new Map(events.map(e => [e.id, e])).values()]
}

/** An error's words as a copy keeps them: never the address, one line, short. */
function errorWords(err: unknown, secret: string | null): string {
  let s = err instanceof Error ? err.message : String(err)
  if (secret) s = s.replaceAll(secret, '<address>')
  return s.replace(/\s+/g, ' ').trim().slice(0, 300) || 'failed'
}

export interface SyncResult {
  source: string
  ok: boolean
  count: number
  error?: string
}

/** The copy of a source with nothing in it yet. */
const emptyCopy = (source: string): SourceCopy => ({
  source,
  from: 0,
  to: 0,
  events: [],
  lastOk: null,
  lastTry: null,
  error: null,
  fails: 0,
})

/** One source fetched for the sync window and its copy written: the new events, or the old ones and the error. */
export async function syncSource(
  c: CalendarConfig,
  source: CalSource,
  now: number = Date.now(),
  zone: string = localZone(),
): Promise<SyncResult> {
  const { from, to } = syncWindow(c, now, zone)
  const before = readCopy(source.id) ?? emptyCopy(source.id)
  try {
    const events = await fetchSource(source, from, to, zone)
    writeCopy({ source: source.id, from, to, events, lastOk: now, lastTry: now, error: null, fails: 0 })
    return { source: source.id, ok: true, count: events.length }
  } catch (err) {
    const error = errorWords(err, source.kind === 'ics' ? readIcsAddress(source.id) : null)
    // no address yet is no failure of the source: looked at again on its interval, not later each time
    const unset = err instanceof CalError && err.code === 'noAddress'
    writeCopy({ ...before, lastTry: now, error, fails: unset ? 0 : before.fails + 1 })
    return { source: source.id, ok: false, count: before.events.length, error }
  }
}

/** A pushed source's copy: the events given for [from, to), the ones outside it kept. */
export function pushEvents(
  source: CalSource,
  raw: unknown[],
  from: number,
  to: number,
  zone: string,
  now = Date.now(),
) {
  const before = readCopy(source.id) ?? emptyCopy(source.id)
  const given = dedupe(raw.map(e => eventOf(e, source.id)).filter((e): e is CalEvent => e !== null))
  const kept = before.events.filter(e => !inWindow(e, from, to, zone))
  const events = dedupe([...kept, ...given])
  writeCopy({
    source: source.id,
    from: before.lastOk ? Math.min(before.from, from) : from,
    to: before.lastOk ? Math.max(before.to, to) : to,
    events,
    lastOk: now,
    lastTry: now,
    error: null,
    fails: 0,
  })
  return { source: source.id, given: given.length, skipped: raw.length - given.length, total: events.length }
}

/** When a source is due again: its interval after its last try, longer after each failure in a row (an hour at most). */
export function dueAt(copy: SourceCopy | null, s: Pick<CalSource, 'everyMin'>): number {
  if (!copy?.lastTry) return 0
  const minutes = copy.fails ? Math.min(s.everyMin * 2 ** copy.fails, Math.max(60, s.everyMin)) : s.everyMin
  return copy.lastTry + minutes * 60_000
}

// ------------------------------------------------------------------ reading

/** A source as Settings, the panel and `board cal sources` show it. */
export interface SourceView {
  id: string
  kind: CalSource['kind']
  label: string
  color: string | null
  lane: string | null
  everyMin: number
  /** mcp: the server's address (never an ICS one: that is a secret). */
  url: string | null
  preset: string | null
  account: string | null
  calendars: string[]
  /** It takes writes to its provider (only for an event the owner asked for). */
  writes: boolean
  /** ics: whether its address is set. */
  address: boolean | null
  lastOk: number | null
  lastTry: number | null
  error: string | null
  fails: number
  /** Events in its copy. */
  count: number
  /** The window its copy holds. */
  from: number | null
  to: number | null
  problems: string | null
}

export function sourceViews(c: CalendarConfig, db: BoardDb | null = null): SourceView[] {
  return c.sources.map(s => {
    const copy = s.kind === 'board' ? null : readCopy(s.id)
    const boardCount =
      s.kind === 'board' && db
        ? ((db.db.query('SELECT COUNT(*) AS n FROM cal_events WHERE deleted IS NULL').get() as { n: number })?.n ?? 0)
        : 0
    return {
      id: s.id,
      kind: s.kind,
      label: s.label,
      color: s.color,
      lane: s.lane,
      everyMin: s.everyMin,
      url: s.kind === 'mcp' ? s.url : null,
      preset: s.preset,
      account: s.account,
      calendars: s.calendars,
      writes: s.kind === 'board' || writesToProvider(s),
      address: s.kind === 'ics' ? !!readIcsAddress(s.id) : null,
      lastOk: copy?.lastOk ?? null,
      lastTry: copy?.lastTry ?? null,
      error: copy?.error ?? null,
      fails: copy?.fails ?? 0,
      count: s.kind === 'board' ? boardCount : (copy?.events.length ?? 0),
      from: copy?.lastOk ? copy.from : null,
      to: copy?.lastOk ? copy.to : null,
      problems: s.problems.length ? problemsText(s.problems, t) : null,
    }
  })
}

export interface ReadOptions {
  /** Only these sources. */
  sources?: readonly string[] | undefined
  /** Cancelled events too. */
  cancelled?: boolean
}

/** Every source's events that touch [from, to), in order; a source's copy as it was last fetched. */
export function readEvents(
  c: CalendarConfig,
  db: BoardDb | null,
  from: number,
  to: number,
  zone: string,
  o: ReadOptions = {},
): CalEvent[] {
  const wanted = (id: string) => !o.sources?.length || o.sources.includes(id)
  const out: CalEvent[] = []
  if (db && wanted(BOARD_SOURCE)) out.push(...listBoardEvents(db, from, to, zone))
  for (const s of c.sources) {
    if (s.kind === 'board' || !wanted(s.id)) continue
    const copy = readCopy(s.id)
    if (copy) out.push(...copy.events.filter(e => inWindow(e, from, to, zone)))
  }
  return out.filter(e => o.cancelled || e.status !== 'cancelled').sort(byStart(zone))
}

/** A source's copy and file gone (a source removed in Settings). */
export const forgetSource = (id: string): void => removeCopy(id)

// ------------------------------------------------------------------ the web board's sync

export interface CalendarSync {
  /** config.json changed: the timer started or stopped as the calendar is on or off. */
  configChanged(): void
  /** Sources fetched now, all of those fetched or the one named; their results. */
  syncNow(id?: string): Promise<SyncResult[]>
  /** The sources being fetched right now. */
  busy(): string[]
  /** The payload's line: null while the calendar is off. */
  line(): CalendarPayload | null
  stop(): void
}

interface SyncOptions {
  cfg: Pick<Config, 'calendar'>
  log(msg: string): void
  /** Something the page shows changed (a copy written). */
  onChange(): void
  now?: () => number
  /** How often the timer looks for a source that is due (30 s). */
  tickMs?: number
  zone?: () => string
}

/** How far ahead the payload's next call is looked for. */
const NEXT_AHEAD_MS = 12 * 3_600_000
/** How often the next call is worked out again when nothing changed. */
const NEXT_EVERY_MS = 30_000

export function createCalendarSync({
  cfg,
  log,
  onChange,
  now = Date.now,
  tickMs = 30_000,
  zone = localZone,
}: SyncOptions): CalendarSync {
  let timer: ReturnType<typeof setInterval> | undefined
  const running = new Map<string, Promise<SyncResult>>()
  let lineCache: { stamp: string; at: number; line: CalendarPayload } | null = null

  const run = (s: CalSource, c: CalendarConfig): Promise<SyncResult> => {
    const had = running.get(s.id)
    if (had) return had
    const p = syncSource(c, s, now(), zone())
      .then(r => {
        if (!r.ok) log(`calendar: ${s.id}: ${r.error}`)
        return r
      })
      // the copy itself could not be written (a full disk, a rename a scanner holds): said, never thrown
      .catch((err: unknown): SyncResult => {
        const error = err instanceof Error ? err.message : String(err)
        log(`calendar: ${s.id}: ${error}`)
        return { source: s.id, ok: false, count: 0, error }
      })
      .finally(() => {
        running.delete(s.id)
        onChange()
      })
    running.set(s.id, p)
    onChange()
    return p
  }

  const tick = (): void => {
    const c = calendarOf(cfg)
    if (!c) return
    for (const s of fetchedSources(c)) if (!running.has(s.id) && now() >= dueAt(readCopy(s.id), s)) void run(s, c)
  }

  const configChanged = (): void => {
    const c = calendarOf(cfg)
    const on = !!c
    keepCalendarDb(on)
    // the folder the `calendar` sink writes an ICS address into: a form submitted on the board finds it there
    if (c?.sources.some(s => s.kind === 'ics')) {
      try {
        makeSecretDir()
      } catch (err) {
        log(`calendar: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (on && !timer) {
      timer = setInterval(tick, tickMs)
      tick()
    } else if (!on && timer) {
      clearInterval(timer)
      timer = undefined
      lineCache = null
    }
  }

  return {
    configChanged,
    async syncNow(id) {
      const c = calendarOf(cfg)
      if (!c) return []
      const list = fetchedSources(c).filter(s => !id || s.id === id)
      return Promise.all(list.map(s => run(s, c)))
    },
    busy: () => [...running.keys()],
    line() {
      const c = calendarOf(cfg)
      if (!c) return null
      let seq = 0
      try {
        seq = existsSync(dbFile()) ? withCalendarDb(false, db => (db ? lastCalendarChange(db) : 0)) : 0
      } catch {
        seq = -1
      }
      const stamp = `${copiesStamp()}.${seq}.${running.size}`
      const at = now()
      if (lineCache && lineCache.stamp === stamp && at - lineCache.at < NEXT_EVERY_MS) return lineCache.line
      const line: CalendarPayload = {
        rev: stamp,
        busy: running.size > 0,
        failing: c.sources.filter(s => s.problems.length || (readCopy(s.id)?.fails ?? 0) > 0).length,
        next: null,
      }
      try {
        const events = withCalendarDb(false, db => readEvents(c, db, at - NEXT_AHEAD_MS, at + NEXT_AHEAD_MS, zone()))
        const next = events.find(
          e => !e.allDay && Date.parse(e.end) > at && e.response !== 'declined' && (!e.kind || e.kind === 'default'),
        )
        if (next) {
          const s = c.sources.find(x => x.id === next.source)
          line.next = {
            source: next.source,
            id: next.id,
            title: next.title,
            start: next.start,
            end: next.end,
            ...(next.join && { join: next.join }),
            label: s?.label ?? next.source,
            color: s?.color ?? null,
            lane: s?.lane ?? null,
          }
        }
      } catch (err) {
        log(`calendar: ${err instanceof Error ? err.message : String(err)}`)
      }
      lineCache = { stamp, at, line }
      return line
    },
    stop() {
      clearInterval(timer)
      timer = undefined
      keepCalendarDb(false)
    },
  }
}
