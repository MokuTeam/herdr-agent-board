// POST /api/settings and the limits on agent starts (#815): written on the computer itself only.
// Through a remote listener (a paired device, the owner's own login) an edit naming them is
// refused and nothing of it written; the board's other settings go as before.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../src/adapters/config-file.ts'
import { configDir } from '../../src/adapters/paths.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { dispatch, type GuardState } from '../../src/server/http.ts'
import { settingsRoute } from '../../src/server/routes/settings.ts'
import { isolatedHome } from '../support/env.ts'

const state: GuardState = { port: 12422, token: 't', stale: () => false }
const post = (body: unknown, remote: boolean) => {
  const r = new Request('http://127.0.0.1:12422/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
  return dispatch([settingsRoute()], r, new URL(r.url), '/api/settings', { ...state, remote }, () => '127.0.0.1')
}
const saved = () => JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) as Record<string, unknown>

test('agent starts: refused from another device, written on the computer; other settings from anywhere', async () => {
  isolatedHome()
  useLanguage('en')
  loadConfig()
  const away = await post({ spawnLimits: { agents: false }, language: 'ru' }, true)
  expect(away.status).toBe(403)
  expect(await away.json()).toEqual({
    ok: false,
    error: 'Agent starts are set on the computer itself, not from another device',
  })
  expect(saved().spawnLimits).toBeUndefined()
  expect(saved().language).not.toBe('ru')
  expect((await post({ foldWaiting: 'over' }, true)).status).toBe(200)
  expect(saved().foldWaiting).toBe('over')
  expect((await post({ spawnLimits: { children: 5 } }, false)).status).toBe(200)
  expect(saved().spawnLimits).toEqual({ children: 5 })
})
