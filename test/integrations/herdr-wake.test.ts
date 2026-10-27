import { describe, expect, test } from 'bun:test'
import type { Item } from '../../src/core/types.ts'
import { createHerdrWake } from '../../src/integrations/herdr-wake.ts'

const item = { name: 'Test', pane: 'pane1', session: 's1' } as Item

interface Call {
  url: string
  init?: RequestInit | undefined
}

function fakeFetch(reply: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return reply()
  }) as typeof fetch
  return { fetch: fn, calls }
}

const downFetch = (message: string): typeof fetch =>
  (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('sleepers', () => {
  test('no url: [] and no request', async () => {
    const f = fakeFetch(() => json([]))
    expect(await createHerdrWake(null, f.fetch).sleepers()).toEqual([])
    expect(f.calls).toHaveLength(0)
  })

  test('two calls within 5 s read once; forget() reads again; 5 s later reads again', async () => {
    const f = fakeFetch(() => json([{ session: 'a' }]))
    let clock = 100_000
    const w = createHerdrWake('http://x', f.fetch, () => clock)
    expect(await w.sleepers()).toEqual([{ session: 'a' }])
    clock += 4999
    await w.sleepers()
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.url).toBe('http://x/sleeping')
    w.forget()
    await w.sleepers()
    expect(f.calls).toHaveLength(2)
    clock += 5000
    await w.sleepers()
    expect(f.calls).toHaveLength(3)
  })

  test('a failing fetch or a non-array answer gives []', async () => {
    const bad = createHerdrWake('http://x', downFetch('down'))
    expect(await bad.sleepers()).toEqual([])
    const notList = createHerdrWake('http://x', fakeFetch(() => json({ nope: 1 })).fetch)
    expect(await notList.sleepers()).toEqual([])
    const notOk = createHerdrWake('http://x', fakeFetch(() => new Response('[{"session":"a"}]', { status: 500 })).fetch)
    expect(await notOk.sleepers()).toEqual([])
  })
})

describe('wake and sleep', () => {
  test('wake posts the pane as target to /wake', async () => {
    const f = fakeFetch(() => json({ ok: true }))
    expect(await createHerdrWake('http://x', f.fetch).wake(item)).toEqual({ ok: true })
    expect(f.calls[0]?.url).toBe('http://x/wake')
    expect(f.calls[0]?.init?.method).toBe('POST')
    expect(f.calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(f.calls[0]?.init?.body).toBe('{"target":"pane1"}')
  })

  test('#204: a sleeper without a pane goes by its session id, and the answer says the pane it woke in', async () => {
    const f = fakeFetch(() => json({ ok: true, pane: 'w1:p9', name: 'Test' }))
    expect(await createHerdrWake('http://x', f.fetch).wake({ ...item, pane: null })).toEqual({
      ok: true,
      pane: 'w1:p9',
    })
    expect(f.calls[0]?.init?.body).toBe('{"target":"s1"}')
    // In its own pane, as before: the answer's pane is that one, nothing more said.
    const same = fakeFetch(() => json({ ok: true, pane: 'pane1', name: 'Test' }))
    expect(await createHerdrWake('http://x', same.fetch).wake(item)).toEqual({ ok: true })
    expect(same.calls[0]?.init?.body).toBe('{"target":"pane1"}')
  })

  test('wake: refusal and unreachable router give a message', async () => {
    const refused = await createHerdrWake('http://x', fakeFetch(() => json({ ok: false, error: 'boom' })).fetch).wake(
      item,
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error).toContain('boom')
    const down = await createHerdrWake('http://x', downFetch('ECONNREFUSED')).wake(item)
    expect(down.ok === false && down.error).toContain('ECONNREFUSED')
  })

  test('sleep posts to /sleep and maps the router refusals', async () => {
    const f = fakeFetch(() => json({ ok: true }))
    expect(await createHerdrWake('http://x', f.fetch).sleep(item)).toEqual({ ok: true })
    expect(f.calls[0]?.url).toBe('http://x/sleep')
    expect(f.calls[0]?.init?.body).toBe('{"target":"pane1"}')
    const busy = await createHerdrWake(
      'http://x',
      fakeFetch(() => json({ ok: false, error: 'session is not idle' })).fetch,
    ).sleep(item)
    const plain = await createHerdrWake('http://x', fakeFetch(() => json({ ok: false, error: 'other' })).fetch).sleep(
      item,
    )
    expect(busy.ok === false && busy.error).not.toBe(plain.ok === false && plain.error)
    expect(plain.ok === false && plain.error).toContain('other')
  })
})
