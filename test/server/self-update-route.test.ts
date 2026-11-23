// Settings → Updates… (#617): editAutoUpdate into config.json's `autoUpdate` (on and off as the
// feature switches go, every and at kept while off, a wrong value refusing the whole edit), and
// /api/self-update: its view, the settings and Check now, on the computer only, X-Board needed.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, editAutoUpdate } from '../../src/adapters/config-file.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { autoUpdateConfig, type UpdateState } from '../../src/core/self-update.ts'
import { dispatch } from '../../src/server/http.ts'
import { selfUpdateRoutes } from '../../src/server/routes/self-update.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import type { CheckResult, SelfUpdate } from '../../src/services/self-update.ts'
import { isolatedHome } from '../support/env.ts'

const STATE = { port: 12422, token: '', stale: () => false }
const config = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
function fresh(raw: Record<string, unknown>): void {
  isolatedHome()
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  mkdirSync(join(configFile(), '..'), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(raw))
}

test('on is true or the section, off keeps every and at under on:false, other keys as they were', () => {
  const others = { language: 'en', todos: true }
  fresh(others)
  expect(editAutoUpdate({ on: true })).toEqual({ ok: true })
  expect(config().autoUpdate).toBe(true)
  expect(editAutoUpdate({ every: 'day', at: '05:30' })).toEqual({ ok: true })
  expect(config().autoUpdate).toEqual({ every: 'day', at: '05:30' })
  expect(editAutoUpdate({ on: false })).toEqual({ ok: true })
  expect(config().autoUpdate).toEqual({ every: 'day', at: '05:30', on: false })
  expect(autoUpdateConfig(config().autoUpdate)).toEqual({ on: false, every: 'day', at: '05:30' })
  // a field set while off stays off
  expect(editAutoUpdate({ every: 'hour' })).toEqual({ ok: true })
  expect(autoUpdateConfig(config().autoUpdate).on).toBe(false)
  expect(editAutoUpdate({ on: true })).toEqual({ ok: true })
  expect(config().autoUpdate).toEqual({ every: 'hour', at: '05:30' })
  const { autoUpdate: _, ...rest } = config()
  expect(rest).toEqual(others)
  // off with nothing of its own: the key goes
  fresh({ autoUpdate: true })
  expect(editAutoUpdate({ on: false })).toEqual({ ok: true })
  expect('autoUpdate' in config()).toBe(false)
})

test('a wrong value, or none, refuses the whole edit and writes nothing', () => {
  fresh({ language: 'en' })
  const before = readFileSync(configFile(), 'utf8')
  for (const body of [{}, { on: 'yes' }, { every: 'week' }, { at: '4am' }, { on: true, at: '24:00' }])
    expect(editAutoUpdate(body).ok).toBe(false)
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
})

function app(state: UpdateState = {}) {
  let checks = 0
  const updater: SelfUpdate = {
    check: async () => {
      checks++
      return { at: 1, outcome: 'current', branch: 'main', commit: 'c'.repeat(40) } satisfies CheckResult
    },
    resume: async () => null,
    tick: async () => null,
    running: () => false,
  }
  const routes = selfUpdateRoutes({
    updater,
    load: () => state,
    checkout: async () => ({ branch: 'main', commit: 'c'.repeat(40) }),
    node: () => false,
    canRestart: true,
    changed: () => {},
  })
  const call = async (method: string, body?: unknown, headers: Record<string, string> = { 'x-board': '1' }) => {
    const url = new URL('http://127.0.0.1:12422/api/self-update')
    const req = new Request(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const res = await dispatch(routes, req, url, url.pathname, STATE)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { call, checks: () => checks }
}

test('the route stays on the computer, wants X-Board, and answers with its view', async () => {
  for (const owner of [false, true])
    expect(remoteRefusal('/api/self-update', '/api/self-update', false, owner, owner)?.status).toBe(403)
  fresh({ language: 'en' })
  const a = app({ last: { at: 1, outcome: 'skipped', reason: 'dirty', branch: 'main', detail: ' M a.ts' } })
  const got = await a.call('GET')
  expect(got.status).toBe(200)
  expect(got.body).toMatchObject({
    config: { on: false, every: 'hour', at: '04:00' },
    checkout: { branch: 'main' },
    node: false,
    standing: { level: 'warn' },
  })
  expect(String((got.body.standing as { text: string }).text)).toContain('files of the checkout are changed')
  expect((await a.call('POST', { op: 'settings', on: true }, {})).status).toBe(403)
  expect('autoUpdate' in config()).toBe(false)
  const set = await a.call('POST', { op: 'settings', on: true, every: 'day', at: '03:15' })
  expect(set.status).toBe(200)
  expect(config().autoUpdate).toEqual({ every: 'day', at: '03:15' })
  expect((set.body.view as { config: unknown }).config).toEqual({ on: true, every: 'day', at: '03:15' })
  expect((await a.call('POST', { op: 'settings', every: 'week' })).status).toBe(400)
  const check = await a.call('POST', { op: 'check' })
  expect(check.body).toMatchObject({ ok: true, result: { outcome: 'current' } })
  expect(a.checks()).toBe(1)
  expect((await a.call('POST', { op: 'nope' })).status).toBe(400)
})
