import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isBoardPayload, isSessionDetail } from '../../web/src/api/client.ts'
import { isHelperReply } from '../../web/src/api/helpers.ts'
import { serveBoard } from '../support/board-server.ts'
import { jsonl, type Line, line } from '../support/helper-fixtures.ts'
import { sandbox } from '../support/sandbox.ts'

type Json = Record<string, unknown>
type Turn = Json & { role: string; send?: Json; spawn?: Json }
type Board = {
  items: (Json & {
    key: string
    helpers?: { live: unknown[]; running: number }
    links?: { from: Json | null; started: { key: string }[]; talks: { key: string; out: number }[] } | null
  })[]
}

test('the board shows helpers and links; a helper is served only from its own session', async () => {
  const box = await sandbox()
  const claude = join(box.env.HOME ?? '', '.claude')
  const project = join(claude, 'projects', 'C--w-case')
  mkdirSync(join(project, 's1', 'subagents'), { recursive: true })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  // Both sessions run (their registry names this test's own process, which is alive).
  const registry = (sessionId: string, name: string, pipe: string) =>
    JSON.stringify({
      pid: process.pid,
      sessionId,
      kind: 'interactive',
      name,
      startedAt: 0,
      messagingSocketPath: pipe,
    })
  writeFileSync(join(claude, 'sessions', 'a.json'), registry('s1', 'Master', '\\\\.\\pipe\\LOCAL\\cc-msg-1'))
  writeFileSync(join(claude, 'sessions', 'b.json'), registry('s2', 'case-42', '\\\\.\\pipe\\LOCAL\\cc-msg-2'))
  const main = (o: Line): Line => ({ ...o, isSidechain: false })
  writeFileSync(
    join(project, 's1.jsonl'),
    jsonl([
      main(line.user(0, 'Hand out the case.')),
      main(line.call(1, 'sp', 'Bash', { command: 'spawn-agent -Name case-42 -Cwd C:\\w\\case' })),
      main(line.result(2, 'sp', 'pane=p2 name=case-42 agent=case-42')),
      main(line.call(3, 'ag', 'Agent', { description: 'Check the logs', subagent_type: 'general-purpose' })),
      main(line.result(4, 'ag', 'Async agent launched successfully.', { toolUseResult: { agentId: 'arun1' } })),
      main(line.call(5, 'sm', 'SendMessage', { to: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-2', message: 'How far?' })),
      // The answer: another session's message, the sender and its pipe in its origin.
      main(
        line.user(6, 'Another Claude session sent a message: Halfway.', {
          isMeta: true,
          origin: {
            kind: 'peer',
            from: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-2',
            name: 'case-42',
            msg_id: 'pm1',
            body: 'Halfway.',
          },
        }),
      ),
    ]),
  )
  writeFileSync(
    join(project, 's1', 'subagents', 'agent-arun1.meta.json'),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'Check the logs',
      toolUseId: 'ag',
      requestShape: 'background',
    }),
  )
  writeFileSync(
    join(project, 's1', 'subagents', 'agent-arun1.jsonl'),
    jsonl([line.user(0, 'Read the logs.'), line.call(1, 'r1', 'Read', { file_path: 'C:/w/case/app.log' })]),
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
  // The links come from a read in the background, which refreshes the board when it finds some.
  let board: Board = { items: [] }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    board = (await get<Board>('/api/board')).body
    if (board.items.find(i => i.key === 's2')?.links?.from) break
    await Bun.sleep(50)
  }
  // What the page checks every answer with takes the server's as it is.
  assert.ok(isBoardPayload(board))
  const s1 = board.items.find(i => i.key === 's1')
  const s2 = board.items.find(i => i.key === 's2')
  assert.deepEqual(s1?.helpers?.live, [{ id: 'arun1', kind: 'agent', label: 'Check the logs', color: '' }])
  assert.equal(s1?.helpers?.running, 1)
  assert.deepEqual(s2?.links?.from, { key: 's1', name: 'Master', at: s2?.links?.from?.at })
  assert.deepEqual(
    s1?.links?.started.map(x => x.key),
    ['s2'],
  )
  assert.deepEqual(
    s1?.links?.talks.map(x => [x.key, x.out]),
    [['s2', 1]],
  )
  // What stays on the server: transcripts, the Claude process and its message pipe.
  for (const key of ['transcript', 'pipe', 'since', 'alive']) assert.ok(s1 && !(key in s1), key)

  const detail = (
    await get<{ helpers: (Json & { id: string; status: string; now?: { label: string } })[]; conversation: Turn[] }>(
      '/api/session/s1',
    )
  ).body
  assert.deepEqual(
    detail.helpers.map(h => [h.id, h.status, h.now?.label]),
    [['arun1', 'running', 'Read']],
  )
  assert.ok(!('path' in (detail.helpers[0] ?? {})))
  const sent = detail.conversation.find(m => m.send)
  assert.deepEqual(sent?.send, { to: 'case-42', summary: '', text: 'How far?', name: '', key: 's2' }) // a pipe becomes the session
  assert.equal(detail.conversation.find(m => m.spawn)?.spawn?.pane, 'p2')
  // The answer came from the session on that pipe: its card's key, no pipe for the page.
  const answer = detail.conversation.find(m => m.role === 'peer')
  assert.deepEqual(answer, { role: 'peer', from: 'case-42', text: 'Halfway.', id: 'pm1', at: answer?.at, key: 's2' })
  assert.ok(isSessionDetail(detail))

  const one = await get<{ helper: { tools: number }; conversation: Turn[] }>('/api/session/s1/helper/arun1')
  assert.equal(one.status, 200)
  assert.equal(one.body.helper.tools, 1)
  assert.ok(isHelperReply(one.body))
  assert.deepEqual(
    one.body.conversation.map(m => m.role),
    ['user', 'tool'],
  )
  assert.equal((await get('/api/session/s2/helper/arun1')).status, 404) // not that session's helper
  assert.equal((await get('/api/session/s1/helper/nope')).status, 404)
  assert.equal((await get('/api/session/s1/helper/..%2F..%2Fs2')).status, 404)
  // Whatever its files hold, what comes back names no path on this computer.
  writeFileSync(join(project, 's1', 'subagents', 'agent-arun1.jsonl'), '')
  const empty = await get('/api/session/s1/helper/arun1')
  assert.ok(!JSON.stringify(empty.body).includes(box.env.HOME ?? '~'))
}, 20_000)
