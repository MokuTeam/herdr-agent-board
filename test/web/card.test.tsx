// The React card against the old one: each scene is drawn by web/app.js's own cardHTML and
// updateCard (support/old-board.ts) and by the React board, and the card compared with its
// inline spaces (canonical `spaces`): "<b>Asks:</b> <span class="qa-tag">", "You fix it".
import { describe, expect, test } from 'bun:test'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { resultToken } from '../../web/src/models/attention.ts'
import { item } from './support/board.tsx'
import { bothCards, type Scene } from './support/board-scene.tsx'

const MIN = 60_000
// Half minutes: the two sides read the clock a few ms apart and must not straddle a minute.
const ago = (minutes: number) => Date.now() - (minutes + 0.5) * MIN

function same(scene: Scene, key: string) {
  const { old, react } = bothCards(scene, key)
  expect(react).toBe(old)
}

const question = (header: string, multiSelect: boolean) => ({
  question: 'Which **one** goes first?',
  header,
  multiSelect,
  preview: false,
  options: [
    { label: 'Alpha', description: '' },
    { label: 'Beta', description: '' },
  ],
})

describe('card markup parity', () => {
  test('working: its own words, the running tool, an alarm that repeats and is due', () => {
    const schedules: ScheduleEntry[] = [
      { id: 's1', key: 'a', text: 'check the **build**', next: Date.now() - 60 * MIN, cron: '0 * * * *' },
      { id: 's2', key: 'a', text: 'later', next: Date.now() + 600 * MIN },
    ]
    const a = item({
      key: 'a',
      name: 'Alpha',
      status: 'working',
      column: 'work',
      doing: 'Fixing the `login` form',
      activity: ago(3),
      tool: { id: 't1', name: 'Bash', label: 'Bash', detail: 'bun test', pending: true },
    })
    same({ items: [a], schedules }, 'a')
  })

  test('working: thinking after a tool, then thinking with none; what it said last', () => {
    const after = item({
      key: 'a',
      status: 'working',
      column: 'work',
      prompt: 'Make it *faster*',
      lastText: 'Looking at the profile',
      activity: ago(12),
      tool: { id: 't1', name: 'Read', label: 'Read', detail: 'x.ts', pending: false },
    })
    const none = item({ key: 'b', status: 'working', column: 'work', activity: ago(0) })
    same({ items: [after, none] }, 'a')
    same({ items: [after, none] }, 'b')
  })

  test('needs me: a question to dismiss, how long it waited, an alarm not due yet', () => {
    const b = item({
      key: 'b',
      name: 'Beta',
      status: 'idle',
      column: 'me',
      attention: 'ask',
      question: 'Deploy to **prod**?',
      askSince: ago(7),
      activity: ago(9),
      session: 'sess-b',
    })
    const schedules: ScheduleEntry[] = [{ id: 's1', key: 'b', text: 'ping', next: Date.now() + 90 * MIN }]
    same({ items: [b], schedules }, 'b')
  })

  test('needs me: a question form with a header, several questions, any of the options', () => {
    const b = item({
      key: 'b',
      status: 'blocked',
      column: 'me',
      attention: 'question',
      activity: ago(2),
      tool: {
        id: 't9',
        name: 'AskUserQuestion',
        pending: true,
        questions: [question('Order', true), question('', false)],
      },
    })
    same({ items: [b] }, 'b')
  })

  test('needs me: a question form without a header; a decision; a card parked for later', () => {
    const form = item({
      key: 'a',
      status: 'blocked',
      column: 'me',
      attention: 'ask',
      tool: { id: 't9', name: 'AskUserQuestion', pending: true, questions: [question('', false)] },
    })
    const decision = item({ key: 'b', column: 'me', attention: 'decision', activity: ago(1) })
    const later = item({ key: 'c', column: 'me', attention: 'later', activity: ago(30), session: 'sess-c' })
    for (const key of ['a', 'b', 'c']) same({ items: [form, decision, later] }, key)
  })

  test('waiting on others: what it waits on, else parked; since when; what it said', () => {
    const waits = item({
      key: 'e',
      column: 'ext',
      wait: 'the review',
      waitSince: ago(25),
      activity: ago(3),
      lastText: 'Opened PR #12',
      title: 'Ship it',
    })
    const parked = item({ key: 'f', column: 'ext', activity: ago(90) })
    same({ items: [waits, parked] }, 'e')
    same({ items: [waits, parked] }, 'f')
  })

  test('done: a result not viewed yet, a renamed session, pinned to its column', () => {
    const c = item({
      key: 'c',
      name: 'Gamma',
      autoName: 'claude-gamma',
      status: 'done',
      column: 'done',
      pin: 'done',
      result: 'Fixed the **bug**',
      lastText: 'All green',
      activity: ago(60 * 26),
    })
    same({ items: [c] }, 'c')
  })

  test('done: the result viewed already; idle with a title that is its name and an old request', () => {
    const c = item({ key: 'c', status: 'done', column: 'done', result: 'R', activity: ago(5) })
    const viewed = { c: resultToken(c) }
    const idle = item({ key: 'i', name: 'Same', title: 'Same', prompt: 'Refactor the **parser**', column: 'idle' })
    same({ items: [c, idle], viewed }, 'c')
    same({ items: [c, idle], viewed }, 'i')
  })

  test('asleep in the idle column: one line with the moon, no sleep button', () => {
    const d = item({ key: 'd', name: 'Delta', status: 'sleeping', column: 'idle', sleeping: true, activity: ago(200) })
    same({ items: [d] }, 'd')
  })

  test('asleep elsewhere: the full card with the moon for a dot', () => {
    const d = item({ key: 'd', status: 'sleeping', column: 'done', sleeping: true, result: 'Done', activity: ago(4) })
    same({ items: [d] }, 'd')
  })

  test('the session in the sheet, and one busy waking', () => {
    const a = item({ key: 'a', column: 'idle', activity: ago(1) })
    const b = item({ key: 'b', column: 'idle', activity: ago(1), sleeping: true })
    const scene = { items: [a, b], open: 'a', busy: [['b', 'Waking…']] satisfies [string, string][] }
    same(scene, 'a')
    same(scene, 'b')
  })

  test('read only: without fresh herdr data focus and sleep wait; without the board dismiss does too', () => {
    const b = item({ key: 'b', column: 'me', attention: 'ask', session: 'sess-b', status: 'idle' })
    same({ items: [b], canMutate: false }, 'b')
    same({ items: [b], canMutate: false, canEdit: false }, 'b')
  })

  test('in Russian', () => {
    const b = item({ key: 'b', column: 'me', attention: 'later', askSince: ago(3), session: 'x' })
    const e = item({ key: 'e', column: 'ext', activity: ago(61) })
    const w = item({ key: 'w', column: 'work', status: 'working', prompt: 'Сделай', activity: ago(0) })
    for (const key of ['b', 'e', 'w']) same({ lang: 'ru', items: [b, e, w] }, key)
  })
})
