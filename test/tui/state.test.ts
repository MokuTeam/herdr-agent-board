import { describe, expect, test } from 'bun:test'
import type { Config, Item } from '../../src/core/types.ts'
import { build, createState, move, type TuiState } from '../../src/tui/state.ts'

const cfg: Config = {
  language: 'en',
  categories: [
    { id: 'work', title: 'Work', color: 'cyan', paths: [] },
    { id: 'personal', title: 'Personal', color: 'green', paths: [] },
  ],
  placement: 'workspace',
  workspace: 'Board',
  refreshSec: 2,
  wakeUrl: null,
  scheduleWaitMin: 240,
}

const item = (key: string, category: string, column: Item['column']): Item => ({
  key,
  session: null,
  pane: null,
  workspace: null,
  cwd: '',
  status: 'idle',
  name: key,
  autoName: key,
  category,
  categorySet: true,
  column,
  attention: '',
})

function board(): TuiState {
  const state = createState(cfg, true)
  // work: a (work), b (me), c (me); personal: d (work)
  state.items = [
    item('a', 'work', 'work'),
    item('b', 'work', 'me'),
    item('c', 'work', 'me'),
    item('d', 'personal', 'work'),
  ]
  build(state)
  return state
}

describe('build', () => {
  test('groups items into lanes in config order and selects the first', () => {
    const state = board()
    expect(state.allCats).toEqual(['work', 'personal'])
    expect(state.lanes.map(l => l.num)).toEqual([1, 2])
    expect(state.sel).toBe('a')
  })

  test('a filter keeps one lane; an unknown filter is dropped', () => {
    const state = board()
    state.filter = 'personal'
    build(state)
    expect(state.lanes.map(l => l.cat)).toEqual(['personal'])
    expect(state.sel).toBe('d')
    state.filter = 'gone'
    build(state)
    expect(state.filter).toBeNull()
    expect(state.lanes).toHaveLength(2)
  })
})

describe('move', () => {
  test('wide: right and left stay in the lane, down crosses lanes in the same column', () => {
    const state = board()
    expect(move(state, 'right', true)).toBe(true)
    expect(state.sel).toBe('b')
    expect(move(state, 'down', true)).toBe(true)
    expect(state.sel).toBe('c')
    expect(move(state, 'left', true)).toBe(true)
    expect(state.sel).toBe('a')
    expect(move(state, 'down', true)).toBe(true)
    expect(state.sel).toBe('d')
    expect(move(state, 'down', true)).toBe(false)
    expect(move(state, 'up', true)).toBe(true)
    expect(state.sel).toBe('a')
  })

  test('wide: up and down reach a lane with nothing in this column, at its nearest column', () => {
    const state = board()
    state.sel = 'c'
    expect(move(state, 'down', true)).toBe(true)
    expect(state.sel).toBe('d')
    state.items = [...state.items, item('e', 'personal', 'idle')]
    build(state)
    state.sel = 'e'
    expect(move(state, 'up', true)).toBe(true)
    expect(state.sel).toBe('c')
  })

  test('narrow: a plain list in column order, home goes to the first', () => {
    const state = board()
    move(state, 'down', false)
    expect(state.sel).toBe('b')
    move(state, 'down', false)
    move(state, 'down', false)
    move(state, 'down', false)
    expect(state.sel).toBe('d')
    move(state, 'home', true)
    expect(state.sel).toBe('a')
  })
})
