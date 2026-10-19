import { afterAll, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, sandbox, until } from './sandbox.ts'

let dirs: string[] = []

test('sandbox() lays out the env and the compiled fake herdr answers a canned reply', async () => {
  const box = await sandbox()
  dirs.push(box.dir)
  expect(box.env.HOME).toBe(join(box.dir, 'home'))
  expect(existsSync(box.env.LOCALAPPDATA as string)).toBe(true)
  expect(existsSync(box.env.HERDR_BIN_PATH as string)).toBe(true)

  box.state({
    'agent list': { result: { agents: [] } },
    'agent read': { text: 'two args' },
    'agent read p1': { text: 'three args' },
    'agent send': { seq: [{ result: 1 }, { result: 2 }] },
    'pane close': { error: 'nope', code: 'bad' },
  })
  const herdr = (...args: string[]) => Bun.spawnSync([box.env.HERDR_BIN_PATH as string, ...args], { env: box.env })
  const list = herdr('agent', 'list')
  expect(JSON.parse(list.stdout.toString())).toEqual({ result: { agents: [] } })
  expect(herdr('agent', 'read', 'p9').stdout.toString()).toBe('two args')
  expect(herdr('agent', 'read', 'p1', '--ansi').stdout.toString()).toBe('three args')
  expect(JSON.parse(herdr('agent', 'send').stdout.toString()).result).toBe(1)
  expect(JSON.parse(herdr('agent', 'send').stdout.toString()).result).toBe(2)
  expect(JSON.parse(herdr('agent', 'send').stdout.toString()).result).toBe(2)
  const failed = herdr('pane', 'close')
  expect(failed.exitCode).toBe(1)
  expect(JSON.parse(failed.stderr.toString())).toEqual({ error: { code: 'bad', message: 'nope' } })
  expect(box.calls()[0]).toEqual(['agent', 'list'])
  expect(box.calls()).toHaveLength(7)

  expect(readFileSync(box.env.FAKE_HERDR_LOG as string, 'utf8')).toContain('"agent","list"')
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const cutOffRun = fileURLToPath(new URL('./cut-off-run.ts', import.meta.url))
// How a run is cut off: Ctrl+C or a stop button signals the test process alone, or it is killed.
// On Windows each of them is a kill.
const CUTS = process.platform === 'win32' ? (['SIGKILL'] as const) : (['SIGINT', 'SIGTERM', 'SIGKILL'] as const)

test('a test run cut off midway leaves nothing its sandbox started running, a detached program included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-cut-off-'))
  const started: { dir: string; child: number; detached: number }[] = []
  try {
    await Promise.all(
      CUTS.map(async signal => {
        const out = join(dir, `${signal}.json`)
        const run = Bun.spawn([process.execPath, cutOffRun, out], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] })
        await until(() => existsSync(out) || run.exitCode !== null, 20_000)
        assert.ok(existsSync(out), `the run stopped before its sandbox was up (${run.exitCode})`)
        const pids = JSON.parse(readFileSync(out, 'utf8')) as { dir: string; child: number; detached: number }
        started.push(pids)
        assert.deepEqual([alive(pids.child), alive(pids.detached)], [true, true], signal)
        run.kill(signal)
        await run.exited
        const deadline = Date.now() + 5000
        while ((alive(pids.child) || alive(pids.detached)) && Date.now() < deadline) await Bun.sleep(25)
        assert.deepEqual(
          { child: alive(pids.child), detached: alive(pids.detached) },
          { child: false, detached: false },
          signal,
        )
      }),
    )
  } finally {
    // A failed check leaves nothing behind either; the cut-off runs could not remove their sandboxes.
    for (const { child, detached } of started)
      for (const pid of [detached, child]) if (alive(pid)) process.kill(pid, 'SIGKILL')
    for (const path of [...started.map(s => s.dir), dir])
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 40_000)

afterAll(() => {
  // Registered by onTestFinished: the directory is gone once the test ended.
  expect(dirs.length).toBe(1)
  for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  dirs = []
})
