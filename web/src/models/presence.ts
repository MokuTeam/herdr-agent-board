// The toolbar's presence switch (#172, src/core/presence.ts), its rules on their own: whether it
// shows (only while the payload carries `presence`, so a board without presence looks as before),
// what it says, what a press sends, the offer detection makes in mode 'suggest', and "on a call"
// by hand where MokuPilot runs (#276; its calls switch by themselves).
import {
  isPresenceMode,
  isPresenceState,
  type PresenceSource,
  type PresenceState,
  type PresenceView,
} from '../../../src/core/presence.ts'
import type { Translator } from '../../../src/core/types.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The payload's `presence`, as far as the page relies on it. */
export const isPresenceView = (v: unknown): v is PresenceView =>
  isRecord(v) &&
  isPresenceState(v.state) &&
  typeof v.since === 'number' &&
  isPresenceMode(v.mode) &&
  typeof v.idleMinutes === 'number' &&
  (v.hint === null || isPresenceState(v.hint))

export interface PresenceSwitchView {
  state: PresenceState
  label: string
  hint: string
  /** What a press switches to. */
  next: PresenceState
  /** Detection's offer (mode 'suggest'): its words and the state it offers; null: none. */
  offer: { text: string; state: PresenceState } | null
  /** "On a call" by hand: its words, where MokuPilot runs and the user is not on one. */
  call?: string
}

const LABEL = { here: 'presence.here', away: 'presence.away', call: 'presence.call' } as const
const HINT = { here: 'presence.hereHint', away: 'presence.awayHint', call: 'presence.callHint' } as const

/** What the switch shows, or null while presence is not on (no switch at all). */
export function presenceSwitch(raw: unknown, t: Translator): PresenceSwitchView | null {
  if (!isPresenceView(raw)) return null
  const { state, hint } = raw
  const offer =
    hint && hint !== state
      ? { text: t(hint === 'away' ? 'presence.suggestAway' : 'presence.suggestHere'), state: hint }
      : null
  return {
    state,
    label: t(LABEL[state]),
    hint: t(HINT[state]),
    // A call ends back where it started.
    next: state === 'call' ? (raw.before ?? 'here') : state === 'away' ? 'here' : 'away',
    offer,
    ...(raw.calls === true && state !== 'call' && { call: t('presence.setCall') }),
  }
}

/** What a press sends: the state, and where it came from (a phone's page or the board's own). */
export const presenceBody = (state: PresenceState, phone: boolean): { state: PresenceState; from: PresenceSource } => ({
  state,
  from: phone ? 'phone' : 'web',
})
