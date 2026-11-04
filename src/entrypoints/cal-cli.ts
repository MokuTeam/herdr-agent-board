// `board cal …` (#328): the owner's calendar for agents. It reads and writes by itself (the copies
// in the state folder, the board's database), so it works while the web board is down; `sync`
// fetches in this process too. One line per event for a person, the whole of it as JSON with
// --json for an agent; an error goes to stderr with a non-zero exit (under --json as JSON:
// { ok: false, error: <code>, message }). Times are this computer's: "2026-11-05 14:00", "14:00"
// (today), or ISO with an offset; a day is a date, today, tomorrow or yesterday.
//
//   board cal list [--day <d> | --from <t> --to <t> | --days <n>] [--source <id>]... [--cancelled] [--json]
//   board cal sources [--json]                    every source, its label and how its sync stands
//   board cal sync [--source <id>] [--json]        fetch now
//   board cal add --title "…" --start <t> (--end <t> | --minutes <n>) [--location "…"] [--join <url>] [--note "…"]
//   board cal add --title "…" --all-day --start <d> [--end <last day>]
//   board cal edit <id> [--title …] [--start <t>] [--end <t> | --minutes <n>] [--location …] [--join …] [--note …] [--expect <rev>]
//   board cal rm <id>
//                                                  the board's own events, as this session
//   … add | edit | rm --source <id> --asked "<what the owner said>"
//                                                  an event in a provider's calendar, through a source
//                                                  that takes writes, only for an event the owner asked for
//   board cal push --source <id> [--file <events.json>] [--from <t> --to <t>]
//                                                  a push source's events (JSON on stdin without --file)
import { readFileSync } from 'node:fs'
import { readCopy } from '../adapters/calendar-cache.ts'
import { McpClient } from '../adapters/calendar-fetch.ts'
import {
  addBoardEvent,
  type CalActor,
  CalError,
  editBoardEvent,
  getBoardEvent,
  journalProviderWrite,
  removeBoardEvent,
} from '../adapters/calendar-store.ts'
import { DbError } from '../adapters/db.ts'
import {
  BOARD_SOURCE,
  type CalEvent,
  type CalendarConfig,
  type CalSource,
  dayWindow,
  fetchedSources,
  writesToProvider,
} from '../core/calendar.ts'
import { googleWriteArgs, type WriteAsk, writtenId } from '../core/calendar-google.ts'
import { addDays, dateIn, isDate, localZone, parseWhen } from '../core/time.ts'
import type { Config } from '../core/types.ts'
import { calendarOf, pushEvents, readEvents, sourceViews, syncSource, withCalendarDb } from '../services/calendar.ts'

export const CAL_USAGE = `board cal list [--day <d> | --from <t> --to <t> | --days <n>] [--source <id>]... [--cancelled] [--json]
board cal sources [--json]
board cal sync [--source <id>] [--json]
board cal add --title "<t>" --start <t> (--end <t> | --minutes <n>) [--location "<l>"] [--join <url>] [--note "<n>"] [--json]
board cal add --title "<t>" --all-day --start <date> [--end <last date>] [--json]
board cal edit <id> [--title …] [--start <t>] [--end <t> | --minutes <n>] [--location …] [--join …] [--note …] [--expect <rev>] [--json]
board cal rm <id> [--json]
  add, edit and rm change the board's own calendar; with --source <id> --asked "<what the owner said>"
  they change a provider's calendar through a source that takes writes, only for an event the owner asked for
board cal push --source <id> [--file <events.json>] [--from <t> --to <t>]
  times: "2026-11-05 14:00", "14:00" (today), ISO with an offset; a day: a date, today, tomorrow, yesterday`

const FLAGS_WITH_VALUE = new Set([
  '--day',
  '--from',
  '--to',
  '--days',
  '--source',
  '--title',
  '--start',
  '--end',
  '--minutes',
  '--location',
  '--join',
  '--note',
  '--expect',
  '--asked',
  '--file',
])

class Usage extends Error {}

interface Args {
  words: string[]
  one(flag: string): string | undefined
  all(flag: string): string[]
  has(flag: string): boolean
}

