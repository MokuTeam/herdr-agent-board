// What the toolbar shows: the summary line (and the title's tooltip, where the summary hides), the
// lanes control and its fading edges, the column heads (an empty column narrows to its head), the
// count of cards that need the user, the schedule badge and the tab's title.
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { ColumnId, Item, Translator } from '../../../src/core/types.ts'
import { type Seen, unseenResult } from './attention.ts'
import { colOf, type PendingMoves } from './board-view.ts'
import { liveCount } from './helper-model.ts'
import { type LanePicks, laneShown } from './lane-picks.ts'

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

/** The summary as one line of text: the title's tooltip, since a narrower toolbar hides the summary. */
export const summaryText = (parts: SummaryPart[]): string => parts.map(p => `${p.n} ${p.text}`).join(' · ')

/** Cards on show that need the user: questions, and results not viewed yet. */
export function attentionCount(visible: Item[], filter: LanePicks, categoryOf: CategoryOf, viewed: Seen): number {
  return visible.filter(
    it => !it.launchOnly && laneShown(filter, categoryOf(it)) && (it.column === 'me' || unseenResult(it, viewed)),
  ).length
}

export type LaneOption = { id: string; title: string; n: number }

/** The lanes control: "All", then the categories with sessions on show and those picked. */
export function laneOptions(
  categories: BoardCategory[],
  visible: Item[],
  filter: LanePicks,
  categoryOf: CategoryOf,
  t: Translator,
): LaneOption[] {
  const used = categories.filter(c => visible.some(i => categoryOf(i) === c.id) || filter.includes(c.id))
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

/** `vacant`: no card on show in it (where cards were moved counts): it narrows to its head. */
export type ColumnHead = { id: ColumnId; title: string; color: string; n: number; vacant: boolean }

/** The column heads with the count of cards in the lanes on show; titles from the page's own dictionary. */
export function columnHeads(
  columns: { id: ColumnId }[],
  visible: Item[],
  filter: LanePicks,
  categoryOf: CategoryOf,
  t: Translator,
  moves: PendingMoves,
): ColumnHead[] {
  const shown = visible.filter(i => laneShown(filter, categoryOf(i)))
  return columns.map(c => ({
    id: c.id,
    title: t(`col.${c.id}`),
    color: COLUMN_COLORS[c.id],
    n: shown.filter(i => i.column === c.id).length,
    vacant: !shown.some(i => colOf(moves, i) === c.id),
  }))
}

/**
 * Each column's share of the board's width: 1 with cards, 0 without, when it keeps only its
 * minimum (--col-min, the head's width). Nothing on show at all: the columns keep their even widths.
 */
export const columnShares = (heads: Pick<ColumnHead, 'vacant'>[]): number[] =>
  heads.some(h => !h.vacant) ? heads.map(h => (h.vacant ? 0 : 1)) : heads.map(() => 1)

/** The board's grid columns (--cols) for the shares as they are now, on their way to the ones wanted. */
export const columnTracks = (shares: number[]): string =>
  shares.map(v => `minmax(var(--col-min), ${Math.max(0, v).toFixed(3)}fr)`).join(' ')

/**
 * The same columns beside a panel docked at a side (--cols-beside, styles/beside.css), where the
 * board may have less room than its columns: one with cards keeps a card's readable width
 * (--col-card) and the board scrolls sideways rather than narrow it further; an empty one keeps only
 * its head's (--col-min), so the ones with cards get the room. In between, as the shares move.
 */
export const besideTracks = (shares: number[]): string =>
  shares
    .map(v => {
      const share = Math.max(0, v).toFixed(3)
      return `minmax(max(var(--col-min), calc(var(--col-card) * ${share})), ${share}fr)`
    })
    .join(' ')

/** The lanes control fades at an edge with more lanes past it. */
export function laneFades(el: { scrollWidth: number; clientWidth: number; scrollLeft: number }): {
  start: boolean
  end: boolean
} {
  const hidden = el.scrollWidth - el.clientWidth
  return { start: el.scrollLeft > 1, end: hidden - el.scrollLeft > 1 }
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
