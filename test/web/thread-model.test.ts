// The conversation as the sheet shows it (web/app.js thread, thumbs).
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ConversationTurn, ToolTurn } from '../../src/core/transcript.ts'
import { askState, threadParts, uploadThumbs } from '../../web/src/models/thread.ts'

const t = translator('en')
const tool = (label: string, done = true): ToolTurn => ({
  role: 'tool',
  label,
  detail: `${label} detail`,
  path: '',
  done,
  at: 1,
})

test('runs of tool calls fold into one line between messages; folds count in order', () => {
  const conversation: ConversationTurn[] = [
    { role: 'user', text: 'go', at: 1 },
    tool('Read'),
    tool('Edit'),
    { role: 'assistant', text: 'done', at: 2 },
    tool('Bash'),
  ]
  const parts = threadParts(conversation, { column: 'done', status: 'done' }, t)
  expect(parts.map(p => p.kind)).toEqual(['message', 'tools', 'message', 'tools'])
  const [, first, , second] = parts
  expect(first).toMatchObject({ kind: 'tools', i: 0, live: false, summary: '2 actions · Edit' })
  expect(second).toMatchObject({ kind: 'tools', i: 1, live: false, summary: '1 action · Bash' })
  expect(first?.kind === 'tools' && first.calls.map(c => c.label)).toEqual(['Read', 'Edit'])
})

test('a run whose last call has not finished is live while the session works', () => {
  const conversation: ConversationTurn[] = [tool('Read'), tool('Bash', false)]
  expect(threadParts(conversation, { column: 'work', status: 'working' }, t)[0]).toMatchObject({
    live: true,
    summary: 'Now: Bash',
  })
  expect(threadParts(conversation, { column: 'me', status: 'blocked' }, t)[0]).toMatchObject({
    live: false,
    summary: '2 actions · Bash',
  })
})

test('a question form is a turn of its own; it waits while the session is held at a dialog', () => {
  const ask: ToolTurn = { ...tool('Ask', false), ask: [{ question: 'Which?', header: 'Pick', multiSelect: false }] }
  const parts = threadParts([tool('Read'), ask, tool('Grep')], { column: 'me', status: 'blocked' }, t)
  expect(parts.map(p => p.kind)).toEqual(['tools', 'ask', 'tools'])
  const asked = parts[1]
  if (asked?.kind !== 'ask') throw new Error('no ask')
  expect(asked.live).toBe(true)
  expect(askState(asked.turn, true)).toBe('waiting')
  expect(askState(asked.turn, false)).toBe(null)
  expect(askState({ ...asked.turn, done: true }, true)).toBe('closed')
  expect(askState({ ...asked.turn, answers: ['A'] }, true)).toBe(null)
})

test('images sent from the board preview under the message, Windows and POSIX paths alike', () => {
  const text = [
    'see C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-17\\shot one#1.png',
    'and /home/me/.local/state/herdr/plugins/agent-board/uploads/2026-10-16/ok.JPEG.',
    'not C:\\x\\agent-board\\uploads\\2026-10-17\\doc.pdf',
  ].join('\n')
  expect(uploadThumbs(text)).toEqual([
    {
      path: '/home/me/.local/state/herdr/plugins/agent-board/uploads/2026-10-16/ok.JPEG',
      url: '/uploads/2026-10-16/ok.JPEG',
    },
  ])
  expect(
    uploadThumbs('C:\\a\\agent-board\\uploads\\2026-10-17\\a#b.png C:/b/agent-board/uploads/2026-10-17/c.webp'),
  ).toEqual([
    { path: 'C:\\a\\agent-board\\uploads\\2026-10-17\\a#b.png', url: '/uploads/2026-10-17/a%23b.png' },
    { path: 'C:/b/agent-board/uploads/2026-10-17/c.webp', url: '/uploads/2026-10-17/c.webp' },
  ])
  expect(uploadThumbs(undefined)).toEqual([])
})
