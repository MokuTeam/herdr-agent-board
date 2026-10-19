// The live dot's class and title in each state the old page put it in (updateLive, the
// connection callback and applyTexts in web/app.js).
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { LiveDot } from '../../web/src/components/LiveDot.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { canonical, parseHtml } from './support/markup.ts'

const t = translator('en')
const dot = (className: string, title: string) =>
  canonical(parseHtml(`<span class="${className}" id="live" title="${title}"></span>`))
const render = (value: ReturnType<typeof board>) => canonical(renderInBoard(<LiveDot />, value))

test('live dot: not connected yet, dropped, waiting, fresh and out of date', () => {
  expect(render(board({ data: null }))).toBe(dot('live stale', t('live.none')))
  expect(render(board({ data: payload(), connected: false, dropped: true }))).toBe(dot('live stale', t('live.off')))
  expect(render(board({ data: payload({ stale: true, lastSuccessfulRefreshAt: null }) }))).toBe(
    dot('live stale', t('live.waiting')),
  )
  expect(render(board({ data: payload({ stale: false, lastSuccessfulRefreshAt: 1000 }) }))).toBe(
    dot('live on', t('live.on')),
  )
  const time = new Date(5000).toLocaleTimeString('en')
  expect(render(board({ data: payload({ stale: true, lastSuccessfulRefreshAt: 5000 }) }))).toBe(
    dot('live stale', t('live.stale', { time })),
  )
})
