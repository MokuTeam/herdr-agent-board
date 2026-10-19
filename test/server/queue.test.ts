// The session's detail carries its queue: the user's messages its running Claude has not taken
// in yet (upstream's test/queue.test.mjs at b5a96b8, its HTTP part), read against the registry
// of the session's own profile.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSessionDetail, type SessionDetail } from '../../web/src/api/client.ts'
import { serveBoard } from '../support/board-server.ts'
import { busy, jsonl, q, T0 } from '../support/queue-fixtures.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

const LINES = jsonl([...busy, q(10, 'enqueue', 'also the logs')])

/** A Claude folder of the sandbox's home with these sessions' transcripts and registry files. */
function claudeHome(box: Sandbox, folder: string, sessions: Record<string, Record<string, unknown> | null>): string {
  const claude = join(box.env.HOME ?? '', folder)
  const project = join(claude, 'projects', 'C--w-case')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  for (const [id, registry] of Object.entries(sessions)) {
    writeFileSync(join(project, `${id}.jsonl`), LINES)
    // A registry file names this test's own process, which is alive.
    if (registry)
      writeFileSync(
        join(claude, 'sessions', `${id}.json`),
        JSON.stringify({ pid: process.pid, sessionId: id, kind: 'interactive', startedAt: T0, ...registry }),
      )
  }
  return claude
}

/** The board over these sessions' panes; resolves once it has them all, with a reader of their details. */
async function boardOf(box: Sandbox, ids: string[], cfg: Record<string, unknown> = {}) {
  const panes = ids.map((id, i) => ({
    pane_id: `p${i}`,
    agent: 'claude',
    agent_session: { value: id },
    agent_status: 'working',
    cwd: 'C:\\w\\case',
  }))
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const { url } = await serveBoard(box, cfg)
  for (const deadline = Date.now() + 8000; ; ) {
    const board = (await (await fetch(`${url}/api/board`)).json()) as { items: unknown[] }
    if (board.items.length >= ids.length) break
    if (Date.now() > deadline) throw new Error('No board with the sessions')
    await Bun.sleep(20)
  }
  return async (key: string): Promise<SessionDetail> => {
    const detail: unknown = await (
      await fetch(`${url}/api/session/${key}`, { signal: AbortSignal.timeout(5000) })
    ).json()
    // What the page checks the detail with takes it.
    if (!isSessionDetail(detail)) throw new Error(`not a session's detail: ${JSON.stringify(detail)}`)
    return detail
  }
}

test("the sheet's data carries the queue of a running Claude only", async () => {
  const box = await sandbox()
  // s1 works; s2 said it was idle after the message came (the queue is gone with it); s3 has no Claude process.
  claudeHome(box, '.claude', {
    s1: { status: 'busy', statusUpdatedAt: T0 },
    s2: { status: 'idle', statusUpdatedAt: T0 + 30_000 },
    s3: null,
  })
  const detail = await boardOf(box, ['s1', 's2', 's3'])
  const s1 = await detail('s1')
  assert.deepEqual(s1.queued, [{ text: 'also the logs', at: T0 + 10_000 }])
  // Upstream's order of the detail's keys.
  assert.deepEqual(Object.keys(s1), [
    'item',
    'conversation',
    'queued',
    'helpers',
    'workflows',
    'screen',
    'dialog',
    'checkout',
  ])
  assert.deepEqual((await detail('s2')).queued, [])
  assert.deepEqual((await detail('s3')).queued, [])
})

test('a session of another profile is read against its own registry, not the board’s ~/.claude', async () => {
  const box = await sandbox()
  claudeHome(box, '.claude', {})
  // Both run in the work profile only: s4 works, s5 said it was idle after the message came.
  const work = claudeHome(box, '.claude-work', {
    s4: { status: 'busy', statusUpdatedAt: T0 },
    s5: { status: 'shell', statusUpdatedAt: T0 + 30_000 },
  })
  writeFileSync(join(work, 'settings.json'), '{}')
  const home = box.env.HOME ?? ''
  const detail = await boardOf(box, ['s4', 's5'], {
    language: 'en',
    profiles: [
      { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
      { id: 'work', title: 'Work', dir: work, color: 'teal', hidden: false },
    ],
  })
  assert.deepEqual((await detail('s4')).queued, [{ text: 'also the logs', at: T0 + 10_000 }])
  assert.deepEqual((await detail('s5')).queued, [])
})
