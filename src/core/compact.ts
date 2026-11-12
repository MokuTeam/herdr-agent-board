// Auto-compact (#378): the board types /compact into a session once its context crosses a limit
// the owner set, so a session that runs for days (a monitor, a day orchestrator) does not grow to
// 600k before someone notices. Pure: the rules here decide, services/compactor.ts reads and types.
//
// The limit is a session's own (`compactAt` on its card: tokens, a share of the window, or "never")
// or else Settings' default (config.json `compact.at`), off in both places unless set. Claude Code's
// own auto-compact near the window's end stays as it is: this one runs earlier and on purpose.
//
// Once at the limit, never bit by bit: one /compact (the prompt cache is rebuilt once). A
// compaction that leaves the context at or above the limit (a large summary), or a /compact that no
// compaction followed, holds the session (`hold` on its run): no second /compact until its context
// is below the limit again (the owner's /compact, Claude's own, a /clear) or its limit changes.
import type { Card, Item } from './types.ts'

/** A limit: so many tokens, so many percent of the session's window, or never for this session. */
export type CompactLimit = { tokens: number } | { share: number } | 'never'

/** The smallest limit in tokens, and the range of a share: below them a session would compact on every turn. */
export const MIN_COMPACT_TOKENS = 10_000
export const MIN_COMPACT_SHARE = 5
export const MAX_COMPACT_SHARE = 95
/** The longest instructions for the summary, as typed after /compact. */
export const MAX_COMPACT_NOTE = 500

/**
 * A limit as the owner wrote it: `300k`, `1.2m`, `250000`, `60%`, `never` (a number is tokens).
 * Null for anything else, a limit below MIN_COMPACT_TOKENS, or a share outside 5 to 95 %.
 */
export function parseCompactLimit(v: unknown): CompactLimit | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= MIN_COMPACT_TOKENS ? { tokens: Math.round(v) } : null
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase().replace(/\s+/g, '').replace(',', '.')
  if (s === 'never') return 'never'
  const share = /^(\d+(?:\.\d+)?)%$/.exec(s)
  if (share) {
    const n = Number(share[1])
    return n >= MIN_COMPACT_SHARE && n <= MAX_COMPACT_SHARE ? { share: n } : null
  }
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s)
  if (!m) return null
  const n = Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1000 : 1)
  return n >= MIN_COMPACT_TOKENS && n <= 100_000_000 ? { tokens: Math.round(n) } : null
}

/** Tokens short: 950, 23k, 1.2M (the web board's helper-model.ts tokens, for the CLI and the log). */
export function shortTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/** A limit as the board writes it on a card and in config.json, and shows it: `300k`, `60%`, `never`. */
export function limitText(limit: CompactLimit): string {
  if (limit === 'never') return 'never'
  if ('share' in limit) return `${limit.share}%`
  return shortTokens(limit.tokens).toLowerCase()
}

/** Settings' default (config.json `compact`): `{ at, note }`, or a bare limit; off when it has none. */
export function compactConfig(v: unknown): { at: Exclude<CompactLimit, 'never'> | null; note: string } {
  const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { at: v }
  const at = parseCompactLimit(o.at)
  return { at: at === 'never' ? null : at, note: noteText(o.note) }
}

/** Settings' default limit as written (`300k`, `60%`), '' for off: what the page shows checked. */
export function compactDefaultText(v: unknown): string {
  const at = compactConfig(v).at
  return at ? limitText(at) : ''
}

