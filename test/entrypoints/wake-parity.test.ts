// The new wake's API against the old herdr-wake router's (herdr-wake/src/router.mjs, on Node), both
// on the same compiled fake herdr, the same Claude registry under the sandbox's home and the same
// session entries: the same answers, field for field, but the profile the new one adds to each
// session (decision 9). Skipped where Node is not installed.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox } from '../support/sandbox.ts'
import { runningSession, SID, SID2 } from '../support/wake-fixtures.ts'
import { endWithSandbox, startWakeProcess, wakeSandbox } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const node = Bun.which('node')
const HOUR = 3_600_000
/** A project folder with spaces, Cyrillic and %. */
const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'

/** What herdr shows: a Default session idle in w1:p1, and w1:p2 a shell where a session sleeps. */
function herdrShows(box: Sandbox): void {
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'Main' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
          panes: [
            {
              pane_id: 'w1:p1',
              tab_id: 't1',
              workspace_id: 'w1',
              cwd: PROJECT,
              agent: 'claude',
              agent_status: 'idle',
              agent_session: { value: SID },
              terminal_title_stripped: 'claude',
            },
            { pane_id: 'w1:p2', tab_id: 't1', workspace_id: 'w1', cwd: PROJECT },
          ],
        },
      },
    },
  })
}

/** The session entries both read: the sleeper in w1:p2, as the old router wrote it. */
function entries(): Record<string, unknown> {
  const sleptAt = Date.now() - HOUR
  return {
    'w1:p2': { session: SID2, name: 'Ledger', cwd: PROJECT, title: 'claude', seen_at: sleptAt, slept_at: sleptAt },
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

/** The old router on `port`, its config and state in folders of its own in the sandbox; resolves once it answers. */
async function oldRouter(box: Sandbox, port: number, sessions: Record<string, unknown>): Promise<string> {
  const configDir = join(box.dir, 'herdr-wake-config')
  const stateDir = join(box.dir, 'herdr-wake-state')
  writeJson(join(configDir, 'config.json'), { port })
  writeJson(join(stateDir, 'sessions.json'), sessions)
  const proc = Bun.spawn([node as string, join(root, 'herdr-wake', 'src', 'router.mjs')], {
    cwd: root,
    env: { ...box.env, HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  endWithSandbox(proc)
  const url = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try {
      return (await fetch(`${url}/status`, { signal: AbortSignal.timeout(1000) })).ok
    } catch {
      return false
    }
  }, 10_000)
  return url
}

/** Resolves once `fn` gives true; throws after `timeout` ms. */
async function waitFor(fn: () => Promise<boolean>, timeout: number): Promise<void> {
  for (const deadline = Date.now() + timeout; !(await fn()); await Bun.sleep(25))
    if (Date.now() > deadline) throw new Error('Timed out waiting for the router')
}

/** Two ports nothing listens on, not the same one. */
async function twoPorts(): Promise<[number, number]> {
  const first = await unusedPort()
  let second = await unusedPort()
  while (second === first) second = await unusedPort()
  return [first, second]
}

const get = async (url: string): Promise<unknown> => (await fetch(url)).json()
const postText = async (url: string, body: unknown): Promise<string> =>
  (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).text()

/** Each entry without its `profile`. */
const withoutProfile = (list: unknown): unknown =>
  Array.isArray(list) ? list.map(({ profile: _profile, ...rest }) => rest) : list

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** GET /status once the first look at herdr is saved: the running session's pane is among the sessions. */
async function statusOnceSeen(url: string): Promise<Record<string, unknown>> {
  let status: Record<string, unknown> = {}
  await waitFor(async () => {
    status = (await get(`${url}/status`)) as Record<string, unknown>
    const sessions = status.sessions
    return !!sessions && typeof sessions === 'object' && 'w1:p1' in sessions
  }, 10_000)
  return status
}

test.skipIf(!node)(
  'the new wake answers /sleeping, /awake and /status field for field as the old router, but each session’s profile',
  async () => {
    const box = await wakeSandbox()
    runningSession(join(box.env.HOME as string, '.claude'), {
      id: SID,
      name: 'Billing',
      cwd: PROJECT,
      statusUpdatedAt: Date.now() - 2 * HOUR,
    })
    herdrShows(box)
    const sessions = entries()
    writeJson(join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'wake-sessions.json'), sessions)
    const [oldPort, newPort] = await twoPorts()
    const old = await oldRouter(box, oldPort, sessions)
    const now = (await startWakeProcess(box, { port: newPort })).url

    const sleeping = await get(`${old}/sleeping`)
    expect(sleeping).toHaveLength(1)
    expect(withoutProfile(await get(`${now}/sleeping`))).toEqual(sleeping)
    const awake = await get(`${old}/awake`)
    expect(awake).toHaveLength(1)
    const newAwake = await get(`${now}/awake`)
    // The profile is there, and is all that differs.
    expect(newAwake).toEqual([expect.objectContaining({ profile: expect.any(Object) })])
    expect(withoutProfile(newAwake)).toEqual(awake)

    const was = await statusOnceSeen(old)
    const is = await statusOnceSeen(now)
    expect(Object.keys(is)).toEqual(Object.keys(was))
    expect(Object.values(is).map(kind)).toEqual(Object.values(was).map(kind))
    // pid and started are each process's own; the rest is the same.
    expect(is.reaper).toEqual(was.reaper)
    expect([is.lastPoll, is.lastError]).toEqual([was.lastPoll, was.lastError])
    expect(withoutProfile(is.sleeping)).toEqual(was.sleeping)
    expect(Object.keys(is.sessions as object).sort()).toEqual(Object.keys(was.sessions as object).sort())

    for (const path of ['/wake', '/sleep'])
      expect(await postText(`${now}${path}`, { target: 'nobody' })).toBe(
        await postText(`${old}${path}`, { target: 'nobody' }),
      )
    for (const url of [old, now]) {
      const res = await fetch(`${url}/nothing`)
      expect([res.status, await res.text()]).toEqual([404, ''])
    }
  },
)
