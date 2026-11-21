// Verified done (#492) against the fake herdr: the board's scheduler finds a held done and starts its
// verifier as a fork is started (services/launch, the board's spawn-agent), in the worker's folder,
// lane and workspace, on the configured model, under a Claude session id the board chose and wrote
// into the thread first, with the verifier's brief as its first message; once, however many ticks.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { listEntries } from '../../src/adapters/schedule-store.ts'
import { threadByKey } from '../../src/adapters/work-thread-store.ts'
import type { Party, ThreadHead } from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { unusedPort } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const worker: Party = { kind: 'session', key: S, name: 'atlas-mapper' }
const THREADS = { verify: { model: 'opus' } }
const calls = (box: Sandbox) => box.calls().map(a => a.join(' '))
const configFile = (box: Sandbox) => join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
const cardOf = (box: Sandbox, key: string): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** In this process with the sandbox's folders: the database, the schedule. */
function inBox<T>(box: Sandbox, fn: () => T): T {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    process.env.APPDATA = saved.APPDATA
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA
  }
}

async function thread(box: Sandbox, actor: Party, args: string[]): Promise<string> {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    const out: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads: THREADS },
      actor,
      lane: 'atlas',
      findSession: async () => null,
      out: l => out.push(l),
      err: l => out.push(l),
    })
    assert.equal(code, 0, out.join('\n'))
    return out.join('\n')
  } finally {
    process.env.APPDATA = saved.APPDATA
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA
  }
}

const headOf = (box: Sandbox, key: string): ThreadHead =>
  inBox(box, () => {
    const db = openDb() as BoardDb
    try {
      return threadByKey(db, key) as ThreadHead
    } finally {
      db.close()
    }
  })

/**
 * herdr with the worker idle in wP:p1 (workspace Atlas), and a new tab wP:t9 whose Claude comes up
 * idle; `verifier`: the session herdr reports in wP:p9 once it runs.
 */
function herdrWith(box: Sandbox, dir: string, verifier?: string): void {
  const pane = {
    pane_id: 'wP:p1',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: S },
    agent_status: 'idle',
    cwd: dir,
    terminal_title_stripped: 'atlas-mapper',
  }
  const fresh = {
    pane_id: 'wP:p9',
    tab_id: 'wP:t9',
    workspace_id: 'wP',
    agent: 'claude',
    agent_status: 'idle',
    cwd: dir,
  }
  const workspaces = [{ workspace_id: 'wP', label: 'Atlas' }]
  const panes = verifier ? [pane, { ...fresh, agent_session: { value: verifier } }] : [pane]
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces } } },
    'pane list': { result: { panes: [pane] } },
    'pane get wP:p1': { result: { pane } },
    'pane get wP:p9': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: S } } } },
    'workspace list': { result: { workspaces } },
    'tab create': { result: { tab: { tab_id: 'wP:t9' }, root_pane: { pane_id: 'wP:p9', terminal_id: 'term-9' } } },
    'pane run': { result: null },
    'agent list': { result: { agents: [] } },
    'agent rename': { result: null },
    'agent prompt': { result: null },
    'pane read': { text: 'Session renamed to: verify-atlas-1' },
  })
}

