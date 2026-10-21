// The terminal board's keys on the web board in its Terminal style (web/src/models/terminal-keys.ts,
// #161): the same letters as on the terminal board, and none while typing, in the quick look or with
// a modifier held; the arrows only on the board, so a panel keeps scrolling by them.
import { describe, expect, test } from 'bun:test'
import type { Dir } from '../../src/core/grid-nav.ts'
import { boardKey, type KeyScene } from '../../web/src/models/board-keys.ts'
import { type CardAct, type TerminalScene, terminalKey } from '../../web/src/models/terminal-keys.ts'

const press = (
  key: string,
  mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})
const scene: TerminalScene = { typing: false, quickLook: false, onBoard: true, column: null }

describe('the terminal board’s keys', () => {
  test('moving: h j k l, the arrows, g and G, Home and End; on a Russian layout the same keys', () => {
    const dirs = ['h', 'j', 'k', 'l', 'g', 'G', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'Home', 'End', 'о']
    const want: Dir[] = [
      'left',
      'down',
      'up',
      'right',
      'home',
      'last',
      'left',
      'down',
      'up',
      'right',
      'home',
      'last',
      'down',
    ]
    expect(dirs.map(k => terminalKey(press(k), scene))).toEqual(want.map(dir => ({ kind: 'move' as const, dir })))
  })

  test('a card’s keys, refresh, close; lanes by digit; a column alone by its capital, Escape for all again', () => {
    expect(['m', 'w', 'x', 'z', 'f', 'c', 'ц'].map(k => terminalKey(press(k), scene))).toEqual(
      (['message', 'wait', 'clear', 'sleep', 'favorite', 'category', 'wait'] as CardAct[]).map(act => ({
        kind: 'card' as const,
        act,
      })),
    )
    expect(terminalKey(press('r'), scene)).toEqual({ kind: 'refresh' })
    expect(terminalKey(press('q'), scene)).toEqual({ kind: 'close' })
    expect(terminalKey(press('0'), scene)).toEqual({ kind: 'lane', n: 0 })
    expect(terminalKey(press('3'), scene)).toEqual({ kind: 'lane', n: 3 })
    expect(terminalKey(press('W', { shiftKey: true }), scene)).toEqual({ kind: 'column', column: 'work' })
    expect(terminalKey(press('O', { shiftKey: true }), scene)).toEqual({ kind: 'column', column: 'ext' })
    expect(terminalKey(press('Escape'), scene)).toBeNull()
    expect(terminalKey(press('Escape'), { ...scene, column: 'me' })).toEqual({ kind: 'allColumns' })
    // o opens the page the terminal board serves (this one); / is the board's own search.
    expect(terminalKey(press('o'), scene)).toBeNull()
    expect(terminalKey(press('/'), scene)).toBeNull()
  })

  test('none while typing, in the quick look, or with Ctrl, Alt or Cmd; the arrows only on the board', () => {
    for (const key of ['j', 'm', 'W', '1', 'ArrowDown']) {
      expect(terminalKey(press(key), { ...scene, typing: true })).toBeNull()
      expect(terminalKey(press(key), { ...scene, quickLook: true })).toBeNull()
      for (const mod of ['ctrlKey', 'altKey', 'metaKey'])
        expect(terminalKey(press(key, { [mod]: true }), scene)).toBeNull()
    }
    expect(terminalKey(press('ArrowDown'), { ...scene, onBoard: false })).toBeNull()
    expect(terminalKey(press('j'), { ...scene, onBoard: false })).toEqual({ kind: 'move', dir: 'down' })
  })

  test('the board’s own keys come first, and leave these alone (the page asks this only for a key they leave)', () => {
    const own: KeyScene = {
      typing: false,
      inSearch: false,
      panelOpen: false,
      query: '',
      quickLook: false,
      digits: false,
    }
    // n, Shift+N, / and F2 are the board's; the terminal board's letters are none of them.
    for (const key of [
      'h',
      'j',
      'k',
      'l',
      'g',
      'G',
      'm',
      'w',
      'x',
      'z',
      'f',
      'c',
      'r',
      'q',
      'W',
      'M',
      'O',
      'D',
      'I',
      '0',
      '5',
    ])
      expect([key, boardKey(press(key), own)]).toEqual([key, null])
    // Digits answer the question on show first.
    expect(boardKey(press('1'), { ...own, digits: true })).toBe('digit')
  })
})
