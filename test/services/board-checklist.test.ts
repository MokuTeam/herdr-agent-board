import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Item } from '../../src/core/types.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

const S_CLAUDE = '11111111-1111-4111-8111-111111111111'
const S_DONE = '22222222-2222-4222-8222-222222222222'
const S_FORK = '33333333-3333-4333-8333-333333333333'
const S_PI = '/home/anna/.pi/agent/sessions/--home-anna--/2026-11-24_atlas 50%.jsonl'
const S_CODEX = '44444444-4444-4444-8444-444444444444'
const S_AGY = '55555555-5555-4555-8555-555555555555'

function writeClaudeTranscript(
  box: Sandbox,
  sessionId: string,
  cwd: string,
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[],
  ts: string,
): void {
  const dir = join(box.env.HOME as string, '.claude', 'projects', projectFolderName(cwd))
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: `Title for ${sessionId.slice(0, 4)}` }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'Work on checklist' }),
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: ts,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tw1', content: 'ok' }] },
    }),
  ]
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
}

describe('board checklist integration (#637)', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let items: Item[] = []

  beforeAll(async () => {
    const box = await sandbox()
    const cwd = join(box.dir, 'atlas work')
    const winCwd = 'C:\\Users\\anna\\work repo 50%'
    mkdirSync(cwd, { recursive: true })

    writeClaudeTranscript(
      box,
      S_CLAUDE,
      cwd,
      [
        { content: 'Read schema', status: 'completed' },
        { content: 'Parse checklist', status: 'in_progress', activeForm: 'Parsing checklist' },
        { content: 'Write tests', status: 'pending' },
      ],
      '2026-11-24T07:00:00.000Z',
    )

    writeClaudeTranscript(
      box,
      S_DONE,
      cwd,
      [
        { content: 'Step 1', status: 'completed' },
        { content: 'Step 2', status: 'completed' },
      ],
      '2026-11-24T07:00:00.000Z',
    )

    // Forked session whose transcript has an old TodoWrite from before card.forkAt.
    writeClaudeTranscript(
      box,
      S_FORK,
      cwd,
      [{ content: 'Parent step', status: 'in_progress' }],
      '2026-11-24T06:00:00.000Z',
    )
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(
      join(box.cards, `${S_FORK}.json`),
      JSON.stringify({ key: S_FORK, forkOf: S_CLAUDE, forkAt: Date.parse('2026-11-24T06:30:00.000Z') }),
    )

    // Non-Claude sessions (pi, codex, agy) and pane-only sessions must never receive TodoWrite checklists.
    const snapshot = {
      workspaces: [{ workspace_id: 'w1', label: 'Atlas 50%' }],
      tabs: [],
      panes: [
        {
          pane_id: 'p1',
          workspace_id: 'w1',
          agent: 'claude',
          agent_session: { value: S_CLAUDE },
          agent_status: 'working',
          cwd,
        },
        {
          pane_id: 'p2',
          workspace_id: 'w1',
          agent: 'claude',
          agent_session: { value: S_DONE },
          agent_status: 'working',
          cwd,
        },
        {
          pane_id: 'p3',
          workspace_id: 'w1',
          agent: 'claude',
          agent_session: { value: S_FORK },
          agent_status: 'working',
          cwd,
        },
        {
          pane_id: 'p4',
          workspace_id: 'w1',
          agent: 'claude',
          agent_status: 'idle',
          cwd: winCwd,
          terminal_title_stripped: 'Анна 50% pane',
        },
        {
          pane_id: 'p5',
          workspace_id: 'w1',
          agent: 'pi',
          agent_session: { value: S_PI },
          agent_status: 'working',
          cwd: winCwd,
          terminal_title_stripped: 'Ben pi',
        },
        {
          pane_id: 'p6',
          workspace_id: 'w1',
          agent: 'codex',
          agent_session: { value: S_CODEX },
          agent_status: 'working',
          cwd,
          terminal_title_stripped: 'Cleo codex',
        },
        {
          pane_id: 'p7',
          workspace_id: 'w1',
          agent: 'agy',
          agent_session: { value: S_AGY },
          agent_status: 'working',
          cwd,
          terminal_title_stripped: 'Atlas agy',
        },
      ],
    }
    box.state({ 'api snapshot': { result: { snapshot } } })
    ;({ url } = await serveBoard(box, { language: 'en' }))

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const res = await fetch(`${url}/api/board`)
      const body = (await res.json()) as { stale: boolean; items: Item[] }
      if (!body.stale) {
        items = body.items
        break
      }
      await Bun.sleep(20)
    }
  }, 20_000)

  test('attaches active TodoWrite checklist to Claude session and detail response', async () => {
    const it = items.find(i => i.key === S_CLAUDE)
    expect(it?.checklist).toEqual({
      done: 1,
      total: 3,
      current: 'Parsing checklist',
      items: [
        { content: 'Read schema', status: 'completed' },
        { content: 'Parse checklist', status: 'in_progress', activeForm: 'Parsing checklist' },
        { content: 'Write tests', status: 'pending' },
      ],
      at: Date.parse('2026-11-24T07:00:00.000Z'),
    })
    const detail = (await (await fetch(`${url}/api/session/${S_CLAUDE}`)).json()) as { item: Item }
    expect(detail.item.checklist).toEqual(it?.checklist)
  })

  test('hides checklist when all items are done or copied before forkAt', () => {
    const done = items.find(i => i.key === S_DONE)
    const fork = items.find(i => i.key === S_FORK)
    expect(done?.checklist).toBeUndefined()
    expect(fork?.checklist).toBeUndefined()
  })

  test('leaves other agents and setups unchanged without checklist', () => {
    for (const key of ['pane-p4', S_PI, S_CODEX, S_AGY]) {
      const it = items.find(i => i.key === key)
      expect(it).toBeDefined()
      expect(it?.checklist).toBeUndefined()
      expect('checklist' in (it as object)).toBe(false)
    }
    const paneItem = items.find(i => i.key === 'pane-p4')
    expect(paneItem?.name).toBe('Анна 50% pane')
    expect(paneItem?.cwd).toBe('C:\\Users\\anna\\work repo 50%')
  })
})
