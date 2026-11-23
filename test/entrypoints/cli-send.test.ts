import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

// `board send <name|key> "<text>"` (#619, entrypoints/cli.ts sendCmd): on the board's computer it
// reads the running board's cards and queues the message in the schedule; on a node it hands the call
// to the node's board, which takes it up the link to the master (test/services/node-uplink.test.ts).
// A stand-in on a port of the test's answers what the running board would.
const ME = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b'
const N1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
const MON = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c'

const BOARD = {
  items: [
    { key: ME, session: ME, name: 'Laptop Work', pane: 'w1:p1', cwd: 'C:\\Work', status: 'working' },
    { key: MON, session: MON, name: 'Monitor', pane: 'w1:p2', cwd: 'C:\\Work\\Проект 100%', status: 'idle' },
    {
      key: `@server-2:${N1}`,
      session: N1,
      name: 'Agent-board Master',
      device: 'server-2',
      pane: 'w5:p2',
      status: 'idle',
    },
  ],
  devices: [
    { id: 'server-2', link: { state: 'online' } },
    { id: 'local', link: null, status: { id: 'laptop' } },
  ],
}

/** A stand-in for the running board: GET /api/board, and POST /api/node/call answered by `call`. */
function standIn(call: (body: unknown) => unknown = () => ({ state: 'unreachable' })) {
  const calls: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/api/board') return Response.json(BOARD)
      if (req.method === 'POST' && path === '/api/node/call') {
        const body = await req.json()
        calls.push(body)
        return Response.json(call(body))
      }
      return new Response(null, { status: 404 })
    },
  })
  return { port: server.port as number, calls, stop: () => server.stop(true) }
}

function config(box: Sandbox, raw: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', wakeUrl: null, ...raw }))
}

function scheduled(box: Sandbox): ScheduleEntry[] {
  const dir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /^[0-9a-f]{6}\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScheduleEntry)
    .sort((a, b) => a.text.localeCompare(b.text))
}

async function send(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'send', '--session', ME, ...args], {
    cwd: root,
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${o}${e}`.trim() }
}

test('#619 board send on the board’s computer: to a node’s session and to one here, by name or ref; refused as it should be', async () => {
  const box = await sandbox()
  const board = standIn()
  config(box, { port: board.port, nodes: { id: 'laptop' } })
  try {
    const there = await send(box, ['agent-board master', 'ping from the laptop'])
    expect(there).toEqual({
      code: 0,
      out:
        'ok · queued for Agent-board Master [7b8c9d0e] on node server-2: the board types it in once it is free, ' +
        'waking it first if it sleeps; the answer comes back as a board reminder · note: no board with the scheduler ' +
        'is running now; this goes out once one runs (late, with a note)',
    })
    const here = await send(box, ['Monitor [4f5a6b7c]', 'a', 'local', 'one'])
    expect(here.code).toBe(0)
    expect(here.out).toStartWith('ok · queued for Monitor [4f5a6b7c] on laptop:')
    expect(scheduled(box)).toMatchObject([
      {
        key: MON,
        name: 'Monitor',
        pane: 'w1:p2',
        cwd: 'C:\\Work\\Проект 100%',
        text: 'a local one',
        from: { key: ME, name: 'Laptop Work' },
        replyTo: 'Laptop Work [3e4f5a6b]',
        replyBy: 'board',
      },
      {
        key: `@server-2:${N1}`,
        text: 'ping from the laptop',
        idle: true,
        from: { key: ME, name: 'Laptop Work' },
        replyTo: 'Laptop Work [3e4f5a6b]',
        fromDevice: 'laptop',
      },
    ])
    // This computer to this computer: no device named in the prompt.
    expect(scheduled(box)[0]?.fromDevice).toBeUndefined()
    expect(await send(box, ['nobody', 'x'])).toEqual({ code: 1, out: 'board: no session "nobody" on the board' })
    expect(await send(box, ['Laptop Work', 'x'])).toEqual({
      code: 1,
      out: 'board: that is this session: nothing was sent',
    })
    expect((await send(box, ['Monitor'])).out).toBe('board: usage: board send <name|key> "<text>"')
    expect(board.calls).toEqual([])
    expect(scheduled(box)).toHaveLength(2)
  } finally {
    board.stop()
  }
})

test('#619 board send on a node goes to its board as a call, not kept; what the master answered is printed', async () => {
  const box = await sandbox()
  let answer: unknown = {
    state: 'answered',
    code: 0,
    out: ['ok · queued for Monitor [4f5a6b7c] on laptop: …'],
    err: [],
  }
  const board = standIn(() => answer)
  config(box, { port: board.port, node: { id: 'server-2', port: 12430, workRoot: '/srv/work' } })
  try {
    expect(await send(box, ['Monitor', 'done: case 42'])).toEqual({
      code: 0,
      out: 'ok · queued for Monitor [4f5a6b7c] on laptop: …',
    })
    expect(board.calls).toEqual([
      { cmd: 'send', argv: ['Monitor', 'done: case 42'], session: ME, lane: null, files: [] },
    ])
    answer = { state: 'answered', code: 1, out: [], err: ['no session "Monitor" on the board'] }
    expect(await send(box, ['Monitor', 'x'])).toEqual({ code: 1, out: 'no session "Monitor" on the board' })
    answer = { state: 'unreachable' }
    expect(await send(box, ['Monitor', 'x'])).toEqual({
      code: 1,
      out: "board: the board's computer did not answer: it may not have been sent; check before sending it again",
    })
    // Nothing is queued on the node itself: the master holds the board.
    expect(scheduled(box)).toEqual([])
  } finally {
    board.stop()
  }
})
