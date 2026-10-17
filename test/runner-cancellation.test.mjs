import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const rows = () => execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8', timeout: 1000 })
  .trim().split('\n').map(line => { const [, pid, parent, state, args] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/) || []; return { pid: Number(pid), parent: Number(parent), state, args } })

for (const signal of ['SIGINT', 'SIGTERM']) test(`portable runner ${signal} stops an actual detached launcher and its child`, { timeout: 30_000, skip: process.platform === 'win32' }, async t => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, ['scripts/run-tests.mjs', '--test-name-pattern=^a launcher that runs too long'], { cwd: root, env, stdio: 'ignore' })
  const tracked = new Set([child.pid])
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  t.after(() => { for (const pid of tracked) try { process.kill(pid, 'SIGKILL') } catch {} })
  let found = false
  const deadline = Date.now() + 15_000
  while (!found && Date.now() < deadline) {
    const table = rows()
    for (let pass = 0; pass < 10; pass++) for (const row of table) if (tracked.has(row.parent)) tracked.add(row.pid)
    found = table.some(row => tracked.has(row.pid) && row.args?.includes('fake-launcher.mjs') && row.args.includes('--late'))
    if (!found) await pause(20)
  }
  assert.equal(found, true, 'waited for the real detached launcher fixture')
  child.kill(signal)
  // Repeated user cancellation must not terminate the wrapper before tree cleanup.
  await pause(10)
  child.kill(signal)
  const result = await closed
  assert.equal(result.code, signal === 'SIGINT' ? 130 : 143)
  await pause(300)
  assert.deepEqual(rows().filter(row => tracked.has(row.pid) && !row.state?.startsWith('Z')), [])
})
