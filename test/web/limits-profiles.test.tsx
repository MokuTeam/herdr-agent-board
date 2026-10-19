// Claude usage per profile: with two or more profiles shown, the usage pill names each profile
// with recent usage before its windows, and the popover gives every shown profile its own part,
// its windows or "No session lately". One shown: none of it (single-profile.test.tsx holds the
// pill and the popover to phase 1's).
import { expect, test } from 'bun:test'
import { createRef } from 'react'
import type { BoardLimits, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Limits } from '../../web/src/components/Limits.tsx'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { profileUsage } from '../../web/src/models/limits.ts'
import { board as boardContext, payload, renderInBoard } from './support/board.tsx'
import { byId, type Element, findAll, hasClass, type Node } from './support/markup.ts'

const MIN = 60_000
const NOW = Date.now()

/** A reading at `at` of the 5-hour and the weekly window. */
const reading = (at: number, five: number, week: number): BoardLimits => ({
  source: 'statusline',
  observedAt: at,
  stale: false,
  windows: [
    { minutes: 300, usedPercentage: five, resetsAt: null, expired: false },
    { minutes: 10080, usedPercentage: week, resetsAt: null, expired: false },
  ],
})
const FRESH = reading(NOW - MIN, 92, 40.4)
/** Over half an hour old: the windows may have reset since. */
const OLD = reading(NOW - 60 * MIN, 20, 75)

const PRIVATE: BoardProfile = {
  id: 'default',
  title: 'Private',
  color: '#5856D6',
  colorName: 'indigo',
  dir: 'C:\\Users\\me\\.claude',
  hidden: false,
  inherited: true,
  exists: true,
  hooks: true,
  sessions: 2,
  limits: FRESH,
}
const WORK: BoardProfile = {
  id: 'work',
  title: 'Work',
  color: '#30B0C7',
  colorName: 'teal',
  dir: 'C:\\Users\\me\\.claude-work',
  hidden: false,
  inherited: false,
  exists: true,
  hooks: true,
  sessions: 1,
  limits: OLD,
}
/** Hidden: never in the pill or the popover, whatever it used. */
const GAMEDEV: BoardProfile = {
  id: 'gamedev',
  title: 'Gamedev',
  color: '#FF2D55',
  colorName: 'pink',
  dir: 'C:\\Users\\me\\.claude-gamedev',
  hidden: true,
  inherited: false,
  exists: true,
  hooks: null,
  sessions: 0,
  limits: reading(NOW - MIN, 55, 66),
}

/** A board with these profiles; its own usage (the board's profile's) is Private's. */
const data = (...profiles: BoardProfile[]): BoardPayload => payload({ limits: FRESH, profiles })

const pill = (value: BoardPayload, connected = true, lang = 'en'): Element =>
  byId(
    renderInBoard(<Limits anchor={createRef<HTMLButtonElement>()} />, boardContext({ data: value, connected }), lang),
    'limits',
  )
const pop = (value: BoardPayload, connected = true, lang = 'en'): Element =>
  byId(
    renderInBoard(
      <LimitsPop anchor={createRef<HTMLButtonElement>()} />,
      boardContext({ data: value, connected, ui: { limitsOpen: true } }),
      lang,
    ),
    'limits-content',
  )

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const elementsIn = (el: Element): Element[] => el.children.filter((c): c is Element => c.kind === 'element')
/** The pill's parts: each one's class, text and style. */
const parts = (el: Element): (string | undefined)[][] =>
  elementsIn(el).map(c => [c.attrs.get('class'), textOf(c), c.attrs.get('style')])
/** The popover's parts: each profile's section, its heading and its paragraphs. */
const sections = (el: Element) =>
  elementsIn(el).map(s => {
    const [head, ...rest] = elementsIn(s)
    return {
      tag: s.tag,
      class: s.attrs.get('class'),
      profile: s.attrs.get('data-profile'),
      head: head && [head.tag, textOf(head), head.attrs.get('style')],
      paragraphs: rest.map(p => [p.tag, p.attrs.get('class') ?? '', textOf(p)]),
    }
  })

const when = (at: number) => new Date(at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })

