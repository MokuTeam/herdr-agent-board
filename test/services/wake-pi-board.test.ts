// pi sessions asleep, on the board's side (#178). A pi session wake put to sleep shows as a
// sleeping card under its session file's key, from wake's answer or, while wake does not answer,
// from wake's pi file; with its pane while that is still its own, without it once it is gone. Its
// card wakes it (the board itself types `board resume --pi <id>` while wake does not answer: in its
// pane, or in a new tab of its workspace), a message to it goes to the pane it woke in, and `board
// sleep` puts it to sleep through the board's wake, by its session file. The separate herdr-wake
// plugin still puts no pi session to sleep.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { boardOnPath, paneCalls, stateDir, wakeRuns } from '../support/sleeper-fixtures.ts'

setDefaultTimeout(40_000)
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const ID = '01a15d6d-9f21-7751-a71a-834d50839768'
const LINE = `board resume --pi ${ID}`
const SLEPT = Date.UTC(2026, 9, 21, 22)

/** The session's folder (spaces, Cyrillic, %) and its pi session file, its last turn over. */
function piSession(box: Sandbox): { cwd: string; file: string } {
  const cwd = join(box.dir, 'Upsun', 'Проект x 50%')
  mkdirSync(cwd, { recursive: true })
  const folder = join(box.env.HOME as string, '.pi', 'agent', 'sessions', '--Upsun-Проект x 50%--')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `2026-10-21T07-47-07-681Z_${ID}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id: ID, cwd },
    { type: 'session_info', id: 'e0', parentId: null, name: 'pricing-sync' },
    { type: 'message', id: 'e1', parentId: 'e0', message: { role: 'user', content: 'go' } },
    {
      type: 'message',
      id: 'e2',
      parentId: 'e1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' },
    },
  ]
  writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  return { cwd, file }
}

/** Wake's pi file with the session asleep in w1:p1, as the wake process writes it. */
function asleepInPiFile(box: Sandbox, s: { cwd: string; file: string }): void {
  mkdirSync(stateDir(box), { recursive: true })
  const entry = {
    session: s.file,
    name: 'pricing-sync',
    pane: 'w1:p1',
    workspace: 'w1',
    workspaceLabel: 'UP_WORK',
    cwd: s.cwd,
    argv: ['pi'],
    account: join(box.env.HOME as string, '.claude-work'),
    slept_at: SLEPT,
  }
  writeFileSync(join(stateDir(box), 'wake-pi.json'), JSON.stringify({ [s.file]: entry }))
}

const RULE = '─'.repeat(40)
const PI_SCREEN = ['● Done.', '', RULE, '\x1b[7m \x1b[0m', RULE, 'xhigh · Opus 5.5   WORK'].join('\n')

/**
 * herdr with workspace w1 "UP_WORK": its pane w1:p1 a bash shell in the session's folder (`own`), or
 * gone; pi comes up idle on the session file in w1:p1, or in the new tab's w1:p9, once `pane run`
 * was called. `running`: pi runs there from the start (to be put to sleep).
 */
function herdrPi(
  box: Sandbox,
  s: { cwd: string; file: string },
  o: { own: boolean; running?: boolean; wokenByWake?: boolean },
): void {
  const shell = { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', cwd: s.cwd }
  const woken = o.own ? 'w1:p1' : 'w1:p9'
  const pi = (pane: string) => ({
    pane_id: pane,
    workspace_id: 'w1',
    tab_id: pane === 'w1:p1' ? 't1' : 't9',
    cwd: s.cwd,
    agent: 'pi',
    agent_status: 'idle',
    agent_session: { value: s.file },
    terminal_title_stripped: 'π - pricing-sync',
  })
  const snapshot = (panes: unknown[]) => ({
    result: {
      snapshot: {
        workspaces: [{ workspace_id: 'w1', label: 'UP_WORK' }],
        tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
        panes,
      },
    },
  })
  const before = o.running ? [pi('w1:p1')] : o.own ? [shell] : []
  const after = o.own ? [pi('w1:p1')] : [pi('w1:p9')]
  const agent = { result: { agent: { agent: 'pi', agent_status: 'idle', agent_session: { value: s.file } } } }
  box.state({
    // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply once the line ran (test/support/fake-herdr.ts)
    'api snapshot': { ...snapshot(before), until: ['pane run'], then: snapshot(after) },
    [`pane get ${woken}`]: {
      result: { pane: o.own ? shell : { pane_id: 'w1:p9', workspace_id: 'w1', cwd: s.cwd } },
      until: ['pane run'],
      // biome-ignore lint/suspicious/noThenProperty: as above
      then: { result: { pane: pi(woken) } },
    },
    // biome-ignore lint/suspicious/noThenProperty: as above
    'agent get': o.running ? agent : { result: { agent: null }, until: ['pane run'], then: agent },
    // Woken by the board's wake (a stand-in here, which runs nothing in herdr): up in the new tab.
    ...(o.wokenByWake && { 'agent get w1:p9': agent }),
    'pane process-info': {
      result: { process_info: { shell_pid: 4242, foreground_processes: [{ pid: 4242, name: 'bash' }] } },
    },
    'tab create': { result: { tab: { tab_id: 't9' }, root_pane: { pane_id: 'w1:p9', terminal_id: 'term9' } } },
    'pane read': { text: PI_SCREEN },
    'pane run': { result: {} },
    'pane send-keys': { result: {} },
    'pane rename': { result: {} },
    'agent prompt': { result: {} },
  })
}

type Shown = {
  key: string
  agent?: string
  sleeping?: boolean
  pane?: string | null
  workspace?: string
  category?: string
}

/** The web board for the sandbox; `card` refreshes until it shows the session's card, and gives it. */
async function board(box: Sandbox, cfg: Record<string, unknown>, file: string) {
  const categories = [
    { id: 'up_work', title: 'UP_WORK', color: 'blue', paths: [join(box.dir, 'Upsun')] },
    { id: 'other', title: 'Other', color: 'gray' },
  ]
  const { url, proc } = await serveBoard(box, { language: 'en', categories, ...cfg }, boardOnPath(box))
  const refreshed = (): number => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  const card = async (fits: (i: Shown) => boolean = () => true): Promise<Shown> => {
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(50)) {
      const before = refreshed()
      proc.send('refresh')
      await until(() => refreshed() > before)
      const b = (await (await fetch(`${url}/api/board`)).json()) as { stale?: boolean; items?: Shown[] }
      const it = b.items?.find(i => i.key === file)
      if (!b.stale && it && fits(it)) return it
      if (Date.now() > deadline) throw new Error(`the board did not show ${file} as asked`)
    }
  }
  const post = async (action: string, body: unknown = {}) => {
    const res = await fetch(`${url}/api/session/${encodeURIComponent(file)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { card, post }
}

for (const [setup, wakeCfg] of [
  ['wake off', async () => ({ wake: false })],
  ['wake on but nothing listening on its port', async () => ({ wake: { enabled: true, port: await unusedPort() } })],
] as const) {
  test(`${setup}: a pi asleep in its pane shows as a sleeping card in its lane, and Wake types board resume --pi there`, async () => {
    const box = await sandbox()
    const s = piSession(box)
    asleepInPiFile(box, s)
    herdrPi(box, s, { own: true })
    const cfg = await wakeCfg()
    if (typeof cfg.wake === 'object') wakeRuns(box)
    const { card, post } = await board(box, cfg, s.file)
    const shown = await card()
    assert.deepEqual(
      [shown.agent, shown.sleeping, shown.pane, shown.workspace, shown.category],
      ['pi', true, 'w1:p1', 'UP_WORK', 'up_work'],
    )
    const r = await post('wake')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(paneCalls(box), [
      ['pane', 'process-info', '--pane', 'w1:p1'],
      ['pane', 'send-keys', 'w1:p1', 'ctrl+u'],
      ['pane', 'run', 'w1:p1', LINE],
    ])
    await card(i => !i.sleeping && i.pane === 'w1:p1')
  })
}

test('its pane gone (a restart, a closed tab), the card stays, and Wake opens a new tab of its workspace in its folder', async () => {
  const box = await sandbox()
  const s = piSession(box)
  asleepInPiFile(box, s)
  herdrPi(box, s, { own: false })
  const { card, post } = await board(box, { wake: false }, s.file)
  const shown = await card()
  assert.deepEqual([shown.sleeping, shown.pane ?? null, shown.workspace], [true, null, 'UP_WORK'])
  const r = await post('wake')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const opened = box.calls().find(c => c[0] === 'tab' && c[1] === 'create')
  assert.deepEqual(opened, [
    'tab',
    'create',
    '--workspace',
    'w1',
    '--cwd',
    s.cwd,
    '--label',
    'pricing-sync',
    '--no-focus',
  ])
  assert.deepEqual(
    paneCalls(box).filter(c => c[1] === 'run'),
    [['pane', 'run', 'w1:p9', LINE]],
  )
})

test('with the board’s wake answering: its list asked with pi’s, a message wakes it there and goes to the pane it woke in', async () => {
  const box = await sandbox()
  const s = piSession(box)
  herdrPi(box, s, { own: false, wokenByWake: true })
  const wake = await fakeWake({
    sleeping: [
      {
        name: 'pricing-sync',
        pane: '',
        session: s.file,
        workspace: 'UP_WORK',
        slept_at: new Date(SLEPT).toISOString(),
        exited: false,
        agent: 'pi',
        cwd: s.cwd,
      },
    ],
    wake: () => ({ ok: true, pane: 'w1:p9', name: 'pricing-sync' }),
  })
  wakeRuns(box)
  const { card, post } = await board(box, { wake: { enabled: true, port: wake.port } }, s.file)
  const shown = await card()
  assert.deepEqual([shown.agent, shown.sleeping, shown.pane ?? null], ['pi', true, null])
  assert.ok(wake.requests().some(q => q.path === '/sleeping' && q.query === 'agents=all'))
  const r = await post('message', { text: 'how is it going?', session: s.file })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(
    wake.requests().filter(q => q.method === 'POST'),
    [{ method: 'POST', path: '/wake', body: { target: s.file } }],
  )
  assert.deepEqual(
    box.calls().filter(c => c[1] === 'prompt'),
    [['agent', 'prompt', 'w1:p9', 'how is it going?']],
  )
})

function config(box: Sandbox, cfg: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...cfg }))
}

