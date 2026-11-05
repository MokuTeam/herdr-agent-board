import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { jsonl, type Line, line } from '../support/helper-fixtures.ts'
import { sandbox } from '../support/sandbox.ts'

type Json = Record<string, unknown>
type Board = { items: (Json & { key: string; links?: { from: Json | null; talks: Json[] } | null })[] }
type Log = { edges: (Json & { seq: number; kind: string })[]; next: number }

test('#280: the edge log, read from the transcripts, served after a cursor; the board as before', async () => {
  const box = await sandbox()
  const claude = join(box.env.HOME ?? '', '.claude')
  const project = join(claude, 'projects', 'C--w-case')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  // Both sessions run (their registry names this test's own process, which is alive).
  const registry = (sessionId: string, name: string) =>
    JSON.stringify({ pid: process.pid, sessionId, kind: 'interactive', name, startedAt: 0 })
  writeFileSync(join(claude, 'sessions', 'a.json'), registry('s1', 'Мастер 50%'))
  writeFileSync(join(claude, 'sessions', 'b.json'), registry('s2', 'case-42'))
  const main = (o: Line): Line => ({ ...o, isSidechain: false, sessionId: 's1' })
  writeFileSync(
    join(project, 's1.jsonl'),
    jsonl([
      main(line.user(0, 'Hand out the case.', { uuid: 'u0' })),
      main(line.call(1, 'sp', 'Bash', { command: 'spawn-agent -Name case-42 -Cwd C:\\w\\case' }, { uuid: 'u1' })),
      main(line.result(2, 'sp', 'pane=p2 name=case-42 agent=case-42', { uuid: 'u2' })),
      main(line.call(3, 'hp', 'Bash', { command: 'herdr agent prompt case-42 "Go on" --wait' }, { uuid: 'u3' })),
      // Only mentions it: no prompt.
      main(
        line.call(
          4,
          'ed',
          'Bash',
          { command: "cat >> CLAUDE.md <<'EOF'\nherdr agent prompt case-42 x\nEOF" },
          { uuid: 'u4' },
        ),
      ),
      main(
        line.call(5, 'sm', 'SendMessage', { to: 'case-42', summary: 'Status', message: 'How far?' }, { uuid: 'u5' }),
      ),
    ]),
  )
  writeFileSync(join(project, 's2.jsonl'), jsonl([main(line.user(0, 'Work the case.'))]))
  const panes = [
    { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: 'C:\\w\\case' },
    { pane_id: 'p2', agent: 'claude', agent_session: { value: 's2' }, agent_status: 'working', cwd: 'C:\\w\\case' },
  ]
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const { url } = await serveBoard(box)
  const get = async <T = Json>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) })
    return { status: res.status, body: (await res.json()) as T }
  }
  let log: Log = { edges: [], next: 0 }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    log = (await get<Log>('/api/links/log')).body
    if (log.edges.length >= 3) break
    await Bun.sleep(50)
  }
  assert.deepEqual(
    log.edges.map(e => [e.seq, e.kind, e.uuid, e.session, e.sessionName, e.toSession, e.toKey]),
    [
      [1, 'spawn', 'u2', 's1', 'Мастер 50%', 's2', 's2'],
      [2, 'prompted', 'u3', 's1', 'Мастер 50%', 's2', 's2'],
      [3, 'sent', 'u5', 's1', 'Мастер 50%', 's2', 's2'],
    ],
  )
  assert.deepEqual(
    [log.edges[1]?.target, log.edges[1]?.verb, log.edges[2]?.summary],
    ['case-42', 'agent prompt', 'Status'],
  )
  assert.ok(!JSON.stringify(log).includes('How far'))
  assert.equal(log.next, 3)
  assert.deepEqual(
    (await get<Log>('/api/links/log?since=1&limit=1')).body.edges.map(e => e.seq),
    [2],
  )
  assert.deepEqual((await get<Log>('/api/links/log?since=3')).body, { edges: [], next: 3 })
  // A cursor that is no number reads from the start.
  assert.equal((await get<Log>('/api/links/log?since=x')).body.edges.length, 3)
  // In the board's state folder.
  const dir = join(box.env.LOCALAPPDATA ?? '', 'herdr', 'plugins', 'agent-board', 'edge-log')
  assert.ok(existsSync(join(dir, 'marks.json')))
  assert.deepEqual(
    readdirSync(dir).filter(f => f.endsWith('.jsonl')),
    ['edges-000000000001.jsonl'],
  )
  // The board's links are what they were: the start and the message, the prompt no talk of its own.
  const board = (await get<Board>('/api/board')).body
  const s1 = board.items.find(i => i.key === 's1')
  assert.deepEqual(board.items.find(i => i.key === 's2')?.links?.from, {
    key: 's1',
    name: 'Мастер 50%',
    at: (board.items.find(i => i.key === 's2')?.links?.from as Json)?.at,
  })
  assert.deepEqual(
    s1?.links?.talks.map(t => [t.key, t.in, t.out]),
    [['s2', 0, 1]],
  )
}, 20_000)
