// The schedule panel against the old page's (at the parity baseline): #sched-body as web/app.js's
// own renderSchedule draws it for a board (support/old-schedule.ts) and what <ScheduleBody> renders
// for the same board, clock and armed button, in English and Russian; then the panel's rules
// (models/schedule.ts) on their own.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory } from '../../src/core/payload.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { ScheduleBody } from '../../web/src/components/schedule/SchedulePanel.tsx'
import { NO_MOVES, withMove } from '../../web/src/models/board-view.ts'
import { logRecords, newEntries, pendingText, scheduleGroups } from '../../web/src/models/schedule.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { canonical, findAll, hasClass, type Node } from './support/markup.ts'
import { oldScheduleBody } from './support/old-schedule.ts'

const MIN = 60_000
const HOUR = 60 * MIN
// A Saturday morning on the local clock: today, tomorrow and next week are fixed.
const NOW = new Date(2026, 9, 17, 10, 0).getTime()

const CATEGORIES: BoardCategory[] = [
  { id: 'proj', title: 'Project', color: '#007AFF', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'ops', title: 'Ops', color: '#34C759', colorName: 'green', paths: [], configured: true, fallback: false },
]
const ITEMS = [
  item({ key: 'a', name: 'Alpha', category: 'proj' }),
  item({ key: 'b', name: 'Beta', category: 'ops' }),
  item({ key: 'c', name: 'Gamma' }),
]

const ENTRIES: ScheduleEntry[] = [
  // Due and waiting, for every reason it can wait.
  { id: 'w1', key: 'a', text: 'Waits for no reason given', next: NOW - 5 * MIN, pendingSince: NOW - 4 * MIN },
  { id: 'w2', key: 'a', text: 'Busy', next: NOW - 3 * HOUR, pendingSince: NOW - HOUR, why: 'busy' },
  { id: 'w3', key: 'b', text: 'Draft', next: NOW - 26 * HOUR, pendingSince: NOW - HOUR, why: 'draft' },
  { id: 'w4', key: 'b', text: 'Dialog', next: NOW - MIN, pendingSince: NOW - MIN, why: 'dialog', idle: true },
  { id: 'w5', key: 'gone', name: 'Old one', text: 'Gone', next: NOW - MIN, pendingSince: NOW, why: 'gone' },
  { id: 'w6', key: 'c', text: 'herdr said no', next: NOW - MIN, pendingSince: NOW, why: 'herdr: pane not found' },
  { id: 'w7', key: 'c', text: 'Due, not tried yet', next: NOW - 10 },
  // Today, tomorrow, next week; repeating, counted, set by another session, a session gone.
  { id: 't1', key: 'a', text: 'Standup', next: NOW + 2 * HOUR, cron: '0 12 * * 1-5', runs: 3, missed: 1 },
  {
    id: 't2',
    key: 'b',
    text: 'Set by Alpha <for> Beta & "co"',
    next: NOW + 3 * HOUR,
    from: { key: 'a', name: 'Alpha before' },
  },
  {
    id: 't3',
    key: 'b',
    text: 'Moved here by /clear',
    next: NOW + 4 * HOUR,
    from: { key: 'b0', name: '' },
    movedFrom: { key: 'b0', name: 'B0' },
  },
  { id: 'm1', key: 'gone', text: 'Nobody to tell', next: NOW + 20 * HOUR },
  { id: 'm2', key: 'c', text: 'Set by a stranger', next: NOW + 22 * HOUR, from: { key: 'zzzzzzzz-1234', name: '' } },
  { id: 'n1', key: 'a', text: 'Next week', next: NOW + 6 * 24 * HOUR, cron: '0 9 * * 5', idle: true, runs: 1 },
  { id: 'y1', key: 'a', text: 'Next year', next: new Date(2027, 2, 1, 9, 0).getTime() },
]

const LOG: unknown[] = [
  { id: 'l1', key: 'a', name: 'Alpha', text: 'on time', due: NOW - HOUR, at: NOW - HOUR + 30_000, result: 'sent' },
  { id: 'l2', key: 'b', name: 'Beta', text: 'late', due: NOW - 3 * HOUR, at: NOW - HOUR, result: 'sent' },
  { id: 'l3', key: 'a', text: 'missed busy', due: NOW - 26 * HOUR, at: NOW - 25 * HOUR, result: 'missed', why: 'busy' },
  { id: 'l4', key: 'x', name: 'Left', text: 'missed gone', due: 0, at: NOW - 2 * HOUR, result: 'missed', why: 'gone' },
  { id: 'l5', key: 'b', text: 'missed draft', due: 0, at: NOW - 2 * HOUR, result: 'missed', why: 'draft' },
  { id: 'l6', key: 'b', text: 'missed dialog', due: 0, at: NOW - 2 * HOUR, result: 'missed', why: 'dialog' },
  { id: 'l7', key: 'b', text: 'missed odd', due: 0, at: NOW - 2 * HOUR, result: 'missed', why: 'herdr gone away' },
  { id: 'l8', key: 'y', text: 'dropped', due: 0, at: NOW - 2 * HOUR, result: 'dropped', n: 5 },
  { id: 'l9', key: 'y', text: 'dropped, no count', due: 0, at: NOW - 2 * HOUR, result: 'dropped' },
  { id: 'l10', key: 'y', text: 'missed, no why', due: 0, at: NOW - 2 * HOUR, result: 'missed' },
]

