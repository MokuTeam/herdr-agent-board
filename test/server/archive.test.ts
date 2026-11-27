// The archive against the fake herdr: a session taken off the board has its tab closed a few
// seconds later (Return in the page's toast puts it back as it was), and comes back later resumed
// by its id in a new tab. These run the server, its scheduler and the board command (ported from
// upstream's test/archive.test.mjs at 2b9e6b7; its rules: test/core/archive.test.ts). With more
// than one Claude profile, a session is archived only when the board can tell its profile, and
// Return resumes it in that profile or not at all.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import { tidyList } from '../../src/core/archive.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import { clockIn, localZone } from '../../src/core/time.ts'
import type { Item } from '../../src/core/types.ts'
import { dueAgain, hides } from '../../src/services/archive.ts'
import { archiveApi, isBoardPayload } from '../../web/src/api/client.ts'
import { archiveNotes } from '../../web/src/models/archive-view.ts'
import { unusedPort } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DAY = 86_400_000

const RULE = '─'.repeat(40)
const screen = (typed = '') => ['● done', RULE, `❯ ${typed}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const stateDir = (box: Sandbox) => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
const configFile = (box: Sandbox) => join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
const archiveFile = (box: Sandbox) => join(stateDir(box), 'archive', `${S}.json`)
type Rec = Record<string, unknown> & { state: string; held: { id: string; text: string }[] }
const record = (box: Sandbox): Rec | null =>
  existsSync(archiveFile(box)) ? JSON.parse(readFileSync(archiveFile(box), 'utf8')) : null
type LogLine = { key: string; result: string; why?: string }
const archiveLog = (box: Sandbox): LogLine[] => {
  const file = join(stateDir(box), 'archive', 'log.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as LogLine)
    : []
}
const entryFile = (box: Sandbox, id: string) => join(stateDir(box), 'schedule', `${id}.json`)
const cardOf = (box: Sandbox) =>
  JSON.parse(readFileSync(join(box.cards, `${S}.json`), 'utf8')) as Record<string, unknown>
const calls = (box: Sandbox) => box.calls().map(a => a.join(' '))
/** Nothing was started: no tab, no Claude, no workspace. */
const startedNothing = (box: Sandbox) =>
  assert.deepEqual(
    calls(box).filter(c => /^(tab create|pane run|workspace create|agent start)/.test(c)),
    [],
  )

/** Claude's conversation of S, run in `dir`, in the profile folder `claudeDir` of the home folder. */
function transcript(box: Sandbox, dir: string, claudeDir = '.claude'): string {
  const projects = join(box.env.HOME as string, claudeDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projects, { recursive: true })
  const file = join(projects, `${S}.jsonl`)
  const line = {
    type: 'user',
    cwd: dir,
    sessionId: S,
    message: { role: 'user', content: 'run the probe' },
    timestamp: new Date().toISOString(),
  }
  writeFileSync(file, `${JSON.stringify(line)}\n`)
  return file
}

/** A project folder with Claude's transcript of S in it (in `claudeDir`), and S's card. */
function project(box: Sandbox, card: Record<string, unknown> = {}, claudeDir = '.claude'): string {
  const dir = join(box.dir, 'probe')
  mkdirSync(dir, { recursive: true })
  if (claudeDir) transcript(box, dir, claudeDir)
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, `${S}.json`),
    JSON.stringify({ key: S, name: 'Probe card', category: 'personal', result: 'tests green', ...card }),
  )
  return dir
}

type HerdrOptions = {
  status?: string
  agent?: 'claude' | 'codex'
  typed?: string
  shared?: boolean
  gone?: boolean
  asleep?: boolean
  label?: string
  running?: boolean
  extra?: Record<string, unknown>[]
}

/**
 * herdr with Claude session S in pane wP:p1, or gone. Its tab wP:t1 also holds herdr-sidebar's
 * panel (no agent, the plugin's tokens), and with `shared` a plain shell beside it.
 */
const NOT_FOUND = { code: 'pane_not_found', error: 'pane_not_found: no such pane' }
function herdrState(dir: string, opts: HerdrOptions = {}): Record<string, unknown> {
  const { status = 'idle', typed = '', shared = false, gone = false, asleep = false, running = false } = opts
  const { agent = 'claude', label = asleep ? '💤 Probe' : '', extra = [] } = opts
  const pane = {
    pane_id: 'wP:p1',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    agent: asleep ? null : agent,
    agent_session: asleep ? null : { value: S },
    agent_status: asleep ? null : status,
    cwd: dir,
    terminal_title_stripped: 'Probe',
    label,
  }
  const sidebar = {
    pane_id: 'wP:p3',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    label: 'Sidebar',
    cwd: dir,
    tokens: { 'herdr-sidebar-explorer': '1' },
  }
  const others = [
    sidebar,
    ...(shared ? [{ pane_id: 'wP:p2', tab_id: 'wP:t1', workspace_id: 'wP', agent: null, cwd: dir }] : []),
  ]
  const panes = gone ? others : [pane, ...others, ...extra]
  const foreground = [{ pid: 7, argv: ['pwsh'] }, ...(running ? [{ pid: 8, argv: ['npm', 'run', 'dev'] }] : [])]
  return {
    'api snapshot': {
      result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } },
    },
    // Gone once the board closed it: the board checks that before it calls it archived.
    // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after a close (test/support/fake-herdr.ts)
    'pane get': gone ? NOT_FOUND : { until: ['tab close', 'pane close'], then: NOT_FOUND, result: { pane } },
    // A sleeping session's shell runs nothing but itself, unless something was started in it.
    'pane process-info': {
      result: { process_info: { pane_id: 'wP:p1', shell_pid: 7, foreground_processes: foreground } },
    },
    'pane list': { result: { panes } },
    'agent get': {
      result: {
        agent: asleep || gone ? null : { agent, agent_status: status, agent_session: { value: S } },
      },
    },
    'agent read': { text: agent === 'codex' ? `› ${typed}` : screen(typed) },
    'tab close': { result: null },
    'pane close': { result: null },
    'workspace list': { result: { workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } },
  }
}
const herdrWith = (box: Sandbox, dir: string, opts: HerdrOptions = {}) => box.state(herdrState(dir, opts))

/** The tab gone; herdr opens a new one for the resume, where Claude comes up idle in wP:p9. */
const FRESH = (dir: string) => ({
  pane_id: 'wP:p9',
  tab_id: 'wP:t9',
  workspace_id: 'wP',
  agent: 'claude',
  agent_session: { value: S },
  agent_status: 'idle',
  cwd: dir,
})
function resumable(box: Sandbox, dir: string): void {
  const fresh = FRESH(dir)
  const gone = herdrState(dir, { gone: true })
  // The new tab's shell, before Claude runs in it: herdr has the pane the board recorded.
  const shell = { pane_id: 'wP:p9', tab_id: 'wP:t9', workspace_id: 'wP', terminal_id: 'term-9', cwd: dir }
  const workspaces = [{ workspace_id: 'wP', label: 'Personal' }]
  const panes = [...(gone['pane list'] as { result: { panes: unknown[] } }).result.panes, shell]
  box.state({
    ...gone,
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces } } },
    'tab create': { result: { tab: { tab_id: 'wP:t9' }, root_pane: { pane_id: 'wP:p9', terminal_id: 'term-9' } } },
    'pane run': { result: null },
    'pane get': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'agent list': { result: { agents: [] } },
    'agent rename': { result: null },
  })
}

const CATEGORIES = [
  { id: 'personal', title: 'Personal', color: 'blue' },
  { id: 'other', title: 'Other', color: 'gray' },
]

type Answer = { status: number; body: Record<string, unknown> & { done?: Record<string, unknown>[] } }

async function board(box: Sandbox, cfg: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const port = await unusedPort()
  const proc: Child = box.run(
    'server',
    {
      port,
      categories: CATEGORIES,
      wakeUrl: null,
      refreshSec: 3600,
      language: 'en',
      scheduleTickSec: 0.2,
      archiveUndoSec: 30,
      ...cfg,
    },
    // Return starts the board's own spawn-agent against the fake herdr, which answers at once: its
    // polls and pauses run at a fiftieth (adapters/pacing.ts).
    { BOARD_TEST_PACE: '0.02', ...env },
  )
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready), 10_000)
  const url = `http://127.0.0.1:${port}`
  const payload = async () => (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
  /** Asks for a refresh and waits for one that ended after `since`. */
  const refreshedAfter = async (since: number) => {
    proc.send('refresh')
    for (const end = Date.now() + 10_000; ; ) {
      const p = await payload()
      if (Number(p.lastSuccessfulRefreshAt) > since) return
      if (Date.now() > end) throw new Error(`no refresh: ${JSON.stringify(proc.messages)}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  // A refresh asked for while another runs is folded into it, and that one may have read herdr
  // before the test changed it (every session action starts one). The first refresh to end after
  // now may be that one; the next one to end began after it ended, so after now.
  const refresh = async () => {
    await refreshedAfter(Date.now())
    await refreshedAfter(Date.now())
  }
  await refresh()
  const post = (path: string, body: unknown): Promise<Answer> =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: (await r.json()) as Answer['body'] }))
  const items = async () => ((await payload()).items as Item[]).map(i => i.key)
  const list = async () =>
    (await (await fetch(`${url}/api/archive`)).json()) as { records: Record<string, unknown>[]; undoMs: number }
  return { proc, url, payload, refresh, post, items, list, archive: () => post(`/api/session/${S}/archive`, {}) }
}

/** A reminder for S, and a restart of it on its way. */
function schedule(box: Sandbox): void {
  mkdirSync(join(stateDir(box), 'schedule'), { recursive: true })
  const later = Date.now() + 3 * 3600e3
  const entry = { key: S, name: 'Probe', pane: 'wP:p1', at: later, next: later, created: Date.now(), by: 'agent' }
  writeFileSync(entryFile(box, 'abc123'), JSON.stringify({ id: 'abc123', ...entry, text: 'check the CI' }))
  writeFileSync(
    entryFile(box, 'def456'),
    JSON.stringify({ id: 'def456', ...entry, kind: 'restart', idle: true, text: '' }),
  )
}

/** The sandbox's config.json, which spawn-agent reads (how Claude starts, the profiles). */
function boardConfig(box: Sandbox, cfg: Record<string, unknown>): void {
  mkdirSync(join(configFile(box), '..'), { recursive: true })
  writeFileSync(configFile(box), JSON.stringify(cfg))
}

test('Archive takes the card off at once and closes its tab after the undo time; its reminder waits in the record', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  const b = await board(box, { archiveUndoSec: 1 })
  assert.ok((await b.items()).includes(S))
  const r = await b.archive()
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.ok, r.body.held, r.body.dropped], [true, 1, 1])
  // Off the board right away, its entries out of the schedule and into its record.
  await b.refresh()
  assert.equal((await b.items()).includes(S), false)
  assert.equal(existsSync(entryFile(box, 'abc123')), false)
  assert.equal(existsSync(entryFile(box, 'def456')), false)
  const rec = record(box)
  assert.ok(rec)
  assert.deepEqual(
    [rec.state, rec.name, rec.category, rec.cwd, rec.workspace, rec.workspaceId, rec.pane, rec.tab, rec.note, rec.by],
    ['closing', 'Probe card', 'personal', dir, 'Personal', 'wP', 'wP:p1', 'wP:t1', 'tests green', 'user'],
  )
  assert.deepEqual(
    rec.held.map(e => [e.id, e.text]),
    [['abc123', 'check the CI']],
  )
  // The profile it runs in, which Return resumes it in: the one profile there is.
  assert.equal(rec.profile, 'default')
  assert.equal(
    calls(box).some(c => c.startsWith('tab close')),
    false,
  )
  // The scheduler closes the tab (nothing but herdr-sidebar's panel is beside it) once the time is up.
  await until(() => record(box)?.state === 'archived', 10_000)
  assert.ok(calls(box).includes('tab close wP:t1'))
  assert.equal(
    calls(box).some(c => c.startsWith('pane close')),
    false,
  )
  assert.deepEqual(
    archiveLog(box).map(e => e.result),
    ['closed'],
  )
  // The archive list, as the page reads it: the held entries as a count, no bookkeeping.
  const list = await b.list()
  assert.deepEqual(
    list.records.map(x => [x.key, x.state, x.held, x.returning, 'claim' in x]),
    [[S, 'archived', 1, false, false]],
  )
  assert.equal(list.undoMs, 1000)
  // The card stays where it was: a session resumed by hand comes back with its name and lane.
  assert.ok(existsSync(join(box.cards, `${S}.json`)))
}, 30_000)

test('Return before the tab closed puts everything back as it was: the card, the reminder under its id', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  const b = await board(box)
  assert.equal((await b.archive()).body.ok, true)
  const back = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  assert.deepEqual(
    back.body.done?.map(d => [d.key, d.back, !!d.resume]),
    [[S, true, false]],
  )
  assert.equal(record(box), null)
  assert.equal(JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8')).text, 'check the CI')
  assert.equal(existsSync(entryFile(box, 'def456')), false) // a restart does not come back: a resume would be one
  await b.refresh()
  assert.ok((await b.items()).includes(S))
  assert.equal(
    calls(box).some(c => /^(tab|pane) close/.test(c)),
    false,
  )
  // Gone from the archive: a second Return says so.
  const again = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(again.status, 409)
  assert.match(String(again.body.error), /not in the archive/)
}, 30_000)

function codexTranscript(box: Sandbox, dir: string): string {
  const codexHome = join(box.dir, 'Codex home 50%')
  const rolls = join(codexHome, 'sessions', '2026', '11', '26')
  mkdirSync(rolls, { recursive: true })
  writeFileSync(
    join(rolls, `rollout-2026-11-26T12-00-00-${S}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: S, cwd: dir } })}\n`,
  )
  return codexHome
}

test('Codex enters the archive and Return starts the original UUID in its rollout home', async () => {
  const box = await sandbox()
  const dir = project(box, {}, '')
  const codexHome = codexTranscript(box, dir)
  const bin = join(box.dir, 'bin')
  mkdirSync(bin)
  const file = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
  chmodSync(file, 0o755)
  herdrWith(box, dir, { agent: 'codex', typed: 'unsent draft' })
  const b = await board(
    box,
    { archiveUndoSec: 0.2 },
    {
      CODEX_HOME: codexHome,
      PATH: `${bin}${delimiter}${box.env.PATH}`,
    },
  )
  assert.equal((await b.archive()).body.ok, false)
  herdrWith(box, dir, { agent: 'codex' })
  assert.equal((await b.archive()).body.ok, true)
  await until(() => record(box)?.state === 'archived', 10_000)
  assert.equal(record(box)?.agent, 'codex')
  resumable(box, dir)
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  box.state({ ...state, 'agent start': { result: {} } })
  await b.refresh()
  const r = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(r.body.done?.[0]?.resume, true, JSON.stringify(r.body))
  await until(() => box.calls().some(c => c[0] === 'agent' && c[1] === 'start'), 10_000)
  const command = box.calls().find(c => c[0] === 'agent' && c[1] === 'start') ?? []
  assert.ok(command.includes('codex'))
  assert.deepEqual(command.slice(-2), ['resume', S])
  const tab = box.calls().find(c => c[0] === 'tab' && c[1] === 'create') ?? []
  assert.ok(tab.includes(`CODEX_HOME=${codexHome}`))
  box.state({
    ...state,
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ ...FRESH(dir), agent: 'codex' }],
          tabs: [],
          workspaces: [{ workspace_id: 'wP', label: 'Personal' }],
        },
      },
    },
  })
  await b.refresh()
  await until(() => record(box) === null, 10_000)
  assert.ok((await b.items()).includes(S))
})

test('archived Codex sleeper with a closed pane keeps its schedule until the native SID returns', async () => {
  const box = await sandbox()
  const dir = project(box, {}, '')
  const codexHome = codexTranscript(box, dir)
  const sleepers = join(stateDir(box), 'wake-codex.json')
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(
    sleepers,
    JSON.stringify({
      [S]: { session: S, pane: 'wP:p1', name: 'Probe card', cwd: dir, argv: ['codex'], slept_at: Date.now() },
    }),
  )
  schedule(box)
  herdrWith(box, dir, { agent: 'codex', asleep: true, label: '💤 Probe card' })
  const b = await board(box, { archiveUndoSec: 0.2 }, { CODEX_HOME: codexHome })
  const find = async () => ((await b.payload()).items as Item[]).find(i => i.key === S)
  const asleep = await find()
  assert.deepEqual([asleep?.agent, asleep?.sleeping, asleep?.pane], ['codex', true, 'wP:p1'])

  assert.equal((await b.archive()).body.ok, true)
  await until(() => archiveLog(box).some(e => e.result === 'closed'), 10_000)
  assert.ok(calls(box).includes('tab close wP:t1'))
  herdrWith(box, dir, { gone: true })
  await b.refresh()
  assert.equal(await find(), undefined)
  assert.equal(record(box)?.state, 'archived')
  assert.equal(record(box)?.pane, 'wP:p1')
  assert.ok(record(box)?.held.some(e => e.id === 'abc123'))
  assert.equal(existsSync(entryFile(box, 'abc123')), false)
  assert.deepEqual(
    archiveLog(box).map(l => l.result),
    ['closed'],
  )

  // The stale registry row can coexist with a real resume. The native item wins by SID.
  box.state({
    'api snapshot': {
      result: {
        snapshot: { panes: [{ ...FRESH(dir), agent: 'codex' }], tabs: [], workspaces: [] },
      },
    },
  })
  await b.refresh()
  const resumed = await find()
  assert.deepEqual([resumed?.agent, resumed?.session, resumed?.sleeping, resumed?.pane], ['codex', S, false, 'wP:p9'])
  assert.equal(record(box), null)
  assert.deepEqual(
    archiveLog(box).map(l => l.result),
    ['closed', 'returned'],
  )
  const reminder = JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8'))
  assert.deepEqual([reminder.id, reminder.key, reminder.pane], ['abc123', S, 'wP:p9'])
})

test('Return after the tab closed resumes it by its id in a new tab, in its folder and workspace, with its name; then it is settled', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  // spawn-agent reads how Claude starts from the board's config.json. pi as the default for new
  // sessions changes nothing here: a session comes back as the Claude session it was.
  const spec = { claude: ['claude-tg', '--dangerously-skip-permissions'], default: 'pi', pi: 'pi' }
  boardConfig(box, { launch: spec })
  const b = await board(box, { archiveUndoSec: 0.2, launch: spec })
  assert.equal((await b.archive()).body.ok, true)
  await until(() => record(box)?.state === 'archived', 10_000)
  resumable(box, dir)
  await b.refresh()
  // Two Returns at once (two windows, the toast and the list): one resume, the other hears it is on its way.
  const [r, twice] = await Promise.all([
    b.post('/api/archive', { op: 'return', keys: [S] }),
    b.post('/api/archive', { op: 'return', keys: [S] }),
  ])
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.done?.[0]?.resume, true)
  assert.deepEqual([twice.status, twice.body.done?.[0]?.again, !!twice.body.done?.[0]?.resume], [200, true, false])
  await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')), 15_000)
  assert.ok(
    calls(box).includes(`tab create --workspace wP --cwd ${dir} --label Probe card --no-focus`),
    calls(box).join('\n'),
  )
  assert.ok(calls(box).includes(`pane run wP:p9 claude-tg --dangerously-skip-permissions --resume ${S}`))
  // Resumed, not renamed: Claude keeps the name it had; herdr gets one to address it by.
  await until(() => calls(box).some(c => c.startsWith('agent rename wP:p9')), 15_000)
  assert.equal(
    calls(box).some(c => c.startsWith('agent prompt')),
    false,
  )
  // In the default profile, the board's own (its env names none): ~/.claude without the variable.
  assert.equal(
    calls(box).some(c => c.includes('--env')),
    false,
  )
  // On its way: the page sees the launch (a card "back" in its lane), the record says so.
  assert.equal((await b.list()).records[0]?.returning, true)
  const launch = ((await b.payload()).launches as { resume?: string | null }[])[0]
  assert.equal(launch?.resume, S)
  // herdr shows the session in its new pane: the record goes, the reminder is back with that pane.
  box.state({
    ...JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8')),
    'api snapshot': {
      result: { snapshot: { panes: [FRESH(dir)], tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } },
    },
  })
  await b.refresh()
  await until(() => record(box) === null, 10_000)
  const entry = JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8'))
  assert.deepEqual([entry.pane, entry.text], ['wP:p9', 'check the CI'])
  assert.ok((await b.items()).includes(S))
  const card = cardOf(box)
  assert.deepEqual([card.name, card.category, card.profileWant], ['Probe card', 'personal', 'default'])
  assert.deepEqual(
    archiveLog(box).map(e => e.result),
    ['closed', 'returned'],
  )
  assert.equal(calls(box).filter(c => c.startsWith('pane run')).length, 1)
}, 40_000)

test('a session that works, waits on a dialog or has a draft stays; one that got to work in the undo time is kept', async () => {
  const box = await sandbox()
  const dir = project(box)
  schedule(box)
  herdrWith(box, dir, { status: 'working' })
  const b = await board(box, { archiveUndoSec: 1.5 })
  const working = await b.archive()
  assert.equal(working.status, 409)
  assert.match(String(working.body.error), /It is working/)
  herdrWith(box, dir, { status: 'blocked' })
  await b.refresh()
  assert.match(String((await b.archive()).body.error), /dialog waits/)
  // herdr says idle, but text waits in its input box: read from the screen, as herdr-wake does.
  herdrWith(box, dir, { typed: 'half a thought' })
  await b.refresh()
  assert.match(String((await b.archive()).body.error), /Text you started typing/)
  assert.equal(record(box), null)
  assert.ok(existsSync(entryFile(box, 'abc123')))

  // Free now; then a message gets it to work before its tab closes: the archive is called off.
  herdrWith(box, dir)
  await b.refresh()
  assert.equal((await b.archive()).body.ok, true)
  herdrWith(box, dir, { status: 'working' })
  await until(() => archiveLog(box).some(e => e.result === 'kept'), 10_000)
  assert.equal(record(box), null)
  assert.equal(archiveLog(box).at(-1)?.why, 'archive.why.working')
  assert.ok(existsSync(entryFile(box, 'abc123')))
  assert.equal(
    calls(box).some(c => /^(tab|pane) close/.test(c)),
    false,
  )
  // The page hears it once, from the board's own log; the card is back.
  await b.refresh()
  assert.ok((await b.items()).includes(S))
  const payload = await b.payload()
  assert.equal((payload.archive as { log: LogLine[] }).log[0]?.result, 'kept')
  // The board payload's first key, as upstream sends it.
  assert.equal(Object.keys(payload)[0], 'archive')
}, 40_000)

test('a sleeping session goes too; a pane that shares its tab closes alone; Remove drops the record and the card, never the transcript', async () => {
  const box = await sandbox()
  const dir = project(box)
  // herdr-wake: S sleeps in wP:p1, a shell now, beside another pane in its tab.
  const wake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        req.url === '/sleeping'
          ? [{ session: S, pane: 'wP:p1', name: 'Probe', slept_at: new Date(Date.now() - 5 * DAY).toISOString() }]
          : {},
      ),
    )
  })
  await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
  try {
    // A shell herdr-wake did not mark as sleeping, or with a program started in it, is not closed.
    herdrWith(box, dir, { asleep: true, label: 'pwsh' })
    const b = await board(box, {
      archiveUndoSec: 0.2,
      wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}`,
    })
    assert.match(String((await b.archive()).body.error), /no longer runs in its pane/)
    herdrWith(box, dir, { asleep: true, running: true })
    assert.match(String((await b.archive()).body.error), /Something else runs in its pane/)
    // herdr gives pane ids out again (#302): a pane marked 💤 for another sleeper is not this one's.
    herdrWith(box, dir, { asleep: true, label: '💤 Other' })
    assert.match(String((await b.archive()).body.error), /no longer runs in its pane/)
    assert.equal(record(box), null)
    assert.equal(
      calls(box).some(c => c.startsWith('pane close') || c.startsWith('tab close')),
      false,
    )
    herdrWith(box, dir, { asleep: true, shared: true })
    mkdirSync(join(stateDir(box), 'context'), { recursive: true })
    writeFileSync(join(stateDir(box), 'context', `${S}.json`), '{}')
    const asleep = ((await b.payload()).items as Item[]).find(i => i.key === S)
    assert.ok(asleep)
    assert.equal(asleep.sleeping, true)
    // Quiet since its transcript's last line (now): every sleeping one, not those over a day.
    assert.deepEqual(
      tidyList([asleep], 0).map(i => i.key),
      [S],
    )
    assert.deepEqual(tidyList([asleep], 1), [])
    const r = await b.post('/api/archive', { op: 'archive', keys: [S, OTHER] })
    assert.deepEqual(
      r.body.done?.map(d => d.key),
      [S],
      JSON.stringify(r.body),
    )
    assert.deepEqual(
      (r.body.failed as { key: string }[]).map(f => f.key),
      [OTHER],
    )
    await until(() => record(box)?.state === 'archived', 10_000)
    assert.ok(calls(box).includes('pane close wP:p1'))
    assert.equal(
      calls(box).some(c => c.startsWith('tab close')),
      false,
    )

    const file = join(box.env.HOME as string, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${S}.jsonl`)
    const removed = await b.post('/api/archive', { op: 'remove', keys: [S] })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(record(box), null)
    assert.equal(existsSync(join(box.cards, `${S}.json`)), false)
    assert.equal(existsSync(join(stateDir(box), 'context', `${S}.json`)), false)
    assert.ok(existsSync(file))
    assert.deepEqual(
      readdirSync(join(stateDir(box), 'archive')).filter(n => n.endsWith('.json')),
      [],
    )
  } finally {
    await new Promise(resolve => wake.close(resolve))
  }
}, 30_000)

test('#323: an archived sleeper with no pane stays hidden; a call agent with no pane, or the session in a pane, shows', () => {
  const rec = { key: S, pane: '', state: 'archived' } as unknown as Parameters<typeof hides>[0]
  assert.equal(hides(rec, { pane: null, sleeping: true }), true)
  // MokuPilot going on in it for a call (#326): no pane, not asleep.
  assert.equal(hides(rec, { pane: null, sleeping: false }), false)
  assert.equal(hides(rec, { pane: 'wP:p9', sleeping: false }), false)
  // Archived from its pane: hidden there only, as before.
  const inPane = { ...rec, pane: 'wP:p1' } as Parameters<typeof hides>[0]
  assert.equal(hides(inPane, { pane: 'wP:p1', sleeping: false }), true)
  assert.equal(hides(inPane, { pane: null, sleeping: true }), false)
})

test('#323: a sleeper whose pane wake closed, archived by name or id, stays archived; resumed by hand elsewhere it is back', async () => {
  for (const target of ['Probe card', S]) {
    const box = await sandbox()
    const dir = project(box)
    // Its pane gone: wake closed it as it went to sleep (#204), so wake lists it without one.
    herdrWith(box, dir, { gone: true })
    let asleep = true
    const wake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      const sleeper = { session: S, pane: '', name: 'Probe', workspace: 'Personal', cwd: dir }
      const at = new Date(Date.now() - 5 * DAY).toISOString()
      res.end(JSON.stringify(req.url?.startsWith('/sleeping') ? (asleep ? [{ ...sleeper, slept_at: at }] : []) : {}))
    })
    await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
    try {
      const wakeUrl = `http://127.0.0.1:${(wake.address() as AddressInfo).port}`
      boardConfig(box, { language: 'en', port: 9, wakeUrl, categories: CATEGORIES })
      const b = await board(box, { wakeUrl })
      const shown = ((await b.payload()).items as Item[]).find(i => i.key === S)
      assert.deepEqual([shown?.sleeping, shown?.pane], [true, null])
      const out = await box.run('cli', {
        args: ['archive', '--session', target],
        env: { CLAUDE_CODE_SESSION_ID: OTHER },
      }).exited
      assert.equal(out.code, 0, `${out.stdout}${out.stderr}`)
      assert.match(out.stdout, /^ok · archived Probe card/)
      await b.refresh()
      await b.refresh()
      assert.equal(record(box)?.state, 'archived', target)
      assert.deepEqual(
        archiveLog(box).map(l => l.result),
        ['closed'],
        target,
      )
      assert.equal((await b.items()).includes(S), false, target)
      // Nothing was closed: it had no pane.
      assert.equal(
        calls(box).some(c => /^(tab|pane) close/.test(c)),
        false,
      )
      if (target !== S) continue
      // Resumed by hand in a pane of its own: it is back, its record settled.
      asleep = false
      box.state({
        'api snapshot': {
          result: {
            snapshot: { panes: [FRESH(dir)], tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] },
          },
        },
      })
      await b.refresh()
      assert.deepEqual(
        archiveLog(box).map(l => l.result),
        ['closed', 'returned'],
      )
      assert.equal(record(box), null)
      assert.ok((await b.items()).includes(S))
    } finally {
      await new Promise(resolve => wake.close(resolve))
    }
  }
}, 60_000)

