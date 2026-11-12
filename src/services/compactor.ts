// Auto-compact (#378) in the board's process: once a session's context crosses the limit set for
// it (core/compact.ts compactRule), /compact goes into its prompt, only while it is free between
// turns: never into a turn, a dialog, a question waiting on the owner, the owner's unsent text, or
// a sleeping session (a sleeper does not grow; it is looked at again once it wakes and idles).
//
// The run is kept on the session's card (`compactRun`): written under the card's lock before the
// command is typed, so a second board (a restart that overlaps) never types it twice, and taken
// back when the session turned out not to be free after all. The next ticks look for the
// compaction in its transcript and write what it left; one that left the context at or above the
// limit, or none that came, holds the session (no loop) until its context is below the limit
// again or its limit changes. Each step goes into the board's log.
//
// A board where no card has a limit and Settings has no default asks herdr nothing on its tick.
import { statSync } from 'node:fs'
import { allCards, readCard, updateCard } from '../adapters/cards.ts'
import { readTail } from '../adapters/claude-home.ts'
import {
  COMPACT_DONE_KEPT,
  type CompactRun,
  compactCommand,
  compactConfig,
  compactionSince,
  compactRule,
  compactStep,
  doneTimes,
  firstRequestAfter,
  measureRun,
  parseCompactLimit,
  pending,
  runOf,
  settleRun,
  shortTokens,
} from '../core/compact.ts'
import type { Card, Item } from '../core/types.ts'
import { send } from './actions.ts'
import { collect } from './board.ts'
import type { Deps } from './deps.ts'

/** How much of a transcript's end is read for the compaction after a /compact (its summary line can be long). */
const TAIL_BYTES = 4 << 20
/** A compaction a little before the /compact was typed (the clocks of two processes) still counts. */
const SKEW_MS = 5000
/** A run typed by another board and still on its way holds this long before this board may type again. */
const SENT_CLAIM_MS = 30 * 60_000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const positive = (v: unknown, fallback: number): number => (Number(v) > 0 ? Number(v) : fallback)

/** Whether a card asks the compactor anything: a limit of its own (not never), or a run to settle or release. */
function cardWants(card: Card): boolean {
  const own = parseCompactLimit(card.compactAt)
  const run = runOf(card.compactRun)
  return (own !== null && own !== 'never') || run?.state === 'sent' || pending(run) || !!run?.hold
}

/** Whether anything is set up at all: Settings' default, or a card that asks. */
export function compactWanted(cfg: Deps['cfg'], cards: Iterable<Card>): boolean {
  if (compactConfig(cfg.compact).at) return true
  for (const card of cards) if (cardWants(card)) return true
  return false
}

/** The run on a session's card, written only while the card still has `expect` (null: none or one not on its way). */
function writeRun(key: string, expect: number | null, run: CompactRun | null): boolean {
  let wrote = false
  updateCard(key, saved => {
    const now = runOf(saved?.compactRun)
    if ((now?.at ?? null) !== expect) return undefined
    wrote = true
    const card: Card = { ...(saved ?? { key }) }
    if (run) card.compactRun = run
    else delete card.compactRun
    // A compaction that just ended: its time joins the ones the conversation marks as the board's.
    if (run?.state === 'done' && run.doneAt && now?.state === 'sent') {
      const times = doneTimes(saved?.compactDone).filter(t => t !== run.doneAt)
      card.compactDone = [...times, run.doneAt].slice(-COMPACT_DONE_KEPT)
    }
    return card
  })
  return wrote
}

/**
 * Claim a /compact for this board: the run goes on the card unless one on its way is there and
 * fresh (another board typed it). The run before it comes back if the command did not go.
 */
function claim(key: string, run: CompactRun): { ok: true; before: CompactRun | null } | { ok: false } {
  let before: CompactRun | null = null
  let ok = false
  updateCard(key, saved => {
    before = runOf(saved?.compactRun)
    if (before?.state === 'sent' && run.at - before.at < SENT_CLAIM_MS) return undefined
    ok = true
    return { ...(saved ?? { key }), compactRun: run }
  })
  return ok ? { ok: true, before } : { ok: false }
}

/** The transcript's lines from its end, for the compaction after a /compact; none when it cannot be read. */
function tailLines(path: string | null | undefined): string[] {
  if (!path) return []
  try {
    const size = statSync(path).size
    return readTail(path, size, TAIL_BYTES).split('\n')
  } catch {
    return []
  }
}

/** A run that holds the session, for the log line. */
const heldWords = (run: CompactRun): string => (run.hold ? ', still at or above the limit; held' : '')

