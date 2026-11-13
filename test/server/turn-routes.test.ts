// Stop and Send now (#330) through the board's HTTP routes, against the sandbox's fake herdr: only
// from the board's own page, Esc only into a working Claude session, and no key, and no herdr call
// of the new kind, for pi, a session herdr does not name, or a turn that is over.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

const LINE = '─'.repeat(40)
const BOX = `${LINE}\n❯ \n${LINE}\n  ? for shortcuts`

type Pane = { id: string; agent: string; session: string; status: string }

function state(panes: Pane[], agentStatus: string): Record<string, Record<string, unknown>> {
  return {
    'api snapshot': {
      result: {
        snapshot: {
          panes: panes.map(p => ({
            pane_id: p.id,
            agent: p.agent,
            agent_session: { value: p.session },
            agent_status: p.status,
            cwd: 'C:\\w\\case',
          })),
          tabs: [],
          workspaces: [],
        },
      },
    },
    // Every pane answers as the Claude one: what matters is that nothing asks it for the others.
    'agent get': { result: { agent: { agent: 'claude', agent_session: { value: 's1' }, agent_status: agentStatus } } },
    'agent read': { text: BOX },
    'agent send-keys': { result: { type: 'ok' } },
  }
}

test('Stop and Send now: from the board page only, Esc into a working Claude, nothing for the others', async () => {
  const box = await sandbox()
  const panes: Pane[] = [
    { id: 'p1', agent: 'claude', session: 's1', status: 'working' },
    { id: 'p2', agent: 'pi', session: 'pi-1', status: 'working' },
    { id: 'p3', agent: 'claude', session: 's3', status: 'idle' },
  ]
  box.state(state(panes, 'working'))
  const { url } = await serveBoard(box)
  for (const deadline = Date.now() + 8000; ; await Bun.sleep(20)) {
    const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: unknown[] }
    if (!board.stale && board.items.length === 3) break
    if (Date.now() > deadline) throw new Error('No board with the sessions')
  }
  const keysPressed = () => box.calls().filter(a => a[0] === 'agent' && a[1] === 'send-keys')
  const herdrFor = (pane: string) => box.calls().filter(a => a.includes(pane))
  const post = async (key: string, action: string, body: object = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}/api/session/${key}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; already?: boolean } }
  }

  // Not from another page.
  for (const action of ['stop', 'sendnow']) {
    const r = await post('s1', action, {}, { origin: 'http://evil.example' })
    assert.equal(r.status, 403, action)
  }
  assert.deepEqual(keysPressed(), [])

  // pi has no known key: refused before herdr is asked anything for its pane.
  const before = herdrFor('p2').length
  for (const action of ['stop', 'sendnow']) {
    const r = await post('pi-1', action)
    assert.equal(r.status, 409, action)
    assert.equal(r.body.ok, false)
  }
  assert.equal(herdrFor('p2').length, before)

  // Send now with nothing in the queue (no transcript here): nothing to send, nothing pressed.
  const none = await post('s1', 'sendnow', { text: 'also the logs' })
  assert.deepEqual([none.status, none.body.ok, none.body.already], [200, true, true])
  assert.deepEqual(keysPressed(), [])

  // Stop: Esc into p1; herdr then says the turn is over.
  const stop = post('s1', 'stop')
  await until(() => keysPressed().length > 0, 5000)
  box.state(state(panes, 'idle'))
  const stopped = await stop
  assert.deepEqual([stopped.status, stopped.body.ok], [200, true])
  assert.deepEqual(
    keysPressed().map(a => a.slice(2)),
    [['p1', 'esc']],
  )
}, 20_000)