test('a sleeper put to sleep without a name of its own closes under the bare 💤 wake gave it (#302)', async () => {
  const box = await sandbox()
  const dir = project(box)
  // No /rename: wake lists it under its title, but `herdr-wake sleep <pane>` labelled it a bare 💤.
  const wake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        req.url?.startsWith('/sleeping')
          ? [{ session: S, pane: 'wP:p1', name: 'Probe', slept_at: new Date(Date.now() - 5 * DAY).toISOString() }]
          : {},
      ),
    )
  })
  await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
  try {
    herdrWith(box, dir, { asleep: true, label: '💤' })
    const b = await board(box, {
      archiveUndoSec: 0.2,
      wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}`,
    })
    const r = await b.archive()
    assert.equal(r.status, 200, JSON.stringify(r.body))
    await until(() => record(box)?.state === 'archived', 10_000)
    // Alone in its tab but for herdr-sidebar's panel: the tab goes with it.
    assert.ok(calls(box).includes('tab close wP:t1'), JSON.stringify(calls(box)))
  } finally {
    await new Promise(resolve => wake.close(resolve))
  }
}, 30_000)

test('board archive --session: by the same rules, its tab closed at once; never the session itself', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  // Port 9 and no herdr-wake: the command never reaches a live board or herdr-wake.
  boardConfig(box, { language: 'ru', port: 9, wakeUrl: null, categories: CATEGORIES })
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const out = await box.run('cli', { args, env }).exited
    return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
  }
  assert.match((await cli(['archive'])).out, /usage: board archive --session/)
  assert.match((await cli(['archive', '--session', 'nobody'])).out, /no session "nobody" on the board/)
  // A name two sessions go by takes neither; the pane or the id says which.
  const twin = {
    pane_id: 'wP:p5',
    tab_id: 'wP:t5',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: OTHER },
    agent_status: 'idle',
    cwd: dir,
    terminal_title_stripped: 'Probe',
  }
  herdrWith(box, dir, { extra: [twin] })
  const both = await cli(['archive', '--session', 'Probe'], { CLAUDE_CODE_SESSION_ID: '' })
  assert.equal(both.code, 1)
  assert.match(both.out, /"Probe" fits 2 sessions on the board .*give its session id or pane/)
  herdrWith(box, dir)
  const self = await cli(['archive', '--session', 'Probe card'], { CLAUDE_CODE_SESSION_ID: S })
  assert.equal(self.code, 1)
  assert.match(self.out, /cannot archive itself/)
  herdrWith(box, dir, { status: 'working' })
  // In English for agents, whatever language the board speaks.
  assert.match(
    (await cli(['archive', '--session', 'Probe card'], { CLAUDE_CODE_SESSION_ID: OTHER })).out,
    /Probe card stays on the board: it is working/,
  )
  herdrWith(box, dir)
  const r = await cli(['archive', '--session', 'probe card'], { CLAUDE_CODE_SESSION_ID: OTHER })
  assert.equal(r.code, 0, r.out)
  assert.match(
    r.out,
    /^ok · archived Probe card: its pane is closed; the user can bring it back from the board's archive/,
  )
  assert.ok(calls(box).includes('tab close wP:t1'))
  const rec = record(box)
  assert.ok(rec)
  assert.deepEqual([rec.state, rec.by, (rec.from as { key: string }).key], ['archived', 'agent', OTHER])
}, 40_000)

test('a board stopped between holding a reminder and taking it out of the schedule: Return does not double it', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  // The record holds abc123, and abc123 is still in the schedule.
  const entry = JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8'))
  mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
  writeFileSync(
    archiveFile(box),
    JSON.stringify({
      key: S,
      session: S,
      name: 'Probe card',
      category: 'personal',
      cwd: dir,
      pane: 'wP:p1',
      state: 'closing',
      closeAt: Date.now() + 60_000,
      archivedAt: Date.now(),
      held: [entry],
    }),
  )
  const b = await board(box)
  const back = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(back.body.done?.[0]?.back, true, JSON.stringify(back.body))
  assert.equal(record(box), null)
  assert.deepEqual(
    readdirSync(join(stateDir(box), 'schedule'))
      .filter(n => /^[0-9a-f]{6}\.json$/.test(n))
      .sort(),
    ['abc123.json', 'def456.json'],
  )
}, 30_000)

test('archiving and Return come only from the board’s own page; a report that comes in the undo time keeps the session', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  const b = await board(box, { archiveUndoSec: 1 })
  const send = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${b.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  assert.equal((await send('/api/archive', { op: 'archive', keys: [S] }, {})).status, 403)
  assert.equal(
    (await send('/api/archive', { op: 'archive', keys: [S] }, { 'x-board': '1', origin: 'http://evil.example' }))
      .status,
    403,
  )
  assert.equal(
    (await send(`/api/session/${S}/archive`, {}, { 'x-board': '1', origin: 'http://evil.example' })).status,
    403,
  )
  assert.equal((await send('/api/archive', { op: 'nope', keys: [S] }, { 'x-board': '1' })).status, 400)
  assert.equal(record(box), null)

  assert.equal((await b.archive()).body.ok, true)
  // A MokuPilot report with a receipt for it, queued meanwhile: it must reach the session.
  mkdirSync(join(stateDir(box), 'schedule'), { recursive: true })
  const later = Date.now() + 3600e3
  writeFileSync(
    entryFile(box, 'fed123'),
    JSON.stringify({
      id: 'fed123',
      key: S,
      kind: 'call',
      idle: true,
      text: 'report',
      at: later,
      next: later,
      created: Date.now(),
      by: 'mokupilot',
      receipt: { key: 'r1' },
    }),
  )
  await until(() => archiveLog(box).some(e => e.result === 'kept'), 10_000)
  assert.equal(archiveLog(box).at(-1)?.why, 'archive.why.report')
  assert.ok(existsSync(entryFile(box, 'fed123')))
  assert.equal(record(box), null)
  assert.equal(
    calls(box).some(c => /^(tab|pane) close/.test(c)),
    false,
  )
}, 30_000)

// ---------------------------------------------------------------- Claude profiles

/**
 * The home folder's profile folders .claude and .claude-work, both shown, in the board's config
 * (the server's and the config.json spawn-agent reads).
 */
function twoProfiles(box: Sandbox, extra: Record<string, unknown> = {}) {
  const home = box.env.HOME as string
  const dirs = { default: join(home, '.claude'), work: join(home, '.claude-work') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dirs.default, 'settings.json'), '{}')
  const profiles = [
    { id: 'default', title: 'Private', dir: dirs.default, color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: dirs.work, color: 'teal', hidden: false },
  ]
  boardConfig(box, { profiles, ...extra })
  return { ...dirs, profiles }
}

test('Return in a second profile resumes in it: its CLAUDE_CONFIG_DIR on the tab, the pane recorded, the card wants it', async () => {
  const box = await sandbox()
  const { work, profiles } = twoProfiles(box, { launch: { claude: ['claude-tg'] } })
  // A work session: its hooks reported the work folder, which holds its conversation.
  const dir = project(box, { profile: 'work', profileDir: work }, '.claude-work')
  herdrWith(box, dir)
  const b = await board(box, { archiveUndoSec: 0.2, profiles })
  const archived = await b.archive()
  assert.equal(archived.status, 200, JSON.stringify(archived.body))
  await until(() => record(box)?.state === 'archived', 10_000)
  assert.equal(record(box)?.profile, 'work')
  resumable(box, dir)
  await b.refresh()
  const r = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.done?.[0]?.resume, true)
  await until(() => calls(box).some(c => c.startsWith('agent rename wP:p9')), 15_000)
  assert.ok(
    calls(box).includes(
      `tab create --workspace wP --cwd ${dir} --label Probe card --env CLAUDE_CONFIG_DIR=${work} --no-focus`,
    ),
    calls(box).join('\n'),
  )
  assert.ok(calls(box).includes(`pane run wP:p9 claude-tg --resume ${S}`))
  // Its pane is the work profile's: a later wake of it passes the board's guard.
  const panes = JSON.parse(readFileSync(join(stateDir(box), 'profile-panes.json'), 'utf8'))
  expect(panes).toMatchObject({ 'wP:p9': { profile: 'work', terminal: 'term-9' } })
  expect(cardOf(box)).toMatchObject({ profile: 'work', profileDir: work, profileWant: 'work' })
  const launch = ((await b.payload()).launches as { resume?: string | null; profile?: string }[])[0]
  expect(launch).toMatchObject({ resume: S, profile: 'work' })
}, 40_000)

test('a session whose profile the board cannot tell is not archived, and one in the archive is not resumed: nothing starts', async () => {
  const box = await sandbox()
  const { profiles } = twoProfiles(box)
  // Its hooks reported a folder no profile has: the board cannot tell which account it is in.
  const dir = project(box, { profileDir: join(box.dir, 'elsewhere', '.claude-x') })
  herdrWith(box, dir)
  const b = await board(box, { profiles })
  const refused = await b.archive()
  assert.equal(refused.status, 409)
  assert.match(
    String(refused.body.error),
    /^Its Claude profile is not known \(.*\.claude-x\): it could not come back from the archive in the right account$/,
  )
  assert.equal(record(box), null)

  // Records the board can no longer place: a folder no profile has, a profile no longer listed,
  // one that ran in another profile than its start asked for.
  const now = Date.now()
  const base = {
    key: S,
    session: S,
    name: 'Probe card',
    category: 'personal',
    cwd: dir,
    workspace: 'Personal',
    workspaceId: 'wP',
    pane: 'wP:p1',
    state: 'archived',
    closeAt: now,
    closedAt: now,
    archivedAt: now,
    held: [],
  }
  mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
  herdrWith(box, dir, { gone: true })
  for (const facts of [
    { profile: null, profileFolder: join(box.dir, 'elsewhere', '.claude-x') },
    { profile: 'gamedev' },
    { profile: 'default', profileWanted: 'work' },
  ]) {
    writeFileSync(archiveFile(box), JSON.stringify({ ...base, ...facts }))
    const r = await b.post('/api/archive', { op: 'return', keys: [S] })
    assert.equal(r.status, 409, JSON.stringify(facts))
    assert.match(
      String(r.body.error),
      new RegExp(
        `^“Probe card” stays in the archive: the board cannot be sure which Claude profile it ran in \\(.+\\), and it never resumes a session in a guessed one\\. Resume it yourself in its profile: claude --resume ${S}$`,
      ),
    )
    // Still in the archive, nothing on its way back.
    const rec = record(box)
    assert.equal(rec?.state, 'archived')
    assert.equal('returning' in (rec ?? {}), false)
  }
  assert.match(
    String((await b.post('/api/archive', { op: 'return', keys: [S] })).body.error),
    /\(Wrong profile: started for Work\)/,
  )
  startedNothing(box)
}, 30_000)

test('Return looks for the conversation in its profile’s folder only: a work session whose transcript is in ~/.claude is refused', async () => {
  const box = await sandbox()
  const { profiles } = twoProfiles(box)
  // The card says work, the conversation is in the default folder (copied there, say).
  const dir = project(box, {}, '.claude')
  const now = Date.now()
  const rec = {
    key: S,
    session: S,
    name: 'Probe card',
    category: 'personal',
    cwd: dir,
    workspace: 'Personal',
    workspaceId: 'wP',
    pane: 'wP:p1',
    state: 'archived',
    closeAt: now,
    archivedAt: now,
    held: [],
    profile: 'work',
  }
  mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
  writeFileSync(archiveFile(box), JSON.stringify(rec))
  herdrWith(box, dir, { gone: true })
  const b = await board(box, { profiles })
  const elsewhere = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(elsewhere.status, 409)
  assert.match(String(elsewhere.body.error), /stays in the archive: the board cannot be sure .* \(Work\)/)
  // In no profile's folder at all: upstream's own reason.
  writeFileSync(archiveFile(box), JSON.stringify({ ...rec, session: OTHER }))
  const none = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(none.status, 409)
  assert.equal(none.body.error, '“Probe card” cannot come back: its conversation is not on this computer any more')
  startedNothing(box)
  assert.equal(record(box)?.state, 'archived')
}, 30_000)

// ---------------------------------------------------------------- Return through each launcher

/** S in the archive, its pane closed, its conversation in ~/.claude; herdr ready for a resume. */
function archived(box: Sandbox): string {
  const dir = project(box)
  const now = Date.now()
  mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
  writeFileSync(
    archiveFile(box),
    JSON.stringify({
      key: S,
      session: S,
      name: 'Probe card',
      category: 'personal',
      cwd: dir,
      workspace: 'Personal',
      workspaceId: 'wP',
      pane: 'wP:p1',
      state: 'archived',
      closeAt: now,
      closedAt: now,
      archivedAt: now,
      held: [],
      profile: 'default',
    }),
  )
  resumable(box, dir)
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  box.state({ ...state, 'agent start': { result: { type: 'ok' } } })
  return dir
}

type LaunchSeen = { id: string; resume?: string | null; state: string; error: string }
const launchOf = async (b: Awaited<ReturnType<typeof board>>, id: unknown): Promise<LaunchSeen> => {
  let l: LaunchSeen | undefined
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
    l = ((await b.payload()).launches as LaunchSeen[]).find(x => x.id === id)
    if (l && (l.state === 'done' || l.state === 'failed')) return l
  }
  throw new Error(`launch ${String(id)} did not finish: ${JSON.stringify(l)}`)
}
const launcher = join(import.meta.dir, '..', 'support', 'fake-launcher.ts')

test('Return through the configured launcher: launch.command with {resume}; without it the board’s spawn-agent', async () => {
  const box = await sandbox()
  archived(box)
  const seen = join(box.dir, 'launcher.json')
  const command = [
    process.execPath,
    launcher,
    seen,
    '-Name',
    '{name}',
    ['-Resume', '{resume}'],
    ['-SessionId', '{sessionId}'],
  ]
  const b = await board(box, { launch: { command } })
  const r = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const l = await launchOf(b, r.body.done?.[0]?.launch)
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.resume, S)
  // Its id, and no new one: the session is resumed, not started.
  assert.deepEqual((JSON.parse(readFileSync(seen, 'utf8')) as { args: string[] }).args, [
    '-Name',
    'Probe card',
    '-Resume',
    S,
  ])
  expect(cardOf(box)).toMatchObject({ name: 'Probe card', category: 'personal', profileWant: 'default' })

  // A launch.command that does not take {resume}: the board's own spawn-agent resumes it.
  const box2 = await sandbox()
  archived(box2)
  const seen2 = join(box2.dir, 'launcher.json')
  const b2 = await board(box2, { launch: { command: [process.execPath, launcher, seen2, '-Name', '{name}'] } })
  const r2 = await b2.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  const l2 = await launchOf(b2, r2.body.done?.[0]?.launch)
  assert.equal(l2.state, 'done', l2.error)
  assert.ok(calls(box2).includes(`pane run wP:p9 claude --resume ${S}`), calls(box2).join('\n'))
  assert.equal(existsSync(seen2), false)
}, 60_000)

test('Return through launch.agent: herdr starts Claude by its id, unnamed; arguments that pick a session refuse it before anything starts', async () => {
  const box = await sandbox()
  archived(box)
  const b = await board(box, { launch: { agent: 'claude', args: ['--model', 'opus'] } })
  const r = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const l = await launchOf(b, r.body.done?.[0]?.launch)
  assert.equal(l.state, 'done', l.error)
  const start = calls(box).find(c => c.startsWith('agent start'))
  assert.match(start ?? '', new RegExp(`--kind claude --pane wP:p9 .* -- --model opus --resume ${S}$`))
  assert.equal(
    calls(box).some(c => c.startsWith('agent prompt')),
    false,
  )

  const box2 = await sandbox()
  archived(box2)
  const b2 = await board(box2, { launch: { agent: 'claude', args: ['--continue'] } })
  const no = await b2.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(no.status, 409)
  assert.equal(
    no.body.error,
    'The board starts sessions with launch.agent here, and its arguments pick the session: it cannot resume one that way',
  )
  startedNothing(box2)
  const rec = record(box2)
  assert.equal(rec?.state, 'archived')
  assert.equal('returning' in (rec ?? {}), false)
}, 60_000)

test('board archive reads the target’s registry in its own profile, not in the command’s own folder', async () => {
  const box = await sandbox()
  const { work } = twoProfiles(box, { language: 'en', port: 9, wakeUrl: null, categories: CATEGORIES })
  const dir = project(box, { profile: 'work', profileDir: work }, '.claude-work')
  // In work's registry, a background command still runs in S; the default one knows nothing of it.
  mkdirSync(join(work, 'sessions'), { recursive: true })
  writeFileSync(
    join(work, 'sessions', '1.json'),
    JSON.stringify({ sessionId: S, kind: 'interactive', pid: process.pid, status: 'shell' }),
  )
  herdrWith(box, dir)
  const out = await box.run('cli', { args: ['archive', '--session', S], env: { CLAUDE_CODE_SESSION_ID: OTHER } }).exited
  assert.equal(out.code, 1)
  assert.match(
    `${out.stdout}${out.stderr}`,
    /Probe card stays on the board: a background command or Monitor runs in it/,
  )
  assert.equal(record(box), null)
}, 30_000)

test('board archive says why a profile refuses it in English, whatever language the board speaks', async () => {
  const box = await sandbox()
  twoProfiles(box, { language: 'ru', port: 9, wakeUrl: null, categories: CATEGORIES })
  const cli = async () => {
    const out = await box.run('cli', { args: ['archive', '--session', S], env: { CLAUDE_CODE_SESSION_ID: OTHER } })
      .exited
    return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
  }
  // No profile named and two shown: the board cannot tell which one it runs in.
  const dir = project(box)
  herdrWith(box, dir)
  const unknown = await cli()
  assert.equal(unknown.code, 1)
  assert.match(
    unknown.out,
    /Probe card stays on the board: its Claude profile is not known \(unknown profile\): it could not come back from the archive in the right account/,
  )
  assert.doesNotMatch(unknown.out, /[а-яё]/i)
  // Started for Private, running in Work.
  project(box, { profileDir: join(box.env.HOME as string, '.claude-work'), profileWant: 'default' }, '')
  const wrong = await cli()
  assert.equal(wrong.code, 1)
  assert.match(
    wrong.out,
    /Probe card stays on the board: its Claude profile is not known \(Wrong profile: started for Private\)/,
  )
  assert.doesNotMatch(wrong.out, /[а-яё]/i)
  assert.equal(record(box), null)
  startedNothing(box)
}, 30_000)

test('the page’s own calls (web/src/api/client.ts) against these routes: archive, its list, the board’s log, Return, Remove', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  boardConfig(box, { launch: { claude: ['claude-tg', '--dangerously-skip-permissions'] } })
  const b = await board(box, { archiveUndoSec: 1.5 })
  // The page asks its own board by path: here, this one.
  const realFetch = globalThis.fetch
  const toBoard = (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? `${b.url}${input}` : input, init)
  globalThis.fetch = Object.assign(toBoard, { preconnect: realFetch.preconnect })
  try {
    const t = translator('en')
    // Archive, as a card's menu or a drop asks it; then the session gets to work in the undo time.
    const first = await archiveApi.post('archive', [S], t)
    assert.deepEqual(
      [first.ok, first.failed, first.done.map(d => [d.key, d.name, d.held, typeof d.closeAt])],
      [true, [], [[S, 'Probe card', 1, 'number']]],
    )
    herdrWith(box, dir, { status: 'working' })
    await until(() => archiveLog(box).some(e => e.result === 'kept'), 10_000)
    await b.refresh()
    // The board as the page takes it, and its log as the page's toast reads it.
    const kept = await b.payload()
    assert.ok(isBoardPayload(kept))
    const notes = archiveNotes(kept.archive?.log ?? [], new Set(), key => (key === S ? 'Probe card' : undefined), t)
    assert.deepEqual(notes.toasts, ['“Probe card” stayed on the board: it is working; it can go once its turn is over'])

    // Free again: archived, its tab closed once the time is up; the list as the panel reads it.
    herdrWith(box, dir)
    await b.refresh()
    assert.equal((await archiveApi.post('archive', [S], t)).ok, true)
    await until(() => record(box)?.state === 'archived', 10_000)
    const listing = await archiveApi.list()
    assert.deepEqual(
      listing.records.map(r => [r.key, r.name, r.category, r.state, r.held, r.returning]),
      [[S, 'Probe card', 'personal', 'archived', 1, false]],
    )
    assert.equal(listing.undoMs, 1500)

    // Return from the list: resumed in a new tab; the board's launch says it is one coming back.
    resumable(box, dir)
    await b.refresh()
    const back = await archiveApi.post('return', [S], t)
    assert.deepEqual([back.ok, back.done.map(d => [d.key, d.name, d.resume])], [true, [[S, 'Probe card', true]]])
    await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')), 15_000)
    const returning = await b.payload()
    assert.ok(isBoardPayload(returning))
    assert.deepEqual(
      returning.launches.map(l => l.resume),
      [S],
    )
    assert.equal((await archiveApi.list()).records[0]?.returning, true)

    // Remove of one not in the archive: refused, with the board's own words.
    const gone = await archiveApi.post('remove', [OTHER], t)
    assert.deepEqual(
      [gone.ok, gone.done, gone.failed.map(f => f.key), gone.error],
      [false, [], [OTHER], 'It is not in the archive any more'],
    )
  } finally {
    globalThis.fetch = realFetch
  }
}, 60_000)

test('#295: the list carries the parked entries with their due time; the page unschedules one and moves one to a session on the board', async () => {
  const box = await sandbox()
  const dir = project(box)
  // ben, another Claude session on the board, in a tab of its own.
  const ben = {
    pane_id: 'wP:p4',
    tab_id: 'wP:t4',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: OTHER },
    agent_status: 'idle',
    cwd: join(box.dir, 'ben'),
  }
  writeFileSync(join(box.cards, `${OTHER}.json`), JSON.stringify({ key: OTHER, name: 'ben', category: 'other' }))
  herdrWith(box, dir, { extra: [ben] })
  schedule(box)
  const b = await board(box, { archiveUndoSec: 0.5 })
  assert.equal((await b.archive()).body.ok, true)
  await until(() => record(box)?.state === 'archived', 10_000)
  // A repeating one whose last run came due while it waited: Return would put it back at its next run.
  const held = record(box) as Rec
  const rep = { id: 'fed789', key: S, name: 'Probe', pane: 'wP:p1', next: Date.now() - 3600e3, cron: '0 9 * * *' }
  // And one whose rule has no run left (30 February): Return drops it, Move cannot take it.
  const ended = { ...rep, id: 'eee000', cron: '0 0 30 2 *', text: 'never again' }
  writeFileSync(archiveFile(box), JSON.stringify({ ...held, held: [...held.held, { ...rep, text: 'standup' }, ended] }))
  await b.refresh()
  const realFetch = globalThis.fetch
  const toBoard = (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? `${b.url}${input}` : input, init)
  globalThis.fetch = Object.assign(toBoard, { preconnect: realFetch.preconnect })
  try {
    const t = translator('en')
    const [rec] = (await archiveApi.list()).records
    assert.equal(rec?.held, 3)
    const parked = new Map((rec?.parked ?? []).map(e => [e.id, e]))
    assert.deepEqual([...parked.keys()].sort(), ['abc123', 'eee000', 'fed789'])
    assert.equal(parked.get('eee000')?.due, null)
    assert.equal(parked.get('abc123')?.text, 'check the CI')
    assert.equal(parked.get('abc123')?.cron, undefined)
    const due = parked.get('fed789')?.due ?? 0
    assert.equal(parked.get('fed789')?.cron, '0 9 * * *')
    assert.ok(due > Date.now() && new Date(due).getHours() === 9, String(due))

    // Only from the board's own page; a wrong op, another session's key, an id no record holds.
    const send = (body: unknown, headers: Record<string, string>) =>
      realFetch(`${b.url}/api/archive/held`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    const drop = { op: 'drop', key: S, id: 'abc123' }
    assert.equal((await send(drop, {})).status, 403)
    assert.equal((await send(drop, { 'x-board': '1', origin: 'http://evil.example' })).status, 403)
    assert.equal((await send({ ...drop, op: 'nope' }, { 'x-board': '1' })).status, 400)
    assert.equal((await send({ ...drop, key: OTHER }, { 'x-board': '1' })).status, 404)
    assert.deepEqual(await archiveApi.held({ op: 'drop', key: S, id: 'nope42' }, t), {
      ok: false,
      name: '',
      error: 'That reminder is not in the archive any more',
    })
    assert.equal(record(box)?.held.length, 3)

    // Unschedule: out of the record for good, nothing in the schedule.
    assert.deepEqual(await archiveApi.held({ op: 'drop', key: S, id: 'ABC123' }, t), { ok: true, name: '', error: '' })
    assert.deepEqual(
      record(box)?.held.map(e => e.id),
      ['fed789', 'eee000'],
    )
    assert.equal(existsSync(entryFile(box, 'abc123')), false)

    // Move: to a session not on the board (the archived one itself), refused; to ben, into its schedule.
    const nowhere = await archiveApi.held({ op: 'move', key: S, id: 'fed789', to: S }, t)
    assert.deepEqual([nowhere.ok, nowhere.error], [false, 'The session is no longer on the board'])
    const moved = await archiveApi.held({ op: 'move', key: S, id: 'fed789', to: OTHER }, t)
    assert.deepEqual(moved, { ok: true, name: 'ben', error: '' })
    const entry = JSON.parse(readFileSync(entryFile(box, 'fed789'), 'utf8'))
    assert.deepEqual(
      [entry.key, entry.name, entry.pane, entry.cwd, entry.next, entry.cron, entry.text, entry.from?.key],
      [OTHER, 'ben', 'wP:p4', ben.cwd, due, '0 9 * * *', 'standup', S],
    )
    assert.deepEqual(
      record(box)?.held.map(e => e.id),
      ['eee000'],
    )
    // One that runs no more does not move; Unschedule takes it, and the record lists none.
    const never = await archiveApi.held({ op: 'move', key: S, id: 'eee000', to: OTHER }, t)
    assert.deepEqual([never.ok, never.error], [false, 'It runs no more: there is nothing to move'])
    assert.equal(existsSync(entryFile(box, 'eee000')), false)
    assert.equal((await archiveApi.held({ op: 'drop', key: S, id: 'eee000' }, t)).ok, true)
    assert.deepEqual(record(box)?.held, [])
    assert.equal((await archiveApi.list()).records[0]?.parked, undefined)
    const again = await archiveApi.held({ op: 'move', key: S, id: 'fed789', to: OTHER }, t)
    assert.equal(again.ok, false)
  } finally {
    globalThis.fetch = realFetch
  }
}, 60_000)

test('Return of a moved Claude session resumes in its target folder before and after local turns (#621)', async () => {
  const setupMovedArchive = (box: Sandbox, nodeDir: string, recCwd: string, lines: Record<string, unknown>[]) => {
    const projects = join(box.env.HOME as string, '.claude', 'projects', projectFolderName(nodeDir))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${S}.jsonl`), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(join(box.cards, `${S}.json`), JSON.stringify({ key: S, name: 'Probe card', category: 'personal' }))
    const now = Date.now()
    mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
    writeFileSync(
      archiveFile(box),
      JSON.stringify({
        key: S,
        session: S,
        name: 'Probe card',
        category: 'personal',
        cwd: recCwd,
        workspace: 'Personal',
        workspaceId: 'wP',
        pane: 'wP:p1',
        state: 'archived',
        closeAt: now,
        closedAt: now,
        archivedAt: now,
        held: [],
        profile: 'default',
      }),
    )
    resumable(box, nodeDir)
  }

  // Subcase A: freshly moved session before any new turn on target (only foreign source cwd in transcript).
  const boxA = await sandbox()
  const nodeDirA = join(boxA.dir, 'atlas проект 100%')
  mkdirSync(nodeDirA, { recursive: true })
  setupMovedArchive(boxA, nodeDirA, nodeDirA, [
    {
      type: 'user',
      cwd: 'C:\\Work\\atlas',
      sessionId: S,
      message: { role: 'user', content: 'from source' },
      timestamp: new Date().toISOString(),
    },
  ])
  const bA = await board(boxA)
  try {
    const rA = await bA.post('/api/archive', { op: 'return', keys: [S] })
    assert.equal(rA.status, 200, JSON.stringify(rA.body))
    assert.equal(rA.body.done?.[0]?.resume, true, JSON.stringify(rA.body))
    await until(() => calls(boxA).some(c => c.startsWith('pane run wP:p9')), 15_000)
    assert.ok(
      calls(boxA).includes(`tab create --workspace wP --cwd ${nodeDirA} --label Probe card --no-focus`),
      calls(boxA).join('\n'),
    )
  } finally {
    bA.proc.kill()
    await bA.proc.exited
  }

  // Subcase B: moved session after a local turn, archived while pane was in a subdirectory.
  const boxB = await sandbox()
  const nodeDirB = join(boxB.dir, 'atlas проект 100%')
  const subDirB = join(nodeDirB, 'sub')
  mkdirSync(subDirB, { recursive: true })
  setupMovedArchive(boxB, nodeDirB, subDirB, [
    {
      type: 'user',
      cwd: 'C:\\Work\\atlas',
      sessionId: S,
      message: { role: 'user', content: 'from source' },
      timestamp: new Date().toISOString(),
    },
    {
      type: 'user',
      cwd: nodeDirB,
      sessionId: S,
      message: { role: 'user', content: 'on node' },
      timestamp: new Date().toISOString(),
    },
  ])
  const bB = await board(boxB)
  try {
    const rB = await bB.post('/api/archive', { op: 'return', keys: [S] })
    assert.equal(rB.status, 200, JSON.stringify(rB.body))
    assert.equal(rB.body.done?.[0]?.resume, true, JSON.stringify(rB.body))
    await until(() => calls(boxB).some(c => c.startsWith('pane run wP:p9')), 15_000)
    assert.ok(
      calls(boxB).includes(`tab create --workspace wP --cwd ${nodeDirB} --label Probe card --no-focus`),
      calls(boxB).join('\n'),
    )
  } finally {
    bB.proc.kill()
    await bB.proc.exited
  }
}, 60_000)

