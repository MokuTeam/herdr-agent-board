// spawn-agent --device and spawn-agent on a node (#760), end to end: the entrypoint in a sandbox
// with its fake herdr, and a fake board on a port of its own that answers as the real one does. On a
// master the start is pinned to the device named, refused at once when the board does not list it or
// it is offline; on a board without nodes only `local` is a device; on a node the start goes up to
// the master through the node's board (POST /api/node/call). Without --device a master board and a
// plain board send what they sent before (spawn-agent-board.test.ts covers those).
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] },
  'agent list': { result: { agents: [{ name: 'acme-invoices', pane_id: 'wB:p1' }, { pane_id: 'wA:p9' }] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  'pane read': { text: 'Session renamed to: Acme invoices' },
  'pane send-keys': { result: null },
}
const PACED = { BOARD_TEST_PACE: '0.02' }
const CALLER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SESSION = '5d0c6a1e-1111-4222-8333-444455556666'

const servers: { stop(force?: boolean): unknown }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

type Posted = Record<string, unknown>
/**
 * A board on a free port: `payload(polls, posted)` is what GET /api/board answers (`polls`: how many
 * came after the start was posted), `launch(body)` what POST /api/launch answers. Every request is kept.
 */
function fakeBoard(o: {
  payload: (polls: number, posted: Posted | null) => unknown
  launch?: (body: Posted) => { status: number; body: unknown }
  call?: (body: Posted) => unknown
}) {
  const calls: Posted[] = []
  const requests: string[] = []
  let posted: Posted | null = null
  let polls = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(`${req.method} ${path}`)
      if (req.method === 'GET' && path === '/api/board') return Response.json(o.payload(posted ? polls++ : 0, posted))
      if (req.method === 'POST' && path === '/api/launch') {
        assert.equal(req.headers.get('x-board'), '1')
        posted = (await req.json()) as Posted
        const a = o.launch?.(posted) ?? { status: 200, body: { ok: true, id: 'abcd1234', session: SESSION } }
        return Response.json(a.body, { status: a.status })
      }
      if (req.method === 'POST' && path === '/api/node/call' && o.call) {
        const body = (await req.json()) as Posted
        calls.push(body)
        return Response.json(o.call(body))
      }
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
  servers.push(server)
  return { port: server.port, requests, posted: () => posted, calls }
}

function boardConfig(box: Sandbox, cfg: unknown): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
}

/** A sandbox with the fake herdr's start, the default profile's folder, a project folder and a brief. */
async function startBox(cfg: Record<string, unknown>) {
  const box = await sandbox()
  box.state(STATE)
  mkdirSync(join(box.env.HOME as string, '.claude'), { recursive: true })
  boardConfig(box, { language: 'en', ...cfg })
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  const brief = join(box.dir, 'brief.txt')
  writeFileSync(brief, '﻿Check the invoices.\nThen report.\n')
  return { box, dir, brief }
}

async function runSpawn(box: Sandbox, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, SPAWN, ...args], {
    cwd: root,
    env: { ...box.env, ...PACED, CLAUDE_CODE_SESSION_ID: CALLER, HERDR_PANE_ID: 'wA:p1', ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

const caller = {
  key: CALLER,
  session: CALLER,
  pane: 'wA:p1',
  workspace: 'Acme',
  cwd: '',
  name: 'Lead',
  category: 'acme',
  profile: 'default',
}
const devices = [
  { id: 'local', title: 'This computer', selfId: 'server-2', link: null },
  { id: 'server-1', title: 'Server 1', link: { state: 'online' } },
  { id: 'server-3', title: 'Server 3', link: { state: 'offline' } },
]
const onServer1 = (polls: number, posted: Posted | null) =>
  !posted
    ? { items: [caller], launches: [], devices }
    : polls < 1
      ? {
          items: [caller],
          launches: [
            {
              id: 'abcd1234',
              name: 'Acme invoices',
              state: 'starting',
              step: 'placing',
              error: '',
              place: { device: 'server-1' },
            },
          ],
          devices,
        }
      : {
          items: [
            caller,
            { key: `@server-1:${SESSION}`, session: SESSION, pane: 'wN:p4', device: 'server-1', name: 'Acme invoices' },
          ],
          launches: [],
          devices,
        }

test('on a master --device pins the start to that device; the master’s own id is local', async () => {
  const board = fakeBoard({ payload: onServer1 })
  const { box, dir } = await startBox({ port: board.port, nodes: { lanes: 'all' } })
  const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', dir, '--device', 'server-1'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(
    r.stdout.trim(),
    `pane=@server-1:wN:p4 name=Acme invoices agent=@server-1:${SESSION} device=server-1 session=${SESSION}`,
  )
  assert.deepEqual(board.posted()?.pin, { device: 'server-1' })
  assert.deepEqual(box.calls(), [])

  const local = fakeBoard({ payload: onServer1 })
  const a = await startBox({ port: local.port, nodes: { lanes: 'all' } })
  await runSpawn(a.box, ['--name', 'Acme invoices', '--cwd', a.dir, '--device', 'server-2', '--timeout-sec', '1'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.deepEqual(local.posted()?.pin, { device: 'local' })
}, 30_000)

test('on a master an unknown or offline device is refused before anything starts', async () => {
  for (const [device, why] of [
    [
      'server-9',
      "spawn-agent: --device server-9: the board has no such device (it has server-2, server-1, server-3; local is the board's own computer)",
    ],
    ['server-3', 'spawn-agent: --device server-3: the device is offline, so the start cannot go there now'],
  ]) {
    const board = fakeBoard({ payload: onServer1 })
    const { box, dir } = await startBox({ port: board.port, nodes: { lanes: 'all' } })
    const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', dir, '--device', device as string], {
      HERDR_WORKSPACE_ID: 'wA',
    })
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.trim(), why)
    assert.equal(board.posted(), null)
    assert.deepEqual(box.calls(), [])
  }
}, 30_000)

