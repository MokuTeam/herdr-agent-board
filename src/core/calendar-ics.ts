// An iCalendar file (RFC 5545) as the calendar's events (#328, core/calendar.ts): what a calendar's
// secret iCal address answers. Read only, no I/O: the text in, the events of a window out.
//
// What it reads: VEVENT with DTSTART, DTEND or DURATION, SUMMARY, LOCATION, DESCRIPTION, URL,
// STATUS, ATTENDEE (a count, and the owner's PARTSTAT), the conference fields Google and RFC 7986
// write; a series' RRULE (every FREQ from DAILY to YEARLY, INTERVAL, COUNT, UNTIL, BYDAY with
// ordinals, BYMONTHDAY, BYMONTH, BYSETPOS, WKST), RDATE and EXDATE, an instance moved or
// cancelled by its own VEVENT (RECURRENCE-ID). A series is expanded on the wall clock of its own
// zone, so a weekly 09:00 stays 09:00 across a change of daylight saving time.
//
// A TZID is an IANA name when Intl knows it (also inside a longer path, as some exporters write
// it), else the file's own VTIMEZONE (its STANDARD and DAYLIGHT onsets), else a Windows name from
// the short list below; a time without a zone (floating) is in X-WR-TIMEZONE or the given zone.
import { type CalEvent, type EventResponse, eventOf, joinLinkIn } from './calendar.ts'
import { addDays, cleanText, instantIn, isDate, knownZone } from './time.ts'

// ------------------------------------------------------------------ the file's lines

export interface IcsProp {
  name: string
  params: Record<string, string>
  value: string
}

export interface IcsComp {
  type: string
  props: IcsProp[]
  children: IcsComp[]
}

/** One content line: NAME;PARAM=a;PARAM="b:c":value (a colon inside quotes is not the value's). */
function propOf(line: string): IcsProp | null {
  let i = 0
  let quoted = false
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ':' && !quoted) break
  }
  if (i >= line.length) return null
  const head = line.slice(0, i)
  const value = line.slice(i + 1)
  const parts: string[] = []
  let cur = ''
  quoted = false
  for (const ch of head) {
    if (ch === '"') quoted = !quoted
    if (ch === ';' && !quoted) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const name = (parts[0] ?? '').trim().toUpperCase()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    params[p.slice(0, eq).trim().toUpperCase()] = p
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
  }
  return { name, params, value }
}

/** The file as components: the lines unfolded, BEGIN and END nesting them. A root holds what is outside any. */
export function parseIcs(text: string): IcsComp {
  const lines = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
  const root: IcsComp = { type: 'ROOT', props: [], children: [] }
  const stack: IcsComp[] = [root]
  for (const line of lines) {
    if (!line.trim()) continue
    const p = propOf(line)
    if (!p) continue
    const top = stack.at(-1) as IcsComp
    if (p.name === 'BEGIN') {
      const comp: IcsComp = { type: p.value.trim().toUpperCase(), props: [], children: [] }
      top.children.push(comp)
      stack.push(comp)
    } else if (p.name === 'END') {
      if (stack.length > 1 && top.type === p.value.trim().toUpperCase()) stack.pop()
    } else top.props.push(p)
  }
  return root
}

/** TEXT's escapes undone: \n, \, \; \\. */
export const unescapeText = (s: string): string =>
  s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

const prop = (c: IcsComp, name: string): IcsProp | undefined => c.props.find(p => p.name === name)
const props = (c: IcsComp, name: string): IcsProp[] => c.props.filter(p => p.name === name)
const textProp = (c: IcsComp, name: string): string => {
  const p = prop(c, name)
  return p ? unescapeText(p.value) : ''
}

// ------------------------------------------------------------------ zones

/** A zone the file's times can be read in: the instant a wall clock shows on a date. */
export interface Zone {
  name: string
  instant(date: string, clock: readonly [number, number, number]): number
}

const ianaZone = (name: string): Zone => ({ name, instant: (date, clock) => instantIn(date, clock, name) })
const UTC: Zone = { name: 'UTC', instant: (date, clock) => wallMs(date, clock) }

/** The wall clock as if it were UTC, in ms: the arithmetic of local times. */
function wallMs(date: string, clock: readonly [number, number, number]): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, mo - 1, d, clock[0], clock[1], clock[2])
}

