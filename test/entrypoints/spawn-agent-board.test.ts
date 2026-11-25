// spawn-agent asks the board (#505, docs/design/nodes 8.5, 14 T9), end to end: the entrypoint in a
// sandbox with its fake herdr, and a fake board on a port of its own in this process that answers
// GET /api/board and POST /api/launch as the real one does. With `nodes` and the board up the start
// is the board's and the line says where it went; with the board down, without `nodes`, from the
// board's own launcher and for the starts the placer does not take, the line and herdr's calls are
// those of a twin sandbox without `nodes`, and the board hears nothing.
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
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
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'

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
}) {
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
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })
  servers.push(server)
  return { port: server.port, requests, posted: () => posted }
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

/** The caller as the board shows it: a Claude session in lane acme, workspace Acme, profile default. */
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
const own = (more: Record<string, unknown>) => ({
  id: 'abcd1234',
  name: 'Acme invoices',
  state: 'starting',
  step: 'placing',
  error: '',
  pane: null,
  key: null,
  ...more,
})

test('with nodes and the board up, the start is the board’s: posted as an agent’s, and the line names the device', async () => {
  const board = fakeBoard({
    payload: (polls, posted) =>
      !posted
        ? { items: [caller], launches: [] }
        : polls < 2
          ? { items: [caller], launches: [own({ place: { device: 'server-1' } })] }
          : {
              items: [
                caller,
                {
                  key: `@server-1:${SESSION}`,
                  session: SESSION,
                  pane: 'wN:p4',
                  device: 'server-1',
                  name: 'Acme invoices',
                },
              ],
              launches: [],
            },
  })
  const { box, dir, brief } = await startBox({ port: board.port, nodes: { lanes: 'all' } })
  const r = await runSpawn(box, ['-Name', 'Acme invoices', '-Cwd', dir, '-Label', 'Invoices', '-BriefFile', brief], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(
    r.stdout.trim(),
    `pane=@server-1:wN:p4 name=Acme invoices agent=@server-1:${SESSION} device=server-1 session=${SESSION}`,
  )
  // This computer's herdr was asked nothing: the node started it.
  assert.deepEqual(box.calls(), [])
  assert.deepEqual(board.posted(), {
    name: 'Acme invoices',
    cwd: dir,
    label: 'Invoices',
    message: 'Check the invoices.\nThen report.',
    workspace: { id: 'wA', label: 'Acme' },
    category: 'acme',
    profile: 'default',
    parent: CALLER,
    byHand: false,
  })
}, 30_000)

test('a start that waits in the queue prints queued= and the blocker, exit 0; one the board refuses says why, exit 1', async () => {
  const queued = fakeBoard({
    payload: (_polls, posted) =>
      posted
        ? {
            items: [caller],
            launches: [
              own({ state: 'queued', place: { wait: { device: 'server-1', kind: 'sessions', busy: 3, max: 3 } } }),
            ],
          }
        : { items: [caller], launches: [] },
  })
  const a = await startBox({ port: queued.port, nodes: {} })
  const q = await runSpawn(a.box, ['--name', 'Acme invoices', '--cwd', a.dir, '--workspace', 'wA', '--model', 'opus'])
  assert.equal(q.code, 0, q.stderr)
  assert.equal(q.stdout.trim(), 'queued=abcd1234 name=Acme invoices waiting=server-1:sessions')
  assert.equal(queued.posted()?.model, 'opus')
  assert.deepEqual(a.box.calls(), [])

  const refused = fakeBoard({
    payload: (_polls, posted) =>
      posted
        ? {
            items: [],
            launches: [
              own({
                state: 'failed',
                place: { refuse: { kind: 'unfit', devices: [{ device: 'server-1', kind: 'paused' }] } },
              }),
            ],
          }
        : { items: [], launches: [] },
  })
  const b = await startBox({ port: refused.port, nodes: {} })
  const f = await runSpawn(b.box, ['--name', 'Acme invoices', '--cwd', b.dir, '--workspace', 'wA'])
  assert.equal(f.code, 1)
  assert.equal(f.stdout, '')
  assert.equal(f.stderr.trim(), 'spawn-agent: No device can take it: server-1 is paused')
  // Without a caller on the board the request names no parent and no lane.
  assert.equal(refused.posted()?.parent, undefined)
  assert.equal(refused.posted()?.category, undefined)

  const homeRefused = fakeBoard({
    payload: (_polls, posted) =>
      posted
        ? {
            items: [],
            launches: [
              own({
                state: 'failed',
                place: {
                  refuse: {
                    kind: 'unfit',
                    devices: [{ device: 'local', kind: 'draining' }],
                    home: { kind: 'unpushed' },
                  },
                },
              }),
            ],
          }
        : { items: [], launches: [] },
  })
  const hr = await startBox({ port: homeRefused.port, nodes: {} })
  const h = await runSpawn(hr.box, ['--name', 'Acme invoices', '--cwd', hr.dir, '--workspace', 'wA'])
  assert.equal(h.code, 1)
  assert.equal(h.stdout, '')
  assert.equal(
    h.stderr.trim(),
    'spawn-agent: Cannot leave this computer (the branch is not at its remote branch), and this computer is draining. Push the branch.',
  )

  const bad = fakeBoard({
    payload: () => ({ items: [], launches: [] }),
    launch: () => ({
      status: 400,
      body: { ok: false, field: 'message', error: 'The first message is longer than 20000 characters' },
    }),
  })
  const c = await startBox({ port: bad.port, nodes: {} })
  const e = await runSpawn(c.box, ['--name', 'Acme invoices', '--cwd', c.dir, '--workspace', 'wA'])
  assert.equal(e.code, 1)
  assert.equal(e.stderr.trim(), 'spawn-agent: The first message is longer than 20000 characters (message)')
  assert.deepEqual(c.box.calls(), [])
}, 30_000)

test('a start the placer keeps on this computer prints spawn-agent’s own line, herdr’s name for the pane, pi with kind=pi', async () => {
  for (const [agent, tail] of [
    ['claude', ''],
    ['pi', ' kind=pi'],
  ] as const) {
    const board = fakeBoard({
      payload: (polls, posted) =>
        !posted
          ? { items: [caller], launches: [] }
          : polls < 1
            ? { items: [caller], launches: [own({ step: 'agent' })] }
            : {
                items: [caller, { key: SESSION, session: SESSION, pane: 'wA:p9', name: 'Acme invoices', agent }],
                launches: [own({ state: 'done', pane: 'wA:p9', agent })],
              },
    })
    const { box, dir } = await startBox({ port: board.port, nodes: {} })
    box.state({ 'agent list': { result: { agents: [{ name: 'acme-invoices-2', pane_id: 'wA:p9' }] } } })
    const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', dir, '--workspace', 'wA'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), `pane=wA:p9 name=Acme invoices agent=acme-invoices-2${tail}`)
    assert.deepEqual(
      box.calls().map(a => a.join(' ')),
      ['agent list'],
    )
  }
}, 30_000)

/** What a run printed and asked herdr, with the sandbox's folder written as <box>. */
const seen = (box: Sandbox, r: { code: number; stdout: string; stderr: string }) => {
  const norm = (s: string) => s.split(box.dir).join('<box>')
  return {
    code: r.code,
    stdout: norm(r.stdout),
    stderr: norm(r.stderr),
    calls: box.calls().map(a => norm(a.join(' '))),
  }
}

/** The same arguments in a twin sandbox without `nodes` and in one with `cfg`: what each printed and asked herdr. */
async function twins(
  cfg: Record<string, unknown>,
  args: (dir: string) => string[],
  env: Record<string, string> = {},
  base: (box: Sandbox) => Record<string, unknown> = () => ({}),
) {
  const main = await startBox({})
  const ours = await startBox(cfg)
  // The part of config.json both twins share, made from each one's own sandbox.
  boardConfig(main.box, { language: 'en', ...base(main.box) })
  boardConfig(ours.box, { language: 'en', ...base(ours.box), ...cfg })
  const a = await runSpawn(main.box, args(main.dir))
  const b = await runSpawn(ours.box, args(ours.dir), env)
  return { main: seen(main.box, a), ours: seen(ours.box, b) }
}

/** herdr's calls in a row, a run of `pane get` (the wait for Claude) as one. */
const callList = (calls: string[]) => {
  const one = calls.map(c => (c.startsWith('pane get ') ? 'pane get' : c))
  return one.filter((c, i) => c !== 'pane get' || one[i - 1] !== 'pane get')
}

const plain = (dir: string) => ['--name', 'Acme invoices', '--cwd', dir, '--workspace', 'wA', '--brief', 'Go.']

test('with the board down, and without nodes, the line and herdr’s calls are main’s, and no request is made', async () => {
  const down = await twins({ port: await unusedPort(), nodes: {} }, plain)
  assert.equal(down.main.code, 0, down.main.stderr)
  assert.equal(down.main.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2')
  assert.deepEqual(callList(down.main.calls), [
    'tab create --workspace wA --cwd <box>\\Acme project --label Acme invoices --no-focus'.replace('\\', sep),
    'pane run wA:p9 claude',
    'pane get',
    'agent list',
    'agent rename wA:p9 acme-invoices-2',
    'agent prompt wA:p9 /rename Acme invoices',
    'pane read wA:p9 --source visible',
    'agent prompt wA:p9 Go.',
  ])
  assert.deepEqual(down.ours, down.main)

  const board = fakeBoard({ payload: () => ({ items: [caller], launches: [] }) })
  const without = await twins({ port: board.port }, plain)
  assert.deepEqual(without.ours, without.main)
  assert.deepEqual(board.requests, [])
}, 30_000)

test('the board’s own launcher, which runs spawn-agent as a child, does not come back to the board', async () => {
  const board = fakeBoard({ payload: () => ({ items: [caller], launches: [] }) })
  const cfg = { port: board.port, nodes: {} }
  // The mark the launcher sets, even on a start that names no session id.
  const marked = await twins(cfg, plain, { BOARD_SPAWN_CHILD: '1' })
  assert.equal(marked.main.code, 0, marked.main.stderr)
  assert.deepEqual(marked.ours, marked.main)
  // The launcher's arguments: --session-id and the profile's env as the board decided it.
  const launcher = await twins(cfg, dir => [...plain(dir), '--session-id', SID, '--keep-env'])
  assert.match(launcher.main.calls.join('\n'), new RegExp(`--session-id ${SID}`))
  assert.deepEqual(launcher.ours, launcher.main)
  assert.deepEqual(board.requests, [])
}, 30_000)

test('--resume, --fork and --pane go as without nodes, and so does a Workdesk worker’s start', async () => {
  const board = fakeBoard({ payload: () => ({ items: [caller], launches: [] }) })
  const cfg = { port: board.port, nodes: {} }
  for (const more of [
    ['--resume', SID],
    ['--fork', SID],
    ['--pane', 'wA:p9'],
  ]) {
    const r = await twins(cfg, dir => [...plain(dir).filter(a => a !== 'wA' && a !== '--workspace'), ...more])
    assert.deepEqual(r.ours, r.main, more.join(' '))
  }
  assert.deepEqual(board.requests, [])
}, 60_000)

test('--trust goes with the start the board places (#798): posted as trust: true; one without it posts no such key', async () => {
  const queuedOf = () =>
    fakeBoard({
      payload: (_polls, posted) =>
        posted
          ? {
              items: [caller],
              launches: [
                own({ state: 'queued', place: { wait: { device: 'server-1', kind: 'sessions', busy: 3, max: 3 } } }),
              ],
            }
          : { items: [caller], launches: [] },
    })
  const trusted = queuedOf()
  const a = await startBox({ port: trusted.port, nodes: {} })
  const q = await runSpawn(a.box, ['--name', 'Acme invoices', '--cwd', a.dir, '--workspace', 'wA', '--trust'])
  assert.equal(q.code, 0, q.stderr)
  assert.equal(q.stdout.trim(), 'queued=abcd1234 name=Acme invoices waiting=server-1:sessions')
  assert.equal(trusted.posted()?.trust, true)
  assert.deepEqual(a.box.calls(), [])
  const plainOne = queuedOf()
  const b = await startBox({ port: plainOne.port, nodes: {} })
  assert.equal((await runSpawn(b.box, ['--name', 'Acme invoices', '--cwd', b.dir, '--workspace', 'wA'])).code, 0)
  assert.equal('trust' in (plainOne.posted() ?? {}), false)
}, 30_000)

test('--trust with another agent, a board with a launcher of its own, a hidden profile not the caller’s, a refusal on stale data: as without nodes', async () => {
  const board = fakeBoard({ payload: () => ({ items: [], launches: [] }) })
  const cfg = { port: board.port, nodes: {} }
  // With another agent than Claude, --trust stays spawn-agent's (Antigravity's own dialog, #648): the start stays here.
  const trust = await twins(cfg, dir => [...plain(dir), '--trust', '--agent', 'pi'])
  assert.equal(trust.main.code, 0, trust.main.stderr)
  assert.deepEqual(trust.ours, trust.main)
  // The board would start it with the owner's launcher, not this path.
  for (const launch of [{ command: ['my-launcher', '{name}'] }, { agent: 'claude' }]) {
    const own = await twins({ ...cfg, launch }, plain)
    assert.deepEqual(own.ours, own.main, JSON.stringify(launch))
  }
  assert.deepEqual(board.requests, [])
  // The agent's own profile is hidden on the board, and the board does not show the agent: asked
  // by name the board would refuse it, so it starts here as before.
  const hidden = await twins(cfg, plain, {}, box => ({
    profiles: [
      { id: 'default', title: 'Private', dir: join(box.env.HOME as string, '.claude'), color: 'indigo', hidden: true },
    ],
  }))
  assert.equal(hidden.main.code, 0, hidden.main.stderr)
  assert.deepEqual(hidden.ours, hidden.main)
  assert.deepEqual(board.requests, ['GET /api/board'])

  // The board refuses on herdr data it does not trust yet: nothing started there, so here.
  const stale = fakeBoard({
    payload: () => ({ items: [], launches: [] }),
    launch: () => ({ status: 409, body: { ok: false, error: 'read only' } }),
  })
  const r = await twins({ port: stale.port, nodes: {} }, plain)
  assert.deepEqual(r.ours, r.main)
  assert.deepEqual(stale.requests, ['GET /api/board', 'POST /api/launch'])
}, 60_000)