test('a master whose board does not answer: --device another machine fails, --device local starts here', async () => {
  const port = await unusedPort()
  const a = await startBox({ port, nodes: { lanes: 'all' } })
  const r = await runSpawn(a.box, ['--name', 'Acme invoices', '--cwd', a.dir, '--device', 'server-1'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(r.code, 1)
  assert.equal(
    r.stderr.trim(),
    'spawn-agent: --device server-1: the board does not answer on this computer, so nothing can be placed',
  )
  assert.deepEqual(a.box.calls(), [])
  const b = await startBox({ port, nodes: { lanes: 'all' } })
  const here = await runSpawn(b.box, ['--name', 'Acme invoices', '--cwd', b.dir, '--device', 'local'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(here.code, 0, here.stderr)
  assert.match(here.stdout.trim(), /^pane=wA:p9 name=Acme invoices agent=/)
}, 30_000)

test('a board without nodes: --device local is this computer, as without the flag; any other device is refused', async () => {
  const port = await unusedPort()
  const plain = await startBox({ port })
  const without = await runSpawn(plain.box, ['--name', 'Acme invoices', '--cwd', plain.dir], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  const twin = await startBox({ port })
  const local = await runSpawn(twin.box, ['--name', 'Acme invoices', '--cwd', twin.dir, '--device', 'local'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(local.code, 0, local.stderr)
  assert.equal(local.stdout, without.stdout)
  assert.equal(
    JSON.stringify(twin.box.calls()).replaceAll(twin.dir, '<dir>'),
    JSON.stringify(plain.box.calls()).replaceAll(plain.dir, '<dir>'),
  )
  const other = await startBox({ port })
  const r = await runSpawn(other.box, ['--name', 'Acme invoices', '--cwd', other.dir, '--device', 'server-1'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(r.code, 1)
  assert.equal(
    r.stderr.trim(),
    'spawn-agent: --device server-1: this board has no other devices (no nodes in its config.json)',
  )
  assert.deepEqual(other.box.calls(), [])
}, 30_000)

const nodeCfg = (port: unknown) => ({ port, node: { id: 'laptop' } })
test('on a node the start goes up to the master as the call spawn, and the master’s line is printed', async () => {
  const line = `pane=@server-2:wM:p3 name=Acme invoices agent=acme device=server-2 session=${SESSION}`
  const board = fakeBoard({
    payload: () => ({ items: [caller], launches: [] }),
    call: () => ({ state: 'answered', code: 0, out: [line], err: [] }),
  })
  const { box, dir, brief } = await startBox(nodeCfg(board.port))
  const r = await runSpawn(box, [
    '--name',
    'Acme invoices',
    '--cwd',
    dir,
    '--brief-file',
    brief,
    '--device',
    'server-2',
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), line)
  assert.deepEqual(box.calls(), [])
  assert.equal(board.calls.length, 1)
  const call = board.calls[0] as Posted
  assert.deepEqual([call.cmd, call.session, call.lane], ['spawn', CALLER, 'acme'])
  const sent = JSON.parse((call.argv as string[])[0] as string)
  assert.deepEqual(
    { ...sent, cwd: sent.cwd === dir },
    {
      name: 'Acme invoices',
      cwd: true,
      message: 'Check the invoices.\nThen report.',
      timeoutSec: 120,
      workspace: 'Acme',
      profile: 'default',
      device: 'server-2',
      facts: { checkout: null, identity: null, localPath: null },
    },
  )
}, 30_000)

test('on a node a master that cannot be reached leaves the start here without --device, and is an error with one', async () => {
  const board = fakeBoard({
    payload: () => ({ items: [caller], launches: [] }),
    call: () => ({ state: 'unreachable' }),
  })
  const a = await startBox(nodeCfg(board.port))
  const here = await runSpawn(a.box, ['--name', 'Acme invoices', '--cwd', a.dir], { HERDR_WORKSPACE_ID: 'wA' })
  assert.equal(here.code, 0, here.stderr)
  assert.match(here.stdout.trim(), /^pane=wA:p9 name=Acme invoices agent=/)
  assert.equal(here.stderr.trim(), "spawn-agent: the board's computer is not reachable: starting it on this computer")
  const b = await startBox(nodeCfg(board.port))
  const away = await runSpawn(b.box, ['--name', 'Acme invoices', '--cwd', b.dir, '--device', 'server-2'])
  assert.equal(away.code, 1)
  assert.equal(away.stderr.trim(), "spawn-agent: --device server-2: the board's computer is not reachable")
  assert.deepEqual(b.box.calls(), [])
}, 30_000)

test('the node board’s own launcher never asks the master', async () => {
  const board = fakeBoard({
    payload: () => ({ items: [caller], launches: [] }),
    call: () => ({ state: 'answered', code: 0, out: ['never'], err: [] }),
  })
  const { box, dir } = await startBox(nodeCfg(board.port))
  const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', dir], {
    BOARD_SPAWN_CHILD: '1',
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout.trim(), /^pane=wA:p9 name=Acme invoices agent=/)
  assert.deepEqual(board.calls, [])
  assert.deepEqual(board.requests, [])
}, 30_000)
