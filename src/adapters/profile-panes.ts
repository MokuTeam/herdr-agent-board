// The herdr panes opened with a Claude profile's CLAUDE_CONFIG_DIR (`tab create --env`), by
// spawn-agent and the board's launches: a session in one of them runs in that profile, so it may
// be woken there, and spawn-agent --pane may start that profile's session in it. Kept in
// profile-panes.json as { "<pane>": { "profile": "<id>", "terminal": "<id>", "at": <ms> } };
// unknown fields are kept. herdr gives a pane's id out again after it starts over, to another
// terminal with herdr's own env: a record vouches for a live pane only while that pane holds the
// terminal the record names (herdr's `terminal_id`), never for a pane of the same id alone.
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

/** Whether a record is of the pane that holds `terminal` now. */
const sameTerminal = (entry: unknown, terminal: string | null | undefined): boolean =>
  isRecord(entry) && typeof entry.terminal === 'string' && !!entry.terminal && entry.terminal === terminal

/**
 * The recorded panes and the id of the profile each was opened in. With `live` (herdr's panes and
 * their terminals): only the records of a live pane that still holds the terminal it was opened with.
 */
export function profilePanes(live?: PaneTerminals): Map<string, string> {
  const panes = new Map<string, string>()
  for (const [pane, entry] of Object.entries(readJson(profilePanesFile(), isRecord) ?? {})) {
    if (!isRecord(entry) || typeof entry.profile !== 'string' || !entry.profile) continue
    if (live && !sameTerminal(entry, live.get(pane))) continue
    panes.set(pane, entry.profile)
  }
  return panes
}

/** Drop the records `keep` says no to. No file: none is made; nothing dropped: nothing is written. */
function forgetWhere(keep: (pane: string, entry: unknown) => boolean): void {
  const file = profilePanesFile()
  if (!readJson(file, isRecord)) return
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
 * those ids; with their terminals (a Map) it keeps only a record of the terminal the pane holds now.
 */
export function forgetProfilePanes(live: ReadonlySet<string> | PaneTerminals): void {
  if (withTerminals(live)) forgetWhere((pane, entry) => sameTerminal(entry, live.get(pane)))
  else forgetWhere(pane => live.has(pane))
}

/** Drop the record of `pane`: herdr opened a new pane of that id without a profile's env. */
export function forgetProfilePane(pane: string): void {
  forgetWhere(p => p !== pane)
}
