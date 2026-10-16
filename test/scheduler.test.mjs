import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { root, sandbox, until } from './support/sandbox.ts'

// The CLI, hook and web-board side of the schedule (the scheduler itself: test/services/scheduler.test.ts).
// Child processes run against a fake herdr: entries are files in the sandbox's
// schedule folder, the session's prompt is a logged `herdr agent prompt` call.
const HOUR = 3600e3
const dirOf = box => join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board/schedule')
const cardsOf = box => join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board/cards')

function put(box, entry) {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(join(dirOf(box), `${entry.id}.json`), JSON.stringify({ key: 's1', name: 'Test', created: Date.now(), ...entry }))
}
const read = (box, id) => (existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null)

/** Claude's input box as `herdr agent read --ansi` shows it; a suggestion is drawn dim. */
const RULE = '─'.repeat(40)
const screen = (typed = '', dim = '') => ['● done', RULE, `❯ ${typed}${dim ? `\x1b[2m${dim}\x1b[0m` : ''}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

/** herdr with one Claude session s1 in pane p1. */
function herdrWith(box, status, extra = {}) {
  const snapshot = { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: status, cwd: box.dir }], tabs: [], workspaces: [] }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: 's1' } } } },
    'agent read': { text: screen('', 'try: run the tests') },
    'agent prompt': { result: {} },
    ...extra,
  })
}

/** The sandbox's board config; port 9 answers nothing, so the CLI never reaches the live board. */
function config(box, extra = {}) {
  const dir = join(box.env.APPDATA, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

/** The board command in an agent's session (its env), with herdr answered by the fake. */
async function agentCli(box, args, env = {}) {
  const out = await box.run('cli', { args, env }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

function cli(box, args) {
  if (!existsSync(join(box.env.APPDATA, 'herdr/plugins/config/agent-board/config.json'))) config(box)
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/cli.mjs'), ...args], { cwd: root, env: box.env })
    let out = ''
    proc.stdout.on('data', c => (out += c))
    proc.stderr.on('data', c => (out += c))
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}

test('board remind / every / schedule / unschedule keep entries for the session', { timeout: 15_000 }, async t => {
  const box = await sandbox(t)
  const s = ['--session', '11111111-2222-3333-4444-555555555555']
  const one = await cli(box, ['remind', ...s, 'in', '30m', 'check the CI run'])
  assert.equal(one.code, 0, one.out)
  const id = /reminder ([0-9a-f]{6})/.exec(one.out)[1]
  const entry = read(box, id)
  assert.equal(entry.text, 'check the CI run')
  assert.ok(Math.abs(entry.next - (Date.now() + 30 * 60e3)) < 10_000)
  assert.equal(entry.idle, undefined) // on time unless asked otherwise
  const free = await cli(box, ['remind', ...s, '--idle', 'in', '1h', 'when free'])
  assert.match(free.out, /when the session is free/)
  assert.equal(read(box, /reminder ([0-9a-f]{6})/.exec(free.out)[1]).idle, true)
  assert.equal((await cli(box, ['unschedule', /reminder ([0-9a-f]{6})/.exec(free.out)[1]])).code, 0)
  const every = await cli(box, ['every', ...s, '0 9 * * 1-5', 'check the inbox'])
  assert.equal(every.code, 0, every.out)
  assert.equal(read(box, /every ([0-9a-f]{6})/.exec(every.out)[1]).cron, '0 9 * * 1-5')
  // PowerShell passes the five fields unquoted.
  assert.equal((await cli(box, ['every', ...s, '0', '9', '*', '*', 'mon', 'weekly'])).code, 0)
  assert.match((await cli(box, ['remind', ...s, 'today', '0:00', 'past'])).out, /in the past/)
  assert.match((await cli(box, ['remind', ...s, 'soon', 'text'])).out, /usage/)
  assert.match((await cli(box, ['every', ...s, '0 0 30 2 *', 'never'])).out, /never runs/)
  assert.match((await cli(box, ['every', ...s, '*/2 * * * *', 'too often'])).out, /more often than every 5 minutes/)
  assert.match((await cli(box, ['remind', ...s, 'in', '99999999999d', 'never'])).out, /usage/)
  assert.match((await cli(box, ['remind', ...s, 'in', '3000d', 'far'])).out, /five years/)
  assert.match((await cli(box, ['every', ...s, '* * *', 'bad'])).out, /5 fields/)
  const list = await cli(box, ['schedule', ...s])
  assert.equal(list.out.split('\n').length, 3)
  assert.match(list.out, /every "0 9 \* \* 1-5"/)
  assert.match((await cli(box, ['unschedule', ...s])).out, /usage/)
  assert.match((await cli(box, ['unschedule', id])).out, new RegExp(`removed ${id}`))
  assert.equal(read(box, id), null)
  assert.match((await cli(box, ['unschedule', ...s, 'all'])).out, /removed 2 entries/)
  assert.deepEqual(readdirSync(dirOf(box)).filter(n => n.endsWith('.json')), [])
})

test('board remind records who set it, the pane and the pane folder, and no control characters', { timeout: 15_000 }, async t => {
  const box = await sandbox(t)
  config(box)
  const project = join(box.dir, 'project')
  const snapshot = {
    panes: [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working', cwd: project, terminal_title_stripped: 'Setter' },
      { pane_id: 'p2', agent: 'claude', agent_session: { value: 's2' }, agent_status: 'idle', cwd: box.dir, terminal_title_stripped: 'Target' },
    ],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
  // Its own: the folder is the pane's, not the shell's (the runner's cwd is the repo).
  const own = await agentCli(box, ['remind', 'in', '1h', 'own'], { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' })
  assert.equal(own.code, 0, own.out)
  const mine = read(box, /reminder ([0-9a-f]{6})/.exec(own.out)[1])
  assert.equal(mine.pane, 'p1')
  assert.equal(mine.cwd, project)
  assert.equal(mine.from, undefined)
  // For another session: who set it, and the text without control characters.
  const other = await agentCli(box, ['remind', '--session', 'Target', 'in', '1h', 'look\x07 at\x1b[31m this\x7f'], { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' })
  assert.equal(other.code, 0, other.out)
  const theirs = read(box, /reminder ([0-9a-f]{6})/.exec(other.out)[1])
  assert.equal(theirs.key, 's2')
  assert.equal(theirs.cwd, box.dir)
  assert.deepEqual(theirs.from, { key: 's1', name: 'Setter' })
  assert.equal(theirs.text, 'look at[31m this')
  // No board answers on the sandbox's port: the agent is told it goes out once one runs.
  assert.match(own.out, /no board with the scheduler is running/)
})

test('board remind says nothing about the board when one with the scheduler answers', { timeout: 15_000 }, async t => {
  const box = await sandbox(t)
  const board = http.createServer((req, res) => res.end(JSON.stringify({ items: [], schedules: [] })))
  await new Promise(resolve => board.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => board.close(resolve)))
  config(box, { port: board.address().port })
  const out = await agentCli(box, ['remind', '--session', '11111111-2222-3333-4444-555555555555', 'in', '1h', 'x'])
  assert.equal(out.code, 0, out.out)
  assert.doesNotMatch(out.out, /no board/)
})

test('a board reminder does not count as the user answering the session', { timeout: 15_000 }, async t => {
  const box = await sandbox(t)
  mkdirSync(cardsOf(box), { recursive: true })
  const card = () => JSON.parse(readFileSync(join(cardsOf(box), 's1.json'), 'utf8'))
  writeFileSync(join(cardsOf(box), 's1.json'), JSON.stringify({ key: 's1', ask: 'Send it?', askSince: 1, pin: 'me', pinAt: 1, briefV: 99 }))
  const hook = prompt =>
    new Promise(resolve => {
      const proc = spawn(process.execPath, [join(root, 'src/hook.mjs')], { cwd: root, env: { ...box.env, HERDR_PANE_ID: 'p1' } })
      proc.on('close', resolve)
      proc.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt }))
    })
  await hook('[board reminder from lead-session] check the CI run')
  assert.equal(card().ask, 'Send it?')
  // The session works again: a column dragged to by hand goes, as with any work.
  assert.equal(card().pin, undefined)
  await hook('yes, send it')
  assert.equal(card().ask, undefined)
})

test('the web board lists the schedule without the bookkeeping and cancels an entry', { timeout: 15_000 }, async t => {
  const box = await sandbox(t)
  herdrWith(box, 'idle')
  put(box, { id: 'abcdef', text: 'later', at: Date.now() + HOUR, next: Date.now() + HOUR, claim: { pid: 1, at: 1 }, tried: 1 })
  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const board = await (await fetch(`${url}/api/board`)).json()
  assert.equal(board.schedules.length, 1)
  assert.equal(board.schedules[0].text, 'later')
  assert.equal('claim' in board.schedules[0] || 'tried' in board.schedules[0], false)
  assert.deepEqual(board.scheduleLog, [])
  const post = (body, headers = { 'x-board': '1' }) => fetch(`${url}/api/schedule`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  // The mode: when the session is free, then on time again.
  assert.equal((await post({ op: 'mode', id: 'abcdef', idle: true }, {})).status, 403)
  assert.equal((await post({ op: 'mode', id: 'abcdef', idle: true })).status, 200)
  assert.equal(read(box, 'abcdef').idle, true)
  assert.equal((await post({ op: 'mode', id: 'abcdef', idle: false })).status, 200)
  assert.equal('idle' in read(box, 'abcdef'), false)
  assert.equal((await post({ op: 'snooze', id: 'abcdef' })).status, 400)
  const cancel = headers => post({ op: 'cancel', id: 'abcdef' }, headers)
  assert.equal((await cancel({})).status, 403)
  assert.equal((await cancel({ 'x-board': '1' })).status, 200)
  assert.equal(read(box, 'abcdef'), null)
  assert.equal((await cancel({ 'x-board': '1' })).status, 404)
})
