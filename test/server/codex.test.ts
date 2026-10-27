import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Item = Record<string, unknown>
type Detail = { conversation: Item[]; queued: unknown[]; helpers: unknown[] }
const ID = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
const MISSING = '01a15a8a-bd97-7701-a7f7-401e4bec3148'
const CLAUDE = '030bc85e-c173-4999-b250-c85a4d5595bd'
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-20T08:00:00Z', type, payload })
const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: 'input_text', text }] })

describe('Codex rollouts on the board, beside Claude, pi and unknown agents', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Awaited<ReturnType<typeof sandbox>>
  let piFile = ''
  const board = async (): Promise<Item[]> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items
  const detail = async (key: string): Promise<Detail> =>
    (await (await fetch(`${url}/api/session/${encodeURIComponent(key)}`)).json()) as Detail

  beforeAll(async () => {
    box = await sandbox()
    const codex = join(box.dir, 'Codex дом 100%', 'sessions', '2026', '10', '20')
    mkdirSync(codex, { recursive: true })
    writeFileSync(
      join(codex, `rollout-2026-10-20T08-00-00-${ID}.jsonl`),
      [
        row('session_meta', { id: ID, cwd: 'C:\\Work\\Проект 100%' }),
        row('response_item', message('user', '<environment_context>injected</environment_context>')),
        row('response_item', message('user', 'fix the Codex build')),
        row('event_msg', { type: 'user_message', message: 'fix the Codex build' }),
        row('response_item', {
          type: 'function_call',
          name: 'exec_command',
          call_id: 't1',
          arguments: '{"cmd":"bun test"}',
        }),
        row('response_item', { type: 'function_call_output', call_id: 't1', output: 'ok' }),
        row('response_item', message('assistant', 'Fixed it. Shall I push?')),
      ].join('\n'),
    )
    // A same-id rollout for Claude must never supply Claude's card.
    writeFileSync(
      join(codex, `rollout-2026-10-20T08-00-00-${CLAUDE}.jsonl`),
      row('response_item', message('assistant', 'wrong agent')),
    )
    const projects = join(box.dir, 'home', '.claude', 'projects', 'fixture')
    mkdirSync(projects, { recursive: true })
    for (const id of [CLAUDE, MISSING])
      writeFileSync(
        join(projects, `${id}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Claude answer' }] },
        }),
      )
    piFile = join(box.dir, 'pi session 100%.jsonl')
    writeFileSync(
      piFile,
      JSON.stringify({
        type: 'message',
        id: 'p1',
        parentId: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'pi answer' }],
        },
      }),
    )
    const pane = (pane_id: string, agent: string, session?: string) => ({
      pane_id,
      agent,
      agent_status: 'idle',
      cwd: projects,
      label: `Session ${pane_id}`,
      ...(session && { agent_session: { value: session } }),
    })
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              pane('c1', 'codex', ID),
              pane('c2', 'codex', MISSING),
              pane('c3', 'codex'),
              pane('c4', 'claude', CLAUDE),
              pane('c5', 'pi', piFile),
              pane('c6', 'agy'),
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    ;({ url } = await serveBoard(box, { language: 'en' }, { CODEX_HOME: join(box.dir, 'Codex дом 100%') }))
    const deadline = Date.now() + 5000
    while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  test('Codex card and panel read the rollout by id from CODEX_HOME', async () => {
    expect((await board()).find(i => i.key === ID)).toMatchObject({
      agent: 'codex',
      prompt: 'fix the Codex build',
      lastText: 'Fixed it. Shall I push?',
      question: 'Fixed it. Shall I push?',
      column: 'me',
      attention: 'question',
      tool: { name: 'exec_command', pending: false },
    })
    const thread = await detail(ID)
    expect(thread.conversation.map(t => [t.role, t.text ?? t.detail])).toEqual([
      ['user', 'fix the Codex build'],
      ['tool', 'bun test'],
      ['assistant', 'Fixed it. Shall I push?'],
    ])
    expect(thread.queued).toEqual([])
    expect(thread.helpers).toEqual([])
  })

  test('missing Codex rollout, pane keys and unknown agents stay bare, never read Claude records', async () => {
    for (const key of [MISSING, 'pane-c3', 'pane-c6']) {
      expect((await board()).find(i => i.key === key)).toMatchObject({
        prompt: '',
        lastText: '',
        tool: null,
        column: 'idle',
      })
      expect((await detail(key)).conversation).toEqual([])
    }
  })

  test("the session meter reads only Claude's pane: Codex, pi and unknown agents answer empty", async () => {
    const keyOf = async (pane: string) => String((await board()).find(i => i.pane === pane)?.key ?? '')
    const reads = () =>
      box
        .calls()
        .filter(a => a[0] === 'agent' && a[1] === 'read')
        .map(a => a[2])
    const before = reads().length
    for (const pane of ['c1', 'c5', 'c6']) {
      const r = await fetch(`${url}/api/session/${encodeURIComponent(await keyOf(pane))}/meter`)
      expect([pane, r.status, await r.json()]).toEqual([pane, 200, { effort: '', model: '' }])
    }
    expect(reads().slice(before)).toEqual([])
    expect((await fetch(`${url}/api/session/${encodeURIComponent(await keyOf('c4'))}/meter`)).status).toBe(200)
    expect(reads().slice(before)).toEqual(['c4'])
  })

  test('Claude UUID and pi file keys keep their own readers, including spaces, Cyrillic and percent paths', async () => {
    const items = await board()
    expect(items.find(i => i.key === CLAUDE)).toMatchObject({ agent: 'claude', lastText: 'Claude answer' })
    expect((await detail(CLAUDE)).conversation.at(-1)).toMatchObject({ role: 'assistant', text: 'Claude answer' })
    expect(items.find(i => i.key === piFile)).toMatchObject({ agent: 'pi', lastText: 'pi answer' })
    expect((await detail(piFile)).conversation.at(-1)).toMatchObject({ role: 'assistant', text: 'pi answer' })
  })
})
