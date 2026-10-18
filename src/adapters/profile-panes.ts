// The herdr panes opened with a Claude profile's CLAUDE_CONFIG_DIR (`tab create --env`), by
// spawn-agent and the board's launchers: a session in one of them runs in that profile, so it may
// be woken there, and spawn-agent --pane may start that profile's session in it. Kept in
// profile-panes.json as { "<pane>": { "profile": "<id>", "at": <ms> } }; unknown fields are kept.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { profilePanesFile } from './paths.ts'

type Panes = Record<string, unknown>

/** `pane` was opened in the profile `profile` (herdr reuses pane ids: the newest record wins). */
export function recordProfilePane(pane: string, profile: string): void {
  const file = profilePanesFile()
  mkdirSync(dirname(file), { recursive: true })
  updateJson(
    file,
    (saved: Panes | null): Panes => {
      const entry = saved?.[pane]
      return { ...saved, [pane]: { ...(isRecord(entry) ? entry : {}), profile, at: Date.now() } }
    },
    isRecord,
  )
}

/** The recorded panes and the id of the profile each was opened in. */
export function profilePanes(): Map<string, string> {
  const panes = new Map<string, string>()
  for (const [pane, entry] of Object.entries(readJson(profilePanesFile(), isRecord) ?? {}))
    if (isRecord(entry) && typeof entry.profile === 'string' && entry.profile) panes.set(pane, entry.profile)
  return panes
}

/** Drop the records of panes herdr no longer has: only those in `live` stay. */
export function forgetProfilePanes(live: ReadonlySet<string>): void {
  const file = profilePanesFile()
  if (!readJson(file, isRecord)) return
  updateJson(
    file,
    (saved: Panes | null): Panes | undefined => {
      if (!saved) return undefined
      const kept = Object.entries(saved).filter(([pane]) => live.has(pane))
      return kept.length === Object.keys(saved).length ? undefined : Object.fromEntries(kept)
    },
    isRecord,
  )
}
