import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runTree } from '../../src/adapters/process.ts'
import { until } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a timeout ends the launcher and everything it started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-proc-'))
  try {
    const script = join(dir, 'parent.ts')
    // The launcher starts a grandchild that sleeps 60 s, prints its pid and waits for it.
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process'",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })",
        'console.log("grandchild=" + child.pid)',
        "child.on('exit', () => process.exit(0))",
        'setTimeout(() => {}, 60000)',
      ].join('\n'),
    )
    const result = await runTree(process.execPath, [script], { timeout: 1500 })
    expect(result.killed).toBe(true)
    const pid = Number(/grandchild=(\d+)/.exec(result.stdout)?.[1])
    assert.ok(pid > 0, `no grandchild pid in ${JSON.stringify(result.stdout)}`)
    await until(() => !alive(pid), 2000)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('a finished program reports its code and output; a missing one its error', async () => {
  const ok = await runTree(process.execPath, ['-e', "console.log('hi'); process.exit(3)"], { timeout: 10_000 })
  expect([ok.code, ok.killed, ok.stdout.trim()]).toEqual([3, false, 'hi'])
  const gone = await run('board-no-such-program', [])
  expect(gone.error?.code).toBe('ENOENT')
  expect(gone.code).toBe('ENOENT')
})
