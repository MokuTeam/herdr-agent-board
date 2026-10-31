// A message with a picture that reached the session while it worked (core/sent-pictures.ts): Claude
// Code keeps it as a queued command with no line naming the picture's file, so the thread had
// "[Image #9]…\nФайл:" with no file. The board's record of what it sent gives the path back; every
// other turn stays as it was. The transcript lines are Claude Code 2.1.308's, from the owner's
// session (the pictures' data cut short).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { messageKey } from '../../src/core/message-key.ts'
import { picturesBack, SENT_WITHIN_MS, type SentPictures } from '../../src/core/sent-pictures.ts'
import { parseConversation } from '../../src/core/transcript.ts'

const LINES = readFileSync(new URL('../fixtures/queued-picture.jsonl', import.meta.url), 'utf8').split('\n')
const UPLOAD = '/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/070429-screenshot-090429.png'
/** What the board typed: the owner's words, then the line naming the file and its path. */
const TYPED = `кнопки «открыть его браузер» я не вижу\n\nФайл:\n${UPLOAD}`
/** When the board typed it: 25 s after the upload, a moment before Claude Code queued it (06:04:54.484). */
const AT = Date.parse('2026-10-31T06:04:54.300Z')
const sent = (more: Partial<SentPictures> = {}): SentPictures[] => [
  { session: 's1', key: messageKey(TYPED), pictures: [UPLOAD], at: AT, ...more },
]

/** The thread with the record's paths given back to its user turns, as the session's detail does. */
const thread = (lines: string[], records: SentPictures[]) =>
  parseConversation(lines).map(m => (m.role === 'user' ? { ...m, text: picturesBack(m.text, m.at, () => records) } : m))

test('a picture sent while the session worked: its path back under the message, as a message sent while idle has it', () => {
  const before = parseConversation(LINES)
  const after = thread(LINES, sent())
  expect(before.at(-1)).toEqual({
    role: 'user',
    text: '[Image #9]кнопки «открыть его браузер» я не вижу\nФайл:',
    at: Date.parse('2026-10-31T06:04:54.484Z'),
  })
  expect(after.at(-1)).toEqual({
    role: 'user',
    text: `кнопки «открыть его браузер» я не вижу\nФайл:\n${UPLOAD}`,
    at: Date.parse('2026-10-31T06:04:54.484Z'),
  })
  // The message sent while idle (its meta line named the file), the task's notice and the
  // text-only message sent while it worked are as they were.
  expect(after.slice(0, -1)).toEqual(before.slice(0, -1))
  expect(before[0]).toMatchObject({
    role: 'user',
    text: expect.stringMatching(/\nФайл:\n\/home\/.+055345-screenshot-075345\.png$/),
  })
  expect(before.map(m => m.role)).toEqual(['user', 'notice', 'user', 'user'])
})

test('the record is read only for a message with a picture mark left', () => {
  let reads = 0
  const counted = () => {
    reads++
    return sent()
  }
  for (const m of parseConversation(LINES.slice(0, -2))) if (m.role === 'user') picturesBack(m.text, m.at, counted)
  expect(reads).toBe(0)
  picturesBack('[Image #9]кнопки «открыть его браузер» я не вижу\nФайл:', AT, counted)
  expect(reads).toBe(1)
})

test('another session’s message, a task, a board reminder and a text-only message keep their words, even with the same words recorded', () => {
  const queued = (prompt: unknown, more: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'attachment',
      timestamp: '2026-10-31T06:05:00.000Z',
      attachment: {
        type: 'queued_command',
        prompt,
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: '2026-10-31T06:05:00.000Z',
        ...more,
      },
    })
  const words = '[Image #9]кнопки «открыть его браузер» я не вижу\nФайл:'
  const lines = [
    queued(`<cross-session-message from="Master">${words}</cross-session-message>`, { origin: { kind: 'peer' } }),
    queued(`[board reminder from Master] ${words}`),
    queued('спасибо'),
  ]
  const records = [...sent(), ...sent({ key: messageKey('спасибо') })]
  expect(thread(lines, records)).toEqual(parseConversation(lines))
})

test('the words, the session’s record and the time must all fit; else the message is as Claude Code keeps it', () => {
  const kept = '[Image #9]кнопки «открыть его браузер» я не вижу\nФайл:'
  const queuedAt = Date.parse('2026-10-31T06:04:54.484Z')
  const back = (records: SentPictures[]) => picturesBack(kept, queuedAt, () => records)
  expect(back([])).toBe(kept)
  expect(back(sent({ key: messageKey('другие слова\n\nФайл:\n/a.png') }))).toBe(kept)
  expect(back(sent({ pictures: [] }))).toBe(kept)
  // Recorded long before (a message typed again much later is someone else's), or after it was queued.
  expect(back(sent({ at: queuedAt - SENT_WITHIN_MS - 1 }))).toBe(kept)
  expect(back(sent({ at: queuedAt + 6_000 }))).toBe(kept)
  // Two records of the same words: the newest one before it.
  const older = '/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/065048-screenshot-085048.png'
  expect(back([...sent({ pictures: [older], at: AT - 60_000 }), ...sent()])).toBe(
    `кнопки «открыть его браузер» я не вижу\nФайл:\n${UPLOAD}`,
  )
  // A picture beside another file: Claude Code keeps the other one's path in the text.
  expect(
    picturesBack('[Image #1]слова\nФайлы:\n/u/notes.pdf', queuedAt, () => [
      { session: 's1', key: messageKey('слова\n\nФайлы:\n/u/notes.pdf\n/u/a.png'), pictures: ['/u/a.png'], at: AT },
    ]),
  ).toBe('слова\nФайлы:\n/u/notes.pdf\n/u/a.png')
  // A Windows board's upload (a user name with a space, other alphabets, %), two pictures.
  const win = 'C:\\Users\\Team Work\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-31\\'
  const typed = `снимок 100%\n\nФайлы:\n${win}a.png\n${win}б.jpeg`
  expect(
    picturesBack('[Image #3] [Image #4]снимок 100%\nФайлы:', queuedAt, () => [
      { session: 's1', key: messageKey(typed), pictures: [`${win}a.png`, `${win}б.jpeg`], at: AT },
    ]),
  ).toBe(`снимок 100%\nФайлы:\n${win}a.png\n${win}б.jpeg`)
})
