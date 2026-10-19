import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type ChildResult, root, type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

// Retry-safe call reports (`board call-report --report-id`, adapters/call-receipts.ts): the board
// command, the scheduler and a stand-in for an interrupted process each run in a child process,
// herdr answered by the fake; the journal and the queue are files in the sandbox.
const SID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

type Receipt = { reportId: string; session: string; entryId: string; state: string; reused: boolean }
type Entry = Record<string, unknown> & { id: string; text: string; why?: string }

const state = (b: Sandbox): string => join(b.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
const journal = (b: Sandbox): string => join(state(b), 'call-receipts.json')
const records = (b: Sandbox): Record<string, Record<string, unknown>> =>
  JSON.parse(readFileSync(journal(b), 'utf8')).records
const firstRecord = (b: Sandbox): Record<string, unknown> | undefined => Object.values(records(b))[0]
const entries = (b: Sandbox): Entry[] =>
  existsSync(join(state(b), 'schedule'))
    ? readdirSync(join(state(b), 'schedule'))
        .filter(n => /^[a-f0-9]{6}\.json$/.test(n))
        .map(n => JSON.parse(readFileSync(join(state(b), 'schedule', n), 'utf8')))
    : []

/** The board's config (port 9 answers nothing; no herdr-wake) and a report in the sandbox. */
async function setup(): Promise<Sandbox> {
  const b = await sandbox()
  const cfg = join(b.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ language: 'en', port: 9, wakeUrl: null }))
  writeFileSync(join(b.dir, 'report.md'), 'Private call summary')
  b.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  return b
}
const cli = (b: Sandbox, args: string[]): Promise<ChildResult> => b.run('cli', { args, env: {} }).exited
const submit = (b: Sandbox, id = 'call-1', session = SID): Promise<ChildResult> =>
  cli(b, ['call-report', '--session', session, '--report-id', id, '--file', join(b.dir, 'report.md')])
const result = (out: ChildResult): Receipt => {
  assert.equal(out.code, 0, out.stderr)
  return JSON.parse(out.stdout)
}

/** Code run with the board's modules in a process of its own (`bun -e`), the sandbox's env. */
function moduleRun(b: Sandbox, code: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: root, env: b.env })
    let out = ''
    let err = ''
    child.stdout.on('data', c => {
      out += c
    })
    child.stderr.on('data', c => {
      err += c
    })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout: out, stderr: err }))
  })
}

