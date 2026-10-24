// What a card says, pinned from web/app.js (plain, ago, cardHTML, alarmBadge: app.js:64-87,451-500).
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Attention } from '../../src/core/types.ts'
import { longWhen, shortWhen } from '../../src/core/when-format.ts'
import {
  ago,
  alarmOf,
  askLine,
  cardAge,
  cardWords,
  compact,
  dismissable,
  folds,
  inTurn,
  plain,
  questionLine,
} from '../../web/src/models/card.ts'
import { item } from './support/board.tsx'
import { OLD_WHEN, oldCode, oldFunction, oldModule } from './support/old-app.ts'

const t = translator('en')
const NOW = 1_800_000_000_000
const MIN = 60_000

test('plain: markdown down to one line of text', () => {
  expect(plain('# Title\n\n- one\n- **two**\n1. `three`')).toBe('Title one two three')
  expect(plain('see [the docs](https://x.y/z) > quoted')).toBe('see the docs quoted')
  expect(plain('before ```js\ncode\n``` after')).toBe('before … after')
  expect(plain('  a\n\n\tb  ')).toBe('a b')
  expect(plain(null)).toBe('')
  expect(plain(undefined)).toBe('')
  expect(plain(42)).toBe('42')
  expect(plain('snake_case and *stars*')).toBe('snakecase and stars')
})

test('ago: now, minutes, hours, days; nothing for no time', () => {
  expect(ago(0, NOW, t)).toBe('')
  expect(ago(null, NOW, t)).toBe('')
  expect(ago(undefined, NOW, t)).toBe('')
  expect(ago(NOW - 30_000, NOW, t)).toBe(t('ago.now'))
  expect(ago(NOW - 5 * MIN - 1, NOW, t)).toBe(t('ago.min', { n: 5 }))
  expect(ago(NOW - 59 * MIN, NOW, t)).toBe(t('ago.min', { n: 59 }))
  expect(ago(NOW - 60 * MIN, NOW, t)).toBe(t('ago.h', { n: 1 }))
  expect(ago(NOW - 23 * 60 * MIN - 59 * MIN, NOW, t)).toBe(t('ago.h', { n: 23 }))
  expect(ago(NOW - 49 * 60 * MIN, NOW, t)).toBe(t('ago.d', { n: 2 }))
})

describe('card states', () => {
  test('a turn is on while it works or a dialog stopped it', () => {
    expect(inTurn(item({ key: 'a', status: 'working' }))).toBe(true)
    expect(inTurn(item({ key: 'a', status: 'blocked' }))).toBe(true)
    expect(inTurn(item({ key: 'a', status: 'idle' }))).toBe(false)
    expect(inTurn(item({ key: 'a', status: 'done' }))).toBe(false)
  })

  test('compact: asleep in the idle column only', () => {
    expect(compact(item({ key: 'a', sleeping: true, column: 'idle' }))).toBe(true)
    expect(compact(item({ key: 'a', sleeping: true, column: 'done' }))).toBe(false)
    expect(compact(item({ key: 'a', column: 'idle' }))).toBe(false)
    // A restart on its way keeps the card whole while Claude is out; another session's does not.
    const restart = { id: 'r1', key: 'a', kind: 'restart', text: '', next: NOW }
    expect(compact(item({ key: 'a', sleeping: true, column: 'idle' }), [restart])).toBe(false)
    expect(compact(item({ key: 'a', sleeping: true, column: 'idle' }), [{ ...restart, key: 'b' }])).toBe(true)
    expect(compact(item({ key: 'a', sleeping: true, column: 'idle' }), [{ ...restart, kind: 'call' }])).toBe(true)
  })

  test('folds: asleep in "Waiting" only, and whole while it restarts (#61)', () => {
    expect(folds(item({ key: 'a', sleeping: true, column: 'ext' }))).toBe(true)
    expect(folds(item({ key: 'a', column: 'ext' }))).toBe(false)
    for (const column of ['work', 'me', 'done', 'idle'] as const)
      expect(folds(item({ key: 'a', sleeping: true, column }))).toBe(false)
    const restart = { id: 'r1', key: 'a', kind: 'restart', text: '', next: NOW }
    expect(folds(item({ key: 'a', sleeping: true, column: 'ext' }), [restart])).toBe(false)
    expect(folds(item({ key: 'a', sleeping: true, column: 'ext' }), [{ ...restart, key: 'b' }])).toBe(true)
    // The idle column folds its own way, as before.
    expect(compact(item({ key: 'a', sleeping: true, column: 'ext' }))).toBe(false)
  })

  test('a favorite stays whole however long it sleeps: not one line in Idle, not folded in Waiting (#64)', () => {
    expect(compact(item({ key: 'a', sleeping: true, column: 'idle', favorite: true }))).toBe(false)
    expect(folds(item({ key: 'a', sleeping: true, column: 'ext', favorite: true }))).toBe(false)
  })

  test('a question that needs no answer can be dismissed', () => {
    const kinds: Attention[] = ['ask', 'question', 'later', 'decision', '']
    expect(kinds.map(attention => dismissable(item({ key: 'a', attention })))).toEqual([true, true, true, false, false])
  })
})

