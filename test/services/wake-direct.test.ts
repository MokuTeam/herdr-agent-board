// The board's own wake (#119, call 28; calls 19 and 4; preflight H1, M16). With wake off, or on
// with nothing listening on its port, a sleeping card's Wake types `board resume <id> --profile
// <id>` into its pane itself, guarded by the "can wake" rule instead of the old profile guard; with
// wake slow to answer it types nothing (wake may be waking that session). Put to sleep, `board
// sleep` and a new `board restart` say wake is off only when today's path would refuse too and
// config.json's own `wake` key turns it off; without the key, today's texts; with herdr-wake
// answering at wakeUrl, through it as today. The board never writes wake's session file.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  card,
  herdrAsleep,
  paneCalls,
  projectDir,
  SCREEN,
  SID,
  SLEPT,
  scheduleDir,
  stateDir,
  transcript,
  twoProfiles,
  wakeFileText,
  wakeRuns,
} from '../support/sleeper-fixtures.ts'

setDefaultTimeout(40_000)
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

type Shown = { key: string; profile?: string | null }

/** The web board for the sandbox, once it shows the session; `post` sends as the page does, `shows` refreshes it until it shows the session as `fits`. */
async function board(box: Sandbox, cfg: Record<string, unknown>, env: Record<string, string> = {}) {
  const { url, proc } = await serveBoard(box, { language: 'en', ...cfg }, env)
  const refreshed = (): number => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  const shows = async (fits: (item: Shown) => boolean = () => true): Promise<void> => {
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(50)) {
      const before = refreshed()
      proc.send('refresh')
      await until(() => refreshed() > before)
      const b = (await (await fetch(`${url}/api/board`)).json()) as { stale?: boolean; items?: Shown[] }
      if (!b.stale && b.items?.some(i => i.key === SID && fits(i))) return
      if (Date.now() > deadline) throw new Error(`the board did not show ${SID} as asked`)
    }
  }
  await shows()
  const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { url, post, shows }
}

const RESUME = `board resume ${SID} --profile work`

