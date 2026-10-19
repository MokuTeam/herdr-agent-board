import { describe, expect, test } from 'bun:test'
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
