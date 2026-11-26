// Pure parsing and formatting for `board remind` and `board every`, shared between
// `entrypoints/cli.ts` and `services/nodes/uplink.ts`.
import type { ScheduleEntry } from './schedule-rules.ts'
import { clockIn, dateIn } from './time.ts'
import { type Cron, nextRun, parseCron, parseWhen, shortestGap } from './when.ts'

export const MIN_REPEAT_MS = 5 * 60_000
export const WHEN_HELP = 'in 30m, in 2h, at 15:30, tomorrow 9:00, fri 17:00, 2026-10-20 14:00 (local time)'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** An instant as the schedule's lines show it; `zone` (core/when.ts scheduleZone): on that zone's clock. */
export function stamp(ms: number, zone?: string): string {
  if (zone) {
    const date = dateIn(ms, zone)
    const [h, min] = clockIn(ms, zone)
    return `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${date} ${pad(h)}:${pad(min)}`
  }
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromNow(ms: number, now: number): string {
  const min = Math.round(Math.abs(ms - now) / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const parts = d ? [`${d} d`, h && `${h} h`] : h ? [`${h} h`, min % 60 && `${min % 60} min`] : [`${min} min`]
  const span = parts.filter(Boolean).join(' ')
  return ms >= now ? `in ${span}` : `${span} ago`
}

export const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function splitRest(
  rest: readonly string[],
  idleFlag = false,
): {
  words: string[]
  leading: string[]
  spare: number
  idle: boolean
} {
  const dashes = rest.indexOf('--')
  const before = dashes < 0 ? rest : rest.slice(0, dashes)
  const idle = idleFlag || before.includes('--idle')
  const flagWords = before.filter(w => w !== '--idle')
  const words = dashes < 0 ? flagWords : [...flagWords, ...rest.slice(dashes + 1)]
  const leading = dashes < 0 ? words : flagWords
  const spare = dashes < 0 ? 1 : 0
  return { words, leading, spare, idle }
}

/**
 * Parse `board remind <when> "<text>" [--idle]` arguments into validated fields. `zone`: the owner's
 * (core/when.ts scheduleZone), else the computer's local time.
 */
export function parseRemindRest(
  rest: readonly string[],
  now: number,
  o: { idle?: boolean; zone?: string | undefined } = {},
): { at: number; text: string; idle: boolean } {
  const { words, leading, spare, idle } = splitRest(rest, o.idle)
  let at: number | null = null
  let used = 0
  for (let k = Math.min(5, leading.length - spare); k >= 1 && at === null; k--) {
    at = parseWhen(leading.slice(0, k).join(' '), now, o.zone)
    used = k
  }
  const msg = words.slice(used).join(' ').replace(/\s+/g, ' ').trim()
  if (at === null || !msg) throw new Error(`usage: board remind <when> "<text>"; when: ${WHEN_HELP}`)
  if (at <= now) throw new Error(`${stamp(at, o.zone)} is in the past`)
  if (at > now + 5 * 366 * 86_400_000) throw new Error(`${stamp(at, o.zone)} is more than five years ahead`)
  return { at, text: msg, idle }
}

/** Parse `board every "<cron>" "<text>" [--idle]` arguments into validated fields; `zone` as parseRemindRest's. */
export function parseEveryRest(
  rest: readonly string[],
  now: number,
  o: { idle?: boolean; zone?: string | undefined } = {},
): { cron: Cron; next: number; text: string; idle: boolean } {
  const { words, leading, spare, idle } = splitRest(rest, o.idle)
  let expr = leading[0] ?? ''
  let used = 1
  if (!/\s/.test(expr) && !expr.startsWith('@') && leading.length >= 5 + spare) {
    expr = leading.slice(0, 5).join(' ')
    used = 5
  }
  let cron: Cron
  try {
    cron = parseCron(expr)
  } catch (err) {
    throw new Error(
      `${messageOf(err)}. usage: board every "<minute hour day month weekday>" "<text>", e.g. board every "0 9 * * 1-5" "check the inbox"; quote the schedule`,
    )
  }
  const msg = words.slice(used).join(' ').replace(/\s+/g, ' ').trim()
  if (!msg) throw new Error('usage: board every "<cron>" "<text>"')
  const next = nextRun(cron, now, o.zone)
  if (next === null) throw new Error(`"${cron.expr}" never runs`)
  if (shortestGap(cron, now, 50, o.zone) < MIN_REPEAT_MS)
    throw new Error(
      `"${cron.expr}" runs more often than every ${MIN_REPEAT_MS / 60_000} minutes; for a one-off wait use board remind`,
    )
  return { cron, next, text: msg, idle }
}

export function formatRemindOk(
  id: string,
  at: number,
  now: number,
  idle: boolean,
  msg: string,
  note = '',
  zone?: string,
): string {
  const mode = idle ? ', when the session is free' : ''
  return `ok · reminder ${id} ${stamp(at, zone)} (${fromNow(at, now)}${mode}): ${clip(msg)} · cancel: board unschedule ${id}${note}`
}

export function formatEveryOk(
  id: string,
  expr: string,
  next: number,
  now: number,
  idle: boolean,
  msg: string,
  note = '',
  zone?: string,
): string {
  const mode = idle ? ', when the session is free' : ''
  return `ok · every ${id} "${expr}", next ${stamp(next, zone)} (${fromNow(next, now)}${mode}): ${clip(msg)} · cancel: board unschedule ${id}${note}`
}

/**
 * A reminder's or a repeating entry's fields as `board schedule` lists them: id, when, how often,
 * how. Shared by the board command and the master's answer to a node's `board schedule` (#806).
 */
export const scheduleParts = (e: ScheduleEntry, now: number, zone?: string): string[] => [
  e.id,
  `${stamp(e.next, zone)} (${fromNow(e.next, now)})`,
  e.cron ? `every "${e.cron}"` : 'once',
  e.idle ? 'when free' : 'on time',
]

/** That a due entry waits for its session, and since when, for `board schedule`; '' when it does not. */
export const waitsPart = (e: ScheduleEntry, zone?: string): string =>
  e.pendingSince ? `due, waits for the session since ${stamp(Number(e.pendingSince), zone)}` : ''
