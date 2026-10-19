import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { archiveBlock, heldEntries, searchArchive, tidyList } from '../web/archive-model.js'
import { translator } from '../web/i18n.js'
import { cardMenu, columnMenu, laneMenu } from '../web/menu-model.js'
import { commandArgs } from '../src/launch.mjs'
import { sandbox, until } from './fixtures/sandbox.mjs'

// The archive: a session taken off the board has its tab closed a few seconds later (Return in
// the page's toast puts it back as it was), and comes back later resumed by its id in a new tab.
// The rules are pure (web/archive-model.js); the rest runs the server, its scheduler and the board
// command against the fake herdr.
const t = translator('en')
const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DAY = 86_400_000

// ---------------------------------------------------------------- the rules

test('what may go to the archive, and why not', () => {
  const it = { key: S, session: S, agent: 'claude', pane: 'wP:p1', status: 'idle' }
  assert.equal(archiveBlock(it), '')
  assert.equal(archiveBlock({ ...it, status: 'done' }), '')
  assert.equal(archiveBlock({ ...it, sleeping: true, status: 'sleeping' }), '')
  assert.equal(archiveBlock({ ...it, status: 'working' }), 'archive.why.working')
  assert.equal(archiveBlock({ ...it, status: 'blocked' }), 'archive.why.dialog')
  assert.equal(archiveBlock({ ...it, helpers: { running: 2 } }), 'archive.why.helpers')
  assert.equal(archiveBlock({ ...it, launch: { state: 'starting' } }), 'archive.why.starting')
  assert.equal(archiveBlock({ ...it, launchOnly: true }), 'archive.why.starting')
  // Return resumes a Claude session by its id: another agent, or none, cannot come back.
  assert.equal(archiveBlock({ ...it, agent: 'codex' }), 'archive.why.notClaude')
  assert.equal(archiveBlock({ ...it, session: null }), 'archive.why.notClaude')
  assert.equal(archiveBlock({ ...it, pane: null }), 'archive.why.noPane')
  // Claude out and coming back in a restart; a report with a receipt that must reach it.
  assert.equal(archiveBlock(it, [{ key: S, kind: 'restart', step: 'wake' }]), 'archive.why.restarting')
  assert.equal(archiveBlock(it, [{ key: S, kind: 'restart' }]), '') // one that only waits goes with it
  assert.equal(archiveBlock(it, [{ key: S, kind: 'call', receipt: { key: 'x' } }]), 'archive.why.report')
  assert.equal(archiveBlock(it, [{ key: OTHER, kind: 'call', receipt: { key: 'x' } }]), '')
  // What waits with it: its reminders and pings, not a restart.
  assert.deepEqual(heldEntries([{ key: S, id: 'a' }, { key: S, id: 'b', kind: 'restart' }, { key: OTHER, id: 'c' }], S).map(e => e.id), ['a'])
})

