import { expect, test } from 'bun:test'
import { inputDraft } from '../../src/core/dialogs/input-box.ts'

const rule = '─'.repeat(40)
const ESC = '\x1b'
const grey = (s: string): string => `${ESC}[0m${ESC}[38;2;136;136;136m${s}${ESC}[0m`
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

// Captured from Claude Code (stub API) after /rename, in a pane 120 columns wide: the rule over
// the box carries the name at its right end, as wide as the rule under the box, and a name longer
// than the rule takes its whole start, cut with "…" (#484). Before, such a box read as a dialog:
// no message from the card, no archive, no sleep.
test('the rule over the box may carry the session name, however long', () => {
  const wide = '─'.repeat(119)
  const named = (top: string, text = `${ESC}[7m ${ESC}[0m`, bottom = wide): string =>
    [
      grey(top),
      `❯ ${ESC}[0m${text}`,
      grey(bottom),
      `  ${ESC}[0m${ESC}[38;2;255;193;7m⏵⏵ auto mode on${ESC}[0m${ESC}[38;2;153;153;153m (shift+tab to cycle)${ESC}[0m`,
    ].join('\n')
  expect(inputDraft(named(`${'─'.repeat(105)} anna#1 ─`))).toBe('')
  const long =
    ' anna-1# Brief: board issue(s) #1, #2 Board agent. Work in thread atlas-1: post your status there. The owner asks to… ─'
  expect(inputDraft(named(long))).toBe('')
  expect(inputDraft(named(long, 'hello'))).toBe('hello')
  // A name a little shorter than the rule leaves a few dashes before it.
  expect(inputDraft(named(`─── ${'b'.repeat(113)} ─`, 'typed'))).toBe('typed')
  // Not that rule: a heading that ends in a dash over a picker, one wider or narrower than the rule
  // under it, a line of text over a picker's cursor, a box with no rule under it.
  expect(inputDraft(named('  Pick one ─', '1. Yes\n  2. No'))).toBeNull()
  expect(inputDraft(named(long, '', '─'.repeat(80)))).toBeNull()
  expect(inputDraft('Pick one:\n❯ 1. Yes\n  2. No')).toBeNull()
  expect(inputDraft(`${grey(long)}\n❯ Continue\n  Cancel`)).toBeNull()
})