async function cli(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  const r = await box.run('cli', { args, env: boardOnPath(box) }).exited
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() }
}

test('board sleep puts a free pi to sleep through the board’s wake, by its session file', async () => {
  const box = await sandbox()
  const s = piSession(box)
  herdrPi(box, s, { own: true, running: true })
  const wake = await fakeWake()
  config(box, { wake: { enabled: true, port: wake.port } })
  wakeRuns(box)
  const r = await cli(box, ['sleep', 'w1:p1'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.out.split('\n'), ['ok · 1 put to sleep', 'pricing-sync (w1:p1): asleep'])
  assert.deepEqual(
    wake.requests().filter(q => q.method === 'POST'),
    [{ method: 'POST', path: '/sleep', body: { target: s.file } }],
  )
})

test('with the separate herdr-wake plugin, a pi stays up as before: it puts only Claude sessions to sleep', async () => {
  const box = await sandbox()
  const s = piSession(box)
  herdrPi(box, s, { own: true, running: true })
  const old = await fakeWake({ oldRouter: true })
  config(box, { wakeUrl: old.url })
  // The board's wake holds back while the separate plugin is installed.
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(join(stateDir(box), 'wake-status.json'), JSON.stringify({ state: 'held', at: Date.now() }))
  const r = await cli(box, ['sleep', 'w1:p1'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.out.split('\n'), [
    'ok · 0 put to sleep, 1 kept up',
    'pricing-sync (w1:p1): kept up, not a Claude session, and herdr-wake puts only those to sleep',
  ])
  assert.deepEqual(
    old.requests().filter(q => q.method === 'POST'),
    [],
  )
})

test('board sleep <pane> --pi-session <file>: a pane where pi was stopped by hand taken as that session asleep', async () => {
  const box = await sandbox()
  const s = piSession(box)
  herdrPi(box, s, { own: true })
  const wake = await fakeWake({ sleep: () => ({ ok: true, pane: 'w1:p1', name: 'pricing-sync' }) })
  config(box, { wake: { enabled: true, port: wake.port } })
  wakeRuns(box)
  const r = await cli(box, ['sleep', 'w1:p1', '--pi-session', s.file])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ok · pricing-sync \(pi\) is asleep in w1:p1: its card shows it sleeping/)
  assert.deepEqual(
    wake.requests().filter(q => q.method === 'POST'),
    [{ method: 'POST', path: '/sleep', body: { target: 'w1:p1', piSession: s.file } }],
  )
  // Not without the board's own wake: it holds back while the separate plugin is installed.
  const old = await fakeWake({ oldRouter: true })
  config(box, { wakeUrl: old.url })
  writeFileSync(join(stateDir(box), 'wake-status.json'), JSON.stringify({ state: 'held', at: Date.now() }))
  const refused = await cli(box, ['sleep', 'w1:p1', '--pi-session', s.file])
  assert.equal(refused.code, 1)
  assert.match(refused.out, /needs the board's own wake, and herdr-wake answers here; nothing was done/)
})
