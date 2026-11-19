import { expect, test } from 'bun:test'
import { codexDraft } from '../../src/core/dialogs/codex-input.ts'

// Codex 0.169's composer in an `herdr agent read --ansi` capture: a bold "›", the placeholder dim.
const footer = '\x1b[22m \x1b[2mGPT-6.1-Sol default · ~/work\x1b[0m\n \x1b[2m? for shortcuts\x1b[0m'
const screen = (line: string): string => `  To get started, describe a task\n\n${line}\n${footer}`

test('the dim placeholder is no draft, typed text is', () => {
  expect(codexDraft(screen('\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[0m'))).toBe('')
  expect(codexDraft(screen('\x1b[1m›\x1b[22m hello draft'))).toBe('hello draft')
  expect(codexDraft(screen('\x1b[1m›\x1b[22m '))).toBe('')
  expect(codexDraft(screen('› Привет, 100% мир'))).toBe('Привет, 100% мир')
})

test('the last composer on the screen counts; one above a newer line does not hide it', () => {
  expect(codexDraft(`› old text\n${screen('› new')}`)).toBe('new')
  expect(codexDraft(`${screen('› typed')}\r\nmore output`)).toBe('typed')
})

test('no composer, or the highlighted option of a dialog, is null', () => {
  expect(codexDraft('')).toBeNull()
  expect(codexDraft(undefined)).toBeNull()
  expect(codexDraft('Working (3s • esc to interrupt)')).toBeNull()
  expect(codexDraft('  Allow command?\n› 1. Yes, proceed (y)\n  2. No (esc)')).toBeNull()
})
