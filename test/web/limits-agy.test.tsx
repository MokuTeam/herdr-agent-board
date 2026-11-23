// Antigravity (Gemini) usage in the toolbar pill and popover (#647):
// - Omitted `agyLimits` (boards without agy): pill and popover are 100% identical to plain Claude.
// - `agyLimits: null` (agy installed, usage unknown): popover shows Gemini (agy) as unknown, never invents 0%.
// - Fresh `agyLimits`: pill shows Gemini windows next to Claude (single or multi-profile), popover shows
//   percentages, reset time / forecast, source and reading time.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardAgyLimits, BoardLimits, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Limits } from '../../web/src/components/Limits.tsx'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { agyLimitInfo, agyWindowLabel } from '../../web/src/models/limits.ts'
import { board as boardContext, payload, renderInBoard } from './support/board.tsx'
import { byId, type Element, findAll, type Node } from './support/markup.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.now()

const CLAUDE_FRESH: BoardLimits = {
  source: 'statusline',
  observedAt: NOW - MIN,
  stale: false,
  windows: [
    { minutes: 300, usedPercentage: 35, resetsAt: NOW + 3 * HOUR, expired: false },
    { minutes: 10080, usedPercentage: 20, resetsAt: NOW + 72 * HOUR, expired: false },
  ],
}

const AGY_FRESH: BoardAgyLimits = {
  source: 'statusline',
  observedAt: NOW - MIN,
  stale: false,
  planTier: 'Pro',
  windows: [
    { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 91, resetsAt: NOW + 2 * HOUR, expired: false },
    { id: 'gemini-weekly', label: '7d', minutes: 10080, usedPercentage: 14, resetsAt: NOW + 96 * HOUR, expired: false },
    { id: 'gemini-flash', label: 'Flash', minutes: null, usedPercentage: 72, resetsAt: NOW + HOUR, expired: false },
  ],
}

const AGY_OLD: BoardAgyLimits = {
  ...AGY_FRESH,
  observedAt: NOW - 2 * HOUR,
  stale: true,
}

const pill = (value: BoardPayload, connected = true, lang = 'en'): Element =>
  byId(
    renderInBoard(<Limits anchor={createRef<HTMLButtonElement>()} />, boardContext({ data: value, connected }), lang),
    'limits',
  )
const popFrame = (value: BoardPayload, connected = true, lang = 'en'): Node[] =>
  renderInBoard(
    <LimitsPop anchor={createRef<HTMLButtonElement>()} />,
    boardContext({ data: value, connected, ui: { limitsOpen: true } }),
    lang,
  )

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const elementsIn = (el: Element): Element[] => el.children.filter((c): c is Element => c.kind === 'element')
const parts = (el: Element): (string | undefined)[][] =>
  elementsIn(el).map(c => [c.attrs.get('class'), textOf(c), c.attrs.get('style')])

