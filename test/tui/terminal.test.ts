import { describe, expect, test } from 'bun:test'
import { useLanguage } from '../../src/core/lang.ts'
import { age, charWidth, fit, paint, width } from '../../src/tui/terminal.ts'

describe('width', () => {
  test('counts cells: Latin, Cyrillic, CJK, symbols', () => {
    expect(width('abc')).toBe(3)
    expect(width('Привет')).toBe(6)
    expect(width('日本')).toBe(4)
    expect(width('✓')).toBe(1)
  })

  test('control and combining characters take no cells, emoji take two', () => {
    expect(charWidth(0x1b)).toBe(0)
    expect(charWidth(0x301)).toBe(0)
    expect(width('⏰')).toBe(2)
    expect(width('🚀')).toBe(2)
  })
})

describe('fit', () => {
  test('pads and cuts to exactly the width', () => {
    expect(fit('ab', 5)).toBe('ab   ')
    expect(fit('Привет мир', 6)).toBe('Приве…')
    expect(width(fit('Привет мир', 6))).toBe(6)
    expect(width(fit('日本語テキスト', 7))).toBe(7)
    expect(fit('abc', 0)).toBe('')
  })

  test('control characters become spaces and nothing becomes empty', () => {
    expect(fit('a\x1b[31mb\nc', 12)).toBe('a [31mb c   ')
    expect(fit(undefined, 3)).toBe('   ')
  })
})

describe('paint', () => {
  test('wraps in the style codes and skips unknown or empty styles', () => {
    expect(paint('x', 'bold', 'red')).toBe('\x1b[1;31mx\x1b[0m')
    expect(paint('x', null, false, undefined, 'nope')).toBe('x')
  })
})

describe('age', () => {
  test('minutes, hours, days since a time; empty without one', () => {
    useLanguage('en')
    const now = 10 * 86_400_000
    expect(age(0, now)).toBe('')
    expect(age(now - 30_000, now)).toBe('<1m')
    expect(age(now - 5 * 60_000, now)).toBe('5m')
    expect(age(now - 3 * 3_600_000, now)).toBe('3h')
    expect(age(now - 2 * 86_400_000, now)).toBe('2d')
  })
})
