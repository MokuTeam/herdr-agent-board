// Settings → Calendar (#328): config.json's `calendar` changed from the panel, under the file's
// lock: the calendar on or off, a source added, changed or removed, a source tried before it is
// added. An ICS source's address never goes into config.json: it is written to its own file
// (adapters/calendar-cache.ts), and the view says only whether one is set.

import { existsSync } from 'node:fs'
import { icsAddress, removeIcsAddress, writeIcsAddress } from '../adapters/calendar-cache.ts'
import { configBusy, configFile, readConfigFile, withConfigFile } from '../adapters/config-file.ts'
import type { BoardDb } from '../adapters/db.ts'
import { isRecord } from '../adapters/json-store.ts'
import {
  BOARD_SOURCE,
  type CalSource,
  calendarConfig,
  MCP_PRESETS,
  problemsText,
  type ReminderSettings,
  SOURCE_ID,
  syncWindow,
} from '../core/calendar.ts'
import { t } from '../core/lang.ts'
import { localZone } from '../core/time.ts'
import { fetchSource, forgetSource, type SourceView, sourceViews } from './calendar.ts'

export type SettingsResult = { ok: true; id?: string } | { ok: false; error: string; code: string }

export interface CalendarSettingsView {
  /** The calendar is on; the rest is what config.json has either way. */
  on: boolean
  everyMin: number
  /** Reminders before events (#335): on, minutes before, the snooze. */
  reminders: ReminderSettings
  sources: SourceView[]
  /** config.json's `calendar` does not check out outside the sources. */
  problems: string | null
}

type Raw = Record<string, unknown>

/** config.json's `calendar` read as on, whatever its `on` says: the panel shows a source while it is off too. */
function asOn(raw: unknown): Raw | true | null {
  if (raw === true) return true
  if (!isRecord(raw)) return null
  const { on: _on, ...rest } = raw
  return rest
}

export function calendarSettingsView(
  withDb: <T>(create: boolean, fn: (db: BoardDb | null) => T) => T,
  raw: unknown = readConfigFile()?.calendar,
): CalendarSettingsView {
  const on = calendarConfig(raw) !== null
  const c = calendarConfig(asOn(raw) ?? true)
  if (!c) return { on, everyMin: 5, reminders: { on: false, beforeMin: 10, snoozeMin: 5 }, sources: [], problems: null }
  let views: SourceView[]
  try {
    views = withDb(false, db => sourceViews(c, db))
  } catch {
    views = sourceViews(c, null)
  }
  return {
    on,
    everyMin: c.everyMin,
    reminders: c.reminders,
    sources: views,
    problems: c.problems.length ? problemsText(c.problems, t) : null,
  }
}

const fail = (code: string, vars: Record<string, string | number> = {}): SettingsResult => ({
  ok: false,
  code,
  error: t(`cal.set.err.${code}`, vars),
})

/** A new source's id from its label: lowercase letters, digits and dashes; else its kind; unique. */
export function idFor(label: string, kind: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || kind
  let id = SOURCE_ID.test(base) ? base : kind
  for (let n = 2; taken.has(id) || id === BOARD_SOURCE; n++) id = `${base}-${n}`.slice(0, 40)
  return id
}

/** The fields a source takes from the panel, as config.json keeps them. */
const FIELDS = ['label', 'color', 'lane', 'everyMin', 'url', 'preset', 'account', 'calendars', 'remindMin'] as const