/** herdr with Claude session `session` idle in pane p1 (`draft`: the user's unsent text), and the scheduler. */
async function scheduler(b: Sandbox, session = SID, prompt: unknown = { result: {} }, draft = '') {
  const rule = '─'.repeat(40)
  b.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            { pane_id: 'p1', agent: 'claude', agent_session: { value: session }, agent_status: 'idle', cwd: b.dir },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: session } } } },
    'agent read': { text: ['● done', rule, `❯ ${draft}`, rule, '  ⏵⏵ bypass permissions on'].join('\n') },
    'agent prompt': prompt,
  })
  const proc = b.run('scheduler', {
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    scheduleTickSec: 0.2,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}
const prompts = (b: Sandbox): string[][] => b.calls().filter(a => a[1] === 'prompt')

test('concurrent call exports deduplicate across processes and canonicalize UUID casing', async () => {
  const b = await setup()
  const outputs = await Promise.all(
    Array.from({ length: 6 }, (_, i) => submit(b, 'call-1', i % 2 ? SID.toUpperCase() : SID)),
  )
  const receipts = outputs.map(result)
  assert.equal(new Set(receipts.map(r => r.entryId)).size, 1)
  assert.equal(receipts.filter(r => !r.reused).length, 1)
  assert.equal(entries(b).length, 1)
  assert.equal(Object.keys(records(b)).length, 1)
  assert.equal(result(await submit(b)).reused, true)
  assert.equal(result(await submit(b, 'call-2')).state, 'queued')
  assert.equal(entries(b).length, 2)
  if (process.platform !== 'win32') {
    assert.equal(statSync(journal(b)).mode & 0o777, 0o600)
    for (const e of entries(b)) assert.equal(statSync(join(state(b), 'schedule', `${e.id}.json`)).mode & 0o777, 0o600)
  }
  assert.ok(!readFileSync(journal(b), 'utf8').includes('Private call summary'))
})

test('conflicting content never alters original receipt or queue; full normalized input is hashed', async () => {
  const b = await setup()
  result(await submit(b))
  const before = readFileSync(journal(b), 'utf8')
  writeFileSync(join(b.dir, 'report.md'), 'Different summary')
  const conflict = await submit(b)
  assert.notEqual(conflict.code, 0)
  assert.match(conflict.stderr, /conflict/)
  assert.equal(readFileSync(journal(b), 'utf8'), before)
  assert.equal(entries(b)[0]?.text, 'Private call summary')
  writeFileSync(join(b.dir, 'report.md'), '﻿Private call summary\r\n')
  assert.equal(result(await submit(b)).reused, true)
})

test('invalid IDs, oversized input and corrupt receipt storage fail closed before queue mutation', async () => {
  const b = await setup()
  for (const id of ['../escape', '/tmp/report', 'a'.repeat(129)]) assert.notEqual((await submit(b, id)).code, 0)
  writeFileSync(join(b.dir, 'report.md'), 'x'.repeat(1024 * 1024 + 1))
  assert.match((await submit(b)).stderr, /exceeds/)
  assert.equal(entries(b).length, 0)
  writeFileSync(join(b.dir, 'report.md'), 'Private call summary')
  result(await submit(b))
  writeFileSync(journal(b), '{truncated')
  assert.match((await submit(b)).stderr, /corrupt/)
  assert.equal(entries(b).length, 1)
})

test('queue-before-journal crash recovers as unknown and never dispatches on restart', async () => {
  const b = await setup()
  result(await submit(b))
  unlinkSync(journal(b)) // persisted queue survived a missing receipt commit
  const retry = await submit(b)
  assert.equal(retry.code, 2)
  assert.equal(JSON.parse(retry.stdout).state, 'delivery-unknown')
  const p = await scheduler(b)
  await until(() => entries(b).length === 0)
  assert.equal(prompts(b).length, 0)
  p.kill()
  await p.exited
  assert.equal((await submit(b)).code, 2)
})

test('crash after dispatch marker yields unknown without another transport attempt', async () => {
  const b = await setup()
  result(await submit(b))
  const mark = await moduleRun(
    b,
    "import { listEntries } from './src/adapters/schedule-store.ts'; import { beginReport } from './src/adapters/call-receipts.ts'; console.log(beginReport(listEntries()[0]))",
  )
  assert.equal(mark.code, 0, mark.stderr)
  assert.match(mark.stdout, /dispatching/)
  const p = await scheduler(b)
  await until(() => entries(b).length === 0)
  assert.equal(prompts(b).length, 0)
  p.kill()
  await p.exited
  assert.equal(firstRecord(b)?.state, 'delivery-unknown')
})

test('sent receipt survives restart and retries without claiming agent consumption', async () => {
  const b = await setup()
  const first = result(await submit(b))
  const p = await scheduler(b)
  await until(() => firstRecord(b)?.state === 'sent', 10_000)
  // The entry goes after the receipt says sent (its removal takes the receipt lock once more): a
  // kill before that would leave the lock behind, which no receipt writer takes over.
  await until(() => entries(b).length === 0)
  p.kill()
  await p.exited
  const retry = result(await submit(b))
  assert.equal(retry.state, 'sent')
  assert.equal(retry.entryId, first.entryId)
  assert.equal(entries(b).length, 0)
  assert.equal(prompts(b).length, 1)
  const status = result(await cli(b, ['call-report', '--session', SID, '--report-id', 'call-1', '--status']))
  assert.equal(status.state, 'sent')
  assert.equal((status as Record<string, unknown>).consumed, undefined)
})

test('cancelled receipt is immutable and opt-in retry cannot requeue it', async () => {
  const b = await setup()
  const first = result(await submit(b))
  assert.equal((await cli(b, ['unschedule', first.entryId])).code, 0)
  assert.equal(result(await submit(b)).state, 'cancelled')
  assert.equal(entries(b).length, 0)
})

test('receipt capacity refuses new IDs without forgetting existing retries', async () => {
  const b = await setup()
  const first = result(await submit(b))
  const filled = await moduleRun(
    b,
    `import { readFileSync, writeFileSync } from 'node:fs'; import { receiptsFile, reportIdentity, reportHash, MAX_RECEIPTS } from './src/adapters/call-receipts.ts'; const j = JSON.parse(readFileSync(receiptsFile(), 'utf8')); for (let i = 1; i < MAX_RECEIPTS; i++) { const r = reportIdentity('${SID}', 'old-' + i, reportHash('text')); j.records[r.key] = { ...r, entryId: 'abcdef', state: 'sent', createdAt: 1, updatedAt: 1 } } writeFileSync(receiptsFile(), JSON.stringify(j));`,
  )
  assert.equal(filled.code, 0, filled.stderr)
  assert.match((await submit(b, 'new-id')).stderr, /limit/)
  assert.equal(result(await submit(b)).entryId, first.entryId)
  assert.equal(Object.keys(records(b)).length, 1000)
  assert.equal(entries(b).length, 1)
})

test('an ambiguous transport failure is not automatically replayed', async () => {
  const b = await setup()
  result(await submit(b))
  const p = await scheduler(b, SID, { error: 'transport disconnected' })
  await until(() => firstRecord(b)?.state === 'delivery-unknown', 10_000)
  await until(() => entries(b).length === 0)
  p.kill()
  await p.exited
  assert.equal(prompts(b).length, 1)
  assert.equal((await submit(b)).code, 2)
})

test('opt-in report stays attached to original session after pane replacement', async () => {
  const b = await setup()
  result(await submit(b))
  const e = entries(b)[0]
  assert.ok(e)
  e.pane = 'p1'
  e.cwd = b.dir
  writeFileSync(join(state(b), 'schedule', `${e.id}.json`), JSON.stringify(e))
  const p = await scheduler(b, OTHER)
  await until(() => entries(b)[0]?.why === 'gone')
  assert.equal(prompts(b).length, 0)
  assert.equal(firstRecord(b)?.state, 'queued')
  p.kill()
  await p.exited
})

test('modified queue session identity cannot use an original receipt to dispatch elsewhere', async () => {
  const b = await setup()
  result(await submit(b))
  const check = await moduleRun(
    b,
    `import { listEntries } from './src/adapters/schedule-store.ts'; import { beginReport } from './src/adapters/call-receipts.ts'; const e = listEntries()[0]; e.key = '${OTHER}'; beginReport(e)`,
  )
  assert.notEqual(check.code, 0)
  assert.match(check.stderr, /refusing dispatch/)
  assert.equal(firstRecord(b)?.state, 'queued')
})

test('a known unsent draft defers receipt rather than turning it into unknown delivery', async () => {
  const b = await setup()
  result(await submit(b))
  const p = await scheduler(b, SID, { result: {} }, 'unsent draft')
  await until(() => entries(b)[0]?.why === 'draft')
  assert.equal(firstRecord(b)?.state, 'queued')
  assert.equal(prompts(b).length, 0)
  p.kill()
  await p.exited
})

test('concurrent retries never steal a stale receipt lock after an interrupted writer', async () => {
  const b = await setup()
  result(await submit(b))
  const lock = `${journal(b)}.lock`
  mkdirSync(lock)
  utimesSync(lock, new Date(0), new Date(0))
  const before = readFileSync(journal(b), 'utf8')
  const retries = await Promise.all([submit(b), submit(b)])
  for (const r of retries) {
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /Timed out waiting for lock/)
  }
  assert.equal(readFileSync(journal(b), 'utf8'), before)
  assert.equal(entries(b).length, 1)
  assert.ok(existsSync(lock))
})

