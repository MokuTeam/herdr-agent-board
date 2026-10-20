// Test connection's probe-only listener: its one nonce, and nothing else.
import { expect, onTestFinished, test } from 'bun:test'
import { openProbeListener, probeAnswer } from '../../src/server/tunnel-probe.ts'

const NONCE = '0123456789abcdef0123456789abcdef'

async function opened(o?: { closeAfterMs?: number }) {
  const l = await openProbeListener(NONCE, o)
  onTestFinished(() => l.close())
  return { ...l, url: (path: string) => `http://127.0.0.1:${l.port}${path}` }
}

/** The port takes no connection. */
async function refuses(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return false
  } catch {
    return true
  }
}

test('probeAnswer: 200, the board and the nonce, never cached', async () => {
  const res = probeAnswer(NONCE)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.json()).toEqual({ board: 'agent-board', probe: NONCE })
})

test('answers its nonce; every other path, nonce and method is 404', async () => {
  const l = await opened()
  expect(l.port).toBeGreaterThan(0)
  const res = await fetch(l.url(`/api/probe/${NONCE}`))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ board: 'agent-board', probe: NONCE })

  const others = [
    `/api/probe/${'f'.repeat(32)}`,
    `/api/probe/${NONCE.toUpperCase()}`,
    `/api/probe/${NONCE}/x`,
    `/api/probe/%30${NONCE.slice(1)}`,
    '/api/probe/',
    '/',
    '/index.html',
    '/app.js',
    '/api/board',
    '/api/hello',
    '/api/access',
    '/api/events',
  ]
  for (const path of others) {
    const r = await fetch(l.url(path))
    expect([path, r.status]).toEqual([path, 404])
    expect(await r.json()).toEqual({ error: 'not found' })
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await fetch(l.url(`/api/probe/${NONCE}`), { method, headers: { 'x-board': '1' } })
    expect([method, r.status]).toEqual([method, 404])
  }
})

test('closed after closeAfterMs, or at once by close(); a second close is harmless', async () => {
  const timed = await opened({ closeAfterMs: 200 })
  expect((await fetch(timed.url(`/api/probe/${NONCE}`))).status).toBe(200)
  await Bun.sleep(300)
  expect(await refuses(timed.url(`/api/probe/${NONCE}`))).toBe(true)

  const l = await opened()
  l.close()
  l.close()
  expect(await refuses(l.url(`/api/probe/${NONCE}`))).toBe(true)
})