/** Windows' names for the zones exporters such as Outlook write, as IANA names. */
const WINDOWS_ZONES: Record<string, string> = {
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Russian Standard Time': 'Europe/Moscow',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russia Time Zone 3': 'Europe/Samara',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Iran Standard Time': 'Asia/Tehran',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Central Asia Standard Time': 'Asia/Almaty',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
}

/** "+0300", "-0500", "+053000": ms east of UTC. */
function offsetMs(s: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(s.trim())
  if (!m) return null
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000
  return m[1] === '-' ? -ms : ms
}

/**
 * A VTIMEZONE as a zone: its STANDARD and DAYLIGHT onsets (each a DTSTART on the wall clock of
 * its TZOFFSETFROM, repeated by its RRULE or its RDATEs) give the offset at any instant: the
 * TZOFFSETTO of the last onset before it.
 */
function vtimezone(comp: IcsComp, name: string): Zone | null {
  const rules = comp.children
    .filter(c => c.type === 'STANDARD' || c.type === 'DAYLIGHT')
    .map(c => {
      const start = wallOf(prop(c, 'DTSTART')?.value ?? '')
      const from = offsetMs(prop(c, 'TZOFFSETFROM')?.value ?? '')
      const to = offsetMs(prop(c, 'TZOFFSETTO')?.value ?? '')
      const rrule = prop(c, 'RRULE')
      const rdates = props(c, 'RDATE').flatMap(p => p.value.split(',').map(wallOf))
      return { start, from, to, rule: rrule ? ruleOf(rrule.value) : null, rdates }
    })
    .filter(
      (r): r is typeof r & { start: Wall; from: number; to: number } =>
        r.start !== null && r.from !== null && r.to !== null,
    )
  if (!rules.length) return null
  const onsetsByYear = new Map<number, { at: number; to: number }[]>()
  const onsets = (year: number) => {
    const had = onsetsByYear.get(year)
    if (had) return had
    const list: { at: number; to: number }[] = []
    // every onset up to the year after: the last one before an instant may be years back (a zone
    // that stopped changing, a rule that ended with its UNTIL)
    const hi = `${year + 1}-12-31`
    for (const r of rules) {
      const walls: Wall[] = [r.start, ...r.rdates.filter((w): w is Wall => w !== null)]
      // an onset's UNTIL is in UTC; the onset itself on the wall clock of its TZOFFSETFROM
      const at = (w: Wall) => wallMs(w.date, w.clock ?? [0, 0, 0]) - (w.utc ? 0 : r.from)
      if (r.rule) walls.push(...expandRule(r.rule, r.start, r.start.date, hi, at))
      for (const w of walls) {
        if (!w.clock || w.date > hi) continue
        list.push({ at: wallMs(w.date, w.clock) - r.from, to: r.to })
      }
    }
    list.sort((a, b) => a.at - b.at)
    onsetsByYear.set(year, list)
    return list
  }
  const first = rules.reduce((a, b) => (wallMs(b.start.date, [0, 0, 0]) < wallMs(a.start.date, [0, 0, 0]) ? b : a))
  const offsetAt = (at: number): number => {
    const list = onsets(new Date(at).getUTCFullYear())
    let off = first.from
    for (const o of list) {
      if (o.at > at) break
      off = o.to
    }
    return off
  }
  return {
    name,
    instant(date, clock) {
      const wall = wallMs(date, clock)
      const before = offsetAt(wall - 86_400_000)
      const after = offsetAt(wall + 86_400_000)
      const fits = [wall - before, wall - after].filter(at => at + offsetAt(at) === wall)
      return fits.length ? Math.min(...fits) : wall - before
    },
  }
}