test('Return of an unmoved Claude session archived from a subdirectory still resumes in its transcript’s first cwd', async () => {
  const box = await sandbox()
  const dir = project(box)
  const sub = join(dir, 'sub')
  mkdirSync(sub, { recursive: true })
  const now = Date.now()
  mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
  writeFileSync(
    archiveFile(box),
    JSON.stringify({
      key: S,
      session: S,
      name: 'Probe card',
      category: 'personal',
      cwd: sub,
      workspace: 'Personal',
      workspaceId: 'wP',
      pane: 'wP:p1',
      state: 'archived',
      closeAt: now,
      closedAt: now,
      archivedAt: now,
      held: [],
      profile: 'default',
    }),
  )
  resumable(box, dir)
  const b = await board(box)
  try {
    const r = await b.post('/api/archive', { op: 'return', keys: [S] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.done?.[0]?.resume, true, JSON.stringify(r.body))
    await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')), 15_000)
    assert.ok(
      calls(box).includes(`tab create --workspace wP --cwd ${dir} --label Probe card --no-focus`),
      calls(box).join('\n'),
    )
  } finally {
    b.proc.kill()
    await b.proc.exited
  }
}, 30_000)

test('archive win32 gating: expired Sidebar & renamed sleeping agy/pi (#888)', async () => {
  // 1) Expired Sidebar pane (label: 'Sidebar', no tokens) beside archived session -> tab close on win32, pane close off Windows (origin/main).
  const box = await sandbox()
  const dir = project(box)
  const state = herdrState(dir)
  const panes = (state['pane list'] as { result: { panes: Record<string, unknown>[] } }).result.panes.map(p =>
    p.pane_id === 'wP:p3' ? { pane_id: 'wP:p3', tab_id: 'wP:t1', workspace_id: 'wP', label: 'Sidebar', cwd: dir } : p,
  )
  box.state({
    ...state,
    'pane list': { result: { panes } },
    'api snapshot': {
      result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } },
    },
  })
  const b = await board(box, { archiveUndoSec: 0.5 })
  try {
    assert.equal((await b.archive()).body.ok, true)
    await until(() => record(box)?.state === 'archived', 10_000)
    if (process.platform === 'win32') {
      assert.ok(calls(box).includes('tab close wP:t1'), calls(box).join('\n'))
      assert.equal(
        calls(box).some(c => c.startsWith('pane close ')),
        false,
      )
    } else {
      assert.ok(calls(box).includes('pane close wP:p1'), calls(box).join('\n'))
      assert.equal(
        calls(box).some(c => c.startsWith('tab close ')),
        false,
      )
    }
  } finally {
    b.proc.kill()
    await b.proc.exited
  }

  // 2) Unit check of freeToClose & tabPanes on win32 vs linux (subprocess so HERDR_BIN_PATH is read at module load).
  const box2 = await sandbox()
  const dir2 = project(box2)
  const st2 = herdrState(dir2, { asleep: true, label: '💤 Custom Agy Name' })
  const panesWithExpiredSidebar = (
    st2['pane list'] as { result: { panes: Record<string, unknown>[] } }
  ).result.panes.map(p =>
    p.pane_id === 'wP:p3' ? { pane_id: 'wP:p3', tab_id: 'wP:t1', workspace_id: 'wP', label: 'Sidebar' } : p,
  )
  box2.state({ ...st2, 'pane list': { result: { panes: panesWithExpiredSidebar } } })
  const probeScript = join(box2.dir, 'probe-free.ts')
  writeFileSync(
    probeScript,
    `
import { translator } from ${JSON.stringify(join(import.meta.dir, '../../src/core/i18n/translator.ts'))}
import { freeToClose, tabPanes } from ${JSON.stringify(join(import.meta.dir, '../../src/services/archive.ts'))}
import { defaultDeps } from ${JSON.stringify(join(import.meta.dir, '../../src/services/deps.ts'))}
const deps = defaultDeps({} as never)
const agy = {
  key: ${JSON.stringify(S)},
  session: ${JSON.stringify(S)},
  name: 'Custom Agy Name',
  autoName: 'Original Auto',
  category: 'personal',
  agent: 'agy',
  pane: 'wP:p1',
} as never
const pi = {
  key: ${JSON.stringify(S)},
  session: ${JSON.stringify(S)},
  name: 'Custom Agy Name',
  autoName: 'Original Auto',
  category: 'personal',
  agent: 'pi',
  pane: 'wP:p1',
} as never
const winIdle = await freeToClose(deps, agy, translator('en'), async () => [{ pid: 7, ppid: 1, bytes: 1024, name: 'pwsh' }], 'win32')
const winBusy = await freeToClose(deps, agy, translator('en'), async () => [
  { pid: 7, ppid: 1, bytes: 1024, name: 'pwsh' },
  { pid: 99, ppid: 7, bytes: 1024, name: 'node' },
], 'win32')
const winPiIdle = await freeToClose(deps, pi, translator('en'), async () => [{ pid: 7, ppid: 1, bytes: 1024, name: 'pwsh' }], 'win32')
const linuxAgy = await freeToClose(deps, agy, translator('en'), null, 'linux')
const linuxPi = await freeToClose(deps, pi, translator('en'), null, 'linux')
const winTab = await tabPanes('wP', 'wP:t1', 'win32')
const linuxTab = await tabPanes('wP', 'wP:t1', 'linux')
console.log(JSON.stringify({ winIdle: winIdle.ok, winBusy, winPiIdle: winPiIdle.ok, linuxAgy, linuxPi, winTab, linuxTab }))
`,
  )
  const proc = Bun.spawn([process.execPath, probeScript], { env: box2.env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(await proc.exited, 0, err)
  const parsed = JSON.parse(out.trim())
  assert.deepEqual(
    {
      winIdle: parsed.winIdle,
      winBusy: parsed.winBusy,
      winPiIdle: parsed.winPiIdle,
      linuxAgy: parsed.linuxAgy,
      linuxPi: parsed.linuxPi,
    },
    {
      winIdle: true,
      winBusy: { ok: false, why: 'archive.why.shellBusy' },
      winPiIdle: true,
      linuxAgy: { ok: false, why: 'archive.why.exited' },
      linuxPi: { ok: false, why: 'archive.why.exited' },
    },
  )
  assert.equal(parsed.winTab.find((p: { pane: string }) => p.pane === 'wP:p3')?.plugin, true)
  assert.equal(parsed.linuxTab.find((p: { pane: string }) => p.pane === 'wP:p3')?.plugin, false)
}, 30_000)

test('#807 dueAgain uses the given zone for past-due repeating entries, and host local time without one', () => {
  const other = localZone() === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
  const now = Date.now()
  const base = {
    id: 'rep807',
    key: S,
    name: 'Probe',
    next: now - 3600e3,
    cron: '57 7 * * *',
    text: 'monitor',
  }
  const zoned = dueAgain(base, now, other)
  assert.ok(zoned !== null && zoned > now)
  assert.deepEqual(clockIn(zoned, other), [7, 57, 0])

  const local = dueAgain(base, now)
  assert.ok(local !== null && local > now)
  assert.deepEqual([new Date(local).getHours(), new Date(local).getMinutes()], [7, 57])

  const future = { ...base, next: now + 3600e3 }
  assert.equal(dueAgain(future, now, other), future.next)
  const once = { id: 'one807', key: S, name: 'Probe', next: now - 60_000, text: 'once' }
  assert.equal(dueAgain(once, now, other), once.next)
  assert.equal(dueAgain(once, now), once.next)
  const ended = { ...base, cron: '0 0 30 2 *' }
  assert.equal(dueAgain(ended, now, other), null)
  assert.equal(dueAgain(ended, now), null)
})

test('#807 archive list, move, Return and kept-on-board compute repeating next run in time.zone (and host time without it)', async () => {
  const other = localZone() === 'Pacific/Kiritimati' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati'
  const kill = async (b: Awaited<ReturnType<typeof board>>) => {
    b.proc.kill()
    await b.proc.exited
  }
  const benPane = (dir: string) => ({
    pane_id: 'wP:p4',
    tab_id: 'wP:t4',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: OTHER },
    agent_status: 'idle',
    cwd: dir,
  })
  const heldPair = (now: number) => [
    { id: 'aaa807', key: S, name: 'Probe', pane: 'wP:p1', next: now - 3600e3, cron: '57 7 * * *', text: 'move me' },
    { id: 'bbb807', key: S, name: 'Probe', pane: 'wP:p1', next: now - 3600e3, cron: '57 7 * * *', text: 'return me' },
  ]

  // 1) With time.zone: GET /api/archive, POST /api/archive/held (move), and Return after pane close (settleReturned).
  const box1 = await sandbox()
  const dir1 = project(box1)
  writeFileSync(join(box1.cards, `${OTHER}.json`), JSON.stringify({ key: OTHER, name: 'ben', category: 'other' }))
  herdrWith(box1, dir1, { extra: [benPane(join(box1.dir, 'ben'))] })
  boardConfig(box1, { time: { zone: other } })
  const b1 = await board(box1, { archiveUndoSec: 0.4, time: { zone: other } })
  try {
    assert.equal((await b1.archive()).body.ok, true)
    await until(() => record(box1)?.state === 'archived', 10_000)
    const now1 = Date.now()
    const rec1 = record(box1) as Rec
    writeFileSync(archiveFile(box1), JSON.stringify({ ...rec1, held: heldPair(now1) }))
    await b1.refresh()

    const [listed] = (await b1.list()).records
    const parked = (listed?.parked ?? []) as { id: string; due: number | null }[]
    assert.equal(parked.length, 2)
    for (const p of parked) {
      assert.ok(typeof p.due === 'number' && p.due > now1)
      assert.deepEqual(clockIn(p.due, other), [7, 57, 0])
    }

    const moved = await b1.post('/api/archive/held', { op: 'move', key: S, id: 'aaa807', to: OTHER })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    const movedEntry = JSON.parse(readFileSync(entryFile(box1, 'aaa807'), 'utf8'))
    assert.ok(movedEntry.next > now1)
    assert.deepEqual(clockIn(movedEntry.next, other), [7, 57, 0])

    resumable(box1, dir1)
    await b1.refresh()
    const ret1 = await b1.post('/api/archive', { op: 'return', keys: [S] })
    assert.equal(ret1.status, 200, JSON.stringify(ret1.body))
    await until(() => calls(box1).some(c => c.startsWith('pane run wP:p9')), 15_000)
    box1.state({
      ...JSON.parse(readFileSync(box1.env.FAKE_HERDR_STATE as string, 'utf8')),
      'api snapshot': {
        result: {
          snapshot: { panes: [FRESH(dir1)], tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] },
        },
      },
    })
    await b1.refresh()
    await until(() => record(box1) === null, 10_000)
    const restored1 = JSON.parse(readFileSync(entryFile(box1, 'bbb807'), 'utf8'))
    assert.ok(restored1.next > now1)
    assert.deepEqual(clockIn(restored1.next, other), [7, 57, 0])
  } finally {
    await kill(b1)
  }

  // 2) With time.zone: Return during the undo toast (state === 'closing' -> takeBack -> putBack).
  const box2 = await sandbox()
  const dir2 = project(box2)
  herdrWith(box2, dir2)
  const b2 = await board(box2, { archiveUndoSec: 30, time: { zone: other } })
  try {
    assert.equal((await b2.archive()).body.ok, true)
    const now2 = Date.now()
    const rec2 = record(box2) as Rec
    assert.equal(rec2.state, 'closing')
    writeFileSync(
      archiveFile(box2),
      JSON.stringify({
        ...rec2,
        held: [
          { id: 'ccc807', key: S, name: 'Probe', pane: 'wP:p1', next: now2 - 3600e3, cron: '57 7 * * *', text: 'undo' },
        ],
      }),
    )
    const back2 = await b2.post('/api/archive', { op: 'return', keys: [S] })
    assert.equal(back2.status, 200, JSON.stringify(back2.body))
    assert.equal(record(box2), null)
    const restored2 = JSON.parse(readFileSync(entryFile(box2, 'ccc807'), 'utf8'))
    assert.ok(restored2.next > now2)
    assert.deepEqual(clockIn(restored2.next, other), [7, 57, 0])
  } finally {
    await kill(b2)
  }

  // 3) With time.zone: Close called off by scheduler when session becomes busy (closeDue -> keep -> putBack).
  const box3 = await sandbox()
  const dir3 = project(box3)
  herdrWith(box3, dir3)
  const b3 = await board(box3, { archiveUndoSec: 0.3, scheduleTickSec: 0.1, time: { zone: other } })
  try {
    assert.equal((await b3.archive()).body.ok, true)
    const now3 = Date.now()
    const rec3 = record(box3) as Rec
    writeFileSync(
      archiveFile(box3),
      JSON.stringify({
        ...rec3,
        held: [
          { id: 'ddd807', key: S, name: 'Probe', pane: 'wP:p1', next: now3 - 3600e3, cron: '57 7 * * *', text: 'kept' },
        ],
      }),
    )
    herdrWith(box3, dir3, { status: 'working' })
    await until(() => record(box3) === null && existsSync(entryFile(box3, 'ddd807')), 10_000)
    const restored3 = JSON.parse(readFileSync(entryFile(box3, 'ddd807'), 'utf8'))
    assert.ok(restored3.next > now3)
    assert.deepEqual(clockIn(restored3.next, other), [7, 57, 0])
  } finally {
    await kill(b3)
  }

  // 4) Without time.zone: list, move, and Return after pane close keep host local time.
  const box4 = await sandbox()
  const dir4 = project(box4)
  writeFileSync(join(box4.cards, `${OTHER}.json`), JSON.stringify({ key: OTHER, name: 'ben', category: 'other' }))
  herdrWith(box4, dir4, { extra: [benPane(join(box4.dir, 'ben'))] })
  const b4 = await board(box4, { archiveUndoSec: 0.4 })
  try {
    assert.equal((await b4.archive()).body.ok, true)
    await until(() => record(box4)?.state === 'archived', 10_000)
    const now4 = Date.now()
    const rec4 = record(box4) as Rec
    writeFileSync(archiveFile(box4), JSON.stringify({ ...rec4, held: heldPair(now4) }))
    await b4.refresh()

    const [listed4] = (await b4.list()).records
    const parked4 = (listed4?.parked ?? []) as { id: string; due: number | null }[]
    for (const p of parked4) {
      assert.ok(typeof p.due === 'number' && p.due > now4)
      assert.deepEqual([new Date(p.due).getHours(), new Date(p.due).getMinutes()], [7, 57])
    }

    const moved4 = await b4.post('/api/archive/held', { op: 'move', key: S, id: 'aaa807', to: OTHER })
    assert.equal(moved4.status, 200, JSON.stringify(moved4.body))
    const movedEntry4 = JSON.parse(readFileSync(entryFile(box4, 'aaa807'), 'utf8'))
    assert.deepEqual([new Date(movedEntry4.next).getHours(), new Date(movedEntry4.next).getMinutes()], [7, 57])

    resumable(box4, dir4)
    await b4.refresh()
    assert.equal((await b4.post('/api/archive', { op: 'return', keys: [S] })).status, 200)
    await until(() => calls(box4).some(c => c.startsWith('pane run wP:p9')), 15_000)
    box4.state({
      ...JSON.parse(readFileSync(box4.env.FAKE_HERDR_STATE as string, 'utf8')),
      'api snapshot': {
        result: {
          snapshot: { panes: [FRESH(dir4)], tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] },
        },
      },
    })
    await b4.refresh()
    await until(() => record(box4) === null, 10_000)
    const restored4 = JSON.parse(readFileSync(entryFile(box4, 'bbb807'), 'utf8'))
    assert.deepEqual([new Date(restored4.next).getHours(), new Date(restored4.next).getMinutes()], [7, 57])
  } finally {
    await kill(b4)
  }
}, 60_000)
