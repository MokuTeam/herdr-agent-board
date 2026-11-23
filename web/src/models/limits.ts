// Claude's usage windows as the toolbar pill and its popover show them, from the payload's `limits`,
// or with two or more profiles shown, from each shown profile's.
import type { Translator } from '../../../src/core/types.ts'
import type { BoardProfile } from '../api/client.ts'

export type LimitSource = 'usagebar' | 'statusline' | 'unknown'
/** A usage window that passed the checks (the reading's own object, other fields untouched). */
export type LimitReading = { minutes: number; usedPercentage: number; resetsAt?: number | null }
export interface LimitInfo {
  windows: LimitReading[]
  observedAt: number | null
  source: LimitSource
  stale: boolean
}

/** An Antigravity (Gemini) quota window (#647) that passed the checks. */
export interface AgyLimitReading {
  id: string
  label: string
  minutes: number | null
  usedPercentage: number
  resetsAt?: number | null
}

export interface AgyLimitInfo {
  windows: AgyLimitReading[]
  observedAt: number | null
  source: 'statusline' | 'unknown'
  planTier: string | null
  stale: boolean
  recent: boolean
}

export const AGY_LIMIT_COLOR = '#4285F4'
export const CLAUDE_LIMIT_COLOR = '#D97757'

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields => (typeof value === 'object' && value !== null ? { ...value } : {})

const isReading = (w: unknown): w is LimitReading => {
  if (typeof w !== 'object' || w === null) return false
  const { minutes, usedPercentage } = fields(w)
  return (
    (minutes === 300 || minutes === 10080) &&
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    usedPercentage >= 0 &&
    usedPercentage <= 100
  )
}

// Percentages are consumption, never remaining allowance. Missing readings do
// not become zero; a stopped connection cannot make an old report look live.
export function limitInfo(limits: unknown, { connected = true, now = Date.now() } = {}): LimitInfo {
  const l = fields(limits)
  const windows = (Array.isArray(l.windows) ? l.windows : []).filter(isReading)
  const at = l.observedAt
  const observedAt = typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now + 60_000 ? at : null
  const source: LimitSource = l.source === 'usagebar' || l.source === 'statusline' ? l.source : 'unknown'
  return {
    windows,
    observedAt,
    source,
    stale: !connected || !!l.stale || !observedAt || now - observedAt > 30 * 60_000,
  }
}

const isAgyReading = (w: unknown): w is AgyLimitReading => {
  if (typeof w !== 'object' || w === null) return false
  const { id, label, minutes, usedPercentage } = fields(w)
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof label === 'string' &&
    label.length > 0 &&
    (minutes === null ||
      minutes === undefined ||
      (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0)) &&
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    usedPercentage >= 0 &&
    usedPercentage <= 100
  )
}

/** Antigravity (Gemini) usage reading (#647); null when `agyLimits` is omitted (agy not installed). */
export function agyLimitInfo(agyLimits: unknown, { connected = true, now = Date.now() } = {}): AgyLimitInfo | null {
  if (agyLimits === undefined) return null
  const l = fields(agyLimits)
  const windows = (Array.isArray(l.windows) ? l.windows : [])
    .filter(isAgyReading)
    .map(w => ({ ...w, minutes: typeof w.minutes === 'number' ? w.minutes : null }))
    .filter(w => !(typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt <= now))
  const at = l.observedAt
  const observedAt = typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now + 60_000 ? at : null
  const source: AgyLimitInfo['source'] = l.source === 'statusline' ? 'statusline' : 'unknown'
  const planTier = typeof l.planTier === 'string' && l.planTier.trim() ? l.planTier.trim() : null
  const stale = !connected || !!l.stale || !observedAt || now - observedAt > 30 * 60_000
  return {
    windows,
    observedAt,
    source,
    planTier,
    stale,
    recent: windows.length > 0 && !stale,
  }
}

/** A shown profile's usage: `recent` when it has windows and they are not stale. */
export interface ProfileUsage {
  id: string
  title: string
  color: string
  lim: LimitInfo
  recent: boolean
}

/**
 * Each shown profile's usage, in the list's order; null with fewer than two shown, where the pill
 * and the popover show the board's own usage, as before profiles.
 */
export function profileUsage(
  profiles: BoardProfile[] | undefined,
  { connected, now = Date.now() }: { connected: boolean; now?: number },
): ProfileUsage[] | null {
  const shown = (profiles ?? []).filter(p => !p.hidden)
  if (shown.length < 2) return null
  return shown.map(p => {
    const lim = limitInfo(p.limits, { connected, now })
    return { id: p.id, title: p.title, color: p.color, lim, recent: lim.windows.length > 0 && !lim.stale }
  })
}

/**
 * Where a window is heading at the pace it has averaged since it started (its reset minus its
 * length): `out` when that pace uses it up before the reset, at `at`; `lasts` when it does not, or
 * misses the reset by under a minute. Null while the reading cannot tell: no reading time, no reset
 * time, a reading from before the window started (it has reset since), already used up, the first
 * tenth of the window, where an average is noise, or a run-out already past at `now` (the reading
 * aged while the session sat at the limit).
 */
export type Forecast = { kind: 'out'; at: number; resetsAt: number } | { kind: 'lasts'; resetsAt: number }

export function forecast(w: LimitReading, observedAt: number | null, now = Date.now()): Forecast | null {
  const { resetsAt } = w
  if (observedAt === null || typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  const length = w.minutes * 60_000
  if (!Number.isFinite(length) || length <= 0) return null
  const start = resetsAt - length
  const elapsed = observedAt - start
  if (elapsed < length / 10 || elapsed > length || w.usedPercentage >= 100) return null
  if (w.usedPercentage <= 0) return { kind: 'lasts', resetsAt }
  const at = start + (elapsed * 100) / w.usedPercentage
  if (resetsAt - at < 60_000) return { kind: 'lasts', resetsAt }
  return at > now ? { kind: 'out', at, resetsAt } : null
}

/** "5h" or "7d". */
export const windowLabel = (w: LimitReading, t: Translator): string => t(w.minutes === 300 ? 'limits.5h' : 'limits.7d')

/** Localized label for an Antigravity window ("5h"/"7d" localized when exact, else its bucket label). */
export function agyWindowLabel(w: AgyLimitReading, t: Translator): string {
  if (w.label === '5h' && w.minutes === 300) return t('limits.5h')
  if (w.label === '7d' && w.minutes === 10080) return t('limits.7d')
  return w.label
}

/** The pill's color for a window: red from 90 %, orange from 70 %. */
export const heat = (usedPercentage: number): 'hot' | 'warm' | '' =>
  usedPercentage >= 90 ? 'hot' : usedPercentage >= 70 ? 'warm' : ''

type Box = { left: number; top: number; bottom: number }
type Size = { width: number; height: number }

/** Where the popover goes: under the pill when it fits, else above it, always 8 px inside the window. */
export function popoverPosition(pill: Box, pop: Size, viewport: Size): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(pill.left, viewport.width - pop.width - 8)),
    top: pill.bottom + pop.height + 8 <= viewport.height ? pill.bottom + 8 : Math.max(8, pill.top - pop.height - 8),
  }
}
