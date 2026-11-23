// Multi-timezone rules for the Calendar panel (#646): per-day UTC offsets (including half-hour and
// 45-minute zones), DST-aware gutter hours for Day and Week views, primary-zone swap, popover lines
// in every shown zone, and searchable IANA time zone picking. Pure: no DOM or I/O.
import { type CalZone, defaultZoneLabel, MAX_EXTRA_ZONES } from '../../../src/core/calendar.ts'
import { addDays, clockIn, dateIn, instantIn, knownZone, localZone } from '../../../src/core/time.ts'
import { clockText, type HourCycle } from './calendar.ts'

export type { CalZone }

export interface GutterZone extends CalZone {
  /** True for the column nearest the grid (the grid, days, and "now" line follow it). */
  primary: boolean
  /** True for this browser's own zone (the default primary before any swap). */
  home: boolean
  /** Header UTC offset text: "UTC-5", "UTC+5:30", or "UTC-4/-5" when DST shifts during the shown days. */
  offsetText: string
  /** UTC offset in minutes at the start and end of the shown days. */
  startOffsetMin: number
  endOffsetMin: number
  /** True when the offset difference between this zone and the primary zone changes during the shown days. */
  relativeShift: boolean
}

export interface GutterRow {
  hour: number
  /** Label drawn on the hairline: "09:00", "10:30", "9 AM", or "10/09" on a week crossing DST. */
  text: string
  /** Day-by-day tooltip when a week crosses a DST change on this row; empty otherwise. */
  title: string
  /** True when this row lands on midnight (00:00) in a secondary zone. */
  midnight: boolean
}

export interface DayShiftNote {
  date: string
  zone: string
  label: string
  offsetText: string
}

export interface PopoverZoneLine {
  zone: string
  label: string
  primary: boolean
  offsetText: string
  timeText: string
  /** Short date shown when the event starts on a different calendar date than in the primary zone. */
  dateNote: string
  /** Short end date shown when the event ends on a later calendar date in this zone. */
  endDateNote: string
}

