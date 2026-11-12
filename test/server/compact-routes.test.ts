// Auto-compact on the web board (#378): the payload's default and each session's view, the sheet's
// writes to the card, Settings' default, and the compaction's line in the conversation, marked as
// the board's when its auto-compact made it. A session with nothing set gets no field at all.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

type Item = Record<string, unknown> & { key: string; compact?: Record<string, unknown> }
const OWN = 'c0a1e5f2-0000-4000-8000-0000000000d1'
const PLAIN = 'c0a1e5f2-0000-4000-8000-0000000000d2'
const PI = 'pane-p3'
const DONE = Date.UTC(2026, 10, 12, 9, 30)

describe('auto-compact on the web board', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Sandbox
  const post = (path: string, body: unknown) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
  const answer = async (res: Response | Promise<Response>) => {
    const r = await res
    return [r.status, await r.json()]
  }
  const board = async () => (await (await fetch(`${url}/api/board`)).json()) as { items: Item[]; compactDefault?: string }
  const item = async (key: string) => (await board()).items.find(i => i.key === key)
  /** The session's item once the board shows what `ok` asks for (a card write redraws it a moment later). */
  const itemOnce = async (key: string, ok: (it: Item | undefined) => boolean) => {
    const deadline = Date.now() + 5000
    for (;;) {
      const it = await item(key)
      if (ok(it) || Date.now() > deadline) return it
      await Bun.sleep(20)
    }
  }
  const card = (key: string) => JSON.parse(readFileSync(join(box.cards, `${key}.json`), 'utf8'))

  beforeAll(async () => {
    box = await sandbox()
    const cwd = join(box.dir, 'Проект 100% x')
    mkdirSync(cwd, { recursive: true })
    const projects = join(box.dir, 'home', '.claude', 'projects', projectFolderName(cwd))
    mkdirSync(projects, { recursive: true })
    const row = (o: Record<string, unknown>) => JSON.stringify(o)
    writeFileSync(
      join(projects, `${OWN}.jsonl`),
      `${[
        row({ type: 'user', message: { content: 'watch the queue' }, timestamp: new Date(DONE - 60_000).toISOString() }),
        row({
          type: 'system',
          subtype: 'compact_boundary',
          isSidechain: false,
          timestamp: new Date(DONE).toISOString(),
          compactMetadata: { trigger: 'manual', preTokens: 612_000, postTokens: 48_000 },
        }),
        row({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } }),
      ].join('\n')}\n`,
    )
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(
      join(box.cards, `${OWN}.json`),
      JSON.stringify({
        key: OWN,
        compactRun: { state: 'done', at: DONE - 30_000, from: 612_000, to: 48_000, limit: 300_000, setting: '300k', doneAt: DONE },
      }),
    )
    const contexts = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'context')
    mkdirSync(contexts, { recursive: true })
    for (const s of [OWN, PLAIN])
      writeFileSync(join(contexts, `${s}.json`), JSON.stringify({ at: Date.now(), tokens: 48_000, size: 1_000_000 }))
    const pane = (pane_id: string, session: string | null, agent = 'claude') => ({
      pane_id,
      agent,
      agent_status: 'idle',
      cwd,
      ...(session && { agent_session: { value: session } }),
    })
    box.state({
      'api snapshot': {
        result: {
          snapshot: { panes: [pane('p1', OWN), pane('p2', PLAIN), pane('p3', null, 'pi')], tabs: [], workspaces: [] },
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

  test('no default: the payload says off; a session with nothing set has no field, one with a run shows it', async () => {
    const b = await board()
    expect(b.compactDefault).toBe('')
    expect(b.items.find(i => i.key === PLAIN)).not.toHaveProperty('compact')
    expect(b.items.find(i => i.key === PI)).not.toHaveProperty('compact')
    expect(b.items.find(i => i.key === OWN)?.compact).toEqual({
      own: '',
      note: '',
      limit: '',
      source: 'off',
      tokens: null,
      run: { state: 'done', at: DONE - 30_000, from: 612_000, to: 48_000, limit: 300_000, setting: '300k', doneAt: DONE },
    })
  })

  test("the sheet sets a session's own limit and instructions on its card; what is no limit is refused", async () => {
    expect(await answer(post(`/api/session/${PLAIN}/card`, { compactAt: '300K', compactNote: 'keep the plan\n' }))).toEqual(
      [200, { ok: true }],
    )
    expect(card(PLAIN)).toMatchObject({ compactAt: '300k', compactNote: 'keep the plan' })
    expect((await itemOnce(PLAIN, it => !!it?.compact))?.compact).toEqual({
      own: '300k',
      note: 'keep the plan',
      limit: '300k',
      source: 'session',
      tokens: 300_000,
      run: null,
    })
    expect(await answer(post(`/api/session/${PLAIN}/card`, { compactAt: 'soon' }))).toEqual([
      409,
      {
        ok: false,
        error: '"soon" is no limit: tokens (300k, 1.2m, at least 10k), a share of the window (5% to 95%) or never',
      },
    ])
    expect(card(PLAIN).compactAt).toBe('300k')
    // Emptied: the default applies again (none here), the instructions stay until emptied too.
    expect(await answer(post(`/api/session/${PLAIN}/card`, { compactAt: '' }))).toEqual([200, { ok: true }])
    expect(card(PLAIN).compactAt).toBeUndefined()
    expect(await answer(post(`/api/session/${PLAIN}/card`, { compactNote: '' }))).toEqual([200, { ok: true }])
    expect(card(PLAIN).compactNote).toBeUndefined()
    expect(await itemOnce(PLAIN, it => !it?.compact)).not.toHaveProperty('compact')
  })

  test("Settings takes a default limit or off; never is a session's own only", async () => {
    expect(await answer(post('/api/settings', { compactAt: '60%' }))).toEqual([200, { ok: true }])
    expect(await answer(post('/api/settings', { compactAt: 'never' }))).toEqual([
      409,
      expect.objectContaining({ ok: false }),
    ])
    expect(await answer(post('/api/settings', { compactAt: '' }))).toEqual([200, { ok: true }])
  })

  test("the conversation shows the compaction, as the board's when its auto-compact made it", async () => {
    const detail = (await (await fetch(`${url}/api/session/${OWN}`)).json()) as {
      conversation: Record<string, unknown>[]
    }
    expect(detail.conversation.filter(m => m.role === 'notice')).toEqual([
      expect.objectContaining({ kind: 'compact', trigger: 'manual', pre: 612_000, post: 48_000, by: 'board', at: DONE }),
    ])
  })
})
