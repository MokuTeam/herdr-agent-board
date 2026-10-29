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
// An entry is billable as its client and project say (`billable`, `nonBillable`) unless a person,
// an agent or the import set it the other way; one that is not counts as worked, never as billed.
// A client's `systems` are where its time is entered (an ERP, a tracker): an entry carries a mark
// per system once it is (adapters/time-store.ts).
// Turned off (`time.on`, a client's `on`: false) and retired projects keep what is there: time off
// keeps its settings for when it is on again; a client off takes no new entry, its own billed by
// its rules as before; a retired project is offered no more, its entries keep it (#237).
//
// The owner writes this config by hand, and a value read wrong would date or bill entries wrong
// with no word: so nothing in it is guessed. A value that does not check out (an unknown zone,
// round or group, a regex that does not compile, a key the board does not know) is a problem,
// named by its place in config.json; while there is one, no entry is written, and every view of a
// day says so.

import type { Translator } from './types.ts'

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

/** A system a client's time is entered in: its id (a-z, 0-9, -) and the name shown. */
export interface TimeSystem {
  id: string
  title: string
}

export interface TimeClient {
  /** Whether it takes new entries (false: off, its entries stay). */
  on: boolean
  /** The projects it takes; null: any. */
  projects: string[] | null
  /** Projects no longer offered for new entries; its entries keep them. */
  retired: string[]
  /** Whether its entries are billable by default (false: a lane never billed). */
  billable: boolean
  /** Projects of a billed client that are not billed. */
  nonBillable: string[]
  /** Where its time is entered; none: nothing to enter. */
  systems: TimeSystem[]
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
  /** What does not check out; none: the config is as written. */
  problems: TimeProblem[]
}

export type ProblemWhy =
  | 'required'
  | 'zone'
  | 'regex'
  | 'group'
  | 'round'
  | 'step'
  | 'type'
  | 'unknown'
  | 'project'
  | 'system'
  | 'retired'

/** A value of config.json's `time` that does not check out: where (time.clients.x.billing[1].round), and why. */
export interface TimeProblem {
  at: string
  why: ProblemWhy
  value?: string
}

/** The problems as one line: "time.zone: … ; time.clients.x.billing[0].round: …". */
export const problemsText = (ps: readonly TimeProblem[], tr: Translator): string =>
  ps.map(p => `${p.at}: ${tr(`time.problem.${p.why}`, { value: p.value ?? '' })}`).join('; ')

/** A case number of five digits, or a ticket key such as ABC-123 (a client with other text before its case sets its own `ref`). */
export const DEFAULT_REF = '\\b([A-Z][A-Z0-9]+-\\d+|\\d{5})\\b'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

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

/** A tag as kept: lowercase, one line, 40 characters at most, no comma (a list of them is joined by one). */
export const cleanTag = (s: string): string => cleanText(s.replaceAll(',', ' '), 40).toLowerCase()

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

const TIME_KEYS = ['on', 'zone', 'excludeTags', 'clients']
const CLIENT_KEYS = ['on', 'projects', 'retired', 'ref', 'zone', 'billing', 'billable', 'nonBillable', 'systems']
const SYSTEM_KEYS = ['id', 'title']
const SYSTEM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const RULE_KEYS = ['match', 'group', 'step', 'round']

const shown = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)))

function unknownKeys(o: Record<string, unknown>, known: readonly string[], at: string, problems: TimeProblem[]): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) problems.push({ at: `${at}.${k}`, why: 'unknown' })
}

/** A list of strings, or a problem (and null) when it is something else. */
function strings(v: unknown, at: string, problems: TimeProblem[]): string[] | null {
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v.map(text).filter(Boolean)
  problems.push({ at, why: 'type', value: shown(v) })
  return null
}

