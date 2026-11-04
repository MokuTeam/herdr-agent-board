// The calendar for the page (#328, services/calendar.ts). GET /api/calendar?from=<t>&to=<t>
// [&sources=a,b] answers every source's events in the window (times as ms or ISO; a window of at
// most 62 days), each source as the panel marks it and how its sync stands. POST /api/calendar
// { op: sync [, source] } fetches now; { op: add | edit | remove, … } changes the board's own
// events as the owner, with the revision read (`rev`) for an edit. Not local-only: the board seen
// from a phone shows the calendar too, but its sources come without their servers' addresses and
// accounts. While the calendar is off both answer 409 and nothing is read.
//
// GET and POST /api/calendar-settings are Settings → Calendar (services/calendar-settings.ts): on
// this computer's board only (core/remote.ts localOnly), as an ICS address is typed there. POST
// { op: test, … } tries a source without adding it.
import { addBoardEvent, CalError, editBoardEvent, removeBoardEvent } from '../../adapters/calendar-store.ts'
import { DbError } from '../../adapters/db.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { isInstant } from '../../core/calendar.ts'
import { t } from '../../core/lang.ts'
import { isDate, localZone } from '../../core/time.ts'
import type { Config } from '../../core/types.ts'
import { type CalendarSync, calendarOf, readEvents, sourceViews, withCalendarDb } from '../../services/calendar.ts'
import { calendarSettingsView, editCalendarSettings, testSource } from '../../services/calendar-settings.ts'
import { json, type Route } from '../http.ts'

/** The widest window one question may ask: a month's grid with a week each side. */
const MAX_WINDOW_MS = 62 * 86_400_000

/** A time in a question: ms, or ISO with an offset. */
function timeOf(v: string | null): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  return isInstant(v) ? Date.parse(v) : null
}

/** A time a change gives: an instant (ISO or ms) for a timed event, a date for an all-day one. */
function whenOf(v: unknown): number | string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string') return undefined
  if (isDate(v)) return v
  return isInstant(v) ? Date.parse(v) : undefined
}

const text = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined)

const refusal = (err: CalError) => ({ ok: false, error: err.message, code: err.code })

export function calendarRoutes(cfg: Config, sync: CalendarSync): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/calendar',
      handle(_req, ctx) {
        const c = calendarOf(cfg)
        if (!c) return json(409, { ok: false, error: t('cal.err.off') })
        const from = timeOf(ctx.url.searchParams.get('from'))
        const to = timeOf(ctx.url.searchParams.get('to'))
        if (from === null || to === null || to <= from || to - from > MAX_WINDOW_MS)
          return json(400, { ok: false, error: t('cal.err.window') })
        const sources = (ctx.url.searchParams.get('sources') ?? '').split(',').filter(Boolean)
        const zone = localZone()
        try {
          const { events, views } = withCalendarDb(false, db => ({
            events: readEvents(c, db, from, to, zone, { sources }),
            views: sourceViews(c, db),
          }))
          return json(200, {
            ok: true,
            from,
            to,
            zone,
            events,
            // a phone sees each source's look and state, never where it is fetched from
            sources: views.map(v => ({ ...v, url: null, account: null })),
            busy: sync.busy(),
          })
        } catch (err) {
          return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/calendar',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const c = calendarOf(cfg)
        if (!c) return json(409, { ok: false, error: t('cal.err.off') })
        const raw = await ctx.rawBody()
        const b = isRecord(raw) ? raw : {}
        if (b.op === 'sync') {
          const results = await sync.syncNow(typeof b.source === 'string' ? b.source : undefined)
          return json(200, { ok: true, results })
        }
        try {
          const event = withCalendarDb(true, db => {
            if (!db) throw new CalError('cal.err.noDb')
            if (b.op === 'add') {
              const start = whenOf(b.start)
              const end = whenOf(b.end)
              if (start === undefined || end === undefined)
                throw new CalError('cal.err.when', { value: String(b.start) })
              return addBoardEvent(db, 'user', {
                title: String(b.title ?? ''),
                start,
                end,
                location: text(b.location) ?? null,
                join: text(b.join) ?? null,
                note: text(b.note) ?? null,
              })
            }
            const id = String(b.id ?? '')
            if (b.op === 'remove') return removeBoardEvent(db, 'user', id)
            if (b.op === 'edit') {
              const start = b.start === undefined ? undefined : whenOf(b.start)
              const end = b.end === undefined ? undefined : whenOf(b.end)
              if (b.start !== undefined && start === undefined)
                throw new CalError('cal.err.when', { value: String(b.start) })
              if (b.end !== undefined && end === undefined) throw new CalError('cal.err.when', { value: String(b.end) })
              const rev = typeof b.rev === 'number' && Number.isInteger(b.rev) ? b.rev : undefined
              return editBoardEvent(
                db,
                'user',
                id,
                {
                  ...(typeof b.title === 'string' && { title: b.title }),
                  ...(start !== undefined && { start }),
                  ...(end !== undefined && { end }),
                  ...(text(b.location) !== undefined && { location: text(b.location) ?? null }),
                  ...(text(b.join) !== undefined && { join: text(b.join) ?? null }),
                  ...(text(b.note) !== undefined && { note: text(b.note) ?? null }),
                },
                rev === undefined ? {} : { expect: rev },
              )
            }
            throw new CalError('cal.err.usage')
          })
          return json(200, { ok: true, event })
        } catch (err) {
          if (err instanceof CalError) {
            const status = err.code === 'notFound' ? 404 : err.code === 'changed' ? 409 : 400
            return json(status, refusal(err))
          }
          if (err instanceof DbError) return json(503, { ok: false, error: err.message })
          return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
    {
      method: 'GET',
      path: '/api/calendar-settings',
      handle() {
        return json(200, calendarSettingsView(withCalendarDb, cfg.calendar))
      },
    },
    {
      method: 'POST',
      path: '/api/calendar-settings',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.rawBody()
        if (isRecord(body) && body.op === 'test') return json(200, await testSource(body))
        const r = editCalendarSettings(body)
        if (r.ok) {
          // the live config follows a moment later; the board's sync and line follow now
          const { readConfigFile } = await import('../../adapters/config-file.ts')
          cfg.calendar = readConfigFile()?.calendar
          sync.configChanged()
          if (isRecord(body) && (body.op === 'add' || body.op === 'edit') && r.id) void sync.syncNow(r.id)
        }
        const status = r.ok ? 200 : r.code === 'configBusy' ? 409 : 400
        return json(status, { ...r, view: calendarSettingsView(withCalendarDb, cfg.calendar) })
      },
    },
  ]
}