function parseArgs(rest: readonly string[]): Args {
  const words: string[] = []
  const values = new Map<string, string[]>()
  const bare = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--') {
      words.push(...rest.slice(i + 1))
      break
    }
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = rest[i + 1]
      if (v === undefined) throw new Usage(`${a} needs a value`)
      values.set(a, [...(values.get(a) ?? []), v])
      i++
    } else if (a.startsWith('--')) bare.add(a)
    else words.push(a)
  }
  return { words, one: f => values.get(f)?.at(-1), all: f => values.get(f) ?? [], has: f => bare.has(f) }
}

export interface CalCmdContext {
  cfg: Pick<Config, 'calendar'>
  actor: CalActor
  out?: (line: string) => void
  err?: (line: string) => void
  /** Standard input's text, for push without --file. */
  stdin?: () => Promise<string>
  now?: number
  zone?: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** A day as the command takes it: a date, today, tomorrow, yesterday. */
function dayOf(s: string, now: number, zone: string): string {
  const today = dateIn(now, zone)
  const v = s.trim().toLowerCase()
  if (v === 'today') return today
  if (v === 'tomorrow') return addDays(today, 1)
  if (v === 'yesterday') return addDays(today, -1)
  if (isDate(v)) return v
  throw new Usage(`not a day: ${s} (a date, today, tomorrow or yesterday)`)
}

/** A time as the command takes it; "14:00" is today's, wherever the clock is. */
function instantOf(s: string, now: number): number {
  const at = parseWhen(s, now, { yesterday: false })
  if (at === null) throw new Usage(`not a time: ${s} ("2026-11-05 14:00", "14:00", or ISO with an offset)`)
  return at
}

/** A clock on this computer: 09:30. */
const clockOf = (at: number): string => {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** How long ago, in words an agent reads at a glance. */
function ago(at: number | null, now: number): string {
  if (!at) return 'never'
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function labelOf(c: CalendarConfig, id: string): string {
  const s = c.sources.find(x => x.id === id)
  return s?.label || (id === BOARD_SOURCE ? 'board' : id)
}

/** An event in one line: its time, title, label, what else matters, and its key. */
function eventLine(e: CalEvent, c: CalendarConfig): string {
  const when = e.allDay
    ? e.end === addDays(e.start, 1)
      ? 'all day'
      : `all day to ${addDays(e.end, -1)}`
    : `${clockOf(Date.parse(e.start))}-${clockOf(Date.parse(e.end))}`
  const extra = [
    e.status === 'cancelled' ? 'cancelled' : '',
    e.status === 'tentative' ? 'tentative' : '',
    e.response === 'declined' ? 'declined' : e.response === 'needsAction' ? 'not answered' : '',
    e.kind && e.kind !== 'default' ? e.kind : '',
    e.join ? `join ${e.join}` : '',
    e.location && e.location !== e.join ? `at ${e.location}` : '',
    e.attendees ? `${e.attendees} invited` : '',
    e.rev ? `rev ${e.rev}` : '',
  ].filter(Boolean)
  return `${when} · ${e.title || '(no title)'} · [${labelOf(c, e.source)}]${extra.length ? ` · ${extra.join(' · ')}` : ''} · ${e.source}/${e.id}`
}

/** The source a write goes to: the board's own, or a provider's that takes writes, with the owner's words. */
function writeTarget(c: CalendarConfig, a: Args): { source: CalSource; asked: string } | null {
  const id = a.one('--source')
  if (!id || id === BOARD_SOURCE) return null
  const source = c.sources.find(s => s.id === id)
  if (!source) throw new CalError('cal.err.noSource', { source: id })
  if (!writesToProvider(source)) throw new CalError('cal.err.readOnly', { source: id })
  const asked = (a.one('--asked') ?? '').trim()
  if (!asked) throw new CalError('cal.err.asked')
  return { source, asked }
}

/** A write to a provider through its source's MCP server; the id it names (or was given). */
async function providerWrite(source: CalSource, ask: WriteAsk): Promise<string | null> {
  if (!source.url) throw new CalError('cal.err.readOnly', { source: source.id })
  const client = new McpClient(source.url)
  try {
    const tool = source.preset === 'google-workspace' ? 'manage_event' : (source.writeTool as string)
    const args = source.preset === 'google-workspace' ? googleWriteArgs(source, ask) : { ...ask }
    const answer = await client.call(tool, args)
    if (answer.isError)
      throw new CalError('cal.err.provider', { error: answer.text.split('\n')[0]?.slice(0, 300) ?? '' })
    return ask.id ?? writtenId(answer.text)
  } finally {
    await client.close()
  }
}

/** The times of an add or an edit: timed (ms) or all day (dates, the end exclusive). */
function timesOf(a: Args, now: number, required: boolean): { start?: number | string; end?: number | string } {
  const start = a.one('--start')
  const end = a.one('--end')
  const minutes = a.one('--minutes')
  if (a.has('--all-day')) {
    if (!start) throw new Usage('--all-day needs --start <date>')
    const first = dayOf(start, now, localZone())
    const last = end ? dayOf(end, now, localZone()) : first
    if (last < first) throw new CalError('cal.err.endBeforeStart')
    return { start: first, end: addDays(last, 1) }
  }
  if (!start) {
    if (required) throw new Usage('--start is needed')
    if (end) return { end: instantOf(end, now) }
    return {}
  }
  const s = instantOf(start, now)
  if (end) return { start: s, end: instantOf(end, now) }
  if (minutes) {
    const n = Number(minutes)
    if (!(n > 0 && n <= 7 * 24 * 60)) throw new Usage(`not a number of minutes: ${minutes}`)
    return { start: s, end: s + n * 60_000 }
  }
  if (required) throw new Usage('--end or --minutes is needed')
  return { start: s }
}

/** The command; its exit code. */
export async function calCmd(rest: readonly string[], ctx: CalCmdContext): Promise<number> {
  const out = ctx.out ?? ((line: string) => console.log(line))
  const errOut = ctx.err ?? ((line: string) => console.error(line))
  const json = rest.includes('--json')
  const now = ctx.now ?? Date.now()
  const zone = ctx.zone ?? localZone()
  const [cmd = 'list', ...more] = rest
  if (cmd === 'help' || rest.includes('--help') || rest.includes('-h')) {
    out(CAL_USAGE)
    return 0
  }
  try {
    const c = calendarOf(ctx.cfg)
    if (!c) throw new CalError('cal.err.off')
    const a = parseArgs(more)
    switch (cmd) {
      case 'list': {
        let from: number
        let to: number
        if (a.one('--from') || a.one('--to')) {
          const f = a.one('--from')
          const tt = a.one('--to')
          if (!f || !tt) throw new Usage('--from and --to come together')
          from = isDate(f) ? dayWindow(f, zone).from : instantOf(f, now)
          to = isDate(tt) ? dayWindow(tt, zone).to : instantOf(tt, now)
        } else {
          const day = dayOf(a.one('--day') ?? 'today', now, zone)
          const days = Number(a.one('--days') ?? 1)
          if (!(Number.isInteger(days) && days >= 1 && days <= 62)) throw new Usage('--days is 1 to 62')
          ;({ from, to } = dayWindow(day, zone, days))
        }
        if (to <= from) throw new CalError('cal.err.window')
        const sources = a.all('--source')
        const events = withCalendarDb(false, db =>
          readEvents(c, db, from, to, zone, { sources, cancelled: a.has('--cancelled') }),
        )
        const views = withCalendarDb(false, db => sourceViews(c, db)).filter(
          v => !sources.length || sources.includes(v.id),
        )
        if (json) {
          out(
            JSON.stringify({
              ok: true,
              from: new Date(from).toISOString(),
              to: new Date(to).toISOString(),
              zone,
              events: events.map(e => ({ ...e, label: labelOf(c, e.source) })),
              sources: views.map(v => ({
                id: v.id,
                kind: v.kind,
                label: v.label || v.id,
                lane: v.lane,
                lastOk: v.lastOk ? new Date(v.lastOk).toISOString() : null,
                error: v.error,
                problems: v.problems,
              })),
            }),
          )
          return 0
        }
        let day = ''
        for (const e of events) {
          const d = e.allDay
            ? e.start < dateIn(from, zone)
              ? dateIn(from, zone)
              : e.start
            : dateIn(Date.parse(e.start), zone)
          if (d !== day) {
            day = d
            out(`${WEEKDAY[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${d}`)
          }
          out(`  ${eventLine(e, c)}`)
        }
        if (!events.length) out('no events')
        const stale = views
          .filter(v => v.kind === 'ics' || v.kind === 'mcp' || v.kind === 'push')
          .map(
            v =>
              `${v.id} ${v.error ? `failed ${ago(v.lastTry, now)}: ${v.error}; last good ${ago(v.lastOk, now)}` : v.problems ? `does not check out: ${v.problems}` : `synced ${ago(v.lastOk, now)}`}`,
          )
        if (stale.length) out(`sources: ${stale.join('; ')}`)
        return 0
      }
      case 'sources': {
        const views = withCalendarDb(false, db => sourceViews(c, db))
        if (json) {
          out(JSON.stringify({ ok: true, sources: views }))
          return 0
        }
        for (const v of views)
          out(
            [
              v.id,
              v.kind,
              v.label || (v.id === BOARD_SOURCE ? 'board' : v.id),
              v.lane ? `lane ${v.lane}` : '',
              v.writes ? 'takes writes' : 'read only',
              v.kind === 'ics' && !v.address ? 'no address yet' : '',
              v.kind === 'board' ? `${v.count} events` : `${v.count} events, synced ${ago(v.lastOk, now)}`,
              v.error ? `last fetch failed: ${v.error}` : '',
              v.problems ? `does not check out: ${v.problems}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
        return 0
      }
      case 'sync': {
        const id = a.one('--source')
        const list = fetchedSources(c).filter(s => !id || s.id === id)
        if (id && !list.length) throw new CalError('cal.err.noSource', { source: id })
        const results = []
        for (const s of list) results.push(await syncSource(c, s, now, zone))
        if (json) out(JSON.stringify({ ok: results.every(r => r.ok), results }))
        else if (!results.length) out('nothing to fetch')
        else for (const r of results) out(r.ok ? `${r.source} · ${r.count} events` : `${r.source} · failed: ${r.error}`)
        return results.every(r => r.ok) ? 0 : 1
      }
      case 'add':
      case 'edit':
      case 'rm': {
        const target = writeTarget(c, a)
        // an id as `list` shows it (<source>/<id>) or bare
        const prefix = `${target?.source.id ?? BOARD_SOURCE}/`
        const word = cmd === 'add' ? '' : (a.words[0] ?? '')
        const id = word.startsWith(prefix) ? word.slice(prefix.length) : word
        if (cmd !== 'add' && !id) throw new Usage(`board cal ${cmd} <id>`)
        const times = cmd === 'rm' ? {} : timesOf(a, now, cmd === 'add')
        const text = (flag: string): string | null | undefined => {
          const v = a.one(flag)
          return v === undefined ? undefined : v.trim() || null
        }
        if (target) {
          // a provider's calendar: the owner asked for this event; the journal says who and what
          const copy = readCopy(target.source.id)
          const before = id ? (copy?.events.find(e => e.id === id) ?? null) : null
          if (cmd !== 'add' && !before) throw new CalError('cal.err.notFound', { id })
          const iso = (v: number | string | undefined) => (typeof v === 'number' ? new Date(v).toISOString() : v)
          const ask: WriteAsk = {
            op: cmd === 'add' ? 'create' : cmd === 'edit' ? 'update' : 'delete',
            ...(id && { id: id.includes('/') ? (id.split('/').pop() as string) : id }),
            ...(id.includes('/') && { calendar: id.split('/').slice(0, -1).join('/') }),
            ...(a.one('--title') !== undefined && { title: a.one('--title') as string }),
            ...(times.start !== undefined && { start: iso(times.start) as string }),
            ...(times.end !== undefined && { end: iso(times.end) as string }),
            ...(text('--location') != null && { location: text('--location') as string }),
            ...(text('--note') != null && { note: text('--note') as string }),
          }
          if (cmd === 'add' && !ask.title) throw new Usage('--title is needed')
          const written = await providerWrite(target.source, ask)
          withCalendarDb(true, db => {
            if (!db) throw new CalError('cal.err.noDb')
            journalProviderWrite(db, ctx.actor, {
              source: target.source.id,
              op: ask.op,
              id: written ?? id ?? '?',
              before,
              after: ask.op === 'delete' ? null : ask,
              asked: target.asked,
            })
          })
          const synced = await syncSource(c, target.source, now, zone)
          const result = { ok: true, source: target.source.id, op: ask.op, id: written, synced: synced.ok }
          out(json ? JSON.stringify(result) : `ok · ${ask.op} in ${target.source.id}${written ? ` · ${written}` : ''}`)
          return 0
        }
        const e = withCalendarDb(true, db => {
          if (!db) throw new CalError('cal.err.noDb')
          if (cmd === 'rm') return removeBoardEvent(db, ctx.actor, id)
          if (cmd === 'add')
            return addBoardEvent(db, ctx.actor, {
              title: a.one('--title') ?? '',
              start: times.start as number | string,
              end: times.end as number | string,
              location: text('--location') ?? null,
              join: text('--join') ?? null,
              note: text('--note') ?? null,
            })
          const expect = a.one('--expect')
          if (expect !== undefined && !/^\d+$/.test(expect)) throw new Usage(`not a revision: ${expect}`)
          if (!getBoardEvent(db, id)) throw new CalError('cal.err.notFound', { id })
          return editBoardEvent(
            db,
            ctx.actor,
            id,
            {
              ...(a.one('--title') !== undefined && { title: a.one('--title') as string }),
              ...(times.start !== undefined && { start: times.start }),
              ...(times.end !== undefined && { end: times.end }),
              ...(text('--location') !== undefined && { location: text('--location') ?? null }),
              ...(text('--join') !== undefined && { join: text('--join') ?? null }),
              ...(text('--note') !== undefined && { note: text('--note') ?? null }),
            },
            expect === undefined ? { now } : { expect: Number(expect), now },
          )
        })
        if (json) out(JSON.stringify({ ok: true, event: e }))
        else out(`ok · ${cmd === 'rm' ? 'removed' : cmd === 'add' ? 'added' : 'changed'} · ${eventLine(e, c)}`)
        return 0
      }
      case 'push': {
        const id = a.one('--source') ?? ''
        const source = c.sources.find(s => s.id === id)
        if (!source) throw new CalError('cal.err.noSource', { source: id })
        if (source.kind !== 'push') throw new CalError('cal.err.notPush', { source: id })
        const file = a.one('--file')
        const text = file ? readFileSync(file, 'utf8') : await (ctx.stdin ?? (() => Bun.stdin.text()))()
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          throw new Usage('the events are not JSON: a list of events, or { "events": [...] }')
        }
        const list = Array.isArray(raw) ? raw : (raw as { events?: unknown })?.events
        if (!Array.isArray(list)) throw new Usage('the events are a list, or { "events": [...] }')
        const f = a.one('--from')
        const tt = a.one('--to')
        if (!!f !== !!tt) throw new Usage('--from and --to come together')
        const from = f ? (isDate(f) ? dayWindow(f, zone).from : instantOf(f, now)) : Number.NEGATIVE_INFINITY
        const to = tt ? (isDate(tt) ? dayWindow(tt, zone).to : instantOf(tt, now)) : Number.POSITIVE_INFINITY
        const r = pushEvents(source, list, from, to, zone, now)
        out(
          json
            ? JSON.stringify({ ok: true, ...r })
            : `ok · ${r.given} events taken${r.skipped ? `, ${r.skipped} not read` : ''} · ${r.total} in ${id}`,
        )
        return 0
      }
      default:
        throw new Usage(`no command "${cmd}"`)
    }
  } catch (err) {
    const code =
      err instanceof CalError
        ? err.code
        : err instanceof Usage
          ? 'usage'
          : err instanceof DbError
            ? err.problem
            : 'failed'
    const message = err instanceof Error ? err.message : String(err)
    if (json) out(JSON.stringify({ ok: false, error: code, message }))
    else {
      errOut(`board cal: ${message}`)
      if (err instanceof Usage) errOut(CAL_USAGE)
    }
    return 1
  }
}