/** The zone a TZID names in this file; `fallback` when it names none that can be read. */
function zoneResolver(root: IcsComp, fallback: Zone): (tzid: string | undefined) => Zone {
  const own = new Map<string, IcsComp>()
  const walk = (c: IcsComp) => {
    for (const ch of c.children) {
      if (ch.type === 'VTIMEZONE') {
        const id = prop(ch, 'TZID')?.value.trim()
        if (id) own.set(id, ch)
      } else walk(ch)
    }
  }
  walk(root)
  const cache = new Map<string, Zone>()
  return tzid => {
    const id = (tzid ?? '').trim()
    if (!id) return fallback
    const had = cache.get(id)
    if (had) return had
    let zone: Zone | null = null
    if (knownZone(id)) zone = ianaZone(id)
    else {
      // "/mozilla.org/20050126_1/Europe/Berlin", "/Europe/Berlin": the IANA name at its end
      const parts = id.split('/').filter(Boolean)
      for (let i = 0; i < parts.length - 1 && !zone; i++) {
        const tail = parts.slice(i).join('/')
        if (/^[A-Z][A-Za-z_]+\/[A-Za-z_]/.test(tail) && knownZone(tail)) zone = ianaZone(tail)
      }
    }
    if (!zone) {
      const comp = own.get(id)
      if (comp) zone = vtimezone(comp, id)
    }
    if (!zone && WINDOWS_ZONES[id]) zone = ianaZone(WINDOWS_ZONES[id] as string)
    if (!zone && /^(utc|gmt|z)$/i.test(id)) zone = UTC
    zone ??= fallback
    cache.set(id, zone)
    return zone
  }
}

// ------------------------------------------------------------------ times

/** A date with a wall clock (null: a date alone); `utc`: the value ended in Z. */
interface Wall {
  date: string
  clock: [number, number, number] | null
  utc: boolean
}

/** 20261102, 20261102T130000, 20261102T130000Z. */
function wallOf(value: string): Wall | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(value.trim())
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (!isDate(date)) return null
  if (m[4] === undefined) return { date, clock: null, utc: false }
  const clock: [number, number, number] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (clock[0] > 23 || clock[1] > 59 || clock[2] > 60) return null
  return { date, clock, utc: !!m[7] }
}

/** A wall time read in a zone (UTC when it said Z). */
const instantOf = (w: Wall, zone: Zone): number => (w.utc ? UTC : zone).instant(w.date, w.clock ?? [0, 0, 0])

/** A DURATION (P1D, PT1H30M, -PT15M, P2W) in ms, or null. */
function durationMs(s: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(s.trim())
  if (!m || s.trim().length < 3) return null
  const n = (i: number) => Number(m[i] ?? 0)
  const ms = (((n(2) * 7 + n(3)) * 24 + n(4)) * 3600 + n(5) * 60 + n(6)) * 1000
  return m[1] === '-' ? -ms : ms
}

// ------------------------------------------------------------------ recurrence

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  until: Wall | null
  /** [ordinal (0: every), weekday 0..6 from Sunday]. */
  byDay: [number, number][]
  byMonthDay: number[]
  byMonth: number[]
  bySetPos: number[]
  /** The week's first day, 0..6 from Sunday. */
  wkst: number
}

/** An RRULE's value; null for a frequency this reader does not expand (HOURLY and finer): its first instance alone. */
export function ruleOf(value: string): Rule | null {
  const parts = new Map<string, string>()
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=')
    if (eq > 0) parts.set(kv.slice(0, eq).trim().toUpperCase(), kv.slice(eq + 1).trim())
  }
  const freq = parts.get('FREQ')?.toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  const ints = (k: string): number[] =>
    (parts.get(k) ?? '')
      .split(',')
      .map(s => Number.parseInt(s, 10))
      .filter(n => Number.isInteger(n) && n !== 0)
  const byDay: [number, number][] = []
  for (const d of (parts.get('BYDAY') ?? '').split(',')) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim())
    if (m) byDay.push([m[1] ? Number(m[1]) : 0, WEEKDAYS.indexOf((m[2] as string).toUpperCase())])
  }
  const count = Number.parseInt(parts.get('COUNT') ?? '', 10)
  const interval = Number.parseInt(parts.get('INTERVAL') ?? '1', 10)
  const wkst = WEEKDAYS.indexOf((parts.get('WKST') ?? 'MO').toUpperCase())
  return {
    freq,
    interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
    count: Number.isInteger(count) && count > 0 ? count : null,
    until: wallOf(parts.get('UNTIL') ?? ''),
    byDay,
    byMonthDay: ints('BYMONTHDAY'),
    byMonth: ints('BYMONTH').filter(m => m >= 1 && m <= 12),
    bySetPos: ints('BYSETPOS'),
    wkst: wkst >= 0 ? wkst : 1,
  }
}