describe('cardWords', () => {
  test('what it works on: its own words, else a title that is not its name, else your last request', () => {
    expect(cardWords(item({ key: 'a', doing: 'Fix **login**', title: 'T', prompt: 'p' }))).toMatchObject({
      own: 'Fix login',
      asked: '',
    })
    expect(cardWords(item({ key: 'a', name: 'N', title: 'Claude title', prompt: 'p' }))).toMatchObject({
      own: 'Claude title',
      asked: '',
    })
    expect(cardWords(item({ key: 'a', name: 'Same', title: 'Same', prompt: 'do *it*' }))).toMatchObject({
      own: '',
      asked: 'do it',
    })
  })

  test('what it said: the result when done or idle, else the last text; never repeated, never under "Needs me"', () => {
    expect(cardWords(item({ key: 'a', column: 'done', result: 'R', lastText: 'L' })).said).toBe('R')
    expect(cardWords(item({ key: 'a', column: 'idle', lastText: 'L' })).said).toBe('L')
    expect(cardWords(item({ key: 'a', column: 'work', result: 'R', lastText: 'L' })).said).toBe('L')
    expect(cardWords(item({ key: 'a', column: 'me', lastText: 'L' })).said).toBe('')
    expect(cardWords(item({ key: 'a', column: 'done', doing: 'Same', result: 'Same' })).said).toBe('')
    expect(cardWords(item({ key: 'a', column: 'done', prompt: 'Same', result: 'Same' })).said).toBe('')
  })
})

describe('cardAge', () => {
  test('under "Needs me": how long it has waited for you, with a title', () => {
    const asked = item({ key: 'a', column: 'me', askSince: NOW - 7 * MIN, activity: NOW - 9 * MIN })
    expect(cardAge(asked, NOW, t)).toEqual({
      text: t('ago.min', { n: 7 }),
      title: t('attention.waitAge', { age: t('ago.min', { n: 7 }) }),
    })
    const idle = item({ key: 'a', column: 'me', activity: NOW - 9 * MIN })
    expect(cardAge(idle, NOW, t).title).toBe(t('attention.activityAge', { age: t('ago.min', { n: 9 }) }))
  })

  test('waiting on others: since it waits, else its last activity; elsewhere its last activity, no title', () => {
    expect(cardAge(item({ key: 'a', column: 'ext', waitSince: NOW - 3 * MIN, activity: NOW - MIN }), NOW, t)).toEqual({
      text: t('ago.min', { n: 3 }),
      title: '',
    })
    expect(cardAge(item({ key: 'a', column: 'ext', activity: NOW - 2 * MIN }), NOW, t).text).toBe(
      t('ago.min', { n: 2 }),
    )
    expect(cardAge(item({ key: 'a', column: 'done', activity: NOW - 2 * MIN }), NOW, t).text).toBe(
      t('ago.min', { n: 2 }),
    )
    expect(cardAge(item({ key: 'a', column: 'done' }), NOW, t)).toEqual({ text: '', title: '' })
  })
})