function ruleOf(raw: unknown, at: string, problems: TimeProblem[]): BillingRule | null {
  if (!isObject(raw)) {
    problems.push({ at, why: 'type', value: shown(raw) })
    return null
  }
  const before = problems.length
  unknownKeys(raw, RULE_KEYS, at, problems)
  let match: string | null = null
  if (typeof raw.match === 'string') match = raw.match.trim() || null
  else if (raw.match !== undefined && raw.match !== null)
    problems.push({ at: `${at}.match`, why: 'type', value: shown(raw.match) })
  if (match && !goodRegex(match)) problems.push({ at: `${at}.match`, why: 'regex', value: match })
  const group = raw.group as Group
  if (raw.group === undefined) problems.push({ at: `${at}.group`, why: 'required' })
  else if (!GROUPS.includes(group)) problems.push({ at: `${at}.group`, why: 'group', value: shown(raw.group) })
  const round = raw.round as Round
  if (raw.round === undefined) problems.push({ at: `${at}.round`, why: 'required' })
  else if (!ROUNDS.includes(round)) problems.push({ at: `${at}.round`, why: 'round', value: shown(raw.round) })
  const step = typeof raw.step === 'number' ? raw.step : Number.NaN
  if (round !== 'exact' && ROUNDS.includes(round) && !(step > 0 && step <= 24 * 60))
    problems.push({ at: `${at}.step`, why: 'step', value: shown(raw.step) })
  if (problems.length > before) return null
  return { match, group, step: round === 'exact' ? 0 : step, round }
}

/** A client's systems: ids (a-z, 0-9, -) each once, as a string or { id, title }. */
function systemsOf(v: unknown, at: string, problems: TimeProblem[]): TimeSystem[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    problems.push({ at, why: 'type', value: shown(v) })
    return []
  }
  const out: TimeSystem[] = []
  for (const [i, raw] of v.entries()) {
    const place = `${at}[${i}]`
    const o = isObject(raw) ? raw : null
    if (o) unknownKeys(o, SYSTEM_KEYS, place, problems)
    const id = typeof raw === 'string' ? raw.trim() : o && typeof o.id === 'string' ? o.id.trim() : null
    if (id === null) problems.push({ at: place, why: 'type', value: shown(raw) })
    else if (!SYSTEM_ID.test(id) || out.some(x => x.id === id)) problems.push({ at: place, why: 'system', value: id })
    else if (o && o.title !== undefined && typeof o.title !== 'string')
      problems.push({ at: `${place}.title`, why: 'type', value: shown(o.title) })
    else out.push({ id, title: (o && typeof o.title === 'string' && cleanText(o.title, 40)) || id })
  }
  return out
}

/** An `on` that is there: a boolean, or a problem (and on). */
function onOf(v: unknown, at: string, problems: TimeProblem[]): boolean {
  if (v === undefined || typeof v === 'boolean') return v !== false
  problems.push({ at, why: 'type', value: shown(v) })
  return true
}

/**
 * config.json's `time`: an object or `true` turns it on; anything else is off (null), and so is an
 * object with `on: false` (its settings kept for when it is on again). `true` is the computer's own
 * zone and every lane; an object names its `zone`. What does not check out is in `problems`, and
 * the rest is read as well as it can be, for a view that says so.
 */
