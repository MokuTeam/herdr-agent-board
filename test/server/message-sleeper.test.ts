// A message to a sleeping session (#267): the first one went to wake, which brought the session
// back, and failed with "another session is in that pane now": herdr names the session in a pane
// only once its own SessionStart hook reported it, which can come seconds after Claude is up and
// idle, all a wake waits for. A message waits for that name now, to a sleeper woken in its pane or
// in a new tab (#204), and to one the card still shows asleep that woke meanwhile; the refusal
// stays where the pane holds another session, and a message to an awake session goes as before.
// Wake is a stand-in on a port of the test's own; herdr the fake one.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { useLanguage } from '../../src/core/lang.ts'
import { serveBoard } from '../support/board-server.ts'
import { type FakeWake, fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  herdrAsleep,
  herdrAwake,
  projectDir,
  SCREEN,
  SID,
  SLEPT,
  transcript,
  twoProfiles,
  wakeFile,
  wakeRuns,
} from '../support/sleeper-fixtures.ts'
import { SID2 } from '../support/wake-fixtures.ts'

setDefaultTimeout(40_000)
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const CHANGED = 'Report: another session is in that pane now, refresh the board'

/** A pane in workspace w1 as herdr's snapshot has it: a shell, or Claude idle on `session` (none: herdr does not name it yet). */
function pane(id: string, cwd: string, session?: string | null): Record<string, unknown> {
  const shell = { pane_id: id, workspace_id: 'w1', tab_id: 't1', cwd }
  if (session === undefined) return shell
  return {
    ...shell,
    agent: 'claude',
    ...(session && { agent_session: { value: session } }),
    agent_status: 'idle',
    terminal_title_stripped: 'Report',
  }
}
const snapshot = (...panes: Record<string, unknown>[]) => ({
  result: {
    snapshot: {
      workspaces: [{ workspace_id: 'w1', label: 'Отчёты 50%' }],
      tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
      panes,
    },
  },
})
/** `herdr agent get`: Claude idle, on `session` or on none herdr knows of yet. */
const agent = (session: string | null) => ({
  result: { agent: { agent: 'claude', agent_status: 'idle', ...(session && { agent_session: { value: session } }) } },
})

/**
 * herdr once Claude is back in `id`, idle: its snapshot as `named` says, and its `agent get`
 * without the session for the first `late` reads, `session` from then on.
 */
function upIn(box: Sandbox, cwd: string, id: string, o: { late: number; session?: string; named?: boolean }): void {
  const session = o.session ?? SID
  box.state({
    'api snapshot': snapshot(pane(id, cwd, o.named === false ? null : session)),
    'agent get': { seq: [...Array.from({ length: o.late }, () => agent(null)), agent(session)] },
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
  })
}

/** A Work session asleep, its transcript in its folder: in p1, or (`freed`) with its pane given back (#204). */
function workSleeper(box: Sandbox, { freed = false } = {}) {
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  if (freed) {
    const entry = { session: SID, name: 'Report', cwd, seen_at: SLEPT, slept_at: SLEPT, profileDir: work }
    const place = { pane: 'p1', workspace: 'w1', workspaceLabel: 'Отчёты 50%', tabLabel: 'Report', at: SLEPT }
    writeFileSync(wakeFile(box), JSON.stringify({ [SID]: { ...entry, profile: 'work', freed: place } }))
  }
  const asleep = {
    session: SID,
    name: 'Report',
    slept_at: new Date(SLEPT).toISOString(),
    ...(!freed && { pane: 'p1' }),
  }
  return { cwd, list, asleep }
}

/**
 * The web board, with wake on at the stand-in (none: off, the sleepers wake's file has), once it
 * shows the session as `fits`; `message` sends as the page does.
 */