test('askLine: the question under "Needs me", or what kind of stop it is', () => {
  expect(askLine(item({ key: 'a', attention: 'ask', question: 'Deploy **now**?' }), t)).toEqual({
    label: t('att.ask'),
    text: 'Deploy now?',
  })
  expect(askLine(item({ key: 'a', attention: 'later' }), t)).toEqual({
    label: t('att.later'),
    text: t('card.lookLater'),
  })
  expect(askLine(item({ key: 'a' }), t)).toEqual({ label: t('att.default'), text: t('card.needsDecision') })
})

test('questionLine: the first question, its options in one line, how many more', () => {
  const question = (header: string, multiSelect: boolean) => ({
    question: 'Which *one*?',
    header,
    multiSelect,
    preview: false,
    options: [
      { label: 'A', description: '' },
      { label: 'B', description: '' },
    ],
  })
  expect(questionLine([question('Pick', false)], t)).toEqual({
    header: 'Pick',
    question: 'Which one?',
    options: 'A · B',
    more: '',
  })
  expect(questionLine([question('', true), question('x', false)], t)).toEqual({
    header: '',
    question: 'Which one?',
    options: `A · B · ${t('qa.any')}`,
    more: t('qa.more', { n: 1 }),
  })
})

describe('alarmOf', () => {
  const entry = (fields: Partial<ScheduleEntry> & Pick<ScheduleEntry, 'id' | 'key' | 'next'>): ScheduleEntry => ({
    text: 'ping the **build**',
    ...fields,
  })

  test('none without entries for the session', () => {
    expect(alarmOf([entry({ id: '1', key: 'b', next: NOW })], 'a', NOW, t)).toBeNull()
  })

  test('the soonest entry: its time, its text in the title, a repeat icon for cron, due once its time passed', () => {
    const schedules = [
      entry({ id: '1', key: 'a', next: NOW + 90 * MIN, cron: '0 * * * *' }),
      entry({ id: '2', key: 'a', next: NOW + 900 * MIN }),
    ]
    expect(alarmOf(schedules, 'a', NOW, t)).toEqual({
      due: false,
      repeat: true,
      when: shortWhen(NOW + 90 * MIN, t, NOW),
      title: t('sched.badge', { n: 2, when: longWhen(NOW + 90 * MIN, t, NOW), text: 'ping the build' }),
    })
    expect(alarmOf([entry({ id: '1', key: 'a', next: NOW })], 'a', NOW, t)).toMatchObject({ due: true, repeat: false })
    expect(alarmOf([entry({ id: '1', key: 'a', next: NOW + 1 })], 'a', NOW, t)?.due).toBe(false)
  })

  test('a MokuPilot call’s results first: the title says them by their title, as upstream’s alarmBadge at #45', async () => {
    const CALL_REPORT = 'bde9cfd'
    const model = await oldModule('web/notice-model.js', CALL_REPORT)
    const now = Date.now()
    const schedules = [
      entry({ id: 'c1', key: 'a', next: now + 5 * MIN, kind: 'call', text: '# Release **2.4** call\n\n- ship' }),
      entry({ id: '2', key: 'a', next: now + 900 * MIN }),
    ]
    for (const lang of ['en', 'ru']) {
      const tr = translator(lang)
      const code = oldCode(
        'web/app.js',
        ['ICON', 'esc', 'plain', 'schedulesOf', 'overdue', 'entryText', 'alarmBadge'],
        {
          t: tr,
          state: { data: { schedules } },
          longWhen: OLD_WHEN.get('longWhen'),
          shortWhen: OLD_WHEN.get('shortWhen'),
          callTitle: model.get('callTitle'),
        },
        CALL_REPORT,
      )
      const badge = String(oldFunction(code, 'alarmBadge')({ key: 'a' }))
      const title = /title="([^"]*)"/
        .exec(badge)?.[1]
        ?.replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
      expect(alarmOf(schedules, 'a', now, tr)?.title).toBe(title)
    }
    expect(alarmOf(schedules, 'a', now, t)?.title).toContain('MokuPilot call results: Release 2.4 call')
  })
})
