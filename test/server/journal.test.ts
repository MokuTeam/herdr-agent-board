// The away journal on the real server (#489): without config.json's `journal` the payload is as
// before and no file is made; with it, a pane's change between two refreshes is one move, the
// payload carries the strip's part and GET /api/journal the list.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateDir } from '../support/sleeper-fixtures.ts'

const sid = '1a8d7619-52ab-45bb-aa45-23e71df5a5cf'
const pane = (status: string, cwd: string) => ({
  pane_id: 'p1',
  agent: 'claude',
  agent_status: status,
  cwd,
  agent_session: { value: sid },
})
let cwd = ''
const snapshot = (status: string) => ({
  'api snapshot': { result: { snapshot: { panes: [pane(status, cwd)], tabs: [], workspaces: [] } } },
})

const board = async (url: string) => (await fetch(`${url}/api/board`)).json() as Promise<Record<string, unknown>>
/** Refreshes until the payload shows the pane in `status` (a refresh asked during one runs after it). */
async function showing(proc: Child, url: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000
  for (;;) {
    proc.send('refresh')
    const b = await board(url)
    const items = (b.items ?? []) as { status?: string }[]
    if (!b.stale && items.length === 1 && items[0]?.status === status) return b
    if (Date.now() > deadline) throw new Error(`no ${status} pane: ${JSON.stringify(items)}`)
    await Bun.sleep(50)
  }
}
const journalDb = (box: Sandbox) => join(stateDir(box), 'journal.db')

test('without the key: no journal in the payload, no route, no file after refreshes', async () => {
  const box = await sandbox()
  cwd = box.dir
  box.state(snapshot('working'))
  const { url, proc } = await serveBoard(box, {})
  await showing(proc, url, 'working')
  box.state(snapshot('done'))
  const payload = await showing(proc, url, 'done')
  expect('journal' in payload).toBe(false)
  expect((await fetch(`${url}/api/journal?since=0`)).status).toBe(404)
  expect(existsSync(journalDb(box))).toBe(false)
  proc.kill()
  await proc.exited
})

test('with the key: a change between refreshes is one move, in the list and the payload', async () => {
  const box = await sandbox()
  cwd = box.dir
  box.state(snapshot('working'))
  const { url, proc } = await serveBoard(box, { journal: true })
  expect((await showing(proc, url, 'working')).journal).toEqual({ strip: null, last: null })
  expect(existsSync(journalDb(box))).toBe(true)
  box.state(snapshot('done'))
  await showing(proc, url, 'done')
  const r = await fetch(`${url}/api/journal?since=0`)
  expect(r.status).toBe(200)
  const { journal } = (await r.json()) as { journal: { rows: { key: string; kind: string }[]; rest: unknown } }
  expect(journal.rows.map(x => x.kind)).toEqual(['done'])
  expect((await fetch(`${url}/api/journal?since=x`)).status).toBe(400)
  const dismiss = await fetch(`${url}/api/journal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'dismiss' }),
  })
  expect(await dismiss.json()).toEqual({ ok: true, dismissed: false })
  proc.kill()
  await proc.exited
})

/** Refreshes until the payload's items pass `ok`. */
async function shows(proc: Child, url: string, ok: (items: { key: string; status?: string }[]) => boolean) {
  const deadline = Date.now() + 10_000
  for (;;) {
    proc.send('refresh')
    const b = await board(url)
    const items = (b.items ?? []) as { key: string; status?: string }[]
    if (!b.stale && ok(items)) return b
    if (Date.now() > deadline) throw new Error(`not shown: ${JSON.stringify(items)}`)
    await Bun.sleep(50)
  }
}

test('a session seen as pane-<id> before herdr reports its session id is one row under the session', async () => {
  const box = await sandbox()
  cwd = box.dir
  const panes = (p: Record<string, unknown>[]) => ({
    'api snapshot': { result: { snapshot: { panes: p, tabs: [], workspaces: [] } } },
  })
  box.state(panes([]))
  const { url, proc } = await serveBoard(box, { journal: true })
  await shows(proc, url, items => items.length === 0)
  // herdr knows the agent before the hook has told it the session id
  // (here it even finishes a turn before that, so the old key has a row of its own to leave behind)
  box.state(panes([{ pane_id: 'p1', agent: 'claude', agent_status: 'done', cwd }]))
  await shows(proc, url, items => items[0]?.key === 'pane-p1' && items[0]?.status === 'done')
  box.state(panes([pane('working', cwd)]))
  await shows(proc, url, items => items[0]?.key === sid && items[0]?.status === 'working')
  const { journal } = (await (await fetch(`${url}/api/journal?since=0`)).json()) as {
    journal: { rows: { key: string; kind: string }[]; rest: { work: number; idle: number } }
  }
  expect(journal.rows.map(x => [x.key, x.kind])).toEqual([[sid, 'done']])
  expect(journal.rest).toEqual({ work: 0, idle: 0 })
  proc.kill()
  await proc.exited
})

test('an API error stop: listed as stopped on an error, and the flag stays off the payload and the detail', async () => {
  const box = await sandbox()
  cwd = box.dir
  box.state(snapshot('working'))
  const { url, proc } = await serveBoard(box, { journal: true })
  await showing(proc, url, 'working')
  const project = join(box.env.HOME as string, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const line = (o: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-11-21T08:00:00.000Z', cwd, ...o })
  writeFileSync(
    join(project, `${sid}.jsonl`),
    [
      line({ type: 'user', message: { role: 'user', content: 'go' } }),
      line({
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'API Error: 529 overloaded' }],
        },
      }),
    ].join('\n') + '\n',
  )
  box.state(snapshot('done'))
  const payload = await showing(proc, url, 'done')
  const { journal } = (await (await fetch(`${url}/api/journal?since=0`)).json()) as {
    journal: { rows: { kind: string; line: string }[] }
  }
  expect(journal.rows.map(r => [r.kind, r.line])).toEqual([['error', 'API Error: 529 overloaded']])
  expect((payload.items as Record<string, unknown>[]).some(i => 'apiError' in i)).toBe(false)
  const detail = (await (await fetch(`${url}/api/session/${sid}`)).json()) as { item: Record<string, unknown> }
  expect(detail.item.key).toBe(sid)
  expect('apiError' in detail.item).toBe(false)
  proc.kill()
  await proc.exited
})
