import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translator } from '../../src/core/i18n/translator.ts'
import { type LiveData, liveView } from '../../web/src/models/live.ts'
import { OLD_LIVE, oldFunction } from './support/old-app.ts'

const STATES: LiveData[] = [
  { stale: true, lastSuccessfulRefreshAt: null },
  { stale: false, lastSuccessfulRefreshAt: 1000 },
  { stale: true, lastSuccessfulRefreshAt: 1000 },
  { stale: false, lastSuccessfulRefreshAt: 1001 },
]

test('live indicator distinguishes waiting, fresh and stale data and recovers with identical items', () => {
  const t = translator('en')
  const [waiting, fresh, stale, back] = STATES.map(data => liveView(data, t))
  assert.equal(waiting?.fresh, false)
  assert.match(waiting?.title ?? '', /Waiting/)
  assert.equal(fresh?.fresh, true)
  assert.equal(stale?.fresh, false)
  assert.match(stale?.title ?? '', /out of date/)
  assert.match(translator('ru')('live.stale', { time: '12:00' }), /устарели/)
  assert.equal(back?.fresh, true)
})

test('the same class and title as the old page’s updateLive (web/live.js at the parity baseline)', () => {
  for (const lang of ['en', 'ru']) {
    const t = translator(lang)
    for (const data of STATES) {
      const classes = new Set<string>()
      const element = {
        classList: {
          toggle(name: string, on: boolean) {
            if (on) classes.add(name)
            else classes.delete(name)
          },
        },
        title: '',
      }
      oldFunction(OLD_LIVE, 'updateLive')(element, data, t)
      const view = liveView(data, t)
      assert.deepEqual([classes.has('on'), classes.has('stale'), element.title], [view.fresh, !view.fresh, view.title])
    }
  }
})
