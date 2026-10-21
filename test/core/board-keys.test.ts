// The board's keys as letters, one set for the terminal board and the web board's Terminal style
// (src/core/board-keys.ts, #161), and moving across the board by them (src/core/grid-nav.ts).
import { describe, expect, test } from 'bun:test'
import { COLUMN_KEYS, columnKey, LETTER_KEYS, letterAction, toggledColumn } from '../../src/core/board-keys.ts'
import { gridStep, listStep } from '../../src/core/grid-nav.ts'

describe('letters', () => {
  test('each letter and its Russian twin take one action; no key is two', () => {
    expect(['k', 'л', 'G', 'П', 'w', 'ц', '/', '.'].map(letterAction)).toEqual([
      'up',
      'up',
      'last',
      'last',
      'wait',
      'wait',
      'search',
      'search',
    ])
    expect(letterAction('W')).toBeNull()
    const keys = [...Object.values(LETTER_KEYS).flat(), ...Object.values(COLUMN_KEYS).flat()]
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('a capital shows its column alone; the same one again shows them all', () => {
    expect(['W', 'M', 'O', 'D', 'I', 'Ц', 'Ш', 'w', 'X'].map(columnKey)).toEqual([
      'work',
      'me',
      'ext',
      'done',
      'idle',
      'work',
      'idle',
      null,
      null,
    ])
    expect(toggledColumn(null, 'work')).toBe('work')
    expect(toggledColumn('work', 'me')).toBe('me')
    expect(toggledColumn('me', 'me')).toBeNull()
  })
})

describe('moving', () => {
  const k = (...keys: string[]) => keys.map(key => ({ key }))
  // Lane 1: a | b c | - ; lane 2: - | - | d
  const grid = [{ cols: [k('a'), k('b', 'c'), k()] }, { cols: [k(), k(), k('d')] }]

  test('a list: one step back or on, the ends for home and last; from nowhere, the first', () => {
    const list = k('a', 'b', 'c')
    expect(['up', 'down', 'home', 'last'].map(dir => listStep(list, 'b', dir as 'up'))).toEqual(['a', 'c', 'a', 'c'])
    expect(listStep(list, 'a', 'up')).toBe('a')
    expect(listStep(list, 'c', 'down')).toBe('c')
    expect(listStep([], null, 'home')).toBeNull()
  })

  test('a grid: left and right in the lane, up and down into the lanes around, at the nearest column', () => {
    expect(gridStep(grid, 'a', 'right')).toBe('b')
    expect(gridStep(grid, 'c', 'left')).toBe('a')
    expect(gridStep(grid, 'b', 'down')).toBe('c')
    expect(gridStep(grid, 'c', 'down')).toBe('d')
    expect(gridStep(grid, 'd', 'up')).toBe('c')
    expect(gridStep(grid, 'b', 'right')).toBeNull()
    expect(gridStep(grid, 'x', 'down')).toBeNull()
  })
})