test('a tidy-up takes the sessions asleep in "Idle" long enough, and the archive is searched by every word', () => {
  const now = Date.now()
  const sleeper = (key, days, extra = {}) => ({ key, session: key, agent: 'claude', pane: `p-${key}`, status: 'sleeping', sleeping: true, column: 'idle', activity: now - days * DAY, ...extra })
  const items = [sleeper('a', 0.5), sleeper('b', 2), sleeper('c', 4), sleeper('d', 9), sleeper('e', 9, { column: 'me' }), { ...sleeper('f', 9), sleeping: false, status: 'idle' }]
  assert.deepEqual(tidyList(items, 0, [], now).map(i => i.key), ['a', 'b', 'c', 'd'])
  assert.deepEqual(tidyList(items, 1, [], now).map(i => i.key), ['b', 'c', 'd'])
  assert.deepEqual(tidyList(items, 3, [], now).map(i => i.key), ['c', 'd'])
  assert.deepEqual(tidyList(items, 7, [], now).map(i => i.key), ['d'])

  const records = [
    { key: 'a', name: 'Invoice fixes', category: 'acme', cwd: 'C:\\Clients\\Acme\\billing', note: 'PR merged', archivedAt: now },
    { key: 'b', name: 'Probe', category: 'personal', cwd: 'C:\\Work\\Personal\\board', note: 'tests green', workspace: 'Personal', archivedAt: now - DAY },
  ]
  const opts = { laneTitle: id => ({ acme: 'Acme Corp', personal: 'Personal' })[id] ?? id, dayText: ms => (ms === now ? 'today' : 'yesterday') }
  assert.deepEqual(searchArchive(records, '', opts).map(r => r.key), ['a', 'b'])
  assert.deepEqual(searchArchive(records, 'acme corp', opts).map(r => r.key), ['a']) // the lane's title
  assert.deepEqual(searchArchive(records, 'billing', opts).map(r => r.key), ['a']) // the folder
  assert.deepEqual(searchArchive(records, 'GREEN', opts).map(r => r.key), ['b']) // the note, any case
  assert.deepEqual(searchArchive(records, 'yesterday probe', opts).map(r => r.key), ['b']) // the day, every word
  assert.deepEqual(searchArchive(records, 'probe acme', opts).map(r => r.key), [])
})

test('menus: Archive on a Claude session’s card, gray with the reason; "Idle" and a lane take their sleeping ones', () => {
  const ctx = { t, canMutate: true, canEdit: true, categories: [], column: 'idle', category: 'other' }
  const it = { key: S, session: S, agent: 'claude', pane: 'wP:p1', cwd: 'C:\\x', status: 'idle', column: 'idle', auto: 'idle' }
  const ids = items => items.filter(i => !i.separator).map(i => i.id)
  assert.deepEqual(ids(cardMenu(it, ctx)).slice(-2), ['archive', 'clear'])
  const gray = cardMenu(it, { ...ctx, archiveWhy: 'archive.why.working' }).find(i => i.id === 'archive')
  assert.equal(gray.disabled, true)
  assert.match(gray.reason, /working/)
  assert.equal(cardMenu(it, { ...ctx, canMutate: false }).find(i => i.id === 'archive').disabled, true)
  assert.equal(cardMenu({ ...it, agent: 'codex' }, ctx).find(i => i.id === 'archive'), undefined)

  const counts = { 0: 5, 1: 4, 3: 2, 7: 0 }
  const idle = columnMenu('idle', { ...ctx, tidyCount: d => counts[d] })
  assert.deepEqual(idle.find(i => i.id === 'tidy').submenu.map(i => [i.id, i.label, i.hint, !!i.disabled]), [
    ['tidy:1', 'Asleep over 1 day', '4', false],
    ['tidy:3', 'Asleep over 3 days', '2', false],
    ['tidy:7', 'Asleep over a week', '0', true],
    ['tidy:0', 'All sleeping ones', '5', false],
  ])
  assert.equal(columnMenu('done', { ...ctx, tidyCount: () => 1 }), null)
  const none = columnMenu('idle', { ...ctx, tidyCount: () => 0 }).find(i => i.id === 'tidy')
  assert.deepEqual([none.disabled, none.reason], [true, 'No session sleeps in “Idle”'])
  assert.equal(columnMenu('idle', { ...ctx, canMutate: false, tidyCount: () => 3 }).find(i => i.id === 'tidy').disabled, true)
  assert.ok(laneMenu({ id: 'acme', title: 'Acme' }, { ...ctx, filter: 'all', tidyCount: d => counts[d] }).find(i => i.id === 'tidy').submenu)
})

// ---------------------------------------------------------------- against the fake herdr