export function timeConfig(raw: unknown): TimeConfig | null {
  if (raw !== true && !isObject(raw)) return null
  const problems: TimeProblem[] = []
  if (raw === true) return { zone: localZone(), excludeTags: ['deferred'], clients: null, problems }
  const c = raw as Record<string, unknown>
  if (c.on === false) return null
  onOf(c.on, 'time.on', problems)
  unknownKeys(c, TIME_KEYS, 'time', problems)
  let zone = localZone()
  if (c.zone === undefined) problems.push({ at: 'time.zone', why: 'required' })
  else if (typeof c.zone !== 'string' || !knownZone(text(c.zone)))
    problems.push({ at: 'time.zone', why: 'zone', value: shown(c.zone) })
  else zone = text(c.zone)
  const excludeTags =
    c.excludeTags === undefined
      ? ['deferred']
      : [...new Set((strings(c.excludeTags, 'time.excludeTags', problems) ?? []).map(cleanTag).filter(Boolean))]
  let clients: TimeConfig['clients'] = null
  if (c.clients !== undefined && !isObject(c.clients))
    problems.push({ at: 'time.clients', why: 'type', value: shown(c.clients) })
  if (isObject(c.clients)) {
    clients = {}
    for (const [id, v] of Object.entries(c.clients)) {
      const at = `time.clients.${id}`
      if (!isObject(v)) problems.push({ at, why: 'type', value: shown(v) })
      const o = isObject(v) ? v : {}
      unknownKeys(o, CLIENT_KEYS, at, problems)
      const on = onOf(o.on, `${at}.on`, problems)
      const projects = o.projects === undefined ? null : [...new Set(strings(o.projects, `${at}.projects`, problems))]
      const retired = o.retired === undefined ? [] : [...new Set(strings(o.retired, `${at}.retired`, problems) ?? [])]
      // offered and retired at once: which one it is would be a guess
      if (projects)
        retired.forEach((project, i) => {
          if (projects.some(p => sameProject(p, project)))
            problems.push({ at: `${at}.retired[${i}]`, why: 'retired', value: project })
        })
      let ref = DEFAULT_REF
      if (typeof o.ref === 'string' && text(o.ref)) {
        if (goodRegex(text(o.ref))) ref = text(o.ref)
        else problems.push({ at: `${at}.ref`, why: 'regex', value: text(o.ref) })
      } else if (o.ref !== undefined) problems.push({ at: `${at}.ref`, why: 'type', value: shown(o.ref) })
      let own: string | null = null
      if (o.zone !== undefined) {
        if (typeof o.zone === 'string' && knownZone(text(o.zone))) own = text(o.zone)
        else problems.push({ at: `${at}.zone`, why: 'zone', value: shown(o.zone) })
      }
      let billing: BillingRule[] = []
      if (Array.isArray(o.billing))
        billing = o.billing
          .map((r, i) => ruleOf(r, `${at}.billing[${i}]`, problems))
          .filter((r): r is BillingRule => r !== null)
      else if (o.billing !== undefined) problems.push({ at: `${at}.billing`, why: 'type', value: shown(o.billing) })
      let billable = true
      if (typeof o.billable === 'boolean') billable = o.billable
      else if (o.billable !== undefined) problems.push({ at: `${at}.billable`, why: 'type', value: shown(o.billable) })
      const nonBillable =
        o.nonBillable === undefined ? [] : [...new Set(strings(o.nonBillable, `${at}.nonBillable`, problems) ?? [])]
      // a project the client does not take is a slip of the pen, not a rule (a retired one it had)
      if (projects)
        nonBillable.forEach((project, i) => {
          if (!projects.includes(project) && !retired.includes(project))
            problems.push({ at: `${at}.nonBillable[${i}]`, why: 'project', value: project })
        })
      const systems = systemsOf(o.systems, `${at}.systems`, problems)
      clients[id] = { on, projects, retired, ref, zone: own, billing, billable, nonBillable, systems }
    }
  }
  return { zone, excludeTags, clients, problems }
}

/** A client's settings, or why it takes no time (a text key). */
export function clientOf(c: TimeConfig, client: string): { ok: true; client: TimeClient } | { ok: false; key: string } {
  if (!c.clients) return { ok: true, client: ANY_CLIENT }
  const found = c.clients[client]
  return found ? { ok: true, client: found } : { ok: false, key: 'time.err.client' }
}

export const zoneOf = (c: TimeConfig, client: string): string => c.clients?.[client]?.zone ?? c.zone

/** The characters that do not show: zero-width spaces and joiners, the word joiner, the BOM, the soft hyphen. */
const UNSEEN = new RegExp(
  `[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad].map(c => String.fromCharCode(c)).join('')}]`,
  'g',
)

/**
 * A project's name as names are told apart: case, spaces and the characters that do not show aside,
 * the same letters however they are encoded ("support " is "Support"; "Café" composed or not, or
 * with a zero-width space in it, is one name).
 */
export const projectKey = (name: string): string =>
  name.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(UNSEEN, '')

export const sameProject = (a: string, b: string): boolean => projectKey(a) === projectKey(b)

/** The name a list has for a project typed (case and spaces aside), or null. */
export const projectIn = (list: readonly string[], name: string): string | null =>
  list.find(p => sameProject(p, name)) ?? null

/** The lanes that take new entries: the clients on (null: every lane). */
export const takersOf = (c: TimeConfig): string[] | null =>
  c.clients
    ? Object.entries(c.clients)
        .filter(([, x]) => x.on)
        .map(([id]) => id)
    : null

