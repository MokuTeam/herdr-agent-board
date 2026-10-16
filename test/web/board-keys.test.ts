// The board's keys, pinned from the old keydown handler (web/app.js:1965-1996): which action a
// key press takes, given what is open and focused.
import { describe, expect, test } from 'bun:test'
import { boardKey, type KeyPress, type KeyScene } from '../../web/src/models/board-keys.ts'

const press = (key: string, mods: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
})
const scene = (fields: Partial<KeyScene> = {}): KeyScene => ({
  typing: false,
  panelOpen: false,
  query: '',
  quickLook: false,
  digits: false,
  ...fields,
})

describe('Escape', () => {
  test('leaves a text field first, then closes the panel, then clears the search', () => {
    expect(boardKey(press('Escape'), scene({ typing: true, panelOpen: true, query: 'x' }))).toBe('blur')
    expect(boardKey(press('Escape'), scene({ panelOpen: true, query: 'x' }))).toBe('closePanel')
    expect(boardKey(press('Escape'), scene({ query: 'x' }))).toBe('clearQuery')
    expect(boardKey(press('Escape'), scene())).toBeNull()
  })
})

describe('N', () => {
  test('N (Т on a Russian layout) opens the next card that needs you', () => {
    for (const key of ['n', 'N', 'т', 'Т']) expect(boardKey(press(key), scene())).toBe('next')
  })

  test('Shift+N starts a new session', () => {
    expect(boardKey(press('N', { shiftKey: true }), scene())).toBe('newSession')
    expect(boardKey(press('Т', { shiftKey: true }), scene())).toBe('newSession')
  })

  test('not while typing, with Cmd, Ctrl or Alt, or over the quick look', () => {
    for (const s of [scene({ typing: true }), scene({ quickLook: true })]) {
      expect(boardKey(press('n'), s)).toBeNull()
      expect(boardKey(press('N', { shiftKey: true }), s)).toBeNull()
    }
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(boardKey(press('n', { [mod]: true }), scene())).toBeNull()
      expect(boardKey(press('N', { shiftKey: true, [mod]: true }), scene())).toBeNull()
    }
  })
})

test('F2 renames, unless typing or over the quick look', () => {
  expect(boardKey(press('F2'), scene())).toBe('rename')
  expect(boardKey(press('F2'), scene({ typing: true }))).toBeNull()
  expect(boardKey(press('F2'), scene({ quickLook: true }))).toBeNull()
})

test('digits 1–9 pick an option of the open question when the sheet or its card has the focus', () => {
  for (const key of ['1', '5', '9']) expect(boardKey(press(key), scene({ digits: true }))).toBe('digit')
  expect(boardKey(press('1'), scene({ digits: true, typing: true }))).toBe('digit') // the sheet checks the field
  expect(boardKey(press('0'), scene({ digits: true }))).toBeNull()
  expect(boardKey(press('1'), scene())).toBeNull()
  expect(boardKey(press('1'), scene({ digits: true, quickLook: true }))).toBeNull()
})

test('/ goes to the search, unless typing', () => {
  expect(boardKey(press('/'), scene())).toBe('search')
  expect(boardKey(press('/'), scene({ typing: true }))).toBeNull()
})

test('other keys do nothing', () => {
  for (const key of ['a', 'Enter', 'ArrowDown', ' ']) expect(boardKey(press(key), scene())).toBeNull()
})