const RULE = '─'.repeat(40)
const screen = (typed = '') => ['● done', RULE, `❯ ${typed}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const stateDir = box => join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board')
const archiveFile = box => join(stateDir(box), 'archive', `${S}.json`)
const record = box => (existsSync(archiveFile(box)) ? JSON.parse(readFileSync(archiveFile(box), 'utf8')) : null)
const archiveLog = box => (existsSync(join(stateDir(box), 'archive', 'log.jsonl')) ? readFileSync(join(stateDir(box), 'archive', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [])
const entryFile = (box, id) => join(stateDir(box), 'schedule', `${id}.json`)
const calls = box => box.calls().map(a => a.join(' '))

/** A project folder with Claude's transcript of S in it, and S's card. */
function project(box, card = {}) {
  const dir = join(box.dir, 'probe')
  mkdirSync(dir, { recursive: true })
  const projects = join(box.env.HOME, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${S}.jsonl`), `${JSON.stringify({ type: 'user', cwd: dir, sessionId: S, message: { role: 'user', content: 'run the probe' }, timestamp: new Date().toISOString() })}\n`)
  mkdirSync(join(stateDir(box), 'cards'), { recursive: true })
  writeFileSync(join(stateDir(box), 'cards', `${S}.json`), JSON.stringify({ key: S, name: 'Probe card', category: 'personal', result: 'tests green', ...card }))
  return dir
}

/**
 * herdr with Claude session S in pane wP:p1, or gone. Its tab wP:t1 also holds herdr-sidebar's
 * panel (no agent, the plugin's tokens), and with `shared` a plain shell beside it.
 */
const NOT_FOUND = { code: 'pane_not_found', error: 'pane_not_found: no such pane' }
function herdrWith(box, dir, { status = 'idle', typed = '', shared = false, gone = false, asleep = false, label = asleep ? '💤 Probe' : '', running = false, extra = [] } = {}) {
  const pane = { pane_id: 'wP:p1', tab_id: 'wP:t1', workspace_id: 'wP', agent: asleep ? null : 'claude', agent_session: asleep ? null : { value: S }, agent_status: asleep ? null : status, cwd: dir, terminal_title_stripped: 'Probe', label }
  const sidebar = { pane_id: 'wP:p3', tab_id: 'wP:t1', workspace_id: 'wP', label: 'Sidebar', cwd: dir, tokens: { 'herdr-sidebar-explorer': '1' } }
  const others = [sidebar, ...(shared ? [{ pane_id: 'wP:p2', tab_id: 'wP:t1', workspace_id: 'wP', agent: null, cwd: dir }] : [])]
  const panes = gone ? others : [pane, ...others, ...extra]
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } } },
    // Gone once the board closed it: the board checks that before it calls it archived.
    'pane get': gone ? NOT_FOUND : { until: ['tab close', 'pane close'], then: NOT_FOUND, result: { pane } },
    // A sleeping session's shell runs nothing but itself, unless something was started in it.
    'pane process-info': { result: { process_info: { pane_id: 'wP:p1', shell_pid: 7, foreground_processes: [{ pid: 7, argv: ['pwsh'] }, ...(running ? [{ pid: 8, argv: ['npm', 'run', 'dev'] }] : [])] } } },
    'pane list': { result: { panes } },
    'agent get': { result: { agent: asleep || gone ? null : { agent: 'claude', agent_status: status, agent_session: { value: S } } } },
    'agent read': { text: screen(typed) },
    'tab close': { result: null },
    'pane close': { result: null },
    'workspace list': { result: { workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } },
  })
}

async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const CATEGORIES = [{ id: 'personal', title: 'Personal', color: 'blue' }, { id: 'other', title: 'Other', color: 'gray' }]

