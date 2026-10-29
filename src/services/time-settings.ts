// Settings → Time (#237, core/time-settings.ts): its view, and an edit of config.json's `time` made
// as the other Settings panels make theirs, under the file's lock (config-file.ts withConfigFile).
// An edit is checked with timeConfig and refused when it brings a problem the file had not (one
// that was there stays said, and stops no edit elsewhere). A new lane is made and takes time in
// the same write. A rename moves the client's live entries of the project in one transaction
// (time-store.ts renameProject), config.json written last in it: a failure leaves both as they were;
// entries are moved only as any entry is written (the config checks out, a backup went through).
import { categoriesEdited, readConfigFile, withConfigFile } from '../adapters/config-file.ts'
import type { BoardDb } from '../adapters/db.ts'
import { isRecord } from '../adapters/json-store.ts'
import { projectUse, renameProject, TimeError } from '../adapters/time-store.ts'
import { DEFAULT_CONFIG } from '../core/categories.ts'
import { t } from '../core/lang.ts'
import { cleanText, localZone, problemsText, type TimeSystem, timeConfig } from '../core/time.ts'
import { editedTime, newProblems, type TimeEdit } from '../core/time-settings.ts'
import { writeRefusal } from './time.ts'

type Raw = Record<string, unknown>

/** The database for one call, as the time routes have it (server/routes/time.ts withDb). */
export type WithDb = <T>(create: boolean, fn: (db: BoardDb | null) => T) => T

export interface TimeClientView {
  on: boolean
  /** null: any project. */
  projects: string[] | null
  retired: string[]
  billable: boolean
  nonBillable: string[]
  systems: TimeSystem[]
  /** Its billing rules and whether it has a `ref` of its own: kept in config.json, said. */
  rules: number
  ref: boolean
  zone: string | null
  /** Its live entries by project. */
  use: Record<string, number>
}

export interface TimeSettingsView {
  /** Time is on (off: its settings below as they will be when it is on again). */
  on: boolean
  /** config.json has a `time` at all. */
  set: boolean
  zone: string
  /** The computer's zone. */
  localZone: string
  /** Every lane takes time, any project (`"time": true`, or no `clients`). */
  every: boolean
  clients: Record<string, TimeClientView>
  /** What does not check out, a line each. */
  problems: string[]
}

/** The section read as if on: its settings, whatever `on` says. */
const asOn = (time: unknown): unknown => {
  if (!isRecord(time)) return time
  const { on: _on, ...rest } = time
  return rest
}

