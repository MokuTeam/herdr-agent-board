// What the board keeps from Claude Code's status line input, and the line it prints back.
// The files and the process around it live in src/entrypoints/statusline.ts.

export type UsageWindow = { usedPercentage: number; resetsAt: number | null }
export type UsageSnapshot = { fetchedAtMs: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
export type ContextFill = {
  usedPercentage: number | null
  size: number | null
  tokens: number | null
  at: number
  /** The model the session runs, as the status line names it. */
  model?: string | null
}
export type StatusDigest = {
  usage: UsageSnapshot | null
  context: ContextFill | null
  session: string | null
  /** The model the session runs, as the status line names it. */
  model: string | null
  /**
   * The effort the session thinks with now (effort.level): a /effort changes it at once, and Claude
   * Code runs the status line again for it. null when the input has none (a model without effort,
   * an older Claude Code) or a malformed one.
   */
  effort: string | null
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const pct = (v: unknown): v is number => num(v) && v >= 0 && v <= 100
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
const count = (v: unknown): v is number => num(v) && v >= 0
/** An effort level as Claude Code names it (low … max), lower case; a level it adds later passes too. */
const level = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return /^[a-z][a-z-]{1,15}$/.test(s) ? s : null
}

/** What the board keeps from one status line input: { usage, context, session, model, effort }. */
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
  // Input context, cached parts included, output left out (as Claude Code's own percentage). A part
  // left out counts 0; one that is there and no count spoils the sum (it would disagree with the
  // percentage), and none of the three a count is no count at all, not a zero.
  const parts = u ? [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens] : []
  const given = parts.filter(v => v !== undefined)
  const tokens = given.length && given.every(count) ? (given as number[]).reduce((a, b) => a + b, 0) : null
  const context: ContextFill | null =
    c && (pct(c.used_percentage) || tokens != null)
      ? {
          usedPercentage: pct(c.used_percentage) ? c.used_percentage : null,
          size: num(c.context_window_size) && c.context_window_size > 0 ? c.context_window_size : null,
          tokens,
          at: now,
        }
      : null
  const m = obj(root?.model)
  const model =
    (typeof m?.display_name === 'string' && m.display_name.trim()) || (typeof m?.id === 'string' && m.id.trim()) || ''
  return {
    usage: usage.fiveHour || usage.sevenDay ? usage : null,
    context,
    session: typeof root?.session_id === 'string' && root.session_id ? root.session_id : null,
    model: model ? String(model).slice(0, 60) : null,
    effort: level(obj(root?.effort)?.level),
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
