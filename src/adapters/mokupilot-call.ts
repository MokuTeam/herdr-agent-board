// A MokuPilot call in progress on this computer (#276), for presence (core/presence.ts): while a
// call runs, MokuPilot keeps call.json in its state folder, `{ "pid": <its process>, "started":
// <unix seconds> }`, and takes it away when the call ends. A file whose process is gone (MokuPilot
// ended mid-call without taking it away) or older than a day says no call.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isAlive } from './process.ts'

const stateFolder = (home = homedir()): string => join(home, '.meeting-copilot')
export const callFile = (home = homedir()): string => join(stateFolder(home), 'call.json')

/** Whether MokuPilot keeps its state on this computer: it has run here. */
export const mokupilotHere = (home = homedir()): boolean => existsSync(stateFolder(home))

const MAX_CALL_MS = 24 * 60 * 60 * 1000

export interface CallOptions {
  file?: string
  now?: () => number
  alive?: (pid: number) => boolean
}

/** The call in progress, as an id that a next call does not share (its process and start), or null. */
export function callInProgress({
  file = callFile(),
  now = Date.now,
  alive = isAlive,
}: CallOptions = {}): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { pid, started } = raw as Record<string, unknown>
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null
  if (typeof started !== 'number' || !Number.isFinite(started)) return null
  const age = now() - started * 1000
  if (age < -60_000 || age > MAX_CALL_MS || !alive(pid as number)) return null
  return `${pid}:${started}`
}