async function board(box, cfg = {}) {
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: CATEGORIES, wakeUrl: null, refreshSec: 3600, language: 'en', scheduleTickSec: 0.2, archiveUndoSec: 30, ...cfg })
  await until(() => proc.messages.some(m => m.ready), 10_000)
  const url = `http://127.0.0.1:${port}`
  const payload = async () => (await fetch(`${url}/api/board`)).json()
  // A refresh asked for while another runs is folded into it: wait for one that starts after now.
  const refresh = async () => {
    const before = Date.now()
    proc.send('refresh')
    for (const end = Date.now() + 10_000; ; ) {
      const p = await payload()
      if (p.lastSuccessfulRefreshAt >= before) return
      if (Date.now() > end) throw new Error(`no refresh: ${JSON.stringify(proc.messages.filter(m => m.log))}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  await refresh()
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
  const items = async () => (await (await fetch(`${url}/api/board`)).json()).items.map(i => i.key)
  return { proc, url, refresh, post, items, archive: () => post(`/api/session/${S}/archive`, {}) }
}

/** A reminder for S, and a restart of it on its way. */
function schedule(box) {
  const dir = join(stateDir(box), 'schedule')
  mkdirSync(dir, { recursive: true })
  const later = Date.now() + 3 * 3600e3
  writeFileSync(entryFile(box, 'abc123'), JSON.stringify({ id: 'abc123', key: S, name: 'Probe', pane: 'wP:p1', text: 'check the CI', at: later, next: later, created: Date.now(), by: 'agent' }))
  writeFileSync(entryFile(box, 'def456'), JSON.stringify({ id: 'def456', key: S, name: 'Probe', pane: 'wP:p1', kind: 'restart', idle: true, text: '', at: later, next: later, created: Date.now(), by: 'agent' }))
}

test('Archive takes the card off at once and closes its tab after the undo time; its reminder waits in the record', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
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
  assert.deepEqual([rec.state, rec.name, rec.category, rec.cwd, rec.workspace, rec.workspaceId, rec.pane, rec.tab, rec.note, rec.by], ['closing', 'Probe card', 'personal', dir, 'Personal', 'wP', 'wP:p1', 'wP:t1', 'tests green', 'user'])
  assert.deepEqual(rec.held.map(e => [e.id, e.text]), [['abc123', 'check the CI']])
  assert.equal(calls(box).some(c => c.startsWith('tab close')), false)
  // The scheduler closes the tab (nothing but herdr-sidebar's panel is beside it) once the time is up.
  await until(() => record(box)?.state === 'archived', 10_000)
  assert.ok(calls(box).includes('tab close wP:t1'))
  assert.equal(calls(box).some(c => c.startsWith('pane close')), false)
  assert.deepEqual(archiveLog(box).map(e => e.result), ['closed'])
  // The archive list, as the page reads it: the held entries as a count, no bookkeeping.
  const list = await (await fetch(`${b.url}/api/archive`)).json()
  assert.deepEqual(list.records.map(x => [x.key, x.state, x.held, x.returning, 'claim' in x]), [[S, 'archived', 1, false, false]])
  // The card stays where it was: a session resumed by hand comes back with its name and lane.
  assert.ok(existsSync(join(stateDir(box), 'cards', `${S}.json`)))
})

test('Return before the tab closed puts everything back as it was: the card, the reminder under its id', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  const b = await board(box)
  assert.equal((await b.archive()).body.ok, true)
  const back = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(back.status, 200, JSON.stringify(back.body))
  assert.deepEqual(back.body.done.map(d => [d.key, d.back, !!d.resume]), [[S, true, false]])
  assert.equal(record(box), null)
  assert.equal(JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8')).text, 'check the CI')
  assert.equal(existsSync(entryFile(box, 'def456')), false) // a restart does not come back: a resume would be one
  await b.refresh()
  assert.ok((await b.items()).includes(S))
  assert.equal(calls(box).some(c => /^(tab|pane) close/.test(c)), false)
  // Gone from the archive: a second Return says so.
  const again = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(again.status, 409)
  assert.match(again.body.error, /not in the archive/)
})

test('Return after the tab closed resumes it by its id in a new tab, in its folder and workspace, with its name; then it is settled', { timeout: 40_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  // spawn-agent reads how Claude starts from the board's config.json.
  const cfgDir = join(box.env.APPDATA, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ launch: { claude: ['claude-tg', '--dangerously-skip-permissions'] } }))
  const b = await board(box, { archiveUndoSec: 0.2 })
  assert.equal((await b.archive()).body.ok, true)
  await until(() => record(box)?.state === 'archived', 10_000)
  // The tab is gone; herdr opens a new one for the resume, where Claude comes up idle.
  const fresh = { pane_id: 'wP:p9', tab_id: 'wP:t9', workspace_id: 'wP', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: dir }
  herdrWith(box, dir, { gone: true })
  box.state({
    ...JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE, 'utf8')),
    'tab create': { result: { tab: { tab_id: 'wP:t9' }, root_pane: { pane_id: 'wP:p9' } } },
    'pane run': { result: null },
    'pane get': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'agent list': { result: { agents: [] } },
    'agent rename': { result: null },
  })
  await b.refresh()
  // Two Returns at once (two windows, the toast and the list): one resume, the other hears it is on its way.
  const [r, twice] = await Promise.all([b.post('/api/archive', { op: 'return', keys: [S] }), b.post('/api/archive', { op: 'return', keys: [S] })])
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.done[0].resume, true)
  assert.deepEqual([twice.status, twice.body.done[0].again, !!twice.body.done[0].resume], [200, true, false])
  await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')), 15_000)
  assert.ok(calls(box).includes(`tab create --workspace wP --cwd ${dir} --label Probe card --no-focus`), calls(box).join('\n'))
  assert.ok(calls(box).includes(`pane run wP:p9 claude-tg --dangerously-skip-permissions --resume ${S}`))
  // Resumed, not renamed: Claude keeps the name it had; herdr gets one to address it by.
  await until(() => calls(box).some(c => c.startsWith('agent rename wP:p9')), 15_000)
  assert.equal(calls(box).some(c => c.startsWith('agent prompt')), false)
  // On its way: the page sees the launch (a card "back" in its lane), the record says so.
  const list = await (await fetch(`${b.url}/api/archive`)).json()
  assert.equal(list.records[0].returning, true)
  // herdr shows the session in its new pane: the record goes, the reminder is back with that pane.
  box.state({ ...JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE, 'utf8')), 'api snapshot': { result: { snapshot: { panes: [fresh], tabs: [], workspaces: [{ workspace_id: 'wP', label: 'Personal' }] } } } })
  await b.refresh()
  await until(() => record(box) === null, 10_000)
  const entry = JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8'))
  assert.deepEqual([entry.pane, entry.text], ['wP:p9', 'check the CI'])
  assert.ok((await b.items()).includes(S))
  const card = JSON.parse(readFileSync(join(stateDir(box), 'cards', `${S}.json`), 'utf8'))
  assert.deepEqual([card.name, card.category], ['Probe card', 'personal'])
  assert.deepEqual(archiveLog(box).map(e => e.result), ['closed', 'returned'])
  assert.equal(calls(box).filter(c => c.startsWith('pane run')).length, 1)
})

test('a session that works, waits on a dialog or has a draft stays; one that got to work in the undo time is kept', { timeout: 40_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  schedule(box)
  herdrWith(box, dir, { status: 'working' })
  const b = await board(box, { archiveUndoSec: 1.5 })
  const working = await b.archive()
  assert.equal(working.status, 409)
  assert.match(working.body.error, /It is working/)
  herdrWith(box, dir, { status: 'blocked' })
  await b.refresh()
  assert.match((await b.archive()).body.error, /dialog waits/)
  // herdr says idle, but text waits in its input box: read from the screen, as herdr-wake does.
  herdrWith(box, dir, { typed: 'half a thought' })
  await b.refresh()
  assert.match((await b.archive()).body.error, /Text you started typing/)
  assert.equal(record(box), null)
  assert.ok(existsSync(entryFile(box, 'abc123')))

  // Free now; then a message gets it to work before its tab closes: the archive is called off.
  herdrWith(box, dir)
  await b.refresh()
  assert.equal((await b.archive()).body.ok, true)
  herdrWith(box, dir, { status: 'working' })
  await until(() => archiveLog(box).some(e => e.result === 'kept'), 10_000)
  assert.equal(record(box), null)
  assert.equal(archiveLog(box).at(-1).why, 'archive.why.working')
  assert.ok(existsSync(entryFile(box, 'abc123')))
  assert.equal(calls(box).some(c => /^(tab|pane) close/.test(c)), false)
  // The page hears it once, from the board's own log; the card is back.
  await b.refresh()
  assert.ok((await b.items()).includes(S))
  const payload = await (await fetch(`${b.url}/api/board`)).json()
  assert.equal(payload.archive.log[0].result, 'kept')
})

test('a sleeping session goes too; a pane that shares its tab closes alone; Remove drops the record and the card, never the transcript', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  // herdr-wake: S sleeps in wP:p1, a shell now, beside another pane in its tab.
  const wake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/sleeping' ? [{ session: S, pane: 'wP:p1', name: 'Probe', slept_at: new Date(Date.now() - 5 * DAY).toISOString() }] : {}))
  })
  await new Promise(resolve => wake.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => wake.close(resolve)))
  // A shell herdr-wake did not mark as sleeping, or with a program started in it, is not closed.
  herdrWith(box, dir, { asleep: true, label: 'pwsh' })
  const b = await board(box, { archiveUndoSec: 0.2, wakeUrl: `http://127.0.0.1:${wake.address().port}` })
  assert.match((await b.archive()).body.error, /no longer runs in its pane/)
  herdrWith(box, dir, { asleep: true, running: true })
  assert.match((await b.archive()).body.error, /Something else runs in its pane/)
  assert.equal(record(box), null)
  herdrWith(box, dir, { asleep: true, shared: true })
  mkdirSync(join(stateDir(box), 'context'), { recursive: true })
  writeFileSync(join(stateDir(box), 'context', `${S}.json`), '{}')
  const asleep = (await (await fetch(`${b.url}/api/board`)).json()).items.find(i => i.key === S)
  assert.equal(asleep.sleeping, true)
  // Quiet since its transcript's last line (now): every sleeping one, not those over a day.
  assert.deepEqual(tidyList([asleep], 0).map(i => i.key), [S])
  assert.deepEqual(tidyList([asleep], 1), [])
  const r = await b.post('/api/archive', { op: 'archive', keys: [S, OTHER] })
  assert.deepEqual(r.body.done.map(d => d.key), [S], JSON.stringify(r.body))
  assert.deepEqual(r.body.failed.map(f => f.key), [OTHER])
  await until(() => record(box)?.state === 'archived', 10_000)
  assert.ok(calls(box).includes('pane close wP:p1'))
  assert.equal(calls(box).some(c => c.startsWith('tab close')), false)

  const transcript = join(box.env.HOME, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${S}.jsonl`)
  const removed = await b.post('/api/archive', { op: 'remove', keys: [S] })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.equal(record(box), null)
  assert.equal(existsSync(join(stateDir(box), 'cards', `${S}.json`)), false)
  assert.equal(existsSync(join(stateDir(box), 'context', `${S}.json`)), false)
  assert.ok(existsSync(transcript))
  assert.deepEqual(readdirSync(join(stateDir(box), 'archive')).filter(n => n.endsWith('.json')), [])
})

test('board archive --session: by the same rules, its tab closed at once; never the session itself', { timeout: 40_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  herdrWith(box, dir)
  const cfgDir = join(box.env.APPDATA, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'ru', port: 9, categories: CATEGORIES }))
  const cli = async (args, env = {}) => {
    const out = await box.run('cli', { args, env }).exited
    return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
  }
  assert.match((await cli(['archive'])).out, /usage: board archive --session/)
  assert.match((await cli(['archive', '--session', 'nobody'])).out, /no session "nobody" on the board/)
  // A name two sessions go by takes neither; the pane or the id says which.
  const twin = { pane_id: 'wP:p5', tab_id: 'wP:t5', workspace_id: 'wP', agent: 'claude', agent_session: { value: OTHER }, agent_status: 'idle', cwd: dir, terminal_title_stripped: 'Probe' }
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
  assert.match((await cli(['archive', '--session', 'Probe card'], { CLAUDE_CODE_SESSION_ID: OTHER })).out, /Probe card stays on the board: it is working/)
  herdrWith(box, dir)
  const r = await cli(['archive', '--session', 'probe card'], { CLAUDE_CODE_SESSION_ID: OTHER })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ok · archived Probe card: its pane is closed; the user can bring it back from the board's archive/)
  assert.ok(calls(box).includes('tab close wP:t1'))
  const rec = record(box)
  assert.deepEqual([rec.state, rec.by, rec.from.key], ['archived', 'agent', OTHER])
})

test('a board stopped between holding a reminder and taking it out of the schedule: Return does not double it', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  herdrWith(box, dir)
  schedule(box)
  // The record holds abc123, and abc123 is still in the schedule.
  const entry = JSON.parse(readFileSync(entryFile(box, 'abc123'), 'utf8'))
  mkdirSync(join(stateDir(box), 'archive'), { recursive: true })
  writeFileSync(archiveFile(box), JSON.stringify({ key: S, session: S, name: 'Probe card', category: 'personal', cwd: dir, pane: 'wP:p1', state: 'closing', closeAt: Date.now() + 60_000, archivedAt: Date.now(), held: [entry] }))
  const b = await board(box)
  const back = await b.post('/api/archive', { op: 'return', keys: [S] })
  assert.equal(back.body.done[0].back, true, JSON.stringify(back.body))
  assert.equal(record(box), null)
  assert.deepEqual(readdirSync(join(stateDir(box), 'schedule')).filter(n => /^[0-9a-f]{6}\.json$/.test(n)).sort(), ['abc123.json', 'def456.json'])
})

test('archiving and Return come only from the board’s own page; a report that comes in the undo time keeps the session', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  const dir = project(box)
  herdrWith(box, dir)
  const b = await board(box, { archiveUndoSec: 1 })
  const send = (path, body, headers) => fetch(`${b.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  assert.equal((await send('/api/archive', { op: 'archive', keys: [S] }, {})).status, 403)
  assert.equal((await send('/api/archive', { op: 'archive', keys: [S] }, { 'x-board': '1', origin: 'http://evil.example' })).status, 403)
  assert.equal((await send(`/api/session/${S}/archive`, {}, { 'x-board': '1', origin: 'http://evil.example' })).status, 403)
  assert.equal((await send('/api/archive', { op: 'nope', keys: [S] }, { 'x-board': '1' })).status, 400)
  assert.equal(record(box), null)

  assert.equal((await b.archive()).body.ok, true)
  // A MokuPilot report with a receipt for it, queued meanwhile: it must reach the session.
  mkdirSync(join(stateDir(box), 'schedule'), { recursive: true })
  const later = Date.now() + 3600e3
  writeFileSync(entryFile(box, 'fed123'), JSON.stringify({ id: 'fed123', key: S, kind: 'call', idle: true, text: 'report', at: later, next: later, created: Date.now(), by: 'mokupilot', receipt: { key: 'r1' } }))
  await until(() => archiveLog(box).some(e => e.result === 'kept'), 10_000)
  assert.equal(archiveLog(box).at(-1).why, 'archive.why.report')
  assert.ok(existsSync(entryFile(box, 'fed123')))
  assert.equal(record(box), null)
  assert.equal(calls(box).some(c => /^(tab|pane) close/.test(c)), false)
})

test('a launch.command resumes through {resume}, left out for a new session', () => {
  const template = ['pwsh', '-File', 'start.ps1', '-Cwd', '{cwd}', ['-Resume', '{resume}'], ['-SessionId', '{sessionId}']]
  assert.deepEqual(commandArgs(template, { cwd: 'C:/x', resume: S, sessionId: '' }).args, ['-File', 'start.ps1', '-Cwd', 'C:/x', '-Resume', S])
  assert.deepEqual(commandArgs(template, { cwd: 'C:/x', resume: '', sessionId: OTHER }).args, ['-File', 'start.ps1', '-Cwd', 'C:/x', '-SessionId', OTHER])
})
