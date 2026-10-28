// Time tracking on the board (#233): config.json's `time`, an entry's work date in a time zone,
// the times a command takes, and a client's day as it will be billed. Pure, with no node: import:
// the page uses it too.
//
// An entry is a client's (a board lane) and a project's, from a start to a stop. The day it counts
// for is its start's date in the client's time zone (config `time.zone`, or the client's own),
// stamped on the entry when it is written, so a later change of zone moves no day already billed.
// A client's day becomes billed lines by its rules, data in the config: each entry goes to the
// first rule whose `match` fits its description; the rule adds entries up by `group` and rounds
// the sum to `step` minutes as `round` says. The board knows no client's rules but these fields.

export type Group = 'entry' | 'ref' | 'project' | 'day'
export type Round = 'up' | 'nearest' | 'down' | 'exact'
export const GROUPS: readonly Group[] = ['entry', 'ref', 'project', 'day']
export const ROUNDS: readonly Round[] = ['up', 'nearest', 'down', 'exact']

export interface BillingRule {
  /** A regex on the description (case-insensitive); null: every entry. */
  match: string | null
  group: Group
  /** Minutes; 0 with `exact`. */
  step: number
  round: Round
}

export interface TimeClient {
  /** The projects it takes; null: any. */
  projects: string[] | null
  /** The reference in a description (a case number, a ticket key): its first capture. */
  ref: string
  /** The client's own time zone; null: the board's. */
  zone: string | null
  billing: BillingRule[]
}

export interface TimeConfig {
  zone: string
  excludeTags: string[]
  /** The lanes that take time, by lane id; null: every lane, any project. */
  clients: Record<string, TimeClient> | null
}

