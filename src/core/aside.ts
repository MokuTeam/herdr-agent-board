// A side question to a session (/btw from the board): asked of a one-off copy of its conversation,
// so the answer knows what the session knows while the session's own conversation gets nothing.
// Claude Code's own /btw answers in an overlay of the terminal and does not run under -p ("isn't
// available in this environment"), so the board cannot read its answer reliably. The board runs
//   claude -p --resume <id> --fork-session --no-session-persistence --tools "" ...
// in the session's folder instead: a fork that is never written to disk, with no tools (it
// answers from the conversation, as /btw does), no MCP servers and no hooks, the question on
// stdin, the answer and what it cost as JSON on stdout. It works while the session is busy or
// asleep: it needs only the session's transcript. services/aside.ts runs it.

/** The longest question the board passes on. */
export const ASIDE_MAX = 4000

/** Claude's arguments for a side question to `session` (the question goes on stdin). */
export function asideArgs(session: string): string[] {
  return [
    '-p',
    '--resume',
    session,
    '--fork-session',
    '--no-session-persistence',
    // No tools: it answers from what the conversation holds, and cannot act.
    '--tools',
    '',
    '--strict-mcp-config',
    // Not a session of the board's: no card, no context, nothing ingested or notified.
    '--settings',
    '{"disableAllHooks":true}',
    '--max-turns',
    '1',
    '--output-format',
    'json',
  ]
}

/** An answer, and what it cost: a request of its own, the whole conversation as its context. */
export interface AsideAnswer {
  text: string
  /** Claude Code's figure at API prices (`total_cost_usd`); null when it gave none. */
  costUsd: number | null
  /** The context it read (input, cache written and read), the part read from the cache, the answer's. */
  tokens: { context: number; cached: number; output: number }
  ms: number
}

export type AsideResult = { ok: true; answer: AsideAnswer } | { ok: false; error: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * What `claude -p --output-format json` printed: the answer, or why there is none. Lines before
 * the JSON (a warning) are skipped; `fallback` is said when nothing can be read.
 */
export function parseAside(stdout: string, fallback = 'no answer'): AsideResult {
  const start = stdout.indexOf('{')
  let o: unknown = null
  try {
    o = start >= 0 ? JSON.parse(stdout.slice(start)) : null
  } catch {}
  if (!isRecord(o)) return { ok: false, error: fallback }
  const text = typeof o.result === 'string' ? o.result.trim() : ''
  if (o.is_error === true || (typeof o.subtype === 'string' && o.subtype !== 'success') || !text)
    return { ok: false, error: text || (typeof o.subtype === 'string' ? o.subtype : fallback) }
  const u = isRecord(o.usage) ? o.usage : {}
  const cached = num(u.cache_read_input_tokens)
  return {
    ok: true,
    answer: {
      text,
      costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
      tokens: {
        context: num(u.input_tokens) + num(u.cache_creation_input_tokens) + cached,
        cached,
        output: num(u.output_tokens),
      },
      ms: num(o.duration_ms),
    },
  }
}
