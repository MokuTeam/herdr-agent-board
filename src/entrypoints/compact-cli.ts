// `board compact` (#378): a session's auto-compact limit and the instructions for its summary, on
// its card (core/compact.ts). The board's compactor (services/compactor.ts) types /compact once the
// session's context reaches the limit, between turns.
//   board compact                          the limit in force, where it comes from, the last run
//   board compact --at <300k|60%|never>    this session's own limit (never: not even Settings' default)
//   board compact --note "<what to keep>"  what its summary must keep (--note none: no instructions)
//   board compact --clear                  its own limit and instructions go: Settings' default applies
// With --session <id|name|pane> (cli.ts), another session's.

import type { CardPatch } from '../adapters/cards.ts'
import { readCard, writeCard } from '../adapters/cards.ts'
import {
  type CompactRun,
  compactRule,
  compactView,
  limitText,
  MAX_COMPACT_NOTE,
  noteText,
  parseCompactLimit,
  shortTokens,
} from '../core/compact.ts'
import type { Card, Config } from '../core/types.ts'

export const COMPACT_USAGE =
  'usage: board compact [--at <300k|60%|never>] [--note "<what the summary must keep>" | --note none] [--clear] [--session <id|name|pane>]'

/** The flags of `board compact`, from the words after it; a word that is no flag is an error. */
export function parseCompactArgs(
  words: readonly string[],
): { at?: string; note?: string; clear: boolean } | { error: string } {
  const out: { at?: string; note?: string; clear: boolean } = { clear: false }
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (w === '--clear') out.clear = true
    else if (w === '--at' || w === '--note') {
      const v = words[i + 1]
      if (v === undefined) return { error: COMPACT_USAGE }
      if (w === '--at') out.at = v
      else out.note = v
      i++
    } else return { error: `unknown word "${w}". ${COMPACT_USAGE}` }
  }
  if (out.clear && (out.at !== undefined || out.note !== undefined))
    return { error: `--clear goes alone. ${COMPACT_USAGE}` }
  return out
}

/** The card change a `board compact` asks for; null when it only shows. */
export function compactPatch(args: {
  at?: string
  note?: string
  clear: boolean
}): CardPatch | { error: string } | null {
  if (args.clear) return { compactAt: '', compactNote: '' }
  const patch: CardPatch = {}
  if (args.at !== undefined) {
    const limit = parseCompactLimit(args.at)
    if (!limit)
      return {
        error: `"${args.at}" is no limit: tokens (300k, 1.2m, at least 10k), a share of the window (5% to 95%) or never. ${COMPACT_USAGE}`,
      }
    patch.compactAt = limitText(limit)
  }
  if (args.note !== undefined) {
    const none = ['', 'none', 'off'].includes(args.note.trim().toLowerCase())
    if (!none && args.note.trim().length > MAX_COMPACT_NOTE)
      return { error: `the instructions are longer than ${MAX_COMPACT_NOTE} characters` }
    patch.compactNote = none ? '' : noteText(args.note)
  }
  return Object.keys(patch).length ? patch : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
const when = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The last run in words: "compacted 2026-11-12 14:05: 612k → 48k". */
export function runLine(run: CompactRun): string {
  const to = run.to === undefined ? '' : ` → ${shortTokens(run.to)}`
  if (run.state === 'sent')
    return `/compact typed ${when(run.at)} at ${shortTokens(run.from)}, waiting for the compaction`
  if (run.state === 'failed')
    return `/compact typed ${when(run.at)} at ${shortTokens(run.from)}, no compaction followed${run.hold ? '; paused until the context is below the limit or the limit changes' : ''}`
  const high = run.hold
    ? `, still at or above ${shortTokens(run.limit)}; paused until the context is below it or the limit changes`
    : ''
  return `compacted ${when(run.doneAt ?? run.at)}: ${shortTokens(run.from)}${to}${high}`
}

/** What `board compact` prints for a session: the limit in force and where it comes from, its instructions, its last run. */
export function compactLine(card: Card | null, cfg: Pick<Config, 'compact'>, windowSize: number | null = null): string {
  const view = compactView(card, cfg.compact, windowSize)
  if (!view)
    return 'compact: off (no limit for this session, no default in Settings) · set one: board compact --at 300k'
  const where =
    view.source === 'session'
      ? `${view.limit}, this session's own`
      : view.source === 'default'
        ? `${view.limit}, Settings' default`
        : view.source === 'never'
          ? "never, this session's own"
          : 'off'
  const parts = [`compact: ${where}`]
  if (view.tokens !== null && view.limit.endsWith('%')) parts.push(`${shortTokens(view.tokens)} of this window`)
  const note = noteText(card?.compactNote)
  if (note) parts.push(`keeps: ${note}`)
  else {
    const fallback = view.limit ? compactRule(card, cfg.compact).note : ''
    if (fallback) parts.push(`keeps (Settings): ${fallback}`)
  }
  if (view.run) parts.push(runLine(view.run))
  return parts.join(' · ')
}

/** `board compact ...` for the session `key`: changes its card when asked, prints its line. */
export function compactCli(key: string, words: readonly string[], cfg: Pick<Config, 'compact'>): string {
  const args = parseCompactArgs(words)
  if ('error' in args) throw new Error(args.error)
  const patch = compactPatch(args)
  if (patch && 'error' in patch) throw new Error(String(patch.error))
  if (patch) writeCard(key, patch)
  const line = compactLine(readCard(key), cfg)
  return patch ? `ok · ${line}` : line
}
