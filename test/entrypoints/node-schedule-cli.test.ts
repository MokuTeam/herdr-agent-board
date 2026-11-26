// board schedule and board unschedule all in a node's session (#806): the entries the master holds
// for it (a handover brought them there, keyed @<node>:<session>) are listed and removed beside the
// node's own. The node's board is a stand-in on a port of the test's; a board that is no node asks
// nothing of it.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const ME = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b'
const MASTER_LINE = 'c9d80d · Thu 2026-11-26 13:30 (in 4 h) · once · on time · ping the client'

type Answer = Record<string, unknown> | null

function standIn(answer: (body: Record<string, unknown>) => Answer) {
  const calls: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/api/board') return Response.json({ items: [] })
      if (req.method === 'POST' && path === '/api/node/call') {
        const body = (await req.json()) as Record<string, unknown>
        calls.push(body)
        return Response.json(answer(body))
      }
      return new Response(null, { status: 404 })
    },
  })
  return { port: server.port as number, calls, stop: () => server.stop(true) }
}

const scheduleDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')

function putLocal(box: Sandbox, id: string, text: string): void {
  mkdirSync(scheduleDir(box), { recursive: true })
  const next = Date.now() + 3_600_000
  writeFileSync(
    join(scheduleDir(box), `${id}.json`),
    JSON.stringify({ id, key: ME, name: 'ben', text, at: next, next, created: Date.now(), by: 'agent' }),
  )
}

async function cli(box: Sandbox, port: number, args: string[], node = true) {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      language: 'en',
      wakeUrl: null,
      port,
      ...(node && { node: { id: 'laptop', port: 12430, workRoot: '/srv/work' } }),
    }),
  )
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
    cwd: root,
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: ME },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: out.trim(), err: err.trim() }
}

test("board schedule on a node: this computer's entries, then the master's for this session", async () => {
  const box = await sandbox()
  putLocal(box, 'aa11bb', 'local note')
  const board = standIn(() => ({ state: 'answered', code: 0, out: [MASTER_LINE], err: [] }))
  try {
    const r = await cli(box, board.port, ['schedule'])
    expect(r.code, r.err).toBe(0)
    const lines = r.out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toStartWith('aa11bb · ')
    expect(lines[0]).toEndWith(' · once · on time · local note')
    expect(lines[1]).toBe(MASTER_LINE)
    expect(r.err).toBe('')
    expect(board.calls).toEqual([{ cmd: 'schedule', argv: [], session: ME, lane: null, files: [] }])
  } finally {
    board.stop()
  }
})

test("board schedule on a node with nothing here: the master's alone; nothing anywhere says so", async () => {
  const box = await sandbox()
  let lines: string[] = [MASTER_LINE]
  const board = standIn(() => ({ state: 'answered', code: 0, out: lines, err: [] }))
  try {
    expect((await cli(box, board.port, ['schedule'])).out).toBe(MASTER_LINE)
    lines = []
    expect((await cli(box, board.port, ['schedule'])).out).toBe('nothing scheduled for this session')
  } finally {
    board.stop()
  }
})

test("board schedule on a node: the master away or older, this computer's entries and a note", async () => {
  const box = await sandbox()
  putLocal(box, 'aa11bb', 'local note')
  for (const [answer, note] of [
    [{ state: 'unreachable' }, "the board's computer is not reachable"],
    [
      { state: 'answered', code: 126, out: [], err: ['board schedule is not taken from a node'] },
      "the board's computer runs an older version",
    ],
  ] as const) {
    const board = standIn(() => answer)
    try {
      const r = await cli(box, board.port, ['schedule'])
      expect(r.code).toBe(0)
      expect(r.out).toEndWith(' · once · on time · local note')
      expect(r.err).toContain(note)
    } finally {
      board.stop()
    }
  }
})

test("board unschedule all on a node: this computer's entries, then the master's for this session", async () => {
  const box = await sandbox()
  putLocal(box, 'aa11bb', 'local note')
  const board = standIn(() => ({
    state: 'answered',
    code: 0,
    out: ["ok · removed 2 entries held by the board's computer"],
    err: [],
  }))
  try {
    const r = await cli(box, board.port, ['unschedule', 'all'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toBe("ok · removed 1 entry\nok · removed 2 entries held by the board's computer")
    expect(existsSync(join(scheduleDir(box), 'aa11bb.json'))).toBe(false)
    expect(board.calls).toHaveLength(1)
    expect(board.calls[0]).toMatchObject({ cmd: 'unschedule', argv: ['all'], session: ME, lane: null, files: [] })
    expect(board.calls[0]?.id).toEqual(expect.any(String))
  } finally {
    board.stop()
  }
})

test('a board that is no node: board schedule and unschedule all ask nothing of the port, as before', async () => {
  const box = await sandbox()
  putLocal(box, 'aa11bb', 'local note')
  const board = standIn(() => ({ state: 'answered', code: 0, out: [MASTER_LINE], err: [] }))
  try {
    const listed = await cli(box, board.port, ['schedule'], false)
    expect(listed.code, listed.err).toBe(0)
    expect(listed.out).toStartWith('aa11bb · ')
    expect(listed.out).not.toContain(MASTER_LINE)
    const removed = await cli(box, board.port, ['unschedule', 'all'], false)
    expect(removed.out).toBe('ok · removed 1 entry')
    expect(board.calls).toEqual([])
  } finally {
    board.stop()
  }
})
