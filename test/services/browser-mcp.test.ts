// `board browser-mcp`'s relay between Claude and chrome-devtools-mcp (services/browser-mcp.ts):
// its own two tools added to the list, calls passed on while the agent has the browser, held
// while the owner has it and let go when it comes back, answered after the hold's limit, and its
// own tools through the board. And the session's pane, from herdr's variable.
import { expect, test } from 'bun:test'
import {
  ASKED,
  CLOSED,
  createRelay,
  devtoolsMcp,
  OWN_TOOLS,
  OWNER_DOING_ASK,
  OWNER_HAS_IT,
  onlyLooks,
  paneOf,
} from '../../src/services/browser-mcp.ts'

type Msg = Record<string, unknown>

function relayWith(
  o: {
    control?: () => string | null
    asks?: () => boolean
    answers?: Record<string, Msg | null>
    holdMs?: number
  } = {},
) {
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
        return c === null ? null : { ok: true, control: c, asks: o.asks?.() ?? false }
      }
      // an answer of null: the board does not answer
      return o.answers && op in o.answers ? (o.answers[op] ?? null) : { ok: true }
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

test('its own tools join chrome-devtools-mcp’s list; everything else goes through as it is', async () => {
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
  expect(names).toEqual([
    'navigate_page',
    'read_page',
    'list_interactive',
    'browser_profile',
    'browser_ask_owner',
    'browser_close',
  ])
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

test('browser_close: through the board once the agent has the browser; told its sign-ins and tabs stay and the next call opens it again, which then goes on as any first call', async () => {
  const desc = OWN_TOOLS.find(t => t.name === 'browser_close')?.description ?? ''
  expect(desc).toContain('done with')
  expect(desc).toContain('next browser tool call')
  expect(desc).toContain('15 minutes')
  const { relay, toChild, toClient, asked } = relayWith({ answers: { close: { ok: true, closed: true } } })
  relay.fromClient(call(1, 'browser_close'))
  await relay.idle()
  expect(toChild).toEqual([])
  expect(asked.map(([op]) => op)).toEqual(['call', 'close'])
  const text = (m: Msg | undefined) =>
    (m?.result as { content: { type?: string; text: string }[]; isError?: boolean } | undefined) ?? null
  expect(text(toClient[0])?.isError).toBeUndefined()
  expect(text(toClient[0])?.content[0]?.text).toBe(CLOSED)
  expect(CLOSED).toContain('next browser tool call')
  // the next call: the browser started first, then passed on
  relay.fromClient(call(2, 'list_pages'))
  await relay.idle()
  expect(asked.map(([op]) => op)).toEqual(['call', 'close', 'call', 'start'])
  expect(toChild).toEqual([call(2, 'list_pages')])
  // nothing open: said so, not an error
  const none = relayWith({ answers: { close: { ok: true, closed: false } } })
  none.relay.fromClient(call(3, 'browser_close'))
  await none.relay.idle()
  expect(text(none.toClient[0])?.content[0]?.text).toContain('not open')
  expect(text(none.toClient[0])?.isError).toBeUndefined()
  // the board says no (its ask stands): its reason, as an error
  const no = relayWith({ answers: { close: { ok: false, error: 'your ask to the owner stands' } } })
  no.relay.fromClient(call(4, 'browser_close'))
  await no.relay.idle()
  expect(text(no.toClient[0])).toEqual({
    content: [{ type: 'text', text: 'your ask to the owner stands' }],
    isError: true,
  })
  // the owner has it for the agent's ask: at once, nothing closed
  const asks = relayWith({ control: () => 'owner', asks: () => true })
  asks.relay.fromClient(call(5, 'browser_close'))
  await asks.relay.idle()
  expect(asks.asked.map(([op]) => op)).toEqual(['call'])
  expect(text(asks.toClient[0])?.content[0]?.text).toBe(OWNER_DOING_ASK)
  // the board does not answer: not closed
  const silent = relayWith({ answers: { close: null } })
  silent.relay.fromClient(call(6, 'browser_close'))
  await silent.relay.idle()
  expect(text(silent.toClient[0])?.isError).toBe(true)
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

// ---------------------------------------------------------------- the owner has it for what the agent asked

/** Looks only: nothing in them moves the page under the owner's hands. */
const LOOKS: [string, Msg][] = [
  ['take_screenshot', {}],
  ['take_screenshot', { format: 'jpeg', quality: 50, filePath: '/tmp/x.jpg' }],
  ['take_snapshot', {}],
  ['list_pages', {}],
  ['list_console_messages', {}],
  ['get_console_message', { msgid: 1 }],
  ['list_network_requests', {}],
  ['get_network_request', { reqid: 2 }],
  ['get_css_styles', { uid: '1_2' }],
]
/** Act on the page, wait, or may do anything. */
const ACTS: [string, Msg][] = [
  ['click', { uid: '1_2' }],
  ['fill', { uid: '1_2', value: 'x' }],
  ['type_text', { text: 'x' }],
  ['press_key', { key: 'Enter' }],
  ['navigate_page', { url: 'https://example.com' }],
  ['drag', { from_uid: '1', to_uid: '2' }],
  ['upload_file', { uid: '1', filePath: '/tmp/a' }],
  ['new_page', { url: 'https://example.com' }],
  ['close_page', { pageId: 1 }],
  ['select_page', { pageId: 1, bringToFront: true }],
  ['evaluate_script', { function: '() => document.title' }],
  ['wait_for', { text: 'Signed in' }],
  ['take_screenshot', { uid: '1_2' }],
  ['take_screenshot', { fullPage: true }],
  ['handle_dialog', { action: 'accept' }],
  ['emulate', { networkConditions: 'Offline' }],
  ['a_tool_not_known_yet', {}],
]

test('what only looks and what acts: a screenshot of what shows, the snapshot, the pages, the console and the network look', () => {
  for (const [name, args] of LOOKS)
    expect([name, args, onlyLooks({ name, arguments: args })]).toEqual([name, args, true])
  for (const [name, args] of ACTS)
    expect([name, args, onlyLooks({ name, arguments: args })]).toEqual([name, args, false])
  expect(onlyLooks(null)).toBe(false)
  expect(onlyLooks({ name: 'take_snapshot' })).toBe(true)
})

test('the owner has it for what the agent asked: a call that acts is answered at once to end the turn, never held or passed on', async () => {
  const { relay, toChild, toClient, asked } = relayWith({ control: () => 'owner', asks: () => true })
  for (const [i, [name, args]] of ACTS.entries()) relay.fromClient(call(100 + i, name, args))
  await Bun.sleep(5)
  expect(relay.held()).toBe(0)
  await relay.idle()
  expect(toChild).toEqual([])
  expect(toClient).toEqual(
    ACTS.map((_, i) => ({
      jsonrpc: '2.0',
      id: 100 + i,
      result: { content: [{ type: 'text', text: OWNER_DOING_ASK }], isError: true },
    })),
  )
  expect(OWNER_DOING_ASK).toContain('End your turn')
  // one look at who has it each, no hold, nothing started
  expect(asked.map(([op]) => op)).toEqual(ACTS.map(() => 'call'))
  // a profile switch too
  relay.fromClient(call(200, 'browser_profile', { name: 'github' }))
  await relay.idle()
  expect(toClient.at(-1)).toEqual({
    jsonrpc: '2.0',
    id: 200,
    result: { content: [{ type: 'text', text: OWNER_DOING_ASK }], isError: true },
  })
  expect(asked.some(([op]) => op === 'profile')).toBe(false)
})

test('the owner has the browser, for an ask or not: a call that only looks goes on at once', async () => {
  for (const asks of [true, false]) {
    const { relay, toChild, toClient } = relayWith({ control: () => 'owner', asks: () => asks })
    const lines = LOOKS.map(([name, args], i) => call(300 + i, name, args))
    for (const line of lines) relay.fromClient(line)
    await relay.idle()
    expect([asks, toChild]).toEqual([asks, lines])
    expect(toClient).toEqual([])
  }
})

test('a batch while the owner has it for an ask: all looks go on; with a call that acts, answered at once as a batch', async () => {
  const { relay, toChild, raw } = relayWith({ control: () => 'owner', asks: () => true })
  const looks = JSON.stringify([JSON.parse(call(1, 'take_snapshot')), JSON.parse(call(2, 'list_pages'))])
  relay.fromClient(looks)
  await relay.idle()
  expect(toChild).toEqual([looks])
  relay.fromClient(JSON.stringify([JSON.parse(call(3, 'take_snapshot')), JSON.parse(call(4, 'click', { uid: '1' }))]))
  await relay.idle()
  expect(toChild).toEqual([looks])
  const answered = JSON.parse(raw.at(-1) as string) as { id: number; result: { content: { text: string }[] } }[]
  expect(answered.map(a => [a.id, a.result.content[0]?.text])).toEqual([
    [3, OWNER_DOING_ASK],
    [4, OWNER_DOING_ASK],
  ])
})

test('as before: the agent has it, everything goes on; the owner has it without an ask, a call that acts is held', async () => {
  const agent = relayWith({ control: () => 'agent', asks: () => true })
  for (const [i, [name, args]] of [...ACTS, ...LOOKS].entries()) agent.relay.fromClient(call(i, name, args))
  await agent.relay.idle()
  expect(agent.toChild).toHaveLength(ACTS.length + LOOKS.length)
  expect(agent.toClient).toEqual([])
  let control = 'owner'
  const owner = relayWith({ control: () => control, asks: () => false })
  owner.relay.fromClient(call(1, 'click', { uid: '1' }))
  await Bun.sleep(20)
  expect(owner.relay.held()).toBe(1)
  control = 'agent'
  await owner.relay.idle()
  expect(owner.toChild).toEqual([call(1, 'click', { uid: '1' })])
})

test('asking the owner: the agent is told to end its turn, not to poll or wait, and that the board wakes it', async () => {
  const ask = OWN_TOOLS.find(t => t.name === 'browser_ask_owner')?.description ?? ''
  expect(ask).toContain('end your turn: do not poll and do not call browser tools to wait')
  expect(ask).toContain('The board wakes you with a message when the owner hands your browser back')
  const { relay, toClient } = relayWith({ answers: { ask: { ok: true } } })
  relay.fromClient(call(1, 'browser_ask_owner', { text: 'Sign in to GitHub' }))
  await relay.idle()
  expect(toClient).toEqual([{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: ASKED }] } }])
  expect(ASKED).toContain('End your turn now')
})

// ---------------------------------------------------------------- read_page and list_interactive

/** The wrapper's own call to chrome-devtools-mcp among what went to it: its id, tool and arguments. */
const ownCall = (lines: string[], name: string) =>
  lines.map(l => JSON.parse(l) as Msg).find(m => (m.params as Msg | undefined)?.name === name) as
    | { id: string; method: string; params: { name: string; arguments: Msg } }
    | undefined

test('read_page: evaluate_script by a call of the wrapper’s own, its answer to Claude as compact text; the call’s own answer never reaches Claude', async () => {
  // the owner has the browser for the agent's ask: reading only looks, so it goes on
  const { relay, toChild, toClient, asked } = relayWith({ control: () => 'owner', asks: () => true })
  relay.fromClient(call(1, 'read_page', { maxChars: 1000 }))
  for (let i = 0; i < 50 && !toChild.length; i++) await Bun.sleep(1)
  expect(asked.map(([op]) => op)).toEqual(['call', 'start'])
  const sent = ownCall(toChild, 'evaluate_script')
  expect(sent?.method).toBe('tools/call')
  expect(sent?.id).toStartWith('board-read-')
  expect(sent?.params.arguments.waitForStableDom).toBe(false)
  expect(String(sent?.params.arguments.function)).toContain('"selector":null')
  const page = { title: 'Karakol', url: 'https://x.org/k', root: 'main', text: 'Karakol is a city.', dropped: 0 }
  const text = `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(page)}\n\`\`\``
  relay.fromChild(JSON.stringify({ jsonrpc: '2.0', id: sent?.id, result: { content: [{ type: 'text', text }] } }))
  await relay.idle()
  expect(toClient).toHaveLength(1)
  expect(toClient[0]?.id).toBe(1)
  const out = toClient[0]?.result as { content: { text: string }[]; isError?: boolean }
  expect(out.isError).toBeUndefined()
  expect(out.content[0]?.text).toContain('Karakol | https://x.org/k')
  expect(out.content[0]?.text).toEndWith('\n\nKarakol is a city.')
  // an answer of chrome-devtools-mcp's to Claude's own call still goes through as it is
  relay.fromChild(JSON.stringify({ jsonrpc: '2.0', id: 'board-read-1', result: {} }))
  expect(toClient).toHaveLength(2)
})

test('list_interactive: take_snapshot by a call of the wrapper’s own, its uids as they are; a failure or a browser that cannot start answered as such', async () => {
  const { relay, toChild, toClient } = relayWith()
  relay.fromClient(call(2, 'list_interactive', { links: false }))
  for (let i = 0; i < 50 && !toChild.length; i++) await Bun.sleep(1)
  const sent = ownCall(toChild, 'take_snapshot')
  expect(sent?.params.arguments).toEqual({})
  const snapshot = [
    '## Latest page snapshot',
    'uid=3_0 RootWebArea "Form" url="https://x.org/f"',
    '  uid=3_7 textbox "Email"',
    '  uid=3_8 link "Home" url="https://x.org/"',
    '  uid=3_9 button "Send"',
  ].join('\n')
  relay.fromChild(
    JSON.stringify({ jsonrpc: '2.0', id: sent?.id, result: { content: [{ type: 'text', text: snapshot }] } }),
  )
  await relay.idle()
  const text = (toClient[0]?.result as { content: { text: string }[] } | undefined)?.content[0]?.text ?? ''
  expect(text).toContain('3_7 textbox "Email"\n3_9 button "Send"')
  expect(text).not.toContain('Home')
  // chrome-devtools-mcp fails it (a dialog open): its words, as an error
  relay.fromClient(call(3, 'list_interactive'))
  for (let i = 0; i < 50 && toChild.length < 2; i++) await Bun.sleep(1)
  const again = JSON.parse(toChild[1] as string) as { id: string }
  relay.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: again.id,
      result: { content: [{ type: 'text', text: 'A dialog is open' }], isError: true },
    }),
  )
  relay.fromClient(call(4, 'read_page'))
  for (let i = 0; i < 50 && toChild.length < 3; i++) await Bun.sleep(1)
  const third = JSON.parse(toChild[2] as string) as { id: string }
  relay.fromChild(JSON.stringify({ jsonrpc: '2.0', id: third.id, error: { code: -32602, message: 'bad params' } }))
  await relay.idle()
  expect(toClient.slice(1)).toEqual([
    { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'A dialog is open' }], isError: true } },
    { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'bad params' }], isError: true } },
  ])
  const none = relayWith({ answers: { start: { ok: false, error: 'no Xvnc on this server' } } })
  none.relay.fromClient(call(5, 'read_page'))
  await none.relay.idle()
  expect(none.toChild).toEqual([])
  expect((none.toClient[0]?.result as { content: { text: string }[] } | undefined)?.content[0]?.text).toContain(
    'no Xvnc',
  )
})

test('the list: take_snapshot’s description points to read_page and list_interactive; the compact tools only look, so asking the owner says they work meanwhile', async () => {
  const { relay, toClient } = relayWith()
  relay.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 'L', method: 'tools/list' }))
  relay.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'L',
      result: { tools: [{ name: 'take_snapshot', description: 'Take a text snapshot.' }, { name: 'click' }] },
    }),
  )
  const tools = (toClient[0]?.result as { tools: { name: string; description?: string }[] } | undefined)?.tools ?? []
  expect(tools[0]?.description).toContain('list_interactive')
  expect(tools[1]).toEqual({ name: 'click' })
  for (const t of OWN_TOOLS.filter(t => t.name === 'browser_ask_owner')) expect(t.description).toContain('read_page')
  expect(ASKED).toContain('read_page, list_interactive')
  expect(OWNER_DOING_ASK).toContain('read_page, list_interactive')
})
