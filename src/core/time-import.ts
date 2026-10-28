// Toggl's history into the board (#233): the Detailed report as Toggl's web page exports it (CSV,
// no API call, so no quota), or Toggl's JSON (API v9 time entries with their project and client
// names). Each row becomes an entry for the lane its Toggl client is mapped to. Keyed by Toggl's
// entry id when the file has one; a CSV without an id column gets a key of its own from the
// client, project, description, start and duration, so a second run of the same export finds
// every row already there. Pure, with no node: import.

/** One Toggl row as read, before it is mapped to a lane. */
export interface TogglRow {
  /** Toggl's id, or the key made from the row (`csv:` and a hash-like string). */
  key: string
  client: string
  project: string
  description: string
  tags: string[]
  start: number
  stop: number
  /** A row of a timer still running: skipped. */
  running: boolean
}

/** CSV text into rows of fields: quotes, doubled quotes, commas and line breaks inside quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const body = text.replace(/^﻿/, '')
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some(f => f !== '')) rows.push(row)
  return rows
}

/** A short, stable key of a string (FNV-1a, 64 bits as two 32-bit halves), for rows without an id. */
function keyOf(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/** "1:02:03" or "62:03" as seconds; NaN otherwise. */
function clockSeconds(s: string): number {
  const parts = s.trim().split(':').map(Number)
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return Number.NaN
  return parts.reduce((total, n) => total * 60 + n, 0)
}

/**
 * The instant a date and a time without an offset mean in a time zone (the Toggl profile's), by
 * the zone's own rules: `instantIn` of core/time.ts.
 */
export type ZonedInstant = (date: string, clock: [number, number, number]) => number

/** Toggl's date as the Detailed report writes it: YYYY-MM-DD, or MM/DD/YYYY. */
function isoDate(s: string): string | null {
  const v = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
  return m ? `${m[3]}-${(m[1] ?? '').padStart(2, '0')}-${(m[2] ?? '').padStart(2, '0')}` : null
}

/**
 * The Detailed report's CSV as rows: the columns found by their header (case and spacing aside),
 * the start in the profile's zone (`zoned`), the stop from the end date and time, else from the
 * duration. A row it cannot read is returned in `bad` by its line number.
 */
export function rowsFromCsv(text: string, zoned: ZonedInstant): { rows: TogglRow[]; bad: number[]; missing: string[] } {
  const all = csvRows(text)
  const head = (all[0] ?? []).map(h => h.trim().toLowerCase().replace(/\s+/g, ' '))
  const col = (...names: string[]): number => head.findIndex(h => names.includes(h))
  const c = {
    id: col('id', 'time entry id', 'entry id'),
    client: col('client'),
    project: col('project'),
    description: col('description'),
    startDate: col('start date'),
    startTime: col('start time'),
    endDate: col('end date'),
    endTime: col('end time'),
    duration: col('duration'),
    tags: col('tags'),
  }
  const missing: string[] = (['client', 'project', 'description', 'startDate', 'startTime'] as const).filter(
    k => c[k] < 0,
  )
  if (c.endTime < 0 && c.duration < 0) missing.push('duration')
  if (missing.length) return { rows: [], bad: [], missing }
  const rows: TogglRow[] = []
  const bad: number[] = []
  all.slice(1).forEach((r, i) => {
    const get = (n: number): string => (n >= 0 ? (r[n] ?? '').trim() : '')
    const date = isoDate(get(c.startDate))
    const time = clockSeconds(get(c.startTime))
    if (!date || !Number.isFinite(time)) {
      bad.push(i + 2)
      return
    }
    const start = zoned(date, [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60])
    let stop = Number.NaN
    const endDate = isoDate(get(c.endDate))
    const endTime = clockSeconds(get(c.endTime))
    if (endDate && Number.isFinite(endTime))
      stop = zoned(endDate, [Math.floor(endTime / 3600), Math.floor(endTime / 60) % 60, endTime % 60])
    else if (Number.isFinite(clockSeconds(get(c.duration)))) stop = start + clockSeconds(get(c.duration)) * 1000
    const running = !Number.isFinite(stop) || get(c.endTime) === '' || stop <= start
    const tags = get(c.tags)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const fields = { client: get(c.client), project: get(c.project), description: get(c.description) }
    const id = get(c.id)
    rows.push({
      key: id || `csv:${keyOf([fields.client, fields.project, fields.description, start, stop].join('\u0000'))}`,
      ...fields,
      tags,
      start,
      stop: Number.isFinite(stop) ? stop : start,
      running,
    })
  })
  return { rows, bad, missing: [] }
}

/** Toggl's JSON: a list of time entries (API v9, with `meta=true` for the names), or `{ time_entries: [...] }`. */
export function rowsFromJson(value: unknown): { rows: TogglRow[]; bad: number[] } {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>).time_entries)
      ? ((value as Record<string, unknown>).time_entries as unknown[])
      : []
  const rows: TogglRow[] = []
  const bad: number[] = []
  list.forEach((v, i) => {
    const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
    const start = Date.parse(s('start'))
    let stop = Date.parse(s('stop'))
    const duration = Number(o.duration)
    if (Number.isNaN(stop) && Number.isFinite(duration) && duration > 0) stop = start + duration * 1000
    const id = typeof o.id === 'number' || typeof o.id === 'string' ? String(o.id) : ''
    if (Number.isNaN(start) || !id) {
      bad.push(i)
      return
    }
    const running = Number.isNaN(stop) || (Number.isFinite(duration) && duration < 0)
    rows.push({
      key: id,
      client: s('client_name') || s('client'),
      project: s('project_name') || s('project'),
      description: s('description'),
      tags: Array.isArray(o.tags) ? o.tags.filter((x): x is string => typeof x === 'string') : [],
      start,
      stop: Number.isNaN(stop) ? start : stop,
      running,
    })
  })
  return { rows, bad }
}

/** `--map "<Toggl client>=<lane>"`: Toggl's client names (case aside; empty: no client) to lanes. */
export function parseMap(values: readonly string[]): Map<string, string> | string {
  const map = new Map<string, string>()
  for (const v of values) {
    const at = v.lastIndexOf('=')
    if (at < 0) return v
    const lane = v.slice(at + 1).trim()
    if (!lane) return v
    map.set(v.slice(0, at).trim().toLowerCase(), lane)
  }
  return map
}

/** Per day and lane: how many entries and seconds, for `--dry-run` to hold against Toggl's report. */
export function dayTotals(rows: readonly { date: string; client: string; seconds: number }[]): {
  date: string
  client: string
  entries: number
  seconds: number
}[] {
  const by = new Map<string, { date: string; client: string; entries: number; seconds: number }>()
  for (const r of rows) {
    const key = `${r.date}\u0000${r.client}`
    const now = by.get(key) ?? { date: r.date, client: r.client, entries: 0, seconds: 0 }
    now.entries++
    now.seconds += r.seconds
    by.set(key, now)
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.client < b.client ? -1 : 1))
}
