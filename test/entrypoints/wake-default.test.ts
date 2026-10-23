// Wake starts with the board on every install (#119): its startup entry, actions and pane in the
// board's own manifest, and on without a `wake` section. The board's own start stays today's, and
// with the separate herdr-wake plugin installed wake's start asks herdr one thing and holds back,
// while the board talks to herdr-wake at wakeUrl behind the old guard, as before.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WAKE_PORT, wakeConfig, wakeSwitch } from '../../src/core/wake/config.ts'
import type { WakeStatusFile } from '../../src/core/wake/status.ts'
import { startWake } from '../../src/services/wake/start.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { root, type Sandbox, until } from '../support/sandbox.ts'
import {
  boardOnPath,
  card,
  herdrAsleep,
  paneCalls,
  projectDir,
  SID,
  SLEPT,
  stateDir,
  transcript,
  twoProfiles,
} from '../support/sleeper-fixtures.ts'
import { endWithSandbox, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'
import { oldSource } from '../web/support/old-app.ts'

setDefaultTimeout(40_000)

const ROOT = resolve(root)
const START_ENTRY = join(root, 'src', 'entrypoints', 'wake-start.ts')

const openCall = (workspace: string): string[] => [
  'plugin',
  'pane',
  'open',
  '--plugin',
  'agent-board',
  '--entrypoint',
  'wake',
  '--placement',
  'tab',
  '--workspace',
  workspace,
  '--cwd',
  ROOT,
  '--no-focus',
]
/** What herdr answers a start on a computer with no Wake workspace yet (the adapter's `result`). */
const FIRST_START: Record<string, unknown> = {
  'plugin list': { plugins: [{ plugin_id: 'agent-board' }] },
  'api snapshot': { snapshot: { workspaces: [{ workspace_id: 'w1', label: 'Main' }], tabs: [], panes: [] } },
  'workspace create': { workspace: { workspace_id: 'wN', label: 'Wake' }, tab: { tab_id: 'first-tab' } },
  'plugin pane open': { plugin_pane: { pane: { pane_id: 'wN:p2' } } },
  'tab close': {},
}
const FIRST_START_CALLS = [
  ['plugin', 'list', '--json'],
  ['api', 'snapshot'],
  ['workspace', 'create', '--label', 'Wake', '--cwd', ROOT, '--no-focus'],
  openCall('wN'),
  ['tab', 'close', 'first-tab'],
]

/** wake-start.ts run to its end in the sandbox. */
async function runStart(box: Sandbox): Promise<{ code: number | null; stdout: string }> {
  const proc = Bun.spawn([process.execPath, START_ENTRY], {
    cwd: root,
    env: { ...box.env, BOARD_WAKE_START_DEADLINE_MS: '8000' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  endWithSandbox(proc)
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout }
}

const statusOf = (box: Sandbox): unknown => JSON.parse(readFileSync(join(stateDir(box), 'wake-status.json'), 'utf8'))

test('with no wake section, wake starts: its start opens the pane', async () => {
  // No config.json, or one without `wake`: the start runs on wake's own port. Its answer is the
  // test's: no test asks 127.0.0.1 on that port.
  const files: { exists: boolean; raw: Record<string, unknown> | null }[] = [
    { exists: false, raw: null },
    { exists: true, raw: { language: 'en', wakeUrl: '' } },
  ]
  for (const file of files) {
    const asked: number[] = []
    const calls: string[][] = []
    let status = null as WakeStatusFile | null
    const result = await startWake(
      {
        herdr: async <T>(args: string[]) => {
          calls.push(args)
          const call = Object.keys(FIRST_START).find(c => `${args.join(' ')} `.startsWith(`${c} `))
          return FIRST_START[call ?? ''] as T
        },
        answers: async port => {
          asked.push(port)
          return false
        },
        readStatus: () => status,
        writeStatus: s => {
          status = s
        },
        alive: () => false,
        log: () => {},
        sleep: async () => {},
        now: Date.now,
        bootedAt: 0,
        root: ROOT,
      },
      { on: wakeSwitch(file), settings: wakeConfig(file.raw?.wake), board: { label: 'Board', pane: null } },
    )
    expect(result).toBe('opened')
    expect(asked).toEqual([WAKE_PORT])
    expect(calls).toEqual(FIRST_START_CALLS)
    expect(status).toEqual({ state: 'starting', at: expect.any(Number), pane: 'wN:p2' })
  }

  // The entrypoint, with a wake section that only moves its port (the switch's default decides).
  const box = await wakeSandbox()
  writeBoardConfig(box, { language: 'en', port: 9, wake: { port: await unusedPort() } })
  box.state(Object.fromEntries(Object.entries(FIRST_START).map(([call, result]) => [call, { result }])))
  const out = await runStart(box)
  expect([out.code, out.stdout.trim()]).toEqual([0, "wake's start: opened"])
  expect(box.calls()).toEqual(FIRST_START_CALLS)
})

// The newest main merged into this work: the board's manifest entries before wake's.
const MAIN = '9296038'
// The board's start (open.ts, run.ts) as of #188, which has open.ts read board.json's host. A later
// change to the board's own start moves this pin.
const START = 'b028e87'
type Entry = { id?: string; command: string[] }
type Manifest = Record<string, unknown> & Partial<Record<'build' | 'startup' | 'actions' | 'panes', Entry[]>>
const LISTS = ['build', 'startup', 'actions', 'panes'] as const

test('the board’s start is today’s: open.ts, run.ts, the board’s manifest entries', () => {
  for (const file of ['src/entrypoints/open.ts', 'src/entrypoints/run.ts'])
    expect(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n')).toBe(oldSource(file, START))

  const before = Bun.TOML.parse(oldSource('herdr-plugin.toml', MAIN)) as Manifest
  const now = Bun.TOML.parse(readFileSync(join(root, 'herdr-plugin.toml'), 'utf8')) as Manifest
  // The plugin's own fields as they were.
  const fields = (m: Manifest) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => !(LISTS as readonly string[]).includes(k)))
  expect(fields(now)).toEqual(fields(before))
  // The board's entries first, as they were; wake's after them.
  const added: Record<string, Entry[]> = {}
  for (const key of LISTS) {
    const board = before[key] ?? []
    expect((now[key] ?? []).slice(0, board.length)).toEqual(board)
    added[key] = (now[key] ?? []).slice(board.length)
  }
  expect(added.build).toEqual([])
  expect(added.startup?.map(s => s.command)).toEqual([['bun', 'src/entrypoints/wake-start.ts']])
  expect(added.actions?.map(a => [a.id, a.command])).toEqual([
    ['sleep', ['bun', 'src/entrypoints/wake-action.ts', 'sleep']],
    ['wake', ['bun', 'src/entrypoints/wake-action.ts', 'wake']],
  ])
  expect(added.panes?.map(p => [p.id, p.command])).toEqual([['wake', ['bun', 'src/entrypoints/wake-run.ts']]])
})

const REFUSED =
  'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'

test('with the old plugin installed, wake’s start makes one plugin list and exits; the board’s calls are today’s', async () => {
  const box = await wakeSandbox()
  const { own, work, list } = twoProfiles(box)
  const cwd = projectDir(box)
  transcript(work, cwd)
  herdrAsleep(box, cwd, {
    extra: { 'plugin list': { result: { plugins: [{ plugin_id: 'agent-board' }, { plugin_id: 'herdr-wake' }] } } },
  })
  const old = await fakeWake({
    sleeping: [{ session: SID, pane: 'p1', name: 'Report', slept_at: new Date(SLEPT).toISOString() }],
  })
  // No wake section: wake is on, and held by the old plugin.
  writeBoardConfig(box, { language: 'en', port: 9, wakeUrl: old.url, profiles: list })
  const out = await runStart(box)
  expect([out.code, out.stdout.trim()]).toEqual([0, "wake's start: held"])
  expect(box.calls()).toEqual([['plugin', 'list', '--json']])
  expect(statusOf(box)).toEqual({ state: 'held', at: expect.any(Number) })

  // The board: herdr-wake at wakeUrl and the old guard. (Its port moved off wake's own: nothing of
  // the board asks 127.0.0.1:12421 in a test.)
  const { url, proc } = await serveBoard(
    box,
    { language: 'en', wakeUrl: old.url, profiles: list, wake: { port: await unusedPort() } },
    boardOnPath(box),
  )
  const wake = async () => {
    const res = await fetch(`${url}/api/session/${SID}/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: '{}',
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const refreshed = (): number => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  /** Refreshes the board until it shows the session in `profile`. */
  const shows = async (profile: string): Promise<void> => {
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(50)) {
      const before = refreshed()
      proc.send('refresh')
      await until(() => refreshed() > before)
      const b = (await (await fetch(`${url}/api/board`)).json()) as {
        stale?: boolean
        items?: { key: string; profile?: string | null }[]
      }
      if (!b.stale && b.items?.some(i => i.key === SID && (i.profile ?? 'default') === profile)) return
      if (Date.now() > deadline) throw new Error(`the board did not show ${SID} in ${profile}`)
    }
  }
  // A session of the board's own profile: herdr-wake wakes it.
  card(box, own)
  await shows('default')
  const woken = await wake()
  expect(woken.status).toBe(200)
  expect(old.requests().filter(q => q.method === 'POST')).toEqual([
    { method: 'POST', path: '/wake', body: { target: 'p1' } },
  ])
  // A Work session started outside the board: the old guard refuses it.
  card(box, work)
  await shows('work')
  const refused = await wake()
  expect([refused.status, refused.body.error]).toEqual([409, REFUSED])
  expect(old.requests().filter(q => q.method === 'POST')).toHaveLength(1)
  expect(paneCalls(box)).toEqual([])
  // The board started no wake beside the old plugin, and asked herdr nothing more of plugins.
  expect(proc.messages.filter(m => (m as { wakeStarted?: unknown }).wakeStarted)).toEqual([])
  expect(box.calls().filter(c => c[0] === 'plugin')).toEqual([['plugin', 'list', '--json']])
})
