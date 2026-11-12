// Threads' events end to end (#379, services/work-threads.ts, services/scheduler.ts): writes made
// by the `board` command (in a child process as an agent runs it, or in this process with the
// sandbox's folders), the scheduler in a child process against the fake herdr, the line a session
// gets read from herdr's `agent prompt` calls. The design's worked example (3.7), a sleeping watcher
// that is not woken, ten changes in a busy turn as one line, and an ordinary reminder that still
// wakes its session.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import { listEntries } from '../../src/adapters/schedule-store.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  herdrAsleep,
  paneCalls,
  projectDir,
  SID,
  transcript,
  twoProfiles,
} from '../support/sleeper-fixtures.ts'

setDefaultTimeout(60_000)

const MASTER = '0a0a0a0a-0000-4000-8000-00000000000a'
const MAPPER = '0b0b0b0b-0000-4000-8000-00000000000b'
const RULE = '─'.repeat(40)
const SCREEN = ['● done', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const ATLAS = [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }]

function config(box: Sandbox, extra: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, categories: ATLAS, ...extra }))
}

/** The master in p1 and the worker atlas-mapper in p2, each with its card in lane atlas; the master `status`. */
function twoSessions(box: Sandbox, status = 'idle'): void {
  const panes = [
    { pane_id: 'p1', session: MASTER, name: 'master', status },
    { pane_id: 'p2', session: MAPPER, name: 'atlas-mapper', status: 'idle' },
  ]
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: panes.map(p => ({
            pane_id: p.pane_id,
            agent: 'claude',
            agent_session: { value: p.session },
            agent_status: p.status,
            terminal_title_stripped: p.name,
            cwd: box.dir,
          })),
          tabs: [],
          workspaces: [],
        },
      },
    },
    ...Object.fromEntries(
      panes.map(p => [
        `agent get ${p.pane_id}`,
        { result: { agent: { agent: 'claude', agent_status: p.status, agent_session: { value: p.session } } } },
      ]),
    ),
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
  })
  mkdirSync(box.cards, { recursive: true })
  for (const p of panes)
    writeFileSync(
      join(box.cards, `${p.session}.json`),
      JSON.stringify({ key: p.session, name: p.name, category: 'atlas' }),
    )
}

/** `board …` as the session `key` in `pane` runs it. */
async function board(box: Sandbox, key: string, pane: string | null, args: string[]) {
  const env: Record<string, string> = { CLAUDE_CODE_SESSION_ID: key, ...(pane && { HERDR_PANE_ID: pane }) }
  const r = await box.run('cli', { args, env }).exited
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() }
}

/** `board thread …` in this process, with the sandbox's folders: as fast as a write gets. */
async function inProcess(box: Sandbox, actor: Party, args: string[], threads: unknown) {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    const out: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads },
      actor,
      lane: 'atlas',
      findSession: async () => null,
      out: l => out.push(l),
      err: l => out.push(l),
    })
    assert.equal(code, 0, out.join('\n'))
    return out.join('\n')
  } finally {
    process.env.APPDATA = saved.APPDATA
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA
  }
}

/** The schedule's entries, read from the sandbox's state folder. */
function entries(box: Sandbox) {
  const saved = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return listEntries()
  } finally {
    process.env.LOCALAPPDATA = saved
  }
}

const prompts = (box: Sandbox, pane?: string): string[] =>
  box
    .calls()
    .filter(c => c[0] === 'agent' && c[1] === 'prompt' && (!pane || c[2] === pane))
    .map(c => c[3] as string)

