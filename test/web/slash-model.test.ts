// The chat box's slash list as a model (#191): when it shows, the order, the keys, the counts.
import { expect, test } from 'bun:test'
import {
  completion,
  noteUse,
  rankCommands,
  readUses,
  type SlashCommand,
  slashArgument,
  slashKey,
  slashQuery,
} from '../../web/src/models/slash.ts'

const c = (name: string, description = '', hint?: string): SlashCommand => ({
  name,
  description,
  source: 'builtin',
  ...(hint && { hint }),
})
const LIST = [
  c('compact', 'Compact the conversation', '[instructions]'),
  c('context', 'Show the context window'),
  c('clear', 'Clear the conversation'),
  c('cost', 'Show the cost'),
  c('pr-comments', 'Get PR comments'),
  c('skill:review', 'Review'),
  c('model', 'Set the model', '[model]'),
]

test('slashQuery: only a leading slash and a name still being typed', () => {
  expect(slashQuery('/')).toBe('')
  expect(slashQuery('/comp')).toBe('comp')
  for (const no of ['', 'hello', ' /comp', '/compact ', '/compact now', '/a\nb', '/c/Users', 'a/b']) expect([no, slashQuery(no)]).toEqual([no, null])
})

test('slashArgument: a command that takes something, right after its space', () => {
  expect(slashArgument('/model ', LIST)?.name).toBe('model')
  expect(slashArgument('/compact ', LIST)?.hint).toBe('[instructions]')
  expect(slashArgument('/model opus', LIST)).toBeNull()
  expect(slashArgument('/clear ', LIST)).toBeNull()
  expect(slashArgument('/nope ', LIST)).toBeNull()
})

test('rankCommands: name starts first, then a word in it, then inside it, then the description', () => {
  // "clear": its description has "co" (conversation).
  expect(rankCommands(LIST, 'co').map(x => x.name)).toEqual(['compact', 'context', 'cost', 'pr-comments', 'clear'])
  expect(rankCommands(LIST, 're').map(x => x.name)).toEqual(['skill:review'])
  expect(rankCommands(LIST, 'ea').map(x => x.name)).toEqual(['clear'])
  expect(rankCommands(LIST, 'window').map(x => x.name)).toEqual(['context'])
  expect(rankCommands(LIST, 'zzz')).toEqual([])
  expect(rankCommands(LIST, 'CO').map(x => x.name)[0]).toBe('compact')
})

test('rankCommands: the ones sent most from this browser first, then by name', () => {
  expect(rankCommands(LIST, '').map(x => x.name)).toEqual([
    'clear',
    'compact',
    'context',
    'cost',
    'model',
    'pr-comments',
    'skill:review',
  ])
  const uses = { cost: 5, model: 2 }
  expect(rankCommands(LIST, '', uses).map(x => x.name).slice(0, 3)).toEqual(['cost', 'model', 'clear'])
  // Popularity orders within a match's closeness, never above a closer match.
  expect(rankCommands(LIST, 'co', { 'pr-comments': 9, cost: 1 }).map(x => x.name)).toEqual([
    'cost',
    'compact',
    'context',
    'pr-comments',
    'clear',
  ])
})

test('completion: the command and a space', () => {
  expect(completion(c('compact'))).toBe('/compact ')
})

test('slashKey: arrows move, Tab and Enter complete, Enter on a whole command sends, Esc closes', () => {
  const k = (key: string, more: Partial<Parameters<typeof slashKey>[0]> = {}) => ({
    key,
    shiftKey: false,
    isComposing: false,
    ...more,
  })
  expect(slashKey(k('ArrowDown'), false)).toBe('next')
  expect(slashKey(k('ArrowUp'), false)).toBe('prev')
  expect(slashKey(k('Tab'), false)).toBe('complete')
  expect(slashKey(k('Tab', { shiftKey: true }), false)).toBe('prev')
  expect(slashKey(k('Enter'), false)).toBe('complete')
  expect(slashKey(k('Enter'), true)).toBeNull()
  expect(slashKey(k('Enter', { shiftKey: true }), false)).toBeNull()
  expect(slashKey(k('Escape'), false)).toBe('close')
  expect(slashKey(k('Enter', { isComposing: true }), false)).toBeNull()
  expect(slashKey(k('ArrowDown', { ctrlKey: true }), false)).toBeNull()
  expect(slashKey(k('a'), false)).toBeNull()
})

test('noteUse counts a sent command this list knows, and nothing else', () => {
  const data = new Map<string, string>()
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
  noteUse('/compact keep the plan', LIST, store)
  noteUse('/compact', LIST, store)
  noteUse('  /cost', LIST, store)
  noteUse('/unknown', LIST, store)
  noteUse('hello /compact', LIST, store)
  noteUse('/compact', null, store)
  expect(readUses(store)).toEqual({ compact: 2, cost: 1 })
})

test('readUses survives what another page left there', () => {
  const store = (v: string | null) => ({ getItem: () => v })
  expect(readUses(store('not json'))).toEqual({})
  expect(readUses(store('[1,2]'))).toEqual({})
  expect(readUses(store('{"a":2,"b":"x","c":-1}'))).toEqual({ a: 2 })
  expect(readUses(null)).toEqual({})
})
