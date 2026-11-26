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

async function runCli(
  box: Sandbox,
  args: string[],
  stdin?: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
    cwd: root,
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: '', ...extraEnv },
    ...(stdin !== undefined && { stdin: new TextEncoder().encode(stdin) }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('#628 board agents lists local and node sessions (including agy), marks self, and supports --json and node fallback', async () => {
  const box = await sandbox()
  const AGY = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
  let answer: unknown = {
    state: 'answered',
    code: 0,
    out: ['Laptop Work [3e4f5a6b]  ·  claude  ·  laptop  ·  working'],
    err: [],
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/api/board')
        return Response.json({
          items: [
            { key: ME, session: ME, agent: 'claude', name: 'Agent-board Master', pane: 'w5:p2', status: 'done' },
            { key: AGY, session: AGY, agent: 'agy', name: 'Gemini-dev', pane: 'w5:p7', status: 'working' },
          ],
        })
      if (req.method === 'POST' && path === '/api/node/call') return Response.json(answer)
      return new Response(null, { status: 404 })
    },
  })
  try {
    // Standalone board: lists both claude and agy, marks caller.
    config(box, { port: server.port })
    const local = await runCli(box, ['agents', '--session', AGY])
    expect(local.code).toBe(0)
    expect(local.stdout.trim().split('\n')).toEqual([
      'Agent-board Master [3e4f5a6b]  ·  claude  ·  done',
      'Gemini-dev [509dfc37]  ·  agy  ·  working  ·  (this session)',
    ])
    const json = await runCli(box, ['agents', '--json', '--session', AGY])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject([
      { key: ME, agent: 'claude', self: false },
      { key: AGY, agent: 'agy', self: true },
    ])

    // On a node: uses master uplink when answered, falls back to local board when older master refuses (126) or unreachable.
    config(box, { port: server.port, node: { id: 'server-2', port: 12430 } })
    const viaMaster = await runCli(box, ['agents', '--session', AGY])
    expect(viaMaster.code).toBe(0)
    expect(viaMaster.stdout.trim()).toBe('Laptop Work [3e4f5a6b]  ·  claude  ·  laptop  ·  working')

    for (const fallback of [
      { state: 'answered', code: 126, out: [], err: ['board agents is not taken from a node'] },
      { state: 'unreachable' },
    ]) {
      answer = fallback
      const localFallback = await runCli(box, ['agents', '--session', AGY])
      expect(localFallback.code).toBe(0)
      expect(localFallback.stdout.trim().split('\n')).toEqual([
        'Agent-board Master [3e4f5a6b]  ·  claude  ·  done',
        'Gemini-dev [509dfc37]  ·  agy  ·  working  ·  (this session)',
      ])
    }
  } finally {
    server.stop(true)
  }
})

test('#628 board mcp --agents serves ListAgents and SendMessage over stdio JSON-RPC', async () => {
  const box = await sandbox()
  const board = standIn()
  config(box, { port: board.port, nodes: { id: 'laptop' } })
  try {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ListAgents', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'SendMessage', arguments: { to: 'Monitor', message: 'hello via mcp' } },
      },
    ]
      .map(m => JSON.stringify(m))
      .join('\n')
    const r = await runCli(box, ['mcp', '--agents', '--session', ME], `${input}\n`)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    const lines = r.stdout
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as { id: number; result?: { tools?: { name: string }[]; content?: { text: string }[] } })
    expect(lines.map(l => l.id)).toEqual([1, 2, 3, 4])
    expect(lines[1]?.result?.tools?.map(t => t.name)).toEqual(['ListAgents', 'SendMessage'])
    const listed = lines[2]?.result?.content?.[0]?.text ?? ''
    expect(listed).toContain('Laptop Work [3e4f5a6b]')
    expect(listed).toContain('(this session)')
    expect(listed).toContain('Monitor [4f5a6b7c]')
    expect(listed).toContain('Agent-board Master [7b8c9d0e]')
    expect(lines[3]?.result?.content?.[0]?.text).toStartWith('ok · queued for Monitor [4f5a6b7c] on laptop:')
    expect(scheduled(box)).toMatchObject([{ key: MON, text: 'hello via mcp', from: { key: ME, name: 'Laptop Work' } }])
  } finally {
    board.stop()
  }
})

