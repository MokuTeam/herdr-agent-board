// board archive on a node (#798): another machine's session named by its id or name, found among
// the master's `board agents --json` views and named in the node's terms for the relay.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { foreignMatch, foreignTargets } from '../../src/entrypoints/node-remote-cli.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const views = [
  // The master's own session: no device in its own terms.
  { key: 'b1c2d3e4-0000-4000-8000-000000000001', name: 'atlas', names: ['atlas'], device: null },
  // server-2's session, by its prefixed key.
  {
    key: `@server-2:${SID}`,
    name: 'agent-board-android-c5',
    names: ['agent-board-android-c5', 'cleo'],
    device: 'server-2',
  },
  // This node's own session (laptop): looked for on the node first, never matched here.
  { key: '@laptop:c0ffee00-0000-4000-8000-000000000002', name: 'ben', names: ['ben'], device: 'laptop' },
]

test("another machine's session by its bare id, its prefixed key or its name, in the node's terms", () => {
  expect(foreignMatch(views, SID, 'laptop', 'server-1')).toEqual({ key: `@server-2:${SID}` })
  expect(foreignMatch(views, SID.toUpperCase(), 'laptop', 'server-1')).toEqual({ key: `@server-2:${SID}` })
  expect(foreignMatch(views, `@server-2:${SID}`, 'laptop', 'server-1')).toEqual({ key: `@server-2:${SID}` })
  expect(foreignMatch(views, 'Agent-Board-Android-C5', 'laptop', 'server-1')).toEqual({ key: `@server-2:${SID}` })
  expect(foreignMatch(views, 'cleo', 'laptop', 'server-1')).toEqual({ key: `@server-2:${SID}` })
})

test("the master's own session goes by the master's id; without it known, a plain error", () => {
  expect(foreignMatch(views, 'atlas', 'laptop', 'server-1')).toEqual({
    key: '@server-1:b1c2d3e4-0000-4000-8000-000000000001',
  })
  expect(foreignMatch(views, 'atlas', 'laptop', '')).toEqual({ error: expect.stringContaining('does not know') })
})

test("this node's own sessions and names nobody has are no match", () => {
  expect(foreignMatch(views, 'ben', 'laptop', 'server-1')).toBeNull()
  expect(foreignMatch(views, 'nobody', 'laptop', 'server-1')).toBeNull()
  expect(foreignMatch('not a list', SID, 'laptop', 'server-1')).toBeNull()
  expect(foreignMatch([{ name: 'x' }, null, 3], 'x', 'laptop', 'server-1')).toBeNull()
})

test('a name two sessions answer to is refused, naming both', () => {
  const two = [...views, { key: '@server-3:dd', name: 'cleo', names: ['cleo'], device: 'server-3' }]
  const m = foreignMatch(two, 'cleo', 'laptop', 'server-1')
  expect(m && 'error' in m && m.error).toContain('fits 2 sessions')
})

test("a key with another machine's prefix is foreign; a bare one or this node's own is not (as before)", () => {
  expect(foreignTargets([`@server-2:${SID}`], 'laptop')).toBe(true)
  expect(foreignTargets([SID, 'atlas', '@laptop:x'], 'laptop')).toBe(false)
})

// The command itself, on a node whose board is a stand-in on a port of the test's: nothing of this
// computer's fits, so the master's agents are asked and the archive goes up by the prefixed key.
const ME = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b'

function standIn(archived: unknown[]) {
  const calls: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/api/board')
        return Response.json({ items: [], relayedDevices: { master: 'server-1' } })
      if (req.method === 'POST' && path === '/api/node/call') {
        const body = await req.json()
        calls.push(body)
        return Response.json({
          state: 'answered',
          code: 0,
          out: ['[', ...views.map((v, i, a) => `${JSON.stringify(v)}${i < a.length - 1 ? ',' : ''}`), ']'],
          err: [],
        })
      }
      if (req.method === 'POST' && path === '/api/archive') {
        archived.push(await req.json())
        return Response.json({ ok: true, failed: [] })
      }
      return new Response(null, { status: 404 })
    },
  })
  return { port: server.port as number, calls, stop: () => server.stop(true) }
}

async function archiveCli(box: Sandbox, port: number, target: string) {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', wakeUrl: null, port, node: { id: 'laptop', port: 12430, workRoot: '/srv/work' } }),
  )
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'archive', '--session', target], {
    cwd: root,
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: ME },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${o}${e}`.trim() }
}

test("board archive on a node: another machine's session by its id or its name goes to the master by its prefixed key", async () => {
  const box = await sandbox()
  // This computer's herdr: no session at all.
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const archived: unknown[] = []
  const board = standIn(archived)
  try {
    const byName = await archiveCli(box, board.port, 'agent-board-android-c5')
    expect(byName).toEqual({
      code: 0,
      out: `ok · archived @server-2:${SID}: the user can bring it back from the board's archive (Archive on the toolbar)`,
    })
    expect(board.calls).toEqual([{ cmd: 'agents', argv: ['--json'], session: ME, lane: null, files: [] }])
    expect((await archiveCli(box, board.port, SID)).code).toBe(0)
    expect((await archiveCli(box, board.port, 'atlas')).code).toBe(0)
    expect(archived).toEqual([
      { op: 'archive', keys: [`@server-2:${SID}`] },
      { op: 'archive', keys: [`@server-2:${SID}`] },
      { op: 'archive', keys: ['@server-1:b1c2d3e4-0000-4000-8000-000000000001'] },
    ])
    // A name no machine has: the same answer as before, nothing archived.
    const none = await archiveCli(box, board.port, 'nobody')
    expect(none).toEqual({ code: 1, out: 'board: no session "nobody" on the board' })
    expect(archived).toHaveLength(3)
  } finally {
    board.stop()
  }
}, 30_000)