const dayOfWeek = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay()
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()
const dateOf = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** The days of a month a BYDAY picks: every such weekday, or the nth (from the end when negative). */
function weekdaysIn(y: number, m: number, byDay: readonly [number, number][]): number[] {
  const n = daysInMonth(y, m)
  const out = new Set<number>()
  for (const [ord, wd] of byDay) {
    const days: number[] = []
    for (let d = 1; d <= n; d++) if (dayOfWeek(dateOf(y, m, d)) === wd) days.push(d)
    if (!ord) for (const d of days) out.add(d)
    else {
      const d = ord > 0 ? days[ord - 1] : days[days.length + ord]
      if (d !== undefined) out.add(d)
    }
  }
  return [...out]
}

/** The days of a month a BYMONTHDAY picks (negative: from its end). */
function monthDaysIn(y: number, m: number, byMonthDay: readonly number[]): number[] {
  const n = daysInMonth(y, m)
  return byMonthDay.map(d => (d > 0 ? d : n + d + 1)).filter(d => d >= 1 && d <= n)
}

/** The candidates of one month for a MONTHLY or YEARLY rule, sorted. */
function monthCandidates(rule: Rule, y: number, m: number, startDay: number): number[] {
  let days: number[]
  if (rule.byMonthDay.length && rule.byDay.length) {
    const wd = new Set(
      weekdaysIn(
        y,
        m,
        rule.byDay.map(([, w]) => [0, w]),
      ),
    )
    days = monthDaysIn(y, m, rule.byMonthDay).filter(d => wd.has(d))
  } else if (rule.byMonthDay.length) days = monthDaysIn(y, m, rule.byMonthDay)
  else if (rule.byDay.length) days = weekdaysIn(y, m, rule.byDay)
  else days = startDay <= daysInMonth(y, m) ? [startDay] : []
  return [...new Set(days)].sort((a, b) => a - b)
}

/** BYSETPOS: the nth of the period's candidates (from the end when negative). */
function setPos<T>(list: readonly T[], pos: readonly number[]): T[] {
  if (!pos.length) return [...list]
  const out: T[] = []
  for (const p of pos) {
    const v = p > 0 ? list[p - 1] : list[list.length + p]
    if (v !== undefined && !out.includes(v)) out.push(v)
  }
  return out
}

/** How many periods a series is walked at most, and instances it gives at most: a runaway rule stops. */
const MAX_PERIODS = 50_000
const MAX_INSTANCES = 5_000

/**
 * The wall times a rule gives from `start` (its first instance, always one) to the date `hi`, at
 * `start`'s clock. `untilMs` reads UNTIL in the series' zone; COUNT counts from `start`. Dates
 * before `lo` are walked (they count) but not returned.
 */
