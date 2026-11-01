// A Claude session's context on its card after a /compact (#284): the board reads the transcript
// and what the status line last wrote, and after a compaction the status line has no count
// (Claude Code sends current_usage null until the next request).
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { digest } from '../../src/core/statusline.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Item = Record<string, unknown>
const COMPACTED = 'c0a1e5f2-0000-4000-8000-000000000001'
const REPLIED = 'c0a1e5f2-0000-4000-8000-000000000002'
const PLAIN = 'c0a1e5f2-0000-4000-8000-000000000003'
const BARE = 'c0a1e5f2-0000-4000-8000-000000000004'

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const reply = (text: string, cached: number) =>
  row({
    type: 'assistant',
    message: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: 300 },
      content: [{ type: 'text', text }],
    },
  })
const before = [row({ type: 'user', message: { content: 'review the branch' } }), reply('Reviewed.', 161466)]
const compaction = [
  row({
    type: 'system',
    subtype: 'compact_boundary',
    isSidechain: false,
    compactMetadata: { trigger: 'manual', preTokens: 161754, postTokens: 13853 },
  }),
  row({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } }),
  row({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }),
]
// What the status line hands the board's command, as Claude Code documents it.
const statusInput = (session: string, usage: Record<string, number> | null, pct: number | null) => ({
  session_id: session,
  model: { display_name: 'Opus 5.5' },
  context_window: { context_window_size: 1_000_000, used_percentage: pct, current_usage: usage },
})

describe('context after a compaction', () => {
  const sandbox = sharedSandbox()
  let url = ''
  const board = async (): Promise<Item[]> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items

  beforeAll(async () => {
    const box = await sandbox()
    const cwd = join(box.dir, 'Проект 100% x')
    mkdirSync(cwd, { recursive: true })
    const projects = join(box.dir, 'home', '.claude', 'projects', projectFolderName(cwd))
    mkdirSync(projects, { recursive: true })
    const transcript = (id: string, lines: string[]) =>
      writeFileSync(join(projects, `${id}.jsonl`), `${lines.join('\n')}\n`)
    transcript(COMPACTED, [...before, ...compaction])
    transcript(REPLIED, [
      ...before,
      ...compaction,
      row({ type: 'user', message: { content: 'go on' } }),
      reply('On it.', 49776),
    ])
    transcript(PLAIN, before)
    transcript(BARE, before)
    // The status line's file, written after the transcript as the status line runs after a reply
    // or a compaction, the way entrypoints/statusline.ts writes it.
    const contexts = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'context')
    mkdirSync(contexts, { recursive: true })
    const statusLine = (input: unknown) => {
      const d = digest(input)
      writeFileSync(join(contexts, `${d.session}.json`), JSON.stringify({ ...(d.context ?? {}), model: d.model }))
    }
    statusLine(statusInput(COMPACTED, null, null))
    statusLine(
      statusInput(REPLIED, { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 49776 }, 5),
    )
    statusLine(
      statusInput(PLAIN, { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 161466 }, 16),
    )
    const pane = (pane_id: string, session: string) => ({
      pane_id,
      agent: 'claude',
      agent_status: 'idle',
      cwd,
      agent_session: { value: session },
    })
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [pane('p1', COMPACTED), pane('p2', REPLIED), pane('p3', PLAIN), pane('p4', BARE)],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    ;({ url } = await serveBoard(box, { language: 'en' }))
    const deadline = Date.now() + 5000
    while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  test('compacted with no request since: what the compaction left, not the size before it', async () => {
    expect((await board()).find(i => i.key === COMPACTED)).toMatchObject({
      context: 13853,
      contextPct: null,
      lastText: 'Reviewed.',
    })
  })

  test('compacted and replied since, or never compacted: the same numbers as before', async () => {
    const items = await board()
    expect(items.find(i => i.key === REPLIED)).toMatchObject({ context: 49778, contextPct: 5 })
    expect(items.find(i => i.key === PLAIN)).toMatchObject({ context: 161468, contextPct: 16 })
    // No status line (another setup, or not installed): the transcript alone.
    expect(items.find(i => i.key === BARE)).toMatchObject({ context: 161468, contextPct: null })
  })
})
