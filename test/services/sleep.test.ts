import { onTestFinished, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { heldEntries } from '../../src/core/archive.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { type ScheduleEntry, targetOf } from '../../src/core/schedule-rules.ts'
import type { Item } from '../../src/core/types.ts'
import { entryText } from '../../web/src/models/schedule.ts'
import { unusedPort } from '../support/board-server.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

// `board sleep` (and POST /api/sleep): several sessions put to sleep in one go through herdr-wake,
// each one answering how it went; with --when-free the busy ones get a schedule entry of kind
// 'sleep' that the scheduler carries out once they are free. The CLI, the scheduler and the board
// run in child processes against a fake herdr with several panes; herdr-wake is a small HTTP
// server here that turns a pane it puts to sleep into a shell, as the real one does.
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')
const dirOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')

type Stored = Record<string, unknown> & { text: string; next: number }
const read = (box: Sandbox, id: string): Stored | null =>
  existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null
const stored = (box: Sandbox): Stored[] =>
  existsSync(dirOf(box))
    ? readdirSync(dirOf(box))
        .filter(n => /^[0-9a-f]{6}\.json$/.test(n))
        .map(n => JSON.parse(readFileSync(join(dirOf(box), n), 'utf8')))
    : []
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

/** Claude's input box as `herdr agent read --ansi` shows it; a suggestion is drawn dim. */
const RULE = '─'.repeat(40)
const screen = (typed = '', dim = ''): string =>
  ['● done', RULE, `❯ ${typed}${dim ? `\x1b[2m${dim}\x1b[0m` : ''}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

/** A pane: Claude session `session` named `name` in herdr's status, or (status null) the shell left after it exited. */
type Pane = { id: string; session: string; name: string; status: string | null; typed?: string }

/** herdr with these panes, each answering `agent get` and `agent read` for itself. */
function herdrWith(box: Sandbox, panes: Pane[]): void {
  const state: Record<string, unknown> = {
    'api snapshot': {
      result: {
        snapshot: {
          panes: panes.map(p =>
            p.status
              ? {
                  pane_id: p.id,
                  agent: 'claude',
                  agent_session: { value: p.session },
                  agent_status: p.status,
                  cwd: box.dir,
                  terminal_title_stripped: p.name,
                }
              : { pane_id: p.id, agent: null, cwd: box.dir },
          ),
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent prompt': { result: {} },
  }
  for (const p of panes) {
    state[`agent get ${p.id}`] = {
      result: {
        agent: p.status ? { agent: 'claude', agent_status: p.status, agent_session: { value: p.session } } : null,
      },
    }
    state[`agent read ${p.id}`] = { text: screen(p.typed ?? '', 'try: run the tests') }
  }
  box.state(state)
}

/** Claude's own registry entry for a session: `shell` while a background command runs. */
function registry(box: Sandbox, session: string, status: string): void {
  const dir = join(box.env.HOME as string, '.claude', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${session}.json`),
    JSON.stringify({ sessionId: session, kind: 'interactive', pid: process.pid, status }),
  )
}

type WakeAnswer = { ok: boolean; error?: string }

/**
 * herdr-wake over `panes` (kept up to date as it puts them to sleep): /sleep turns the pane into a
 * shell and lists it under /sleeping; `asleep` lists sessions asleep from the start. `sleep`
 * answers instead, when given. `targets` are what /sleep was asked for, in order.
 */
async function fakeWake(
  box: Sandbox,
  panes: Pane[],
  { asleep = [], sleep }: { asleep?: Pane[]; sleep?: () => WakeAnswer } = {},
): Promise<{ url: string; targets: () => string[]; calls: () => string[] }> {
  const sleeping = [...asleep]
  const targets: string[] = []
  const calls: string[] = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping')
      return res.end(
        JSON.stringify(
          sleeping.map(p => ({ session: p.session, pane: p.id, name: p.name, slept_at: new Date().toISOString() })),
        ),
      )
    if (req.url === '/status') return res.end('{}')
    calls.push(req.url ?? '')
    if (req.url === '/sleep') {
      const target = String(JSON.parse(body || '{}').target)
      targets.push(target)
      const r = sleep ? sleep() : { ok: true }
      const pane = panes.find(p => p.id === target)
      if (r.ok && pane) {
        pane.status = null
        sleeping.push(pane)
        herdrWith(box, panes)
      }
      return res.end(JSON.stringify(r))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    targets: () => [...targets],
    calls: () => [...calls],
  }
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

async function scheduler(box: Sandbox, cfg: Record<string, unknown> = {}) {
  const proc = box.run('scheduler', {
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    scheduleTickSec: 0.2,
    ...cfg,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

/** A sleep entry for `pane`'s session, due now, as `board sleep --when-free` leaves it. */
function put(box: Sandbox, id: string, pane: Pane): void {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(
    join(dirOf(box), `${id}.json`),
    JSON.stringify({
      id,
      key: pane.session,
      name: pane.name,
      pane: pane.id,
      cwd: '',
      kind: 'sleep',
      idle: true,
      by: 'agent',
      text: '',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
      created: Date.now(),
    }),
  )
}

const pane = (id: string, name: string, status: string | null, typed?: string): Pane => ({
  id,
  session: `s-${id}`,
  name,
  status,
  ...(typed && { typed }),
})

test('board sleep puts every free one to sleep at once and says for each one that stays up why', async () => {
  const box = await sandbox()
  const panes = [
    pane('p1', 'One', 'idle'),
    pane('p2', 'Two', 'working'),
    pane('p4', 'Four', 'idle', 'half a thought'),
    pane('p5', 'Five', 'idle'),
    pane('p6', 'Six', 'blocked'),
    pane('p7', 'Twin', 'idle'),
    pane('p8', 'Twin', 'idle'),
    pane('p9', 'Nine', 'done'),
  ]
  const three = pane('p3', 'Three', null)
  herdrWith(box, [...panes, three])
  registry(box, 's-p5', 'shell')
  const wake = await fakeWake(box, panes, { asleep: [three] })
  config(box, { wakeUrl: wake.url })
  // One by its name and again by its session id, another by its pane.
  const r = await agentCli(box, [
    'sleep',
    'One',
    'p2',
    'three',
    'Four',
    'Five',
    'Six',
    'Twin',
    'nobody',
    'Nine',
    's-p1',
  ])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.out.split('\n'), [
    'ok · 2 put to sleep, 1 asleep already, 6 kept up · with --when-free the busy ones go to sleep once they are free',
    'One (p1): asleep',
    'Two (p2): kept up, working',
    'Three (p3): asleep already',
    'Four (p4): kept up, unsent text in its input box',
    'Five (p5): kept up, background tasks run',
    'Six (p6): kept up, a dialog waits for an answer',
    '"Twin": fits several sessions (Twin in p7, Twin in p8); give its session id or pane',
    '"nobody": no such session on the board',
    'Nine (p9): asleep',
    'One (p1): asleep',
  ])
  // Once each, only the free ones; nothing scheduled.
  assert.deepEqual(wake.targets().sort(), ['p1', 'p9'])
  assert.deepEqual(stored(box), [])
  assert.deepEqual(prompts(box), [])

  // herdr-wake refusing says so; without it nothing is tried.
  const refusing = await sandbox()
  const lone = [pane('p1', 'One', 'idle')]
  herdrWith(refusing, lone)
  const no = await fakeWake(refusing, lone, { sleep: () => ({ ok: false, error: 'One did not go to sleep' }) })
  config(refusing, { wakeUrl: no.url })
  const kept = await agentCli(refusing, ['sleep', 'One'])
  assert.match(kept.out, /^ok · 0 put to sleep, 1 kept up\nOne \(p1\): kept up, herdr-wake refused: Could not put One/)
  config(refusing, { wakeUrl: 'http://127.0.0.1:9' })
  const down = await agentCli(refusing, ['sleep', 'One'])
  assert.equal(down.code, 1)
  assert.match(
    down.out,
    /needs herdr-wake, which does not answer at http:\/\/127\.0\.0\.1:9 .+; nothing was put to sleep/,
  )
  assert.match((await agentCli(refusing, ['sleep'])).out, /^board: usage: board sleep <id\|name\|pane>/)
  assert.deepEqual(no.targets(), ['p1'])
})

test('board sleep --when-free: the free ones now, the busy ones once they are free; asked again it keeps one entry', async () => {
  const box = await sandbox()
  const panes = [pane('p1', 'One', 'idle'), pane('p2', 'Two', 'working'), pane('p3', 'Lead', 'working')]
  herdrWith(box, panes)
  const wake = await fakeWake(box, panes)
  config(box, { wakeUrl: wake.url })
  const lead = { CLAUDE_CODE_SESSION_ID: 's-p3', HERDR_PANE_ID: 'p3' }
  const r = await agentCli(box, ['sleep', 'One', 'Two', 'nobody', '--when-free'], lead)
  assert.equal(r.code, 0, r.out)
  const [e] = stored(box)
  assert.ok(e)
  assert.deepEqual(
    [e.kind, e.idle, e.by, e.key, e.pane, e.text, e.from],
    ['sleep', true, 'agent', 's-p2', 'p2', '', { key: 's-p3', name: 'Lead' }],
  )
  const lines = r.out.split('\n')
  assert.match(lines[0] ?? '', /^ok · 1 put to sleep, 1 once free, 1 kept up · note: no board with the scheduler/)
  assert.deepEqual(lines.slice(1), [
    'One (p1): asleep',
    `Two (p2): working; goes to sleep once it is free · cancel: board unschedule ${e.id}`,
    '"nobody": no such session on the board',
  ])
  assert.deepEqual(wake.targets(), ['p1'])

  const again = await agentCli(box, ['sleep', 'Two', '--when-free'], lead)
  assert.match(
    again.out,
    new RegExp(
      `Two \\(p2\\): working; goes to sleep once it is free \\(asked before\\) · cancel: board unschedule ${e.id}`,
    ),
  )
  assert.equal(stored(box).length, 1)
  const list = await agentCli(box, ['schedule', '--all'])
  assert.match(list.out, new RegExp(`^${e.id} · sleep, asked .+ · once the session is free · Two$`))
})

test('the scheduler puts a busy one to sleep once it is free, and nothing more: no wake, nothing typed', async () => {
  const box = await sandbox()
  const two = pane('p2', 'Two', 'working')
  herdrWith(box, [two])
  const wake = await fakeWake(box, [two])
  put(box, 'cccc01', two)
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => read(box, 'cccc01')?.why === 'busy')
  // Its turn is over, but the user started typing.
  two.status = 'idle'
  two.typed = 'half a thought'
  herdrWith(box, [two])
  await until(() => read(box, 'cccc01')?.why === 'draft')
  assert.deepEqual(wake.calls(), [])
  two.typed = ''
  herdrWith(box, [two])
  await until(() => runs(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep'])
  assert.equal(read(box, 'cccc01'), null)
  const [run] = runs(box)
  assert.deepEqual([run?.result, run?.kind, run?.key], ['sent', 'sleep', 's-p2'])
  assert.deepEqual(prompts(box), [])
})

test('a sleep herdr-wake keeps refusing is given up after three tries, in the log only', async () => {
  const box = await sandbox()
  const one = pane('p1', 'One', 'idle')
  herdrWith(box, [one])
  const wake = await fakeWake(box, [one], { sleep: () => ({ ok: false, error: 'One did not go to sleep' }) })
  put(box, 'dddd01', one)
  await scheduler(box, { wakeUrl: wake.url })
  await until(() => runs(box).length === 1)
  assert.deepEqual(wake.calls(), ['/sleep', '/sleep', '/sleep'])
  assert.equal(read(box, 'dddd01'), null)
  const [run] = runs(box)
  assert.deepEqual([run?.result, run?.kind], ['failed', 'sleep'])
  assert.match(String(run?.why), /^Could not put One to sleep: it stayed up/)
  assert.deepEqual(prompts(box), [])
})

test('POST /api/sleep does the same for agents that speak to the board', async () => {
  const box = await sandbox()
  const panes = [pane('p1', 'One', 'idle'), pane('p2', 'Two', 'working')]
  herdrWith(box, panes)
  const wake = await fakeWake(box, panes)
  const port = await unusedPort()
  box.run('server', {
    port,
    language: 'en',
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    refreshSec: 3600,
    scheduleTickSec: 3600,
    wakeUrl: wake.url,
  })
  const url = `http://127.0.0.1:${port}`
  // Actions through herdr wait for the board's first refresh.
  for (const deadline = Date.now() + 8000; ; await new Promise(resolve => setTimeout(resolve, 100))) {
    try {
      const b = (await (await fetch(`${url}/api/board`)).json()) as { stale?: boolean; items?: unknown[] }
      if (!b.stale && b.items?.length) break
    } catch {}
    if (Date.now() > deadline) throw new Error('the board did not come up')
  }
  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }, path = '/api/sleep') =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  assert.equal((await post({ targets: ['One'] }, {})).status, 403)
  assert.equal((await post({ targets: [] })).status, 400)
  const r = await post({ targets: ['One', 'Two', 'nobody'], whenFree: true })
  const body = (await r.json()) as { ok: boolean; results: Record<string, unknown>[] }
  assert.equal(r.status, 200, JSON.stringify(body))
  const id = String(stored(box)[0]?.id)
  assert.deepEqual(body.results, [
    { target: 'One', key: 's-p1', name: 'One', pane: 'p1', result: 'asleep' },
    { target: 'Two', key: 's-p2', name: 'Two', pane: 'p2', result: 'scheduled', why: 'busy', id, again: false },
    { target: 'nobody', result: 'kept', why: 'unknown' },
  ])
  assert.deepEqual(wake.targets(), ['p1'])
  // A sleep always waits until the session is free.
  assert.equal((await post({ op: 'mode', id, idle: false }, undefined, '/api/schedule')).status, 400)
  assert.equal(read(box, id)?.idle, true)
})

test('a sleep is for its own session only, does not wait in the archive with it, and reads as one on the page', () => {
  const t = translator('en')
  const entry: ScheduleEntry = { id: 'eeee01', key: 's1', kind: 'sleep', next: 0, text: '', pane: 'p1', cwd: '/w' }
  // The session after /clear in that pane, in the same profile: a reminder follows it there, a sleep does not.
  const next = { key: 's2', session: 's2', pane: 'p1', cwd: '/w' } as Item
  const { kind, ...reminder } = entry
  assert.equal(targetOf(reminder, [next], () => 'default').item?.key, 's2')
  assert.deepEqual(
    targetOf(entry, [next], () => 'default'),
    {},
  )
  assert.deepEqual(
    heldEntries([entry, { ...reminder, id: 'eeee02' }], 's1').map(e => e.id),
    ['eeee02'],
  )
  assert.equal(entryText(entry, t), 'Put to sleep once free')
})
