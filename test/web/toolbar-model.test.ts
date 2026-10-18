import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { resultToken } from '../../web/src/models/attention.ts'
import { NO_MOVES, withMove } from '../../web/src/models/board-view.ts'
import {
  attentionCount,
  columnHeads,
  columnShares,
  columnTracks,
  documentTitle,
  laneFades,
  laneOptions,
  scheduleBadge,
  summaryParts,
  summaryText,
} from '../../web/src/models/toolbar.ts'
import { item } from './support/board.tsx'

const t = translator('en')
const categoryOf = (it: Item) => it.category
const CATEGORIES = ['proj', 'other', 'unused'].map(id => ({
  id,
  title: id.toUpperCase(),
  color: '#000',
  colorName: 'gray',
  paths: [],
  configured: true,
  fallback: id === 'other',
}))

test('summary: every session on the board, the working, waiting and asleep ones only when there are any', () => {
  expect(summaryParts([], t)).toEqual([{ id: 'sessions', n: 0, text: 'sessions', strong: true }])
  const items = [
    item({ key: 'a', column: 'work' }),
    item({ key: 'b', column: 'work' }),
    item({ key: 'c', column: 'me' }),
    item({ key: 'd', column: 'idle', sleeping: true }),
  ]
  expect(summaryParts(items, t)).toEqual([
    { id: 'sessions', n: 4, text: 'sessions', strong: true },
    { id: 'work', n: 2, text: 'working', strong: true },
    { id: 'me', n: 1, text: 'needs you', strong: true },
    { id: 'asleep', n: 1, text: 'asleep', strong: false },
  ])
  expect(summaryParts([item({ key: 'a', column: 'ext' })], translator('ru')).map(p => p.text)).toEqual([
    'сессия',
    'ждёт ответа извне',
  ])
})

test('attention: questions and unviewed results in the lanes on show, starting cards left out', () => {
  const done = item({ key: 'c', column: 'done', result: 'ok', category: 'other' })
  const visible = [
    item({ key: 'a', column: 'me', category: 'proj' }),
    item({ key: 'l', column: 'me', category: 'proj', launchOnly: true }),
    done,
    item({ key: 'w', column: 'work', category: 'proj' }),
  ]
  expect(attentionCount(visible, 'all', categoryOf, {})).toBe(2)
  expect(attentionCount(visible, 'proj', categoryOf, {})).toBe(1)
  expect(attentionCount(visible, 'all', categoryOf, { c: resultToken(done) })).toBe(1)
})

test('lanes control: All, then the categories with sessions on show and the picked one, in the board order', () => {
  const visible = [item({ key: 'a', category: 'other' }), item({ key: 'b', category: 'other' })]
  expect(laneOptions(CATEGORIES, visible, 'all', categoryOf, t)).toEqual([
    { id: 'all', title: 'All', n: 2 },
    { id: 'other', title: 'OTHER', n: 2 },
  ])
  expect(laneOptions(CATEGORIES, visible, 'unused', categoryOf, t).map(o => [o.id, o.n])).toEqual([
    ['all', 2],
    ['other', 2],
    ['unused', 0],
  ])
})

test('column heads: the page dictionary titles, the column colors and counts in the lanes on show', () => {
  const columns = [{ id: 'work' as const }, { id: 'me' as const }]
  const visible = [item({ key: 'a', column: 'work', category: 'proj' }), item({ key: 'b', column: 'work' })]
  expect(columnHeads(columns, visible, 'proj', categoryOf, translator('ru'), NO_MOVES)).toEqual([
    { id: 'work', title: 'Работает', color: 'var(--green)', n: 1, vacant: false },
    { id: 'me', title: 'Ждёт меня', color: 'var(--orange)', n: 0, vacant: true },
  ])
})

test('a column with no card on show narrows to its head; where a card was moved counts, its count stays the server’s', () => {
  const columns = [{ id: 'work' as const }, { id: 'me' as const }, { id: 'done' as const }]
  const visible = [item({ key: 'a', column: 'work', category: 'proj' })]
  const moved = withMove(NO_MOVES, 'a', { cat: null, column: 'done', at: 1 })
  const heads = columnHeads(columns, visible, 'all', categoryOf, t, moved)
  expect(heads.map(h => [h.id, h.n, h.vacant])).toEqual([
    ['work', 1, true],
    ['me', 0, true],
    ['done', 0, false],
  ])
  expect(columnShares(heads)).toEqual([0, 0, 1])
  // Nothing on show at all: the columns keep their even widths.
  expect(columnShares(columnHeads(columns, [], 'all', categoryOf, t, NO_MOVES))).toEqual([1, 1, 1])
  expect(columnTracks([1, 0.4999, -0.01])).toBe(
    'minmax(var(--col-min), 1.000fr) minmax(var(--col-min), 0.500fr) minmax(var(--col-min), 0.000fr)',
  )
})

test('the title’s tooltip is the summary, for a toolbar too narrow to show it', () => {
  const items = [item({ key: 'a', column: 'work' }), item({ key: 'b', column: 'me', sleeping: true })]
  expect(summaryText(summaryParts(items, t))).toBe('2 sessions · 1 working · 1 needs you · 1 asleep')
})

test('the lanes control fades at an edge with more lanes past it', () => {
  expect(laneFades({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })).toEqual({ start: false, end: false })
  expect(laneFades({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })).toEqual({ start: false, end: true })
  expect(laneFades({ scrollWidth: 500, clientWidth: 300, scrollLeft: 100 })).toEqual({ start: true, end: true })
  expect(laneFades({ scrollWidth: 500, clientWidth: 300, scrollLeft: 199.5 })).toEqual({ start: true, end: false })
})

test('schedule badge and the tab title', () => {
  const entry = (next: number) => ({ id: String(next), key: 'a', text: 'x', next })
  expect(scheduleBadge([], 1000)).toEqual({ count: 0, due: false })
  expect(scheduleBadge([entry(2000)], 1000)).toEqual({ count: 1, due: false })
  expect(scheduleBadge([entry(2000), entry(1000)], 1000)).toEqual({ count: 2, due: true })
  expect(documentTitle([item({ key: 'a', column: 'work' })])).toBe('Agent board')
  expect(documentTitle([item({ key: 'a', column: 'me' }), item({ key: 'b', column: 'me' })])).toBe('(2) Agent board')
})
