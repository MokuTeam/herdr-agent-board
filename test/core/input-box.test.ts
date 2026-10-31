import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { inputDraft, PICTURE_PATH, stillPasting } from '../../src/core/dialogs/input-box.ts'

const rule = '─'.repeat(40)
const box = (text: string, footer = '  ⏵⏵ bypass permissions on'): string =>
  [rule, `❯ ${text}`, rule, footer].join('\n')

test('a complete current input box preserves multiline text and ignores a dim suggestion', () => {
  expect(inputDraft(box(''))).toBe('')
  expect(inputDraft(box('\x1b[2mTry fixing the tests\x1b[0m'))).toBe('')
  expect(inputDraft(box('first\n  second line'))).toBe('first\n  second line')
  expect(inputDraft(box('Explain\n  Esc to cancel'))).toBe('Explain\n  Esc to cancel')
  expect(inputDraft(box('Explain this terminal snippet:\n  ❯ bun test'))).toBe(
    'Explain this terminal snippet:\n  ❯ bun test',
  )
  expect(inputDraft(box('typed', '  esc to interrupt · tab to accept'))).toBe('typed')
  expect(inputDraft(`Earlier question: Esc to cancel\n${box('current')}`)).toBe('current')
})

test('an old input box is not evidence that a later dialog takes messages', () => {
  expect(inputDraft(`${box('')}\nTeach auto mode?\n   ❯ Continue\n   Esc to cancel`)).toBeNull()
  expect(inputDraft(`${box('')}\nUnknown dialog\nEnter to continue`)).toBeNull()
  expect(inputDraft(`${rule}\n❯ Continue\n  Cancel`)).toBeNull()
  expect(inputDraft(`${rule}\n❯ `)).toBeNull()
  expect(inputDraft('')).toBeNull()
})

// Claude Code 2.1.308 in herdr, captured with `agent read --source visible --ansi`: a screenshot's
// path pasted, then the box once it was read.
const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8')

test('a paste still being read: "Pasting…" under the box, the box empty', () => {
  expect(stillPasting(screen('claude-pasting'))).toBe(true)
  expect(stillPasting(screen('claude-pasting').replaceAll('\n', '\r\n'))).toBe(true)
  expect(inputDraft(screen('claude-pasting'))).toBe('')
  expect(stillPasting(box('', '  Pasting...'))).toBe(true)
})

test('the picture in the box, an empty box, and "Pasting…" anywhere else are not a paste being read', () => {
  expect(stillPasting(screen('claude-picture-in-box'))).toBe(false)
  expect(inputDraft(screen('claude-picture-in-box'))).toBe(
    '[Image #3]the browser icon looks broken on the tablet\n  Файл:',
  )
  expect(stillPasting(box(''))).toBe(false)
  expect(stillPasting(box('Pasting…'))).toBe(false)
  expect(stillPasting(`  Pasting…\n${box('')}`)).toBe(false)
  expect(stillPasting(box('', '  Pasting… more'))).toBe(false)
  expect(stillPasting('')).toBe(false)
  expect(stillPasting(null)).toBe(false)
})

test('the paths Claude Code takes in as pictures: its own extensions, any case, on any system', () => {
  for (const path of [
    '/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/054431-screenshot-074431.png',
    'C:\\Users\\Team Work\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-31\\074431-снимок-100%.PNG',
    '/uploads/2026-10-31/IMG-0001.jpeg',
    '/uploads/2026-10-31/photo.JPG',
    '/uploads/2026-10-31/a.gif',
    '/uploads/2026-10-31/a.webp',
  ])
    expect(PICTURE_PATH.test(path)).toBe(true)
  for (const path of [
    '/uploads/2026-10-31/notes.pdf',
    '/uploads/2026-10-31/a.heic',
    '/uploads/a.png.txt',
    '/uploads/png',
  ])
    expect(PICTURE_PATH.test(path)).toBe(false)
})
