// The board's HTTP MCP on a running board (#813): a client initializes, lists the tools and calls
// them at /mcp; each call is the board command run as its caller.
// - Two sessions through the same endpoint at once: each card gets its own text (the caller is read
//   per call from X-Board-Pane or X-Board-Session, never fixed when the server starts).
// - A new conversation in the same pane (#630): the next call is the new session's.
// - No caller: the owner, as the command outside a session; the command's own line comes back as
//   a tool error.
// - What is not this computer's own client is refused: another site's page, a GET, a body that
//   does not say it is JSON.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { boardConfig, rpc, tool } from '../support/mcp-client.ts'
import { type FakePane, showPanes } from '../support/node-pair.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

const claude = (box: Sandbox, pane: string, session: string): FakePane => ({
  pane_id: pane,
  agent: 'claude',
  agent_session: { value: session },
  agent_status: 'idle',
  cwd: box.dir,
})

const doingOf = (box: Sandbox, key: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(box.cards, `${key}.json`), 'utf8')).doing
  } catch {
    return undefined
  }
}

test('initialize, the tools, and two sessions through one endpoint, each as itself', async () => {
  const box = await sandbox()
  showPanes(box, [claude(box, 'p1', 'anna-1'), claude(box, 'p2', 'ben-1')])
  const { url } = await serveBoard(box, { language: 'en' })
  boardConfig(box, url)

  const init = await rpc(url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't' },
  })
  expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'agent-board' } })
  const note = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  expect([note.status, await note.text()]).toEqual([202, ''])
  const list = await rpc(url, 'tools/list', {})
  expect((list.result.tools as { name: string }[]).map(t => t.name)).toEqual([
    'card',
    'schedule',
    'agents',
    'threads',
    'thread',
    'spawn',
    'cal',
  ])

  // At once, one by its pane, one by its session key.
  const [a, b] = await Promise.all([
    tool(url, 'card', { op: 'doing', text: 'mapping the atlas' }, { 'x-board-pane': 'p1' }),
    tool(url, 'card', { op: 'doing', text: 'ben ☃ 100% done-ish' }, { 'x-board-session': 'ben-1' }),
  ])
  expect(a).toMatchObject({ error: false })
  expect(a.text).toStartWith('ok · ')
  expect(b).toMatchObject({ error: false })
  expect(doingOf(box, 'anna-1')).toBe('mapping the atlas')
  expect(doingOf(box, 'ben-1')).toBe('ben ☃ 100% done-ish')

  // #630: a new conversation in pane p1; the same client, the same header, the new session.
  showPanes(box, [claude(box, 'p1', 'anna-2'), claude(box, 'p2', 'ben-1')])
  expect((await tool(url, 'card', { op: 'doing', text: 'after /clear' }, { 'x-board-pane': 'p1' })).error).toBe(false)
  expect(doingOf(box, 'anna-2')).toBe('after /clear')
  expect(doingOf(box, 'anna-1')).toBe('mapping the atlas')

  // No caller: the owner, so a card op has nobody's card; the command's line as the error.
  const owner = await tool(url, 'card', { op: 'doing', text: 'x' })
  expect(owner).toEqual({
    error: true,
    text: 'board: cannot tell which session this is: run it from a Claude session, or pass --session',
  })
  // A schedule entry for the caller, listed for it and for nobody else.
  const remind = await tool(
    url,
    'schedule',
    { op: 'remind', when: 'in 2h', text: 'check CI' },
    { 'x-board-pane': 'p2' },
  )
  expect(remind.error).toBe(false)
  expect(remind.text).toMatch(/reminder [0-9a-f]{6}/)
  expect((await tool(url, 'schedule', { op: 'list' }, { 'x-board-pane': 'p2' })).text).toMatch(/check CI/)
  expect((await tool(url, 'schedule', { op: 'list' }, { 'x-board-pane': 'p1' })).text).toBe(
    'nothing scheduled for this session',
  )
}, 60_000)

test("refused: another site's page, a GET, a body that is not JSON, a header that is no pane", async () => {
  const box = await sandbox()
  showPanes(box, [])
  const { url } = await serveBoard(box, { language: 'en' })
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const post = (headers: Record<string, string>) => fetch(`${url}/mcp`, { method: 'POST', headers, body })
  expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403)
  expect((await post({ 'content-type': 'text/plain' })).status).toBe(415)
  expect((await post({ 'content-type': 'application/json', 'x-board-pane': '--session' })).status).toBe(400)
  const get = await fetch(`${url}/mcp`)
  expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
  // The board's own page may.
  expect((await post({ 'content-type': 'application/json', origin: url })).status).toBe(200)
}, 30_000)
