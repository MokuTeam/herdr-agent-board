import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runHere, runTree } from '../../src/adapters/process.ts'
import { root, until } from '../support/sandbox.ts'

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
  let pid = 0
  try {
    const script = join(dir, 'parent.ts')
    // The launcher starts a grandchild that sleeps 10 s, prints its pid and waits for it: long
    // enough for the check below, and a test run cut off before the kill leaves it no longer.
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process'",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore', detached: process.platform === 'win32' })",
        'console.log("grandchild=" + child.pid)',
        "child.on('exit', () => process.exit(0))",
        'setTimeout(() => {}, 10000)',
      ].join('\n'),
    )
    const result = await runTree(process.execPath, [script], { timeout: 1500 })
    expect(result.killed).toBe(true)
    pid = Number(/grandchild=(\d+)/.exec(result.stdout)?.[1])
    assert.ok(pid > 0, `no grandchild pid in ${JSON.stringify(result.stdout)}`)
    await until(() => !alive(pid), 2000)
  } finally {
    // A failed check leaves no grandchild behind either.
    if (pid > 0 && alive(pid)) process.kill(pid)
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

test('runTree hands the program its input on stdin and closes it; a signal ends it as the timeout does', async () => {
  const echo = await runTree(
    process.execPath,
    [
      '-e',
      'let s = ""; process.stdin.on("data", d => (s += d)); process.stdin.on("end", () => console.log("got:" + s))',
    ],
    { timeout: 10_000, input: 'what was the code word?' },
  )
  expect(echo.stdout.trim()).toBe('got:what was the code word?')
  expect(echo.killed).toBe(false)
  const control = new AbortController()
  const started = Date.now()
  const long = runTree(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
    timeout: 15_000,
    signal: control.signal,
  })
  setTimeout(() => control.abort(), 300)
  const ended = await long
  expect(ended.killed).toBe(true)
  expect(Date.now() - started).toBeLessThan(8000)
  // Without them, as before: the program runs to its end.
  const plain = await runTree(process.execPath, ['-e', 'console.log("done")'], { timeout: 10_000 })
  expect([plain.stdout.trim(), plain.killed]).toEqual(['done', false])
})

test('runHere starts the program in this folder when the one it is given is gone by then; one that starts nowhere, its error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-here-'))
  try {
    // The fake claude (test/support/fake-claude.ts) writes down the folder it runs in.
    const log = join(dir, 'claude.json')
    const claude = [join(root, 'test/support/fake-claude.ts'), '--resume', 'x']
    const env = { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXIT: '7' }
    const ranIn = (): string => realpathSync(JSON.parse(readFileSync(log, 'utf8')).cwd)
    // A folder that is there: it runs there.
    expect(await runHere(process.execPath, claude, env, dir)).toEqual({ code: 7, error: null })
    expect(ranIn()).toBe(realpathSync(dir))
    // One removed since it was looked at: here, as without one.
    rmSync(log)
    expect(await runHere(process.execPath, claude, env, join(dir, 'gone'))).toEqual({ code: 7, error: null })
    expect(ranIn()).toBe(realpathSync(process.cwd()))
    // A program that starts in neither: the error, as without a folder.
    const none = await runHere('board-no-such-program', [], env, join(dir, 'gone'))
    expect(none.code).toBe(127)
    expect(none.error?.code).toBe('ENOENT')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