/** A client as `time: true` has every lane: any project, billed, nowhere to enter it. */
const ANY_CLIENT: TimeClient = {
  on: true,
  projects: null,
  retired: [],
  ref: DEFAULT_REF,
  zone: null,
  billing: [],
  billable: true,
  nonBillable: [],
  systems: [],
}

/** Whether a client's entries on a project are billable by default (its `billable`, then `nonBillable`). */
export function billableByDefault(c: TimeConfig, client: string, project: string): boolean {
  const own = clientOf(c, client)
  if (!own.ok) return true
  return own.client.billable && !own.client.nonBillable.includes(project)
}

/** Whether an entry is billable: as set on it, else as its client and project say. */
export const billableOf = (c: TimeConfig, e: Pick<TimeEntry, 'client' | 'project' | 'billable'>): boolean =>
  e.billable ?? billableByDefault(c, e.client, e.project)

/** The systems a client's time is entered in (none: nothing to enter). */
export const systemsFor = (c: TimeConfig, client: string): TimeSystem[] => {
  const own = clientOf(c, client)
  return own.ok ? own.client.systems : []
}

// ------------------------------------------------------------------ dates and times

// a formatter per zone, made once: making one costs more than using it many times
const dateFormats = new Map<string, Intl.DateTimeFormat>()
const clockFormats = new Map<string, Intl.DateTimeFormat>()
function formatOf(cache: Map<string, Intl.DateTimeFormat>, zone: string, make: () => Intl.DateTimeFormat) {
  const had = cache.get(zone)
  if (had) return had
  const f = make()
  cache.set(zone, f)
  return f
}