test('the pill: each profile with recent usage, by name and color', () => {
  // Work's reading is old: left out, as is hidden Gamedev's.
  const one = pill(data(PRIVATE, WORK, GAMEDEV))
  expect(one.attrs.get('class')).toBe('limits')
  expect(parts(one)).toEqual([
    ['limits-profile', 'Private', '--c:#5856D6'],
    ['hot', '5h 92%', undefined],
    [undefined, '7d 40%', undefined],
  ])
  // Both recent: in the list's order, each one's windows after its name, colored by their use.
  const both = pill(data(PRIVATE, { ...WORK, limits: reading(NOW - 2 * MIN, 20, 75) }, GAMEDEV))
  expect(both.attrs.get('class')).toBe('limits')
  expect(parts(both)).toEqual([
    ['limits-profile', 'Private', '--c:#5856D6'],
    ['hot', '5h 92%', undefined],
    [undefined, '7d 40%', undefined],
    ['limits-profile', 'Work', '--c:#30B0C7'],
    [undefined, '5h 20%', undefined],
    ['warm', '7d 75%', undefined],
  ])
  // Its name and tooltip are today's; the windows in Russian.
  expect([both.attrs.get('aria-label'), both.attrs.get('title')]).toEqual([
    'Claude usage',
    'Show usage, source and reading time',
  ])
  expect(parts(pill(data(PRIVATE, WORK), true, 'ru')).map(p => p[1])).toEqual(['Private', '5ч 92%', '7д 40%'])

  // The model: every shown profile in the list's order, recent when it has windows and they are fresh.
  const usage = profileUsage([PRIVATE, WORK, GAMEDEV], { connected: true, now: NOW })
  expect(usage?.map(u => [u.id, u.title, u.color, u.recent, u.lim.windows.length])).toEqual([
    ['default', 'Private', '#5856D6', true, 2],
    ['work', 'Work', '#30B0C7', false, 2],
  ])
  expect(profileUsage([PRIVATE, { ...WORK, limits: null }], { connected: true, now: NOW })?.[1]?.recent).toBe(false)
  // Not connected: nothing is recent.
  expect(profileUsage([PRIVATE, WORK], { connected: false, now: NOW })?.map(u => u.recent)).toEqual([false, false])
  // Fewer than two shown: none, the pill is today's.
  expect(profileUsage([PRIVATE, { ...WORK, hidden: true }, GAMEDEV], { connected: true })).toBeNull()
  expect(profileUsage([PRIVATE], { connected: true })).toBeNull()
  expect(profileUsage([], { connected: true })).toBeNull()
  expect(profileUsage(undefined, { connected: true })).toBeNull()
})

test('the popover: every shown profile, its windows or "No session lately"', () => {
  const fresh = when(NOW - MIN)
  const old = when(NOW - 60 * MIN)
  const content = pop(data(PRIVATE, { ...WORK, limits: null }, GAMEDEV))
  expect(sections(content)).toEqual([
    {
      tag: 'section',
      class: 'limits-for',
      profile: 'default',
      head: ['h4', 'Private', '--c:#5856D6'],
      paragraphs: [
        ['p', '', 'Used: 5h: 92% · 7d: 40%'],
        ['p', '', `Claude usage of this account, ${fresh}, as Claude Code reported it to the status line.`],
        ['p', '', 'Last available local report. These percentages show consumption, not remaining allowance.'],
      ],
    },
    {
      tag: 'section',
      class: 'limits-for',
      profile: 'work',
      head: ['h4', 'Work', '--c:#30B0C7'],
      paragraphs: [['p', 'limits-none', 'No session lately']],
    },
  ])
  // An old reading still lists its windows, with today's warning.
  const stale = sections(pop(data(PRIVATE, WORK)))[1]
  expect(stale?.paragraphs).toEqual([
    ['p', '', 'Used: 5h: 20% · 7d: 75%'],
    ['p', '', `Claude usage of this account, ${old}, as Claude Code reported it to the status line.`],
    ['p', 'limits-warning', `Claude usage, ${old}: an old reading, the windows may have reset since.`],
  ])
  // In Russian.
  const ru = sections(pop(data(PRIVATE, { ...WORK, limits: null }), true, 'ru'))
  expect(ru.map(s => s.head?.[1])).toEqual(['Private', 'Work'])
  expect(ru[1]?.paragraphs).toEqual([['p', 'limits-none', 'Сессий давно не было']])
  // The popover's frame is today's.
  const frame = renderInBoard(
    <LimitsPop anchor={createRef<HTMLButtonElement>()} />,
    boardContext({ data: data(PRIVATE, WORK), ui: { limitsOpen: true } }),
  )
  expect(textOf(byId(frame, 'limits-title'))).toBe('Claude usage')
  expect(findAll(frame, el => hasClass(el, 'limits-for')).length).toBe(2)
})

test('no recent usage in any profile: "Usage —"', () => {
  for (const [value, connected] of [
    [data(PRIVATE, WORK), false],
    [data({ ...PRIVATE, limits: OLD }, WORK), true],
    [data({ ...PRIVATE, limits: null }, { ...WORK, limits: null }, GAMEDEV), true],
  ] as const) {
    const el = pill(value, connected)
    expect([el.attrs.get('class'), textOf(el), elementsIn(el).length]).toEqual(['limits', 'Usage —', 0])
  }
  expect(textOf(pill(data({ ...PRIVATE, limits: null }, { ...WORK, limits: null }), true, 'ru'))).toBe('Лимиты —')
  // The popover still lists each, the old reading with its warning.
  const offline = sections(pop(data(PRIVATE, { ...WORK, limits: null }), false))
  expect(offline.map(s => s.paragraphs.at(-1)?.[1])).toEqual(['limits-warning', 'limits-none'])
})
