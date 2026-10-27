// The board's local key on its own server (adapters/local-key.ts): made once, 0600, kept; the
// programs that call the board's ports on 127.0.0.1 send it there and only there. On a PC fetch
// goes as it went: what it was given, no header, the key's file never read.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  ensureLocalKey,
  keyMatches,
  LOCAL_KEY_HEADER,
  localFetch,
  localKeyFile,
  readLocalKey,
} from '../../src/adapters/local-key.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import { isolatedHome } from '../support/env.ts'

const SERVER = { serverMode: { domain: 'board.example.com', socket: '/var/lib/agent-board/board.sock' } }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** globalThis.fetch replaced by a recorder of what it was given. */
function recordFetch(): { url: unknown; init: RequestInit | undefined }[] {
  const calls: { url: unknown; init: RequestInit | undefined }[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response('{}')
  }) as typeof fetch
  return calls
}

test('made once, 32 random bytes, 0600; the same key after; a file that holds no key replaced', () => {
  isolatedHome()
  expect(readLocalKey()).toBeNull()
  const key = ensureLocalKey()
  expect(key).toMatch(/^[\w-]{43}$/)
  expect(readFileSync(localKeyFile(), 'utf8')).toBe(`${key}\n`)
  if (process.platform !== 'win32') expect(statSync(localKeyFile()).mode & 0o777).toBe(0o600)
  expect(ensureLocalKey()).toBe(key)
  expect(readLocalKey()).toBe(key)
  writeFileSync(localKeyFile(), 'not a key\n')
  const again = ensureLocalKey()
  expect(again).toMatch(/^[\w-]{43}$/)
  expect(again).not.toBe(key)
  expect(readLocalKey()).toBe(again)
  // nothing left beside it
  expect(readdirSync(stateDir())).toEqual(['local-key'])
})

test('a key matches only itself', () => {
  const key = 'k'.repeat(43)
  expect(keyMatches(key, key)).toBe(true)
  expect(keyMatches(null, key)).toBe(false)
  expect(keyMatches('', key)).toBe(false)
  expect(keyMatches('k'.repeat(42), key)).toBe(false)
  expect(keyMatches(`${'k'.repeat(42)}j`, key)).toBe(false)
})

test('on a PC: fetch with what it was given, no header, even with a key on file', async () => {
  isolatedHome()
  mkdirSync(stateDir(), { recursive: true })
  ensureLocalKey()
  const calls = recordFetch()
  const init = { method: 'POST', headers: { 'x-board': '1' }, body: '{}' }
  for (const cfg of [{}, { serverMode: null }, { serverMode: 'yes' }, null, undefined]) {
    await localFetch(cfg)('http://127.0.0.1:12422/api/board', init)
    await localFetch(cfg)('http://127.0.0.1:12421/status')
  }
  expect(calls).toHaveLength(10)
  for (const [i, c] of calls.entries()) {
    expect(c.url).toBe(i % 2 ? 'http://127.0.0.1:12421/status' : 'http://127.0.0.1:12422/api/board')
    // the very object it was given, or none
    expect(c.init).toBe(i % 2 ? undefined : init)
  }
})

test('on the board’s server: the key on every call, the call’s own headers kept; none on file, none sent', async () => {
  isolatedHome()
  const calls = recordFetch()
  await localFetch(SERVER)('http://127.0.0.1:12421/status')
  expect(new Headers(calls[0]?.init?.headers).has(LOCAL_KEY_HEADER)).toBe(false)
  expect(existsSync(localKeyFile())).toBe(false)
  const key = ensureLocalKey()
  const signal = AbortSignal.timeout(5000)
  await localFetch(SERVER)('http://127.0.0.1:12422/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: '{"op":"test"}',
    signal,
  })
  await localFetch(SERVER)('http://127.0.0.1:12421/sleeping', { headers: new Headers({ accept: 'application/json' }) })
  const [, post, get] = calls
  const h = new Headers(post?.init?.headers)
  expect([h.get(LOCAL_KEY_HEADER), h.get('x-board'), h.get('content-type')]).toEqual([key, '1', 'application/json'])
  expect(post?.init?.method).toBe('POST')
  expect(post?.init?.body).toBe('{"op":"test"}')
  expect(post?.init?.signal).toBe(signal)
  const g = new Headers(get?.init?.headers)
  expect([g.get(LOCAL_KEY_HEADER), g.get('accept')]).toEqual([key, 'application/json'])
})

test('follows the config as it is at each call (a live one turned to the server mode)', async () => {
  isolatedHome()
  const key = ensureLocalKey()
  const calls = recordFetch()
  const cfg: { serverMode?: unknown } = {}
  const ask = localFetch(cfg)
  await ask('http://127.0.0.1:12422/api/board')
  cfg.serverMode = SERVER.serverMode
  await ask('http://127.0.0.1:12422/api/board')
  expect(calls[0]?.init).toBeUndefined()
  expect(new Headers(calls[1]?.init?.headers).get(LOCAL_KEY_HEADER)).toBe(key)
})

/** A wake on a port of the test's own: what it was asked (the path, and the key sent, '' for none), answered as wake answers. */
function wakeStub(): { port: number; asked: [string, string][]; stop(): void } {
  const asked: [string, string][] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: req => {
      const path = new URL(req.url).pathname
      asked.push([path, req.headers.get(LOCAL_KEY_HEADER) ?? ''])
      if (path === '/alive') return Response.json({ pid: 4242 })
      if (path === '/sleeping') return Response.json([])
      if (path === '/status')
        return Response.json({ pid: 4242, sessions: {}, sleeping: [], telegram: { state: 'off' } })
      return Response.json({ ok: true })
    },
  })
  return { port: Number(server.port), asked, stop: () => void server.stop(true) }
}

test('the board’s own calls to wake (a card’s sleep and wake, its list, the panel’s line, doctor’s facts) carry the key on its server; on a PC none', async () => {
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { writeWakeStatus } = await import('../../src/adapters/wake-files.ts')
  const { defaultDeps } = await import('../../src/services/deps.ts')
  const { createWakeControl } = await import('../../src/services/wake/control.ts')
  const { gatherFacts } = await import('../../src/adapters/setup-facts.ts')
  const item = { name: 'Billing', pane: 'w1:p1', key: 'w1:p1' } as never
  const ask = async (cfg: ReturnType<typeof normalizeConfig>): Promise<void> => {
    const deps = defaultDeps(cfg)
    await deps.wake.sleepers()
    await deps.wake.sleep(item)
    await deps.wake.wake(item)
    const control = createWakeControl({ cfg, starter: () => {} })
    await control.view()
    control.stop()
    await gatherFacts(cfg, { profiles: [], probeMs: 2000 })
  }
  const paths = ['/alive', '/sleeping', '/sleep', '/wake', '/status']
  for (const server of [true, false]) {
    isolatedHome()
    const key = ensureLocalKey()
    writeWakeStatus({ state: 'running', at: Date.now(), pid: 4242 })
    const wake = wakeStub()
    try {
      await ask(normalizeConfig({ ...(server && SERVER), wake: { enabled: true, port: wake.port } }))
      for (const path of paths) expect([path, wake.asked.some(([p]) => p === path)]).toEqual([path, true])
      // /alive (the health check) takes it or not
      for (const [path, sent] of wake.asked.filter(([p]) => !server || p !== '/alive'))
        expect([path, sent]).toEqual([path, server ? key : ''])
    } finally {
      wake.stop()
    }
  }
})
