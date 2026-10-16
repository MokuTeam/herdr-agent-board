// The usage popover against today's: the #limits-pop block of web/index.html after applyTexts()
// and renderLimits() filled #limits-content for the same reading.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { LimitsPop } from '../../web/src/components/LimitsPop.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import {
  addButtonTypes,
  applyTexts,
  byId,
  canonical,
  type Node,
  OLD_PAGE_ONLY,
  pageMarkup,
  removeAttr,
  setHtml,
  stripAttrs,
} from './support/markup.ts'

const NOW = Date.now()
const reading = (fields: Partial<NonNullable<BoardPayload['limits']>> = {}): BoardPayload['limits'] => ({
  source: 'usagebar',
  observedAt: NOW - 60_000,
  stale: false,
  windows: [
    { minutes: 300, usedPercentage: 92, resetsAt: null, expired: false },
    { minutes: 10080, usedPercentage: 40.4, resetsAt: null, expired: false },
  ],
  ...fields,
})

function oldPop(lang: string, content: string): Node[] {
  const pop = [byId(pageMarkup(), 'limits-pop')]
  applyTexts(pop, translator(lang))
  setHtml(byId(pop, 'limits-content'), content)
  return pop
}

function asReactRendersIt(pop: Node[]): string {
  addButtonTypes(pop)
  stripAttrs(pop, OLD_PAGE_ONLY)
  return canonical(pop)
}

const render = (value: ReturnType<typeof board>, lang = 'en') =>
  canonical(renderInBoard(<LimitsPop anchor={createRef<HTMLButtonElement>()} />, value, lang))

const when = (at: number, lang: string) =>
  new Date(at).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })

describe('usage popover markup parity', () => {
  test('a fresh usagebar reading, closed', () => {
    const t = translator('en')
    const time = when(NOW - 60_000, 'en')
    const expected = oldPop(
      'en',
      `<p><b>Used:</b> 5h: 92% · 7d: 40%</p><p>${t('limits.hintUsagebar', { time })}</p><p class="">${t('limits.localReport', { time })}</p>`,
    )
    expect(render(board({ data: payload({ limits: reading() }) }))).toBe(asReactRendersIt(expected))
  })

  test('an old status-line reading in Russian, open', () => {
    const t = translator('ru')
    const at = NOW - 3_600_000
    const time = when(at, 'ru')
    const expected = oldPop(
      'ru',
      `<p><b>Израсходовано:</b> 5ч: 92% · 7д: 40%</p><p>${t('limits.hint', { time })}</p><p class="limits-warning">${t('limits.stale', { time })}</p>`,
    )
    removeAttr(byId(expected, 'limits-pop'), 'hidden')
    const value = board({
      data: payload({ limits: reading({ source: 'statusline', observedAt: at }) }),
      ui: { limitsOpen: true },
    })
    expect(render(value, 'ru')).toBe(asReactRendersIt(expected))
  })

  test('no reading, and a reading while the board is not connected', () => {
    const t = translator('en')
    expect(render(board({ data: payload({ limits: null }) }))).toBe(
      asReactRendersIt(oldPop('en', `<p>${t('limits.unavailable')}</p>`)),
    )
    const time = when(NOW - 60_000, 'en')
    const offline = oldPop(
      'en',
      `<p><b>Used:</b> 5h: 92% · 7d: 40%</p><p>${t('limits.hintUsagebar', { time })}</p><p class="limits-warning">${t('limits.stale', { time })}</p>`,
    )
    expect(render(board({ data: payload({ limits: reading() }), connected: false }))).toBe(asReactRendersIt(offline))
  })
})
