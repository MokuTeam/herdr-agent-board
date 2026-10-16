// What the board keeps from Claude Code's status line input, and the line it prints back.
// The files and the process around it live in src/statusline.mjs.

export type UsageWindow = { usedPercentage: number; resetsAt: number | null }
export type UsageSnapshot = { fetchedAtMs: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
export type ContextFill = { usedPercentage: number | null; size: number | null; tokens: number | null; at: number }
export type StatusDigest = { usage: UsageSnapshot | null; context: ContextFill | null; session: string | null }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const pct = (v: unknown): v is number => num(v) && v >= 0 && v <= 100
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
const count = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** What the board keeps from one status line input: { usage, context, session }. */
export function digest(input: unknown, now = Date.now()): StatusDigest {
  const root = obj(input)
  const usage: UsageSnapshot = { fetchedAtMs: now }
  for (const [from, to] of [
    ['five_hour', 'fiveHour'],
    ['seven_day', 'sevenDay'],
  ] as const) {
    const w = obj(obj(root?.rate_limits)?.[from])
    if (w && pct(w.used_percentage))
      usage[to] = { usedPercentage: w.used_percentage, resetsAt: num(w.resets_at) ? w.resets_at : null }
  }
  const c = obj(root?.context_window)
  const u = obj(c?.current_usage)
  const tokens = u
    ? count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens)
    : null
  const context: ContextFill | null =
    c && (pct(c.used_percentage) || tokens)
      ? {
          usedPercentage: pct(c.used_percentage) ? c.used_percentage : null,
          size: num(c.context_window_size) ? c.context_window_size : null,
          tokens,
          at: now,
        }
      : null
  return {
    usage: usage.fiveHour || usage.sevenDay ? usage : null,
    context,
    session: typeof root?.session_id === 'string' && root.session_id ? root.session_id : null,
  }
}

/** The line under the prompt: dim labels, the numbers yellow from 70% and red from 90%. */
export function statusText(d: StatusDigest): string {
  const tone = (p: number) => (p >= 90 ? '\x1b[31m' : p >= 70 ? '\x1b[33m' : '\x1b[0m')
  const part = (label: string, p: number) => `\x1b[2m${label}\x1b[0m ${tone(p)}${Math.round(p)}%\x1b[0m`
  const parts: string[] = []
  if (d.context?.usedPercentage != null) parts.push(part('ctx', d.context.usedPercentage))
  else if (d.context?.tokens) parts.push(`\x1b[2mctx\x1b[0m ${Math.round(d.context.tokens / 1000)}k`)
  if (d.usage?.fiveHour) parts.push(part('5h', d.usage.fiveHour.usedPercentage))
  if (d.usage?.sevenDay) parts.push(part('7d', d.usage.sevenDay.usedPercentage))
  return parts.join('\x1b[2m · \x1b[0m')
}
