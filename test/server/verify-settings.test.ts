// Settings -> Verified done (#680): readThreadsSettings and editThreads verifySettings into
// config.json under its lock, setting and clearing every threads.verify field (model, profile
// string or per-device map, lanes, brief string or per-lane map, limitMin, max), preserving
// unknown keys and #597 off-keeps-values behaviour, remote/door refusals, payload parity for other
// setups, and live running board updates.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, editThreads, readThreadsSettings } from '../../src/adapters/config-file.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { doorRefusal } from '../../src/core/node-door.ts'
import { VERIFY_CODE_CHECKLIST, VERIFY_LIMIT_MIN, VERIFY_MAX, verifyConfig } from '../../src/core/work-threads.ts'
import { dispatch } from '../../src/server/http.ts'
import { revStream, type ThreadsApp, threadsRoutes } from '../../src/server/routes/threads.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { threadsPayload } from '../../src/services/work-threads.ts'
import { serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { sandbox } from '../support/sandbox.ts'

const STATE = { port: 12422, token: '', stale: () => false }
const config = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
function writeConfig(raw: Record<string, unknown>): void {
  mkdirSync(join(configFile(), '..'), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(raw))
}
function fresh(raw: Record<string, unknown>): void {
  isolatedHome()
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  writeConfig(raw)
}

async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

test('set and clear every threads.verify field under config.json lock; clearing all while on returns verify: true', () => {
  fresh({ language: 'en', threads: { verify: true }, team: { hub: 'h', name: 'anna' } })

  expect(editThreads({ verifySettings: { model: 'sonnet' } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ verify: { model: 'sonnet' } })

  expect(editThreads({ verifySettings: { profile: 'work' } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ verify: { model: 'sonnet', profile: 'work' } })

  expect(editThreads({ verifySettings: { profile: { local: 'work', 'atlas-1': 'default' } } })).toEqual({
    ok: true,
    on: true,
  })
  expect(config().threads).toEqual({
    verify: { model: 'sonnet', profile: { local: 'work', 'atlas-1': 'default' } },
  })

  expect(editThreads({ verifySettings: { lanes: ['atlas', 'Cleo'] } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({
    verify: { model: 'sonnet', profile: { local: 'work', 'atlas-1': 'default' }, lanes: ['atlas', 'cleo'] },
  })

  expect(editThreads({ verifySettings: { brief: VERIFY_CODE_CHECKLIST } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({
    verify: {
      model: 'sonnet',
      profile: { local: 'work', 'atlas-1': 'default' },
      lanes: ['atlas', 'cleo'],
      brief: VERIFY_CODE_CHECKLIST,
    },
  })

  expect(
    editThreads({
      verifySettings: { brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'docs/agents/verify-checklist.md' } },
    }),
  ).toEqual({ ok: true, on: true })
  expect(editThreads({ verifySettings: { limitMin: 45, max: 3 } })).toEqual({ ok: true, on: true })

  expect(verifyConfig((config().threads as { verify: unknown }).verify)).toEqual({
    model: 'sonnet',
    profile: { local: 'work', 'atlas-1': 'default' },
    lanes: ['atlas', 'cleo'],
    brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'docs/agents/verify-checklist.md' },
    limitMin: 45,
    max: 3,
  })

  // Clear each field one by one; clearing all collapses back to verify: true.
  expect(editThreads({ verifySettings: { model: null } })).toEqual({ ok: true, on: true })
  expect(editThreads({ verifySettings: { profile: null } })).toEqual({ ok: true, on: true })
  expect(editThreads({ verifySettings: { lanes: [] } })).toEqual({ ok: true, on: true })
  expect(editThreads({ verifySettings: { brief: null } })).toEqual({ ok: true, on: true })
  expect(editThreads({ verifySettings: { limitMin: null, max: null } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ verify: true })
  expect(config().team).toEqual({ hub: 'h', name: 'anna' })
})

test('off keeps configured values (#597); editing and clearing while off preserve on: false and remove verify once empty', () => {
  fresh({ threads: { verify: { model: 'opus', lanes: ['atlas'], limitMin: 20 } } })
  expect(editThreads({ verify: false })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ verify: { model: 'opus', lanes: ['atlas'], limitMin: 20, on: false } })

  // Editing while off keeps on: false and leaves the rest intact.
  expect(editThreads({ verifySettings: { max: 4 } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ verify: { model: 'opus', lanes: ['atlas'], limitMin: 20, max: 4, on: false } })

  // Turning back on restores all fields without on: false.
  expect(editThreads({ verify: true })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ verify: { model: 'opus', lanes: ['atlas'], limitMin: 20, max: 4 } })

  // Turning off then clearing every field removes verify altogether and simplifies threads back to true.
  expect(editThreads({ verify: false })).toEqual({ ok: true, on: true })
  expect(editThreads({ verifySettings: { model: null, lanes: null, limitMin: null, max: null } })).toEqual({
    ok: true,
    on: true,
  })
  expect(config().threads).toBe(true)
})

test('hand-written config.json reads back unchanged and unknown keys in threads and threads.verify are kept', () => {
  const hand = {
    agents: false,
    events: { gapSec: 15 },
    customThreadKey: { keep: 1 },
    verify: {
      model: 'claude-opus-5-5',
      profile: { local: 'work', 'ben-box': 'default' },
      lanes: ['atlas', 'ben'],
      brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'checks/general.md' },
      limitMin: 40,
      max: 4,
      futureKey: { nested: true },
    },
  }
  fresh({ threads: hand })
  const view = readThreadsSettings()
  expect(view).toEqual({
    threadsOn: true,
    verify: {
      on: true,
      settings: {
        model: 'claude-opus-5-5',
        profile: { local: 'work', 'ben-box': 'default' },
        lanes: ['atlas', 'ben'],
        brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'checks/general.md' },
        limitMin: 40,
        max: 4,
      },
      defaults: { limitMin: VERIFY_LIMIT_MIN, max: VERIFY_MAX },
    },
  })

  // Changing one field and clearing another leaves unknown keys and other fields untouched.
  expect(editThreads({ verifySettings: { model: 'haiku', limitMin: null } })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({
    agents: false,
    events: { gapSec: 15 },
    customThreadKey: { keep: 1 },
    verify: {
      model: 'haiku',
      profile: { local: 'work', 'ben-box': 'default' },
      lanes: ['atlas', 'ben'],
      brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'checks/general.md' },
      max: 4,
      futureKey: { nested: true },
    },
  })
})

test('invalid verifySettings values and threads-off edits are refused and leave config.json untouched', () => {
  fresh({ language: 'en', threads: { verify: { model: 'sonnet' } } })
  const before = readFileSync(configFile(), 'utf8')
  const badBodies = [
    { verifySettings: null },
    { verifySettings: {} },
    { verifySettings: { unknown: 1 } },
    { verifySettings: { model: '-bad-flag' } },
    { verifySettings: { model: 'two words' } },
    { verifySettings: { profile: 'a\nb' } },
    { verifySettings: { profile: { 'bad id!': 'work' } } },
    { verifySettings: { profile: { local: 42 } } },
    { verifySettings: { lanes: 'atlas' } },
    { verifySettings: { lanes: ['bad lane!'] } },
    { verifySettings: { brief: 'bad\u0000path' } },
    { verifySettings: { brief: { 'bad lane!': 'x.md' } } },
    { verifySettings: { limitMin: 0 } },
    { verifySettings: { limitMin: 1441 } },
    { verifySettings: { limitMin: 1.5 } },
    { verifySettings: { max: 0 } },
    { verifySettings: { max: 11 } },
    { verifySettings: { max: '2' } },
  ]
  for (const body of badBodies) {
    const res = editThreads(body)
    expect(res.ok).toBe(false)
  }
  expect(readFileSync(configFile(), 'utf8')).toBe(before)

  // Refused when threads are off.
  writeConfig({ language: 'en' })
  const offBefore = readFileSync(configFile(), 'utf8')
  expect(editThreads({ verifySettings: { model: 'opus' } })).toEqual({
    ok: false,
    error: 'Threads are off (config.json: "threads")',
  })
  expect(readFileSync(configFile(), 'utf8')).toBe(offBefore)
})

test('under config.json lock: refused in words and nothing written', () => {
  fresh({ language: 'en', threads: true })
  const saved = process.env.BOARD_LOCK_TIMEOUT_MS
  process.env.BOARD_LOCK_TIMEOUT_MS = '100'
  mkdirSync(`${configFile()}.lock`)
  try {
    const r = editThreads({ verifySettings: { model: 'opus' } })
    expect(r.ok).toBe(false)
    expect(config().threads).toBe(true)
  } finally {
    if (saved === undefined) delete process.env.BOARD_LOCK_TIMEOUT_MS
    else process.env.BOARD_LOCK_TIMEOUT_MS = saved
  }
})

test('GET and POST /api/threads-settings: auth, validation, remote/door refusals, and payload parity for other setups', async () => {
  fresh({
    language: 'en',
    threads: { agents: false, verify: { model: 'opus', lanes: ['atlas'], limitMin: 25 } },
  })
  const cfg: { threads?: unknown } = { threads: config().threads }
  const app: ThreadsApp = {
    cfg,
    changed() {},
    tell: async () => ({ ok: true }),
    clearAsk() {},
  }
  const routes = threadsRoutes(app, revStream())
  const call = async (method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = { 'x-board': '1' }) => {
    const url = new URL('http://127.0.0.1:12422/api/threads-settings')
    const req = new Request(url, {
      method,
      headers: { ...(method === 'POST' && { 'content-type': 'application/json' }), ...headers },
      ...(method === 'POST' && { body: JSON.stringify(body) }),
    })
    const res = await dispatch(routes, req, url, url.pathname, STATE)
    cfg.threads = config().threads
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  expect(await call('GET')).toEqual({
    status: 200,
    body: {
      threadsOn: true,
      verify: {
        on: true,
        settings: {
          model: 'opus',
          lanes: ['atlas'],
          brief: null,
          profile: null,
          limitMin: 25,
          max: null,
        },
        defaults: { limitMin: VERIFY_LIMIT_MIN, max: VERIFY_MAX },
      },
    },
  })

  // Missing X-Board on POST is refused (403).
  expect((await call('POST', { verifySettings: { max: 3 } }, {})).status).toBe(403)
  // Valid POST returns { ok: true } (same contract as existing tests).
  expect(await call('POST', { verifySettings: { max: 3 } })).toEqual({ status: 200, body: { ok: true } })
  // Invalid POST returns 400.
  expect((await call('POST', { verifySettings: { max: 99 } })).status).toBe(400)

  // Remote listener refuses both GET and POST (even owner login), and node door refuses both (404).
  for (const owner of [false, true]) {
    expect(remoteRefusal('/api/threads-settings', '/api/threads-settings', false, owner, owner)?.status).toBe(403)
  }
  expect(doorRefusal('GET', '/api/threads-settings', '/api/threads-settings')?.status).toBe(404)
  expect(doorRefusal('POST', '/api/threads-settings', '/api/threads-settings')?.status).toBe(404)

  // Board payload line for other setups stays identical: only verify: true when on, absent when off.
  expect(threadsPayload({ threads: config().threads })).toEqual({ rev: 0, needsOwner: 0, agents: false, verify: true })
  expect(threadsPayload({ threads: true })).toEqual({ rev: 0, needsOwner: 0 })
})

test('a running board serves GET /api/threads-settings and follows POST verifySettings live', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const wake = await fakeWake()
  try {
    const cfg = { language: 'en', wakeUrl: wake.url, threads: true }
    const file = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg))
    const { url, proc } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1', BOARD_TEST_PACE: '0.02' })
    const getSettings = async () => (await fetch(`${url}/api/threads-settings`)).json()
    const postSettings = (body: Record<string, unknown>) =>
      fetch(`${url}/api/threads-settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })

    expect(
      await postSettings({ verify: true, verifySettings: { model: 'opus', lanes: ['atlas'], limitMin: 45, max: 3 } }),
    ).toSatisfy((r: Response) => r.status === 200)
    const view = (await getSettings()) as { verify: { on: boolean; settings: Record<string, unknown> } }
    expect(view.verify.on).toBe(true)
    expect(view.verify.settings).toMatchObject({ model: 'opus', lanes: ['atlas'], limitMin: 45, max: 3 })

    await until(async () => {
      proc.send('refresh')
      await Bun.sleep(40)
      const board = (await (await fetch(`${url}/api/board`)).json()) as { threads?: { verify?: boolean } }
      return board.threads?.verify === true
    })
  } finally {
    wake.down()
  }
}, 30_000)
