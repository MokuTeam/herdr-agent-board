// Times for the board's scheduler, in local time: when a one-off reminder is due ("in 30m",
// "at 15:30", "tomorrow 9:00", "fri 17:00", "2026-10-20 14:00") and when a cron schedule
// (5 fields, or @daily and the like) runs next.
//
// Local time is the owner's (#806): config.json's `time.zone` where it names a zone other than the
// computer's (scheduleZone), so a board on a server in UTC keeps the owner's clock and a master
// handover never shifts a schedule. Without one, or with the computer's own zone, the computer's
// local time, as before: the same code as before, no zone is looked up.
import { clockIn, dateIn, instantIn, knownZone, localZone } from './time.ts'

type Unit = 's' | 'm' | 'h' | 'd' | 'w'
type Clock = { h: number; min: number }

const UNIT_MS: Record<Unit, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }
const UNIT_WORDS: [RegExp, Unit][] = [
  [/^(s|secs?|seconds?)$/, 's'],
  [/^(m|mins?|minutes?)$/, 'm'],
  [/^(h|hrs?|hours?)$/, 'h'],
  [/^(d|days?)$/, 'd'],
  [/^(w|wks?|weeks?)$/, 'w'],
]
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// A date without a time of day: the morning, so "tomorrow" does not ring at midnight.
const MORNING: Clock = { h: 9, min: 0 }

/** "1h30m", "90 min", "2 hours", "1.5h" in milliseconds, or null. */
export function parseDuration(text: string): number | null {
  let rest = String(text ?? '').trim()
  let ms = 0
  let any = false
  while (rest) {
    const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]+)\s*(?:and\s+|,\s*)?/.exec(rest)
    const unit = m && UNIT_WORDS.find(([re]) => re.test(m[2] ?? ''))?.[1]
    if (!m || !unit) return null
    ms += Number((m[1] ?? '').replace(',', '.')) * UNIT_MS[unit]
    any = true
    rest = rest.slice(m[0].length)
  }
  return any ? Math.round(ms) : null
}

/** "15:30", "9.05", "3pm", "3:30pm"; a bare hour ("9") only when `bare` (it followed "at"). */
function clockOf(word: string, bare: boolean): Clock | null {
  const m = /^(\d{1,2})(?:[:.h](\d{2})(?::(\d{2}))?)?(am|pm)?$/.exec(word)
  if (!m || (m[2] === undefined && !m[4] && !bare)) return null
  let h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (m[4]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[4] === 'pm' ? 12 : 0)
  }
  return h > 23 || min > 59 ? null : { h, min }
}

/** today = 0, tomorrow = 1, a weekday = { dow }, else null. */
type Day = number | { dow: number }

/** A day word of parseWhen's: today, tonight, tomorrow, a weekday; null for any other word. */
export function dayOf(word: string): Day | null {
  if (word === 'today' || word === 'tonight') return 0
  if (word === 'tomorrow' || word === 'tmrw') return 1
  const dow = DAY_NAMES.indexOf(word.slice(0, 3))
  return dow >= 0 && /^[a-z]{3,9}$/.test(word) && (word.length === 3 || DAY_FULL[dow]?.startsWith(word))
    ? { dow }
    : null
}
const DAY_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const at = (base: Date, dayOffset: number, { h, min }: Clock): number =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, min).getTime()

/**
 * The zone the schedule reads its times in (#806): `time.zone` of config.json when it is a zone
 * Intl knows and not the computer's own; undefined (the computer's local time) otherwise.
 */
export function scheduleZone(time: unknown): string | undefined {
  if (typeof time !== 'object' || time === null) return undefined
  const raw = (time as { zone?: unknown }).zone
  const zone = typeof raw === 'string' ? raw.trim() : ''
  return zone && knownZone(zone) && zone !== localZone() ? zone : undefined
}

/** A date by its year, month (0-11) and day, which may run past the month's end, as YYYY-MM-DD. */
const dateOf = (y: number, mo: number, d: number): string => new Date(Date.UTC(y, mo, d)).toISOString().slice(0, 10)

