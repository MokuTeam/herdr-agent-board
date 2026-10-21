import { describe, expect, test } from 'bun:test'
import { COLUMN_KEYS, LETTER_KEYS } from '../../src/core/board-keys.ts'
import { ACTION, hitAt, KEYMAP, parseMouse, tokens } from '../../src/tui/input.ts'

describe('tokens', () => {
  test('splits an arrow key, a letter and a mouse report', () => {
    expect(tokens('\x1b[A' + 'j' + '\x1b[<0;10;5M')).toEqual(['\x1b[A', 'j', '\x1b[<0;10;5M'])
  })

  test('keeps SS3 keys, a lone Escape, paste markers and Cyrillic letters apart', () => {
    expect(tokens('\x1bOB\x1b\x1b[200~я\x1b[201~')).toEqual(['\x1bOB', '\x1b', '\x1b[200~', 'я', '\x1b[201~'])
  })

  test('a release report and a wheel report are single tokens', () => {
    expect(tokens('\x1b[<0;10;5m\x1b[<64;1;1M')).toEqual(['\x1b[<0;10;5m', '\x1b[<64;1;1M'])
  })

  test('empty input has no tokens', () => {
    expect(tokens('')).toEqual([])
  })
})

describe('keymap', () => {
  test('a Latin key and its Russian-layout twin run the same action', () => {
    expect(ACTION.get('k')).toBe('up')
    expect(ACTION.get('л')).toBe('up')
    expect(ACTION.get('\x03')).toBe('exit')
    expect(ACTION.get('\x1b')).toBe('quit')
    expect(ACTION.get('?')).toBeUndefined()
    // A favorite or not (#64): f, а on a Russian layout.
    expect(ACTION.get('f')).toBe('favorite')
    expect(ACTION.get('а')).toBe('favorite')
  })

  test('no key belongs to two actions', () => {
    const keys = Object.values(KEYMAP).flat()
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('mouse', () => {
  test('parses a press, a release and the wheel', () => {
    expect(parseMouse('\x1b[<0;10;5M')).toEqual({ button: 0, x: 10, y: 5, press: true })
    expect(parseMouse('\x1b[<0;10;5m')).toEqual({ button: 0, x: 10, y: 5, press: false })
    expect(parseMouse('\x1b[<65;120;40M')).toEqual({ button: 65, x: 120, y: 40, press: true })
  })

  test('anything else is not a mouse report', () => {
    expect(parseMouse('\x1b[A')).toBeNull()
    expect(parseMouse('x\x1b[<0;1;1M')).toBeNull()
  })

  test('hitAt finds the card under a column on a line', () => {
    const hits = [
      [],
      [
        { x0: 2, x1: 10, key: 'a' },
        { x0: 11, x1: 20, key: 'b' },
      ],
    ]
    expect(hitAt(hits, 1, 11)?.key).toBe('b')
    expect(hitAt(hits, 1, 1)).toBeUndefined()
    expect(hitAt(hits, 0, 5)).toBeUndefined()
    expect(hitAt(hits, -3, 5)).toBeUndefined()
  })
})

describe('the keys the web board shares (#161)', () => {
  test('every letter is the action it is in core/board-keys.ts, and the new ones come with nothing taken from an old one', () => {
    for (const [name, keys] of Object.entries(LETTER_KEYS))
      for (const k of keys) expect([k, ACTION.get(k)]).toEqual([k, name])
    // G and End go to the last card, / searches; on a Russian layout П and the . on the / key.
    expect(['G', 'П', '\x1b[F', '\x1b[4~'].map(k => ACTION.get(k))).toEqual(['last', 'last', 'last', 'last'])
    expect(['/', '.'].map(k => ACTION.get(k))).toEqual(['search', 'search'])
    // A capital shows one column alone: none of them is an action of its own.
    for (const keys of Object.values(COLUMN_KEYS)) for (const k of keys) expect(ACTION.get(k)).toBeUndefined()
  })

  test('the keys the board had before stay as they were', () => {
    const before: Record<string, readonly string[]> = {
      up: ['\x1b[A', '\x1bOA', 'k', 'л'],
      down: ['\x1b[B', '\x1bOB', 'j', 'о'],
      right: ['\x1b[C', '\x1bOC', 'l', 'д', '\t'],
      left: ['\x1b[D', '\x1bOD', 'h', 'р', '\x1b[Z'],
      home: ['\x1b[H', '\x1b[1~', 'g', 'п'],
      enter: ['\r', '\n'],
      quit: ['q', 'й', '\x1b'],
      exit: ['\x03'],
      message: ['m', 'ь'],
      wait: ['w', 'ц'],
      clear: ['x', 'ч'],
      sleep: ['z', 'я'],
      favorite: ['f', 'а'],
      category: ['c', 'с'],
      refresh: ['r', 'к'],
      web: ['o', 'щ'],
    }
    for (const [name, keys] of Object.entries(before)) expect([name, KEYMAP[name]]).toEqual([name, keys])
  })
})
