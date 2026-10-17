// What the toolbar shows: the summary line, the lanes control, the column heads, the count of
// cards that need the user, the schedule badge and the tab's title.
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { ColumnId, Item, Translator } from '../../../src/core/types.ts'
import { type Seen, unseenResult } from './attention.ts'
import { laneShown } from './board-view.ts'
import { liveCount } from './helper-model.ts'

type CategoryOf = (item: Item) => string

/** A count in the summary line (`id`: what it counts); the sessions asleep are not in bold. */
export type SummaryPart = { id: string; n: number; text: string; strong: boolean }

const SUMMARY_COLUMNS: [ColumnId, string][] = [
  ['work', 'sum.working'],
  ['me', 'sum.needYou'],
  ['ext', 'sum.waitOthers'],
]

/** "4 sessions · 1 working · 1 needs you · 2 asleep", of every session on the board. */
export function summaryParts(items: Item[], t: Translator): SummaryPart[] {
  const parts: SummaryPart[] = [
    { id: 'sessions', n: items.length, text: t('sum.sessions', { n: items.length }), strong: true },
  ]
  for (const [column, key] of SUMMARY_COLUMNS) {
    const n = items.filter(i => i.column === column).length
    if (n) parts.push({ id: column, n, text: t(key, { n }), strong: true })
  }
  const helping = items.reduce((n, i) => n + liveCount(i), 0)
  if (helping) parts.push({ id: 'helpers', n: helping, text: t('sum.helpers', { n: helping }), strong: true })
  const asleep = items.filter(i => i.sleeping).length
  if (asleep) parts.push({ id: 'asleep', n: asleep, text: t('sum.asleep', { n: asleep }), strong: false })
  return parts
}

/** Cards on show that need the user: questions, and results not viewed yet. */
export function attentionCount(visible: Item[], filter: string, categoryOf: CategoryOf, viewed: Seen): number {
  return visible.filter(
    it => !it.launchOnly && laneShown(filter, categoryOf(it)) && (it.column === 'me' || unseenResult(it, viewed)),
  ).length
}

export type LaneOption = { id: string; title: string; n: number }

/** The lanes control: "All", then the categories with sessions on show and the one picked. */
export function laneOptions(
  categories: BoardCategory[],
  visible: Item[],
  filter: string,
  categoryOf: CategoryOf,
  t: Translator,
): LaneOption[] {
  const used = categories.filter(c => visible.some(i => categoryOf(i) === c.id) || c.id === filter)
  return [
    { id: 'all', title: t('all'), n: visible.length },
    ...used.map(c => ({ id: c.id, title: c.title, n: visible.filter(i => categoryOf(i) === c.id).length })),
  ]
}

export const COLUMN_COLORS: Record<ColumnId, string> = {
  work: 'var(--green)',
  me: 'var(--orange)',
  ext: 'var(--purple)',
  done: 'var(--blue)',
  idle: 'var(--gray)',
}

export type ColumnHead = { id: ColumnId; title: string; color: string; n: number }

/** The column heads with the count of cards in the lanes on show; titles from the page's own dictionary. */
export function columnHeads(
  columns: { id: ColumnId }[],
  visible: Item[],
  filter: string,
  categoryOf: CategoryOf,
  t: Translator,
): ColumnHead[] {
  return columns.map(c => ({
    id: c.id,
    title: t(`col.${c.id}`),
    color: COLUMN_COLORS[c.id],
    n: visible.filter(i => i.column === c.id && laneShown(filter, categoryOf(i))).length,
  }))
}

/** The schedule button's badge: how many entries, and whether one is due and waits. */
export function scheduleBadge(schedules: ScheduleEntry[], now: number): { count: number; due: boolean } {
  return { count: schedules.length, due: schedules.some(e => e.next <= now) }
}

/** The tab's title, with how many sessions need the user first. */
export function documentTitle(items: Item[]): string {
  const me = items.filter(i => i.column === 'me').length
  return me ? `(${me}) Agent board` : 'Agent board'
}
