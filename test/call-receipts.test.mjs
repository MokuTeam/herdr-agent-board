import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { root, sandbox, until } from './fixtures/sandbox.mjs'
const SID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'
const state = b => join(b.env.LOCALAPPDATA, 'herdr/plugins/agent-board')
const journal = b => join(state(b), 'call-receipts.json')
const records = b => JSON.parse(readFileSync(journal(b), 'utf8')).records
const entries = b => existsSync(join(state(b), 'schedule')) ? readdirSync(join(state(b), 'schedule')).filter(n => /^[a-f0-9]{6}\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(state(b), 'schedule', n)))) : []
function setup(t) {
  const b = sandbox(t)
  const cfg = join(b.env.APPDATA, 'herdr/plugins/config/agent-board')
  mkdirSync(cfg, { recursive: true }); writeFileSync(join(cfg, 'config.json'), JSON.stringify({ language: 'en', port: 9 }))
  writeFileSync(join(b.dir, 'report.md'), 'Private call summary')
  b.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  return b
}
async function cli(b, args) { return b.run('cli', { args, env: {} }).exited }
async function submit(b, id = 'call-1', session = SID) {
  return cli(b, ['call-report', '--session', session, '--report-id', id, '--file', join(b.dir, 'report.md')])
}
const result = out => { assert.equal(out.code, 0, out.stderr); return JSON.parse(out.stdout) }
async function moduleRun(b, code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: b.env })
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c)
    child.on('error', reject); child.on('close', code => resolve({ code, stdout: out, stderr: err }))
  })
}
async function scheduler(b, session = SID, prompt = { result: {} }, draft = '') {
  const rule = '─'.repeat(40)
  b.state({
    'api snapshot': { result: { snapshot: { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: session }, agent_status: 'idle', cwd: b.dir }], tabs: [], workspaces: [] } } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: session } } } },
    'agent read': { text: ['● done', rule, `❯ ${draft}`, rule, '  ⏵⏵ bypass permissions on'].join('\n') },
    'agent prompt': prompt,
  })
  const proc = b.run('scheduler', { categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, scheduleTickSec: 0.2 })
  await until(() => proc.messages.some(m => m.ready)); return proc
}
const prompts = b => b.calls().filter(a => a[1] === 'prompt')

test('concurrent call exports deduplicate across processes and canonicalize UUID casing', { timeout: 15000 }, async t => {
  const b = setup(t)
  const outputs = await Promise.all(Array.from({ length: 6 }, (_, i) => submit(b, 'call-1', i % 2 ? SID.toUpperCase() : SID)))
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

test('conflicting content never alters original receipt or queue; full normalized input is hashed', async t => {
  const b = setup(t); result(await submit(b)); const before = readFileSync(journal(b), 'utf8')
  writeFileSync(join(b.dir, 'report.md'), 'Different summary')
  const conflict = await submit(b); assert.notEqual(conflict.code, 0); assert.match(conflict.stderr, /conflict/)
  assert.equal(readFileSync(journal(b), 'utf8'), before); assert.equal(entries(b)[0].text, 'Private call summary')
  writeFileSync(join(b.dir, 'report.md'), '\uFEFFPrivate call summary\r\n')
  assert.equal(result(await submit(b)).reused, true)
})

test('invalid IDs, oversized input and corrupt receipt storage fail closed before queue mutation', async t => {
  const b = setup(t)
  for (const id of ['../escape', '/tmp/report', 'a'.repeat(129)]) assert.notEqual((await submit(b, id)).code, 0)
  writeFileSync(join(b.dir, 'report.md'), 'x'.repeat(1024 * 1024 + 1))
  assert.match((await submit(b)).stderr, /exceeds/); assert.equal(entries(b).length, 0)
  writeFileSync(join(b.dir, 'report.md'), 'Private call summary'); result(await submit(b))
  writeFileSync(journal(b), '{truncated')
  assert.match((await submit(b)).stderr, /corrupt/); assert.equal(entries(b).length, 1)
})

test('queue-before-journal crash recovers as unknown and never dispatches on restart', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b)); unlinkSync(journal(b)) // persisted queue survived a missing receipt commit
  const retry = await submit(b); assert.equal(retry.code, 2); assert.equal(JSON.parse(retry.stdout).state, 'delivery-unknown')
  const p = await scheduler(b); await until(() => entries(b).length === 0)
  assert.equal(prompts(b).length, 0); p.kill(); await p.exited
  assert.equal((await submit(b)).code, 2)
})

test('crash after dispatch marker yields unknown without another transport attempt', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b))
  const mark = await moduleRun(b, "import {listEntries} from './src/schedule.mjs'; import {beginReport} from './src/call-receipts.mjs'; console.log(beginReport(listEntries()[0]))")
  assert.equal(mark.code, 0, mark.stderr); assert.match(mark.stdout, /dispatching/)
  const p = await scheduler(b); await until(() => entries(b).length === 0)
  assert.equal(prompts(b).length, 0); p.kill(); await p.exited
  assert.equal(Object.values(records(b))[0].state, 'delivery-unknown')
})