interface Scene {
  lang?: string
  schedules?: ScheduleEntry[]
  log?: unknown[]
  armed?: string | null
  canEdit?: boolean
  moved?: [string, string][]
}

function sides(scene: Scene): { old: Node[]; react: Node[] } {
  const lang = scene.lang ?? 'en'
  const data = payload({
    lang: lang === 'ru' ? 'ru' : 'en',
    items: ITEMS,
    categories: CATEGORIES,
    schedules: scene.schedules ?? ENTRIES,
    scheduleLog: scene.log ?? LOG,
  })
  const moved = new Map(scene.moved ?? [])
  const old = oldScheduleBody({
    lang,
    data,
    now: NOW,
    moved,
    armed: scene.armed ?? null,
    canEdit: scene.canEdit ?? true,
  })
  const moves = [...moved].reduce((all, [key, cat]) => withMove(all, key, { cat, column: null, at: NOW }), NO_MOVES)
  const react = renderInBoard(
    <ScheduleBody data={data} now={NOW} moves={moves} armed={scene.armed ?? null} disabled={scene.canEdit === false} />,
    board({ data, now: NOW }),
    lang,
  )
  return { old, react }
}

function same(scene: Scene): void {
  const { old, react } = sides(scene)
  expect(canonical(react)).toBe(canonical(old))
}

describe('schedule panel markup parity', () => {
  test('nothing scheduled, nothing run lately', () => {
    same({ schedules: [], log: [] })
    same({ schedules: [], log: [], lang: 'ru' })
  })

  test('nothing scheduled, but the recent runs', () => {
    same({ schedules: [] })
  })

  test('every kind of entry: waiting and why, by day, repeating and counted, set by another session, gone', () => {
    same({})
  })

  test('the same in Russian', () => {
    same({ lang: 'ru' })
  })

  test('one asking "Cancel?"; without the board the buttons do nothing', () => {
    same({ armed: 't2' })
    same({ armed: 'w4', canEdit: false })
  })

  test('the session’s lane color follows a card the user moved', () => {
    same({ moved: [['a', 'ops']] })
  })

  test('the stats and the log lines keep their inline spaces', () => {
    const { old, react } = sides({})
    const inline = (nodes: Node[]) =>
      findAll(nodes, el => hasClass(el, 'sched-stats') || hasClass(el, 'log-what')).map(el =>
        canonical([el], { spaces: true }),
      )
    expect(inline(old).length).toBe(ENTRIES.length + LOG.length)
    expect(inline(react)).toEqual(inline(old))
  })
})

describe('schedule rules', () => {
  const t = translator('en')

  test('why a due entry waits', () => {
    const e = (fields: Partial<ScheduleEntry>): ScheduleEntry => ({ id: 'x', key: 'k', text: '', next: 0, ...fields })
    expect(pendingText(e({}), t)).toBe('')
    expect(pendingText(e({ pendingSince: 1 }), t)).toBe('Waits until the session is free')
    expect(pendingText(e({ pendingSince: 1, why: 'busy' }), t)).toBe('Waits until the session is free')
    expect(pendingText(e({ pendingSince: 1, why: 'gone' }), t)).toBe('The session is not on the board')
    expect(pendingText(e({ pendingSince: 1, why: 'odd' }), t)).toBe('Not sent yet: odd')
    // Only its own words: a reason named like an Object property is still "not sent yet".
    expect(pendingText(e({ pendingSince: 1, why: 'toString' }), t)).toBe('Not sent yet: toString')
  })

  test('groups: the waiting ones first, then one per day in the order given', () => {
    const groups = scheduleGroups(ENTRIES, NOW, t)
    expect(groups.map(g => [g.title, g.entries.length])).toEqual([
      ['Due, waiting for the session', 7],
      ['Today', 3],
      ['Tomorrow', 2],
      [expect.stringMatching(/^Friday/), 1],
      [expect.stringMatching(/2027/), 1],
    ])
  })

  test('log lines: the newest 15, those that are records of a run', () => {
    const lines = [null, 'text', [], { at: 'soon' }, { at: 5, result: 'sent', text: 7 }]
    expect(logRecords(lines)).toEqual([
      { key: '', name: '', text: '', due: Number.NaN, at: 5, result: 'sent', why: '', n: undefined },
    ])
    const many = Array.from({ length: 20 }, (_, i) => ({ at: i, result: 'sent' }))
    expect(logRecords(many).map(r => r.at)).toEqual([...Array(15).keys()])
  })

  test('entries that came in while the panel is open materialize; none on its first draw', () => {
    expect(newEntries(['a', 'b'], null)).toEqual([])
    expect(newEntries(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c'])
  })
})
