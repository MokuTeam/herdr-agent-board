import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { sandbox, until } from './fixtures/sandbox.mjs'
import { useLanguage } from '../src/lang.mjs'
import { promptOf } from '../src/scheduler.mjs'

// `board restart`: a schedule entry of kind 'restart' that the scheduler carries out once the
// session is free, through herdr-wake (/sleep, then /wake), then types the session's note. The
// scheduler and the CLI run in child processes against a fake herdr; herdr-wake is a small HTTP
// server here that flips the fake herdr's pane between Claude and a shell, as the real one does.
useLanguage('en')
const dirOf = box => join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board/schedule')
const past = () => Date.now() - 1000

function put(box, entry) {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(join(dirOf(box), `${entry.id}.json`), JSON.stringify({ key: 's1', name: 'Test', pane: 'p1', kind: 'restart', idle: true, by: 'agent', text: '', at: past(), next: past(), created: Date.now(), ...entry }))
}
const read = (box, id) => (existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null)
const entries = box => (existsSync(dirOf(box)) ? readdirSync(dirOf(box)).filter(n => /^[0-9a-f]{6}\.json$/.test(n)) : [])
const runs = box => (existsSync(join(dirOf(box), 'log.jsonl')) ? readFileSync(join(dirOf(box), 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const prompts = box => box.calls().filter(a => a[1] === 'prompt').map(a => a[3])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Claude's input box as `herdr agent read --ansi` shows it; a suggestion is drawn dim. */
const RULE = '─'.repeat(40)
const screen = (typed = '', dim = '') => ['● done', RULE, `❯ ${typed}${dim ? `\x1b[2m${dim}\x1b[0m` : ''}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

/** herdr with Claude session s1 in pane p1, or (status null) the shell left after it exited. */
function herdrWith(box, status, extra = {}) {
  const pane = status ? { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: status, cwd: box.dir, terminal_title_stripped: 'Test' } : { pane_id: 'p1', agent: null, cwd: box.dir }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'agent get': { result: { agent: status ? { agent: 'claude', agent_status: status, agent_session: { value: 's1' } } : null } },
    'agent read': { text: screen('', 'try: run the tests') },
    'agent prompt': { result: {} },
    ...extra,
  })
}

/** Claude's own registry entry for s1 (~/.claude/sessions): `shell` while a background command runs. */
function registry(box, status) {
  const dir = join(box.env.HOME, '.claude/sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '1.json'), JSON.stringify({ sessionId: 's1', kind: 'interactive', pid: process.pid, status, name: 'Test' }))
}

/**
 * herdr-wake: /sleep puts s1 to sleep (the pane becomes a shell, /sleeping lists it), /wake brings
 * it back. `sleep` and `wake` answer instead, when given ({ ok: false, error } refuses).
 */
async function fakeWake(t, box, { asleep = false, sleep, wake } = {}) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping') return res.end(JSON.stringify(asleep ? [{ session: 's1', pane: 'p1', name: 'Test', slept_at: new Date().toISOString() }] : []))
    // The web board's setup check.
    if (req.url === '/status') return res.end('{}')
    calls.push(req.url)
    if (req.url === '/sleep') {
      const r = sleep ? await sleep() : { ok: true }
      if (r.ok) {
        asleep = true
        herdrWith(box, null)
      }
      return res.end(JSON.stringify(r))
    }
    if (req.url === '/wake') {
      const r = wake ? await wake() : { ok: true }
      if (r.ok) {
        asleep = false
        herdrWith(box, 'idle')
      }
      return res.end(JSON.stringify(r))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => [...calls] }
}

async function scheduler(box, cfg = {}) {
  const proc = box.run('scheduler', { categories: [{ id: 'other', title: 'Other', color: 'gray' }], scheduleTickSec: 0.2, restartSettleSec: 0, ...cfg })
  await until(() => proc.messages.some(m => m.ready))
  return proc
}

/** The sandbox's board config; port 9 answers nothing, so the CLI never reaches the live board. */
function config(box, extra = {}) {
  const dir = join(box.env.APPDATA, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

async function agentCli(box, args, env = {}) {
  const out = await box.run('cli', { args, env }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

test('the prompt after a restart: own, set by another session, asked by the user, and one that did not happen', () => {
  const at = Date.now()
  const base = { id: 'aaaa00', key: 's1', kind: 'restart', next: at - 3 * 3600e3, text: '' }
  // Late means nothing to a restart: it says how it went.
  assert.equal(promptOf({ ...base, by: 'agent' }, at), '[board reminder; restarted as you asked] Carry on.')
  assert.equal(promptOf({ ...base, by: 'agent', text: 'finish the PR review' }, at), '[board reminder; restarted as you asked] finish the PR review')
  assert.equal(promptOf({ ...base, by: 'agent', from: { key: 's7', name: 'lead' } }, at), '[board reminder from lead; restarted] Carry on.')
  assert.match(promptOf({ ...base, by: 'user' }, at), /^\[board reminder; restarted by the user\] Your MCP servers, settings, hooks, skills and CLAUDE\.md are loaded anew\./)
  assert.equal(promptOf({ ...base, by: 'agent', failed: 'herdr-wake is down', text: 'finish it' }, at), '[board reminder] restart did not happen: herdr-wake is down. Your note for after it: finish it')
  assert.equal(promptOf({ ...base, by: 'agent', failed: 'herdr-wake is down' }, at), '[board reminder] restart did not happen: herdr-wake is down.')
})

test('board restart asks for one: due now, once the session is free; asked again it keeps one; refused at once without herdr-wake or herdr', { timeout: 20_000 }, async t => {
  const box = sandbox(t)
  const wake = await fakeWake(t, box)
  config(box, { wakeUrl: wake.url })
  const project = join(box.dir, 'project')
  box.state({ 'api snapshot': { result: { snapshot: { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working', cwd: project }], tabs: [], workspaces: [] } } } })
  const env = { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' }
  const r = await agentCli(box, ['restart', 'go', 'on', 'with', 'the', 'review'], env)
  assert.equal(r.code, 0, r.out)
  const id = /^ok · restart ([0-9a-f]{6}): once this turn is over/.exec(r.out)?.[1]
  assert.ok(id, r.out)
  assert.match(r.out, /then gets "\[board reminder; restarted as you asked\] go on with the review"/)
  assert.match(r.out, /end your turn now/)
  assert.match(r.out, new RegExp(`cancel: board unschedule ${id}`))
  const e = read(box, id)
  assert.deepEqual([e.kind, e.idle, e.by, e.key, e.pane, e.cwd, e.text], ['restart', true, 'agent', 's1', 'p1', project, 'go on with the review'])
  assert.ok(Math.abs(e.next - Date.now()) < 10_000)
  assert.deepEqual(wake.calls(), []) // asking only checks that herdr-wake answers

  // Asked again: the same restart, with the newer note.
  const again = await agentCli(box, ['restart', 'a newer note'], env)
  assert.match(again.out, new RegExp(`^ok · restart ${id} is on its way already, with this note`))
  assert.equal(read(box, id).text, 'a newer note')
  assert.equal(entries(box).length, 1)
  const list = await agentCli(box, ['schedule'], env)
  assert.match(list.out, new RegExp(`^${id} · restart, asked .+ · once the session is free · a newer note$`))
  assert.match((await agentCli(box, ['unschedule', id], env)).out, new RegExp(`removed ${id}`))

  // No herdr-wake: refused at once, nothing scheduled, and what to do instead.
  config(box, { wakeUrl: 'http://127.0.0.1:9' })
  const down = await agentCli(box, ['restart'], env)
  assert.equal(down.code, 1, down.out)
  assert.match(down.out, /a restart needs herdr-wake, which does not answer at http:\/\/127\.0\.0\.1:9 \(.+\); nothing was scheduled\. Ask the user to restart this session by hand: \/exit in it, then claude --resume s1/)
  config(box, { wakeUrl: null })
  assert.match((await agentCli(box, ['restart'], env)).out, /wakeUrl in the board's config\.json is empty; nothing was scheduled/)
  // Not in a herdr pane.
  config(box, { wakeUrl: wake.url })
  const outside = await agentCli(box, ['restart'], { CLAUDE_CODE_SESSION_ID: 's1' })
  assert.equal(outside.code, 1)
  assert.match(outside.out, /works for a session in a herdr pane/)
  assert.equal(entries(box).length, 0)
})

test('once the session is free it is put to sleep, woken, and gets its note; the log says so', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const wake = await fakeWake(t, box)
  put(box, { id: 'aaaa01', text: 'go on with the PR review' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] go on with the PR review'])
  assert.equal(read(box, 'aaaa01'), null)
  assert.deepEqual([runs(box)[0].result, runs(box)[0].kind, runs(box)[0].by], ['sent', 'restart', 'agent'])
})

test('a turn, the user’s draft and background tasks hold a restart back, without counting as tries', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'working')
  const wake = await fakeWake(t, box)
  put(box, { id: 'bbbb01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'bbbb01')?.why === 'busy')
  // The turn is over for herdr, not yet for Claude: still busy, several ticks on.
  registry(box, 'busy')
  herdrWith(box, 'idle')
  const since = Date.now()
  await until(() => read(box, 'bbbb01')?.tried > since + 500)
  assert.equal(read(box, 'bbbb01').why, 'busy')
  assert.deepEqual(wake.calls(), [])
  registry(box, 'idle')
  herdrWith(box, 'idle', { 'agent read': { text: screen('half a thought') } })
  await until(() => read(box, 'bbbb01')?.why === 'draft')
  herdrWith(box, 'blocked')
  await until(() => read(box, 'bbbb01')?.why === 'dialog')
  registry(box, 'shell')
  herdrWith(box, 'idle')
  await until(() => read(box, 'bbbb01')?.why === 'tasks')
  assert.ok(read(box, 'bbbb01').tasksSince)
  assert.equal(read(box, 'bbbb01').attempts, undefined)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual(prompts(box), [])
  registry(box, 'idle')
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] Carry on.'])
})

test('background tasks are counted from when they began to hold it: a hold for another reason starts over', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'working')
  const wake = await fakeWake(t, box)
  // Tasks held it long ago; then a turn ran.
  put(box, { id: 'cdcd01', tasksSince: Date.now() - 11 * 60e3 })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'cdcd01')?.why === 'busy')
  assert.equal(read(box, 'cdcd01').tasksSince, undefined)
  // A new background command at the end of that turn holds it afresh, not as 11 minutes old.
  registry(box, 'shell')
  herdrWith(box, 'idle')
  await until(() => read(box, 'cdcd01')?.why === 'tasks')
  assert.ok(Date.now() - read(box, 'cdcd01').tasksSince < 5000)
  await pause(600)
  assert.equal(read(box, 'cdcd01').failed, undefined)
  assert.deepEqual(prompts(box), [])
  assert.deepEqual(wake.calls(), [])
})

test('background tasks that keep running give a restart up: the session hears why, with its note', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  registry(box, 'shell')
  const wake = await fakeWake(t, box)
  put(box, { id: 'cccc01', text: 'carry on with the tests', tasksSince: Date.now() - 11 * 60e3 })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  assert.match(prompts(box)[0], /^\[board reminder\] restart did not happen: background tasks \(a command, a Monitor\) kept running in it for 10 minutes; .+\. Your note for after it: carry on with the tests$/)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual([runs(box)[0].result, runs(box)[0].kind], ['failed', 'restart'])
  assert.equal(read(box, 'cccc01'), null)
})

test('herdr-wake refusing three times gives up: the session hears why; one the user asked for only goes to the log', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const wake = await fakeWake(t, box, { sleep: () => ({ ok: false, error: 'Test is not idle' }) })
  put(box, { id: 'dddd01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/sleep', '/sleep'])
  assert.match(prompts(box)[0], /^\[board reminder\] restart did not happen: Could not put Test to sleep: it is busy\.$/)
  await until(() => runs(box).length === 1)
  assert.equal(runs(box)[0].result, 'failed')

  const user = sandbox(t)
  herdrWith(user, 'idle')
  const wake2 = await fakeWake(t, user, { sleep: () => ({ ok: false, error: 'Test did not go to sleep (busy, or text in its input box)' }) })
  put(user, { id: 'dddd02', by: 'user' })
  await scheduler(user, { wakeUrl: wake2.url })
  await until(() => runs(user).length === 1)
  assert.deepEqual([runs(user)[0].result, runs(user)[0].by], ['failed', 'user'])
  assert.match(runs(user)[0].why, /stayed up/)
  assert.equal(read(user, 'dddd02'), null)
  await pause(300)
  assert.deepEqual(prompts(user), [])
})

test('a restart a board left halfway wakes the session it put to sleep, then types the note', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, null)
  const wake = await fakeWake(t, box, { asleep: true })
  put(box, { id: 'eeee01', step: 'wake', text: 'resume the migration' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] resume the migration'])
})

test('a restart back from its wake types only the note; a wake that fails once is tried again', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const wake = await fakeWake(t, box)
  put(box, { id: 'eeee02', step: 'note', text: 'only the note' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] only the note'])

  const flaky = sandbox(t)
  herdrWith(flaky, 'idle')
  let wakes = 0
  const wake2 = await fakeWake(t, flaky, { wake: () => (++wakes === 1 ? { ok: false, error: 'the session did not start' } : { ok: true }) })
  put(flaky, { id: 'eeee03' })
  await scheduler(flaky, { wakeUrl: wake2.url })
  await until(() => prompts(flaky).length === 1)
  assert.deepEqual(wake2.calls(), ['/sleep', '/wake', '/wake'])
  assert.deepEqual(prompts(flaky), ['[board reminder; restarted as you asked] Carry on.'])
})

test('a restart is for the session that asked: after /clear the new session in that pane is left alone', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const wake = await fakeWake(t, box)
  // Asked by s0, which /clear replaced with s1 in the same pane and folder.
  put(box, { id: 'acac01', key: 's0', cwd: box.dir })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'acac01')?.why === 'gone')
  await pause(500)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual(prompts(box), [])
})

test('a herdr that does not answer holds a restart as a reason of its own, counted against the wait', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle', { 'agent get': { error: 'pane not found' } })
  const wake = await fakeWake(t, box)
  put(box, { id: 'adad01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => /^herdr did not answer/.test(read(box, 'adad01')?.why ?? ''))
  const first = read(box, 'adad01').tried
  await until(() => read(box, 'adad01').tried > first)
  assert.ok(read(box, 'adad01').waited > 0)
  assert.deepEqual(wake.calls(), [])
})

test('asked again over one that gave up, it is a new restart; an agent asking takes over one the user asked for', { timeout: 20_000 }, async t => {
  const box = sandbox(t)
  const wake = await fakeWake(t, box)
  config(box, { wakeUrl: wake.url })
  box.state({ 'api snapshot': { result: { snapshot: { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working', cwd: box.dir }], tabs: [], workspaces: [] } } } })
  const env = { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' }
  put(box, { id: 'afaf01', failed: 'herdr-wake is down', text: 'old note' })
  const r = await agentCli(box, ['restart', 'new', 'note'], env)
  assert.equal(r.code, 0, r.out)
  assert.equal(read(box, 'afaf01'), null)
  const [file] = entries(box)
  const e = read(box, file.slice(0, 6))
  assert.deepEqual([e.failed, e.text, e.by], [undefined, 'new note', 'agent'])
  rmSync(join(dirOf(box), file))

  put(box, { id: 'afaf02', by: 'user' })
  const over = await agentCli(box, ['restart', 'mine now'], env)
  assert.match(over.out, /restart afaf02 is on its way already, with this note/)
  assert.deepEqual([read(box, 'afaf02').by, read(box, 'afaf02').text], ['agent', 'mine now'])
})

test('cancelled while it sleeps: the session is woken all the same, and gets nothing typed', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const wake = await fakeWake(t, box, { sleep: () => (rmSync(join(dirOf(box), 'ffff01.json')), { ok: true }) })
  put(box, { id: 'ffff01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => wake.calls().includes('/wake'))
  await pause(500)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), [])
  assert.deepEqual(runs(box), [])
})

test('a session that will not wake is left asleep after three tries; only the log says so', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const wake = await fakeWake(t, box, { wake: () => ({ ok: false, error: 'the session did not start' }) })
  put(box, { id: 'abab01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => runs(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake', '/wake', '/wake'])
  assert.equal(runs(box)[0].result, 'failed')
  assert.match(runs(box)[0].why, /the session did not start/)
  assert.equal(read(box, 'abab01'), null)
  assert.deepEqual(prompts(box), [])
})

test('the web board asks for a restart for the user, says when one is on its way, refuses one without herdr-wake, and keeps its mode', { timeout: 20_000 }, async t => {
  const start = async (box, wakeUrl) => {
    const probe = http.createServer()
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    box.run('server', { port, language: 'en', categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl, refreshSec: 3600, scheduleTickSec: 0.2 })
    const url = `http://127.0.0.1:${port}`
    // Actions through herdr wait for the board's first refresh.
    for (const deadline = Date.now() + 8000; ; await pause(100)) {
      try {
        const b = await (await fetch(`${url}/api/board`)).json()
        if (!b.stale && b.items.length) break
      } catch {}
      if (Date.now() > deadline) throw new Error('the board did not come up')
    }
    const post = (path, body = {}, headers = { 'x-board': '1' }) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { post }
  }
  const box = sandbox(t)
  // Working: the scheduler leaves the restart waiting for the turn to end.
  herdrWith(box, 'working')
  const wake = await fakeWake(t, box)
  const { post } = await start(box, wake.url)
  assert.equal((await post('/api/session/s1/restart', {}, {})).status, 403)
  const r = await post('/api/session/s1/restart')
  const body = await r.json()
  assert.equal(r.status, 200, JSON.stringify(body))
  const e = read(box, body.id)
  assert.deepEqual([e.kind, e.by, e.key, e.pane, e.idle], ['restart', 'user', 's1', 'p1', true])
  const twice = await (await post('/api/session/s1/restart')).json()
  assert.deepEqual([twice.id, twice.again], [body.id, true])
  // A restart always waits until the session is free.
  assert.equal((await post('/api/schedule', { op: 'mode', id: body.id, idle: false })).status, 400)
  assert.equal(read(box, body.id).idle, true)
  assert.deepEqual(wake.calls(), [])

  const lone = sandbox(t)
  herdrWith(lone, 'idle')
  const { post: post2 } = await start(lone, null)
  const no = await post2('/api/session/s1/restart')
  assert.equal(no.status, 409)
  assert.match((await no.json()).error, /needs herdr-wake/)
  assert.equal(entries(lone).length, 0)
})
