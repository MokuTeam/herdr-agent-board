import { expect, test } from 'bun:test'
import type { Item } from '../../src/core/types.ts'
import { categoryInfo, laneShown, visibleItems } from '../../web/src/models/board-view.ts'
import { item } from './support/board.tsx'

const categories = [
  {
    id: 'proj',
    title: 'Client Work',
    color: '#007AFF',
    colorName: 'blue',
    paths: [],
    configured: true,
    fallback: false,
  },
]
const categoryOf = (it: Item) => it.category
const keys = (items: Item[]) => items.map(i => i.key)

test('sleeping sessions in the idle column hide unless asked for; sleeping ones elsewhere stay', () => {
  const items = [
    item({ key: 'a', column: 'idle', sleeping: true }),
    item({ key: 'b', column: 'done', sleeping: true }),
    item({ key: 'c', column: 'idle' }),
  ]
  expect(keys(visibleItems(items, { query: '', sleepers: false, categories, categoryOf }))).toEqual(['b', 'c'])
  expect(keys(visibleItems(items, { query: '', sleepers: true, categories, categoryOf }))).toEqual(['a', 'b', 'c'])
})

test('the search matches names, texts, the workspace and the lane title, ignoring case and outer spaces', () => {
  const items = [
    item({ key: 'a', name: 'Alpha' }),
    item({ key: 'b', doing: 'Fixing the LOGIN form' }),
    item({ key: 'c', workspace: 'infra' }),
    item({ key: 'd', category: 'proj' }),
    item({ key: 'e', lastText: 'nothing here' }),
  ]
  const search = (query: string) => keys(visibleItems(items, { query, sleepers: true, categories, categoryOf }))
  expect(search('  alpha ')).toEqual(['a'])
  expect(search('login')).toEqual(['b'])
  expect(search('INFRA')).toEqual(['c'])
  expect(search('client')).toEqual(['d'])
  expect(search('zzz')).toEqual([])
})

test('lanes on show and the look of a lane the payload does not list', () => {
  expect(laneShown('all', 'x')).toBe(true)
  expect(laneShown('x', 'x')).toBe(true)
  expect(laneShown('y', 'x')).toBe(false)
  expect(categoryInfo(categories, 'proj').title).toBe('Client Work')
  expect(categoryInfo(categories, 'new')).toEqual({ id: 'new', title: 'new', color: 'var(--gray)' })
})
