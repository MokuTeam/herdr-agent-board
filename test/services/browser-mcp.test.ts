// `board browser-mcp`'s relay between Claude and chrome-devtools-mcp (services/browser-mcp.ts):
// its own two tools added to the list, calls passed on while the agent has the browser, held
// while the owner has it and let go when it comes back, answered after the hold's limit, and its
// own tools through the board. And the session's pane, from herdr's variable.
import { expect, test } from 'bun:test'
import { createRelay, OWN_TOOLS, OWNER_HAS_IT, paneOf } from '../../src/services/browser-mcp.ts'

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

test('a call goes on at once while the agent has the browser, or when the board does not answer', async () => {
  for (const control of [() => 'agent', () => null]) {
    const { relay, toChild } = relayWith({ control })
    relay.fromClient(call(5, 'take_screenshot'))
    await relay.idle()
    expect(toChild).toEqual([call(5, 'take_screenshot')])
  }
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
    answers: { profile: { ok: true, port: 9300, copy: true, profile: 'github' }, ask: { ok: true, port: 9300 } },
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
