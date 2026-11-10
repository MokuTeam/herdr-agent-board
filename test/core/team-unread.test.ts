// The team's unread count and a notification's words (#355, core/team-unread.ts).
import { expect, test } from 'bun:test'
import { isThreadKey, TOAST_CHARS, toastBody, unreadByThread } from '../../src/core/team-unread.ts'

const A = 'A'.repeat(43)

test('a thread key: a peer or team, then general or a thread id (#216); nothing else', () => {
  for (const ok of [`${A}/general`, 'team/general', `${A}/0123abcd-4567-49ab-8def-0123456789ab`])
    expect(isThreadKey(ok)).toBe(true)
  for (const bad of [
    A,
    `${A}/`,
    `${A}/topic`,
    `${A}/../general`,
    'team/0123ABCD-4567-49AB-8DEF-0123456789AB',
    'team/0123abcd-4567-89ab-cdef-0123456789ab',
    `x${A}/general`,
    'other/general',
    7,
  ])
    expect(isThreadKey(bad)).toBe(false)
})

test('unread: after the later of since and the thread’s mark; a muted thread none', () => {
  const reads = { since: 100, threads: { [`${A}/general`]: 300 } }
  const incoming = [
    { thread: `${A}/general`, at: 50 },
    { thread: `${A}/general`, at: 250 },
    { thread: `${A}/general`, at: 350 },
    { thread: 'team/general', at: 50 },
    { thread: 'team/general', at: 150 },
  ]
  expect(unreadByThread(incoming, reads, () => false)).toEqual({ [`${A}/general`]: 1, 'team/general': 1 })
  expect(unreadByThread(incoming, reads, th => th === 'team/general')).toEqual({ [`${A}/general`]: 1 })
})

test('a notification’s words: one line, printable, cut with an ellipsis', () => {
  expect(toastBody('  two\n\nlines\there ')).toBe('two lines here')
  expect(toastBody('a\u0007b')).toBe('a\\u{7}b')
  const long = toastBody('x'.repeat(TOAST_CHARS + 50))
  expect(long).toBe(`${'x'.repeat(TOAST_CHARS)}…`)
  expect(toastBody('y'.repeat(TOAST_CHARS))).toBe('y'.repeat(TOAST_CHARS))
  expect(toastBody('a long topic title', 6)).toBe('a long…')
})