/** Instructions for the summary as they go after /compact: one line, no control characters, at most MAX_COMPACT_NOTE. */
export function noteText(v: unknown): string {
  if (typeof v !== 'string') return ''
  // Control characters (a pasted line break, an escape) are spaces: the text goes into a terminal.
  const plain = Array.from(v, ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('')
  return plain.replace(/\s+/g, ' ').trim().slice(0, MAX_COMPACT_NOTE)
}

/** Where a session's limit comes from: its own card, Settings' default, its own "never", or nowhere. */
export type CompactSource = 'session' | 'default' | 'never' | 'off'

export interface CompactRule {
  /** The limit in force; null for none (off, or never). */
  limit: Exclude<CompactLimit, 'never'> | null
  source: CompactSource
  /** What the summary must keep: the session's own, else the default's. */
  note: string
}

/** The rule in force for a session: its own limit beats the default, its own "never" beats both. */
export function compactRule(
  card: Pick<Card, 'compactAt' | 'compactNote'> | null | undefined,
  cfg: unknown,
): CompactRule {
  const def = compactConfig(cfg)
  const own = parseCompactLimit(card?.compactAt)
  const note = noteText(card?.compactNote) || def.note
  if (own === 'never') return { limit: null, source: 'never', note }
  if (own) return { limit: own, source: 'session', note }
  return def.at ? { limit: def.at, source: 'default', note } : { limit: null, source: 'off', note }
}

/** The limit in tokens for a session's window: a share needs the window's size (the status line's). */
export function limitTokens(limit: CompactRule['limit'], windowSize: number | null | undefined): number | null {
  if (!limit) return null
  if ('tokens' in limit) return limit.tokens
  return windowSize && windowSize > 0 ? Math.round((windowSize * limit.share) / 100) : null
}

/**
 * The board's last /compact for a session, on its card (`compactRun`):
 *   sent    typed at `at` with the context at `from`, the limit `limit` (tokens, as `setting` gave it)
 *   done    the compaction came (`doneAt` when it ended): `to` is what it left, Claude Code's own
 *           count of the summary at first, then (`measured`) the context of the first request after
 *           it, which carries the system prompt and the tools too: what the session really has now
 *   failed  typed, but no compaction followed in time
 * `hold`: what it left is at or above the limit, or it failed: no second /compact until the context
 * is below the limit again or the session's limit changes.
 */
export interface CompactRun {
  state: 'sent' | 'done' | 'failed'
  at: number
  from: number
  limit: number
  setting: string
  to?: number
  doneAt?: number
  measured?: true
  hold?: true
}

export function runOf(v: unknown): CompactRun | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  const at = num(r.at)
  const from = num(r.from)
  const limit = num(r.limit)
  if (r.state !== 'sent' && r.state !== 'done' && r.state !== 'failed') return null
  if (at === undefined || from === undefined || limit === undefined) return null
  const to = num(r.to)
  const doneAt = num(r.doneAt)
  return {
    state: r.state,
    at,
    from,
    limit,
    setting: typeof r.setting === 'string' ? r.setting : '',
    ...(to !== undefined && { to }),
    ...(doneAt !== undefined && { doneAt }),
    ...(r.measured === true && { measured: true }),
    ...(r.hold === true && { hold: true }),
  }
}

/** A session's auto-compact as the board shows it (Item.compact, the sheet and `board compact`). */
export interface CompactView {
  /** Its own limit as written (`300k`, `60%`, `never`), '' for none: Settings' default applies. */
  own: string
  /** Its own instructions for the summary, '' for none. */
  note: string
  /** The limit in force as written, '' for none, and where it comes from. */
  limit: string
  source: CompactSource
  /** That limit in tokens for its window now; null when not known (a share without the window's size). */
  tokens: number | null
  /** The board's last /compact for it, null for none. */
  run: CompactRun | null
}

/**
 * A session's auto-compact for the board, or null when there is nothing to show: no limit of its
 * own, no instructions, no run, and Settings has no default (so a board that never set any sends
 * what it sent before).
 */
export function compactView(
  card: Card | null | undefined,
  cfg: unknown,
  windowSize: number | null | undefined,
): CompactView | null {
  const ownLimit = parseCompactLimit(card?.compactAt)
  const own = ownLimit ? limitText(ownLimit) : ''
  const note = noteText(card?.compactNote)
  const run = runOf(card?.compactRun)
  const rule = compactRule(card, cfg)
  if (!own && !note && !run && rule.source === 'off') return null
  return {
    own,
    note,
    limit: rule.limit ? limitText(rule.limit) : '',
    source: rule.source,
    tokens: limitTokens(rule.limit, windowSize),
    run,
  }
}

/** How long a typed /compact has for its compaction to show in the transcript: longer while the session works on it. */
export const SENT_IDLE_MS = 10 * 60_000
export const SENT_WORKING_MS = 30 * 60_000

/** A session as the compactor looks at it: the board's item. */
export type CompactItem = Pick<
  Item,
  'key' | 'session' | 'pane' | 'agent' | 'status' | 'sleeping' | 'attention' | 'context' | 'contextSize'
> &
  Partial<Pick<Item, 'day' | 'call'>>

/**
 * What to do for a session now:
 *   none     nothing (no limit, not over it, held, or a /compact on its way)
 *   wait     over its limit, but not free now (a turn, a dialog, a question, asleep): next time
 *   compact  type /compact now (`limit`: its limit in tokens)
 *   release  the hold goes: its context is below the limit, or its limit changed
 */
export type CompactStep =
  | { do: 'none' }
  | { do: 'wait'; why: string }
  | { do: 'compact'; limit: number; setting: string }
  | { do: 'release' }

/** Only Claude Code sessions in a pane of their own: a day session or a call agent has none to type in. */
export function compactable(item: CompactItem): boolean {
  return item.agent === 'claude' && !!item.pane && !!item.session && !item.day && !item.call
}

