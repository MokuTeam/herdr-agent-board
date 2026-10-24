// The web board's presence API (#172): GET /api/presence and POST for the switch and the setting,
// the board's payload carrying it only while it is on, and detection running against a fake
// computer (TEST_PRESENCE_OBS) instead of this one.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const configOf = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
const presenceFile = (box: Sandbox): string =>
  join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/presence.json')
const CFG = {
  language: 'en',
  categories: [{ id: 'other', title: 'Other', color: 'gray' }],
  wakeUrl: null,
  refreshSec: 3600,
}

async function board(box: Sandbox, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const cfg = { ...CFG, ...extra }
  mkdirSync(join(configOf(box), '..'), { recursive: true })
  writeFileSync(configOf(box), JSON.stringify(cfg))
  const { url } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1', ...env })
  const get = async () =>
    ((await (await fetch(`${url}/api/presence`)).json()) as { presence: Record<string, unknown> | null }).presence
  const post = async (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) => {
    const res = await fetch(`${url}/api/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return [res.status, await res.json()] as [number, Record<string, unknown>]
  }
  const payload = async () => (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
  return { url, get, post, payload }
}

/** Polls until `fn` holds (the config watcher and the detection timer run on their own). */
async function eventually(fn: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

test('off: GET says null, the payload has no presence, a switch is refused, no file', async () => {
  const box = await sandbox()
  const b = await board(box)
  expect(await b.get()).toBeNull()
  expect(await b.payload()).not.toHaveProperty('presence')
  const [status, body] = await b.post({ state: 'away' })
  expect(status).toBe(409)
  expect(body.error).toMatch(/Presence is off/)
  expect(existsSync(presenceFile(box))).toBe(false)
})

test('the setting turns it on; the switch answers changed; the payload carries it; off forgets it', async () => {
  const box = await sandbox()
  const b = await board(box)
  expect(await b.post({ op: 'settings', on: true, idleMinutes: 20 })).toEqual([200, { ok: true }])
  expect(JSON.parse(readFileSync(configOf(box), 'utf8')).presence).toEqual({ mode: 'auto', idleMinutes: 20 })
  await eventually(async () => (await b.get()) !== null)
  expect(await b.get()).toMatchObject({ state: 'here', mode: 'auto', idleMinutes: 20, hint: null })

  const [status, body] = await b.post({ state: 'away', from: 'phone' })
  expect(status).toBe(200)
  expect(body).toMatchObject({ ok: true, changed: true, presence: { state: 'away', by: 'user', from: 'phone' } })
  expect((await b.post({ state: 'away', from: 'auto' }))[1]).toMatchObject({ changed: false })
  expect((await b.payload()).presence).toMatchObject({ state: 'away', mode: 'auto' })
  // A source the API does not know (or 'auto', the board's own) is 'api'.
  const [, here] = await b.post({ state: 'here', from: 'auto' })
  expect(here.presence).toMatchObject({ state: 'here', from: 'api' })

  expect(await b.post({ op: 'settings', on: false })).toEqual([200, { ok: true }])
  await eventually(async () => (await b.get()) === null)
  expect(existsSync(presenceFile(box))).toBe(false)
  expect(await b.payload()).not.toHaveProperty('presence')
})

test('refusals: a bad state, a bad setting, no board header', async () => {
  const box = await sandbox()
  const b = await board(box, { presence: true })
  expect((await b.post({ state: 'gone' }))[0]).toBe(400)
  expect(await b.post({ op: 'settings', idleMinutes: 0 })).toEqual([
    409,
    { ok: false, error: expect.stringMatching(/1440/) },
  ])
  expect((await b.post({ state: 'away' }, {}))[0]).toBe(403)
  expect(existsSync(presenceFile(box))).toBe(false)
})

test('detection flips it on the fake computer’s idle time, and back on input', async () => {
  const box = await sandbox()
  const obs = join(box.dir, 'obs.json')
  writeFileSync(obs, JSON.stringify({ idleSec: 5, locked: null }))
  const b = await board(
    box,
    { presence: { mode: 'auto', idleMinutes: 1 } },
    { TEST_PRESENCE_OBS: obs, TEST_PRESENCE_MS: '50' },
  )
  await eventually(async () => (await b.get())?.detects === true)
  expect((await b.get())?.state).toBe('here')
  writeFileSync(obs, JSON.stringify({ idleSec: 120, locked: null }))
  await eventually(async () => (await b.get())?.state === 'away')
  expect(await b.get()).toMatchObject({ by: 'auto', from: 'auto' })
  writeFileSync(obs, JSON.stringify({ idleSec: 0, locked: null }))
  await eventually(async () => (await b.get())?.state === 'here')
})

test('suggest: the offer is in the view, nothing switches by itself', async () => {
  const box = await sandbox()
  const obs = join(box.dir, 'obs.json')
  writeFileSync(obs, JSON.stringify({ idleSec: null, locked: true }))
  const b = await board(box, { presence: { mode: 'suggest' } }, { TEST_PRESENCE_OBS: obs, TEST_PRESENCE_MS: '50' })
  await eventually(async () => (await b.get())?.hint === 'away')
  expect((await b.get())?.state).toBe('here')
  expect(existsSync(presenceFile(box))).toBe(false)
})