test('sent receipt survives restart and retries without claiming agent consumption', { timeout: 15000 }, async t => {
  const b = setup(t); const first = result(await submit(b)); const p = await scheduler(b)
  await until(() => Object.values(records(b))[0].state === 'sent', 10000)
  p.kill(); await p.exited
  const retry = result(await submit(b)); assert.equal(retry.state, 'sent'); assert.equal(retry.entryId, first.entryId)
  assert.equal(entries(b).length, 0); assert.equal(prompts(b).length, 1)
  const status = result(await cli(b, ['call-report', '--session', SID, '--report-id', 'call-1', '--status']))
  assert.equal(status.state, 'sent'); assert.equal(status.consumed, undefined)
})

test('cancelled receipt is immutable and opt-in retry cannot requeue it', async t => {
  const b = setup(t); const first = result(await submit(b))
  assert.equal((await cli(b, ['unschedule', first.entryId])).code, 0)
  assert.equal(result(await submit(b)).state, 'cancelled'); assert.equal(entries(b).length, 0)
})

test('receipt capacity refuses new IDs without forgetting existing retries', async t => {
  const b = setup(t); const first = result(await submit(b))
  const filled = await moduleRun(b, "import {readFileSync,writeFileSync} from 'node:fs'; import {RECEIPTS_FILE,reportIdentity,reportHash,MAX_RECEIPTS} from './src/call-receipts.mjs'; const j=JSON.parse(readFileSync(RECEIPTS_FILE)); for(let i=1;i<MAX_RECEIPTS;i++){const r=reportIdentity('" + SID + "','old-'+i,reportHash('text')); j.records[r.key]={...r,entryId:'abcdef',state:'sent',createdAt:1,updatedAt:1}} writeFileSync(RECEIPTS_FILE,JSON.stringify(j));")
  assert.equal(filled.code, 0, filled.stderr)
  assert.match((await submit(b, 'new-id')).stderr, /limit/)
  assert.equal(result(await submit(b)).entryId, first.entryId)
  assert.equal(Object.keys(records(b)).length, 1000); assert.equal(entries(b).length, 1)
})

test('an ambiguous transport failure is not automatically replayed', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b)); const p = await scheduler(b, SID, { error: 'transport disconnected' })
  await until(() => Object.values(records(b))[0].state === 'delivery-unknown', 10000)
  await until(() => entries(b).length === 0); p.kill(); await p.exited
  assert.equal(prompts(b).length, 1); assert.equal((await submit(b)).code, 2)
})

test('opt-in report stays attached to original session after pane replacement', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b))
  const e = entries(b)[0]; e.pane = 'p1'; e.cwd = b.dir
  writeFileSync(join(state(b), 'schedule', `${e.id}.json`), JSON.stringify(e))
  const p = await scheduler(b, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  await until(() => entries(b)[0]?.why === 'gone')
  assert.equal(prompts(b).length, 0); assert.equal(Object.values(records(b))[0].state, 'queued')
  p.kill(); await p.exited
})

test('modified queue session identity cannot use an original receipt to dispatch elsewhere', async t => {
  const b = setup(t); result(await submit(b))
  const check = await moduleRun(b, "import {listEntries} from './src/schedule.mjs'; import {beginReport} from './src/call-receipts.mjs'; const e=listEntries()[0]; e.key='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; beginReport(e)")
  assert.notEqual(check.code, 0); assert.match(check.stderr, /refusing dispatch/)
  assert.equal(Object.values(records(b))[0].state, 'queued')
})

test('a known unsent draft defers receipt rather than turning it into unknown delivery', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b)); const p = await scheduler(b, SID, { result: {} }, 'unsent draft')
  await until(() => entries(b)[0]?.why === 'draft')
  assert.equal(Object.values(records(b))[0].state, 'queued'); assert.equal(prompts(b).length, 0)
  p.kill(); await p.exited
})

test('concurrent retries never steal a stale receipt lock after an interrupted writer', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b))
  const lock = `${journal(b)}.lock`; mkdirSync(lock)
  const { utimesSync } = await import('node:fs'); utimesSync(lock, new Date(0), new Date(0))
  const before = readFileSync(journal(b), 'utf8')
  const retries = await Promise.all([submit(b), submit(b)])
  for (const r of retries) { assert.notEqual(r.code, 0); assert.match(r.stderr, /Timed out waiting for lock/) }
  assert.equal(readFileSync(journal(b), 'utf8'), before); assert.equal(entries(b).length, 1); assert.ok(existsSync(lock))
})

test('missing queue behind a queued receipt is unknown rather than silently requeued', async t => {
  const b = setup(t); const first = result(await submit(b))
  unlinkSync(join(state(b), 'schedule', `${first.entryId}.json`))
  const retry = await submit(b); assert.equal(retry.code, 2); assert.equal(JSON.parse(retry.stdout).state, 'delivery-unknown')
  assert.equal(entries(b).length, 0)
})

test('terminal receipt cleanup does not need the original session to be available', { timeout: 15000 }, async t => {
  const b = setup(t); result(await submit(b))
  const mark = await moduleRun(b, "import {listEntries} from './src/schedule.mjs'; import {beginReport,settleReport} from './src/call-receipts.mjs'; const e=listEntries()[0]; beginReport(e); settleReport(e,'sent')")
  assert.equal(mark.code, 0, mark.stderr)
  const p = await scheduler(b, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'); await until(() => entries(b).length === 0)
  assert.equal(prompts(b).length, 0); assert.equal(Object.values(records(b))[0].state, 'sent'); p.kill(); await p.exited
})
