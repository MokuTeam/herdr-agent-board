// Antigravity (Gemini) usage windows (#647), parsed from Antigravity CLI's statusLine JSON payload
// (agy-limits-latest.json, written by src/entrypoints/agy-statusline.ts without any model calls).
// Only known numeric fields leave; missing or unreadable readings stay unknown, never invented.
import { hasUnprintable } from './team.ts'

export interface AgyLimitWindow {
  /** Quota bucket id as Antigravity CLI reports it (e.g. "gemini-5h", "gemini-weekly", "gemini-pro"). */
  id: string
  /** Short display label derived from the bucket id (e.g. "5h", "7d", "Pro"). */
  label: string
  /** Known window duration in minutes (300 for 5h, 10080 for 7d), or null when not known. */
  minutes: number | null
  /** Consumption percentage (0..100), derived from 1 - remaining_fraction. */
  usedPercentage: number
  /** Reset time as epoch milliseconds, or null when not reported. */
  resetsAt: number | null
  expired: boolean
}

/** What agy-statusline.ts saves to agy-limits-latest.json. */
export interface AgyUsageSnapshot {
  fetchedAtMs: number
  planTier?: string
  windows: Omit<AgyLimitWindow, 'expired'>[]
}

/** Parsed local reading, matching core/limits.ts Limits discipline. */
export interface AgyLimits {
  available: boolean
  stale?: boolean
  planTier?: string | null
  windows?: AgyLimitWindow[]
  ageMs?: number
  observedAt: number | null
  source: string
}

/** Antigravity usage windows as BoardPayload and NodeStatus carry them. */
export interface BoardAgyLimits {
  source: 'statusline'
  observedAt: number | null
  stale: boolean
  planTier?: string | null
  windows: AgyLimitWindow[]
}

const SOURCE = 'antigravity statusLine cache'
const MAX_WINDOWS = 16
const STALE_MS = 30 * 60_000

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const pct = (v: unknown): v is number => num(v) && v >= 0 && v <= 100
const positive = (v: unknown): v is number => num(v) && v > 0
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > max || hasUnprintable(s)) return null
  return s
}

/**
 * Derive a short display label and known window length (minutes) from an Antigravity quota bucket id:
 * e.g. "gemini-5h" -> { label: "5h", minutes: 300 }, "gemini-weekly" -> { label: "7d", minutes: 10080 },
 * "gemini-pro-weekly" -> { label: "Pro 7d", minutes: 10080 }, "gemini-flash" -> { label: "Flash", minutes: null }.
 */
export function agyWindowMeta(id: string): { label: string; minutes: number | null } {
  const lower = id.toLowerCase()
  const is5h = /(?:^|[-_])5h(?:$|[-_])/.test(lower)
  const is7d = /(?:^|[-_])(?:weekly|7d|week)(?:$|[-_])/.test(lower)
  const minutes = is5h ? 300 : is7d ? 10080 : null

  const tokens = id
    .split(/[-_]+/)
    .map(t => t.trim())
    .filter(Boolean)
  // Drop a leading "gemini" prefix when another token describes the group or window.
  const trimmed = tokens.length > 1 && tokens[0]?.toLowerCase() === 'gemini' ? tokens.slice(1) : tokens
  const parts = trimmed.map(tok => {
    const t = tok.toLowerCase()
    if (t === '5h') return '5h'
    if (t === 'weekly' || t === 'week' || t === '7d') return '7d'
    if (t === 'gpt') return 'GPT'
    return `${tok[0]?.toUpperCase() ?? ''}${tok.slice(1)}`
  })
  return { label: parts.join(' ') || id, minutes }
}

function sortWindows<T extends { id: string; minutes: number | null }>(windows: T[]): T[] {
  return [...windows].sort((a, b) => {
    const am = a.minutes ?? Number.POSITIVE_INFINITY
    const bm = b.minutes ?? Number.POSITIVE_INFINITY
    return am - bm || a.id.localeCompare(b.id)
  })
}

/**
 * Extract quota windows from Antigravity CLI's statusLine JSON stdin payload.
 * Returns null when no usable quota bucket is present (never invents percentages).
 */
export function digestAgyStatusLine(input: unknown, now = Date.now()): AgyUsageSnapshot | null {
  const root = record(input)
  const quota = record(root?.quota)
  if (!quota) return null
  const windows: Omit<AgyLimitWindow, 'expired'>[] = []
  const seen = new Set<string>()
  for (const [rawId, rawBucket] of Object.entries(quota)) {
    if (windows.length >= MAX_WINDOWS) break
    const id = cleanText(rawId, 64)
    const bucket = record(rawBucket)
    if (!id || seen.has(id) || !bucket || bucket.disabled === true) continue
    const frac = bucket.remaining_fraction
    if (!num(frac) || frac < 0 || frac > 1) continue
    seen.add(id)
    const usedPercentage = Math.min(100, Math.max(0, Math.round((1 - frac) * 10000) / 100))
    let resetsAt: number | null = null
    if (typeof bucket.reset_time === 'string' && bucket.reset_time.trim()) {
      const parsed = Date.parse(bucket.reset_time)
      if (positive(parsed)) resetsAt = parsed
    }
    if (resetsAt === null && positive(bucket.reset_in_seconds)) {
      resetsAt = Math.round(now + bucket.reset_in_seconds * 1000)
    }
    const { label, minutes } = agyWindowMeta(id)
    windows.push({ id, label, minutes, usedPercentage, resetsAt })
  }
  if (!windows.length) return null
  const planTier = cleanText(root?.plan_tier, 40)
  return {
    fetchedAtMs: now,
    ...(planTier && { planTier }),
    windows: sortWindows(windows),
  }
}