export interface ZoneOption {
  zone: string
  display: string
  offsetText: string
  abbr: string
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 24 }, (_, h) => h)

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(locale: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(o)}`
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, o)
    fmtCache.set(key, f)
  }
  return f
}

/** How far `zone` is ahead of UTC at `at`, in whole minutes (east positive, west negative). */
export function offsetMinutesAt(at: number, zone: string): number {
  const [y, mo, d] = dateIn(at, zone).split('-').map(Number) as [number, number, number]
  const [h, mi, s] = clockIn(at, zone)
  return Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(at / 1000) * 1000) / 60_000)
}

function shortOffsetPart(minutes: number): string {
  if (minutes === 0) return '+0'
  const sign = minutes > 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m ? `${sign}${h}:${pad2(m)}` : `${sign}${h}`
}

/** Minutes ahead of UTC as a compact header offset: "UTC", "UTC-5", "UTC+4", "UTC+5:30". */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return 'UTC'
  return `UTC${shortOffsetPart(minutes)}`
}

/** Header offset across a span of days: one offset when constant, "UTC-4/-5" when DST shifts. */
export function formatOffsetRange(startMin: number, endMin: number): string {
  if (startMin === endMin) return formatUtcOffset(startMin)
  return `${formatUtcOffset(startMin)}/${shortOffsetPart(endMin)}`
}

/** A wall-clock hour and minute formatted for the gutter in 24h or 12h cycle. */
export function formatGutterClock(hour: number, minute: number, lang: string, cycle: HourCycle): string {
  const d = new Date(Date.UTC(2026, 0, 5, hour, minute))
  if (cycle === 'h12') {
    return minute === 0
      ? formatter(lang, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' }).format(d)
      : formatter(lang, { hour: 'numeric', minute: '2-digit', hourCycle: 'h12', timeZone: 'UTC' }).format(d)
  }
  return formatter(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(d)
}

/** Compact two-value label for a week row whose clock shifts across a DST change (for example "10/09", "18/19:30", or "10/9 AM"). */
function formatSplitClock(
  first: readonly [number, number],
  second: readonly [number, number],
  cycle: HourCycle,
): string {
  const [h1, m1] = first
  const [h2, m2] = second
  if (cycle === 'h23') {
    if (m1 === 0 && m2 === 0) return `${pad2(h1)}/${pad2(h2)}`
    if (m1 === m2) return `${pad2(h1)}/${pad2(h2)}:${pad2(m1)}`
    return `${pad2(h1)}:${pad2(m1)}/${pad2(h2)}:${pad2(m2)}`
  }
  const n1 = h1 % 12 || 12
  const n2 = h2 % 12 || 12
  const p1 = h1 < 12 ? 'a' : 'p'
  const p2 = h2 < 12 ? 'a' : 'p'
  if (p1 === p2 && m1 === 0 && m2 === 0) return `${n1}/${n2} ${p1 === 'a' ? 'AM' : 'PM'}`
  if (p1 === p2 && m1 === m2) return `${n1}/${n2}:${pad2(m1)}${p1}`
  const s1 = m1 ? `${n1}:${pad2(m1)}${p1}` : `${n1}${p1}`
  const s2 = m2 ? `${n2}:${pad2(m2)}${p2}` : `${n2}${p2}`
  return `${s1}/${s2}`
}

/** Short timezone abbreviation from Intl (for example "EST", "CET", "IST") when alphabetic, else empty. */
export function zoneAbbr(zone: string, at: number): string {
  try {
    const part = formatter('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(at))
      .find(p => p.type === 'timeZoneName')?.value
    return part && /^[A-Z]{2,5}$/.test(part) ? part : ''
  } catch {
    return ''
  }
}

/** Browser's own IANA time zone. */
export const browserZone = (): string => localZone()

/** The effective primary zone: `swapped` if it is among the active zones, else `homeZone`. */
export function resolvePrimaryZone(homeZone: string, extraZones: readonly CalZone[], swapped: string | null): string {
  if (!swapped || swapped === homeZone) return homeZone
  return extraZones.some(z => z.zone === swapped && knownZone(z.zone)) ? swapped : homeZone
}

/** Deduplicated valid extra zones (at most two, never repeating the home zone). */
export function activeExtraZones(homeZone: string, extraZones: readonly CalZone[]): CalZone[] {
  const seen = new Set<string>([homeZone])
  const out: CalZone[] = []
  for (const z of extraZones) {
    if (!z.zone || seen.has(z.zone) || !knownZone(z.zone)) continue
    seen.add(z.zone)
    out.push({ zone: z.zone, label: z.label.trim() || defaultZoneLabel(z.zone) })
    if (out.length >= MAX_EXTRA_ZONES) break
  }
  return out
}

/**
 * The gutter columns in left-to-right order: secondary zones first, primary zone last (nearest the
 * grid). When no extra zones are configured, returns a single entry for `homeZone`.
 */
export function buildGutterZones(
  homeZone: string,
  extraZones: readonly CalZone[],
  swappedPrimary: string | null,
  days: readonly string[],
): GutterZone[] {
  const extras = activeExtraZones(homeZone, extraZones)
  const primary = resolvePrimaryZone(homeZone, extras, swappedPrimary)
  const firstDay = days[0] ?? dateIn(Date.now(), primary)
  const lastDay = days.at(-1) ?? firstDay
  const startAt = instantIn(firstDay, [0, 0, 0], primary)
  const endAt = instantIn(addDays(lastDay, 1), [0, 0, 0], primary) - 1000
  const startPrimaryOff = offsetMinutesAt(startAt, primary)
  const endPrimaryOff = offsetMinutesAt(endAt, primary)

  const make = (zone: string, label: string, home: boolean): GutterZone => {
    const startOffsetMin = offsetMinutesAt(startAt, zone)
    const endOffsetMin = offsetMinutesAt(endAt, zone)
    return {
      zone,
      label,
      primary: zone === primary,
      home,
      offsetText: formatOffsetRange(startOffsetMin, endOffsetMin),
      startOffsetMin,
      endOffsetMin,
      relativeShift: startOffsetMin - startPrimaryOff !== endOffsetMin - endPrimaryOff,
    }
  }

  const homeLabel = defaultZoneLabel(homeZone)
  if (!extras.length) return [make(homeZone, homeLabel, true)]

  const all: GutterZone[] = [make(homeZone, homeLabel, true), ...extras.map(z => make(z.zone, z.label, false))]
  const secondary = all.filter(z => !z.primary)
  const chosen = all.find(z => z.primary) ?? all[0]
  return chosen ? [...secondary, chosen] : all
}

function shortWeekday(date: string, lang: string): string {
  return formatter(lang, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
}

/**
 * The 24 hour rows for one gutter column over `days` (one day in Day view, seven in Week view).
 * Each row is computed per day from the primary zone's wall-clock hour, so half-hour offsets and
 * daylight saving transitions on any day of a week are exact.
 */
export function gutterRowsFor(
  days: readonly string[],
  primaryZone: string,
  zone: string,
  lang: string,
  cycle: HourCycle,
): GutterRow[] {
  if (zone === primaryZone) {
    return HOURS.map(h => ({
      hour: h,
      text: h > 0 ? formatGutterClock(h, 0, lang, cycle) : '',
      title: '',
      midnight: false,
    }))
  }
  const list = days.length ? days : [dateIn(Date.now(), primaryZone)]
  return HOURS.map(h => {
    if (h === 0) return { hour: 0, text: '', title: '', midnight: false }
    if (list.length === 1) {
      const at = instantIn(list[0] as string, [h, 0, 0], primaryZone)
      const [sh, sm] = clockIn(at, zone)
      return {
        hour: h,
        text: formatGutterClock(sh, sm, lang, cycle),
        title: '',
        midnight: sh === 0 && sm === 0,
      }
    }
    // Evaluate each day in the week: when every day maps row h to the same clock in `zone`, show
    // one label; when a DST change splits the week, show both sides cleanly and explain by day.
    const perDay = list.map(d => {
      const at = instantIn(d, [h, 0, 0], primaryZone)
      const [sh, sm] = clockIn(at, zone)
      return { d, sh, sm, key: `${sh}:${sm}` }
    })
    const groups: { firstDay: string; lastDay: string; sh: number; sm: number; key: string }[] = []
    for (const item of perDay) {
      const prev = groups.at(-1)
      if (prev && prev.key === item.key) prev.lastDay = item.d
      else groups.push({ firstDay: item.d, lastDay: item.d, sh: item.sh, sm: item.sm, key: item.key })
    }
    if (groups.length === 1) {
      const only = groups[0] as (typeof groups)[number]
      return {
        hour: h,
        text: formatGutterClock(only.sh, only.sm, lang, cycle),
        title: '',
        midnight: only.sh === 0 && only.sm === 0,
      }
    }
    const first = groups[0] as (typeof groups)[number]
    const last = groups.at(-1) as (typeof groups)[number]
    // When both primary and secondary shift on different days in the same week, the last group can
    // return to the initial clock; pick the shifted group so we show "12/13" rather than "12/12".
    const other = last.key !== first.key ? last : (groups.find(g => g.key !== first.key) ?? last)
    const title = groups
      .map(g => {
        const range =
          g.firstDay === g.lastDay
            ? shortWeekday(g.firstDay, lang)
            : `${shortWeekday(g.firstDay, lang)} - ${shortWeekday(g.lastDay, lang)}`
        return `${range}: ${formatGutterClock(g.sh, g.sm, lang, cycle)}`
      })
      .join(', ')
    return {
      hour: h,
      text: formatSplitClock([first.sh, first.sm], [other.sh, other.sm], cycle),
      title,
      midnight: groups.some(g => g.sh === 0 && g.sm === 0),
    }
  })
}

/**
 * Days within `days` on which any shown zone's UTC offset changes (a DST transition day). Used in
 * Week view to mark the exact day column where the offset shifts. Samples from 1 second before
 * midnight on subsequent days so transitions occurring exactly at 00:00 primary time are never
 * missed between days.
 */
export function dayDstShifts(
  days: readonly string[],
  primaryZone: string,
  zones: readonly GutterZone[],
): Map<string, DayShiftNote[]> {
  const out = new Map<string, DayShiftNote[]>()
  if (zones.length <= 1) return out
  for (let i = 0; i < days.length; i++) {
    const d = days[i] as string
    const dayStart = instantIn(d, [0, 0, 0], primaryZone)
    const beforeAt = i === 0 ? dayStart : dayStart - 1000
    const endAt = instantIn(addDays(d, 1), [0, 0, 0], primaryZone) - 1000
    const notes: DayShiftNote[] = []
    for (const z of zones) {
      const startOff = offsetMinutesAt(beforeAt, z.zone)
      const endOff = offsetMinutesAt(endAt, z.zone)
      if (startOff !== endOff) {
        notes.push({ date: d, zone: z.zone, label: z.label, offsetText: formatUtcOffset(endOff) })
      }
    }
    if (notes.length) out.set(d, notes)
  }
  return out
}

function shortDateText(date: string, lang: string): string {
  return formatter(lang, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  )
}

/**
 * Start and end times of a timed event formatted in every shown zone, primary first. Uses each
 * event's exact instants so daylight saving is always right for that date.
 */
export function popoverZoneLines(
  startMs: number,
  endMs: number,
  zones: readonly GutterZone[],
  lang: string,
  cycle: HourCycle,
): PopoverZoneLine[] {
  if (!zones.length) return []
  const primary = zones.find(z => z.primary) ?? zones[0]
  if (!primary) return []
  const ordered = [primary, ...zones.filter(z => z.zone !== primary.zone)]
  const primaryStartDate = dateIn(startMs, primary.zone)
  const endCheck = endMs > startMs ? endMs - 1 : endMs
  return ordered.map(z => {
    const startDate = dateIn(startMs, z.zone)
    const endDate = dateIn(endCheck, z.zone)
    return {
      zone: z.zone,
      label: z.label,
      primary: z.zone === primary.zone,
      offsetText: formatUtcOffset(offsetMinutesAt(startMs, z.zone)),
      timeText: `${clockText(startMs, lang, cycle, z.zone)} - ${clockText(endMs, lang, cycle, z.zone)}`,
      dateNote: startDate !== primaryStartDate ? shortDateText(startDate, lang) : '',
      endDateNote: endDate !== startDate ? shortDateText(endDate, lang) : '',
    }
  })
}

/** All IANA time zones this runtime knows, sorted, always including UTC and any extra ids passed. */
export function allIanaZones(extra: readonly string[] = []): string[] {
  let known: string[] = []
  try {
    known = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {}
  return [...new Set([...known, ...extra, 'UTC'])].filter(Boolean).sort()
}

const norm = (s: string): string => s.toLowerCase().replaceAll('_', ' ').trim()

/** Precompute searchable zone metadata once so typing in Settings stays instant. */
export function buildZoneIndex(allZones: readonly string[], now: number): ZoneOption[] {
  return allZones.map(zone => ({
    zone,
    display: zone.replaceAll('_', ' '),
    offsetText: formatUtcOffset(offsetMinutesAt(now, zone)),
    abbr: zoneAbbr(zone, now),
  }))
}

/** Searchable IANA zone options matching a query by city, region, full zone id, abbreviation, or UTC offset. */
export function searchZones(
  query: string,
  allZones: readonly (string | ZoneOption)[],
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  limit = 60,
): ZoneOption[] {
  const q = norm(query)
  const matches: { score: number; opt: ZoneOption }[] = []
  for (const item of allZones) {
    const zone = typeof item === 'string' ? item : item.zone
    if (exclude.has(zone)) continue
    const opt: ZoneOption =
      typeof item === 'string'
        ? {
            zone,
            display: zone.replaceAll('_', ' '),
            offsetText: formatUtcOffset(offsetMinutesAt(now, zone)),
            abbr: zoneAbbr(zone, now),
          }
        : item
    const lower = opt.display.toLowerCase()
    const city = (lower.split('/').at(-1) ?? lower).trim()
    const offsetLower = opt.offsetText.toLowerCase()
    const abbrLower = opt.abbr.toLowerCase()
    let score = 0
    if (q) {
      if (city === q || lower === q) score = 0
      else if (city.startsWith(q)) score = 1
      else if (lower.startsWith(q)) score = 2
      else if (abbrLower === q || offsetLower === q || offsetLower.slice(3) === q) score = 3
      else if (lower.includes(q) || offsetLower.includes(q) || abbrLower.includes(q)) score = 4
      else continue
    }
    matches.push({ score, opt })
  }
  matches.sort((a, b) => a.score - b.score || a.opt.display.localeCompare(b.opt.display))
  return matches.slice(0, limit).map(m => m.opt)
}