for (const [setup, wakeCfg] of [
  ['wake off', async () => ({ wake: false })],
  ['wake on but nothing listening on its port', async () => ({ wake: { enabled: true, port: await unusedPort() } })],
] as const)
  test(`${setup}, a Work session asleep: Wake types board resume <id> --profile work into its pane`, async () => {
    const box = await sandbox()
    const { work, list } = twoProfiles(box)
    const cwd = projectDir(box)
    transcript(work, cwd)
    const file = asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
    // Its hooks reported the work folder, and the board did not open its pane: the old guard
    // (mayWake) refuses such a session; the board's own wake sets the profile itself.
    card(box, work)
    herdrAsleep(box, cwd)
    const cfg = await wakeCfg()
    if (typeof cfg.wake === 'object') wakeRuns(box)
    const { post } = await board(box, { ...cfg, wakeUrl: null, profiles: list }, boardOnPath(box))
    const r = await post(`/api/session/${SID}/wake`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(paneCalls(box), [
      ['pane', 'process-info', '--pane', 'p1'],
      ['pane', 'send-keys', 'p1', 'esc'],
      ['pane', 'run', 'p1', RESUME],
      // L14: its 💤 label cleared once it runs.
      ['pane', 'rename', 'p1', '--clear'],
    ])
    // One writer: the board leaves wake's session file as it was.
    assert.equal(wakeFileText(box), file)
  })

test('a POSIX shell gets Ctrl+U before the line, the profile folder spelled another way', async () => {
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  // The file spells the folder with a trailing separator; the profile id comes from the card.
  asleepInFile(box, { cwd, profileDir: `${work}/` })
  card(box, work)
  herdrAsleep(box, cwd, { shell: '/usr/bin/bash' })
  const { post } = await board(box, { wake: false, wakeUrl: null, profiles: list }, boardOnPath(box))
  const r = await post(`/api/session/${SID}/wake`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(paneCalls(box).slice(0, 3), [
    ['pane', 'process-info', '--pane', 'p1'],
    ['pane', 'send-keys', 'p1', 'ctrl+u'],
    ['pane', 'run', 'p1', RESUME],
  ])
})

test('two Wakes at once: the line is typed once, and the second finds the session up', async () => {
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  const { post } = await board(box, { wake: false, wakeUrl: null, profiles: list }, boardOnPath(box))
  const both = await Promise.all([post(`/api/session/${SID}/wake`), post(`/api/session/${SID}/wake`)])
  assert.deepEqual(
    both.map(r => r.status),
    [200, 200],
    JSON.stringify(both.map(r => r.body)),
  )
  assert.equal(paneCalls(box).filter(c => c[1] === 'run').length, 1)
})

test('wake slow to answer: no second wake is typed, and the user is told why', async () => {
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  const wake = await fakeWake()
  wake.slow = true
  wakeRuns(box)
  const { post } = await board(
    box,
    { wake: { enabled: true, port: wake.port }, wakeUrl: null, profiles: list },
    boardOnPath(box),
  )
  const r = await post(`/api/session/${SID}/wake`)
  assert.equal(r.status, 409)
  assert.equal(r.body.error, 'Wake is slow to answer and may be waking Report already; try again in a minute')
  assert.equal(r.body.wakeBusy, true)
  assert.deepEqual(paneCalls(box), [])
  assert.ok(wake.requests().some(q => q.method === 'GET' && q.path === '/alive'))
  assert.ok(!wake.requests().some(q => q.method === 'POST'))
})

test('the guard: the new path refuses only what it could not wake again', async () => {
  // No transcript in its profile's folder: board resume could not bring it back.
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  const { post } = await board(box, { wake: false, wakeUrl: null, profiles: list }, boardOnPath(box))
  const r = await post(`/api/session/${SID}/wake`)
  assert.equal(r.status, 409)
  assert.equal(r.body.error, "Report could not be woken again: its conversation is not in its profile's folder")
  assert.deepEqual(paneCalls(box), [])

  // board not on PATH: the line it would type could not run.
  const bare = await sandbox()
  const two = twoProfiles(bare)
  const there = projectDir(bare)
  transcript(two.work, there)
  asleepInFile(bare, { cwd: there, profileDir: two.work, profile: 'work' })
  herdrAsleep(bare, there)
  const off = await board(bare, { wake: { enabled: false }, wakeUrl: null, profiles: two.list })
  const r2 = await off.post(`/api/session/${SID}/wake`)
  assert.equal(r2.status, 409)
  assert.equal(r2.body.error, 'Report could not be woken again: the board command is not on PATH')
  assert.deepEqual(paneCalls(bare), [])
})

// ---------------------------------------------------------------- the old path, as today

const REFUSED =
  'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'

for (const [name, wake] of [
  ['no wake key', undefined],
  ['"wake": false', false],
] as const)
  test.skipIf(wake === undefined && WAKE_SHIPPED)(
    `the old path is today’s (${name}): wakeUrl, its guard and its texts`,
    async () => {
      const box = await sandbox()
      const { work, list } = twoProfiles(box)
      const cwd = projectDir(box)
      transcript(work, cwd)
      herdrAsleep(box, cwd)
      const old = await fakeWake({
        sleeping: [{ session: SID, pane: 'p1', name: 'Report', slept_at: new Date(SLEPT).toISOString() }],
      })
      // A session of the board's own profile: herdr-wake wakes it.
      card(box, join(box.env.HOME as string, '.claude'))
      const cfg = { wakeUrl: old.url, profiles: list, ...(wake === undefined ? {} : { wake }) }
      const { post, shows } = await board(box, cfg, boardOnPath(box))
      const r = await post(`/api/session/${SID}/wake`)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(
        old.requests().filter(q => q.method === 'POST'),
        [{ method: 'POST', path: '/wake', body: { target: 'p1' } }],
      )
      assert.deepEqual(paneCalls(box), [])
      // A Work session started outside the board: the old guard refuses it, as today.
      card(box, work)
      await shows(i => i.profile === 'work')
      const refused = await post(`/api/session/${SID}/wake`)
      assert.equal(refused.status, 409)
      assert.equal(refused.body.error, REFUSED)
      assert.equal(old.requests().filter(q => q.method === 'POST').length, 1)
      assert.deepEqual(paneCalls(box), [])
    },
  )

// ---------------------------------------------------------------- Put to sleep, board sleep, board restart

/** herdr with the session running in p1, idle, and its registry in the default folder. */
function running(box: Sandbox): void {
  const cwd = projectDir(box)
  const pane = { pane_id: 'p1', agent: 'claude', agent_session: { value: SID }, agent_status: 'idle', cwd }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
  })
  const sessions = join(box.env.HOME as string, '.claude', 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, '1.json'),
    JSON.stringify({ sessionId: SID, kind: 'interactive', pid: process.pid, status: 'idle', name: 'Report' }),
  )
}