function sourceFields(b: Raw): Raw {
  const out: Raw = {}
  for (const k of FIELDS) {
    const v = b[k]
    if (v === undefined) continue
    if (v === null || v === '') continue
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  if (typeof out.calendars === 'string')
    out.calendars = String(out.calendars)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  return out
}

/** Edits under the file's lock: `change` gets `calendar` as an object (made when missing) and says ok. */
function edit(change: (cal: Raw) => SettingsResult): SettingsResult {
  if (!readConfigFile() && existsSync(configFile()))
    return { ok: false, code: 'configUnreadable', error: t('err.configUnreadable') }
  try {
    return withConfigFile((raw, save) => {
      const file = raw ?? {}
      const cal: Raw = isRecord(file.calendar)
        ? { ...file.calendar }
        : file.calendar === true
          ? { on: true }
          : { on: false }
      const r = change(cal)
      if (r.ok) save({ ...file, calendar: cal })
      return r
    })
  } catch (err) {
    if (configBusy(err)) return { ok: false, code: 'configBusy', error: t('err.configBusy') }
    throw err
  }
}

const sourcesOf = (cal: Raw): Raw[] => (Array.isArray(cal.sources) ? (cal.sources as unknown[]).filter(isRecord) : [])

/** The source as config.json would read it with this list: its problems, or none. */
function problemsOf(cal: Raw, id: string): string | null {
  const c = calendarConfig({ ...cal, on: true })
  const s = c?.sources.find(x => x.id === id)
  if (!s) return null
  return s.problems.length ? problemsText(s.problems, t) : null
}

/** config.json's reminders' problems with this `calendar`, or none. */
function reminderProblems(cal: Raw): string | null {
  const c = calendarConfig({ ...cal, on: true })
  const ps = (c?.problems ?? []).filter(p => p.at.startsWith('calendar.reminders'))
  return ps.length ? problemsText(ps, t) : null
}

const REMINDER_FIELDS = ['on', 'beforeMin', 'snoozeMin'] as const

/** One change from the panel: { op: on | reminders | add | edit | remove, … }. */
export function editCalendarSettings(body: unknown): SettingsResult {
  const b = isRecord(body) ? body : {}
  if (b.op === 'reminders') {
    if (!REMINDER_FIELDS.some(k => b[k] !== undefined)) return fail('usage')
    return edit(cal => {
      const was = cal.reminders
      const next: Raw = isRecord(was) ? { ...was } : was === false ? { on: false } : {}
      for (const k of REMINDER_FIELDS) if (b[k] !== undefined) next[k] = b[k]
      // on is how config.json reads it when it says nothing
      if (next.on === true) delete next.on
      const problems = reminderProblems({ ...cal, reminders: next })
      if (problems) return fail('reminders', { problems })
      if (Object.keys(next).length) cal.reminders = next
      else delete cal.reminders
      return { ok: true }
    })
  }
  if (b.op === 'on') {
    if (typeof b.on !== 'boolean') return fail('usage')
    return edit(cal => {
      cal.on = b.on
      return { ok: true }
    })
  }
  if (b.op === 'add') {
    const kind = b.kind
    if (kind !== 'ics' && kind !== 'mcp' && kind !== 'push') return fail('usage')
    const fields = sourceFields(isRecord(b.source) ? b.source : {})
    if (kind === 'mcp' && !fields.preset && !isRecord(b.list)) fields.preset = MCP_PRESETS[0]
    const address = kind === 'ics' ? icsAddress(b.address) : null
    if (kind === 'ics' && !address) return fail('address')
    let id = ''
    const r = edit(cal => {
      const list = sourcesOf(cal)
      id = idFor(String(fields.label ?? ''), kind, new Set(list.map(s => String(s.id))))
      const next = [...list, { id, kind, ...fields }]
      const problems = problemsOf({ ...cal, sources: next }, id)
      if (problems) return fail('source', { problems })
      cal.sources = next
      return { ok: true, id }
    })
    if (r.ok && address) writeIcsAddress(id, address)
    return r
  }
  if (b.op === 'edit') {
    const id = String(b.id ?? '')
    const fields = isRecord(b.source) ? b.source : {}
    const address = b.address === undefined || b.address === '' ? null : icsAddress(b.address)
    if (b.address !== undefined && b.address !== '' && !address) return fail('address')
    let kind = ''
    const r = edit(cal => {
      const list = sourcesOf(cal)
      const i = list.findIndex(s => s.id === id)
      // the board's own: only its look, kept as a `board` entry
      if (i < 0 && id === BOARD_SOURCE) list.push({ id, kind: 'board' })
      const at = i < 0 ? list.length - 1 : i
      const was = list[at]
      if (!was) return fail('notFound', { id })
      kind = String(was.kind)
      const next: Raw = { ...was }
      for (const k of FIELDS) {
        if (!(k in fields)) continue
        const v = fields[k]
        if (v === null || v === '') delete next[k]
        else
          next[k] =
            k === 'calendars' && typeof v === 'string'
              ? v
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              : typeof v === 'string'
                ? v.trim()
                : v
      }
      const updated = list.map((s, j) => (j === at ? next : s))
      const problems = problemsOf({ ...cal, sources: updated }, id)
      if (problems) return fail('source', { problems })
      cal.sources = updated
      return { ok: true, id }
    })
    if (r.ok && address && kind === 'ics') writeIcsAddress(id, address)
    return r
  }
  if (b.op === 'remove') {
    const id = String(b.id ?? '')
    if (id === BOARD_SOURCE) return fail('board')
    const r = edit(cal => {
      const list = sourcesOf(cal)
      if (!list.some(s => s.id === id)) return fail('notFound', { id })
      cal.sources = list.filter(s => s.id !== id)
      return { ok: true, id }
    })
    if (r.ok) {
      forgetSource(id)
      removeIcsAddress(id)
    }
    return r
  }
  return fail('usage')
}

/**
 * A source tried as it would be fetched (one week ahead), nothing written: the number of events,
 * or why it failed. The panel's Test, for a source not added yet (its fields and address as typed)
 * or one that is (by id).
 */
export async function testSource(body: unknown): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const b = isRecord(body) ? body : {}
  let source: CalSource | undefined
  let address: string | null = null
  if (typeof b.id === 'string' && b.id) {
    const c = calendarConfig(asOn(readConfigFile()?.calendar) ?? true)
    source = c?.sources.find(s => s.id === b.id)
    if (!source) return { ok: false, error: t('cal.set.err.notFound', { id: b.id }) }
  } else {
    const kind = b.kind
    if (kind !== 'ics' && kind !== 'mcp') return { ok: false, error: t('cal.set.err.usage') }
    const fields = sourceFields(isRecord(b.source) ? b.source : {})
    if (kind === 'mcp' && !fields.preset) fields.preset = MCP_PRESETS[0]
    const c = calendarConfig({ sources: [{ id: 'test', kind, ...fields }] })
    source = c?.sources.find(s => s.id === 'test')
    if (!source) return { ok: false, error: t('cal.set.err.usage') }
    if (source.problems.length) return { ok: false, error: problemsText(source.problems, t) }
    if (kind === 'ics') {
      address = icsAddress(b.address)
      if (!address) return { ok: false, error: t('cal.set.err.address') }
    }
  }
  if (source.problems.length) return { ok: false, error: problemsText(source.problems, t) }
  const now = Date.now()
  const zone = localZone()
  const { from } = syncWindow({ pastDays: 0, futureDays: 0 }, now, zone)
  try {
    const events = await fetchSource(source, from, from + 8 * 86_400_000, zone, address ? { address } : {})
    return { ok: true, count: events.length }
  } catch (err) {
    let s = err instanceof Error ? err.message : String(err)
    if (address) s = s.replaceAll(address, '<address>')
    return { ok: false, error: s.slice(0, 300) }
  }
}
