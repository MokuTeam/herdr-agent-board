// The board's side of presence (core/presence.ts): the switch, the view the page and the phone
// read, and detection. While config.json's presence mode is 'auto' or 'suggest' the board asks
// the computer every half minute how long it has gone without input and whether its screen is
// locked (adapters/idle.ts), and a request from the board's own page counts as input too; each
// answer goes through presenceStep. With presence off, or its mode 'off', nothing is asked and
// nothing runs. Nothing is ever sent to a session: they read the state from the hooks.
import { observe as observeComputer } from '../adapters/idle.ts'
import {
  clearPresence,
  currentPresence,
  markSessions,
  setPresence,
  unmarkSessions,
} from '../adapters/presence-store.ts'
import {
  type Observation,
  type Presence,
  type PresenceConfig,
  type PresenceSource,
  type PresenceState,
  type PresenceView,
  presenceConfig,
  presenceStep,
  type StepMemory,
} from '../core/presence.ts'
import type { Config } from '../core/types.ts'

export interface PresenceService {
  /** The view, null while presence is not on in config.json. */
  view(): PresenceView | null
  /** A switch by the user. */
  set(state: PresenceState, from: PresenceSource): { presence: Presence; changed: boolean }
  /** The board's page was used here: the user is at the computer. */
  touch(): void
  /** One detection step now (the timer's; tests call it). */
  tick(): Promise<void>
  /**
   * config.json changed: presence turned on marks the running sessions to hear it on their next
   * prompt; turned off forgets the state and unmarks them.
   */
  refresh(): void
  start(): void
  stop(): void
}

interface Options {
  cfg: Pick<Config, 'presence'>
  log: (line: string) => void
  /** The board changed: publish it. */
  onChange: () => void
  /** The sessions on the board (card keys). */
  sessions?: () => Iterable<string>
  observe?: () => Promise<Observation>
  now?: () => number
  intervalMs?: number
}

export const DETECT_INTERVAL_MS = 30_000

export function createPresence({
  cfg,
  log,
  onChange,
  sessions = () => [],
  observe = () => observeComputer(),
  now = Date.now,
  intervalMs = DETECT_INTERVAL_MS,
}: Options): PresenceService {
  let memory: StepMemory | null = null
  let hint: PresenceState | null = null
  let detects: boolean | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let busy = false
  let on: boolean | null = null

  const config = (): PresenceConfig | null => presenceConfig(cfg.presence)
  const detecting = (c: PresenceConfig | null): c is PresenceConfig => !!c && c.mode !== 'off'

  function apply(c: PresenceConfig, obs: Observation): void {
    const step = presenceStep(currentPresence(), obs, c, memory)
    memory = step.memory
    let changed = false
    if (step.flip) {
      const r = setPresence(step.flip, 'auto', 'auto', now())
      changed = r.changed
      if (changed) log(`presence: ${step.flip} (detected)`)
    }
    if (step.hint !== hint) {
      hint = step.hint
      changed = true
    }
    if (changed) onChange()
  }

  function refresh(): void {
    const now = !!config()
    if (now === on) return
    const was = on
    on = now
    if (now) markSessions(sessions())
    else if (was) {
      clearPresence()
      unmarkSessions(sessions())
      hint = null
      detects = null
      memory = null
    }
    if (was !== null) onChange()
  }

  async function tick(): Promise<void> {
    refresh()
    const c = config()
    if (!detecting(c)) {
      // Turned off: no offer stays on show.
      if (hint) {
        hint = null
        onChange()
      }
      return
    }
    if (busy) return
    busy = true
    try {
      const obs = await observe()
      const said = obs.idleSec !== null || obs.locked !== null
      if (said !== detects) {
        detects = said
        onChange()
      }
      apply(c, obs)
    } catch (err) {
      log(`presence: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }

  return {
    view() {
      const c = config()
      if (!c) return null
      return { ...currentPresence(), mode: c.mode, idleMinutes: c.idleMinutes, hint, detects }
    },
    set(state, from) {
      const r = setPresence(state, 'user', from, now())
      // The offer is answered either way.
      if (hint) hint = null
      if (r.changed) log(`presence: ${state} (${from})`)
      onChange()
      return r
    },
    touch() {
      const c = config()
      if (detecting(c)) apply(c, { idleSec: 0, locked: false })
    },
    tick,
    refresh,
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
    },
  }
}