test('#912 board agents without a session on a node goes via /api/node-cli, and pane shells without herdr resolve via /api/board', async () => {
  const box = await sandbox()
  const PANE_SID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
  const calls: { path: string; body: unknown }[] = []
  let cliAnswer: { status: number; body: unknown } = {
    status: 200,
    body: {
      code: 0,
      out: ['Master Session [3e4f5a6b]  ·  claude  ·  master-box  ·  working'],
      err: [],
    },
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/api/board')
        return Response.json({
          items: [
            {
              key: PANE_SID,
              session: PANE_SID,
              agent: 'claude',
              name: 'Pane Worker',
              pane: 'w5:p7',
              cwd: '/tmp/work',
              status: 'working',
            },
          ],
        })
      const body = await req.json()
      calls.push({ path, body })
      if (req.method === 'POST' && path === '/api/node-cli')
        return Response.json(cliAnswer.body, { status: cliAnswer.status })
      if (req.method === 'POST' && path === '/api/node/call')
        return Response.json({
          state: 'answered',
          code: 0,
          out: ['Pane Worker [509dfc37]  ·  claude  ·  node win-node  ·  working  ·  (this session)'],
          err: [],
        })
      return new Response(null, { status: 404 })
    },
  })
  try {
    // On a node without a session: uses /api/node-cli for plain and --json agents.
    config(box, { port: server.port, node: { id: 'win-node', port: 12430 } })
    const noSess = await runCli(box, ['agents'])
    expect(noSess.code, noSess.stderr).toBe(0)
    expect(noSess.stdout.trim()).toBe('Master Session [3e4f5a6b]  ·  claude  ·  master-box  ·  working')
    expect(calls.at(-1)).toEqual({ path: '/api/node-cli', body: { cmd: 'agents', argv: [] } })

    cliAnswer = {
      status: 200,
      body: {
        code: 0,
        out: [JSON.stringify([{ key: ME, name: 'Master Session', self: false }])],
        err: [],
      },
    }
    const noSessJson = await runCli(box, ['agents', '--json'])
    expect(noSessJson.code, noSessJson.stderr).toBe(0)
    expect(JSON.parse(noSessJson.stdout)).toMatchObject([{ key: ME, name: 'Master Session' }])
    expect(calls.at(-1)).toEqual({ path: '/api/node-cli', body: { cmd: 'agents', argv: ['--json'] } })

    // Offline master on /api/node-cli (503 node-master-offline): falls back to local board.
    cliAnswer = { status: 503, body: { ok: false, error: 'node-master-offline' } }
    const offlineFallback = await runCli(box, ['agents'])
    expect(offlineFallback.code, offlineFallback.stderr).toBe(0)
    expect(offlineFallback.stdout.trim()).toBe('Pane Worker [509dfc37]  ·  claude  ·  working')

    // In a herdr pane when HERDR_BIN_PATH is broken/missing from PATH: falls back to /api/board for pane resolution.
    const brokenHerdrEnv = {
      HERDR_PANE_ID: 'w5:p7',
      HERDR_BIN_PATH: join(box.dir, 'missing-herdr.exe'),
    }
    const viaPane = await runCli(box, ['agents'], undefined, brokenHerdrEnv)
    expect(viaPane.code, viaPane.stderr).toBe(0)
    expect(viaPane.stdout.trim()).toBe(
      'Pane Worker [509dfc37]  ·  claude  ·  node win-node  ·  working  ·  (this session)',
    )
    expect(calls.at(-1)).toEqual({
      path: '/api/node/call',
      body: { cmd: 'agents', argv: [], session: PANE_SID, lane: null, files: [] },
    })

    const sendViaPane = await runCli(box, ['send', 'Master Session', 'hello from pane'], undefined, brokenHerdrEnv)
    expect(sendViaPane.code, sendViaPane.stderr).toBe(0)
    expect(calls.at(-1)).toEqual({
      path: '/api/node/call',
      body: { cmd: 'send', argv: ['Master Session', 'hello from pane'], session: PANE_SID, lane: null, files: [] },
    })

    // Standalone board (no `node`): never touches /api/node/call or /api/node-cli.
    calls.length = 0
    config(box, { port: server.port })
    const standalone = await runCli(box, ['agents'])
    expect(standalone.code, standalone.stderr).toBe(0)
    expect(standalone.stdout.trim()).toBe('Pane Worker [509dfc37]  ·  claude  ·  working')
    expect(calls).toEqual([])
  } finally {
    server.stop(true)
  }
})