test('a held done gets one verifier, started by the board with the brief, model, folder and the session id in the thread', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'work')
  mkdirSync(dir, { recursive: true })
  herdrWith(box, dir)
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${S}.json`), JSON.stringify({ key: S, name: 'atlas-mapper', category: 'atlas' }))
  const launch = { claude: ['claude-tg'] }
  const cfg = {
    port: await unusedPort(),
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue' }],
    wakeUrl: null,
    refreshSec: 3600,
    scheduleTickSec: 0.2,
    language: 'en',
    launch,
    threads: THREADS,
  }
  mkdirSync(join(configFile(box), '..'), { recursive: true })
  writeFileSync(configFile(box), JSON.stringify(cfg))
  await thread(box, worker, ['new', '--doing', '--verify', '--accept', 'every row mapped', 'Map the price columns'])
  assert.equal(
    await thread(box, worker, ['done', 'atlas-1', 'all rows mapped']),
    'ok · atlas-1 · doing · done held: a verifier checks it',
  )
  const proc: Child = box.run('server', cfg)
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready), 10_000)
  await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')), 20_000)
  const run = calls(box).find(c => c.startsWith('pane run wP:p9')) ?? ''
  const id = /--session-id ([0-9a-f-]{36})$/.exec(run)?.[1] ?? ''
  assert.equal(run, `pane run wP:p9 claude-tg --model opus --session-id ${id}`)
  // The thread named that session its verifier before it started; its limit is in the schedule.
  const h = headOf(box, 'atlas-1')
  expect(h.verify?.run).toMatchObject({ key: id, name: 'verify-atlas-1' })
  assert.equal(h.proposed?.verify, true)
  const limit = inBox(box, () => listEntries()).find(e => e.kind === 'verify')
  expect(limit).toMatchObject({ key: id, thread: h.id, next: h.verify?.run?.until })
  // In the worker's folder, lane and workspace; its card the lane and the model.
  assert.ok(
    calls(box).includes(`tab create --workspace wP --cwd ${dir} --label verify-atlas-1 --no-focus`),
    calls(box).join('\n'),
  )
  expect(cardOf(box, id)).toMatchObject({ category: 'atlas', modelWant: 'opus' })
  // The brief as its first message.
  await until(() => calls(box).some(c => c.startsWith('agent prompt wP:p9 [board verify]')), 20_000)
  const brief = calls(box).find(c => c.startsWith('agent prompt wP:p9 [board verify]')) ?? ''
  assert.match(brief, /You are the verifier of thread atlas-1/)
  assert.match(brief, /- every row mapped/)
  assert.match(brief, /all rows mapped/)
  // herdr now reports the verifier's session in its pane.
  herdrWith(box, dir, id)
  // A session id put in the env does not make a verifier: the pane herdr says it runs in holds another
  // one; and it fails closed: no pane, or a pane herdr names no session in, is refused, saying why.
  const cli = async (env: Record<string, string>, args: string[]) => {
    const r = await box.run('cli', { args, env }).exited
    return `${r.code} ${r.stdout}${r.stderr}`.trim()
  }
  const forged = ['thread', 'verdict', 'atlas-1', 'fail', 'forged']
  assert.match(
    await cli({ CLAUDE_CODE_SESSION_ID: id, HERDR_PANE_ID: 'wP:p1' }, forged),
    /^1 only the verifier the board started for atlas-1 gives its verdict, from its own session: pane wP:p1 holds another session/,
  )
  assert.match(
    await cli({ CLAUDE_CODE_SESSION_ID: id, HERDR_PANE_ID: '' }, forged),
    /^1 only the verifier .*: HERDR_PANE_ID is not set, so herdr cannot confirm the session it runs in/,
  )
  assert.match(
    await cli({ CLAUDE_CODE_SESSION_ID: id, HERDR_PANE_ID: 'wP:p7' }, forged),
    /^1 only the verifier .*: herdr names no session in pane wP:p7/,
  )
  assert.equal(headOf(box, 'atlas-1').verify?.run?.key, id)
  const report = join(box.dir, 'report.md')
  writeFileSync(report, '- every row mapped: rows 1-217 read\n')
  assert.equal(
    await cli({ CLAUDE_CODE_SESSION_ID: id, HERDR_PANE_ID: 'wP:p9' }, [
      'thread',
      'verdict',
      'atlas-1',
      'pass',
      '--file',
      report,
      'rows read',
    ]),
    '0 ok · atlas-1 · done · verdict pass',
  )
  // Once: more ticks start nothing more.
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(calls(box).filter(c => c.startsWith('tab create')).length, 1)
}, 60_000)
