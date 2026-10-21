// Reminders for sleeping sessions while wake is slow, down or off (#119, safeguard 14, call 28;
// preflight M7, M16). A run for a sleeper waits, without counting the wait and without counting the
// session as gone, while wake is slow to answer or the board's own wake cannot reach herdr; it goes
// as usual once wake answers. With wake off the board wakes the session itself and the reminder is
// sent. A restart in the new wake needs no wakeUrl; the old path gives one up as today, saying wake
// is off only where config.json turns it off (H1). The scheduler runs in a child process against
// the fake herdr; wake is a stand-in on a port of the test's own, or nothing at all.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  card,
  herdrAsleep,
  herdrAwake,
  paneCalls,
  projectDir,
  SID,
  scheduleDir,
  transcript,
  twoProfiles,
  wakeRuns,
} from '../support/sleeper-fixtures.ts'
import { runningSession } from '../support/wake-fixtures.ts'

setDefaultTimeout(45_000)

type Stored = Record<string, unknown> & { next: number }

function put(box: Sandbox, entry: Record<string, unknown>): void {
  mkdirSync(scheduleDir(box), { recursive: true })
  const past = Date.now() - 1000
  writeFileSync(
    join(scheduleDir(box), `${entry.id}.json`),
    JSON.stringify({ key: SID, name: 'Report', pane: 'p1', at: past, next: past, created: past, ...entry }),
  )
}
const read = (box: Sandbox, id: string): Stored | null => {
  const file = join(scheduleDir(box), `${id}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
const runs = (box: Sandbox): Record<string, unknown>[] => {
  const file = join(scheduleDir(box), 'log.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
}
const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(c => c[0] === 'agent' && c[1] === 'prompt')
    .map(c => c[3] as string)

async function scheduler(box: Sandbox, cfg: Record<string, unknown>, env: Record<string, string> = {}) {
  const proc = box.run(
    'scheduler',
    {
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      scheduleTickSec: 0.2,
      restartSettleSec: 0,
      ...cfg,
    },
    env,
  )
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

/** A Work session asleep in p1 as wake's file has it, its transcript in its folder; the config's profiles. */
function workSleeper(box: Sandbox) {
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  return { cwd, list }
}

test('a reminder for a sleeper waits while wake is slow, and is not counted missed past scheduleWaitMin', async () => {
  const box = await sandbox()
  const { cwd, list } = workSleeper(box)
  herdrAsleep(box, cwd)
  // Once it answers again, it lists the session asleep, and its wake brings it back.
  const wake = await fakeWake({
    sleeping: [{ session: SID, pane: 'p1', name: 'Report', slept_at: new Date().toISOString() }],
    wake: () => {
      herdrAwake(box, cwd)
      wake.sleeping = []
      return { ok: true }
    },
  })
  wake.slow = true
  wakeRuns(box)
  put(box, { id: 'eeee01', text: 'check the build' })
  await scheduler(
    box,
    { wake: { enabled: true, port: wake.port }, profiles: list, scheduleWaitMin: 0.001 },
    boardOnPath(box),
  )
  const asked = (): number => wake.requests().filter(q => q.method === 'GET' && q.path === '/alive').length
  await until(() => asked() >= 3 && read(box, 'eeee01')?.why === 'wake', 30_000)
  const held = read(box, 'eeee01')
  assert.ok(held, 'the reminder is still there')
  assert.equal(held.waited, undefined)
  assert.ok(held.pendingSince)
  assert.deepEqual(runs(box), [])
  assert.deepEqual(prompts(box), [])
  assert.deepEqual(paneCalls(box), [])

  wake.slow = false
  await until(() => prompts(box).length === 1, 20_000)
  assert.deepEqual(prompts(box), ['[board reminder] check the build'])
  assert.deepEqual(
    wake.requests().filter(q => q.method === 'POST'),
    [{ method: 'POST', path: '/wake', body: { target: 'p1' } }],
  )
  await until(() => runs(box).length === 1)
  assert.equal(runs(box)[0]?.result, 'sent')
  assert.equal(read(box, 'eeee01'), null)
})

test('a restart in its wake step waits while wake is slow, its tries not counted', async () => {
  const box = await sandbox()
  const { cwd, list } = workSleeper(box)
  herdrAsleep(box, cwd)
  const wake = await fakeWake()
  wake.slow = true
  wakeRuns(box)
  put(box, { id: 'eeee06', kind: 'restart', idle: true, by: 'agent', text: 'my note', step: 'wake' })
  await scheduler(box, { wake: { enabled: true, port: wake.port }, profiles: list }, boardOnPath(box))
  const asked = (): number => wake.requests().filter(q => q.method === 'GET' && q.path === '/alive').length
  // More than RESTART_TRIES (3) times: a counted retry would have given up by now.
  await until(() => asked() >= 4 && read(box, 'eeee06')?.why === 'wake', 30_000)
  const held = read(box, 'eeee06')
  assert.ok(held, 'the restart is still there')
  assert.deepEqual([held.step, held.attempts, held.failed], ['wake', undefined, undefined])
  assert.deepEqual(runs(box), [])
  assert.deepEqual(paneCalls(box), [])
})

test('a cron reminder for a sleeper is kept past three runs while wake is down and herdr cannot be reached', async () => {
  const box = await sandbox()
  const { cwd, list } = workSleeper(box)
  // Nothing listens on wake's port, and herdr fails the board's own wake.
  herdrAsleep(box, cwd, { extra: { 'pane process-info': { error: 'herdr is not answering', code: 'internal' } } })
  wakeRuns(box)
  put(box, { id: 'eeee02', text: 'daily check', cron: '0 9 * * *', gone: 2, missed: 2 })
  await scheduler(
    box,
    { wake: { enabled: true, port: await unusedPort() }, profiles: list, scheduleWaitMin: 0.001 },
    boardOnPath(box),
  )
  const tries = (): number => box.calls().filter(c => c[0] === 'pane' && c[1] === 'process-info').length
  await until(() => tries() >= 4 && read(box, 'eeee02')?.why === 'wake', 30_000)
  const kept = read(box, 'eeee02')
  assert.ok(kept, 'the cron reminder is kept')
  assert.deepEqual([kept.gone, kept.missed, kept.waited], [2, 2, undefined])
  assert.deepEqual(runs(box), [])
  assert.deepEqual(prompts(box), [])
})

test('wake off: the reminder wakes the session through the board and is sent', async () => {
  const box = await sandbox()
  const { cwd, list } = workSleeper(box)
  herdrAsleep(box, cwd)
  put(box, { id: 'eeee03', text: 'check the build' })
  await scheduler(box, { wake: false, profiles: list }, boardOnPath(box))
  await until(() => prompts(box).length === 1, 20_000)
  assert.deepEqual(prompts(box), ['[board reminder] check the build'])
  assert.deepEqual(
    paneCalls(box).filter(c => c[1] === 'run'),
    [['pane', 'run', 'p1', `board resume ${SID} --profile work`]],
  )
  await until(() => runs(box).length === 1)
  assert.equal(runs(box)[0]?.result, 'sent')
})

test('a restart with wakeUrl null and wake on (the new wake) is not given up: put to sleep, woken, its note', async () => {
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  runningSession(work, { id: SID, name: 'Report', cwd })
  card(box, work)
  herdrAwake(box, cwd)
  const wake = await fakeWake({
    sleep: () => {
      herdrAsleep(box, cwd)
      return { ok: true }
    },
    wake: () => {
      herdrAwake(box, cwd)
      return { ok: true }
    },
  })
  wakeRuns(box)
  put(box, { id: 'eeee04', kind: 'restart', idle: true, by: 'agent', text: 'back to the report' })
  await scheduler(box, { wake: { enabled: true, port: wake.port }, wakeUrl: null, profiles: list }, boardOnPath(box))
  await until(() => prompts(box).length === 1, 20_000)
  assert.deepEqual(prompts(box), ['[board reminder; restarted as you asked] back to the report'])
  assert.deepEqual(
    wake
      .requests()
      .filter(q => q.method === 'POST')
      .map(q => q.path),
    ['/sleep', '/wake'],
  )
  await until(() => runs(box).length === 1)
  assert.deepEqual([runs(box)[0]?.result, runs(box)[0]?.kind], ['sent', 'restart'])
})

for (const [name, wake, why] of [
  ['no wake key', undefined, 'A restart needs herdr-wake, and wakeUrl in the board’s config.json is empty'],
  ['"wake": false', false, 'Sleep and wake is off (Settings → Sleep and wake…)'],
] as const)
  test.skipIf(wake === undefined && WAKE_SHIPPED)(
    `the old path with wakeUrl null (${name}) gives a restart up as today, and says why`,
    async () => {
      const box = await sandbox()
      const cwd = projectDir(box)
      runningSession(join(box.env.HOME as string, '.claude'), { id: SID, name: 'Report', cwd })
      herdrAwake(box, cwd)
      put(box, { id: 'eeee05', kind: 'restart', idle: true, by: 'agent', text: 'my note' })
      await scheduler(box, { wakeUrl: null, ...(wake === undefined ? {} : { wake }) })
      await until(() => prompts(box).length === 1, 20_000)
      assert.deepEqual(prompts(box), [
        `[board reminder] restart did not happen: ${why}. Your note for after it: my note`,
      ])
      assert.deepEqual(paneCalls(box), [])
    },
  )