test('missing queue behind a queued receipt is unknown rather than silently requeued', async () => {
  const b = await setup()
  const first = result(await submit(b))
  unlinkSync(join(state(b), 'schedule', `${first.entryId}.json`))
  const retry = await submit(b)
  assert.equal(retry.code, 2)
  assert.equal(JSON.parse(retry.stdout).state, 'delivery-unknown')
  assert.equal(entries(b).length, 0)
})

test('terminal receipt cleanup does not need the original session to be available', async () => {
  const b = await setup()
  result(await submit(b))
  const mark = await moduleRun(
    b,
    "import { listEntries } from './src/adapters/schedule-store.ts'; import { beginReport, settleReport } from './src/adapters/call-receipts.ts'; const e = listEntries()[0]; beginReport(e); settleReport(e, 'sent')",
  )
  assert.equal(mark.code, 0, mark.stderr)
  const p = await scheduler(b, OTHER)
  await until(() => entries(b).length === 0)
  assert.equal(prompts(b).length, 0)
  assert.equal(firstRecord(b)?.state, 'sent')
  p.kill()
  await p.exited
})

// Multi-profile: one journal for the board, keyed by the session's UUID, whichever profile it runs in.

/** A profile folder in the sandbox's home whose registry has `name` running as `session`. */
function profileWith(b: Sandbox, folder: string, session: string, name: string): string {
  const dir = join(b.env.HOME as string, folder)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{}')
  writeFileSync(
    join(dir, 'sessions', '1.json'),
    JSON.stringify({ sessionId: session, kind: 'interactive', pid: process.pid, name }),
  )
  return dir
}