export function expandRule(rule: Rule, start: Wall, lo: string, hi: string, untilMs: (w: Wall) => number): Wall[] {
  const out: Wall[] = []
  const clock = start.clock
  const startMs = wallMs(start.date, clock ?? [0, 0, 0])
  const until = rule.until
  const untilAt = until ? (until.utc || until.clock ? untilMs(until) : wallMs(until.date, [23, 59, 59])) : null
  let n = 0
  const take = (date: string): boolean => {
    const w: Wall = { date, clock, utc: start.utc }
    const at = wallMs(date, clock ?? [0, 0, 0])
    if (at < startMs) return true
    if (untilAt !== null) {
      // UNTIL in UTC or the series' zone, compared as the series sees it
      const here = until?.utc || until?.clock ? untilMs({ ...w, utc: start.utc }) : at
      if (here > untilAt) return false
    }
    if (date > hi) return false
    n++
    if (rule.count !== null && n > rule.count) return false
    if (date >= lo) out.push(w)
    return out.length < MAX_INSTANCES
  }
  const [sy, sm, sd] = start.date.split('-').map(Number) as [number, number, number]
  const monthOk = (m: number) => !rule.byMonth.length || rule.byMonth.includes(m)
  // Without COUNT nothing before the window counts: the walk starts a period before it (a daily
  // series from years ago is not walked day by day). With COUNT every instance from DTSTART does.
  let first = 0
  if (rule.count === null && lo > start.date) {
    const [ly, lm] = lo.split('-').map(Number) as [number, number]
    const days = Math.floor((Date.parse(`${lo}T12:00:00Z`) - Date.parse(`${start.date}T12:00:00Z`)) / 86_400_000)
    const span =
      rule.freq === 'DAILY'
        ? days
        : rule.freq === 'WEEKLY'
          ? Math.floor(days / 7)
          : rule.freq === 'MONTHLY'
            ? (ly - sy) * 12 + (lm - sm)
            : ly - sy
    first = Math.max(0, Math.floor(span / rule.interval) - 1)
  }
  for (let p = first; p < first + MAX_PERIODS; p++) {
    let dates: string[] = []
    if (rule.freq === 'DAILY') {
      const date = addDays(start.date, p * rule.interval)
      const [, m, d] = date.split('-').map(Number) as [number, number, number]
      const okDay =
        (!rule.byDay.length || rule.byDay.some(([, w]) => w === dayOfWeek(date))) &&
        (!rule.byMonthDay.length || monthDaysIn(Number(date.slice(0, 4)), m, rule.byMonthDay).includes(d))
      if (monthOk(m) && okDay) dates = [date]
      if (date > hi) break
    } else if (rule.freq === 'WEEKLY') {
      const back = (dayOfWeek(start.date) - rule.wkst + 7) % 7
      const weekStart = addDays(start.date, p * 7 * rule.interval - back)
      if (weekStart > hi) break
      const wds = rule.byDay.length ? rule.byDay.map(([, w]) => w) : [dayOfWeek(start.date)]
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        if (wds.includes(dayOfWeek(date)) && monthOk(Number(date.slice(5, 7)))) dates.push(date)
      }
    } else if (rule.freq === 'MONTHLY') {
      const k = sm - 1 + p * rule.interval
      const y = sy + Math.floor(k / 12)
      const m = (k % 12) + 1
      if (dateOf(y, m, 1) > hi) break
      if (monthOk(m)) dates = monthCandidates(rule, y, m, sd).map(d => dateOf(y, m, d))
    } else {
      const y = sy + p * rule.interval
      if (dateOf(y, 1, 1) > hi) break
      const months = rule.byMonth.length ? rule.byMonth : [sm]
      if (!rule.byMonth.length && rule.byDay.some(([o]) => o !== 0) && !rule.byMonthDay.length) {
        // the nth weekday of the year
        const all: string[] = []
        for (let m = 1; m <= 12; m++)
          for (let d = 1; d <= daysInMonth(y, m); d++) {
            const date = dateOf(y, m, d)
            if (rule.byDay.some(([, w]) => w === dayOfWeek(date))) all.push(date)
          }
        for (const [ord, wd] of rule.byDay) {
          const days = all.filter(d => dayOfWeek(d) === wd)
          const d = ord > 0 ? days[ord - 1] : ord < 0 ? days[days.length + ord] : undefined
          if (d) dates.push(d)
          else if (!ord) dates.push(...days)
        }
      } else
        for (const m of months.slice().sort((a, b) => a - b))
          dates.push(...monthCandidates(rule, y, m, sd).map(d => dateOf(y, m, d)))
    }
    dates = setPos([...new Set(dates)].sort(), rule.bySetPos)
    let more = true
    for (const date of dates) {
      if (!take(date)) {
        more = false
        break
      }
    }
    if (!more) break
  }
  // DTSTART is the first instance even where the rule would not have picked it
  if (!out.some(w => w.date === start.date) && start.date >= lo && start.date <= hi) out.unshift(start)
  return out
}

// ------------------------------------------------------------------ events

export interface IcsOptions {
  source: string
  /** The window: instances that touch [from, to) are given. */
  from: number
  to: number
  /** The zone of a time that names none (floating) when the file names no X-WR-TIMEZONE. */
  zone: string
  /** The owner's address: their invitation's answer is the event's `response`. */
  account?: string | null
}

const PARTSTAT: Record<string, EventResponse> = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
  'NEEDS-ACTION': 'needsAction',
}

/** The compact form of an instance's original start, for its id: 20261102T130000Z or 20261102. */
const stamp = (at: number | string): string =>
  typeof at === 'string'
    ? at.replaceAll('-', '')
    : new Date(at)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z')

const isoOf = (at: number): string => new Date(at).toISOString().replace('.000Z', 'Z')

