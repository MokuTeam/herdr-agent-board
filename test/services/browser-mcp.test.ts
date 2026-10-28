// `board browser-mcp`'s relay between Claude and chrome-devtools-mcp (services/browser-mcp.ts):
// its own two tools added to the list, calls passed on while the agent has the browser, held
// while the owner has it and let go when it comes back, answered after the hold's limit, and its
// own tools through the board. And the session's pane, from herdr's variable.
import { expect, test } from 'bun:test'
import { createRelay, devtoolsMcp, OWN_TOOLS, OWNER_HAS_IT, paneOf } from '../../src/services/browser-mcp.ts'

type Msg = Record<string, unknown>

function relayWith(o: { control?: () => string | null; answers?: Record<string, Msg>; holdMs?: number } = {}) {
  const toChild: string[] = []
  const toClient: Msg[] = []
  const raw: string[] = []
  const asked: [string, Msg][] = []
  let clock = 0
  const relay = createRelay({
    board: async (op, body) => {
      asked.push([op, body])
      if (op === 'call') {
        const c = o.control ? o.control() : 'agent'
        return c === null ? null : { ok: true, control: c }
      }
      return o.answers?.[op] ?? { ok: true }
    },
    toChild: line => toChild.push(line),
    toClient: line => {
      raw.push(line)
      try {
        toClient.push(JSON.parse(line))
      } catch {}
    },
    holdMs: o.holdMs ?? 3_600_000,
    pollMs: 1000,
    sleep: async ms => {
      clock += ms
      await Bun.sleep(1)
    },
    now: () => clock,
  })
  return { relay, toChild, toClient, raw, asked }
}

const call = (id: number, name: string, args: Msg = {}): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

test('its two tools join chrome-devtools-mcp’s list; everything else goes through as it is', async () => {
  const { relay, toChild, toClient, raw } = relayWith()
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  relay.fromClient(init)
  relay.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 'L', method: 'tools/list' }))
  expect(toChild).toEqual([init, JSON.stringify({ jsonrpc: '2.0', id: 'L', method: 'tools/list' })])
  relay.fromChild(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'not-a-list-answer' }] } }))
  relay.fromChild(JSON.stringify({ jsonrpc: '2.0', id: 'L', result: { tools: [{ name: 'navigate_page' }] } }))
  relay.fromChild('not json')
  expect(raw.at(-1)).toBe('not json')
  expect(toClient.length).toBe(2)
  expect((toClient[0]?.result as { tools?: unknown[] } | undefined)?.tools).toHaveLength(1)
  const names = ((toClient[1]?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(t => t.name)
  expect(names).toEqual(['navigate_page', 'browser_profile', 'browser_ask_owner'])
  expect(OWN_TOOLS.every(t => t.inputSchema.type === 'object')).toBe(true)
})

test('a call goes on at once while the agent has the browser', async () => {
  const { relay, toChild } = relayWith({ control: () => 'agent' })
  relay.fromClient(call(5, 'take_screenshot'))
  await relay.idle()
  expect(toChild).toEqual([call(5, 'take_screenshot')])
})

test('the board does not answer who has it: held as for the owner, until it answers or the hold ends', async () => {
  let control: string | null = null
  const { relay, toChild, toClient } = relayWith({ control: () => control })
  relay.fromClient(call(5, 'take_screenshot'))
  await Bun.sleep(20)
  expect(toChild).toEqual([])
  expect(relay.held()).toBe(1)
  control = 'agent'
  await relay.idle()
  expect(toChild).toEqual([call(5, 'take_screenshot')])
  expect(toClient).toEqual([])
  const silent = relayWith({ control: () => null, holdMs: 3000 })
  silent.relay.fromClient(call(6, 'click'))
  await silent.relay.idle()
  expect(silent.toChild).toEqual([])
  expect(silent.toClient).toEqual([
    {
      jsonrpc: '2.0',
      id: 6,
      result: { content: [{ type: 'text', text: expect.stringContaining('board does not answer') }], isError: true },
    },
  ])
})

test('a JSON-RPC batch with a call in it is held as a whole; answered as a batch after the hold', async () => {
  let control = 'owner'
  const { relay, toChild, raw } = relayWith({ control: () => control, holdMs: 3_600_000 })
  const note = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const batch = JSON.stringify([JSON.parse(call(1, 'click')), note, JSON.parse(call(2, 'take_screenshot'))])
  relay.fromClient(batch)
  await Bun.sleep(20)
  expect(toChild).toEqual([])
  control = 'agent'
  await relay.idle()
  expect(toChild).toEqual([batch])
  // a batch without a call goes on at once
  const list = JSON.stringify([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }])
  relay.fromClient(list)
  expect(toChild.at(-1)).toBe(list)
  // held past its limit: each call in it answered, in one batch
  const late = relayWith({ control: () => 'owner', holdMs: 2000 })
  late.relay.fromClient(batch)
  await late.relay.idle()
  expect(late.toChild).toEqual([])
  const answered = JSON.parse(late.raw[0] as string) as { id: number; result: { isError: boolean } }[]
  expect(answered.map(a => [a.id, a.result.isError])).toEqual([
    [1, true],
    [2, true],
  ])
  expect(raw).toEqual([])
})