async function scheduler(box: Sandbox, cfg: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const proc = box.run('scheduler', { categories: ATLAS, wakeUrl: null, scheduleTickSec: 0.2, ...cfg }, env)
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

test('the worked example (3.7) end to end: the master gets one line, typed in by the board, once', async () => {
  const box = await sandbox()
  config(box, { threads: true })
  twoSessions(box)
  // Eleven atlas threads before, as in the example.
  const db = openDb({ path: join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/board.db') })
  db?.db.query("INSERT INTO thread_seq (lane, n) VALUES ('atlas', 11)").run()
  db?.close()

  assert.deepEqual(
    await board(box, MASTER, 'p1', ['thread', 'new', '--lane', 'atlas', 'Import mapping for the order feed']),
    {
      code: 0,
      out: 'ok · atlas-12 · next',
    },
  )
  assert.deepEqual(
    await board(box, MASTER, 'p1', [
      'thread',
      'new',
      '--parent',
      'atlas-12',
      '--to',
      'atlas-mapper',
      'Map the 2019 price columns',
    ]),
    { code: 0, out: 'ok · atlas-13 · doing · atlas-mapper' },
  )
  // in the session atlas-mapper, an hour later
  mkdirSync(join(box.dir, 'out'))
  writeFileSync(join(box.dir, 'out', 'mapping-report.md'), `# Mapping report\n${'| 2019 | ok |\n'.repeat(600)}`)
  const posted = await board(box, MAPPER, 'p2', [
    'thread',
    'post',
    'atlas-13',
    '--status',
    'done',
    '--summary',
    '217 rows mapped, 3 flagged in the report',
    '--file',
    join(box.dir, 'out', 'mapping-report.md'),
  ])
  assert.deepEqual(posted, { code: 0, out: 'ok · atlas-13 · done · 1 file' })

  // typed into the master by the board, once, when it is next free
  await scheduler(box)
  await until(() => prompts(box).length === 1, 20_000)
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.deepEqual(prompts(box), [
    '[board reminder from threads] atlas-13 done: 217 rows mapped, 3 flagged in the report. More: board thread changes',
  ])
  assert.deepEqual(prompts(box, 'p2'), [], 'the worker hears nothing of its own change')
  assert.deepEqual(entries(box), [])
})

test('a sleeping watcher is not woken and gets one line when it is next awake; an ordinary reminder still wakes it', async () => {
  const box = await sandbox()
  const { work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  asleepInFile(box, { cwd, profileDir: work, profile: 'work' })
  herdrAsleep(box, cwd)
  config(box, { threads: true, profiles: list })
  const threads = true
  const watcher: Party = { kind: 'session', key: SID, name: 'Report' }
  const worker: Party = { kind: 'session', key: 'worker-1', name: 'worker' }
  // The watcher made the thread before it went to sleep; two workers write while it sleeps.
  await inProcess(box, watcher, ['new', 'Weekly numbers'], threads)
  await inProcess(box, worker, ['post', 'atlas-1', '--status', 'doing', '--summary', 'pulling the numbers'], threads)
  await inProcess(box, worker, ['done', 'atlas-1', 'numbers are in the sheet'], threads)
  const [event] = entries(box)
  assert.equal(event?.noWake, true)

  await scheduler(box, { wake: false, profiles: list }, boardOnPath(box))
  await until(() => entries(box)[0]?.why === 'asleep', 20_000)
  // A few ticks later it still waits: not woken, nothing typed, not counted against the wait.
  await new Promise(resolve => setTimeout(resolve, 1500))
  const held = entries(box)
  assert.equal(held.length, 1)
  assert.equal(held[0]?.waited, undefined)
  assert.deepEqual(prompts(box), [])
  assert.deepEqual(
    paneCalls(box).filter(c => c[1] === 'run'),
    [],
  )

  // An ordinary reminder for the same session wakes it as before; the event follows, one line.
  mkdirSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule'), { recursive: true })
  const past = Date.now() - 1000
  writeFileSync(
    join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule/eeee09.json'),
    JSON.stringify({
      id: 'eeee09',
      key: SID,
      name: 'Report',
      pane: 'p1',
      text: 'check the build',
      at: past,
      next: past,
      created: past,
    }),
  )
  await until(() => prompts(box).length === 2, 30_000)
  assert.deepEqual(
    paneCalls(box).filter(c => c[1] === 'run'),
    [['pane', 'run', 'p1', `board resume ${SID} --profile work`]],
  )
  assert.deepEqual(prompts(box).sort(), [
    '[board reminder from threads] atlas-1 done: numbers are in the sheet. More: board thread changes',
    '[board reminder] check the build',
  ])
})

test('ten changes during a busy turn arrive as one line: the first change goes at once, the rest wait out the gap together', async () => {
  const box = await sandbox()
  // A gap long enough for ten writes on a loaded machine.
  const threads = { events: { gapSec: 8 } }
  config(box, { threads })
  twoSessions(box, 'working')
  const master: Party = { kind: 'session', key: MASTER, name: 'master' }
  const mapper: Party = { kind: 'session', key: MAPPER, name: 'atlas-mapper' }
  for (let i = 1; i <= 10; i++) await inProcess(box, master, ['new', `Part ${i}`], threads)
  await scheduler(box)
  await inProcess(box, mapper, ['post', 'atlas-1', '--status', 'doing'], threads)
  await until(() => prompts(box).length === 1, 20_000)
  assert.equal(prompts(box)[0], '[board reminder from threads] atlas-1 doing. More: board thread changes')
  // The master is still in its turn; ten workers finish within the gap.
  for (let i = 1; i <= 10; i++) await inProcess(box, mapper, ['done', `atlas-${i}`, `part ${i} mapped`], threads)
  assert.equal(entries(box).length, 1, 'one pending event, whatever the number of changes')
  await until(() => prompts(box).length === 2, 20_000)
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.deepEqual(prompts(box).slice(1), [
    '[board reminder from threads] atlas-1 done: part 1 mapped · atlas-2 done: part 2 mapped · atlas-3 done: part 3 mapped · and 7 more. More: board thread changes',
  ])
})

test('with --idle, ten changes during a busy turn wait for its end and arrive as one line', async () => {
  const box = await sandbox()
  const threads = true
  config(box, { threads })
  twoSessions(box, 'working')
  const master: Party = { kind: 'session', key: MASTER, name: 'master' }
  const mapper: Party = { kind: 'session', key: MAPPER, name: 'atlas-mapper' }
  for (let i = 1; i <= 10; i++) await inProcess(box, master, ['new', `Part ${i}`], threads)
  // The creator's own watches stay as they are; a watch that asks to wait for a free session has its way.
  await inProcess(box, master, ['watch', '--lane', 'atlas', '--idle'], threads)
  await scheduler(box)
  for (let i = 1; i <= 10; i++) await inProcess(box, mapper, ['done', `atlas-${i}`, `part ${i} mapped`], threads)
  await until(() => entries(box)[0]?.why === 'busy', 20_000)
  assert.deepEqual(prompts(box), [])
  twoSessions(box, 'idle')
  await until(() => prompts(box).length === 1, 20_000)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.deepEqual(prompts(box), [
    '[board reminder from threads] atlas-1 done: part 1 mapped · atlas-2 done: part 2 mapped · atlas-3 done: part 3 mapped · and 7 more. More: board thread changes',
  ])
})