describe('Antigravity (Gemini) usage in the board UI (#647)', () => {
  test('omitted agyLimits leaves plain Claude pill and popover unchanged', () => {
    expect(agyLimitInfo(undefined)).toBeNull()
    const data = payload({ limits: CLAUDE_FRESH })
    const p = pill(data)
    expect(p.attrs.get('aria-label')).toBe('Claude usage')
    expect(parts(p)).toEqual([
      [undefined, '5h 35%', undefined],
      [undefined, '7d 20%', undefined],
    ])
    const frame = popFrame(data)
    expect(textOf(byId(frame, 'limits-title'))).toBe('Claude usage')
    expect(findAll(frame, el => el.attrs.get('data-provider') === 'agy')).toHaveLength(0)
  })

  test('fresh Gemini windows show beside Claude in single-profile and multi-profile pills', () => {
    // Single profile: Claude + Gemini labelled side by side with heat colors.
    const single = pill(payload({ limits: CLAUDE_FRESH, agyLimits: AGY_FRESH }))
    expect(single.attrs.get('aria-label')).toBe('Usage')
    expect(parts(single)).toEqual([
      ['limits-profile', 'Claude', '--c:#D97757'],
      [undefined, '5h 35%', undefined],
      [undefined, '7d 20%', undefined],
      ['limits-profile', 'Gemini', '--c:#4285F4'],
      ['hot', '5h 91%', undefined],
      [undefined, '7d 14%', undefined],
      ['warm', 'Flash 72%', undefined],
    ])

    // When Claude has no reading, Gemini still shows in the pill.
    const agyOnly = pill(payload({ limits: null, agyLimits: AGY_FRESH }))
    expect(parts(agyOnly).map(x => x[1])).toEqual(['Gemini', '5h 91%', '7d 14%', 'Flash 72%'])

    // Russian labels localize 5h / 7d while keeping model-group labels.
    const ru = pill(payload({ limits: null, agyLimits: AGY_FRESH }), true, 'ru')
    expect(parts(ru).map(x => x[1])).toEqual(['Gemini', '5ч 91%', '7д 14%', 'Flash 72%'])

    // Multi-profile Claude + Gemini.
    const profiles: BoardProfile[] = [
      {
        id: 'default',
        title: 'Private',
        color: '#5856D6',
        colorName: 'indigo',
        dir: '/claude',
        hidden: false,
        inherited: true,
        exists: true,
        hooks: true,
        sessions: 1,
        limits: CLAUDE_FRESH,
      },
      {
        id: 'work',
        title: 'Work',
        color: '#30B0C7',
        colorName: 'teal',
        dir: '/claude-work',
        hidden: false,
        inherited: false,
        exists: true,
        hooks: true,
        sessions: 0,
        limits: null,
      },
    ]
    const multi = pill(payload({ limits: CLAUDE_FRESH, profiles, agyLimits: AGY_FRESH }))
    expect(parts(multi).map(x => x[1])).toEqual([
      'Private',
      '5h 35%',
      '7d 20%',
      'Gemini',
      '5h 91%',
      '7d 14%',
      'Flash 72%',
    ])
  })

  test('popover shows Gemini (agy) section with percentages, reset/forecast, unknown and stale states', () => {
    // Fresh reading with plan tier.
    const frame = popFrame(payload({ limits: CLAUDE_FRESH, agyLimits: AGY_FRESH }))
    expect(textOf(byId(frame, 'limits-title'))).toBe('Usage')
    const agySection = findAll(frame, el => el.attrs.get('data-provider') === 'agy')[0]
    expect(agySection).toBeDefined()
    const agyText = textOf(agySection as Element)
    expect(agyText).toContain('Gemini (agy) · Pro')
    expect(agyText).toContain('Used: 5h: 91% · 7d: 14% · Flash: 72%')
    expect(agyText).toContain('Antigravity CLI')
    expect(agyText).toContain('Flash: resets')

    // Installed with no reading yet (null): shows unknown, never invents 0%.
    const unknownFrame = popFrame(payload({ limits: CLAUDE_FRESH, agyLimits: null }))
    const unknownSection = findAll(unknownFrame, el => el.attrs.get('data-provider') === 'agy')[0]
    expect(textOf(unknownSection as Element)).toContain('unknown')
    expect(textOf(unknownSection as Element)).not.toContain('0%')

    // Stale reading: dropped from pill, shown with stale warning in popover.
    const stalePill = pill(payload({ limits: null, agyLimits: AGY_OLD }))
    expect(textOf(stalePill)).toBe('Usage —')
    const staleFrame = popFrame(payload({ limits: null, agyLimits: AGY_OLD }))
    const staleSection = findAll(staleFrame, el => el.attrs.get('data-provider') === 'agy')[0]
    expect(textOf(staleSection as Element)).toContain('old reading')

    // Disconnected with fresh reading: pill drops Gemini to Usage — and popover marks stale.
    expect(textOf(pill(payload({ limits: null, agyLimits: AGY_FRESH }), false))).toBe('Usage —')
    const offlineFrame = popFrame(payload({ limits: null, agyLimits: AGY_FRESH }), false)
    expect(textOf(findAll(offlineFrame, el => el.attrs.get('data-provider') === 'agy')[0] as Element)).toContain(
      'old reading',
    )

    // Expired windows are filtered out, and minutes: undefined is normalized to null (never produces false forecast).
    const mixed = agyLimitInfo(
      {
        source: 'statusline',
        observedAt: NOW - MIN,
        stale: false,
        windows: [
          { id: 'expired', label: '5h', minutes: 300, usedPercentage: 50, resetsAt: NOW - 1000 },
          { id: 'gemini-flash', label: 'Flash', usedPercentage: 0, resetsAt: NOW + HOUR },
        ],
      },
      { connected: true, now: NOW },
    )
    expect(mixed?.windows).toEqual([
      { id: 'gemini-flash', label: 'Flash', minutes: null, usedPercentage: 0, resetsAt: NOW + HOUR },
    ])
    const undefFrame = popFrame(
      payload({
        limits: null,
        agyLimits: {
          source: 'statusline',
          observedAt: NOW - MIN,
          stale: false,
          windows: [
            {
              id: 'gemini-flash',
              label: 'Flash',
              minutes: undefined as unknown as null,
              usedPercentage: 0,
              resetsAt: NOW + HOUR,
              expired: false,
            },
          ],
        },
      }),
    )
    const undefText = textOf(findAll(undefFrame, el => el.attrs.get('data-provider') === 'agy')[0] as Element)
    expect(undefText).toContain('Flash: resets')
    expect(undefText).not.toContain('at this pace')
  })

  test('names, translates, orders, and tooltips third-party 3p windows in English and Russian (#664)', () => {
    const en = translator('en')
    const ru = translator('ru')

    const cases: Array<[string, string, number | null, string, string]> = [
      ['gemini-5h', '5h', 300, '5h', '5ч'],
      ['gemini-weekly', '7d', 10080, '7d', '7д'],
      ['gemini-pro-weekly', 'Pro 7d', 10080, 'Pro 7d', 'Pro 7д'],
      ['claude-5h', 'Claude 5h', 300, 'Claude 5h', 'Claude 5ч'],
      ['gemini-flash', 'Flash', null, 'Flash', 'Flash'],
      ['3p-5h', 'Other models 5h', 300, 'Other models 5h', 'Другие модели 5ч'],
      ['3p-5h', '3p 5h', 300, 'Other models 5h', 'Другие модели 5ч'],
      ['3p-weekly', 'Other models 7d', 10080, 'Other models 7d', 'Другие модели 7д'],
      ['3p-weekly', '3p 7d', 10080, 'Other models 7d', 'Другие модели 7д'],
      ['3p', 'Other models', null, 'Other models', 'Другие модели'],
    ]
    for (const [id, label, minutes, expectedEn, expectedRu] of cases) {
      const reading = { id, label, minutes, usedPercentage: 10 }
      expect(agyWindowLabel(reading, en)).toBe(expectedEn)
      expect(agyWindowLabel(reading, ru)).toBe(expectedRu)
    }

    // 0% third-party windows are hidden while 0% Gemini windows stay visible.
    const zero3p: BoardAgyLimits = {
      source: 'statusline',
      observedAt: NOW - MIN,
      stale: false,
      windows: [
        {
          id: '3p-5h',
          label: 'Other models 5h',
          minutes: 300,
          usedPercentage: 0,
          resetsAt: NOW + 2 * HOUR,
          expired: false,
        },
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 0, resetsAt: NOW + 2 * HOUR, expired: false },
        {
          id: 'gemini-weekly',
          label: '7d',
          minutes: 10080,
          usedPercentage: 9,
          resetsAt: NOW + 96 * HOUR,
          expired: false,
        },
        {
          id: '3p-weekly',
          label: 'Other models 7d',
          minutes: 10080,
          usedPercentage: 0,
          resetsAt: NOW + 96 * HOUR,
          expired: false,
        },
      ],
    }
    expect(parts(pill(payload({ limits: null, agyLimits: zero3p }), true, 'en')).map(x => x[1])).toEqual([
      'Gemini',
      '5h 0%',
      '7d 9%',
    ])
    expect(parts(pill(payload({ limits: null, agyLimits: zero3p }), true, 'ru')).map(x => x[1])).toEqual([
      'Gemini',
      '5ч 0%',
      '7д 9%',
    ])
    const zeroEnPop = findAll(
      popFrame(payload({ limits: null, agyLimits: zero3p }), true, 'en'),
      el => el.attrs.get('data-provider') === 'agy',
    )[0] as Element
    expect(textOf(zeroEnPop)).toContain('Used: 5h: 0% · 7d: 9%')
    expect(textOf(zeroEnPop)).not.toContain('Other models')
    const zeroRuPop = findAll(
      popFrame(payload({ limits: null, agyLimits: zero3p }), true, 'ru'),
      el => el.attrs.get('data-provider') === 'agy',
    )[0] as Element
    expect(textOf(zeroRuPop)).toContain('Израсходовано: 5ч: 0% · 7д: 9%')
    expect(textOf(zeroRuPop)).not.toContain('Другие модели')

    // Non-zero 3p window appears after Gemini windows, localized and carrying the explanatory tooltip.
    const active3p: BoardAgyLimits = {
      source: 'statusline',
      observedAt: NOW - MIN,
      stale: false,
      windows: [
        { id: '3p-5h', label: '3p 5h', minutes: 300, usedPercentage: 12, resetsAt: NOW + 2 * HOUR, expired: false },
        {
          id: '3p-weekly',
          label: '3p 7d',
          minutes: 10080,
          usedPercentage: 0,
          resetsAt: NOW + 96 * HOUR,
          expired: false,
        },
        {
          id: 'gemini-weekly',
          label: '7d',
          minutes: 10080,
          usedPercentage: 9,
          resetsAt: NOW + 96 * HOUR,
          expired: false,
        },
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 35, resetsAt: NOW + 2 * HOUR, expired: false },
      ],
    }

    const enPill = pill(payload({ limits: null, agyLimits: active3p }), true, 'en')
    expect(parts(enPill).map(x => x[1])).toEqual(['Gemini', '5h 35%', '7d 9%', 'Other models 5h 12%'])
    const enPillSpans = elementsIn(enPill)
    expect(enPillSpans[1]?.attrs.get('title')).toBeUndefined()
    expect(enPillSpans[3]?.attrs.get('title')).toBe('Third-party models in Antigravity, such as Claude')

    const ruPill = pill(payload({ limits: null, agyLimits: active3p }), true, 'ru')
    expect(parts(ruPill).map(x => x[1])).toEqual(['Gemini', '5ч 35%', '7д 9%', 'Другие модели 5ч 12%'])
    const ruPillSpans = elementsIn(ruPill)
    expect(ruPillSpans[1]?.attrs.get('title')).toBeUndefined()
    expect(ruPillSpans[3]?.attrs.get('title')).toBe('Сторонние модели в Antigravity, например Claude')

    const enSection = findAll(
      popFrame(payload({ limits: null, agyLimits: active3p }), true, 'en'),
      el => el.attrs.get('data-provider') === 'agy',
    )[0] as Element
    expect(textOf(enSection)).toContain('Used: 5h: 35% · 7d: 9% · Other models 5h: 12%')
    const enTips = findAll(enSection.children, el => el.attrs.has('title'))
    expect(enTips.length).toBeGreaterThanOrEqual(1)
    for (const el of enTips) {
      expect(el.attrs.get('title')).toBe('Third-party models in Antigravity, such as Claude')
      expect(textOf(el)).toContain('Other models 5h')
    }

    const ruSection = findAll(
      popFrame(payload({ limits: null, agyLimits: active3p }), true, 'ru'),
      el => el.attrs.get('data-provider') === 'agy',
    )[0] as Element
    expect(textOf(ruSection)).toContain('Израсходовано: 5ч: 35% · 7д: 9% · Другие модели 5ч: 12%')
    const ruTips = findAll(ruSection.children, el => el.attrs.has('title'))
    expect(ruTips.length).toBeGreaterThanOrEqual(1)
    for (const el of ruTips) {
      expect(el.attrs.get('title')).toBe('Сторонние модели в Antigravity, например Claude')
      expect(textOf(el)).toContain('Другие модели 5ч')
    }
  })
})