/** The date of an instant in a zone: year, month (0-11), day and weekday. */
function dayIn(ms: number, zone: string): { y: number; mo: number; d: number; dow: number } {
  const [y, m, d] = dateIn(ms, zone).split('-').map(Number) as [number, number, number]
  return { y, mo: m - 1, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
}

/**
 * When a reminder is due, in ms, or null when `text` is not a time. A time of day alone is its
 * next occurrence (tomorrow when it has passed today); everything else is taken as written, so
 * the caller checks that it is in the future.
 */
export function parseWhen(text: string, now = Date.now(), zone?: string): number | null {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(\d) (am|pm)\b/g, '$1$2')
    .trim()
  if (!s) return null
  let m = /^(?:in|\+) ?(.+)$/.exec(s)
  if (m) {
    const ms = parseDuration(m[1] ?? '')
    // Past what Date can hold ("in 99999999999d") is not a time.
    return ms === null || !(now + ms < 8.64e15) ? null : now + ms
  }
  // An ISO time with its own zone is a moment as it is.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(s.toUpperCase())
    return Number.isNaN(ms) ? null : ms
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](?:at )?(.+))?$/.exec(s)
  if (m) {
    const clock = m[4] ? clockOf(m[4], true) : MORNING
    if (!clock) return null
    if (zone) {
      const date = dateOf(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      return date === `${m[1]}-${m[2]}-${m[3]}` ? instantIn(date, [clock.h, clock.min, 0], zone) : null
    }
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), clock.h, clock.min)
    // 2026-02-30 rolls over in Date: not a date.
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null
  }
  let day: Day | null = null
  let clock: Clock | null = null
  let prev = ''
  for (const word of s.split(' ')) {
    if (['at', 'on', 'next', 'this'].includes(word)) {
      prev = word
      continue
    }
    const d: Day | null = day === null ? dayOf(word) : null
    const c: Clock | null = d === null && !clock ? clockOf(word, prev === 'at') : null
    if (d !== null) day = d
    else if (c) clock = c
    else return null
    prev = word
  }
  const base = new Date(now)
  // In the owner's zone (#806): the same days and clocks, read on that zone's calendar.
  const zoned = zone ? dayIn(now, zone) : null
  const on = (dayOffset: number, c: Clock): number =>
    zoned && zone
      ? instantIn(dateOf(zoned.y, zoned.mo, zoned.d + dayOffset), [c.h, c.min, 0], zone)
      : at(base, dayOffset, c)
  if (day === null) {
    if (!clock) return null
    const today = on(0, clock)
    return today > now ? today : on(1, clock)
  }
  if (typeof day === 'number') return day === 0 && !clock ? null : on(day, clock ?? MORNING)
  // A weekday: the next one, today included while its time is still ahead.
  const ahead = (day.dow - (zoned ? zoned.dow : base.getDay()) + 7) % 7
  const time = on(ahead, clock ?? MORNING)
  return time > now ? time : on(ahead + 7, clock ?? MORNING)
}

// ---------------------------------------------------------------- cron

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}
type Field = { name: string; min: number; max: number; names?: string[]; base?: number }
export type Cron = {
  expr: string
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  anyDom: boolean
  anyDow: boolean
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES, base: 0 },
]

function fieldValue(token: string, f: Field): number {
  if (/^\d+$/.test(token)) {
    const v = Number(token)
    if (v < f.min || v > f.max) throw new Error(`${f.name} ${v} is out of range ${f.min}-${f.max}`)
    return v
  }
  const i = f.names?.indexOf(token.slice(0, 3)) ?? -1
  if (i < 0 || token.length < 3) throw new Error(`bad ${f.name} "${token}"`)
  return i + (f.base ?? 0)
}

function fieldSet(text: string, f: Field): Set<number> {
  const set = new Set<number>()
  for (const item of text.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(item)
    if (!m) throw new Error(`bad ${f.name} "${item}"`)
    // "*" for the day of week is 0-6: 7 is Sunday again.
    let lo = f.min
    let hi = f.name === 'day of week' ? 6 : f.max
    const range = m[1]
    if (range !== undefined && range !== '*') {
      const [a = '', b] = range.split('-')
      lo = fieldValue(a, f)
      // "5/15": from 5 to the end, every 15.
      hi = b !== undefined ? fieldValue(b, f) : m[2] ? f.max : lo
    }
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!step) throw new Error(`bad step in ${f.name} "${item}"`)
    if (lo > hi) throw new Error(`bad range in ${f.name} "${item}"`)
    for (let v = lo; v <= hi; v += step) set.add(f.name === 'day of week' && v === 7 ? 0 : v)
  }
  return set
}

