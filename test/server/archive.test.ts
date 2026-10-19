// The archive against the fake herdr: a session taken off the board has its tab closed a few
// seconds later (Return in the page's toast puts it back as it was), and comes back later resumed
// by its id in a new tab. These run the server, its scheduler and the board command (ported from
// upstream's test/archive.test.mjs at 2b9e6b7; its rules: test/core/archive.test.ts). With more
// than one Claude profile, a session is archived only when the board can tell its profile, and
// Return resumes it in that profile or not at all.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tidyList } from '../../src/core/archive.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
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
  const { label = asleep ? '💤 Probe' : '', extra = [] } = opts
  const pane = {
    pane_id: 'wP:p1',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    agent: asleep ? null : 'claude',
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
        agent: asleep || gone ? null : { agent: 'claude', agent_status: status, agent_session: { value: S } },
      },
    },
    'agent read': { text: screen(typed) },
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

async function board(box: Sandbox, cfg: Record<string, unknown> = {}) {
  const port = await unusedPort()
  const proc: Child = box.run('server', {
    port,
    categories: CATEGORIES,
    wakeUrl: null,
    refreshSec: 3600,
    language: 'en',
    scheduleTickSec: 0.2,
    archiveUndoSec: 30,
    ...cfg,
  })
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

test('Return after the tab closed resumes it by its id in a new tab, in its folder and workspace, with its name; then it is settled', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  // spawn-agent reads how Claude starts from the board's config.json.
  boardConfig(box, { launch: { claude: ['claude-tg', '--dangerously-skip-permissions'] } })
  const b = await board(box, { archiveUndoSec: 0.2 })
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
    assert.equal(record(box), null)
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
