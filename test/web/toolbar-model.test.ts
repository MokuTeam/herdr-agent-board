import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { resultToken } from '../../web/src/models/attention.ts'
import {
  attentionCount,
  columnHeads,
  documentTitle,
  laneOptions,
  scheduleBadge,
  summaryParts,
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
  expect(columnHeads(columns, visible, 'proj', categoryOf, translator('ru'))).toEqual([
    { id: 'work', title: 'Работает', color: 'var(--green)', n: 1 },
    { id: 'me', title: 'Ждёт меня', color: 'var(--orange)', n: 0 },
  ])
})

test('schedule badge and the tab title', () => {
  const entry = (next: number) => ({ id: String(next), key: 'a', text: 'x', next })
  expect(scheduleBadge([], 1000)).toEqual({ count: 0, due: false })
  expect(scheduleBadge([entry(2000)], 1000)).toEqual({ count: 1, due: false })
  expect(scheduleBadge([entry(2000), entry(1000)], 1000)).toEqual({ count: 2, due: true })
  expect(documentTitle([item({ key: 'a', column: 'work' })])).toBe('Agent board')
  expect(documentTitle([item({ key: 'a', column: 'me' }), item({ key: 'b', column: 'me' })])).toBe('(2) Agent board')
})