test('a retry-safe report for a session in another profile, a hidden one too, is named and kept once', async () => {
  const b = await setup()
  // ~/.claude-work is found but not shown: its registry names the session all the same.
  profileWith(b, '.claude-work', SID, 'Work one')
  const first = result(await submit(b))
  assert.deepEqual(first, { reportId: 'call-1', session: SID, entryId: first.entryId, state: 'queued', reused: false })
  const e = entries(b)[0]
  assert.ok(e)
  assert.deepEqual([e.key, e.name, e.kind, e.by], [SID, 'Work one', 'call', 'mokupilot'])
  assert.equal(result(await submit(b)).entryId, first.entryId)
  assert.equal(entries(b).length, 1)
})

test('a retry-safe report never wakes a session the profile guard holds: it waits with the reason, still queued', async () => {
  const b = await setup()
  result(await submit(b))
  const home = b.env.HOME as string
  for (const name of ['.claude', '.claude-work']) {
    mkdirSync(join(home, name), { recursive: true })
    writeFileSync(join(home, name, 'settings.json'), '{}')
  }
  // The sleeper's card: its hooks reported the work folder. Its pane is a plain terminal now.
  mkdirSync(b.cards, { recursive: true })
  writeFileSync(join(b.cards, `${SID}.json`), JSON.stringify({ key: SID, profileDir: join(home, '.claude-work') }))
  b.state({
    'api snapshot': {
      result: { snapshot: { panes: [{ pane_id: 'p1', terminal_id: 'term-1' }], tabs: [], workspaces: [] } },
    },
  })
  let wakes = 0
  const wake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping')
      return res.end(JSON.stringify([{ session: SID, pane: 'p1', name: 'Sleepy', slept_at: new Date().toISOString() }]))
    wakes++
    res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
  try {
    const p = b.run('scheduler', {
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}`,
      scheduleTickSec: 0.2,
      profiles: [
        { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
        { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
      ],
    })
    await until(() => p.messages.some(m => (m as { ready?: boolean }).ready))
    const why =
      'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'
    await until(() => entries(b)[0]?.why === why)
    assert.equal(wakes, 0)
    assert.equal(prompts(b).length, 0)
    assert.equal(firstRecord(b)?.state, 'queued')
    p.kill()
    await p.exited
  } finally {
    await new Promise(resolve => wake.close(resolve))
  }
})