/** A case number of five digits, or a ticket key such as ABC-123. */
export const DEFAULT_REF = '\\b([A-Z][A-Z0-9]+-\\d+|\\d{5})\\b'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Whether a time zone is one Intl knows. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The computer's time zone. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** Whether a regex source compiles. */
function goodRegex(source: string): boolean {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

function ruleOf(raw: unknown): BillingRule | null {
  if (!isObject(raw)) return null
  const match = text(raw.match) || null
  if (match && !goodRegex(match)) return null
  const group = GROUPS.includes(raw.group as Group) ? (raw.group as Group) : 'entry'
  const round = ROUNDS.includes(raw.round as Round) ? (raw.round as Round) : 'exact'
  const step = Number(raw.step)
  const ok = round === 'exact' || (Number.isFinite(step) && step > 0 && step <= 24 * 60)
  if (!ok) return null
  return { match, group, step: round === 'exact' ? 0 : step, round }
}

/** config.json's `time`: an object or `true` turns it on; anything else is off (null). */
export function timeConfig(raw: unknown): TimeConfig | null {
  if (raw !== true && !isObject(raw)) return null
  const c = isObject(raw) ? raw : {}
  const zone = text(c.zone) && knownZone(text(c.zone)) ? text(c.zone) : localZone()
  const excludeTags = Array.isArray(c.excludeTags) ? c.excludeTags.map(text).filter(Boolean) : ['deferred']
  let clients: TimeConfig['clients'] = null
  if (isObject(c.clients)) {
    clients = {}
    for (const [id, v] of Object.entries(c.clients)) {
      const o = isObject(v) ? v : {}
      const projects = Array.isArray(o.projects) ? [...new Set(o.projects.map(text).filter(Boolean))] : null
      const ref = text(o.ref) && goodRegex(text(o.ref)) ? text(o.ref) : DEFAULT_REF
      const own = text(o.zone)
      clients[id] = {
        projects,
        ref,
        zone: own && knownZone(own) ? own : null,
        billing: Array.isArray(o.billing) ? o.billing.map(ruleOf).filter((r): r is BillingRule => r !== null) : [],
      }
    }
  }
  return { zone, excludeTags, clients }
}

/** A client's settings, or why it takes no time (a text key). */
export function clientOf(c: TimeConfig, client: string): { ok: true; client: TimeClient } | { ok: false; key: string } {
  if (!c.clients) return { ok: true, client: { projects: null, ref: DEFAULT_REF, zone: null, billing: [] } }
  const found = c.clients[client]
  return found ? { ok: true, client: found } : { ok: false, key: 'time.err.client' }
}

export const zoneOf = (c: TimeConfig, client: string): string => c.clients?.[client]?.zone ?? c.zone

// ------------------------------------------------------------------ dates and times

/** The date of an instant in a time zone, YYYY-MM-DD. */
export function dateIn(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((o, p) => {
      o[p.type] = p.value
      return o
    }, {})
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** The wall clock of an instant in a time zone: [h, m, s]. */
export function clockIn(at: number, zone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((o, p) => {
      o[p.type] = p.value
      return o
    }, {})
  return [Number(parts.hour), Number(parts.minute), Number(parts.second)]
}

/** How far the zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(at: number, zone: string): number {
  const [y, mo, d] = dateIn(at, zone).split('-').map(Number) as [number, number, number]
  const [h, mi, s] = clockIn(at, zone)
  return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(at / 1000) * 1000
}

/**
 * The instant a wall clock on a date shows in a time zone. A time the zone skips that day (the
 * spring's DST gap) is moved forward by the gap; one it shows twice (the autumn's) is the first.
 */
export function instantIn(date: string, clock: readonly [number, number, number], zone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const wall = Date.UTC(y, mo - 1, d, clock[0], clock[1], clock[2])
  // two passes settle any zone; the earlier offset is taken where two fit (the autumn's repeat)
  const first = wall - offsetAt(wall, zone)
  const second = wall - offsetAt(first, zone)
  const candidates = [first, second].filter(at => {
    const [h, mi, s] = clockIn(at, zone)
    return dateIn(at, zone) === date && h === clock[0] && mi === clock[1] && s === clock[2]
  })
  if (candidates.length) return Math.min(...candidates)
  // the gap: the same wall time with the offset from before it, which lands past the gap
  return wall - offsetAt(wall - 6 * 3_600_000, zone)
}

export const isDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s)

/** A date and a number of days after it (negative: before). */
export function addDays(date: string, days: number): string {
  const at = Date.parse(`${date}T12:00:00Z`) + days * 86_400_000
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * A time as a command takes it: ISO with an offset or Z ("2026-10-28T09:00:00+03:00"), or the
 * computer's own clock: "HH:MM" today, "YYYY-MM-DD HH:MM". The instant, or null.
 */
export function parseWhen(s: string, now: number = Date.now()): number | null {
  const v = s.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const at = Date.parse(v)
    return Number.isNaN(at) ? null : at
  }
  let m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (m) {
    const d = new Date(now)
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return Number(m[1]) < 24 && Number(m[2]) < 60 ? d.getTime() : null
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(v)
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
    const at = new Date(y, mo - 1, d, h, mi, 0, 0)
    return at.getMonth() === mo - 1 && h < 24 && mi < 60 ? at.getTime() : null
  }
  return null
}

/** An instant as the store keeps it: UTC to the second. */
export const isoOf = (at: number): string => new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z')

/** Seconds as H:MM (rounded to the minute). */
export function hm(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const sign = minutes < 0 ? '-' : ''
  const a = Math.abs(minutes)
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

/** Seconds as hours with up to two decimals, as a bill says them: 1.5, 0.25, 2. */
export const hoursOf = (seconds: number): number => Math.round((seconds / 3600) * 100) / 100

/** A duration a command takes: --minutes 90, --hours 1.5; seconds, or null. */
export function durationOf(o: { minutes?: string | undefined; hours?: string | undefined }): number | null {
  const n =
    o.minutes !== undefined ? Number(o.minutes) * 60 : o.hours !== undefined ? Number(o.hours) * 3600 : Number.NaN
  return Number.isFinite(n) && n > 0 && n <= 24 * 3600 ? Math.round(n) : null
}

// ------------------------------------------------------------------ entries

/** Who made or changed an entry. */
export type Actor = { key: string; name: string } | 'user' | 'import'

export interface TimeEntry {
  id: string
  client: string
  project: string
  description: string
  tags: string[]
  /** ISO, UTC, to the second. */
  start: string
  stop: string
  /** The work date, YYYY-MM-DD. */
  date: string
  by: Actor
  at: number
  changed: number
  changedBy: Actor
  rev: number
  deleted?: number
  toggl?: string
}

export const secondsOf = (e: Pick<TimeEntry, 'start' | 'stop'>): number =>
  Math.round((Date.parse(e.stop) - Date.parse(e.start)) / 1000)

/** The text kept: one line, no control characters, at most 1000 characters. */
export function cleanText(s: string, max = 1000): string {
  // control characters out (a tab or a line break becomes a space), then the spaces made one
  const one = [...s]
    .map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > max ? one.slice(0, max) : one
}

export const cleanTag = (s: string): string => cleanText(s, 40).toLowerCase()

// ------------------------------------------------------------------ a day as billed

export interface DayLine {
  /** What tells the line from the others: the rule's index and its group's value. */
  key: string
  project: string
  /** The reference the entries share (`ref` group), else null. */
  ref: string | null
  /** The rule's index in the client's billing; null: no rule took them (exact, each alone). */
  rule: number | null
  group: Group
  step: number
  round: Round
  seconds: number
  billedSeconds: number
  entries: string[]
}

export interface ClientDay {
  client: string
  date: string
  zone: string
  lines: DayLine[]
  /** Entries with one of `excludeTags`: shown, counted in no total. */
  held: string[]
  seconds: number
  billedSeconds: number
}

/** A sum of seconds rounded to `step` minutes as `round` says; a tie goes up with `nearest`. */
export function rounded(seconds: number, step: number, round: Round): number {
  if (round === 'exact' || step <= 0) return seconds
  const s = step * 60
  if (round === 'up') return Math.ceil(seconds / s) * s
  if (round === 'down') return Math.floor(seconds / s) * s
  return Math.floor((seconds + s / 2) / s) * s
}

/** The first capture of `ref` in a description, or the whole match, or null. */
export function refIn(description: string, ref: string): string | null {
  const m = new RegExp(ref, 'i').exec(description)
  if (!m) return null
  return (m[1] ?? m[0]).toUpperCase()
}

/**
 * One client's entries of one day (live ones; any order) as billed lines: each entry to the first
 * rule whose `match` fits, the rule's group added up and rounded; an entry no rule takes, alone and
 * exact; an entry with an excluded tag held. Lines in the order of their first entry's start.
 */
export function clientDay(c: TimeConfig, client: string, date: string, entries: readonly TimeEntry[]): ClientDay {
  const settings = clientOf(c, client)
  const own = settings.ok ? settings.client : { projects: null, ref: DEFAULT_REF, zone: null, billing: [] }
  const sorted = [...entries].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1))
  const held: string[] = []
  const lines = new Map<string, DayLine & { first: string }>()
  const matchers = own.billing.map(r => (r.match ? new RegExp(r.match, 'i') : null))
  for (const e of sorted) {
    if (e.tags.some(tag => c.excludeTags.includes(tag))) {
      held.push(e.id)
      continue
    }
    const index = own.billing.findIndex((_, i) => {
      const m = matchers[i]
      return !m || m.test(e.description)
    })
    const rule = index >= 0 ? own.billing[index] : undefined
    const ref = refIn(e.description, own.ref)
    let key: string
    if (!rule || rule.group === 'entry') key = `${index}:${e.id}`
    else if (rule.group === 'ref') key = `${index}:${e.project}\u0000${ref ?? ''}`
    else if (rule.group === 'project') key = `${index}:${e.project}`
    else key = `${index}:day`
    const line = lines.get(key) ?? {
      key,
      project: e.project,
      ref: rule?.group === 'ref' || !rule || rule.group === 'entry' ? ref : null,
      rule: rule ? index : null,
      group: rule?.group ?? 'entry',
      step: rule?.step ?? 0,
      round: rule?.round ?? 'exact',
      seconds: 0,
      billedSeconds: 0,
      entries: [],
      first: e.start,
    }
    line.seconds += secondsOf(e)
    line.entries.push(e.id)
    if (rule?.group === 'day' && line.project !== e.project) line.project = ''
    lines.set(key, line)
  }
  const out: DayLine[] = [...lines.values()]
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
    .map(({ first: _first, ...l }) => ({ ...l, billedSeconds: rounded(l.seconds, l.step, l.round) }))
  return {
    client,
    date,
    zone: zoneOf(c, client),
    lines: out,
    held,
    seconds: out.reduce((n, l) => n + l.seconds, 0),
    billedSeconds: out.reduce((n, l) => n + l.billedSeconds, 0),
  }
}