/** The board's config.json, for the CLI (port 9 answers nothing: no live board is asked). */
function config(box: Sandbox, cfg: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...cfg }))
}

async function cli(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  const r = await box.run('cli', { args, env: { CLAUDE_CODE_SESSION_ID: SID, HERDR_PANE_ID: 'p1' } }).exited
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() }
}

const entries = (box: Sandbox): string[] =>
  existsSync(scheduleDir(box)) ? readdirSync(scheduleDir(box)).filter(n => /^[0-9a-f]{6}\.json$/.test(n)) : []

const OFF = 'Sleep and wake is off (Settings → Sleep and wake…)'

test('with wake off, Put to sleep, board sleep and a new board restart refuse and say it is off', async () => {
  // H1: config.json turns wake off itself, and herdr-wake does not answer at wakeUrl.
  const box = await sandbox()
  running(box)
  const cfg = { wake: { enabled: false }, wakeUrl: `http://127.0.0.1:${await unusedPort()}` }
  const { post } = await board(box, cfg)
  for (const path of [`/api/session/${SID}/sleep`, `/api/session/${SID}/restart`])
    assert.deepEqual([path, (await post(path)).body.error], [path, OFF])
  const many = await post('/api/sleep', { targets: [SID] })
  assert.deepEqual([many.status, many.body.error], [409, OFF])

  config(box, cfg)
  const sleep = await cli(box, ['sleep', SID])
  assert.equal(sleep.code, 1, sleep.out)
  assert.equal(
    sleep.out,
    'board: putting sessions to sleep needs wake, and it is off (Settings → Sleep and wake…); nothing was put to sleep',
  )
  const restart = await cli(box, ['restart', 'a note'])
  assert.equal(restart.code, 1, restart.out)
  assert.match(
    restart.out,
    /^board: a restart needs wake, and it is off \(Settings → Sleep and wake…\); nothing was scheduled/,
  )
  assert.deepEqual(entries(box), [])
  assert.ok(!box.calls().some(c => c[0] === 'agent' && c[1] === 'prompt'))
})

test.skipIf(WAKE_SHIPPED)('without a wake key and nothing at wakeUrl, the refusals are today’s', async () => {
  const box = await sandbox()
  running(box)
  const { post } = await board(box, { wakeUrl: null })
  assert.match(String((await post(`/api/session/${SID}/sleep`)).body.error), /^herdr-wake did not answer: /)
  assert.equal(
    (await post(`/api/session/${SID}/restart`)).body.error,
    'A restart needs herdr-wake, and wakeUrl in the board’s config.json is empty',
  )
  config(box, { wakeUrl: null })
  assert.equal(
    (await cli(box, ['sleep', SID])).out,
    "board: putting sessions to sleep needs herdr-wake, and wakeUrl in the board's config.json is empty; nothing was put to sleep",
  )
  assert.match(
    (await cli(box, ['restart'])).out,
    /^board: a restart needs herdr-wake, and wakeUrl in the board's config\.json is empty; nothing was scheduled\. Ask the user/,
  )
  assert.deepEqual(entries(box), [])
})

