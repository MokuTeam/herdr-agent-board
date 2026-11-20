// A Claude session's context and effort on its card (#193): the status line's file says the live
// effort (a session-only /effort too) and wins over the transcript's, a run that reports none
// clears it, and setups without that file (an older board's file, a status line of the user's own)
// read the transcript and settings as before.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { digest } from '../../src/core/statusline.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Item = Record<string, unknown>
const LIVE = 'e0a1e5f2-0000-4000-8000-000000000001'
const GONE = 'e0a1e5f2-0000-4000-8000-000000000002'
const OLD = 'e0a1e5f2-0000-4000-8000-000000000003'
const ZERO = 'e0a1e5f2-0000-4000-8000-000000000004'
const NONE = 'e0a1e5f2-0000-4000-8000-000000000005'
const COMPACTED = 'e0a1e5f2-0000-4000-8000-000000000006'
const CODEX = 'e0a1e5f2-0000-4000-8000-000000000007'

const row = (o: Record<string, unknown>) => JSON.stringify(o)
/** A finished turn, sent with `effort`, as Claude Code writes it on the transcript's line. */
const turn = (effort: string, cached: number) => [
  row({ type: 'user', message: { content: 'review the branch' } }),
  row({
    type: 'assistant',
    effort,
    message: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: 300 },
      content: [{ type: 'text', text: 'Reviewed.' }],
    },
  }),
]
const usage = (cached: number) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached })
// What the status line hands the board's command, as Claude Code 2.1 sends it.
const statusInput = (session: string, extra: Record<string, unknown>) => ({
  session_id: session,
  model: { display_name: 'Opus 5.5' },
  ...extra,
})

describe('context and effort on the card', () => {
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
    for (const id of [LIVE, GONE, OLD, ZERO]) transcript(id, turn('high', 85_000))
    transcript(NONE, turn('low', 85_000))
    transcript(COMPACTED, [
      ...turn('high', 161_466),
      row({
        type: 'system',
        subtype: 'compact_boundary',
        isSidechain: false,
        compactMetadata: { trigger: 'auto', preTokens: 161_754, postTokens: 13_853 },
      }),
    ])
    const contexts = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'context')
    mkdirSync(contexts, { recursive: true })
    // The status line's file, after the transcript, the way entrypoints/statusline.ts writes it.
    const statusLine = (input: unknown) => {
      const d = digest(input)
      writeFileSync(
        join(contexts, `${d.session}.json`),
        JSON.stringify({ ...(d.context ?? {}), model: d.model, effort: d.effort }),
      )
    }
    const window = (cached: number, pct: number) => ({
      context_window: { context_window_size: 200_000, used_percentage: pct, current_usage: usage(cached) },
    })
    // The turn went at high; a session-only /effort max since, which the transcript does not have.
    statusLine(statusInput(LIVE, { ...window(85_000, 43), effort: { level: 'max' } }))
    // A model without effort since: no count and no effort in the last run.
    statusLine(statusInput(GONE, { context_window: { current_usage: null } }))
    // Compacted: Claude Code sends no count until the next request, the effort all the same.
    statusLine(statusInput(COMPACTED, { context_window: { current_usage: null }, effort: { level: 'high' } }))
    // A file named like a Codex session's: the board never reads one for Codex.
    statusLine(statusInput(CODEX, { ...window(85_000, 43), effort: { level: 'max' } }))
    statusLine(statusInput(ZERO, { ...window(0, 0), effort: { level: 'low' } }))
    // A file an older board wrote: no effort key at all.
    const old = digest(statusInput(OLD, window(85_000, 43))).context
    writeFileSync(join(contexts, `${OLD}.json`), JSON.stringify({ ...old, model: 'Opus 5.5' }))
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
            panes: [
              pane('p1', LIVE),
              pane('p2', GONE),
              pane('p3', OLD),
              pane('p4', ZERO),
              pane('p5', NONE),
              pane('p6', COMPACTED),
              { ...pane('p7', CODEX), agent: 'codex' },
            ],
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

  test('the status line’s effort is the live one: a /effort since the last turn shows', async () => {
    expect((await board()).find(i => i.key === LIVE)).toMatchObject({
      context: 85_000,
      contextPct: 43,
      contextSize: 200_000,
      effort: 'max',
      effortLive: true,
    })
  })

  test('a run that reports no effort clears it, also with no context in that run', async () => {
    const it = (await board()).find(i => i.key === GONE)
    expect(it).toMatchObject({ effort: null, contextPct: null, model: 'Opus 5.5' })
    expect(it?.effortLive).toBeUndefined()
    expect(it?.context).toBe(85_002) // the transcript's count, as before
  })

  test('compacted: what the compaction left, no window or percentage, the effort the status line said', async () => {
    const it = (await board()).find(i => i.key === COMPACTED)
    expect(it).toMatchObject({ context: 13_853, contextPct: null, contextSize: null, effort: 'high', effortLive: true })
  })

  test('a Codex session reads no status line file, as before', async () => {
    const it = (await board()).find(i => i.key === CODEX)
    expect(it).toBeDefined()
    expect(it?.effort).not.toBe('max')
    expect(it?.effortLive).toBeUndefined()
    expect(it?.contextPct ?? null).toBeNull()
  })

  test('a zero it counted stays a zero', async () => {
    expect((await board()).find(i => i.key === ZERO)).toMatchObject({ context: 0, contextPct: 0, effort: 'low' })
  })

  test('no effort in the file (an older board) or no file (a status line of their own): the transcript’s, as before', async () => {
    const items = await board()
    const old = items.find(i => i.key === OLD)
    const none = items.find(i => i.key === NONE)
    expect(old).toMatchObject({ effort: 'high', contextPct: 43 })
    expect(none).toMatchObject({ effort: 'low', context: 85_002, contextPct: null })
    // Not the status line's: the card leaves it out (web/src/models/card.ts cardMeter).
    expect([old?.effortLive, none?.effortLive]).toEqual([undefined, undefined])
  })
})
