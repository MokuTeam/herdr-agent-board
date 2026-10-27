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

/** The card's new status label is not in the old page's markup: compare the rest. */
const withoutStatus = (html: string) => html.replace(/[ \t]*<span class="card-status"[^>]*>[^<]*<\/span>\n?/, '')

function same(scene: Scene, key: string) {
  const { old, react } = bothCards(scene, key)
  expect(withoutStatus(react)).toBe(withoutStatus(old))
}

test('the card shows its status by the name', () => {
  const a = item({ key: 'a', name: 'Alpha', status: 'working', column: 'work' })
  const { react } = bothCards({ items: [a] }, 'a')
  expect(react).toContain('class="card-status"')
  expect(react).toContain('>Working<')
  expect(react).not.toContain('card-facts')
  // Another column: its own words.
  const bare = bothCards({ items: [item({ key: 'b', column: 'me', name: 'B' })] }, 'b').react
  expect(bare).toContain('>Needs me<')
})

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

  test('asleep in "Waiting": folded to its name, what it waits on and its time, the rest under it (#61)', () => {
    const fields = {
      key: 'e',
      column: 'ext' as const,
      wait: 'the review',
      waitSince: ago(25),
      lastText: 'Opened PR #12',
      title: 'Ship it',
    }
    const asleep = item({ ...fields, status: 'sleeping', sleeping: true })
    const { react } = bothCards({ items: [asleep] }, 'e')
    expect(react).toContain('class="card folds"')
    const [top, more] = react.split('class="fold-more"')
    expect(top).toContain('the review')
    expect(top).toContain('class="age"')
    expect(top).not.toContain('Ship it')
    expect(more).toContain('class="what">Ship it')
    expect(more).toContain('class="said">Opened PR #12')
    // Awake, or restarting, it is the whole card as before.
    same({ items: [item(fields)] }, 'e')
    const restart: ScheduleEntry = { id: 'r1', key: 'e', kind: 'restart', text: '', next: Date.now() + MIN }
    expect(bothCards({ items: [asleep], schedules: [restart] }, 'e').react).not.toContain('fold')
    // Folded the same whichever way it unfolds; with folding off in Settings, the whole card as before.
    for (const foldWaiting of ['push', 'over'] as const)
      expect(bothCards({ items: [asleep], foldWaiting }, 'e').react).toBe(react)
    same({ items: [asleep], foldWaiting: 'off' }, 'e')
  })

  test('a favorite: a star by its name; asleep in Idle or in Waiting, the whole card (#64)', () => {
    const fields = {
      name: 'Delta',
      status: 'sleeping' as const,
      sleeping: true,
      result: 'Done',
      lastText: 'Done',
      activity: ago(200),
    }
    for (const column of ['idle', 'ext'] as const) {
      const fav = item({ key: 'd', column, wait: 'review', ...fields, favorite: true })
      const { react } = bothCards({ items: [fav] }, 'd')
      expect(react).toContain(
        '<span class="favorite" title="Favorite: first in its column and whole, however long it idles">',
      )
      expect(react).toContain('<svg class="star"')
      expect(react).not.toContain('compact')
      expect(react).not.toContain('folds')
      // Its last words are on it, as on a card awake.
      expect(react).toContain('class="said">Done')
    }
    // Not a favorite: the card as before.
    same({ items: [item({ key: 'd', column: 'idle', ...fields, favorite: false })] }, 'd')
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

describe('card markup parity at the restart’s merge (#51): the card as upstream’s own cardHTML there draws it', () => {
  const RESTART = '513e441'
  const restart = (fields: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
    id: 'r1',
    key: 'a',
    kind: 'restart',
    idle: true,
    by: 'agent',
    text: '',
    next: Date.now() - 5 * MIN,
    ...fields,
  })
  const a = item({
    key: 'a',
    name: 'Alpha',
    status: 'idle',
    column: 'idle',
    session: 'sess-a',
    agent: 'claude',
    result: 'Done the **thing**',
    activity: ago(3),
  })

  test('cards without a restart draw as there too', () => {
    const w = item({ key: 'w', status: 'working', column: 'work', doing: 'x', activity: ago(1), tool: null })
    const d = item({ key: 'd', status: 'sleeping', column: 'idle', sleeping: true, activity: ago(200) })
    const schedules: ScheduleEntry[] = [{ id: 's1', key: 'w', text: 'ping', next: Date.now() + 90 * MIN }]
    for (const key of ['a', 'w', 'd']) same({ items: [a, w, d], schedules, ref: RESTART }, key)
  })

  test('a restart on its way: a line of its own, waiting (on what), under way (arrows turning), given up; the clock without it', () => {
    for (const fields of [
      {},
      { why: 'tasks', pendingSince: Date.now() },
      { why: 'draft' },
      { why: 'dialog' },
      { why: 'gone' },
      { why: 'busy', attempts: 1 },
      { why: 'Could not put Alpha to sleep: it is busy', attempts: 2 },
      { step: 'sleep' },
      { step: 'wake', text: 'go on' },
      { step: 'note' },
      { failed: 'herdr-wake is down <now>' },
    ]) {
      same({ items: [a], schedules: [restart(fields)], ref: RESTART }, 'a')
      same({ items: [a], schedules: [restart(fields)], ref: RESTART, lang: 'ru' }, 'a')
    }
    // With a reminder too: the clock shows the reminder alone.
    const schedules = [restart(), { id: 's1', key: 'a', text: 'ping', next: Date.now() + 90 * MIN }]
    same({ items: [a], schedules, ref: RESTART }, 'a')
    const { react } = bothCards({ items: [a], schedules, ref: RESTART }, 'a')
    expect(react).toContain('class="now restart"')
    expect(react).toContain('class="alarm"')
  })

  test('asleep in the idle column while it restarts: the card stays whole; one for another session folds it as before', () => {
    const asleep = { ...a, status: 'sleeping' as const, sleeping: true }
    same({ items: [asleep], schedules: [restart({ step: 'wake' })], ref: RESTART }, 'a')
    same({ items: [asleep], schedules: [restart({ key: 'b' })], ref: RESTART }, 'a')
    const { react } = bothCards({ items: [asleep], schedules: [restart({ step: 'wake' })], ref: RESTART }, 'a')
    expect(react).not.toContain('compact')
    expect(react).toContain('class="now on restart"')
  })
})
