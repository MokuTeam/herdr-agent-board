// `bun src/entrypoints/wake-run.ts`, what wake's pane runs: the supervisor with the wake process
// under it, against a sandbox's fake herdr, on a port of the test's. It records the pane and its own
// process in wake-status.json; with wake off it starts nothing.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, until } from '../support/sandbox.ts'
import { endWithSandbox, wakeOnConfig, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const RUN_ENTRY = join(root, 'src', 'entrypoints', 'wake-run.ts')

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const statusFile = (box: Sandbox): string => join(stateOf(box), 'wake-status.json')
function statusOf(box: Sandbox): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(statusFile(box), 'utf8'))
  } catch {
    return null
  }
}

/** herdr shows no pane at all: the wake process's looks find nothing to do. */
const emptyHerdr = (box: Sandbox): void =>
  box.state({ 'api snapshot': { result: { snapshot: { workspaces: [], tabs: [], panes: [] } } } })

/** `bun src/entrypoints/wake-run.ts` with the sandbox's env and `env`, ended (with what it started) before the sandbox goes. */
function spawnRun(box: Sandbox, env: Record<string, string> = {}): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  const proc = Bun.spawn([process.execPath, RUN_ENTRY], {
    cwd: root,
    env: { ...box.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  endWithSandbox(proc)
  // Read as it comes, so a full pipe never holds it up.
  void new Response(proc.stdout).text()
  void new Response(proc.stderr).text()
  return proc
}

async function exitWithin(proc: Bun.Subprocess, ms: number): Promise<number | null> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => null)])
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

test('the pane’s supervisor runs the wake process and records its pane and pid', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  const proc = spawnRun(box, { HERDR_PANE_ID: 'w9:p1' })
  await until(() => statusOf(box)?.state === 'running', 15_000)
  expect(statusOf(box)).toEqual({ state: 'running', at: expect.any(Number), pane: 'w9:p1', pid: proc.pid, port })
  // The API is the wake process's, a process of its own under the supervisor.
  const api = await (await fetch(`http://127.0.0.1:${port}/status`)).json()
  expect(api.pid).not.toBe(proc.pid)
  expect(proc.exitCode).toBeNull()
})

test('wake off: it ends with 0 and starts nothing', async () => {
  for (const config of [{ ...wakeOnConfig(0), wake: false }, '{ "wake": { "enabled": tr']) {
    const box = await wakeSandbox()
    emptyHerdr(box)
    const port = await unusedPort()
    writeBoardConfig(box, typeof config === 'string' ? config : { ...config, port: 9 })
    const proc = spawnRun(box, { HERDR_PANE_ID: 'w9:p1' })
    expect(await exitWithin(proc, 10_000)).toBe(0)
    expect(existsSync(statusFile(box))).toBe(false)
    expect(box.calls()).toEqual([])
    expect(await listening(port)).toBe(false)
  }
})

test('turned off while it runs: the wake process ends with 0, and so does its supervisor, status stopped', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  const proc = spawnRun(box, { HERDR_PANE_ID: 'w9:p1' })
  await until(() => statusOf(box)?.state === 'running', 15_000)
  writeBoardConfig(box, wakeOnConfig(port, { wake: { enabled: false } }))
  expect(await exitWithin(proc, 15_000)).toBe(0)
  expect(statusOf(box)).toEqual({ state: 'stopped', at: expect.any(Number), pane: 'w9:p1', pid: proc.pid })
  expect(await listening(port)).toBe(false)
})
