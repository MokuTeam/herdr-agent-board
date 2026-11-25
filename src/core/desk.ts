// The owner's desk (#788, epic #763 T5): the computer the owner sits at. A master that runs on a
// headless server sees no keyboard and no screen, so the machines the owner works at tell it: each
// node answers the master's ask for how long its computer has gone without input and whether its
// screen is locked (GET /api/node/desk on its door), the master adds its own reading where it has a
// desktop, and the most recently active desk stands for the owner. Its presence detection
// (core/presence.ts presenceStep) reads that one observation as before; the desktop notifications
// (calendar reminders, Team) go to that desk alone, once.
//
// Only a master with `nodes` asks; a board without them reads its own computer as it always did.
// No I/O: the master's side is services/nodes/desks.ts, the node's services/node/desk.ts.
import { REMINDER_ID } from './calendar-reminders.ts'
import type { Observation } from './presence.ts'
import { isThreadKey } from './team-unread.ts'

/** A desk's reading: whose (`''` this board's own computer, else a device id), what it said, when (ms). */
export interface DeskReading {
  device: string
  idleSec: number | null
  locked: boolean | null
  at: number
}

/** What a node's door answers to the master's ask (GET /api/node/desk). */
export interface DeskAnswer {
  ok: true
  /** Whether the node's computer has a desktop at all; without one it says nothing more. */
  desktop: boolean
  idleSec?: number | null
  locked?: boolean | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A node's answer as a reading at `at`, or null: no desktop there, or nothing it can tell. */
export function deskReadingOf(raw: unknown, device: string, at: number): DeskReading | null {
  if (!isObject(raw) || raw.desktop !== true) return null
  const idle = raw.idleSec
  const idleSec = typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 ? idle : null
  const locked = typeof raw.locked === 'boolean' ? raw.locked : null
  if (idleSec === null && locked === null) return null
  return { device, idleSec, locked, at }
}

/**
 * How a desk ranks: an unlocked one with an idle time by when the owner last touched it (its time
 * less its idle time); then an unlocked one that tells no idle time (a desktop that says only "not
 * locked"), which stands for the owner only where no desk tells an idle time; a locked one last.
 */
function rank(r: DeskReading): [number, number] {
  if (r.locked === true) return [0, r.at]
  if (r.idleSec === null) return [1, r.at]
  return [2, r.at - r.idleSec * 1000]
}

/** Whether desk `a` stands for the owner before desk `b`. A tie goes to this computer, then to the first device by id. */
function ranksBefore(a: DeskReading, b: DeskReading): boolean {
  const [ka, ta] = rank(a)
  const [kb, tb] = rank(b)
  if (ka !== kb) return ka > kb
  if (ta !== tb) return ta > tb
  if ((a.device === '') !== (b.device === '')) return a.device === ''
  return a.device < b.device
}

/** The desks that tell anything, the most recently active first. */
export function rankDesks(readings: readonly DeskReading[]): DeskReading[] {
  return readings
    .filter(r => r.idleSec !== null || r.locked !== null)
    .sort((a, b) => (ranksBefore(a, b) ? -1 : ranksBefore(b, a) ? 1 : 0))
}

/** The most recently active desk of these, or null when none tells anything. */
export function activeDesk(readings: readonly DeskReading[]): DeskReading | null {
  return rankDesks(readings)[0] ?? null
}

/**
 * What the desks say of the owner, as one observation for presence detection: the most recently
 * active desk's own reading. Its idle time is the shortest of the unlocked ones that tell one, so it
 * says "away" only when every such desk is idle past the limit or locked; no desk that tells anything is no word at
 * all (presence stays as it is), which is what a headless master alone says.
 */
export function combineDesks(readings: readonly DeskReading[]): Observation {
  const best = activeDesk(readings)
  return best ? { idleSec: best.idleSec, locked: best.locked } : { idleSec: null, locked: null }
}

/** The longest text a desk notification carries in one field. */
const MOST_TEXT = 1000
const MOST_URL = 2048
/** A Team message's id as a toast tags it: printable, no spaces. */
const ID = /^[\x21-\x7e]{1,200}$/

const text = (v: unknown, max = MOST_TEXT): v is string => typeof v === 'string' && v.length <= max
const optText = (v: unknown): boolean => v === undefined || text(v)

/** A link a notification may open: http or https only. */
function webLink(v: unknown): v is string {
  if (!text(v, MOST_URL)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/** A calendar reminder as integrations/reminder-toast.ts shows it. */
export interface DeskReminder {
  id: string
  title: string
  body: string
  whose: string
  join?: string | undefined
  expires: number
  labels: { join: string; open: string; snooze: string; start?: string | undefined }
}

/** A Team message as integrations/team-toast.ts shows it. */
export interface DeskTeam {
  id: string
  thread: string
  title: string
  body: string
  label: string
}

/** What a master posts to its desk node (POST /api/node/desk-toast). */
export type DeskToast =
  | { kind: 'reminder'; toast: DeskReminder }
  | { kind: 'reminder-clear'; id: string }
  | { kind: 'team'; toast: DeskTeam }

/** The master's post as the node shows it, or null: only these kinds, each field of its kind, bounded. */
export function deskToastOf(raw: unknown): DeskToast | null {
  if (!isObject(raw)) return null
  if (raw.kind === 'reminder-clear')
    return typeof raw.id === 'string' && REMINDER_ID.test(raw.id) ? { kind: raw.kind, id: raw.id } : null
  const t = raw.toast
  if (!isObject(t)) return null
  if (raw.kind === 'reminder') {
    const l = t.labels
    if (
      typeof t.id !== 'string' ||
      !REMINDER_ID.test(t.id) ||
      !text(t.title) ||
      !text(t.body) ||
      !text(t.whose) ||
      !(t.join === undefined || webLink(t.join)) ||
      typeof t.expires !== 'number' ||
      !Number.isFinite(t.expires) ||
      !isObject(l) ||
      !text(l.join) ||
      !text(l.open) ||
      !text(l.snooze) ||
      !optText(l.start)
    )
      return null
    return {
      kind: 'reminder',
      toast: {
        id: t.id,
        title: t.title,
        body: t.body,
        whose: t.whose,
        ...(t.join !== undefined && { join: t.join }),
        expires: t.expires,
        labels: {
          join: l.join,
          open: l.open,
          snooze: l.snooze,
          ...(l.start !== undefined && { start: l.start as string }),
        },
      },
    }
  }
  if (raw.kind === 'team') {
    if (
      typeof t.id !== 'string' ||
      !ID.test(t.id) ||
      !isThreadKey(t.thread) ||
      !text(t.title) ||
      !text(t.body) ||
      !text(t.label)
    )
      return null
    return { kind: 'team', toast: { id: t.id, thread: t.thread, title: t.title, body: t.body, label: t.label } }
  }
  return null
}