test('held while the owner has the browser; let go the moment it is back', async () => {
  let control = 'owner'
  const { relay, toChild, toClient } = relayWith({ control: () => control })
  relay.fromClient(call(7, 'navigate_page', { url: 'https://example.com' }))
  await Bun.sleep(20)
  expect(relay.held()).toBe(1)
  expect(toChild).toEqual([])
  // other messages are not held behind it
  relay.fromClient(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  expect(toChild).toHaveLength(1)
  control = 'agent'
  await relay.idle()
  expect(relay.held()).toBe(0)
  expect(toChild.at(-1)).toBe(call(7, 'navigate_page', { url: 'https://example.com' }))
  expect(toClient).toEqual([])
})

test('held past its limit: answered that the owner has the browser, never passed on', async () => {
  const { relay, toChild, toClient } = relayWith({ control: () => 'owner', holdMs: 3000 })
  relay.fromClient(call(8, 'click', { uid: '1' }))
  await relay.idle()
  expect(toChild).toEqual([])
  expect(toClient).toEqual([
    { jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: OWNER_HAS_IT }], isError: true } },
  ])
})

test('a held call Claude cancels is dropped', async () => {
  let control = 'owner'
  const { relay, toChild } = relayWith({ control: () => control })
  relay.fromClient(call(9, 'click'))
  await Bun.sleep(20)
  relay.fromClient(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }))
  control = 'agent'
  await relay.idle()
  expect(toChild).toEqual([])
})

test('its own tools: through the board, a profile only while the agent has the browser', async () => {
  const { relay, toChild, toClient, asked } = relayWith({
    answers: { profile: { ok: true, copy: true, profile: 'github' }, ask: { ok: true } },
  })
  relay.fromClient(call(1, 'browser_profile', { name: 'github' }))
  relay.fromClient(call(2, 'browser_ask_owner', { text: 'Sign in to GitHub' }))
  relay.fromClient(call(3, 'browser_ask_owner', {}))
  await relay.idle()
  expect(toChild).toEqual([])
  expect(asked.filter(([op]) => op !== 'call').sort()).toEqual([
    ['ask', { text: 'Sign in to GitHub' }],
    ['profile', { name: 'github' }],
  ])
  const text = (id: number) =>
    (toClient.find(m => m.id === id)?.result as { content: { text: string }[]; isError?: boolean }) ?? null
  expect(text(1)?.content[0]?.text).toContain('a copy of the profile "github"')
  expect(text(2)?.content[0]?.text).toContain('needs you')
  expect(text(3)?.isError).toBe(true)
  // the owner has it: a profile switch waits as any browser action does
  const held = relayWith({ control: () => 'owner', holdMs: 2000 })
  held.relay.fromClient(call(4, 'browser_profile', { name: 'x' }))
  await held.relay.idle()
  expect(held.asked.some(([op]) => op === 'profile')).toBe(false)
  expect((held.toClient[0]?.result as { isError?: boolean } | undefined)?.isError).toBe(true)
})

test('the session’s pane: HERDR_PANE_ID, else none outside herdr', () => {
  expect(paneOf({ HERDR_PANE_ID: 'w0:p3' }, 1)).toBe('w0:p3')
  expect(paneOf({}, 999_999_999)).toBeNull()
})

test('a call passed on starts the browser first; one that cannot start is answered with why, never passed on', async () => {
  const { relay, toChild, asked } = relayWith()
  relay.fromClient(call(1, 'navigate_page', { url: 'https://example.com' }))
  await relay.idle()
  expect(asked.map(([op]) => op)).toEqual(['call', 'start'])
  expect(toChild).toEqual([call(1, 'navigate_page', { url: 'https://example.com' })])
  const none = relayWith({ answers: { start: { ok: false, error: 'no Xvnc on this server' } } })
  none.relay.fromClient(call(2, 'take_screenshot'))
  await none.relay.idle()
  expect(none.toChild).toEqual([])
  expect(none.toClient).toEqual([
    {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: expect.stringContaining('no Xvnc on this server') }], isError: true },
    },
  ])
})

test('chrome-devtools-mcp to the board’s keyed DevTools route: the key in its config file, never on its command line', () => {
  const key = 'k'.repeat(43)
  const m = devtoolsMcp({
    origin: 'http://127.0.0.1:12422',
    pane: 'w0:p1 %',
    key,
    bin: '/m/cdm.js',
    config: '/r/c.json',
  })
  expect(m.config).toEqual({
    wsEndpoint: 'ws://127.0.0.1:12422/api/browser/cdp?pane=w0%3Ap1%20%25',
    wsHeaders: JSON.stringify({ 'x-board-key': key }),
  })
  expect(m.argv.slice(1, 4)).toEqual(['/m/cdm.js', '--config', '/r/c.json'])
  expect(m.argv).toContain('--no-page-id-routing')
  expect(m.argv.some(a => a.includes(key) || a.startsWith('--browserUrl') || a.startsWith('--wsHeaders'))).toBe(false)
  // no key (not on the server): none sent
  expect(devtoolsMcp({ origin: 'http://127.0.0.1:1', pane: 'p', key: null, bin: 'b', config: 'c' }).config).toEqual({
    wsEndpoint: 'ws://127.0.0.1:1/api/browser/cdp?pane=p',
  })
})