export function timeSettingsView(withDb: WithDb): TimeSettingsView {
  const time = readConfigFile()?.time
  const conf = timeConfig(asOn(time))
  const raw = isRecord(time) ? time : {}
  const clients = isRecord(raw.clients) ? raw.clients : {}
  const use = withDb(false, db => {
    const out: Record<string, Record<string, number>> = {}
    if (db) for (const id of Object.keys(conf?.clients ?? {})) out[id] = projectUse(db, id)
    return out
  })
  return {
    on: timeConfig(time) !== null,
    set: time === true || isRecord(time),
    zone: conf?.zone ?? localZone(),
    localZone: localZone(),
    every: !conf?.clients,
    clients: Object.fromEntries(
      Object.entries(conf?.clients ?? {}).map(([id, c]) => {
        const own = isRecord(clients[id]) ? clients[id] : {}
        return [
          id,
          {
            on: c.on,
            projects: c.projects,
            retired: c.retired,
            billable: c.billable,
            nonBillable: c.nonBillable,
            systems: c.systems,
            rules: c.billing.length,
            ref: typeof own.ref === 'string',
            zone: c.zone,
            use: use[id] ?? {},
          },
        ]
      }),
    ),
    problems: (conf?.problems ?? []).map(p => problemsText([p], t)),
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** The body as an edit, or null when it is none. A new lane is { op: 'newLane', id, title, color }. */
function editOf(b: Raw): TimeEdit | { op: 'newLane'; id: string; title: string; color: string } | null {
  const client = text(b.client)
  switch (b.op) {
    case 'on':
      return bool(b.on) === null ? null : { op: 'on', on: b.on as boolean }
    case 'zone':
      return { op: 'zone', zone: text(b.zone) }
    case 'lanes':
      return Array.isArray(b.lanes) ? { op: 'lanes', lanes: b.lanes.map(text).filter(Boolean) } : null
    case 'newLane':
      return { op: 'newLane', id: text(b.id), title: text(b.title), color: text(b.color) }
    case 'client':
      return client && bool(b.on) !== null ? { op: 'client', client, on: b.on as boolean } : null
    case 'list':
      return client && Array.isArray(b.projects) ? { op: 'list', client, projects: b.projects.map(text) } : null
    case 'project':
      return client ? { op: 'project', client, name: text(b.name) } : null
    case 'rename':
      return client && text(b.from) ? { op: 'rename', client, from: text(b.from), to: text(b.to) } : null
    case 'retire':
    case 'restore':
      return client && text(b.project) ? { op: b.op, client, project: text(b.project) } : null
    case 'billable':
      return client && bool(b.billable) !== null ? { op: 'billable', client, billable: b.billable as boolean } : null
    case 'projectBillable':
      return client && text(b.project) && bool(b.billable) !== null
        ? { op: 'projectBillable', client, project: text(b.project), billable: b.billable as boolean }
        : null
    case 'systems':
      return client && Array.isArray(b.systems)
        ? {
            op: 'systems',
            client,
            systems: b.systems.map(s =>
              isRecord(s) ? { id: text(s.id), title: text(s.title) } : { id: '', title: '' },
            ),
          }
        : null
    default:
      return null
  }
}

export type TimeSettingsResult = { ok: true; moved?: number } | { ok: false; error: string; code?: string }

/** A text key's last part, the code beside the words (as the time routes say theirs). */
const codeOf = (key: string): string => key.split('.').at(-1) ?? 'failed'

const refused = (key: string, vars: Record<string, string> = {}): TimeSettingsResult => ({
  ok: false,
  error: t(key, vars),
  code: codeOf(key),
})

/** One edit from Settings → Time, as the owner. */
export function editTimeSettings(body: unknown, withDb: WithDb): TimeSettingsResult {
  const b: Raw = isRecord(body) ? body : {}
  const e = editOf(b)
  if (!e) return refused('time.set.err.usage')
  try {
    return withConfigFile((had, save): TimeSettingsResult => {
      const raw = had ?? structuredClone<Raw>(DEFAULT_CONFIG as unknown as Raw)
      const was = structuredClone(raw)
      let edit: TimeEdit = e as TimeEdit
      if (e.op === 'newLane') {
        // the lane as the categories editor makes it, then time for it: one write of the file
        const id = e.id.trim().toLowerCase()
        const made = categoriesEdited(raw, { op: 'create', id, title: e.title, color: e.color })
        if (!made.ok) return { ok: false, error: made.error }
        edit = { op: 'client', client: id, on: true }
      }
      const next = editedTime(raw.time, edit, localZone())
      if ('key' in next) return refused(next.key, next.vars)
      const before = timeConfig(asOn(raw.time))?.problems ?? []
      const conf = timeConfig(asOn(next.time))
      const brought = newProblems(before, conf?.problems ?? [])
      if (brought.length) return refused('time.set.err.problems', { problems: problemsText(brought, t) })
      if (next.time === undefined) delete raw.time
      else raw.time = next.time
      if (edit.op !== 'rename' || !conf) {
        save(raw)
        return { ok: true }
      }
      const { client, from, to } = edit
      const moving = withDb(false, db => (db ? (projectUse(db, client)[from] ?? 0) : 0))
      if (!moving) {
        save(raw)
        return { ok: true, moved: 0 }
      }
      // the entries are written as any entry is: the config checks out, a backup went through
      const gate = writeRefusal({ backup: raw.backup }, conf)
      if (gate) throw gate
      const name = cleanText(to, 120)
      let written = false
      try {
        const moved = withDb(true, db => {
          if (!db) throw new TimeError('time.err.noDb')
          return renameProject(db, conf, client, from, name, 'user', () => {
            save(raw)
            written = true
          })
        })
        return { ok: true, moved: moved.length }
      } catch (err) {
        // config.json written, then the transaction did not go through: the file back as it was
        if (written) save(was)
        throw err
      }
    })
  } catch (err) {
    if (err instanceof TimeError) return { ok: false, error: err.message, code: codeOf(err.key) }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
