import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translator } from '../src/core/i18n/translator.ts'
import { updateLive } from '../web/live.js'

test('live indicator distinguishes waiting, fresh and stale data and recovers with identical items', () => {
  const classes = new Set()
  const element = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name) } }, title: '' }
  const t = translator('en')
  updateLive(element, { stale: true, lastSuccessfulRefreshAt: null }, t)
  assert.equal(classes.has('on'), false)
  assert.match(element.title, /Waiting/)
  updateLive(element, { stale: false, lastSuccessfulRefreshAt: 1000 }, t)
  assert.equal(classes.has('on'), true)
  updateLive(element, { stale: true, lastSuccessfulRefreshAt: 1000 }, t)
  assert.equal(classes.has('on'), false)
  assert.equal(classes.has('stale'), true)
  assert.match(element.title, /out of date/)
  assert.match(translator('ru')('live.stale', { time: '12:00' }), /устарели/)
  updateLive(element, { stale: false, lastSuccessfulRefreshAt: 1001 }, t)
  assert.equal(classes.has('on'), true)
  assert.equal(classes.has('stale'), false)
})
