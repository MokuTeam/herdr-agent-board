// Reading Claude Code's /btw overlay off the screen (core/aside.ts). The screens are captures of
// Claude Code 2.1.284 in a 110×40 terminal (herdr agent read --source visible), shortened above.
import { expect, test } from 'bun:test'
import { ASIDE_MAX, btwLine, mergeScroll, readBtw } from '../../src/core/aside.ts'

const RULE = '▔'.repeat(110)
const HEAD = [
  '❯ Remember: the code word is PINEAPPLE. When a reply from me arrives, run the shell command: echo got-reply.  ',
  "  For now just answer 'ready'.",
  '',
  '● ready',
]
const FOOTER = '    ↑/↓ to scroll · c to copy · f to fork · Esc to close'
const screen = (...lines: string[]) => [...HEAD, ...lines].join('\n')
const Q = 'what is 2+2? answer with one word'

test('the line typed: /btw and the question on one line; a question stays under a paste Claude Code would fold', () => {
  expect(btwLine('  what was\n the code   word? ')).toBe('/btw what was the code word?')
  // Over 800 characters Claude Code folds a paste into "[Pasted text #1]", sent as a message.
  expect(ASIDE_MAX).toBe(790)
  expect(btwLine('x'.repeat(ASIDE_MAX)).length).toBeLessThanOrEqual(800)
})

test('an answered overlay: the answer without its indent', () => {
  const s = screen(RULE, '', `    /btw ${Q}`, '', '      Four', '', FOOTER)
  expect(readBtw(s, Q)).toEqual({ state: 'answered', lines: ['Four'] })
  // Spaces in the question as typed do not matter: it went on one line.
  expect(readBtw(s, `  what is 2+2?\nanswer with one word `)).toEqual({ state: 'answered', lines: ['Four'] })
})

test('still answering: the spinner, and a footer with nothing but Esc', () => {
  expect(readBtw(screen(RULE, '', `    /btw ${Q}`, '', '      ✽ Answering…', '', '    Esc to close'), Q)).toEqual({
    state: 'answering',
  })
  expect(readBtw(screen(RULE, '', `    /btw ${Q}`, '', '      · Answering…', '', '    Esc to close'), Q)).toEqual({
    state: 'answering',
  })
})

test('no overlay, or another question in it: never read as ours', () => {
  const box = ['─'.repeat(110), `❯ /btw ${Q}`, '─'.repeat(110), '  ⏵⏵ auto mode on (shift+tab to cycle)']
  // Typed in the input box, not yet asked; the earlier prompt in the conversation is not an overlay.
  expect(readBtw(screen(...box), Q)).toEqual({ state: 'none' })
  expect(readBtw(screen(`❯ /btw ${Q}`, '● Four'), Q)).toEqual({ state: 'none' })
  // A dialog has "Esc to close" too, but no rule and no /btw line over it.
  expect(readBtw(screen('  Select model', '  ❯ 1. Opus', '  Esc to close'), Q)).toEqual({ state: 'none' })
  expect(readBtw(screen(RULE, '', '    /btw which file?', '', '      a.ts', '', FOOTER), Q)).toEqual({ state: 'other' })
  expect(readBtw('', Q)).toEqual({ state: 'none' })
})

test('earlier questions above it, a notice in its rule, a long question cut short: the last question line is ours', () => {
  const long = `ignore this filler: ${'lorem ipsum '.repeat(20)}-- what is 3+4?`
  const shown = `${btwLine(long).slice(0, 100)}…`
  const s = screen(
    `▔▔▔▔ You've used 88% of your weekly limit ${'▔'.repeat(60)}`,
    '',
    '    /btw what is 2+2? answer with one word',
    `    ${shown}`,
    '',
    '      Seven',
    '',
    '    ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close',
  )
  expect(readBtw(s, long)).toEqual({ state: 'answered', lines: ['Seven'] })
  expect(readBtw(s, Q)).toEqual({ state: 'other' })
  // Cut short, it must still be the start of ours.
  expect(readBtw(s, `another ${long}`)).toEqual({ state: 'other' })
})

test('a longer answer keeps its own indent and blank lines; the frame around it goes', () => {
  const s = screen(
    RULE,
    '',
    `    /btw ${Q}`,
    '',
    '      Two options:',
    '',
    '      - first',
    '        wrapped on',
    '      - second',
    '',
    FOOTER,
  )
  expect(readBtw(s, Q)).toEqual({
    state: 'answered',
    lines: ['Two options:', '', '- first', '  wrapped on', '- second'],
  })
})

const squares = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i} ${(from + i) ** 2}`)

test('scrolled: lines in sight meet the lines read before, blank lines and repeats included', () => {
  expect(mergeScroll(squares(1, 26), squares(4, 29))).toEqual(squares(1, 29))
  expect(mergeScroll(squares(1, 29), [...squares(22, 45), '', 'done'])).toEqual([...squares(1, 45), '', 'done'])
  // Nothing new in sight: as it was.
  expect(mergeScroll(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  expect(mergeScroll(['a', '', 'b', ''], ['b', '', 'c'])).toEqual(['a', '', 'b', '', 'c'])
  expect(mergeScroll([], ['a'])).toEqual(['a'])
})