export function compactStep(item: CompactItem, rule: CompactRule, run: CompactRun | null): CompactStep {
  if (!compactable(item)) return { do: 'none' }
  // A /compact on its way, or one whose result is not measured yet: the compactor settles it
  // (settleRun, measureRun), nothing else is typed meanwhile.
  if (run?.state === 'sent' || pending(run)) return { do: 'none' }
  const limit = limitTokens(rule.limit, item.contextSize)
  const setting = rule.limit ? limitText(rule.limit) : ''
  const context = typeof item.context === 'number' ? item.context : null
  if (run?.hold) {
    // Below the limit again (any compaction, a /clear), another limit, or none: armed again.
    if (limit === null || run.setting !== setting || (context !== null && context < limit)) return { do: 'release' }
    return { do: 'none' }
  }
  if (limit === null || context === null || context < limit) return { do: 'none' }
  // Over the limit: only between turns, never into a dialog, a question waiting on the owner, or a sleeper.
  if (item.sleeping) return { do: 'wait', why: 'asleep' }
  if (item.status === 'working') return { do: 'wait', why: 'busy' }
  if (item.status === 'blocked' || item.attention === 'decision') return { do: 'wait', why: 'dialog' }
  if (item.attention === 'ask' || item.attention === 'question') return { do: 'wait', why: 'asked' }
  if (item.status !== 'idle' && item.status !== 'done') return { do: 'wait', why: item.status }
  return { do: 'compact', limit, setting }
}

/** A compaction the board made whose first request after it has not come yet: what it left is not known. */
export const pending = (run: CompactRun | null): boolean => run?.state === 'done' && !run.measured && !run.hold

/** What goes into the session's prompt: /compact, with the instructions for its summary when there are any. */
export const compactCommand = (note: string): string => (note ? `/compact ${note}` : '/compact')

/** A compaction a transcript recorded: when, and Claude Code's own counts before and after. */
export interface Compaction {
  at: number
  pre: number | null
  post: number | null
}

/**
 * The newest compaction in a transcript's lines at or after `since` (its compact_boundary line;
 * a subagent's own are not the session's), else null.
 */
export function compactionSince(lines: readonly string[], since: number): Compaction | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"compact_boundary"')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o?.type !== 'system' || o.subtype !== 'compact_boundary' || o.isSidechain) continue
    const at = Date.parse(String(o.timestamp ?? ''))
    if (!at || at < since) return null
    const meta =
      typeof o.compactMetadata === 'object' && o.compactMetadata ? (o.compactMetadata as Record<string, unknown>) : {}
    const count = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)
    return { at, pre: count(meta.preTokens), post: count(meta.postTokens) }
  }
  return null
}

/**
 * The context of the first real request after `since` (a compaction's time) in a transcript's
 * lines, as transcript.ts counts it (cached parts included), else null: none came yet.
 */
export function firstRequestAfter(lines: readonly string[], since: number): number | null {
  for (const line of lines) {
    if (!line?.includes('"type":"assistant"') || !line.includes('"usage"')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o?.type !== 'assistant' || o.isSidechain) continue
    const at = Date.parse(String(o.timestamp ?? ''))
    if (!at || at <= since) continue
    const message = typeof o.message === 'object' && o.message ? (o.message as Record<string, unknown>) : {}
    if (message.model === '<synthetic>') continue
    const u = typeof message.usage === 'object' && message.usage ? (message.usage as Record<string, unknown>) : {}
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
    const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
    if (tokens) return tokens
  }
  return null
}

/**
 * A run on its way, settled: done when the transcript shows the compaction, failed (held) when none
 * came in time, else null (still waiting). Done, what it left is measured on the first request after
 * it (measureRun); a summary Claude Code counts at or above the limit already holds it.
 * `context`: the session's context now, for a compaction whose counts the transcript lacks.
 */
export function settleRun(
  run: CompactRun,
  found: Compaction | null,
  status: Item['status'],
  context: number | null,
  now: number,
): CompactRun | null {
  if (run.state !== 'sent') return null
  if (found) {
    const to = found.post ?? context ?? undefined
    const from = found.pre ?? run.from
    const high = to !== undefined && to >= run.limit
    return {
      ...run,
      state: 'done',
      from,
      ...(to !== undefined && { to }),
      doneAt: found.at,
      ...(high && { hold: true }),
    }
  }
  const waited = now - run.at
  if (waited < SENT_IDLE_MS || (status === 'working' && waited < SENT_WORKING_MS)) return null
  return { ...run, state: 'failed', hold: true }
}

/**
 * A done run measured: `tokens` is the context of the first request after the compaction (what the
 * session really has now); at or above the limit it holds, so a limit below what a session carries
 * anyway (its system prompt and tools) never compacts it on every turn.
 */
export function measureRun(run: CompactRun, tokens: number): CompactRun {
  return { ...run, to: tokens, measured: true, ...(tokens >= run.limit && { hold: true }) }
}
