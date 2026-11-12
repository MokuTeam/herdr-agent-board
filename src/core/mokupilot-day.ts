// A MokuPilot day session on the board (#331). MokuPilot drives it as `claude -p` over stream-json
// with every hook off (`--settings {"disableAllHooks": true}`), so none of the board's hooks run in
// it and herdr names no session in the pane MokuPilot runs in. What the board knows of it comes
// from MokuPilot's day folder, <day root>/<YYYY-MM-DD>/ (the root: MOKUPILOT_DAY_ROOT, else
// ~/.meeting-copilot/day), the contract on issue #331:
//   state.json  { provider, fork_session, ended_at, herdr_pane, ... }: the day runs while
//               fork_session is set and ended_at is null; fork_session is its Claude session id;
//               herdr_pane the pane MokuPilot runs in, when it runs in one
//   inbox/      one file per message, <16-digit microseconds>-<8 hex>.json, { from, text, at }
//               (unix seconds), written whole (a temporary file renamed): MokuPilot types each into
//               the day session as "[report] <from>: <text>" (`meet day --report` writes the same)
// Typing into its pane would reach MokuPilot's console, not the session: messages go to the inbox.
// Pure: what the files say, read and written by adapters/mokupilot-day.ts.
import { SAFE_NAME } from './call-agent.ts'

/** The running day's session as its state.json says. */
export interface DaySession {
  /** Its Claude session id. */
  session: string
  /** The herdr pane MokuPilot runs in, '' when it does not say. */
  pane: string
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** A herdr pane id as herdr writes it (`wP:p9N`), else ''. */
const paneId = (v: unknown): string =>
  typeof v === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(v.trim()) ? v.trim() : ''

/** The day a state.json says runs, null for none: not Claude's, no session yet, or ended. */
export function parseDayState(raw: unknown): DaySession | null {
  const d = rec(raw)
  if (d?.provider !== 'claude') return null
  const session = typeof d.fork_session === 'string' ? d.fork_session : ''
  if (!SAFE_NAME.test(session)) return null
  if (d.ended_at !== undefined && d.ended_at !== null) return null
  return { session, pane: paneId(d.herdr_pane) }
}

/** A pi day (#393): its task board is pi's file, which the board copies into threads while they are on. */
export interface PiDay {
  /** Its pi session id: the task board is ~/.agent-boards/pi/<session>.json. */
  session: string
  /** Its folder, which decides the lane of the threads copied from it. */
  cwd: string
  /** The name MokuPilot gave the day, '' when none. */
  name: string
}

/** The pi day a state.json says runs, null for none: not pi's, no session yet, or ended. */
export function parsePiDay(raw: unknown): PiDay | null {
  const d = rec(raw)
  if (d?.provider !== 'pi') return null
  const session = typeof d.fork_session === 'string' ? d.fork_session : ''
  if (!SAFE_NAME.test(session)) return null
  if (d.ended_at !== undefined && d.ended_at !== null) return null
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  return { session, cwd: text(d.cwd, 1000), name: text(d.name, 60) }
}

/** The day folder's name for a time: its local date, as MokuPilot names it. */
export function dayName(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
}

/** An inbox file's name: microseconds since 1970, 16 digits, then 8 hex characters. */
export const reportName = (micros: number, hex: string): string =>
  `${String(Math.max(0, Math.trunc(micros))).padStart(16, '0')}-${hex}.json`
