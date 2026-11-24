// Background task tracking for Antigravity (`agy`) sessions (#676): pure helpers for
// configuration, summarizing running tasks, and flagging tasks that exceed the stuck threshold.
import type { Translator } from './types.ts'

export const BG_TASK_STUCK_DEFAULT_MIN = 30
export const BG_TASK_STUCK_MAX_MIN = 1440
export const MAX_BG_TASK_DETAIL = 160

/** A single running non-daemon background task parsed from an agent transcript. */
export interface RunningBgTask {
  id: string
  stepIndex?: number | null
  startedAt: number
  detail: string
}

/** Card-level summary of active background tasks for an item. */
export interface BgTaskSummary {
  count: number
  since: number | null
  detail: string
  stuckMin: number
  stuck?: boolean
}

function singleLineClip(raw: string, max = MAX_BG_TASK_DETAIL): string {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * Threshold in minutes after which a running background task is flagged as potentially stuck.
 * Returns 0 when explicitly disabled (`0`), clamps positive numbers to [1, BG_TASK_STUCK_MAX_MIN],
 * and defaults to BG_TASK_STUCK_DEFAULT_MIN (30).
 */
export function bgTaskStuckMin(raw: unknown): number {
  if (raw === 0) return 0
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.min(BG_TASK_STUCK_MAX_MIN, Math.max(1, Math.round(raw)))
  }
  return BG_TASK_STUCK_DEFAULT_MIN
}

/** Whether a card carries at least one active background task. */
export const bgTaskActive = (bg: BgTaskSummary | null | undefined): bg is BgTaskSummary =>
  !!bg && typeof bg.count === 'number' && Number.isInteger(bg.count) && bg.count > 0

/** Whether an active background task has exceeded the configured stuck threshold at `now`. */
export function isBgTaskStuck(
  bg: Pick<BgTaskSummary, 'since' | 'stuckMin' | 'stuck'> | null | undefined,
  now: number,
): boolean {
  if (!bg) return false
  if (bg.stuck === true) return true
  return bg.since != null && bg.since > 0 && bg.stuckMin > 0 && now - bg.since >= bg.stuckMin * 60_000
}

/** Summarize running transcript background tasks into a card-level BgTaskSummary. */
export function summarizeBgTasks(tasks: readonly RunningBgTask[], stuckMin: number, now: number): BgTaskSummary | null {
  if (tasks.length === 0) return null
  let oldest = tasks[0] as RunningBgTask
  for (let i = 1; i < tasks.length; i++) {
    const t = tasks[i] as RunningBgTask
    if (t.startedAt > 0 && (oldest.startedAt <= 0 || t.startedAt < oldest.startedAt)) {
      oldest = t
    }
  }
  const since = oldest.startedAt > 0 ? oldest.startedAt : null
  const detail = singleLineClip(oldest.detail)
  const stuck = since !== null && stuckMin > 0 && now - since >= stuckMin * 60_000
  return {
    count: tasks.length,
    since,
    detail,
    stuckMin,
    ...(stuck ? { stuck: true } : {}),
  }
}

/** Build a BgTaskSummary from a terminal footer task count and observed start timestamp. */
export function bgTaskFromFooter(
  count: number,
  since: number | null,
  stuckMin: number,
  now: number,
): BgTaskSummary | null {
  if (!Number.isInteger(count) || count <= 0) return null
  const cleanSince = since != null && Number.isFinite(since) && since > 0 ? since : null
  const stuck = cleanSince !== null && stuckMin > 0 && now - cleanSince >= stuckMin * 60_000
  return {
    count,
    since: cleanSince,
    detail: '',
    stuckMin,
    ...(stuck ? { stuck: true } : {}),
  }
}

/** Format the card/TUI label for an active background task summary. */
export function bgTaskLabel(bg: Pick<BgTaskSummary, 'count'>, ageText: string, stuck: boolean, t: Translator): string {
  if (stuck) {
    if (!ageText) return t('card.bgTaskStuckNoAge')
    return bg.count === 1
      ? t('card.bgTaskStuck', { age: ageText })
      : t('card.bgTasksStuck', { n: bg.count, age: ageText })
  }
  if (bg.count === 1) return ageText ? t('card.bgTaskAge', { age: ageText }) : t('card.bgTask')
  return ageText ? t('card.bgTasksAge', { n: bg.count, age: ageText }) : t('card.bgTasks', { n: bg.count })
}