/** The events of an iCalendar file that touch the window, a series' instances each on its own. */
export function icsEvents(text: string, o: IcsOptions): CalEvent[] {
  const root = parseIcs(text)
  const cal = root.children.find(c => c.type === 'VCALENDAR') ?? root
  const wr = prop(cal, 'X-WR-TIMEZONE')?.value.trim()
  const fallback = ianaZone(wr && knownZone(wr) ? wr : o.zone)
  const zoneOf = zoneResolver(root, fallback)
  const vevents: IcsComp[] = []
  const walk = (c: IcsComp) => {
    for (const ch of c.children) {
      if (ch.type === 'VEVENT') vevents.push(ch)
      else if (ch.type !== 'VTIMEZONE') walk(ch)
    }
  }
  walk(root)
  const account = o.account?.trim().toLowerCase() || null
  const hiDate = new Date(o.to + 2 * 86_400_000).toISOString().slice(0, 10)

  interface Base {
    comp: IcsComp
    uid: string
    start: Wall
    zone: Zone
    allDay: boolean
    /** ms for a timed event, days for an all-day one. */
    length: number
  }
  const baseOf = (comp: IcsComp, i: number): Base | null => {
    const ds = prop(comp, 'DTSTART')
    const start = ds ? wallOf(ds.value) : null
    if (!ds || !start) return null
    const allDay = ds.params.VALUE?.toUpperCase() === 'DATE' || !start.clock
    const zone = zoneOf(ds.params.TZID)
    const uid = textProp(comp, 'UID').trim() || `nouid-${i}`
    const de = prop(comp, 'DTEND')
    const end = de ? wallOf(de.value) : null
    const dur = durationMs(prop(comp, 'DURATION')?.value ?? '')
    let length: number
    if (allDay) {
      if (end && end.date > start.date)
        length = Math.round((Date.parse(`${end.date}T12:00:00Z`) - Date.parse(`${start.date}T12:00:00Z`)) / 86_400_000)
      else if (dur !== null && dur > 0) length = Math.max(1, Math.round(dur / 86_400_000))
      else length = 1
    } else {
      const s = instantOf(start, zone)
      if (end?.clock) length = Math.max(0, instantOf(end, zoneOf(de?.params.TZID)) - s)
      else if (dur !== null) length = Math.max(0, dur)
      else length = 0
    }
    return { comp, uid, start: allDay ? { ...start, clock: null } : start, zone, allDay, length }
  }

  const eventAt = (b: Base, comp: IcsComp, start: Wall, original: string | null): CalEvent | null => {
    let s: string
    let e: string
    if (b.allDay) {
      s = start.date
      e = addDays(start.date, b.length)
    } else {
      const at = instantOf(start, b.zone)
      s = isoOf(at)
      e = isoOf(at + b.length)
    }
    const attendees = props(comp, 'ATTENDEE')
    const me = account
      ? attendees.find(
          p =>
            p.value
              .replace(/^mailto:/i, '')
              .trim()
              .toLowerCase() === account,
        )
      : undefined
    const response = me ? PARTSTAT[(me.params.PARTSTAT ?? '').toUpperCase()] : undefined
    const status = (prop(comp, 'STATUS')?.value ?? '').trim().toUpperCase()
    const location = cleanText(textProp(comp, 'LOCATION'), 500)
    const description = textProp(comp, 'DESCRIPTION')
    const conference = [
      textProp(comp, 'X-GOOGLE-CONFERENCE'),
      ...props(comp, 'CONFERENCE').map(p => p.value),
      textProp(comp, 'X-MICROSOFT-SKYPETEAMSMEETINGURL'),
    ].join(' ')
    const busy = (prop(comp, 'X-MICROSOFT-CDO-BUSYSTATUS')?.value ?? '').trim().toUpperCase()
    const raw: Record<string, unknown> = {
      id: original ? `${b.uid}_${original}` : b.uid,
      title: textProp(comp, 'SUMMARY'),
      start: s,
      end: e,
      allDay: b.allDay,
      zone: b.allDay ? undefined : b.zone.name,
      location,
      join: joinLinkIn(conference, location, description) ?? undefined,
      link: textProp(comp, 'URL') || undefined,
      attendees: attendees.length || undefined,
      status: status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
      response,
      kind: busy === 'OOF' ? 'outOfOffice' : undefined,
      series: original ? b.uid : undefined,
    }
    return eventOf(raw, o.source)
  }

  const touches = (e: CalEvent): boolean => {
    const s = e.allDay ? fallback.instant(e.start, [0, 0, 0]) : Date.parse(e.start)
    const end = e.allDay ? fallback.instant(e.end, [0, 0, 0]) : Date.parse(e.end)
    return s < o.to && (end > o.from || (end === s && s >= o.from))
  }

  // moved or cancelled instances, by series and original start (an instant, or a date)
  const overrides = new Map<string, Map<string, IcsComp>>()
  const masters: IcsComp[] = []
  for (const comp of vevents) {
    const rid = prop(comp, 'RECURRENCE-ID')
    const uid = textProp(comp, 'UID').trim()
    if (rid && uid) {
      const w = wallOf(rid.value)
      if (!w) continue
      const key = w.clock ? String(instantOf(w, zoneOf(rid.params.TZID))) : w.date
      const forUid = overrides.get(uid) ?? new Map<string, IcsComp>()
      forUid.set(key, comp)
      overrides.set(uid, forUid)
    } else masters.push(comp)
  }

  const out: CalEvent[] = []
  const seen = new Map<string, number>()
  const push = (e: CalEvent | null) => {
    if (!e || !touches(e)) return
    const n = seen.get(e.id) ?? 0
    seen.set(e.id, n + 1)
    out.push(n ? { ...e, id: `${e.id}~${n}` } : e)
  }
  masters.forEach((comp, i) => {
    const b = baseOf(comp, i)
    if (!b) return
    const rrule = prop(comp, 'RRULE')
    const rule = rrule ? ruleOf(rrule.value) : null
    const rdates = props(comp, 'RDATE').flatMap(p =>
      p.params.VALUE?.toUpperCase() === 'PERIOD' ? [] : p.value.split(',').map(wallOf),
    )
    if (!rule && !rdates.length) {
      push(eventAt(b, comp, b.start, null))
      return
    }
    const excluded = new Set<string>()
    for (const p of props(comp, 'EXDATE'))
      for (const v of p.value.split(',')) {
        const w = wallOf(v)
        if (!w) continue
        excluded.add(b.allDay || !w.clock ? w.date : String(instantOf(w, zoneOf(p.params.TZID ?? undefined))))
      }
    // an instance that began before the window and lasts into it is in it: the walk starts its length earlier
    const reach = b.allDay ? b.length * 86_400_000 : b.length
    const lo = new Date(o.from - 2 * 86_400_000 - reach).toISOString().slice(0, 10)
    const walls: Wall[] = rule
      ? expandRule(rule, b.start, lo < b.start.date ? b.start.date : lo, hiDate, w => instantOf(w, b.zone))
      : [b.start]
    for (const r of rdates) if (r) walls.push(b.allDay ? { ...r, clock: null } : r)
    const own = overrides.get(b.uid)
    const used = new Set<string>()
    const done = new Set<string>()
    for (const w of walls) {
      const key = b.allDay ? w.date : String(instantOf(w, b.zone))
      if (done.has(key)) continue
      done.add(key)
      if (excluded.has(key) || excluded.has(w.date)) continue
      const original = b.allDay ? stamp(w.date) : stamp(Number(key))
      const moved = own?.get(key)
      if (moved) {
        used.add(key)
        const mb = baseOf(moved, i)
        if (mb) push(eventAt({ ...mb, uid: b.uid }, moved, mb.start, original))
      } else push(eventAt(b, comp, w, original))
    }
    // an instance moved into the window from a date the walk did not reach
    for (const [key, moved] of own ?? []) {
      if (used.has(key) || excluded.has(key)) continue
      const mb = baseOf(moved, i)
      if (!mb) continue
      const original = /^\d+$/.test(key) ? stamp(Number(key)) : stamp(key)
      push(eventAt({ ...mb, uid: b.uid }, moved, mb.start, original))
    }
  })
  // an override whose series is not in the file: on its own
  for (const [uid, own] of overrides) {
    if (masters.some(m => textProp(m, 'UID').trim() === uid)) continue
    for (const [key, comp] of own) {
      const b = baseOf(comp, 0)
      if (b) push(eventAt({ ...b, uid }, comp, b.start, /^\d+$/.test(key) ? stamp(Number(key)) : stamp(key)))
    }
  }
  return out
}