/** A cron schedule: 5 fields (minute hour day-of-month month day-of-week) or a macro. Throws on a bad one. */
export function parseCron(text: string): Cron {
  const expr = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  const parts = (MACROS[expr] ?? expr).split(' ')
  if (parts.length !== 5 || !parts[0]) {
    throw new Error(
      `a cron schedule has 5 fields (minute hour day-of-month month day-of-week), "${expr}" has ${parts[0] ? parts.length : 0}`,
    )
  }
  const [minute, hour, dom, month, dow] = parts.map((p, i) => fieldSet(p, FIELDS[i] as Field)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]
  return {
    expr,
    minute,
    hour,
    dom,
    month,
    dow,
    anyDom: (parts[2] ?? '').startsWith('*'),
    anyDow: (parts[4] ?? '').startsWith('*'),
  }
}

// As in Vixie cron: a day field that starts with "*" (so "*/2" too) narrows the other one;
// two restricted day fields are either-or.
function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate())
  const dow = c.dow.has(d.getDay())
  return c.anyDom || c.anyDow ? dom && dow : dom || dow
}

const HORIZON_MS = 8 * 366 * 86400e3

/**
 * The first run strictly after `after` (ms), or null when it never runs (Feb 30). `cron` may be
 * the text of a schedule too (as stored with a scheduled entry). `zone`: read in that zone
 * (scheduleZone), else in the computer's local time.
 */
export function nextRun(cron: Cron | string, after: number, zone?: string): number | null {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  if (zone) return nextRunIn(c, after, zone)
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  while (d.getTime() - after < HORIZON_MS) {
    const was = d.getTime()
    // Whole months, days and hours are skipped in local time; a DST change cannot stall it.
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
    } else {
      return d.getTime()
    }
    if (d.getTime() <= was) d.setTime(was + 60_000)
  }
  return null
}

/**
 * nextRun in a zone (#806): the same walk on the zone's wall clock, kept in a UTC date (which has no
 * DST to stall on), each match turned into its instant. A time the zone skips (the spring's gap)
 * runs once the gap is over, as instantIn places it; one the zone shows twice (the autumn's) runs
 * the first time.
 */
function nextRunIn(c: Cron, after: number, zone: string): number | null {
  const today = dayIn(after, zone)
  const [h, min] = clockIn(after, zone)
  const d = new Date(Date.UTC(today.y, today.mo, today.d, h, min + 1))
  const start = d.getTime()
  while (d.getTime() - start < HORIZON_MS) {
    if (!c.month.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1)
      d.setUTCHours(0, 0, 0, 0)
    } else if (!dayFits(c, d.getUTCDate(), d.getUTCDay())) {
      d.setUTCDate(d.getUTCDate() + 1)
      d.setUTCHours(0, 0, 0, 0)
    } else if (!c.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0)
    } else if (!c.minute.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0)
    } else {
      const at = instantIn(d.toISOString().slice(0, 10), [d.getUTCHours(), d.getUTCMinutes(), 0], zone)
      if (at > after) return at
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0)
    }
  }
  return null
}

/** dayMatches on a day given by its date and weekday. */
function dayFits(c: Cron, date: number, weekday: number): boolean {
  const dom = c.dom.has(date)
  const dow = c.dow.has(weekday)
  return c.anyDom || c.anyDow ? dom && dow : dom || dow
}

/** The shortest gap between its next `runs` runs after `after`, in ms (Infinity when it runs once or never). */
export function shortestGap(cron: Cron | string, after: number, runs = 50, zone?: string): number {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  let gap = Infinity
  let at: number | null = nextRun(c, after, zone)
  for (let i = 1; i < runs && at !== null; i++) {
    const next = nextRun(c, at, zone)
    if (next !== null) gap = Math.min(gap, next - at)
    at = next
  }
  return gap
}

/** How many runs fall in [from, to], counting at most `cap`. */
export function countRuns(cron: Cron | string, from: number, to: number, cap = 9999): number {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  let n = 0
  for (let at = nextRun(c, from - 1); at !== null && at <= to && n < cap; at = nextRun(c, at)) n++
  return n
}
