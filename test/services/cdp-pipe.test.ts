// A desktop's Chrome on its DevTools pipe, one client at a time (services/cdp-pipe.ts): ready once
// Chrome answers; each client's ids its own on the way back; events to the client connected; a new
// client in place of the one before, which hears nothing more; and what a client set on the browser
// undone when it goes, so a page opened later never waits for a debugger no one is. And the pipe's
// framing: JSON messages each ended by a NUL byte, cut anywhere on the way.
import { expect, test } from 'bun:test'
import { createCdpMux, nulFrames } from '../../src/services/cdp-pipe.ts'

type Msg = Record<string, unknown>

function chrome() {
  const got: Msg[] = []
  const mux = createCdpMux(text => got.push(JSON.parse(text)))
  /** Chrome answers the last message it got that has `method`, with `result`. */
  const answer = (method: string, result: Msg = {}) => {
    const m = [...got].reverse().find(g => g.method === method)
    if (!m) throw new Error(`no ${method}`)
    mux.fromChrome(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }))
  }
  return { mux, got, answer }
}

function client(c: ReturnType<typeof chrome>) {
  const heard: Msg[] = []
  let kicked = false
  const conn = c.mux.connect(
    text => heard.push(JSON.parse(text)),
    () => {
      kicked = true
    },
  )
  return { conn, heard, kicked: () => kicked }
}

test('ready once Chrome answers on its pipe', async () => {
  const c = chrome()
  expect(c.got.map(g => g.method)).toEqual(['Browser.getVersion'])
  let ready = ''
  void c.mux.ready.then(v => {
    ready = v
  })
  await Bun.sleep(1)
  expect(ready).toBe('')
  c.answer('Browser.getVersion', { product: 'Chrome/140' })
  await Bun.sleep(1)
  expect(ready).toBe('Chrome/140')
})

test('a client’s ids are its own both ways; events go to it; what is not a command is dropped', () => {
  const c = chrome()
  const a = client(c)
  a.conn.send(JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} }))
  a.conn.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' }))
  a.conn.send('not json')
  a.conn.send(JSON.stringify({ method: 'no id' }))
  a.conn.send(JSON.stringify([{ id: 3, method: 'Target.getTargets' }]))
  const sent = c.got.slice(1)
  expect(sent.map(g => [g.method, g.sessionId ?? null])).toEqual([
    ['Target.getTargets', null],
    ['Runtime.evaluate', 'S1'],
  ])
  // the pipe's ids are the holder's, not the client's
  expect(new Set([c.got[0]?.id, sent[0]?.id, sent[1]?.id]).size).toBe(3)
  c.answer('Runtime.evaluate', { result: { value: 1 } })
  c.answer('Target.getTargets', { targetInfos: [] })
  c.mux.fromChrome(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: {} } }))
  expect(a.heard).toEqual([
    { id: 2, result: { result: { value: 1 } }, sessionId: 'S1' },
    { id: 1, result: { targetInfos: [] } },
    { method: 'Target.targetCreated', params: { targetInfo: {} } },
  ])
})

test('a new client takes the place of the one before: that one is let go and hears nothing more', () => {
  const c = chrome()
  const a = client(c)
  a.conn.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }))
  const b = client(c)
  expect(a.kicked()).toBe(true)
  // the answer to a's call, late: not b's (b's id 1 is another call)
  b.conn.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }))
  c.answer('Page.navigate', { frameId: 'F' })
  c.mux.fromChrome(JSON.stringify({ method: 'Target.targetCreated', params: {} }))
  a.conn.send(JSON.stringify({ id: 5, method: 'Browser.close' }))
  expect(c.got.some(g => g.method === 'Browser.close')).toBe(false)
  expect(a.heard).toEqual([])
  expect(b.heard).toEqual([{ method: 'Target.targetCreated', params: {} }])
  c.answer('Target.getTargets', {})
  expect(b.heard.at(-1)).toEqual({ id: 1, result: {} })
})

test('a client gone: auto-attach and discovery off, its pages let run and its sessions detached', () => {
  const c = chrome()
  const a = client(c)
  a.conn.send(
    JSON.stringify({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    }),
  )
  c.mux.fromChrome(
    JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', waitingForDebugger: true } }),
  )
  a.conn.send(JSON.stringify({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } }))
  c.answer('Target.attachToTarget', { sessionId: 'S2' })
  c.mux.fromChrome(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S3' } }))
  c.mux.fromChrome(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S3' } }))
  const before = c.got.length
  a.conn.close()
  const after = c.got.slice(before).map(g => [g.method, g.sessionId ?? (g.params as Msg)?.sessionId ?? null])
  expect(after).toEqual([
    ['Target.setAutoAttach', null],
    ['Target.setDiscoverTargets', null],
    ['Runtime.runIfWaitingForDebugger', 'S1'],
    ['Target.detachFromTarget', 'S1'],
    ['Runtime.runIfWaitingForDebugger', 'S2'],
    ['Target.detachFromTarget', 'S2'],
  ])
  expect(c.got.slice(before)[0]?.params).toEqual({ autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
  // their answers go to no one; a second close does nothing
  for (const g of c.got.slice(before)) c.mux.fromChrome(JSON.stringify({ id: g.id, result: {} }))
  expect(a.heard).toHaveLength(4)
  a.conn.close()
  expect(c.got).toHaveLength(before + 6)
})

test('the pipe’s framing: a NUL after each message, cut anywhere, text in any alphabet', () => {
  const frames = nulFrames()
  const all = new TextEncoder().encode('{"a":"Привет 👋"}\0{"b":1}\0{"c"')
  const out: string[] = []
  for (let i = 0; i < all.length; i += 3) out.push(...frames(all.subarray(i, i + 3)))
  expect(out).toEqual(['{"a":"Привет 👋"}', '{"b":1}'])
  expect(frames(new TextEncoder().encode(':2}\0'))).toEqual(['{"c":2}'])
})
