import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHttpRelay, httpRelayHeaders } from '../../src/entrypoints/mcp-relay.ts'
import { serveBoard } from '../support/board-server.ts'
import { boardConfig } from '../support/mcp-client.ts'
import { showPanes } from '../support/node-pair.ts'
import { root, sandbox } from '../support/sandbox.ts'

// A fake board /mcp (#813's contract): JSON answers, 202 for a notification, what it was sent kept.
type Seen = { headers: Record<string, string>; body: string }
const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})
// biome-ignore lint/suspicious/noExplicitAny: the JSON-RPC message as sent
function fakeBoard(answer?: (msg: any, req: Request) => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text()
      seen.push({ headers: Object.fromEntries(req.headers), body })
      if (new URL(req.url).pathname !== '/mcp' || req.method !== 'POST') return new Response(null, { status: 405 })
      const msg = JSON.parse(body)
      if (answer) return answer(msg, req)
      if (!('id' in msg)) return new Response(null, { status: 202 })
      return new Response(
        `{\n  "jsonrpc": "2.0", "id": ${JSON.stringify(msg.id)},\n  "result": { "echo": ${JSON.stringify(msg.method)} }\n}`,
        {
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}/mcp`, port: server.port, seen }
}

describe('httpRelayHeaders', () => {
  test('the session --session names, else the herdr pane, else nothing (the owner)', () => {
    expect(httpRelayHeaders({ HERDR_PANE_ID: 'w5:p2R' })).toEqual({ 'X-Board-Pane': 'w5:p2R' })
    expect(httpRelayHeaders({ HERDR_PANE_ID: 'w5:p2R' }, 'pane-7')).toEqual({ 'X-Board-Session': 'pane-7' })
    expect(httpRelayHeaders({})).toEqual({})
    expect(httpRelayHeaders({ HERDR_PANE_ID: '' })).toEqual({})
  })
})

describe('createHttpRelay', () => {
  test('a request goes as it is with the caller header; the answer comes back on one line', async () => {
    const board = fakeBoard()
    const relay = createHttpRelay({ url: board.url, headers: { 'X-Board-Pane': 'w1:p9' } })
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":"дом 100%"}}'
    expect(await relay.handle(line)).toBe('{"jsonrpc":"2.0","id":1,"result":{"echo":"tools/list"}}')
    expect(board.seen[0]?.body).toBe(line)
    expect(board.seen[0]?.headers['x-board-pane']).toBe('w1:p9')
    expect(board.seen[0]?.headers['content-type']).toBe('application/json')
    expect(board.seen[0]?.headers.accept).toContain('text/event-stream')
    expect(board.seen[0]?.headers.origin).toBeUndefined()
  })

  test('a notification answered 202 gives nothing back; blank lines are not sent', async () => {
    const board = fakeBoard()
    const relay = createHttpRelay({ url: board.url, headers: {} })
    expect(await relay.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull()
    expect(await relay.handle('   ')).toBeNull()
    expect(board.seen).toHaveLength(1)
  })

  test('an event-stream answer: each event a line', async () => {
    const board = fakeBoard(
      msg =>
        new Response(`event: message\ndata: {"jsonrpc":"2.0","id":${msg.id},\ndata: "result":{}}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const relay = createHttpRelay({ url: board.url, headers: {} })
    expect(await relay.handle('{"jsonrpc":"2.0","id":7,"method":"ping"}')).toBe('{"jsonrpc":"2.0","id":7,"result":{}}')
  })

  test("the board's own JSON-RPC refusal goes back as it is; another error is worded with the request's id", async () => {
    const refusing = fakeBoard(msg =>
      Response.json(
        { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'foreign origin' } },
        { status: 403 },
      ),
    )
    const r1 = createHttpRelay({ url: refusing.url, headers: {} })
    expect(JSON.parse((await r1.handle('{"jsonrpc":"2.0","id":"a","method":"x"}')) as string)).toEqual({
      jsonrpc: '2.0',
      id: 'a',
      error: { code: -32600, message: 'foreign origin' },
    })
    const broken = fakeBoard(() => new Response('<html>no</html>', { status: 500 }))
    const r2 = createHttpRelay({ url: broken.url, headers: {} })
    const answer = JSON.parse((await r2.handle('{"jsonrpc":"2.0","id":3,"method":"x"}')) as string)
    expect(answer.id).toBe(3)
    expect(answer.error.message).toContain('answered 500')
  })

  test('no board on the port: an error for a request, nothing for a notification; a line that is not JSON', async () => {
    const board = fakeBoard()
    const url = board.url
    for (const s of servers.splice(0)) s.stop(true)
    const relay = createHttpRelay({ url, headers: {} })
    const answer = JSON.parse((await relay.handle('{"jsonrpc":"2.0","id":9,"method":"initialize"}')) as string)
    expect(answer).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32000 } })
    expect(answer.error.message).toContain('the board does not answer at')
    expect(await relay.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull()
    expect(JSON.parse((await relay.handle('{nope')) as string).error.code).toBe(-32700)
  })
})

test('board mcp --http: stdin lines relayed to the port config.json names, as the pane it runs in', async () => {
  const box = await sandbox()
  const board = fakeBoard()
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', wakeUrl: '', wake: false, port: board.port }),
  )
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '',
  ].join('\n')
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'mcp', '--http'], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'w3:p4', CLAUDE_CODE_SESSION_ID: '' },
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(0)
  expect(
    stdout
      .trim()
      .split('\n')
      .map(l => JSON.parse(l).id),
  ).toEqual([1, 2])
  expect(board.seen.map(s => s.headers['x-board-pane'])).toEqual(['w3:p4', 'w3:p4', 'w3:p4'])
})

test('board mcp --http against a running board (#813): the tools, and a card call as the pane it runs in', async () => {
  const box = await sandbox()
  showPanes(box, [
    { pane_id: 'p7', agent: 'claude', agent_session: { value: 'cleo-1' }, agent_status: 'idle', cwd: box.dir },
  ])
  const { url } = await serveBoard(box, { language: 'en' })
  boardConfig(box, url)
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"card","arguments":{"op":"doing","text":"relay check"}}}',
    '',
  ].join('\n')
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'mcp', '--http'], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'p7', CLAUDE_CODE_SESSION_ID: '' },
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(0)
  const answers = stdout
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(answers.map(a => a.id)).toEqual([1, 2, 3])
  expect(answers[0].result.serverInfo.name).toBe('agent-board')
  expect(answers[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
    'card',
    'schedule',
    'agents',
    'threads',
    'thread',
    'spawn',
    'cal',
  ])
  expect(answers[2].result.isError).toBeUndefined()
  expect(JSON.parse(readFileSync(join(box.cards, 'cleo-1.json'), 'utf8')).doing).toBe('relay check')
}, 30_000)
