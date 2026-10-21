import { onTestFinished, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { promptOf, type ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { unusedPort } from '../support/board-server.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

// `board restart`: a schedule entry of kind 'restart' that the scheduler carries out once the
// session is free, through herdr-wake (/sleep, then /wake), then types the session's note. The
// scheduler and the CLI run in child processes against a fake herdr; herdr-wake is a small HTTP
// server here that flips the fake herdr's pane between Claude and a shell, as the real one does.
// The sandbox's home has one profile (the default folder), so the upstream tests are upstream's
// behaviour with one profile; the work profile's tests at the end set up two.
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')
const dirOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
const past = (): number => Date.now() - 1000

type Stored = Record<string, unknown> & { text: string; next: number }

function put(box: Sandbox, entry: Record<string, unknown>): void {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(
    join(dirOf(box), `${entry.id}.json`),
    JSON.stringify({
      key: 's1',
      name: 'Test',
      pane: 'p1',
      kind: 'restart',
      idle: true,
      by: 'agent',
      text: '',
      at: past(),
      next: past(),
      created: Date.now(),
      ...entry,
    }),
  )
}
const read = (box: Sandbox, id: string): Stored | null =>
  existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null
const entries = (box: Sandbox): string[] =>
  existsSync(dirOf(box)) ? readdirSync(dirOf(box)).filter(n => /^[0-9a-f]{6}\.json$/.test(n)) : []
const runs = (box: Sandbox): Record<string, unknown>[] =>
  existsSync(join(dirOf(box), 'log.jsonl'))
    ? readFileSync(join(dirOf(box), 'log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(a => a[1] === 'prompt')
    .map(a => a[3] as string)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Claude's input box as `herdr agent read --ansi` shows it; a suggestion is drawn dim. */
const RULE = '─'.repeat(40)
const screen = (typed = '', dim = ''): string =>
  ['● done', RULE, `❯ ${typed}${dim ? `\x1b[2m${dim}\x1b[0m` : ''}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

/**
 * herdr with Claude session s1 in pane p1, or (status null) the shell left after it exited.
 * `pane`: more of the pane as herdr's snapshot has it (the terminal it holds).
 */
function herdrWith(
  box: Sandbox,
  status: string | null,
  extra: Record<string, unknown> = {},
  pane: Record<string, unknown> = {},
): void {
  const shown = status
    ? {
        pane_id: 'p1',
        agent: 'claude',
        agent_session: { value: 's1' },
        agent_status: status,
        cwd: box.dir,
        terminal_title_stripped: 'Test',
        ...pane,
      }
    : { pane_id: 'p1', agent: null, cwd: box.dir, ...pane }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [shown], tabs: [], workspaces: [] } } },
    'agent get': {
      result: { agent: status ? { agent: 'claude', agent_status: status, agent_session: { value: 's1' } } : null },
    },
    'agent read': { text: screen('', 'try: run the tests') },
    'agent prompt': { result: {} },
    ...extra,
  })
}

/** Claude's own registry entry for s1 (<profile folder>/sessions): `shell` while a background command runs. */
function registry(box: Sandbox, status: string, profileDir = join(box.env.HOME as string, '.claude')): void {
  const dir = join(profileDir, 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '1.json'),
    JSON.stringify({ sessionId: 's1', kind: 'interactive', pid: process.pid, status, name: 'Test' }),
  )
}

type WakeAnswer = { ok: boolean; error?: string }

/**
 * herdr-wake: /sleep puts s1 to sleep (the pane becomes a shell, /sleeping lists it), /wake brings
 * it back. `sleep` and `wake` answer instead, when given ({ ok: false, error } refuses). `pane`:
 * more of the pane as herdr shows it, kept through both.
 */
async function fakeWake(
  box: Sandbox,
  {
    asleep: start = false,
    sleep,
    wake,
    pane = {},
  }: {
    asleep?: boolean
    sleep?: () => WakeAnswer | Promise<WakeAnswer>
    wake?: () => WakeAnswer | Promise<WakeAnswer>
    pane?: Record<string, unknown>
  } = {},
): Promise<{ url: string; calls: () => string[] }> {
  let asleep = start
  const calls: string[] = []
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping')
      return res.end(
        JSON.stringify(asleep ? [{ session: 's1', pane: 'p1', name: 'Test', slept_at: new Date().toISOString() }] : []),
      )
    // The web board's setup check.
    if (req.url === '/status') return res.end('{}')
    calls.push(req.url ?? '')
    if (req.url === '/sleep') {
      const r = sleep ? await sleep() : { ok: true }
      if (r.ok) {
        asleep = true
        herdrWith(box, null, {}, pane)
      }
      return res.end(JSON.stringify(r))
    }
    if (req.url === '/wake') {
      const r = wake ? await wake() : { ok: true }
      if (r.ok) {
        asleep = false
        herdrWith(box, 'idle', {}, pane)
      }
      return res.end(JSON.stringify(r))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => [...calls] }
}

async function scheduler(box: Sandbox, cfg: Record<string, unknown> = {}) {
  const proc = box.run('scheduler', {
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    scheduleTickSec: 0.2,
    restartSettleSec: 0,
    ...cfg,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

/** The sandbox's board config; port 9 answers nothing, so the CLI never reaches the live board. */
function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

async function agentCli(box: Sandbox, args: string[], env: Record<string, string> = {}) {
  const out = await box.run('cli', { args, env }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

test('the prompt after a restart: own, set by another session, asked by the user, and one that did not happen', () => {
  const at = Date.now()
  const base: ScheduleEntry = { id: 'aaaa00', key: 's1', kind: 'restart', next: at - 3 * 3600e3, text: '' }
  // Late means nothing to a restart: it says how it went.
  assert.equal(promptOf({ ...base, by: 'agent' }, at), '[board reminder; restarted as you asked] Carry on.')
  assert.equal(
    promptOf({ ...base, by: 'agent', text: 'finish the PR review' }, at),
    '[board reminder; restarted as you asked] finish the PR review',
  )
  assert.equal(
    promptOf({ ...base, by: 'agent', from: { key: 's7', name: 'lead' } }, at),
    '[board reminder from lead; restarted] Carry on.',
  )
  assert.match(
    promptOf({ ...base, by: 'user' }, at),
    /^\[board reminder; restarted by the user\] Your MCP servers, settings, hooks, skills and CLAUDE\.md are loaded anew\./,
  )
  assert.equal(
    promptOf({ ...base, by: 'agent', failed: 'herdr-wake is down', text: 'finish it' }, at),
    '[board reminder] restart did not happen: herdr-wake is down. Your note for after it: finish it',
  )
  assert.equal(
    promptOf({ ...base, by: 'agent', failed: 'herdr-wake is down' }, at),
    '[board reminder] restart did not happen: herdr-wake is down.',
  )
})

test('board restart asks for one: due now, once the session is free; asked again it keeps one; refused at once without herdr-wake or herdr', async () => {
  const box = await sandbox()
  const wake = await fakeWake(box)
  config(box, { wakeUrl: wake.url })
  const project = join(box.dir, 'project')
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working', cwd: project },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const env = { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' }
  const r = await agentCli(box, ['restart', 'go', 'on', 'with', 'the', 'review'], env)
  assert.equal(r.code, 0, r.out)
  const id = /^ok · restart ([0-9a-f]{6}): once this turn is over/.exec(r.out)?.[1]
  assert.ok(id, r.out)
  assert.match(r.out, /then gets "\[board reminder; restarted as you asked\] go on with the review"/)
  assert.match(r.out, /end your turn now/)
  assert.match(r.out, new RegExp(`cancel: board unschedule ${id}`))
  const e = read(box, id)
  assert.ok(e)
  assert.deepEqual(
    [e.kind, e.idle, e.by, e.key, e.pane, e.cwd, e.text],
    ['restart', true, 'agent', 's1', 'p1', project, 'go on with the review'],
  )
  assert.ok(Math.abs(e.next - Date.now()) < 10_000)
  assert.deepEqual(wake.calls(), []) // asking only checks that herdr-wake answers

  // Asked again: the same restart, with the newer note.
  const again = await agentCli(box, ['restart', 'a newer note'], env)
  assert.match(again.out, new RegExp(`^ok · restart ${id} is on its way already, with this note`))
  assert.equal(read(box, id)?.text, 'a newer note')
  assert.equal(entries(box).length, 1)
  const list = await agentCli(box, ['schedule'], env)
  assert.match(list.out, new RegExp(`^${id} · restart, asked .+ · once the session is free · a newer note$`))
  assert.match((await agentCli(box, ['unschedule', id], env)).out, new RegExp(`removed ${id}`))

  // No herdr-wake: refused at once, nothing scheduled, and what to do instead.
  config(box, { wakeUrl: 'http://127.0.0.1:9' })
  const down = await agentCli(box, ['restart'], env)
  assert.equal(down.code, 1, down.out)
  assert.match(
    down.out,
    /a restart needs herdr-wake, which does not answer at http:\/\/127\.0\.0\.1:9 \(.+\); nothing was scheduled\. Ask the user to restart this session by hand: \/exit in it, then claude --resume s1/,
  )
  config(box, { wakeUrl: null })
  assert.match(
    (await agentCli(box, ['restart'], env)).out,
    /wakeUrl in the board's config\.json is empty; nothing was scheduled/,
  )
  // Not in a herdr pane.
  config(box, { wakeUrl: wake.url })
  const outside = await agentCli(box, ['restart'], { CLAUDE_CODE_SESSION_ID: 's1' })
  assert.equal(outside.code, 1)
  assert.match(outside.out, /works for a session in a herdr pane/)
  assert.equal(entries(box).length, 0)
})

test('once the session is free it is put to sleep, woken, and gets its note; the log says so', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  const wake = await fakeWake(box)
  put(box, { id: 'aaaa01', text: 'go on with the PR review' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] go on with the PR review'])
  assert.equal(read(box, 'aaaa01'), null)
  const [run] = runs(box)
  assert.deepEqual([run?.result, run?.kind, run?.by], ['sent', 'restart', 'agent'])
})

test('a turn, the user’s draft and background tasks hold a restart back, without counting as tries', async () => {
  const box = await sandbox()
  herdrWith(box, 'working')
  const wake = await fakeWake(box)
  put(box, { id: 'bbbb01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'bbbb01')?.why === 'busy')
  // The turn is over for herdr, not yet for Claude: still busy, several ticks on.
  registry(box, 'busy')
  herdrWith(box, 'idle')
  const since = Date.now()
  await until(() => Number(read(box, 'bbbb01')?.tried) > since + 500)
  assert.equal(read(box, 'bbbb01')?.why, 'busy')
  assert.deepEqual(wake.calls(), [])
  registry(box, 'idle')
  herdrWith(box, 'idle', { 'agent read': { text: screen('half a thought') } })
  await until(() => read(box, 'bbbb01')?.why === 'draft')
  herdrWith(box, 'blocked')
  await until(() => read(box, 'bbbb01')?.why === 'dialog')
  registry(box, 'shell')
  herdrWith(box, 'idle')
  await until(() => read(box, 'bbbb01')?.why === 'tasks')
  assert.ok(read(box, 'bbbb01')?.tasksSince)
  assert.equal(read(box, 'bbbb01')?.attempts, undefined)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual(prompts(box), [])
  registry(box, 'idle')
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] Carry on.'])
})

test('background tasks are counted from when they began to hold it: a hold for another reason starts over', async () => {
  const box = await sandbox()
  herdrWith(box, 'working')
  const wake = await fakeWake(box)
  // Tasks held it long ago; then a turn ran.
  put(box, { id: 'cdcd01', tasksSince: Date.now() - 11 * 60e3 })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'cdcd01')?.why === 'busy')
  assert.equal(read(box, 'cdcd01')?.tasksSince, undefined)
  // A new background command at the end of that turn holds it afresh, not as 11 minutes old.
  registry(box, 'shell')
  herdrWith(box, 'idle')
  await until(() => read(box, 'cdcd01')?.why === 'tasks')
  assert.ok(Date.now() - Number(read(box, 'cdcd01')?.tasksSince) < 5000)
  await pause(600)
  assert.equal(read(box, 'cdcd01')?.failed, undefined)
  assert.deepEqual(prompts(box), [])
  assert.deepEqual(wake.calls(), [])
})

test('background tasks that keep running give a restart up: the session hears why, with its note', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  registry(box, 'shell')
  const wake = await fakeWake(box)
  put(box, { id: 'cccc01', text: 'carry on with the tests', tasksSince: Date.now() - 11 * 60e3 })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  assert.match(
    prompts(box)[0] ?? '',
    /^\[board reminder\] restart did not happen: background tasks \(a command, a Monitor\) kept running in it for 10 minutes; .+\. Your note for after it: carry on with the tests$/,
  )
  assert.deepEqual(wake.calls(), [])
  const [run] = runs(box)
  assert.deepEqual([run?.result, run?.kind], ['failed', 'restart'])
  assert.equal(read(box, 'cccc01'), null)
})

test('herdr-wake refusing three times gives up: the session hears why; one the user asked for only goes to the log', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  const wake = await fakeWake(box, { sleep: () => ({ ok: false, error: 'Test is not idle' }) })
  put(box, { id: 'dddd01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/sleep', '/sleep'])
  assert.match(
    prompts(box)[0] ?? '',
    /^\[board reminder\] restart did not happen: Could not put Test to sleep: it is busy\.$/,
  )
  await until(() => runs(box).length === 1)
  assert.equal(runs(box)[0]?.result, 'failed')

  const user = await sandbox()
  herdrWith(user, 'idle')
  const wake2 = await fakeWake(user, {
    sleep: () => ({ ok: false, error: 'Test did not go to sleep (busy, or text in its input box)' }),
  })
  put(user, { id: 'dddd02', by: 'user' })
  await scheduler(user, { wakeUrl: wake2.url })
  await until(() => runs(user).length === 1)
  assert.deepEqual([runs(user)[0]?.result, runs(user)[0]?.by], ['failed', 'user'])
  assert.match(String(runs(user)[0]?.why), /stayed up/)
  assert.equal(read(user, 'dddd02'), null)
  await pause(300)
  assert.deepEqual(prompts(user), [])
})

test('a restart a board left halfway wakes the session it put to sleep, then types the note', async () => {
  const box = await sandbox()
  herdrWith(box, null)
  const wake = await fakeWake(box, { asleep: true })
  put(box, { id: 'eeee01', step: 'wake', text: 'resume the migration' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] resume the migration'])
})

test('a restart back from its wake types only the note; a wake that fails once is tried again', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  const wake = await fakeWake(box)
  put(box, { id: 'eeee02', step: 'note', text: 'only the note' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] only the note'])

  const flaky = await sandbox()
  herdrWith(flaky, 'idle')
  let wakes = 0
  const wake2 = await fakeWake(flaky, {
    wake: () => (++wakes === 1 ? { ok: false, error: 'the session did not start' } : { ok: true }),
  })
  put(flaky, { id: 'eeee03' })
  await scheduler(flaky, { wakeUrl: wake2.url })
  await until(() => prompts(flaky).length === 1)
  assert.deepEqual(wake2.calls(), ['/sleep', '/wake', '/wake'])
  assert.deepEqual(prompts(flaky), ['[board reminder; restarted as you asked] Carry on.'])
})

test('a restart is for the session that asked: after /clear the new session in that pane is left alone', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  const wake = await fakeWake(box)
  // Asked by s0, which /clear replaced with s1 in the same pane and folder.
  put(box, { id: 'acac01', key: 's0', cwd: box.dir })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'acac01')?.why === 'gone')
  await pause(500)
  assert.deepEqual(wake.calls(), [])
  assert.deepEqual(prompts(box), [])
})

test('a herdr that does not answer holds a restart as a reason of its own, counted against the wait', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle', { 'agent get': { error: 'pane not found' } })
  const wake = await fakeWake(box)
  put(box, { id: 'adad01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => /^herdr did not answer/.test(String(read(box, 'adad01')?.why ?? '')))
  const first = Number(read(box, 'adad01')?.tried)
  await until(() => Number(read(box, 'adad01')?.tried) > first)
  assert.ok(Number(read(box, 'adad01')?.waited) > 0)
  assert.deepEqual(wake.calls(), [])
})

test('asked again over one that gave up, it is a new restart; an agent asking takes over one the user asked for', async () => {
  const box = await sandbox()
  const wake = await fakeWake(box)
  config(box, { wakeUrl: wake.url })
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working', cwd: box.dir },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const env = { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' }
  put(box, { id: 'afaf01', failed: 'herdr-wake is down', text: 'old note' })
  const r = await agentCli(box, ['restart', 'new', 'note'], env)
  assert.equal(r.code, 0, r.out)
  assert.equal(read(box, 'afaf01'), null)
  const [file] = entries(box)
  assert.ok(file)
  const e = read(box, file.slice(0, 6))
  assert.deepEqual([e?.failed, e?.text, e?.by], [undefined, 'new note', 'agent'])
  rmSync(join(dirOf(box), file))

  put(box, { id: 'afaf02', by: 'user' })
  const over = await agentCli(box, ['restart', 'mine now'], env)
  assert.match(over.out, /restart afaf02 is on its way already, with this note/)
  assert.deepEqual([read(box, 'afaf02')?.by, read(box, 'afaf02')?.text], ['agent', 'mine now'])
})

test('cancelled while it sleeps: the session is woken all the same, and gets nothing typed', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  const wake = await fakeWake(box, {
    sleep: () => {
      rmSync(join(dirOf(box), 'ffff01.json'))
      return { ok: true }
    },
  })
  put(box, { id: 'ffff01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => wake.calls().includes('/wake'))
  await pause(500)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), [])
  assert.deepEqual(runs(box), [])
})

test('a session that will not wake is left asleep after three tries; only the log says so', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  const wake = await fakeWake(box, { wake: () => ({ ok: false, error: 'the session did not start' }) })
  put(box, { id: 'abab01' })
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => runs(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake', '/wake', '/wake'])
  assert.equal(runs(box)[0]?.result, 'failed')
  assert.match(String(runs(box)[0]?.why), /the session did not start/)
  assert.equal(read(box, 'abab01'), null)
  assert.deepEqual(prompts(box), [])
})

/** The web board for the sandbox, up once its first refresh brought the sessions in. */
async function webBoard(box: Sandbox, cfg: Record<string, unknown>) {
  const port = await unusedPort()
  box.run('server', {
    port,
    language: 'en',
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    refreshSec: 3600,
    scheduleTickSec: 0.2,
    ...cfg,
  })
  const url = `http://127.0.0.1:${port}`
  // Actions through herdr wait for the board's first refresh.
  for (const deadline = Date.now() + 8000; ; await pause(100)) {
    try {
      const b = (await (await fetch(`${url}/api/board`)).json()) as { stale?: boolean; items?: unknown[] }
      if (!b.stale && b.items?.length) break
    } catch {}
    if (Date.now() > deadline) throw new Error('the board did not come up')
  }
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  return { post, port }
}

test('the web board asks for a restart for the user, says when one is on its way, refuses one without wake, and keeps its mode', async () => {
  const box = await sandbox()
  // Working: the scheduler leaves the restart waiting for the turn to end.
  herdrWith(box, 'working')
  const wake = await fakeWake(box)
  const { post } = await webBoard(box, { wakeUrl: wake.url })
  assert.equal((await post('/api/session/s1/restart', {}, {})).status, 403)
  const r = await post('/api/session/s1/restart')
  const body = (await r.json()) as { id: string; again?: boolean }
  assert.equal(r.status, 200, JSON.stringify(body))
  const e = read(box, body.id)
  assert.ok(e)
  assert.deepEqual([e.kind, e.by, e.key, e.pane, e.idle], ['restart', 'user', 's1', 'p1', true])
  const twice = (await (await post('/api/session/s1/restart')).json()) as { id: string; again?: boolean }
  assert.deepEqual([twice.id, twice.again], [body.id, true])
  // A restart always waits until the session is free.
  assert.equal((await post('/api/schedule', { op: 'mode', id: body.id, idle: false })).status, 400)
  assert.equal(read(box, body.id)?.idle, true)
  assert.deepEqual(wake.calls(), [])

  const lone = await sandbox()
  herdrWith(lone, 'idle')
  const { post: post2 } = await webBoard(lone, { wakeUrl: null })
  const no = await post2('/api/session/s1/restart')
  assert.equal(no.status, 409)
  // Once wake ships the board's tests run with it off (runner.ts): it says so. Before, with no wake
  // key, today's text.
  assert.match(
    ((await no.json()) as { error: string }).error,
    WAKE_SHIPPED ? /^Sleep and wake is off \(Settings → Sleep and wake…\)$/ : /needs herdr-wake/,
  )
  assert.equal(entries(lone).length, 0)
})

// ---------------------------------------------------------------- with profiles: the wrong account first

const REFUSED =
  'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'

/**
 * A home with the default and the work profile (each with settings.json), and s1's card saying its
 * hooks reported `profile`'s folder. `recorded`: the board opened p1 in the work profile, holding
 * terminal term-1 (profile-panes.json), which herdr shows p1 still holds. Returns the profiles as
 * config.json lists them, and the work folder.
 */
function twoProfiles(
  box: Sandbox,
  { profile = 'work', recorded = false }: { profile?: 'work' | 'default'; recorded?: boolean } = {},
) {
  const home = box.env.HOME as string
  for (const name of ['.claude', '.claude-work']) {
    mkdirSync(join(home, name), { recursive: true })
    writeFileSync(join(home, name, 'settings.json'), '{}')
  }
  const work = join(home, '.claude-work')
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, 's1.json'),
    JSON.stringify({ key: 's1', profileDir: profile === 'work' ? work : join(home, '.claude') }),
  )
  if (recorded) {
    const file = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'profile-panes.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ p1: { profile: 'work', terminal: 'term-1', at: Date.now() } }))
  }
  const profiles = [
    { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: work, color: 'teal', hidden: false },
  ]
  return { profiles, work, pane: { terminal_id: 'term-1' } }
}

test('a restart of a work session started outside the board is refused before any sleep: herdr-wake is not called', async () => {
  // Asked by the agent: it hears why once it is free; nothing put it to sleep.
  const box = await sandbox()
  const { profiles, pane } = twoProfiles(box)
  herdrWith(box, 'idle', {}, pane)
  const wake = await fakeWake(box, { pane })
  put(box, { id: 'baba01', text: 'my note' })
  await scheduler(box, { wakeUrl: wake.url, profiles })
  await until(() => prompts(box).length === 1)
  assert.deepEqual(prompts(box), [
    `[board reminder] restart did not happen: ${REFUSED}. Your note for after it: my note`,
  ])
  assert.deepEqual(wake.calls(), [])
  await until(() => runs(box).length === 1)
  assert.deepEqual([runs(box)[0]?.result, runs(box)[0]?.why], ['failed', REFUSED])

  // Asked by the user on the board: only the log says so, and nothing is typed.
  const user = await sandbox()
  const two = twoProfiles(user)
  herdrWith(user, 'idle', {}, two.pane)
  const wake2 = await fakeWake(user, { pane: two.pane })
  put(user, { id: 'baba02', by: 'user' })
  await scheduler(user, { wakeUrl: wake2.url, profiles: two.profiles })
  await until(() => runs(user).length === 1)
  assert.deepEqual([runs(user)[0]?.result, runs(user)[0]?.by, runs(user)[0]?.why], ['failed', 'user', REFUSED])
  assert.equal(read(user, 'baba02'), null)
  await pause(300)
  assert.deepEqual(wake2.calls(), [])
  assert.deepEqual(prompts(user), [])
})

test('the web board and board restart refuse a work session the board could not wake, before anything is scheduled', async () => {
  const box = await sandbox()
  const { profiles, pane } = twoProfiles(box)
  herdrWith(box, 'idle', {}, pane)
  const wake = await fakeWake(box, { pane })
  const { post } = await webBoard(box, { wakeUrl: wake.url, profiles })
  const r = await post('/api/session/s1/restart')
  assert.equal(r.status, 409)
  assert.equal(((await r.json()) as { error: string }).error, REFUSED)
  assert.equal(entries(box).length, 0)

  // The agent's own `board restart`, with no board answering: the same guard, its own profiles.
  config(box, { wakeUrl: wake.url, profiles })
  const out = await agentCli(box, ['restart', 'a note'], { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' })
  assert.equal(out.code, 1, out.out)
  assert.equal(out.out, `board: ${REFUSED}; nothing was scheduled`)
  assert.equal(entries(box).length, 0)
  await pause(300)
  assert.deepEqual(wake.calls(), [])
})

test('board restart asks the running board for its own profile: a session in the agent’s own env is refused when the board’s is another', async () => {
  // The agent's env points to the work folder (CLAUDE_CONFIG_DIR, set for its claude only); the
  // board runs with the default one, the pane's shell too, so herdr-wake would resume it there.
  const box = await sandbox()
  const { profiles, work, pane } = twoProfiles(box)
  herdrWith(box, 'idle', {}, pane)
  const wake = await fakeWake(box, { pane })
  const { port } = await webBoard(box, { wakeUrl: wake.url, profiles })
  config(box, { wakeUrl: wake.url, profiles, port })
  const env = { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1', CLAUDE_CONFIG_DIR: work }
  const out = await agentCli(box, ['restart'], env)
  assert.equal(out.code, 1, out.out)
  assert.equal(out.out, `board: ${REFUSED}; nothing was scheduled`)
  assert.equal(entries(box).length, 0)
})

test('a work session in a pane the board opened in its profile restarts, its registry read in its own profile’s folder', async () => {
  const box = await sandbox()
  const { profiles, work, pane } = twoProfiles(box, { recorded: true })
  herdrWith(box, 'idle', {}, pane)
  // A background command runs in it: the work folder's registry says so, the default one's not.
  registry(box, 'shell', work)
  const wake = await fakeWake(box, { pane })
  put(box, { id: 'cbcb01', text: 'back to work' })
  await scheduler(box, { wakeUrl: wake.url, profiles })
  await until(() => read(box, 'cbcb01')?.why === 'tasks')
  assert.deepEqual(wake.calls(), [])
  registry(box, 'idle', work)
  await until(() => prompts(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/wake'])
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] back to work'])

  // The default folder's registry saying `shell` for it holds nothing: it is not its profile's.
  const other = await sandbox()
  const two = twoProfiles(other, { recorded: true })
  herdrWith(other, 'idle', {}, two.pane)
  registry(other, 'shell')
  registry(other, 'idle', two.work)
  const wake2 = await fakeWake(other, { pane: two.pane })
  put(other, { id: 'cbcb02' })
  await scheduler(other, { wakeUrl: wake2.url, profiles: two.profiles })
  await until(() => prompts(other).length === 1)
  assert.deepEqual(wake2.calls(), ['/sleep', '/wake'])
})

test('a default-profile session in a pane the board opened in the work profile is refused: it would resume in work', async () => {
  const box = await sandbox()
  const { profiles, pane } = twoProfiles(box, { profile: 'default', recorded: true })
  herdrWith(box, 'idle', {}, pane)
  const wake = await fakeWake(box, { pane })
  put(box, { id: 'cbcb03' })
  await scheduler(box, { wakeUrl: wake.url, profiles })
  await until(() => prompts(box).length === 1)
  assert.match(prompts(box)[0] ?? '', /^\[board reminder\] restart did not happen: .*Work/)
  assert.deepEqual(wake.calls(), [])
})
