// One wake per machine, held by its port (#119, safeguard 7): a second wake process that finds the
// port held by a wake ends with 0 quietly; a port another program holds is a status the board shows
// (portTaken), and the supervisor does not start wake again over it.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, until } from '../support/sandbox.ts'
import {
  endWithSandbox,
  spawnWake,
  startWakeProcess,
  wakeOnConfig,
  wakeSandbox,
  writeBoardConfig,
} from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const statusFile = (box: Sandbox): string => join(stateOf(box), 'wake-status.json')
function statusOf(box: Sandbox): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(statusFile(box), 'utf8'))
  } catch {
    return null
  }
}
const wakeLogText = (box: Sandbox): string => {
  try {
    return readFileSync(join(stateOf(box), 'wake.log'), 'utf8')
  } catch {
    return ''
  }
}
const emptyHerdr = (box: Sandbox): void =>
  box.state({ 'api snapshot': { result: { snapshot: { workspaces: [], tabs: [], panes: [] } } } })

async function exitWithin(proc: Bun.Subprocess, ms: number): Promise<number | null> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => null)])
}

/** Another program on the port: it answers, but not as a wake. */
function foreignServer(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('<html>not wake</html>') })
}

test('a second wake process finds the port held by a wake and exits 0 quietly', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  const first = await startWakeProcess(box, { port })
  const second = spawnWake(box)
  expect(await exitWithin(second.proc, 15_000)).toBe(0)
  expect(second.output().stderr).toBe('')
  expect(wakeLogText(box)).toContain(` another wake answers on 127.0.0.1:${port}: this one ends\n`)
  // The first one goes on, its status untouched.
  expect((await (await fetch(`${first.url}/status`)).json()).pid).toBe(first.proc.pid)
  expect(statusOf(box)).toBeNull()
})

test('a port held by a wake whose herdr hangs: the second wake still knows it for a wake (its /alive) and exits 0 quietly', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  const first = await startWakeProcess(box, { port })
  // herdr's snapshot never comes from now on: the first wake's /status does not answer.
  box.state({ 'api snapshot': { waitFor: join(box.dir, 'never') } })
  const second = spawnWake(box)
  expect(await exitWithin(second.proc, 15_000)).toBe(0)
  expect(second.output().stderr).toBe('')
  expect(wakeLogText(box)).toContain(` another wake answers on 127.0.0.1:${port}: this one ends\n`)
  // No portTaken written over the live wake's record.
  expect(statusOf(box)).toBeNull()
  expect(first.proc.exitCode).toBeNull()
})

test('a port held by another program: status portTaken, exit 76', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  // What the supervisor wrote as it started this process.
  mkdirSync(dirname(statusFile(box)), { recursive: true })
  writeFileSync(statusFile(box), JSON.stringify({ state: 'starting', at: 1, pane: 'w9:p1', pid: 4242 }))
  const other = foreignServer(port)
  try {
    const wake = spawnWake(box)
    endWithSandbox(wake.proc)
    expect(await exitWithin(wake.proc, 15_000)).toBe(76)
    expect(wake.output().stderr).toContain(`Port ${port} is taken by another program`)
  } finally {
    await other.stop(true)
  }
  expect(statusOf(box)).toEqual({
    state: 'portTaken',
    at: expect.any(Number),
    pane: 'w9:p1',
    pid: 4242,
    port,
    error: `Port ${port} is taken by another program`,
  })
  expect(box.calls()).toEqual([])
})

test('under its supervisor: a port another program holds stays portTaken, and wake is not started again', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  const other = foreignServer(port)
  try {
    const run = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'wake-run.ts')], {
      cwd: root,
      env: { ...box.env, HERDR_PANE_ID: 'w9:p1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    endWithSandbox(run)
    const screen = new Response(run.stderr).text()
    void new Response(run.stdout).text()
    await until(() => statusOf(box)?.state === 'portTaken', 15_000)
    const taken = statusOf(box)
    // Longer than the first pause after a crash (2 s): no start came.
    await Bun.sleep(3000)
    expect(statusOf(box)).toEqual(taken)
    expect(taken).toMatchObject({ pane: 'w9:p1', pid: run.pid, port })
    expect(run.exitCode).toBeNull()
    run.kill()
    expect(await screen).toContain(`Port ${port} is taken by another program`)
  } finally {
    await other.stop(true)
  }
})

test('a port the separate herdr-wake plugin’s router still holds (uninstalled, its pane left open): no quiet end, status portTaken naming it, exit 76', async () => {
  const box = await wakeSandbox()
  emptyHerdr(box)
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  // The old router: /status with its pid and sessions, no Telegram state; a 404 for /alive.
  const router = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: req =>
      new URL(req.url).pathname === '/status'
        ? Response.json({ pid: 4242, started: 'x', lastPoll: null, lastError: null, sessions: {} })
        : new Response(null, { status: 404 }),
  })
  const error = `Port ${port} is held by the separate herdr-wake plugin’s router (process 4242)`
  try {
    const wake = spawnWake(box)
    endWithSandbox(wake.proc)
    expect(await exitWithin(wake.proc, 15_000)).toBe(76)
    expect(wake.output().stderr).toContain(error)
  } finally {
    await router.stop(true)
  }
  expect(statusOf(box)).toEqual({ state: 'portTaken', at: expect.any(Number), port, error })
  expect(wakeLogText(box)).not.toContain('another wake answers')
})
