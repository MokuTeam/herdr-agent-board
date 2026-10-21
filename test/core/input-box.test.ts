import { expect, test } from 'bun:test'
import { inputDraft } from '../../src/core/dialogs/input-box.ts'

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
