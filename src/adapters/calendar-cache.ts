// The calendar's files in the state folder (#328): each fetched or pushed source's last copy of its
// events with how its sync stands, and an ICS source's secret address. Neither is in the board's
// database: a copy is a provider's data, fetched again at will, so it stays out of the journal and
// the backups; the address is a secret, readable by the owner alone.
//
//   calendar/<source>.json          { source, from, to, events, lastOk, lastTry, error, fails }
//   calendar/secret/<source>.json   { "url": "<the address>" }   (0600; what the `calendar` sink writes)
//
// A copy is written whole by rename, so the web board and a `board cal` command never read half of
// one. A failed fetch writes the copy again with its events as they were and the error beside them.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type CalEvent, eventOf, SOURCE_ID, webAddress } from '../core/calendar.ts'
import { isRecord, readJson, replaceFile } from './json-store.ts'
import { stateDir } from './paths.ts'

export const calendarDir = (): string => join(stateDir(), 'calendar')
export const secretDir = (): string => join(calendarDir(), 'secret')

/** A source's copy: its events in the window it was fetched for, and how its sync stands. */
export interface SourceCopy {
  source: string
  /** The window the events were fetched for (ms). */
  from: number
  to: number
  events: CalEvent[]
  /** The last fetch that went through, and the last one tried (ms). */
  lastOk: number | null
  lastTry: number | null
  /** The last fetch's error, in words without the address; null: it went through. */
  error: string | null
  /** Fetches failed in a row. */
  fails: number
}

const copyFile = (id: string): string => join(calendarDir(), `${id}.json`)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A source's copy as it was left, or null: none yet (or the id cannot be a source's). */
export function readCopy(id: string): SourceCopy | null {
  if (!SOURCE_ID.test(id)) return null
  const raw = readJson(copyFile(id), isRecord)
  if (!raw) return null
  const events = Array.isArray(raw.events)
    ? raw.events.map(e => eventOf(e, id)).filter((e): e is CalEvent => e !== null)
    : []
  return {
    source: id,
    from: num(raw.from) ?? 0,
    to: num(raw.to) ?? 0,
    events,
    lastOk: num(raw.lastOk),
    lastTry: num(raw.lastTry),
    error: typeof raw.error === 'string' ? raw.error : null,
    fails: num(raw.fails) ?? 0,
  }
}

export function writeCopy(copy: SourceCopy): void {
  if (!SOURCE_ID.test(copy.source)) throw new Error(`not a source id: ${copy.source}`)
  mkdirSync(calendarDir(), { recursive: true })
  replaceFile(copyFile(copy.source), JSON.stringify(copy))
}

export function removeCopy(id: string): void {
  if (SOURCE_ID.test(id)) rmSync(copyFile(id), { force: true })
}

/** What the copies are at now, as one stamp that changes with any of them (the payload's line). */
export function copiesStamp(): number {
  const dir = calendarDir()
  if (!existsSync(dir)) return 0
  let stamp = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      stamp += Math.round(statSync(join(dir, f)).mtimeMs)
    } catch {}
  }
  return stamp
}

// ------------------------------------------------------------------ an ICS source's address

const addressFile = (id: string): string => join(secretDir(), `${id}.json`)

/** webcal:// is https:// for a fetch; anything else but http(s) is no address. */
export function icsAddress(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().replace(/^webcals?:\/\//i, 'https://') : ''
  return webAddress(s)
}

/**
 * The folder of the addresses, made when missing: on macOS and Linux its owner's alone (0700), as
 * each file in it is (0600), so no other user lists which sources have one. Windows keeps the
 * profile folder's own access rules.
 */
export function makeSecretDir(): void {
  mkdirSync(secretDir(), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(secretDir(), 0o700)
}

/** An ICS source's address, or null: none set (or not one that can be fetched). */
export function readIcsAddress(id: string): string | null {
  if (!SOURCE_ID.test(id)) return null
  const raw = readJson(addressFile(id), isRecord)
  return raw ? icsAddress(raw.url) : null
}

export const hasIcsAddress = (id: string): boolean => SOURCE_ID.test(id) && existsSync(addressFile(id))

/** The address as the `calendar` sink writes it: the file readable by the owner alone. */
export function writeIcsAddress(id: string, url: string): void {
  if (!SOURCE_ID.test(id)) throw new Error(`not a source id: ${id}`)
  makeSecretDir()
  replaceFile(addressFile(id), `${JSON.stringify({ url })}\n`, undefined, 0o600)
}

export function removeIcsAddress(id: string): void {
  if (SOURCE_ID.test(id)) rmSync(addressFile(id), { force: true })
}