/** A run in words for the log: "612k → 48k (limit 300k)". */
export function runWords(run: CompactRun): string {
  const to = run.to === undefined ? '?' : shortTokens(run.to)
  return `${shortTokens(run.from)} → ${to} (limit ${shortTokens(run.limit)})`
}

export interface CompactorOptions {
  deps: Deps
  /** Called after a run changed, so the board redraws. */
  onChange?: () => void
}

/**
 * Start looking at sessions' context. `deps.cfg` is the live config: `compact` (Settings' default),
 * `compactTickSec` (30, how often).
 */
export function startCompactor({ deps, onChange = () => {} }: CompactorOptions): {
  stop(): void
  tick(): Promise<void>
} {
  const { cfg, log } = deps
  const tickMs = (): number => Math.min(600, Math.max(0.1, positive(cfg.compactTickSec, 30))) * 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  let ticking = false
  let stopped = false

  async function tick(): Promise<void> {
    if (ticking || stopped) return
    ticking = true
    let changed = false
    try {
      if (!compactWanted(cfg, allCards().values())) return
      const items = await collect(deps)
      for (const item of items) {
        if (stopped) return
        try {
          if (await look(item)) changed = true
        } catch (err) {
          log(`compact ${item.name}: ${messageOf(err)}`)
        }
      }
    } catch (err) {
      log(`compact: ${messageOf(err)}`)
    } finally {
      ticking = false
      if (changed) onChange()
    }
  }

  /** One session: settle its run on its way, release its hold, or type /compact. True when its card changed. */
  async function look(item: Item): Promise<boolean> {
    const card = readCard(item.key)
    // Nothing of its own and no default: nothing to do. Else compactRule decides (its own never too).
    if (!compactConfig(cfg.compact).at && !(card && cardWants(card))) return false
    const run = runOf(card?.compactRun)
    const context = typeof item.context === 'number' ? item.context : null
    if (run?.state === 'sent') {
      const lines = tailLines(item.transcript)
      let settled = settleRun(run, compactionSince(lines, run.at - SKEW_MS), item.status, context, Date.now())
      if (!settled) return false
      // A request after it already (the board was off meanwhile): measured at once.
      const after = pending(settled) && settled.doneAt ? firstRequestAfter(lines, settled.doneAt) : null
      if (after !== null) settled = measureRun(settled, after)
      if (!writeRun(item.key, run.at, settled)) return false
      if (settled.state === 'failed') log(`compact: ${item.name}: /compact typed, no compaction followed; held`)
      else log(`compact: ${item.name}: compacted ${runWords(settled)}${heldWords(settled)}`)
      return true
    }
    // What the compaction left, on the first request after it: the system prompt and tools included.
    if (run && pending(run) && run.doneAt) {
      const after = firstRequestAfter(tailLines(item.transcript), run.doneAt)
      if (after === null) return false
      const measured = measureRun(run, after)
      if (!writeRun(item.key, run.at, measured)) return false
      log(`compact: ${item.name}: after the compaction the context is ${shortTokens(after)}${heldWords(measured)}`)
      return true
    }
    const rule = compactRule(card, cfg.compact)
    const step = compactStep(item, rule, run)
    if (step.do === 'release' && run) {
      // Settled for good: the context was seen below the limit (or the limit changed).
      const { hold, ...rest } = run
      if (!writeRun(item.key, run.at, { ...rest, measured: true })) return false
      log(`compact: ${item.name}: armed again (context ${context === null ? '?' : shortTokens(context)})`)
      return true
    }
    if (step.do !== 'compact' || context === null) return false
    const now = Date.now()
    const next: CompactRun = { state: 'sent', at: now, from: context, limit: step.limit, setting: step.setting }
    const claimed = claim(item.key, next)
    if (!claimed.ok) return false
    const r = await send(deps, item, compactCommand(rule.note), { free: true, draft: true })
    if (!r.ok) {
      // Not free after all (a turn began, a dialog, the owner's draft): as it was, tried next tick.
      writeRun(item.key, now, claimed.before)
      if (!r.busy) log(`compact: ${item.name}: ${r.error}`)
      return false
    }
    log(
      `compact: ${item.name}: context ${shortTokens(context)} at or above ${shortTokens(step.limit)} (${rule.source}), /compact typed`,
    )
    return true
  }

  async function loop(): Promise<void> {
    await tick()
    if (!stopped) timer = setTimeout(loop, tickMs())
  }
  timer = setTimeout(loop, Math.min(tickMs(), 5000))

  return {
    stop() {
      stopped = true
      clearTimeout(timer)
    },
    tick,
  }
}
