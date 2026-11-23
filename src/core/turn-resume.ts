// Continue after a crash or reboot (#633): pure rules for tracking mid-turn Claude sessions,
// reading the setting, and deciding when a session recovered after a restart gets its single
// "continue" reminder, when it waits, and when it is skipped with a reason.
import type { AgentStatus, Item, TurnMark } from './types.ts'

export const TURN_RESUME_DEFAULT_WAIT_MS = 5 * 60_000
export const TURN_RESUME_MIN_WAIT_MS = 10_000
export const TURN_RESUME_MAX_WAIT_MS = 60 * 60_000
export const TURN_RESUME_KIND = 'turn-resume'
export const TURN_RESUME_TEXT = 'the computer restarted in the middle of your turn; continue where you stopped'

export interface TurnResumeConfig {
  on: boolean
  waitMs: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clampWait = (ms: number): number =>
  Math.min(TURN_RESUME_MAX_WAIT_MS, Math.max(TURN_RESUME_MIN_WAIT_MS, Math.round(ms)))

/**
 * Config for turn-resume (`turnResume` in config.json): on by default (`undefined`, `null`, `true`),
 * off when `false` or `{ on: false }`. Optional `waitSec` or `waitMin` overrides the recovery window.
 */
export function turnResumeConfig(raw: unknown): TurnResumeConfig {
  if (raw === false) return { on: false, waitMs: TURN_RESUME_DEFAULT_WAIT_MS }
  if (raw === undefined || raw === null || raw === true) return { on: true, waitMs: TURN_RESUME_DEFAULT_WAIT_MS }
  if (!isRecord(raw)) return { on: true, waitMs: TURN_RESUME_DEFAULT_WAIT_MS }
  const on = raw.on !== false
  let waitMs = TURN_RESUME_DEFAULT_WAIT_MS
  if (typeof raw.waitSec === 'number' && Number.isFinite(raw.waitSec) && raw.waitSec > 0) {
    waitMs = clampWait(raw.waitSec * 1000)
  } else if (typeof raw.waitMin === 'number' && Number.isFinite(raw.waitMin) && raw.waitMin > 0) {
    waitMs = clampWait(raw.waitMin * 60_000)
  }
  return { on, waitMs }
}

/** Parse and validate a `midTurn` mark stored on a card; null when missing or malformed. */
export function parseTurnMark(raw: unknown): TurnMark | null {
  if (!isRecord(raw)) return null
  const session = typeof raw.session === 'string' ? raw.session.trim() : ''
  const startedAt = raw.startedAt
  if (!session || typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return null
  const pane = typeof raw.pane === 'string' && raw.pane.trim() ? raw.pane.trim() : undefined
  const processStartedAt =
    typeof raw.processStartedAt === 'number' && Number.isFinite(raw.processStartedAt) && raw.processStartedAt > 0
      ? raw.processStartedAt
      : undefined
  return {
    session,
    startedAt,
    ...(pane !== undefined && { pane }),
    ...(processStartedAt !== undefined && { processStartedAt }),
  }
}

/** Whether two turn marks carry identical fields. */
export function sameTurnMark(a: TurnMark | null, b: TurnMark | null): boolean {
  if (!a || !b) return a === b
  return (
    a.session === b.session &&
    a.startedAt === b.startedAt &&
    a.pane === b.pane &&
    a.processStartedAt === b.processStartedAt
  )
}

/**
 * Only local, awake Claude Code sessions with a real session id and pane participate.
 * Leaves pi, codex, agy, pane-<id> sessions, sleepers, MokuPilot day/call, and remote node items untouched.
 */
export function isTurnResumeEligible(
  item: Pick<Item, 'agent' | 'session' | 'pane' | 'sleeping' | 'day' | 'call' | 'device'>,
): boolean {
  return (
    item.agent === 'claude' &&
    typeof item.session === 'string' &&
    item.session.length > 0 &&
    typeof item.pane === 'string' &&
    item.pane.length > 0 &&
    !item.sleeping &&
    !item.day &&
    !item.call &&
    !item.device
  )
}

/** Whether herdr reports the session as waiting idle at a prompt. */
export const isIdleStatus = (status: AgentStatus): boolean => status === 'idle' || status === 'done'

export interface PendingMark {
  key: string
  mark: TurnMark
  name?: string
}

export type SkipReason = 'different-session' | 'timeout' | 'asleep' | 'same-process' | 'ineligible'

export type RecoveryDecision =
  | { action: 'wait' }
  | { action: 'resume'; item: Item }
  | { action: 'already-working'; item: Item; reason: 'already-working'; detail: string }
  | { action: 'skip'; reason: SkipReason; detail: string }

/**
 * Decide what to do with a `midTurn` mark left from before a board/herdr/computer restart:
 * - Same session back and idle (and not the exact same Claude process that already held the turn): resume once.
 * - Same session already working: keep tracking as active without sending a duplicate continue.
 * - Same session asleep or no longer eligible: skip with reason.
 * - Same Claude process finished the turn during a brief board-only reload (`processStartedAt === since`): skip.
 * - Different session or agent kind back in the same pane/key: skip with reason.
 * - Session missing or still blocked/unknown past `waitMs`: skip with timeout reason.
 */
export function evaluatePending(
  pending: PendingMark,
  items: readonly Item[],
  now: number,
  recoveryStartedAt: number,
  waitMs: number,
): RecoveryDecision {
  const match = items.find(i => i.session === pending.mark.session)
  if (match) {
    if (match.sleeping) return { action: 'skip', reason: 'asleep', detail: 'session is asleep' }
    if (!isTurnResumeEligible(match)) {
      return {
        action: 'skip',
        reason: 'ineligible',
        detail: `session is no longer an eligible Claude pane (${match.agent ?? 'unknown'})`,
      }
    }
    if (match.status === 'working') {
      return { action: 'already-working', item: match, reason: 'already-working', detail: 'session is already working' }
    }
    if (isIdleStatus(match.status)) {
      if (
        pending.mark.processStartedAt !== undefined &&
        typeof match.since === 'number' &&
        match.since > 0 &&
        match.since === pending.mark.processStartedAt
      ) {
        return {
          action: 'skip',
          reason: 'same-process',
          detail: 'turn ended in the same Claude process without a restart',
        }
      }
      return { action: 'resume', item: match }
    }
    if (now - recoveryStartedAt >= waitMs) {
      return {
        action: 'skip',
        reason: 'timeout',
        detail:
          match.status === 'blocked' ? 'still blocked after restart window' : 'still starting after restart window',
      }
    }
    return { action: 'wait' }
  }

  const byKey = items.find(i => i.key === pending.key && i.session && i.session !== pending.mark.session)
  if (byKey) {
    return {
      action: 'skip',
      reason: 'different-session',
      detail: `card now holds another session (${byKey.session})`,
    }
  }

  if (pending.mark.pane) {
    const inPane = items.find(i => !i.sleeping && i.pane === pending.mark.pane)
    if (inPane && inPane.agent !== 'claude') {
      return {
        action: 'skip',
        reason: 'different-session',
        detail: `pane ${pending.mark.pane} now runs ${inPane.agent ?? 'another agent'}`,
      }
    }
    if (inPane?.session && inPane.session !== pending.mark.session) {
      return {
        action: 'skip',
        reason: 'different-session',
        detail: `pane ${pending.mark.pane} came back with another session (${inPane.session})`,
      }
    }
  }

  if (now - recoveryStartedAt >= waitMs) {
    return {
      action: 'skip',
      reason: 'timeout',
      detail: `session ${pending.mark.session} did not come back within ${Math.round(waitMs / 1000)}s`,
    }
  }
  return { action: 'wait' }
}
