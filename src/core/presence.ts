// Whether the user is at the computer ('here') or away from it ('away'), #172: the board keeps it
// (adapters/presence-store.ts), the user switches it (the web board and the phone, `board away`,
// POST /api/presence), and the board can notice it by itself (services/presence.ts). Every
// session reads it passively: a line in its hook context (entrypoints/hook.ts) and `board
// presence`. The line tells the agent where its news goes: while the user is away, also to where
// they read it away from the computer (a messenger such as Telegram); while here, the board and
// the terminal only. Nothing is ever typed into a session for it.
//
// config.json's `presence` turns it on; a setup without it sees nothing of this anywhere:
//   "presence": { "mode": "auto", "idleMinutes": 15 }
// mode: 'auto' (the default) switches by itself on idle input or a locked screen, and back;
// 'suggest' only offers the switch on the board; 'off' is the manual switch alone. `true` is
// { mode: 'auto' }.

export const PRESENCE_MODES = ['auto', 'suggest', 'off'] as const
export type PresenceMode = (typeof PRESENCE_MODES)[number]
export type PresenceState = 'here' | 'away'
/** Where a manual switch came from; 'auto' marks the board's own. */
export const PRESENCE_SOURCES = ['web', 'phone', 'cli', 'agent', 'api', 'auto'] as const
export type PresenceSource = (typeof PRESENCE_SOURCES)[number]

export interface Presence {
  state: PresenceState
  /** When it last changed (ms); 0 for the state no one set yet. */
  since: number
  /** Who set it: the user (a switch) or the board's detection. */
  by: 'user' | 'auto'
  from?: PresenceSource
}

/** What the page, the phone and GET /api/presence see (services/presence.ts). */
export interface PresenceView extends Presence {
  mode: PresenceMode
  idleMinutes: number
  /** The state detection offers (mode 'suggest'), or null. */
  hint: PresenceState | null
  /** Whether this computer told detection anything at its last ask; null before one. */
  detects: boolean | null
}

export interface PresenceConfig {
  mode: PresenceMode
  /** Minutes without input before the user counts as away. */
  idleMinutes: number
}

export const DEFAULT_IDLE_MINUTES = 15
export const MAX_IDLE_MINUTES = 24 * 60

/** The state before anyone set one: here, as if the board had seen the user. */
export const NO_PRESENCE: Presence = { state: 'here', since: 0, by: 'auto' }

export const isPresenceMode = (v: unknown): v is PresenceMode => PRESENCE_MODES.some(m => m === v)
export const isPresenceState = (v: unknown): v is PresenceState => v === 'here' || v === 'away'
export const isPresenceSource = (v: unknown): v is PresenceSource => PRESENCE_SOURCES.some(s => s === v)

export const validIdleMinutes = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_IDLE_MINUTES

/**
 * config.json's `presence` as the board uses it, or null while it is not on: no section, `false`,
 * or something else that is no object. A section without a valid mode is 'auto'; a missing or
 * out-of-range idleMinutes is the default.
 */
export function presenceConfig(raw: unknown): PresenceConfig | null {
  if (raw === true) return { mode: 'auto', idleMinutes: DEFAULT_IDLE_MINUTES }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  return {
    mode: isPresenceMode(r.mode) ? r.mode : 'auto',
    idleMinutes: validIdleMinutes(r.idleMinutes) ? r.idleMinutes : DEFAULT_IDLE_MINUTES,
  }
}

export const isPresence = (v: unknown): v is Presence => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const p = v as Record<string, unknown>
  return (
    isPresenceState(p.state) &&
    typeof p.since === 'number' &&
    (p.by === 'user' || p.by === 'auto') &&
    (p.from === undefined || isPresenceSource(p.from))
  )
}

/** What the computer said, each null when it cannot tell: seconds since the last input, a locked screen. */
export interface Observation {
  idleSec: number | null
  locked: boolean | null
}

/** What an observation says of the user: gone, at the computer, or nothing (no way to tell). */
export function seenOf(obs: Observation, idleMinutes: number): 'away' | 'back' | null {
  if (obs.locked === true) return 'away'
  if (obs.idleSec !== null) return obs.idleSec >= idleMinutes * 60 ? 'away' : 'back'
  if (obs.locked === false) return 'back'
  return null
}

/**
 * What detection keeps between steps: whether, since the state last changed, an observation has
 * agreed with it. A manual switch starts disagreeing ("I am away" said at the keyboard), and the
 * board flips it only once the user did what they said and then stopped: the next clear change,
 * not the first observation after the click.
 */
export interface StepMemory {
  since: number
  agreed: boolean
}

export interface Step {
  /** Switch to this state now (mode 'auto'). */
  flip?: PresenceState
  /** Offer this state on the board (mode 'suggest'); null: nothing to offer. */
  hint: PresenceState | null
  memory: StepMemory
}

/**
 * One detection step: the state on record, what the computer says now, the config and the memory
 * of the step before. Pure, so tests drive it with fake clocks and inputs.
 */
export function presenceStep(p: Presence, obs: Observation, cfg: PresenceConfig, memory: StepMemory | null): Step {
  // A state the board set agreed with what it saw; one the user set has to be seen first.
  const mem = memory && memory.since === p.since ? memory : { since: p.since, agreed: p.by === 'auto' }
  const seen = seenOf(obs, cfg.idleMinutes)
  if (!seen || cfg.mode === 'off') return { hint: null, memory: mem }
  const want: PresenceState = seen === 'away' ? 'away' : 'here'
  if (want === p.state) return { hint: null, memory: mem.agreed ? mem : { ...mem, agreed: true } }
  if (!mem.agreed) return { hint: null, memory: mem }
  if (cfg.mode === 'auto') return { flip: want, hint: null, memory: mem }
  return { hint: want, memory: mem }
}

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The line a session is told: where its news goes now. */
export function presenceLine(p: Presence): string {
  const at = p.since ? ` (since ${clock(p.since)})` : ''
  return p.state === 'away'
    ? `[agent-board] The user is away from the computer${at}. Anything they need to see or answer (a result, a question, a blocker) also goes where they read it away from the computer, if this session has a way (Telegram or another messenger); the board alone waits unseen.`
    : `[agent-board] The user is at the computer${at}: the board and this terminal are enough; no need to send things elsewhere (Telegram and the like).`
}

/** The brief's part on presence, for a setup that turned it on. */
export function presenceBrief(p: Presence): string {
  return [
    '- Presence: the board knows whether the user is at the computer or away, and a line in this context says when it changes. board presence prints it.',
    presenceLine(p),
  ].join('\n')
}
