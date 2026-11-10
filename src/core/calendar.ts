// The calendar (#328): the owner's events from several sources in one model, for the board's
// Calendar panel and `board cal`. The rules here: config.json's `calendar` (strict, like `time`),
// the event as every source gives it, a join link found in what an event says, the window a sync
// keeps, and how events are put together and asked for. No I/O: the sources' fetches are
// adapters/calendar-sources.ts, the copies they leave adapters/calendar-cache.ts, the board's own
// events adapters/calendar-store.ts, the sync services/calendar.ts.
//
// Off is the default: no `calendar` in config.json, or `on: false`, and calendarConfig answers
// null; nothing then reads, fetches or keeps a timer for it.
import { addDays, cleanText, dateIn, instantIn, isDate, knownZone, localZone } from './time.ts'
import type { Translator } from './types.ts'

// ------------------------------------------------------------------ the event

export type SourceKind = 'ics' | 'mcp' | 'push' | 'board'
export const SOURCE_KINDS: readonly SourceKind[] = ['ics', 'mcp', 'push', 'board']
export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'
/** The owner's own answer to an invitation, where the source says it. */
export type EventResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction'
/** What the event is beside a meeting (Google's event types). */
export type EventKind = 'default' | 'workingLocation' | 'outOfOffice' | 'focusTime'

/**
 * One event, whatever source it came from. A timed event's `start` and `end` are ISO instants with
 * an offset or Z; an all-day one's are dates (YYYY-MM-DD), `end` the day after its last. `id` is
 * the source's own, unique within it (a recurring event's instance has its own).
 */
export interface CalEvent {
  source: string
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  /** The zone the event was written in (IANA, or the name its source gave), for a hint. */
  zone?: string
  location?: string
  /** A video call's address (Meet, Zoom, Teams…), one tap away. */
  join?: string
  /** The event's page at its provider. */
  link?: string
  /** How many are invited, the owner too. */
  attendees?: number
  status: EventStatus
  response?: EventResponse
  kind?: EventKind
  /** The series it is an instance of, when its source says. */
  series?: string
  /** A board event's own note. */
  note?: string
  /** A board event: who made it, who changed it last and when, its revision. */
  by?: string
  at?: number
  changedBy?: string
  changed?: number
  rev?: number
}

const STATUSES: readonly EventStatus[] = ['confirmed', 'tentative', 'cancelled']
const RESPONSES: readonly EventResponse[] = ['accepted', 'declined', 'tentative', 'needsAction']
const KINDS: readonly EventKind[] = ['default', 'workingLocation', 'outOfOffice', 'focusTime']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** An ISO instant with an offset or Z, as an event's time is written. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
export const isInstant = (s: string): boolean => ISO_INSTANT.test(s) && !Number.isNaN(Date.parse(s))

