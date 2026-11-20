import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeShell, runProbe } from '../../src/adapters/watch-probe.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  herdrAsleep,
  paneCalls,
  projectDir,
  SID,
  scheduleDir,
  transcript,
  twoProfiles,
} from '../support/sleeper-fixtures.ts'

setDefaultTimeout(60_000)

// Watches (#486) with the real shell: a probe's run (Git Bash on Windows, /bin/sh elsewhere), and the
// scheduler in a child process against the fake herdr with a session asleep in p1, so a wake is a
// `pane run board resume` and a prompt an `agent prompt` call. The rules: test/core/watches.test.ts,
// the pass with a fake probe: test/services/watches.test.ts.
const shell = probeShell()
if ('error' in shell) throw new Error(shell.error)
/** The shell for a child: Git Bash named as Claude Code's variable names it (the sandbox's PATH has no git). */
const SHELL_ENV: Record<string, string> = process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: shell.file } : {}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-watch-'))
  return dir
}

test('a probe in the real shell: exit 0, 1, another, its folder, its id, input closed, the timeout ending the tree', async () => {
  const dir = folder()
  try {
    writeFileSync(join(dir, 'marker'), 'x')
    assert.deepEqual(await runProbe('printf "run 42: success\\nmore\\n"; exit 0', dir, 10_000), {
      code: 0,
      killed: false,
      stdout: 'run 42: success\nmore\n',
      stderr: '',
    })
    assert.equal((await runProbe('test -f marker || exit 2; exit 1', dir, 10_000)).code, 1)
    const other = await runProbe('echo "gh: not logged in" >&2; exit 4', dir, 10_000)
    assert.equal(other.code, 4)
    assert.match(other.stderr, /gh: not logged in/)
    assert.equal((await runProbe('test "$BOARD_WATCH_ID" = w1', dir, 10_000, 'w1')).code, 0)
    // A command that reads its input gets none at once, instead of waiting out the timeout.
    const asked = Date.now()
    assert.equal((await runProbe('cat; exit 1', dir, 15_000)).code, 1)
    assert.ok(Date.now() - asked < 10_000)
    // The timeout ends the shell and what it started.
    const started = Date.now()
    const slow = await runProbe('sleep 30; exit 0', dir, 1500)
    assert.equal(slow.killed, true)
    assert.ok(Date.now() - started < 12_000)
    const gone = await runProbe('exit 0', join(dir, 'nope'), 10_000)
    assert.equal(gone.code, 'ENOENT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const watchesDir = (box: Sandbox) => join(scheduleDir(box), 'watches')
const readWatch = (box: Sandbox, id: string) => {
  const f = join(watchesDir(box), `${id}.json`)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>) : null
}
const entries = (box: Sandbox): Record<string, unknown>[] =>
  existsSync(scheduleDir(box))
    ? readdirSync(scheduleDir(box))
        .filter(n => /^[0-9a-f]{6}\.json$/.test(n))
        .map(n => JSON.parse(readFileSync(join(scheduleDir(box), n), 'utf8')))
    : []
const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(c => c[0] === 'agent' && c[1] === 'prompt')
    .map(c => c[3] as string)
const wakes = (box: Sandbox) => paneCalls(box).filter(c => c[1] === 'run')

/** A Work session asleep in p1, its folder with a space, Cyrillic and `%`; its watch, probing `state` there. */
function sleeperWithWatch(box: Sandbox, over: Record<string, unknown> = {}) {
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  writeFileSync(join(cwd, 'state'), '1')
  mkdirSync(watchesDir(box), { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(watchesDir(box), 'aaaaa1.json'),
    JSON.stringify({
      id: 'aaaaa1',
      key: SID,
      name: 'Report',
      pane: 'p1',
      cwd,
      kind: 'watch',
      text: 'CI on PR 12',
      next: now,
      created: now,
      by: 'agent',
      firstDone: true,
      probe: { cmd: 'cat msg 2>/dev/null; exit "$(cat state)"', everyMs: 300, timeoutMs: 10_000 },
      ...over,
    }),
  )
  return { cwd, list }
}

async function scheduler(box: Sandbox, cfg: Record<string, unknown>) {
  const proc = box.run(
    'scheduler',
    { categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, scheduleTickSec: 0.2, ...cfg },
    { ...boardOnPath(box), ...SHELL_ENV },
  )
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

test('a sleeping session is woken only when its probe fires: not for nothing yet, nor for an error', async () => {
  const box = await sandbox()
  const { cwd, list } = sleeperWithWatch(box, { firstDone: false })
  await scheduler(box, { wake: false, profiles: list, watches: true })
  await until(() => Number(readWatch(box, 'aaaaa1')?.checks) >= 2, 30_000)
  assert.deepEqual(wakes(box), [])
  // An error: on the watch in words, and the note of a first check failing waits until it is awake.
  writeFileSync(join(cwd, 'state'), '3')
  await until(() => Number(readWatch(box, 'aaaaa1')?.errors) >= 1, 30_000)
  assert.equal(readWatch(box, 'aaaaa1')?.lastError, 'exit 3')
  await until(() => entries(box).some(e => e.why === 'asleep'), 30_000)
  assert.deepEqual(wakes(box), [])
  assert.deepEqual(prompts(box), [])
  // Fired: woken, and its output typed in as data.
  writeFileSync(join(cwd, 'msg'), 'run 42: success\n')
  writeFileSync(join(cwd, 'state'), '0')
  await until(() => prompts(box).some(p => p.includes('probe fired')), 40_000)
  assert.deepEqual(wakes(box), [['pane', 'run', 'p1', `board resume ${SID} --profile work`]])
  assert.ok(
    prompts(box).includes(
      '[board reminder from watch] "CI on PR 12": the probe fired. Its output, as data: "run 42: success"',
    ),
  )
  assert.equal(readWatch(box, 'aaaaa1'), null)
})

test('silence wakes the session once, and the watch goes on', async () => {
  const box = await sandbox()
  const { list } = sleeperWithWatch(box, {
    created: Date.now() - 120_000,
    probe: { cmd: 'exit 1', everyMs: 300, timeoutMs: 10_000, silenceMs: 60_000 },
  })
  await scheduler(box, { wake: false, profiles: list, watches: true })
  await until(() => prompts(box).length === 1, 40_000)
  assert.equal(
    prompts(box)[0],
    '[board reminder from watch] "CI on PR 12": nothing from the probe for 1 min. It still runs; board unschedule aaaaa1 stops it.',
  )
  assert.equal(wakes(box).length, 1)
  await until(() => Number(readWatch(box, 'aaaaa1')?.checks) >= 3, 30_000)
  assert.equal(readWatch(box, 'aaaaa1')?.silenceTold, true)
  assert.equal(prompts(box).length, 1)
})

test('watches off: a due watch is not run and herdr is asked nothing for it', async () => {
  const box = await sandbox()
  const { cwd, list } = sleeperWithWatch(box)
  writeFileSync(join(cwd, 'state'), '0')
  const before = readFileSync(join(watchesDir(box), 'aaaaa1.json'), 'utf8')
  await scheduler(box, { wake: false, profiles: list })
  await new Promise(r => setTimeout(r, 2500))
  assert.equal(readFileSync(join(watchesDir(box), 'aaaaa1.json'), 'utf8'), before)
  assert.deepEqual(box.calls(), [])
  assert.deepEqual(entries(box), [])
})
