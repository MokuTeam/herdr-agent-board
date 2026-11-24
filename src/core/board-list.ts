// Shared formatting for `board list` across local CLI and node uplink (#698).
import { bgTaskActive, bgTaskLabel, isBgTaskStuck } from './bg-task.ts'
import { COLUMNS, noteOf, statusText } from './board.ts'
import { laneRank } from './categories.ts'
import { t } from './lang.ts'
import type { Config, Item } from './types.ts'
import { shortWhen, span } from './when-format.ts'

export interface ListLinesOptions {
  /** Soonest scheduled entry timestamp per session key (`⏰ ...`). */
  soonest?: ReadonlyMap<string, number>
  now?: number
  /** Free-text card notes (doing/waiting/asking/done). Omitted on node uplink replies so private notes stay on master. */
  includeNote?: boolean
}

/**
 * Formats board sessions sorted by lane rank, lane id, and column order, matching `board list`.
 */
export function formatListLines(items: readonly Item[], cfg: Config, opts: ListLinesOptions = {}): string[] {
  const order = new Map(COLUMNS.map((c, i) => [c.id, i]))
  const sorted = [...items].sort(
    (a, b) =>
      laneRank(cfg, a.category) - laneRank(cfg, b.category) ||
      a.category.localeCompare(b.category) ||
      (order.get(a.column) ?? 0) - (order.get(b.column) ?? 0),
  )
  const now = opts.now ?? Date.now()
  return sorted.map(i => {
    const col = COLUMNS.find(c => c.id === i.column)?.title
    const note = opts.includeNote ? noteOf(i) : ''
    const next = opts.soonest?.get(i.key)
    const alarm = next !== undefined ? ` ⏰ ${shortWhen(next, t)}` : ''
    let bgNote = ''
    if (bgTaskActive(i.bgTasks)) {
      const stuck = isBgTaskStuck(i.bgTasks, now)
      const ageText = i.bgTasks.since
        ? now - i.bgTasks.since < 60_000
          ? t('ago.now')
          : span(now - i.bgTasks.since, t)
        : ''
      bgNote = ` [${bgTaskLabel(i.bgTasks, ageText, stuck, t)}]`
    }
    return `${i.name} [${i.category}] ${col}${i.sleeping ? ` (${statusText('sleeping')})` : ''}${alarm}${bgNote}${note ? `: ${note.slice(0, 80)}` : ''}`
  })
}