/** The date of an instant in a time zone, YYYY-MM-DD. */
export function dateIn(at: number, zone: string): string {
  const parts = formatOf(
    dateFormats,
    zone,
    () => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
  )
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((o, p) => {
      o[p.type] = p.value
      return o
    }, {})
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** The wall clock of an instant in a time zone: [h, m, s]. */
export function clockIn(at: number, zone: string): [number, number, number] {
  const parts = formatOf(
    clockFormats,
    zone,
    () =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
  )
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
 * The instant a wall clock on a date shows in a time zone, east or west of UTC. A time the zone
 * skips that day (the spring's DST gap) is moved forward by the gap; one it shows twice (the
 * autumn's) is the first.
 */
export function instantIn(date: string, clock: readonly [number, number, number], zone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const wall = Date.UTC(y, mo - 1, d, clock[0], clock[1], clock[2])
  // the zone's offsets a day before and a day after: no change of offset lies outside them, and
  // where both fit (the autumn's repeat) the earlier instant is the one
  const before = offsetAt(wall - 86_400_000, zone)
  const after = offsetAt(wall + 86_400_000, zone)
  const candidates = [wall - before, wall - after].filter(at => {
    const [h, mi, s] = clockIn(at, zone)
    return dateIn(at, zone) === date && h === clock[0] && mi === clock[1] && s === clock[2]
  })
  if (candidates.length) return Math.min(...candidates)
  // the gap: the same wall time with the offset from before it, which lands past the gap
  return wall - before
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

/** How far ahead "HH:MM" may be before it means yesterday's: past midnight, "21:00" is last evening. */
const HM_AHEAD_MS = 3_600_000

/**
 * A time as a command takes it: ISO with an offset or Z ("2026-10-28T09:00:00+03:00"), or the
 * computer's own clock: "HH:MM" (today's, or yesterday's when today's is more than an hour ahead,
 * unless `yesterday` is false), "YYYY-MM-DD HH:MM". The instant, or null.
 */
export function parseWhen(s: string, now: number = Date.now(), o: { yesterday?: boolean } = {}): number | null {
  const v = s.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const at = Date.parse(v)
    return Number.isNaN(at) ? null : at
  }
  let m = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (m) {
    if (!(Number(m[1]) < 24 && Number(m[2]) < 60)) return null
    const d = new Date(now)
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    if (o.yesterday !== false && d.getTime() > now + HM_AHEAD_MS) d.setDate(d.getDate() - 1)
    return d.getTime()
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(v)
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
    const at = new Date(y, mo - 1, d, h, mi, 0, 0)
    return at.getMonth() === mo - 1 && h < 24 && mi < 60 ? at.getTime() : null
  }
  return null
}

/** How far from now an entry's time may be: a day ahead, a year back. */
export const AHEAD_MS = 86_400_000
export const BACK_MS = 366 * 86_400_000

/** Whether an instant is one an entry may have: not more than a day ahead, nor a year back. */
export const plausible = (at: number, now: number = Date.now()): boolean => at <= now + AHEAD_MS && at >= now - BACK_MS

/** An instant as the store keeps it: UTC to the second. */
export const isoOf = (at: number): string => new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z')

/** Seconds as H:MM (rounded to the minute). */
export function hm(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const sign = minutes < 0 ? '-' : ''
  const a = Math.abs(minutes)
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

/**
 * Seconds as the board says a duration everywhere (the panel, a lane's total, the editor, the
 * command's day), to the minute and in its language: "1h 30m", "45m", "2h"; "1 ч 30 мин".
 */
export function durationText(seconds: number, t: Translator): string {
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return t('time.dur.m', { m })
  return m ? t('time.dur.hm', { h, m }) : t('time.dur.h', { h })
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
  /** Set by a person, an agent or the import; absent: as the config says (billableOf). */
  billable?: boolean
}

export const secondsOf = (e: Pick<TimeEntry, 'start' | 'stop'>): number =>
  Math.round((Date.parse(e.stop) - Date.parse(e.start)) / 1000)

/** Where an entry was entered: a system of its client's, when, by whom, that system's id for it, the entry's revision then. */
export interface EntryPost {
  system: string
  at: number
  by: Actor
  record: string | null
  rev: number
}

/**
 * An entry as the JSON gives it (`board time --json`, the Time panel): the stored fields, its
 * `seconds`, `billable` as it comes out with `billableDefault` (true: as the config says, not set
 * on it), and `posts`, where it was entered, each with `changedAfter` (the entry changed since).
 */
export function entryView(c: TimeConfig, e: TimeEntry, posts: readonly EntryPost[] = []) {
  return {
    ...e,
    seconds: secondsOf(e),
    billable: billableOf(c, e),
    billableDefault: e.billable === undefined,
    posts: posts.map(p => ({
      system: p.system,
      at: p.at,
      by: p.by,
      record: p.record,
      rev: p.rev,
      changedAfter: p.rev < e.rev,
    })),
  }
}

export type EntryView = ReturnType<typeof entryView>

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
  /** Entries not billable: in no line, counted in `seconds` (worked), never billed. */
  nonBillable: string[]
  /** Worked: the lines' and the non-billable entries'. */
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
 * exact; an entry not billable apart (worked, never billed: it joins no line, so no rounding and
 * no Raise or Trim touches it); then one with an excluded tag held (billable later). Lines in the
 * order of their first entry's start.
 */
export function clientDay(c: TimeConfig, client: string, date: string, entries: readonly TimeEntry[]): ClientDay {
  const settings = clientOf(c, client)
  const own = settings.ok ? settings.client : ANY_CLIENT
  const sorted = [...entries].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1))
  const held: string[] = []
  const nonBillable: string[] = []
  let unbilled = 0
  const lines = new Map<string, DayLine & { first: string }>()
  const matchers = own.billing.map(r => (r.match ? new RegExp(r.match, 'i') : null))
  for (const e of sorted) {
    if (!billableOf(c, e)) {
      nonBillable.push(e.id)
      unbilled += secondsOf(e)
      continue
    }
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
    // a reference is one line whatever its project (a case under two projects is rounded once);
    // entries with none, by project
    else if (rule.group === 'ref') key = ref ? `${index}:ref\u0000${ref}` : `${index}:project\u0000${e.project}`
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
    if ((rule?.group === 'day' || rule?.group === 'ref') && line.project !== e.project) line.project = ''
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
    nonBillable,
    seconds: out.reduce((n, l) => n + l.seconds, 0) + unbilled,
    billedSeconds: out.reduce((n, l) => n + l.billedSeconds, 0),
  }
}
