// Continue after a crash or reboot (#633): tracks active Claude turns on their cards (`midTurn`),
// clears the mark when the turn ends, and after a board/herdr/computer restart queues one
// continue reminder through the schedule once the same session is back and idle.
import { allCards, updateCard } from '../adapters/cards.ts'
import { knobMs } from '../adapters/pacing.ts'
import { addEntry, listEntries } from '../adapters/schedule-store.ts'
import {
  evaluatePending,
  isTurnResumeEligible,
  type PendingMark,
  parseTurnMark,
  sameTurnMark,
  TURN_RESUME_KIND,
  TURN_RESUME_TEXT,
  turnResumeConfig,
} from '../core/turn-resume.ts'
import type { Config, Item, TurnMark } from '../core/types.ts'

export interface TurnResumeService {
  /** Observe a fresh board collect: resolve pending marks from before a restart and update active marks. */
  observe(items: readonly Item[]): void
  /** Note a failed herdr read so active marks are treated as recovery candidates once herdr answers again. */
  observeFailure(): void
  /** Clear in-memory state when the board shuts down, leaving on-disk marks intact. */
  stop(): void
}

export interface TurnResumeOptions {
  cfg: Pick<Config, 'turnResume'>
  log: (line: string) => void
  now?: () => number
  onQueued?: () => void
}

type PendingEntry = PendingMark & { since?: number }
type DropOutcome = 'dropped' | 'absent' | 'error'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createTurnResume({ cfg, log, now = Date.now, onQueued }: TurnResumeOptions): TurnResumeService {
  const pending = new Map<string, PendingEntry>()
  const active = new Map<string, TurnMark>()
  let herdrFailed = false
  let wasOn = turnResumeConfig(cfg.turnResume).on

  if (wasOn) {
    for (const [key, card] of allCards()) {
      const mark = parseTurnMark(card.midTurn)
      if (!mark) continue
      pending.set(key, {
        key,
        mark,
        ...(typeof card.name === 'string' && card.name && { name: card.name }),
      })
    }
  }

  function writeMark(key: string, mark: TurnMark): boolean {
    try {
      updateCard(key, saved => {
        const current = parseTurnMark(saved?.midTurn)
        if (current && sameTurnMark(current, mark)) return undefined
        return { ...(saved ?? { key }), midTurn: mark }
      })
      return true
    } catch (err) {
      log(`turn-resume: write mark ${key}: ${messageOf(err)}`)
      return false
    }
  }

  function dropMark(key: string, expect?: TurnMark): DropOutcome {
    let outcome: DropOutcome = 'absent'
    try {
      updateCard(key, saved => {
        if (!saved || saved.midTurn === undefined) return undefined
        const current = parseTurnMark(saved.midTurn)
        if (expect && !sameTurnMark(current, expect)) return undefined
        const { midTurn: _gone, ...rest } = saved
        outcome = 'dropped'
        return rest
      })
      return outcome
    } catch (err) {
      log(`turn-resume: clear mark ${key}: ${messageOf(err)}`)
      return 'error'
    }
  }

  function buildMark(item: Item, existing: TurnMark | undefined, tNow: number): TurnMark {
    const session = item.session ?? ''
    const startedAt = existing && existing.session === session ? existing.startedAt : tNow
    const processStartedAt = typeof item.since === 'number' && item.since > 0 ? item.since : undefined
    return {
      session,
      startedAt,
      ...(item.pane ? { pane: item.pane } : {}),
      ...(processStartedAt !== undefined && { processStartedAt }),
    }
  }

  function observeFailure(): void {
    if (turnResumeConfig(cfg.turnResume).on && active.size > 0) {
      herdrFailed = true
    }
  }

  function observe(items: readonly Item[]): void {
    const conf = turnResumeConfig(cfg.turnResume)
    const waitMs = knobMs('BOARD_TURN_RESUME_WAIT_MS', conf.waitMs)

    if (!conf.on) {
      if (wasOn) {
        for (const [key, entry] of pending) dropMark(key, entry.mark)
        pending.clear()
        herdrFailed = false
        for (const key of active.keys()) dropMark(key)
        active.clear()
        wasOn = false
      }
      return
    }

    if (!wasOn) {
      wasOn = true
    }

    if (herdrFailed) {
      herdrFailed = false
      if (active.size > 0) {
        for (const [key, mark] of active) {
          if (!pending.has(key)) pending.set(key, { key, mark })
        }
        active.clear()
      }
    }

    const tNow = now()

    if (pending.size > 0) {
      for (const [key, entry] of [...pending.entries()]) {
        entry.since ??= tNow
        const decision = evaluatePending(entry, items, tNow, entry.since, waitMs)
        if (decision.action === 'wait') continue

        const label = entry.name || key.slice(0, 8)

        if (decision.action === 'already-working') {
          pending.delete(key)
          log(`turn-resume: ${decision.item.name || label}: skipped (${decision.detail})`)
          const nextMark = buildMark(decision.item, entry.mark, tNow)
          if (sameTurnMark(entry.mark, nextMark) || writeMark(key, nextMark)) {
            active.set(key, nextMark)
          }
          continue
        }

        if (decision.action === 'skip') {
          if (dropMark(key, entry.mark) !== 'error') {
            pending.delete(key)
            log(`turn-resume: ${label}: skipped (${decision.detail})`)
          }
          continue
        }

        // Drop the mark BEFORE enqueueing so a crash right after never sends a second continue.
        const claimed = dropMark(key, entry.mark)
        if (claimed === 'error') continue
        pending.delete(key)
        if (claimed === 'absent') {
          log(`turn-resume: ${decision.item.name || label}: skipped (mark already claimed)`)
          continue
        }
        if (listEntries().some(e => e.key === decision.item.key && e.kind === TURN_RESUME_KIND)) {
          log(`turn-resume: ${decision.item.name || label}: skipped (continue already scheduled)`)
          continue
        }
        addEntry(
          {
            key: decision.item.key,
            name: decision.item.name,
            ...(decision.item.pane ? { pane: decision.item.pane } : {}),
            ...(decision.item.cwd ? { cwd: decision.item.cwd } : {}),
            text: TURN_RESUME_TEXT,
            kind: TURN_RESUME_KIND,
            idle: true,
            noWake: true,
            at: tNow,
            next: tNow,
            by: 'board',
          },
          { overCap: true },
        )
        log(`turn-resume: ${decision.item.name || label}: queued continue after restart`)
        onQueued?.()
      }
    }

    const seenKeys = new Set<string>()
    for (const item of items) {
      seenKeys.add(item.key)
      if (pending.has(item.key) || (item.session && pending.has(item.session))) continue
      if (isTurnResumeEligible(item)) {
        if (item.status === 'working') {
          const existing = active.get(item.key)
          const nextMark = buildMark(item, existing, tNow)
          if (!existing || !sameTurnMark(existing, nextMark)) {
            if (writeMark(item.key, nextMark)) active.set(item.key, nextMark)
          }
        } else if (item.status !== 'unknown') {
          if (active.has(item.key) && dropMark(item.key) !== 'error') {
            active.delete(item.key)
          }
        }
      } else if (active.has(item.key) && dropMark(item.key) !== 'error') {
        active.delete(item.key)
      }
    }

    // If an active Claude pane closed/exited on a normal collect (without observeFailure), clear its mark.
    for (const key of [...active.keys()]) {
      if (seenKeys.has(key) || pending.has(key)) continue
      if (dropMark(key) !== 'error') active.delete(key)
    }
  }

  function stop(): void {
    pending.clear()
    active.clear()
    herdrFailed = false
  }

  return { observe, observeFailure, stop }
}
