// The usage popover's forecast (#173): when a window runs out at the pace it has averaged since it
// started, and whether that comes before its reset.
import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { forecast, type LimitReading } from '../../web/src/models/limits.ts'
import { board, payload, renderInBoard } from './support/board.tsx'
import { canonical } from './support/markup.ts'

const H = 3_600_000
const NOW = Date.now()
// A 7d window that started 3 days ago (resets in 4) and a 5h one that started 2 hours ago (resets in 3).
const week = (used: number, resetsAt: number | null = NOW + 96 * H) =>
  ({ minutes: 10080, usedPercentage: used, resetsAt, expired: false }) as LimitReading
const five = (used: number) =>
  ({ minutes: 300, usedPercentage: used, resetsAt: NOW + 3 * H, expired: false }) as LimitReading

test('a steady burn: out before the reset when the pace is too fast, else lasts', () => {
  // 3 of 7 days gone, 60% used: 20% a day runs out at day 5, two days before the reset.
  expect(forecast(week(60), NOW)).toEqual({ kind: 'out', at: NOW + 48 * H, resetsAt: NOW + 96 * H })
  // 30% in 3 days lasts the week.
  expect(forecast(week(30), NOW)).toEqual({ kind: 'lasts', resetsAt: NOW + 96 * H })
  // 2 of 5 hours gone at 80%: out half an hour from now.
  expect(forecast(five(80), NOW)).toEqual({ kind: 'out', at: NOW + H / 2, resetsAt: NOW + 3 * H })
})

test('nothing used yet lasts; nothing forecast where the reading cannot tell', () => {
  expect(forecast(week(0), NOW)).toEqual({ kind: 'lasts', resetsAt: NOW + 96 * H })
  // No reset time (the old cache shape), no reading time, already used up.
  expect(forecast(week(60, null), NOW)).toBeNull()
  expect(forecast({ minutes: 300, usedPercentage: 50 }, NOW)).toBeNull()
  expect(forecast(week(60), null)).toBeNull()
  expect(forecast(week(100), NOW)).toBeNull()
  // The first tenth of a window: 10 hours into the week, the average is noise.
  expect(forecast(week(5, NOW + 158 * H), NOW)).toBeNull()
  // A reading from before the window started: it has reset since.
  expect(forecast(week(60, NOW + 200 * H), NOW)).toBeNull()
})

const reading = (fields: Partial<NonNullable<BoardPayload['limits']>> = {}): BoardPayload['limits'] => ({
  source: 'statusline',
  observedAt: NOW,
  stale: false,
  windows: [five(30), week(60)] as NonNullable<BoardPayload['limits']>['windows'],
  ...fields,
})
const render = (limits: BoardPayload['limits'], lang = 'en') =>
  canonical(
    renderInBoard(<LimitsPop anchor={createRef<HTMLButtonElement>()} />, board({ data: payload({ limits }) }), lang),
  )
const at = (ms: number, lang: string) =>
  new Date(ms).toLocaleString(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

test('the popover says it per window, the one that runs out as a warning', () => {
  for (const lang of ['en', 'ru']) {
    const t = translator(lang)
    const html = render(reading(), lang)
    expect(html).toContain(
      `<p class="">${t('limits.forecastLasts', { window: t('limits.5h'), reset: at(NOW + 3 * H, lang) })}</p>`,
    )
    expect(html).toContain(
      `<p class="limits-warning">${t('limits.forecastOut', { window: t('limits.7d'), at: at(NOW + 48 * H, lang), reset: at(NOW + 96 * H, lang) })}</p>`,
    )
  }
})

test('a stale reading forecasts nothing', () => {
  expect(render(reading({ stale: true }))).not.toContain('at this pace')
  expect(render(reading())).toContain('at this pace')
})
