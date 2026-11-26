// /mcp's own guards (#813, server/routes/mcp.ts), as the route table dispatches it: the network side
// never reaches it (a remote listener and a relayed request are marked remote, a peer that is not
// loopback is refused) and the caller headers are read on every request, never kept.
import { describe, expect, test } from 'bun:test'
import type { Caller, HttpMcp } from '../../src/entrypoints/mcp-http.ts'
import { dispatch, type GuardState } from '../../src/server/http.ts'
import { callerOf, mcpRoutes } from '../../src/server/routes/mcp.ts'

const state: GuardState = { port: 12422, token: 't', stale: () => false }

function routes() {
  const seen: (Caller | null)[] = []
  const mcp: HttpMcp = {
    async handle(text, caller) {
      seen.push(caller)
      const id = (JSON.parse(text) as { id?: unknown }).id
      return id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id, result: {} })
    },
  }
  const find = (ref: { pane?: string; session?: string }) =>
    ref.session === 'anna-1' || ref.pane === 'p1'
      ? { pane: 'p1', cwd: '/work/anna', configDir: '/home/anna/.claude-work' }
      : null
  return { table: mcpRoutes({ mcp, find }), seen }
}

const req = (headers: Record<string, string> = {}, body = '{"jsonrpc":"2.0","id":1,"method":"ping"}') =>
  new Request('http://127.0.0.1:12422/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

const send = (table: ReturnType<typeof routes>['table'], r: Request, s: GuardState = state, peer = '127.0.0.1') =>
  dispatch(table, r, new URL(r.url), '/mcp', s, () => peer)

describe('/mcp', () => {
  test('through a remote listener or a relay, and from a peer that is not loopback: not found, nothing run', async () => {
    const { table, seen } = routes()
    expect((await send(table, req(), { ...state, remote: true })).status).toBe(404)
    expect((await send(table, req(), state, '192.168.1.20')).status).toBe(404)
    expect((await send(table, req(), state, '100.64.0.7')).status).toBe(404)
    const service = req({ 'x-board-owner-service': 'invalid' })
    expect((await send(table, service, { ...state, remote: true })).status).toBe(404)
    expect((await send(table, service, state, '100.64.0.7')).status).toBe(404)
    expect(seen).toEqual([])
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect((await send(table, req(), state, peer)).status).toBe(200)
  })

  test('the caller per request: a pane, a key the board knows, none', async () => {
    const { table, seen } = routes()
    await send(table, req({ 'x-board-pane': 'p1' }))
    await send(table, req({ 'x-board-session': 'anna-1' }))
    await send(table, req({ 'x-board-session': 'pane-w2:p9' }))
    await send(table, req())
    expect(seen).toEqual([
      { pane: 'p1', cwd: '/work/anna', configDir: '/home/anna/.claude-work' },
      { pane: 'p1', session: 'anna-1', cwd: '/work/anna', configDir: '/home/anna/.claude-work' },
      { session: 'pane-w2:p9' },
      null,
    ])
  })

  test('a notification: 202 and no body; a message too large: 413', async () => {
    const { table } = routes()
    const note = await send(table, req({}, '{"jsonrpc":"2.0","method":"notifications/initialized"}'))
    expect([note.status, await note.text()]).toEqual([202, ''])
    expect((await send(table, req({}, `"${'x'.repeat(1 << 20)}"`))).status).toBe(413)
  })

  test('caller headers that cannot be a pane or a key', () => {
    const find = () => null
    const of = (h: Record<string, string>) => callerOf(new Request('http://127.0.0.1/mcp', { headers: h }), find)
    expect(of({ 'x-board-pane': 'w5:p2P' })).toEqual({ pane: 'w5:p2P' })
    expect(of({ 'x-board-pane': '-x' })).toBe('X-Board-Pane is not a herdr pane id')
    expect(of({ 'x-board-pane': 'a b' })).toBe('X-Board-Pane is not a herdr pane id')
    expect(of({ 'x-board-session': '--session' })).toBe('X-Board-Session is not a session key')
    expect(of({ 'x-board-session': 'C:/Users/anna/.pi/sessions/one file.jsonl' })).toEqual({
      session: 'C:/Users/anna/.pi/sessions/one file.jsonl',
    })
    expect(of({})).toBeNull()
  })
})
