// The account's usage windows as the board shows them, parsed from the usagebar statusLine cache
// (claude-limits-latest.json). Only known numeric fields leave; nothing is invented.

export type LimitWindow = { minutes: number; usedPercentage: number; resetsAt: number | null; expired: boolean }
export type Limits = {
  available: boolean
  stale?: boolean
  windows?: LimitWindow[]
  ageMs?: number
  observedAt: number | null
  source: string
  sessionAccountVerified: boolean
}

const SOURCE = 'usagebar default-profile statusLine cache'
const pct = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

/** `raw` is the parsed cache file. Bad, future (more than 5 s ahead) or out-of-range data: not available. */
export function parseLimits(raw: unknown, now: number): Limits {
  const unknown: Limits = { available: false, observedAt: null, source: SOURCE, sessionAccountVerified: false }
  const data = record(raw)
  if (!data) return unknown
  const at = data.fetchedAtMs
  if (!positive(at) || at > now + 5000) return unknown
  const windows: LimitWindow[] = []
  for (const [key, minutes] of [
    ['fiveHour', 300],
    ['sevenDay', 10080],
  ] as const) {
    const value = record(data[key])
    if (!value || !pct(value.usedPercentage)) continue
    const resetsAt = positive(value.resetsAt) ? value.resetsAt * 1000 : null
    windows.push({
      minutes,
      usedPercentage: value.usedPercentage,
      resetsAt,
      expired: resetsAt !== null && resetsAt <= now,
    })
  }
  if (!windows.length) return unknown
  return {
    ...unknown,
    available: true,
    observedAt: at,
    ageMs: Math.max(0, now - at),
    stale: now - at > 300000 || windows.some(w => w.expired),
    windows,
  }
}