for (const [name, wake] of [
  ['no wake key', undefined],
  ['"wake": false', false],
] as const)
  test.skipIf(wake === undefined && WAKE_SHIPPED)(
    `${name} and herdr-wake at wakeUrl: Put to sleep, board sleep and board restart go through it`,
    async () => {
      const box = await sandbox()
      running(box)
      const old = await fakeWake()
      const cfg = { wakeUrl: old.url, ...(wake === undefined ? {} : { wake }) }
      const { post } = await board(box, cfg)
      const put = await post(`/api/session/${SID}/sleep`)
      assert.equal(put.status, 200, JSON.stringify(put.body))
      config(box, cfg)
      const sleep = await cli(box, ['sleep', SID])
      assert.equal(sleep.code, 0, sleep.out)
      assert.match(sleep.out, /^ok · 1 put to sleep/)
      const sleeps = old.requests().filter(q => q.method === 'POST')
      assert.deepEqual(sleeps, [
        { method: 'POST', path: '/sleep', body: { target: 'p1' } },
        { method: 'POST', path: '/sleep', body: { target: 'p1' } },
      ])
      const restart = await cli(box, ['restart', 'a note'])
      assert.equal(restart.code, 0, restart.out)
      assert.match(restart.out, /^ok · restart [0-9a-f]{6}/)
      assert.equal(entries(box).length, 1)
    },
  )

test('wake on and running: board sleep and board schedule name it wake, never herdr-wake', async () => {
  const box = await sandbox()
  running(box)
  const wake = await fakeWake({ sleep: () => ({ ok: false, error: 'no running session in p1' }) })
  config(box, { wake: { enabled: true, port: wake.port } })
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(
    join(stateDir(box), 'wake-status.json'),
    JSON.stringify({ state: 'running', at: Date.now(), port: wake.port }),
  )
  const sleep = await cli(box, ['sleep', SID])
  assert.equal(sleep.code, 0, sleep.out)
  assert.match(sleep.out, /kept up, wake refused: Could not put .+ to sleep: wake does not know it$/)
  // A restart the board's wake refused, as `board schedule --all` lists it.
  mkdirSync(scheduleDir(box), { recursive: true })
  const at = Date.now()
  writeFileSync(
    join(scheduleDir(box), 'abc123.json'),
    JSON.stringify({
      id: 'abc123',
      key: SID,
      kind: 'restart',
      next: at,
      created: at,
      attempts: 1,
      why: 'it stayed up',
    }),
  )
  const listed = await cli(box, ['schedule', '--all'])
  assert.match(listed.out, /\(wake refused, tries again: it stayed up\)/)
  assert.doesNotMatch(`${sleep.out}\n${listed.out}`, /herdr-wake/)
})

// ---------------------------------------------------------------- a restart in its wake step

test('a restart in its wake step when wake goes off finishes: woken by the board, then its note', async () => {
  // Wake put it to sleep for the restart, then was turned off: the board wakes it itself.
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  mkdirSync(scheduleDir(box), { recursive: true })
  const past = Date.now() - 1000
  writeFileSync(
    join(scheduleDir(box), 'dede01.json'),
    JSON.stringify({
      id: 'dede01',
      key: SID,
      name: 'Report',
      pane: 'p1',
      kind: 'restart',
      idle: true,
      by: 'agent',
      text: 'back to the report',
      step: 'wake',
      at: past,
      next: past,
      created: past,
    }),
  )
  const proc = box.run(
    'scheduler',
    {
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wake: false,
      wakeUrl: null,
      profiles: list,
      scheduleTickSec: 0.2,
      restartSettleSec: 0,
    },
    boardOnPath(box),
  )
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  const log = join(scheduleDir(box), 'log.jsonl')
  await until(() => existsSync(log), 20_000)
  const [run] = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual([run?.result, run?.kind], ['sent', 'restart'])
  assert.ok(paneCalls(box).some(c => c.join(' ') === `pane run p1 ${RESUME}`))
  assert.deepEqual(
    box
      .calls()
      .filter(c => c[0] === 'agent' && c[1] === 'prompt')
      .map(c => c[3]),
    ['[board reminder; restarted as you asked] back to the report'],
  )
  assert.equal(entries(box).length, 0)
})
