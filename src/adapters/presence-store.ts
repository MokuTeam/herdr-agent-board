// The user's presence on record (core/presence.ts): presence.json in the board's state folder,
// written under its lock by the board, `board away` and the hooks' readers alike. No file is
// the state no one set (here); a setup that never turned presence on never has one.
import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  isPresence,
  NO_PRESENCE,
  type Presence,
  type PresenceSource,
  type PresenceState,
  presenceConfig,
  presenceLine,
} from '../core/presence.ts'
import type { Card, Config } from '../core/types.ts'
import { readCard, writeCard } from './cards.ts'
import { readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export const presenceFile = (): string => join(stateDir(), 'presence.json')

/** The state on record, or null when there is no file (or no valid one). */
export const readPresence = (): Presence | null => readJson(presenceFile(), isPresence)

/** The state on record, the default (here) when none. */
export const currentPresence = (): Presence => readPresence() ?? NO_PRESENCE

/**
 * Set the state. The same state again changes nothing (its time and who set it stay), so a click
 * on "away" while the board already put the user away is no new change. A call keeps the state it
 * started from, to return to. Returns the state on record and whether it changed.
 */
export function setPresence(
  state: PresenceState,
  by: Presence['by'],
  from: PresenceSource,
  now = Date.now(),
): { presence: Presence; changed: boolean } {
  let changed = false
  mkdirSync(stateDir(), { recursive: true })
  const presence = updateJson(
    presenceFile(),
    (cur: Presence | null): Presence => {
      const was = cur ?? NO_PRESENCE
      if (was.state === state && cur) return cur
      changed = true
      if (state !== 'call' || was.state === 'call') return { state, since: now, by, from }
      return { state, since: now, by, from, before: was.state }
    },
    isPresence,
  )
  return { presence, changed }
}

/** Forget the state (presence turned off): the hooks go quiet again. */
export function clearPresence(): void {
  try {
    unlinkSync(presenceFile())
  } catch {}
}

/** For a brief (the hooks): the presence to tell, or null where config.json has it off. */
export const presenceForBrief = (cfg: Pick<Config, 'presence'>): Presence | null =>
  presenceConfig(cfg.presence) ? currentPresence() : null

/**
 * For a prompt (the hooks): the line to add when the presence changed since the session was last
 * told, and the `since` to note on its card. A card that never heard of presence (every card of a
 * setup that never turned it on) reads nothing at all.
 */
export function presenceNews(
  card: Pick<Card, 'presenceSeen'> | null | undefined,
): { line: string; seen: number } | null {
  const seen = card?.presenceSeen
  if (typeof seen !== 'number') return null
  const p = readPresence() ?? (seen === -1 ? NO_PRESENCE : null)
  if (!p || p.since === seen) return null
  return { line: presenceLine(p), seen: p.since }
}

/**
 * Presence was turned on while these sessions ran: each with a briefed card that never heard of
 * it is marked, and its next prompt tells it (presenceNews). Nothing is typed into a session.
 */
export function markSessions(keys: Iterable<string>): void {
  for (const key of keys) {
    const card = readCard(key)
    if (card?.briefV && card.presenceSeen === undefined) writeCard(key, { presenceSeen: -1 })
  }
}

/** Presence was turned off: the sessions that heard of it forget it, so no prompt reads it again. */
export function unmarkSessions(keys: Iterable<string>): void {
  for (const key of keys) if (readCard(key)?.presenceSeen !== undefined) writeCard(key, { presenceSeen: '' })
}
