// pi sessions on the web board: herdr reports a pi pane's session by its file, and the board reads
// that file for the card (pi's words, its question, its last tool) and for the session's sheet.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Item = Record<string, unknown>
const T0 = Date.parse('2026-10-20T08:00:00.000Z')
const lines = (...entries: Record<string, unknown>[]) => {
  let parent: string | null = null
  const out = [JSON.stringify({ type: 'session', version: 3, id: '01a1', timestamp: '', cwd: '/w' })]
  for (const [i, e] of entries.entries()) {
    const id = `e${i}`
    out.push(JSON.stringify({ type: 'message', id, parentId: parent, timestamp: '', message: e }))
    parent = id
  }
  return `${out.join('\n')}\n`
}

describe('pi sessions', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let piFile = ''
  let freshFile = ''
  const board = async (): Promise<Item[]> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items

  beforeAll(async () => {
    const box = await sandbox()
    const sessions = join(box.dir, 'home', '.pi', 'agent', 'sessions', '--w--')
    mkdirSync(sessions, { recursive: true })
    piFile = join(sessions, '2026-10-20T05-10-02-695Z_01a1.jsonl')
    // pi writes the file once the session has something in it: herdr reports it before that.
    freshFile = join(sessions, '2026-10-20T06-00-00-000Z_01a2.jsonl')
    writeFileSync(
      piFile,
      lines(
        { role: 'user', content: [{ type: 'text', text: 'fix the build' }], timestamp: T0 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'bun test' } }],
          usage: { input: 2, cacheRead: 1000, cacheWrite: 8 },
          timestamp: T0 + 1000,
        },
        { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Fixed it. Shall I push?' }],
          usage: { input: 3, cacheRead: 2000, cacheWrite: 10 },
          timestamp: T0 + 2000,
        },
      ),
    )
    const snapshot = {
      panes: [
        { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir },
        { pane_id: 'p2', agent: 'pi', agent_session: { value: piFile }, agent_status: 'idle', cwd: box.dir },
        { pane_id: 'p3', agent: 'pi', agent_session: { value: freshFile }, agent_status: 'idle', cwd: box.dir },
        { pane_id: 'p4', agent: 'pi', agent_status: 'idle', cwd: box.dir, terminal_title_stripped: 'π - w' },
      ],
      tabs: [],
      workspaces: [],
    }
    box.state({ 'api snapshot': { result: { snapshot } } })
    ;({ url } = await serveBoard(box, { language: 'en' }))
    const deadline = Date.now() + 5000
    while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  test("a pi card says what pi's file says: the prompt, the question it ends with, the last tool, the context", async () => {
    const pi = (await board()).find(i => i.key === piFile)
    expect(pi).toMatchObject({
      agent: 'pi',
      prompt: 'fix the build',
      lastText: 'Fixed it. Shall I push?',
      question: 'Fixed it. Shall I push?',
      attention: 'question',
      column: 'me',
      tool: { name: 'bash', detail: 'bun test', pending: false },
      context: 2013,
    })
    expect(Number(pi?.activity)).toBeGreaterThan(0)
  })

  test('a pi session whose file is not there yet, or that herdr reports no file for, is a bare card', async () => {
    const items = await board()
    for (const key of [freshFile, 'pane-p4'])
      expect(items.find(i => i.key === key)).toMatchObject({ prompt: '', lastText: '', tool: null, column: 'idle' })
    expect(items.find(i => i.key === 'pane-p4')?.name).toBe('π - w')
  })

  test("a pi session's sheet: its turns from its file", async () => {
    const res = await fetch(`${url}/api/session/${encodeURIComponent(piFile)}`)
    expect(res.status).toBe(200)
    const detail = (await res.json()) as { conversation: Item[]; queued: unknown[] }
    expect(detail.conversation.map(t => [t.role, t.text ?? t.detail])).toEqual([
      ['user', 'fix the build'],
      ['tool', 'bun test'],
      ['assistant', 'Fixed it. Shall I push?'],
    ])
    expect(detail.queued).toEqual([])
    const fresh = (await (await fetch(`${url}/api/session/${encodeURIComponent(freshFile)}`)).json()) as Item
    expect(fresh.conversation).toEqual([])
  })

  test('a Claude pane beside them is read as before: from its own transcript, none here', async () => {
    const claude = (await board()).find(i => i.key === 's1')
    expect(claude).toMatchObject({ agent: 'claude', prompt: '', lastText: '', tool: null, column: 'idle' })
  })
})