async function board(box: Sandbox, wake: FakeWake | null, list: unknown[], fits: (item: Shown) => boolean) {
  if (wake) wakeRuns(box)
  const cfg = { language: 'en', wake: wake ? { enabled: true, port: wake.port } : false, wakeUrl: null, profiles: list }
  const { url, proc } = await serveBoard(box, cfg, boardOnPath(box))
  const refreshed = (): number => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
    const before = refreshed()
    proc.send('refresh')
    await until(() => refreshed() > before)
    const b = (await (await fetch(`${url}/api/board`)).json()) as { stale?: boolean; items?: Shown[] }
    if (!b.stale && b.items?.some(i => i.key === SID && fits(i))) break
    if (Date.now() > deadline) throw new Error(`the board did not show ${SID} as asked`)
  }
  const message = async (text: string) => {
    const res = await fetch(`${url}/api/session/${SID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ session: SID, text }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { message }
}

type Shown = { key: string; sleeping?: boolean; pane?: string | null }
const asleepIn =
  (pane: string | null) =>
  (i: Shown): boolean =>
    i.sleeping === true && (i.pane ?? null) === pane

const prompts = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')
const reads = (box: Sandbox): number => box.calls().filter(c => c[0] === 'agent' && c[1] === 'get').length
const wakes = (wake: FakeWake) => wake.requests().filter(q => q.method === 'POST' && q.path === '/wake')

test('a sleeper in its pane: wake brings it back, herdr names it seconds later, the message goes once', async () => {
  const box = await sandbox()
  const { cwd, list, asleep } = workSleeper(box)
  herdrAsleep(box, cwd)
  const wake = await fakeWake({
    sleeping: [asleep],
    wake: () => {
      upIn(box, cwd, 'p1', { late: 2 })
      wake.sleeping = []
      return { ok: true, pane: 'p1', name: 'Report' }
    },
  })
  const { message } = await board(box, wake, list, asleepIn('p1'))
  const r = await message('check the build')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p1', 'check the build']])
  assert.deepEqual(
    wakes(wake).map(q => q.body),
    [{ target: 'p1' }],
  )
  // Twice without the session, then with it; once more after the screen read.
  assert.equal(reads(box), 4)
})

test('a sleeper whose pane was given back (#204): it wakes in a new tab and the message goes there once', async () => {
  const box = await sandbox()
  const { cwd, list, asleep } = workSleeper(box, { freed: true })
  box.state({ 'api snapshot': snapshot() })
  const wake = await fakeWake({
    sleeping: [asleep],
    wake: () => {
      upIn(box, cwd, 'p9', { late: 1 })
      wake.sleeping = []
      return { ok: true, pane: 'p9', name: 'Report' }
    },
  })
  const { message } = await board(box, wake, list, asleepIn(null))
  const r = await message('check the build')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p9', 'check the build']])
  assert.deepEqual(
    wakes(wake).map(q => q.body),
    [{ target: SID }],
  )
})

test('shown asleep, woken meanwhile in a new tab: the message goes where it is now, nothing woken again', async () => {
  const box = await sandbox()
  const { cwd, list, asleep } = workSleeper(box, { freed: true })
  box.state({ 'api snapshot': snapshot() })
  const wake = await fakeWake({ sleeping: [asleep] })
  const { message } = await board(box, wake, list, asleepIn(null))
  upIn(box, cwd, 'p9', { late: 0 })
  wake.sleeping = []
  const r = await message('check the build')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p9', 'check the build']])
  assert.deepEqual(wakes(wake), [])
})

test('shown asleep, woken meanwhile in its pane that herdr does not name it in yet: the message goes once', async () => {
  const box = await sandbox()
  const { cwd, list } = workSleeper(box)
  herdrAsleep(box, cwd)
  // Wake off: the sleeper is wake's file's, shown only while its pane is a shell.
  const { message } = await board(box, null, list, asleepIn('p1'))
  // Claude runs in p1 again; herdr names its session there 2 s after the message was sent.
  upIn(box, cwd, 'p1', { late: 1, named: false })
  const sent = message('check the build')
  await Bun.sleep(2000)
  upIn(box, cwd, 'p1', { late: 0 })
  const r = await sent
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(prompts(box), [['agent', 'prompt', 'p1', 'check the build']])
  assert.deepEqual(
    box.calls().filter(c => c[0] === 'pane' && c[1] === 'run'),
    [],
  )
})

test('woken into a pane that holds another session: refused at once, as before, nothing typed', async () => {
  const box = await sandbox()
  const { cwd, list, asleep } = workSleeper(box)
  herdrAsleep(box, cwd)
  const wake = await fakeWake({
    sleeping: [asleep],
    wake: () => {
      upIn(box, cwd, 'p1', { late: 0, session: SID2 })
      wake.sleeping = []
      return { ok: true, pane: 'p1', name: 'Report' }
    },
  })
  const { message } = await board(box, wake, list, asleepIn('p1'))
  const r = await message('check the build')
  assert.equal(r.status, 409)
  assert.equal(r.body.error, CHANGED)
  assert.deepEqual(prompts(box), [])
  assert.equal(reads(box), 1)
})

test('an awake session: the same herdr calls as before, and no wait for a session herdr does not name', async () => {
  const box = await sandbox()
  const { cwd, list } = workSleeper(box)
  herdrAwake(box, cwd)
  const wake = await fakeWake()
  const { message } = await board(box, wake, list, i => !i.sleeping)
  const r = await message('check the build')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(
    box.calls().filter(c => c[0] === 'agent'),
    [
      ['agent', 'get', 'p1'],
      ['agent', 'read', 'p1', '--source', 'visible', '--ansi'],
      ['agent', 'get', 'p1'],
      ['agent', 'prompt', 'p1', 'check the build'],
    ],
  )
  // herdr no longer names the session in its pane: refused at once, one read.
  upIn(box, cwd, 'p1', { late: 5 })
  const before = reads(box)
  const again = await message('and the docs')
  assert.equal(again.status, 409)
  assert.equal(again.body.error, CHANGED)
  assert.equal(reads(box) - before, 1)
  assert.deepEqual(wakes(wake), [])
})
