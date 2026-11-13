// MokuPilot's day folder (#331, core/mokupilot-day.ts): the day running now, and a message put in
// its inbox for MokuPilot to type into the day session.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type DaySession, dayName, type PiDay, parseDayState, parsePiDay, reportName } from '../core/mokupilot-day.ts'

import { mokupilotHere } from './mokupilot-call.ts'

export type { PiDay }

/** The days' folder: MOKUPILOT_DAY_ROOT (a leading ~ is the home), else ~/.meeting-copilot/day. */
export function dayRoot(home = homedir()): string {
  const own = process.env.MOKUPILOT_DAY_ROOT?.trim()
  if (!own) return join(home, '.meeting-copilot', 'day')
  return own === '~' || /^~[\\/]/.test(own) ? join(home, own.slice(1)) : own
}

/** The day running now, with its folder; null for none, or a state.json that cannot be read. */
export function runningDay({
  root = dayRoot(),
  now = new Date(),
}: {
  root?: string
  now?: Date
} = {}): (DaySession & { folder: string }) | null {
  const folder = join(root, dayName(now))
  try {
    const day = parseDayState(JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8')))
    return day && { ...day, folder }
  } catch {
    return null
  }
}

/** The pi day running now (#393), null for none or a state.json that cannot be read. */
export function runningPiDay({ root = dayRoot(), now = new Date() }: { root?: string; now?: Date } = {}): PiDay | null {
  try {
    return parsePiDay(JSON.parse(readFileSync(join(root, dayName(now), 'state.json'), 'utf8')))
  } catch {
    return null
  }
}

export interface DayGateOptions {
  /** Whether MokuPilot has run on this computer. */
  here?: () => boolean
  read?: () => DaySession | null
  now?: () => number
}

/**
 * The day session to show, for config.json's `cfg`: none where `"mokupilot": false` turns MokuPilot
 * off or it never ran here, without a look at its folder; whether it has run here is looked up once
 * a minute, as the call agents' gate does (adapters/mokupilot-call.ts callAgentsGate).
 */
export function dayGate({ here = mokupilotHere, read = runningDay, now = Date.now }: DayGateOptions = {}) {
  let seen = { at: Number.NEGATIVE_INFINITY, on: false }
  return (cfg: { readonly mokupilot?: unknown; readonly [key: string]: unknown }): DaySession | null => {
    if (cfg.mokupilot === false) return null
    if (now() - seen.at > 60_000) seen = { at: now(), on: here() }
    return seen.on ? read() : null
  }
}

let lastStamp = 0

/**
 * A message for the day session in `folder`'s inbox, whole or not at all; its path. Files go out in
 * the order they were written: each one's stamp is later than the one before, as MokuPilot's own.
 */
export function reportToDay(folder: string, sender: string, text: string, now = Date.now()): string {
  const inbox = join(folder, 'inbox')
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  lastStamp = Math.max(now * 1000, lastStamp + 1)
  const file = join(inbox, reportName(lastStamp, randomBytes(4).toString('hex')))
  const temp = join(inbox, `.board-${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify({ from: sender, text, at: now / 1000 }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
  return file
}
