// Claude's usage windows as the toolbar pill and its popover show them, from the payload's `limits`,
// or with two or more profiles shown, from each shown profile's.
import type { Translator } from '../../../src/core/types.ts'
import type { BoardProfile } from '../api/client.ts'

export type LimitSource = 'usagebar' | 'statusline' | 'unknown'
/** A usage window that passed the checks (the reading's own object, other fields untouched). */
export type LimitReading = { minutes: number; usedPercentage: number }
export interface LimitInfo {
  windows: LimitReading[]
  observedAt: number | null
  source: LimitSource
  stale: boolean
}

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
 * length): `out` when that pace uses it up before the reset, at `at`; `lasts` when it does not.
 * Null while the reading cannot tell: no reset time, already used up, or the first tenth of the
 * window, where an average is noise.
 */
export type Forecast = { kind: 'out'; at: number; resetsAt: number } | { kind: 'lasts'; resetsAt: number }

export function forecast(w: LimitReading, observedAt: number | null): Forecast | null {
  const { resetsAt } = fields(w)
  if (observedAt === null || typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  const length = w.minutes * 60_000
  const start = resetsAt - length
  const elapsed = observedAt - start
  if (elapsed < length / 10 || elapsed > length || w.usedPercentage >= 100) return null
  if (w.usedPercentage <= 0) return { kind: 'lasts', resetsAt }
  const at = start + (elapsed * 100) / w.usedPercentage
  return at < resetsAt ? { kind: 'out', at, resetsAt } : { kind: 'lasts', resetsAt }
}

/** "5h" or "7d". */
export const windowLabel = (w: LimitReading, t: Translator): string => t(w.minutes === 300 ? 'limits.5h' : 'limits.7d')

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
