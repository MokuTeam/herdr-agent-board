// The herdr panes opened with a Claude profile's CLAUDE_CONFIG_DIR (`tab create --env`), by
// spawn-agent and the board's launches: a session in one of them runs in that profile, so it may
// be woken there, and spawn-agent --pane may start that profile's session in it. Kept in
// profile-panes.json as { "<pane>": { "profile": "<id>", "terminal": "<id>", "at": <ms> } };
// unknown fields are kept. herdr gives a pane's id out again after it starts over, to another
// terminal with herdr's own env, so a record is read against the terminal the pane holds now
// (herdr's `terminal_id`), in one of two ways, never a third:
//   provenProfilePanes    the profile a live pane MAY VOUCH FOR (a wake, a --pane start that sets
//                         the folder): only a record of the very terminal the pane holds.
//   possibleProfilePanes  the profile a live pane COULD BE IN (to refuse a start that leaves the
//                         env alone): a record unless herdr shows the pane holds another terminal.
// A terminal not known on either side proves nothing and rules nothing out.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { profilePanesFile } from './paths.ts'

type Panes = Record<string, unknown>

/** herdr's live panes, each with the terminal it holds (`terminal_id`; null when herdr did not say). */
export type PaneTerminals = ReadonlyMap<string, string | null>

/**
 * `pane` was opened in the profile `profile`, holding `terminal` (herdr reuses pane ids: the
 * newest record wins). Without a terminal the record vouches for no live pane.
 */
export function recordProfilePane(pane: string, profile: string, terminal?: string | null): void {
  const file = profilePanesFile()
  mkdirSync(dirname(file), { recursive: true })
  updateJson(
    file,
    (saved: Panes | null): Panes => {
      const entry = saved?.[pane]
      const next: Record<string, unknown> = { ...(isRecord(entry) ? entry : {}), profile, at: Date.now() }
      // An older record's terminal is another pane's.
      if (terminal) next.terminal = terminal
      else delete next.terminal
      return { ...saved, [pane]: next }
    },
    isRecord,
  )
}

/** A terminal id as far as it is known: a non-empty string, else null. */
const known = (terminal: unknown): string | null => (typeof terminal === 'string' && terminal ? terminal : null)
const terminalOf = (entry: unknown): string | null => (isRecord(entry) ? known(entry.terminal) : null)

/** herdr proves the pane is the one recorded: both terminals known, and the same. */
const proven = (entry: unknown, live: string | null | undefined): boolean => {
  const recorded = terminalOf(entry)
  return recorded !== null && recorded === known(live)
}
/** herdr proves the pane is another one than recorded: both terminals known, and not the same. */
const reused = (entry: unknown, live: string | null | undefined): boolean => {
  const recorded = terminalOf(entry)
  const now = known(live)
  return recorded !== null && now !== null && recorded !== now
}

/** The profile of each record of a pane in `live` that `counts`. */
function readPanes(
  live: PaneTerminals,
  counts: (entry: unknown, terminal: string | null) => boolean,
): Map<string, string> {
  const panes = new Map<string, string>()
  for (const [pane, entry] of Object.entries(readJson(profilePanesFile(), isRecord) ?? {})) {
    if (!isRecord(entry) || typeof entry.profile !== 'string' || !entry.profile) continue
    const terminal = live.get(pane)
    if (terminal === undefined || !counts(entry, terminal)) continue
    panes.set(pane, entry.profile)
  }
  return panes
}

/**
 * VOUCHING: the profile each live pane (`live`, with its terminal) was proven opened in, for what
 * may run in that profile because the pane is in it (a wake, a --pane start that sets the folder).
 * A record counts only when it names the very terminal the pane holds: a record without one, or a
 * pane herdr did not say the terminal of, vouches for nothing.
 */
export function provenProfilePanes(live: PaneTerminals): Map<string, string> {
  return readPanes(live, proven)
}

/**
 * BLOCKING: the profile each live pane (`live`, with its terminal) could be in, for what must not
 * run there unless it is that profile (a start that leaves the env alone). A record counts unless
 * both terminals are known and differ: one herdr cannot tell apart from the pane still blocks.
 * Before herdr is asked, give the pane's terminal as null.
 */
export function possibleProfilePanes(live: PaneTerminals): Map<string, string> {
  return readPanes(live, (entry, terminal) => !reused(entry, terminal))
}

/** Drop the records `keep` says no to. No file: none is made; nothing dropped: nothing is written. */
function forgetWhere(keep: (pane: string, entry: unknown) => boolean): void {
  const file = profilePanesFile()
  const found = readJson(file, isRecord)
  // Nothing to drop: no lock taken, so a start that only tidies up never waits on it.
  if (!found || Object.entries(found).every(([pane, entry]) => keep(pane, entry))) return
  updateJson(
    file,
    (saved: Panes | null): Panes | undefined => {
      if (!saved) return undefined
      const kept = Object.entries(saved).filter(([pane, entry]) => keep(pane, entry))
      return kept.length === Object.keys(saved).length ? undefined : Object.fromEntries(kept)
    },
    isRecord,
  )
}

const withTerminals = (live: ReadonlySet<string> | PaneTerminals): live is PaneTerminals => live instanceof Map

/**
 * Drop the records of panes herdr no longer has. `live` as a Set of pane ids keeps the records of
 * those ids; with their terminals (a Map) it also drops a record herdr shows to be of another
 * terminal than the pane holds now. A record whose terminal is not known on either side is kept:
 * it still blocks (possibleProfilePanes).
 */
export function forgetProfilePanes(live: ReadonlySet<string> | PaneTerminals): void {
  if (withTerminals(live)) forgetWhere((pane, entry) => live.has(pane) && !reused(entry, live.get(pane)))
  else forgetWhere(pane => live.has(pane))
}

/** Drop the record of `pane`: herdr opened a new pane of that id without a profile's env. */
export function forgetProfilePane(pane: string): void {
  forgetWhere(p => p !== pane)
}