function parseWindow(raw: unknown, now: number): AgyLimitWindow | null {
  const w = record(raw)
  if (!w) return null
  const id = cleanText(w.id, 64)
  if (!id || !pct(w.usedPercentage)) return null
  const fallback = agyWindowMeta(id)
  const label = cleanText(w.label, 64) ?? fallback.label
  const minutes = w.minutes === null || w.minutes === undefined ? null : positive(w.minutes) ? w.minutes : null
  const resetsAt = positive(w.resetsAt) ? w.resetsAt : null
  return {
    id,
    label,
    minutes,
    usedPercentage: w.usedPercentage,
    resetsAt,
    expired: resetsAt !== null && resetsAt <= now,
  }
}

/** Parse agy-limits-latest.json; bad, future (> 5 s ahead) or empty data stays unavailable. */
export function parseAgyLimits(raw: unknown, now = Date.now()): AgyLimits {
  const unknown: AgyLimits = { available: false, observedAt: null, source: SOURCE }
  const data = record(raw)
  if (!data) return unknown
  const at = data.fetchedAtMs
  if (!positive(at) || at > now + 5000) return unknown
  if (!Array.isArray(data.windows)) return unknown
  const windows: AgyLimitWindow[] = []
  const seen = new Set<string>()
  for (const entry of data.windows) {
    if (windows.length >= MAX_WINDOWS) break
    const parsed = parseWindow(entry, now)
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id)
      windows.push(parsed)
    }
  }
  if (!windows.length) return unknown
  const planTier = cleanText(data.planTier, 40)
  return {
    ...unknown,
    available: true,
    observedAt: at,
    ageMs: Math.max(0, now - at),
    stale: now - at > 300_000 || windows.some(w => w.expired),
    ...(planTier && { planTier }),
    windows: sortWindows(windows),
  }
}

/** Convert a local parsed reading into BoardAgyLimits, dropping windows already past their reset. */
export function boardAgyLimitsFrom(limits: AgyLimits, now = Date.now()): BoardAgyLimits | null {
  if (!limits.available || !limits.observedAt) return null
  const windows = (limits.windows ?? []).filter(w => !w.expired && !(w.resetsAt !== null && w.resetsAt <= now))
  if (!windows.length) return null
  return {
    source: 'statusline',
    observedAt: limits.observedAt,
    stale: now - limits.observedAt > STALE_MS,
    ...(limits.planTier && { planTier: limits.planTier }),
    windows,
  }
}

/** Validate a BoardAgyLimits object arriving over the wire (e.g. from a node's NodeStatus). */
export function boardAgyLimitsOf(raw: unknown, now = Date.now()): BoardAgyLimits | null {
  const data = record(raw)
  if (data?.source !== 'statusline') return null
  const at = data.observedAt
  if (!positive(at) || at > now + 60_000) return null
  if (!Array.isArray(data.windows)) return null
  const windows: AgyLimitWindow[] = []
  const seen = new Set<string>()
  for (const entry of data.windows) {
    if (windows.length >= MAX_WINDOWS) break
    const parsed = parseWindow(entry, now)
    if (parsed && !parsed.expired && !seen.has(parsed.id)) {
      seen.add(parsed.id)
      windows.push(parsed)
    }
  }
  if (!windows.length) return null
  const planTier = cleanText(data.planTier, 40)
  return {
    source: 'statusline',
    observedAt: at,
    stale: data.stale === true || now - at > STALE_MS,
    ...(planTier && { planTier }),
    windows: sortWindows(windows),
  }
}

/**
 * Combine local and remote-node Antigravity usage readings:
 * - Returns `undefined` when every input is `undefined` (agy is not installed anywhere -> omitted).
 * - Returns the freshest non-expired reading (highest `observedAt`) when at least one has windows.
 * - Returns `null` when agy is installed somewhere but no readable/non-expired reading exists yet.
 */
export function pickAgyLimits(
  readings: readonly (BoardAgyLimits | null | undefined)[],
  now = Date.now(),
): BoardAgyLimits | null | undefined {
  let installed = false
  let best: BoardAgyLimits | null = null
  for (const r of readings) {
    if (r === undefined) continue
    installed = true
    if (!r?.observedAt) continue
    const windows = r.windows.filter(w => !(w.resetsAt !== null && w.resetsAt <= now))
    if (!windows.length) continue
    const candidate: BoardAgyLimits = {
      source: r.source,
      observedAt: r.observedAt,
      stale: r.stale || now - r.observedAt > STALE_MS,
      ...(r.planTier && { planTier: r.planTier }),
      windows,
    }
    if (!best || (candidate.observedAt ?? 0) > (best.observedAt ?? 0)) best = candidate
  }
  if (!installed) return undefined
  return best
}