/** An address kept only when it is http(s) and one line. */
export function webAddress(v: unknown): string | null {
  const s = str(v)
  if (!s || s.length > 2000 || /\s/.test(s)) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * An event as a source handed it over (a push, a generic MCP server's JSON, the cache read back):
 * checked field by field, null when it cannot be one (no id, no title and no times that read).
 */
export function eventOf(raw: unknown, source: string): CalEvent | null {
  if (!isObject(raw)) return null
  const id = cleanText(str(raw.id), 300)
  const allDay = raw.allDay === true || (isDate(str(raw.start)) && isDate(str(raw.end)))
  let start = str(raw.start)
  let end = str(raw.end)
  if (!id) return null
  if (allDay) {
    if (!isDate(start)) return null
    if (!isDate(end) || end <= start) end = addDays(start, 1)
  } else {
    if (!isInstant(start)) return null
    if (!isInstant(end) || Date.parse(end) < Date.parse(start)) end = start
    start = normalInstant(start)
    end = normalInstant(end)
  }
  const e: CalEvent = {
    source,
    id,
    title: cleanText(str(raw.title), 500),
    start,
    end,
    allDay,
    status: STATUSES.includes(raw.status as EventStatus) ? (raw.status as EventStatus) : 'confirmed',
  }
  const zone = cleanText(str(raw.zone), 100)
  if (zone) e.zone = zone
  const location = cleanText(str(raw.location), 500)
  if (location) e.location = location
  const join = webAddress(raw.join)
  if (join) e.join = join
  const link = webAddress(raw.link)
  if (link) e.link = link
  if (typeof raw.attendees === 'number' && Number.isInteger(raw.attendees) && raw.attendees >= 0)
    e.attendees = raw.attendees
  if (RESPONSES.includes(raw.response as EventResponse)) e.response = raw.response as EventResponse
  if (KINDS.includes(raw.kind as EventKind) && raw.kind !== 'default') e.kind = raw.kind as EventKind
  const series = cleanText(str(raw.series), 300)
  if (series) e.series = series
  const note = cleanText(str(raw.note), 2000)
  if (note) e.note = note
  return e
}

/** An instant as it came, with its offset (the zone it was said in), seconds kept, fractions off. */
function normalInstant(s: string): string {
  return s.replace(/\.\d+(?=Z|[+-])/i, '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
}

// ------------------------------------------------------------------ join links

/** Video calls' addresses, by provider: the first one found is the event's join link. */
const JOIN_PATTERNS: readonly RegExp[] = [
  /https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3}[^\s<>"'`)\]]*/i,
  /https:\/\/meet\.google\.com\/lookup\/[^\s<>"'`)\]]+/i,
  /https:\/\/(?:[\w-]+\.)*zoom\.us\/(?:j|my|w|s|wc\/join)\/[^\s<>"'`)\]]+/i,
  /https:\/\/(?:[\w-]+\.)*zoomgov\.com\/(?:j|my|w|s)\/[^\s<>"'`)\]]+/i,
  /https:\/\/teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/[^\s<>"'`)\]]+/i,
  /https:\/\/teams\.live\.com\/meet\/[^\s<>"'`)\]]+/i,
  /https:\/\/(?:[\w-]+\.)*webex\.com\/(?:meet|join|[\w-]+\/j\.php|wbxmjs)[^\s<>"'`)\]]*/i,
  /https:\/\/meet\.jit\.si\/[^\s<>"'`)\]]+/i,
  /https:\/\/(?:[\w-]+\.)?whereby\.com\/[^\s<>"'`)\]]+/i,
  /https:\/\/telemost\.yandex\.(?:ru|com)\/j\/[^\s<>"'`)\]]+/i,
  /https:\/\/(?:global\.)?gotomeeting\.com\/join\/\d+/i,
  /https:\/\/meet\.goto\.com\/\d+/i,
  /https:\/\/chime\.aws\/\d+/i,
  /https:\/\/(?:[\w-]+\.)?bluejeans\.com\/\d+[^\s<>"'`)\]]*/i,
]

/** HTML's escapes an address may carry in a description written as HTML. */
const unHtml = (s: string): string =>
  s
    .replace(/&amp;/gi, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')

/** The first video call's address in these texts, in their order (a conference field first, then the place, then the description). */
export function joinLinkIn(...texts: readonly (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue
    const plain = unHtml(text)
    for (const p of JOIN_PATTERNS) {
      const m = p.exec(plain)
      if (m) {
        const url = webAddress(m[0].replace(/[.,;:!?]+$/, ''))
        if (url) return url
      }
    }
  }
  return null
}

// ------------------------------------------------------------------ config

export type CalProblemWhy = 'type' | 'unknown' | 'required' | 'id' | 'kind' | 'duplicate' | 'url' | 'color' | 'range'

/** A value of `calendar` that does not check out: where (calendar.sources.0.url), and why. */
export interface CalProblem {
  at: string
  why: CalProblemWhy
  value?: string
}

export const problemsText = (ps: readonly CalProblem[], tr: Translator): string =>
  ps.map(p => `${p.at}: ${tr(`cal.problem.${p.why}`, { value: p.value ?? '' })}`).join('; ')

/** The presets a `mcp` source may name: how the board calls a known server and reads its answer. */
export type McpPreset = 'google-workspace'
export const MCP_PRESETS: readonly McpPreset[] = ['google-workspace']

export interface CalSource {
  id: string
  kind: SourceKind
  /** A short label, as the view marks the source's events. */
  label: string
  /** #rrggbb; null: the lane's colour, else one of the view's own. */
  color: string | null
  /** A lane (a category's id): its events read as that client's, in its colour. */
  lane: string | null
  /** How often it is fetched, in minutes (ics and mcp). */
  everyMin: number
  /** mcp: the server's address (Streamable HTTP). */
  url: string | null
  /** mcp: a known server's preset; null: the generic form (`list`). */
  preset: McpPreset | null
  /** The owner's address at this source: the preset's account, and the invitee whose answer is the owner's. */
  account: string | null
  /** mcp, google-workspace: the calendars read ("primary" when none is named). */
  calendars: string[]
  /** mcp, generic: the tool that lists events and its arguments, `{from}` and `{to}` filled in. */
  list: { tool: string; args: Record<string, unknown> } | null
  /** Minutes before an event its reminder comes (#335); null: the calendar's own; 0: none. */
  remindMin: number | null
  /** The source takes writes (mcp with a write tool): only for an event the owner asked for. */
  write: boolean
  /** mcp, generic: the tool that writes, when `write`. */
  writeTool: string | null
  /** What does not check out in it: a source with a problem is not fetched. */
  problems: CalProblem[]
}

/** Reminders before events (#335): on unless config.json turns them off. */
export interface ReminderSettings {
  on: boolean
  /** Minutes before an event's start, unless its source says otherwise. */
  beforeMin: number
  /** Minutes a Snooze puts a reminder off. */
  snoozeMin: number
}

export interface CalendarConfig {
  /** How often a source is fetched unless it says otherwise, in minutes. */
  everyMin: number
  /** The window a sync keeps: so many days back and ahead of today. */
  pastDays: number
  futureDays: number
  reminders: ReminderSettings
  /** The board's own calendar is always among them, first. */
  sources: CalSource[]
  /** What does not check out outside any one source. */
  problems: CalProblem[]
}

export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** The board's own calendar's id. */
export const BOARD_SOURCE = 'board'
export const DEFAULT_EVERY_MIN = 5
const MIN_EVERY_MIN = 1
const MAX_EVERY_MIN = 24 * 60
const DEFAULT_PAST_DAYS = 35
const DEFAULT_FUTURE_DAYS = 90
const MAX_DAYS = 400
const COLOR = /^#[0-9a-f]{6}$/i

export const DEFAULT_BEFORE_MIN = 10
export const DEFAULT_SNOOZE_MIN = 5
const MAX_BEFORE_MIN = 24 * 60
const MAX_SNOOZE_MIN = 4 * 60

const CALENDAR_KEYS = ['on', 'everyMin', 'pastDays', 'futureDays', 'reminders', 'sources']
const REMINDER_KEYS = ['on', 'beforeMin', 'snoozeMin']
const SOURCE_KEYS: Record<SourceKind, readonly string[]> = {
  board: ['id', 'kind', 'label', 'color', 'lane', 'remindMin'],
  push: ['id', 'kind', 'label', 'color', 'lane', 'account', 'remindMin'],
  ics: ['id', 'kind', 'label', 'color', 'lane', 'everyMin', 'account', 'remindMin'],
  mcp: [
    'id',
    'kind',
    'label',
    'color',
    'lane',
    'everyMin',
    'url',
    'preset',
    'account',
    'calendars',
    'list',
    'write',
    'remindMin',
  ],
}

const shown = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)))

function unknownKeys(o: Record<string, unknown>, known: readonly string[], at: string, problems: CalProblem[]): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) problems.push({ at: `${at}.${k}`, why: 'unknown' })
}

function numberIn(v: unknown, at: string, min: number, max: number, fallback: number, problems: CalProblem[]): number {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    problems.push({ at, why: 'range', value: shown(v) })
    return fallback
  }
  return v
}

/** Whole minutes in [min, max], or the fallback and a problem. */
const minutesIn = (
  v: unknown,
  at: string,
  min: number,
  max: number,
  fallback: number,
  problems: CalProblem[],
): number => Math.round(numberIn(v, at, min, max, fallback, problems))

/** config.json's `calendar.reminders`: `false` turns them off, an object sets them; absent, they are on. */
function remindersOf(v: unknown, problems: CalProblem[]): ReminderSettings {
  const r: ReminderSettings = { on: true, beforeMin: DEFAULT_BEFORE_MIN, snoozeMin: DEFAULT_SNOOZE_MIN }
  if (v === undefined || v === true) return r
  if (v === false) return { ...r, on: false }
  if (!isObject(v)) {
    problems.push({ at: 'calendar.reminders', why: 'type', value: shown(v) })
    return r
  }
  unknownKeys(v, REMINDER_KEYS, 'calendar.reminders', problems)
  if (v.on === false) r.on = false
  else if (v.on !== undefined && v.on !== true)
    problems.push({ at: 'calendar.reminders.on', why: 'type', value: shown(v.on) })
  r.beforeMin = minutesIn(v.beforeMin, 'calendar.reminders.beforeMin', 1, MAX_BEFORE_MIN, DEFAULT_BEFORE_MIN, problems)
  r.snoozeMin = minutesIn(v.snoozeMin, 'calendar.reminders.snoozeMin', 1, MAX_SNOOZE_MIN, DEFAULT_SNOOZE_MIN, problems)
  return r
}

/** A source's `remindMin`: minutes, 0 or `false` for none; absent, the calendar's own (null). */
function remindMinOf(v: unknown, at: string, problems: CalProblem[]): number | null {
  if (v === undefined) return null
  if (v === false) return 0
  const n = minutesIn(v, at, 0, MAX_BEFORE_MIN, -1, problems)
  return n < 0 ? null : n
}

/** A local server's or a provider's address: http on this computer, https anywhere. */
export function serverAddress(v: unknown): string | null {
  const url = webAddress(v)
  if (!url) return null
  const u = new URL(url)
  if (u.protocol === 'https:') return url
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? url : null
}

function sourceOf(raw: unknown, i: number, everyMin: number): CalSource {
  const at = `calendar.sources.${i}`
  const problems: CalProblem[] = []
  const o = isObject(raw) ? raw : {}
  if (!isObject(raw)) problems.push({ at, why: 'type', value: shown(raw) })
  const id = str(o.id)
  if (!id) problems.push({ at: `${at}.id`, why: 'required' })
  else if (!SOURCE_ID.test(id)) problems.push({ at: `${at}.id`, why: 'id', value: id })
  const kind = o.kind as SourceKind
  const known = SOURCE_KINDS.includes(kind)
  if (isObject(raw) && !known)
    problems.push({ at: `${at}.kind`, why: o.kind === undefined ? 'required' : 'kind', value: shown(o.kind) })
  if (isObject(raw) && known) unknownKeys(o, SOURCE_KEYS[kind], at, problems)
  const label = cleanText(str(o.label), 40) || id
  let color: string | null = null
  if (o.color !== undefined) {
    if (typeof o.color === 'string' && COLOR.test(o.color)) color = o.color.toLowerCase()
    else problems.push({ at: `${at}.color`, why: 'color', value: shown(o.color) })
  }
  const lane = str(o.lane) || null
  const account = str(o.account) || null
  const source: CalSource = {
    id,
    kind: known ? kind : 'push',
    label,
    color,
    lane,
    everyMin: numberIn(o.everyMin, `${at}.everyMin`, MIN_EVERY_MIN, MAX_EVERY_MIN, everyMin, problems),
    remindMin: remindMinOf(o.remindMin, `${at}.remindMin`, problems),
    url: null,
    preset: null,
    account,
    calendars: [],
    list: null,
    write: false,
    writeTool: null,
    problems,
  }
  if (kind !== 'mcp') return source
  source.url = serverAddress(o.url)
  if (!source.url)
    problems.push({ at: `${at}.url`, why: o.url === undefined ? 'required' : 'url', value: shown(o.url) })
  if (o.preset !== undefined) {
    if (MCP_PRESETS.includes(o.preset as McpPreset)) source.preset = o.preset as McpPreset
    else problems.push({ at: `${at}.preset`, why: 'kind', value: shown(o.preset) })
  }
  if (o.calendars !== undefined) {
    if (Array.isArray(o.calendars) && o.calendars.every(c => typeof c === 'string' && c.trim()))
      source.calendars = [...new Set((o.calendars as string[]).map(c => c.trim()))]
    else problems.push({ at: `${at}.calendars`, why: 'type', value: shown(o.calendars) })
  }
  if (source.preset === 'google-workspace') {
    if (!account) problems.push({ at: `${at}.account`, why: 'required' })
    if (!source.calendars.length) source.calendars = ['primary']
  }
  if (o.list !== undefined) {
    const l = isObject(o.list) ? o.list : null
    const tool = str(l?.tool)
    const args = l?.args === undefined ? {} : l.args
    if (!l || !tool || !isObject(args)) problems.push({ at: `${at}.list`, why: 'type', value: shown(o.list) })
    else source.list = { tool, args }
  } else if (!source.preset) problems.push({ at: `${at}.list`, why: 'required' })
  if (o.write !== undefined) {
    if (o.write === true || o.write === false) source.write = o.write
    else if (typeof o.write === 'string' && o.write.trim()) {
      source.write = true
      source.writeTool = o.write.trim()
    } else problems.push({ at: `${at}.write`, why: 'type', value: shown(o.write) })
  }
  if (source.write && !source.preset && !source.writeTool)
    problems.push({ at: `${at}.write`, why: 'required', value: shown(o.write) })
  return source
}

/** The board's own calendar as it is when config.json does not restyle it. */
const boardSource = (): CalSource => ({
  id: BOARD_SOURCE,
  kind: 'board',
  label: '',
  color: null,
  lane: null,
  everyMin: DEFAULT_EVERY_MIN,
  remindMin: null,
  url: null,
  preset: null,
  account: null,
  calendars: [],
  list: null,
  write: true,
  writeTool: null,
  problems: [],
})

/**
 * config.json's `calendar`: an object or `true` turns it on; anything else is off (null), and so
 * is an object with `on: false` (its sources kept for when it is on again). The board's own
 * calendar is always a source (`board`); one with `kind: "board"` in `sources` restyles it. What
 * does not check out is in `problems`, the source's own in its own.
 */
export function calendarConfig(raw: unknown): CalendarConfig | null {
  if (raw !== true && !isObject(raw)) return null
  const problems: CalProblem[] = []
  const base: CalendarConfig = {
    everyMin: DEFAULT_EVERY_MIN,
    pastDays: DEFAULT_PAST_DAYS,
    futureDays: DEFAULT_FUTURE_DAYS,
    reminders: remindersOf(undefined, problems),
    sources: [boardSource()],
    problems,
  }
  if (raw === true) return base
  const c = raw as Record<string, unknown>
  if (c.on === false) return null
  if (c.on !== undefined && c.on !== true) problems.push({ at: 'calendar.on', why: 'type', value: shown(c.on) })
  unknownKeys(c, CALENDAR_KEYS, 'calendar', problems)
  base.everyMin = numberIn(c.everyMin, 'calendar.everyMin', MIN_EVERY_MIN, MAX_EVERY_MIN, DEFAULT_EVERY_MIN, problems)
  base.pastDays = Math.round(numberIn(c.pastDays, 'calendar.pastDays', 0, MAX_DAYS, DEFAULT_PAST_DAYS, problems))
  base.futureDays = Math.round(
    numberIn(c.futureDays, 'calendar.futureDays', 1, MAX_DAYS, DEFAULT_FUTURE_DAYS, problems),
  )
  base.reminders = remindersOf(c.reminders, problems)
  if (c.sources === undefined) return base
  if (!Array.isArray(c.sources)) {
    problems.push({ at: 'calendar.sources', why: 'type', value: shown(c.sources) })
    return base
  }
  const seen = new Set<string>()
  c.sources.forEach((raw, i) => {
    const s = sourceOf(raw, i, base.everyMin)
    if (s.kind === 'board') {
      if (s.id && s.id !== BOARD_SOURCE) s.problems.push({ at: `calendar.sources.${i}.id`, why: 'id', value: s.id })
      const own = base.sources[0] as CalSource
      base.sources[0] = {
        ...own,
        label: s.label === s.id ? own.label : s.label,
        color: s.color,
        lane: s.lane,
        remindMin: s.remindMin,
      }
      if (s.problems.length) problems.push(...s.problems)
      return
    }
    if (s.id && seen.has(s.id)) s.problems.push({ at: `calendar.sources.${i}.id`, why: 'duplicate', value: s.id })
    if (s.id === BOARD_SOURCE) s.problems.push({ at: `calendar.sources.${i}.id`, why: 'duplicate', value: s.id })
    if (s.id) seen.add(s.id)
    base.sources.push(s)
  })
  return base
}

/** A source by id, or null. */
export const sourceById = (c: CalendarConfig, id: string): CalSource | null => c.sources.find(s => s.id === id) ?? null

/** Sources the board fetches itself (ics and mcp), with nothing wrong in them. */
export const fetchedSources = (c: CalendarConfig): CalSource[] =>
  c.sources.filter(s => (s.kind === 'ics' || s.kind === 'mcp') && !s.problems.length)

/** Whether a source takes writes to its provider: an mcp source with `write`. */
export const writesToProvider = (s: CalSource): boolean => s.kind === 'mcp' && s.write && !s.problems.length

// ------------------------------------------------------------------ times and windows

/** An event's span as instants; an all-day one's from midnight to midnight in `zone`. */
export function spanOf(e: Pick<CalEvent, 'start' | 'end' | 'allDay'>, zone: string): { start: number; end: number } {
  if (e.allDay) return { start: instantIn(e.start, [0, 0, 0], zone), end: instantIn(e.end, [0, 0, 0], zone) }
  return { start: Date.parse(e.start), end: Date.parse(e.end) }
}

/** Whether an event lies in [from, to) at all (one with no length: at its start). */
export function inWindow(e: CalEvent, from: number, to: number, zone: string): boolean {
  const s = spanOf(e, zone)
  return s.start < to && (s.end > from || (s.end === s.start && s.start >= from))
}

/** The window a sync keeps around `now`: from midnight `pastDays` back to midnight after `futureDays` ahead, in `zone`. */
export function syncWindow(
  c: Pick<CalendarConfig, 'pastDays' | 'futureDays'>,
  now: number,
  zone: string = localZone(),
): { from: number; to: number } {
  const today = dateIn(now, zone)
  return {
    from: instantIn(addDays(today, -c.pastDays), [0, 0, 0], zone),
    to: instantIn(addDays(today, c.futureDays + 1), [0, 0, 0], zone),
  }
}

/** A day's window in `zone`. */
export function dayWindow(date: string, zone: string, days = 1): { from: number; to: number } {
  return { from: instantIn(date, [0, 0, 0], zone), to: instantIn(addDays(date, days), [0, 0, 0], zone) }
}

/** Events in order: by start, an all-day one before a timed one that day, then the longer, then by source and title. */
export function byStart(zone: string): (a: CalEvent, b: CalEvent) => number {
  return (a, b) => {
    const sa = spanOf(a, zone)
    const sb = spanOf(b, zone)
    return (
      sa.start - sb.start ||
      Number(b.allDay) - Number(a.allDay) ||
      sb.end - sb.start - (sa.end - sa.start) ||
      a.source.localeCompare(b.source) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    )
  }
}

/** Whether a zone name is one this computer knows. */
export const zoneKnown = knownZone

/** The key an event goes by across sources: `<source>/<id>`. */
export const eventKey = (e: Pick<CalEvent, 'source' | 'id'>): string => `${e.source}/${e.id}`
