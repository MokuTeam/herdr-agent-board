// A message from the page to a session herdr says waits in a dialog its screen does not show
// (#164): the route looks at the screen and says so with code 'stale'; "Send anyway" (anyway: true)
// types it with pane send-text instead of agent prompt, which herdr refuses for a blocked pane.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

type Board = { items: { key?: string }[] }
const rule = '─'.repeat(40)
const prompt = [rule, '❯ ', rule, '  ? for shortcuts'].join('\n')

describe('a page message to a session herdr calls blocked', () => {
  let box: Sandbox
  let base = ''
  let key = ''
  const cleanups: (() => void | Promise<void>)[] = []
  const agent = { agent: 'claude', agent_status: 'blocked', agent_session: { value: 'sess-anna' } }

  beforeAll(async () => {
    box = await sandbox({ after: fn => void cleanups.push(fn) })
    box.state({
      'api snapshot': {
        result: { snapshot: { panes: [{ pane_id: 'p', ...agent }], tabs: [], workspaces: [] } },
      },
      'agent get': { result: { agent } },
      'agent read': { text: prompt },
      'pane send-text': { result: {} },
      'agent send-keys': { result: {} },
      'agent prompt': { error: 'agent_blocked' },
    })
    base = (await serveBoard(box)).url
    for (let i = 0; i < 250; i++) {
      const board = (await (await fetch(`${base}/api/board`)).json()) as Board
      key = board.items[0]?.key ?? ''
      if (key) return
      await new Promise(r => setTimeout(r, 20))
    }
    throw Error('No fixture board')
  })
  afterAll(async () => {
    for (const fn of cleanups) await fn()
  })

  const typing = () => box.calls().filter(a => a[0] === 'pane' || a[1] === 'send-keys' || a[1] === 'prompt')
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/session/${encodeURIComponent(key)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ text: 'hi', session: 'sess-anna', requestId: 'r1', ...body }),
    })
    return (await r.json()) as Record<string, unknown>
  }

  test('the route looks at the screen; anyway types with send-text, Enter only once the box shows it', async () => {
    expect(await post({})).toMatchObject({ ok: false, dialog: true, code: 'stale' })
    expect(typing()).toEqual([])
    // The box here never shows the text: typed, no Enter.
    expect(await post({ anyway: true })).toMatchObject({ ok: false })
    expect(typing()).toEqual([['pane', 'send-text', 'p', 'hi']])
  }, 30_000)
})
