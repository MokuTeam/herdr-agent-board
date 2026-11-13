// A MokuPilot day session on the board (#331), against a fake MokuPilot: a temp HOME with the day's
// folder (~/.meeting-copilot/day/<today>/state.json) and the session in Claude's registry, which
// MokuPilot runs as `claude -p` with every hook off, in the herdr pane MokuPilot runs in (herdr
// names no session there). The day has one card under its Claude name with no pane, and what is
// sent to it goes to the day's inbox, in `meet day --report`'s format. Without a running day, or
// with `"mokupilot": false`, that pane's card is as it was.
import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayName } from '../../src/core/mokupilot-day.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const DAY = '3dbb2396-0000-4000-8000-000000000331'
const OTHER = '7a2b4c6d-0000-4000-8000-000000000002'
const PANE = 'w1:p9N'

const home = (box: Sandbox): string => box.env.HOME as string
const configDir = (box: Sandbox): string => join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const dayFolder = (box: Sandbox): string => join(home(box), '.meeting-copilot', 'day', dayName(new Date()))
const put = (file: string, value: unknown): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

/** herdr's view: MokuPilot's pane, where herdr sees Claude but names no session, and a session of its own. */
function herdrState(box: Sandbox): void {
  const snapshot = {
    workspaces: [{ workspace_id: 'w1', label: 'Моя работа 100%' }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
    panes: [
      {
        pane_id: PANE,
        tab_id: 't1',
        workspace_id: 'w1',
        agent: 'claude',
        agent_status: 'idle',
        cwd: join(box.dir, 'MokuPilot'),
        terminal_title_stripped: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      },
      {
        pane_id: 'w1:p1',
        tab_id: 't1',
        workspace_id: 'w1',
        agent: 'claude',
        agent_session: { value: OTHER },
        agent_status: 'idle',
        cwd: box.dir,
        terminal_title_stripped: 'Invoices',
      },
    ],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
}

/** The day session in a profile's registry (the default one's), as Claude writes it; this test's pid: alive. */
function registry(box: Sandbox, status = 'idle', profile = '.claude', cwd = 'C:\\Work'): void {
  put(join(home(box), profile, 'settings.json'), {})
  put(join(home(box), profile, 'sessions', `${process.pid}.json`), {
    pid: process.pid,
    sessionId: DAY,
    cwd,
    startedAt: Date.now() - 600_000,
    kind: 'interactive',
    entrypoint: 'sdk-cli',
    name: 'work-a7',
    status,
    statusUpdatedAt: Date.now() - 5_000,
  })
}

/** The day's state.json as MokuPilot writes it, with the keys of the contract (#331). */
function dayState(box: Sandbox, over: Record<string, unknown> = {}): void {
  put(join(dayFolder(box), 'state.json'), {
    provider: 'claude',
    model: 'opus',
    cwd: 'C:\\Work',
    claude_config_dir: null,
    name: 'Ева',
    mode: 'agent',
    fork_session: DAY,
    ended_at: null,
    herdr_pane: PANE,
    ...over,
  })
}

/** The messages in the day's inbox, oldest first, as MokuPilot's watcher reads them. */
function inbox(box: Sandbox): { from: string; text: string; at: number }[] {
  const dir = join(dayFolder(box), 'inbox')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /^\d{16}-[0-9a-f]{8}\.json$/.test(f))
    .sort()
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { from: string; text: string; at: number })
}

async function board(
  box: Sandbox,
  cfg: Record<string, unknown> = {},
): Promise<{ url: string; items: Record<string, unknown>[] }> {
  const wake = await fakeWake({ sleeping: [] })
  const { url } = await serveBoard(box, { language: 'en', wakeUrl: wake.url, ...cfg })
  return { url, items: await itemsOf(url) }
}

async function itemsOf(url: string): Promise<Record<string, unknown>[]> {
  for (let tries = 0; ; tries++) {
    const b = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: Record<string, unknown>[] }
    if (!b.stale) return b.items
    if (tries > 200) throw new Error('the board did not refresh')
    await Bun.sleep(25)
  }
}

async function cli(box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<string> {
  const out = await box.run('cli', { args, env }).exited
  assert.equal(out.code, 0, out.stderr)
  return out.stdout.trim()
}

const post = (url: string, key: string, act: string, body: unknown) =>
  fetch(`${url}/api/session/${key}/${act}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

test('a MokuPilot day session: one card under its Claude name in its pane’s workspace; messages go to its inbox', async () => {
  const box = await sandbox()
  herdrState(box)
  registry(box, 'busy')
  dayState(box)
  const { url, items } = await board(box, { scheduleTickSec: 0.2 })

  // MokuPilot's pane is the day's card: by the session's id and Claude name, with no pane.
  expect(items.map(i => i.key).sort()).toEqual([DAY, OTHER].sort())
  const day = items.find(i => i.key === DAY)
  expect(day).toMatchObject({
    session: DAY,
    pane: null,
    name: 'work-a7',
    workspace: 'Моя работа 100%',
    agent: 'claude',
    status: 'working',
    sleeping: false,
    day: true,
  })
  expect(items.find(i => i.key === OTHER)).not.toHaveProperty('day')

  // A message from the sheet: into the inbox, from the user. herdr is not asked to type anything.
  const before = box.calls().length
  const res = await post(url, DAY, 'message', { session: DAY, text: 'Check the invoices, please' })
  expect([res.status, await res.json()]).toEqual([200, { ok: true }])
  expect(inbox(box)).toEqual([
    { from: 'the user, on the agent board', text: 'Check the invoices, please', at: expect.any(Number) },
  ])
  expect(
    box
      .calls()
      .slice(before)
      .filter(c => c[1] !== 'snapshot'),
  ).toEqual([])

  // Nothing of herdr's for it: its pane is MokuPilot's console.
  for (const act of ['sleep', 'restart', 'archive', 'focus', 'fork', 'mokupilot']) {
    const r = await post(url, DAY, act, {})
    expect([act, r.status, ((await r.json()) as { error?: string }).error]).toEqual([
      act,
      409,
      'The session has no pane',
    ])
  }

  // `board remind --session <its Claude name>` finds it; the scheduler puts the reminder in the inbox.
  await cli(box, ['remind', 'in', '1m', '--session', 'work-a7', 'Report the totals'])
  const dir = join(stateDir(box), 'schedule')
  const [file] = readdirSync(dir).filter(f => /^[0-9a-f]{6}\.json$/.test(f))
  assert.ok(file, 'no entry written')
  const entry = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
  expect(entry.key).toBe(DAY)
  writeFileSync(join(dir, file), JSON.stringify({ ...entry, next: Date.now() - 1000 }))
  for (let tries = 0; inbox(box).length < 2; tries++) {
    if (tries > 200) throw new Error('the reminder did not reach the inbox')
    await Bun.sleep(50)
  }
  expect(inbox(box)[1]).toEqual({ from: 'agent board', text: expect.any(String), at: expect.any(Number) })
  expect(inbox(box)[1]?.text).toStartWith('[board reminder')
  expect(inbox(box)[1]?.text).toEndWith('Report the totals')

  // Its own `board doing` (Claude Code's session id in its Bash tool) is on its card.
  await cli(box, ['doing', 'Разбираю почту'], { CLAUDE_CODE_SESSION_ID: DAY })
  expect((await board(box)).items.find(i => i.key === DAY)?.doing).toBe('Разбираю почту')
})

test('a day in another profile than the default one: its card says that profile, as its hooks would', async () => {
  const box = await sandbox()
  herdrState(box)
  registry(box, 'idle', '.claude-work 100%')
  put(join(home(box), '.claude', 'settings.json'), {})
  dayState(box, { claude_config_dir: join(home(box), '.claude-work 100%') })
  const { items } = await board(box)
  expect(items.find(i => i.key === DAY)).toMatchObject({ name: 'work-a7', profile: 'work-100', day: true })
})

test('a day with no herdr_pane: its own card, and MokuPilot’s pane keeps its card', async () => {
  const box = await sandbox()
  herdrState(box)
  registry(box)
  dayState(box, { herdr_pane: undefined })
  const { items } = await board(box)
  expect(items.map(i => i.key).sort()).toEqual([DAY, OTHER, `pane-${PANE}`].sort())
  expect(items.find(i => i.key === DAY)).toMatchObject({ pane: null, name: 'work-a7', status: 'idle', day: true })
  expect(items.find(i => i.key === `pane-${PANE}`)).toMatchObject({
    pane: PANE,
    name: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  })
})

test('no day card: an ended day, one whose session is not running, a day of pi, or "mokupilot": false', async () => {
  const cases: [string, (box: Sandbox) => void, Record<string, unknown>][] = [
    [
      'ended',
      box => {
        registry(box)
        dayState(box, { ended_at: 1793870263.9 })
      },
      {},
    ],
    ['not running', box => dayState(box), {}],
    [
      'pi',
      box => {
        registry(box)
        dayState(box, { provider: 'pi' })
      },
      {},
    ],
    [
      'off',
      box => {
        registry(box)
        dayState(box)
      },
      { mokupilot: false },
    ],
  ]
  for (const [what, setUp, cfg] of cases) {
    const box = await sandbox()
    herdrState(box)
    setUp(box)
    const { items } = await board(box, cfg)
    // The pane's card as it was before #331: keyed by its pane, named by its terminal title.
    expect([what, items.map(i => i.key).sort()]).toEqual([what, [OTHER, `pane-${PANE}`].sort()])
    expect(items.some(i => i.day)).toBe(false)
  }
})

test('`board list` without MokuPilot on the computer prints what it printed before', async () => {
  const box = await sandbox()
  herdrState(box)
  registry(box)
  const wake = await fakeWake({ sleeping: [] })
  put(join(configDir(box), 'config.json'), { language: 'en', wakeUrl: wake.url })
  const out = await cli(box, ['list'])
  expect(out).toContain('pwsh.exe')
  expect(out).not.toContain('work-a7')
})

test('threads (#379): a day session writes with --session as itself, and its event goes to its inbox', async () => {
  const box = await sandbox()
  herdrState(box)
  registry(box)
  dayState(box)
  const wake = await fakeWake({ sleeping: [] })
  // The command reads config.json itself: threads on, and the fake wake, never the live one.
  put(join(configDir(box), 'config.json'), { language: 'en', port: 9, wakeUrl: wake.url, threads: true })
  await serveBoard(box, { language: 'en', wakeUrl: wake.url, threads: true, scheduleTickSec: 0.2 })
  // MokuPilot passes the day session by its Claude name, as its MCP tools will (5.4).
  expect(await cli(box, ['thread', 'new', '--session', 'work-a7', '--lane', 'atlas', 'Collect the invoices'])).toBe(
    'ok · atlas-1 · next',
  )
  expect(
    await cli(box, ['thread', 'done', 'atlas-1', '12 invoices collected'], { CLAUDE_CODE_SESSION_ID: OTHER }),
  ).toBe('ok · atlas-1 · done')
  for (let tries = 0; inbox(box).length < 1; tries++) {
    if (tries > 200) throw new Error('the event did not reach the inbox')
    await Bun.sleep(50)
  }
  expect(inbox(box)).toEqual([
    {
      from: 'agent board',
      text: '[board reminder from threads] atlas-1 done: 12 invoices collected. More: board thread changes',
      at: expect.any(Number),
    },
  ])
  // Nothing typed into a pane: the day has none.
  expect(box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')).toEqual([])
})

test('threads (#393): a day session with no pane writes by its id, in the lane of its own folder; its event goes to its inbox', async () => {
  const box = await sandbox()
  herdrState(box)
  const work = join(box.dir, 'atlas')
  registry(box, 'idle', '.claude', work)
  dayState(box, { herdr_pane: undefined, cwd: work })
  const wake = await fakeWake({ sleeping: [] })
  const categories = [
    { id: 'atlas', title: 'Atlas', color: 'gray', paths: [work] },
    { id: 'inbox', title: 'Inbox', color: 'gray', paths: [box.dir] },
  ]
  put(join(configDir(box), 'config.json'), { language: 'en', port: 9, wakeUrl: wake.url, threads: true, categories })
  await serveBoard(box, { language: 'en', wakeUrl: wake.url, threads: true, categories, scheduleTickSec: 0.2 })
  // MokuPilot knows the day by its Claude session id; the command runs in MokuPilot's own folder.
  expect(await cli(box, ['thread', 'new', '--session', DAY, 'Collect the invoices'])).toBe('ok · atlas-1 · next')
  const made = JSON.parse(await cli(box, ['thread', 'show', 'atlas-1', '--json']))
  expect(made.thread.createdBy).toEqual({ kind: 'session', key: DAY, name: 'work-a7' })
  // Another session by its id goes as before: its lane is the command's folder (none here), not its card's.
  const other = await box.run('cli', { args: ['thread', 'new', '--session', OTHER, 'Not the day'], env: {} }).exited
  expect([other.code, other.stderr]).toEqual([1, expect.stringContaining('no lane')])
  expect(
    await cli(box, ['thread', 'done', 'atlas-1', '12 invoices collected'], { CLAUDE_CODE_SESSION_ID: OTHER }),
  ).toBe('ok · atlas-1 · done')
  for (let tries = 0; inbox(box).length < 1; tries++) {
    if (tries > 200) throw new Error('the event did not reach the inbox')
    await Bun.sleep(50)
  }
  expect(inbox(box).map(m => m.text)).toEqual([
    '[board reminder from threads] atlas-1 done: 12 invoices collected. More: board thread changes',
  ])
  expect(box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')).toEqual([])
})

test("threads (#393): a pi day's task board is in threads within a refresh, and a change of it follows", async () => {
  const box = await sandbox()
  herdrState(box)
  const PI = 'pi-session-0393'
  const work = join(box.dir, 'atlas')
  dayState(box, { provider: 'pi', fork_session: PI, herdr_pane: undefined, cwd: work })
  const tasks = join(home(box), '.agent-boards', 'pi', `${PI}.json`)
  const board = (items: Record<string, unknown>[]) =>
    put(tasks, { format: 'agent-board', version: 1, harness: 'pi', session_id: PI, writer: 'pi', items })
  const at = new Date().toISOString()
  const item = { owner: '', owner_id: '', created_at: at, started_at: null, done_at: null, updated_at: at }
  board([
    { ...item, id: 't1', text: 'Draft the import plan', status: 'doing', started_at: at },
    { ...item, id: 't2', text: 'Ask ben for the price list', status: 'next' },
  ])
  const wake = await fakeWake({ sleeping: [] })
  const categories = [{ id: 'atlas', title: 'Atlas', color: 'gray', paths: [work] }]
  const cfg = { language: 'en', wakeUrl: wake.url, threads: true, categories }
  put(join(configDir(box), 'config.json'), { ...cfg, port: 9 })
  const { url } = await serveBoard(box, { ...cfg, refreshSec: 1 })
  const rev = async (): Promise<number> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { threads?: { rev: number } }).threads?.rev ?? 0
  const until = async (ok: () => Promise<boolean>): Promise<void> => {
    for (let tries = 0; !(await ok()); tries++) {
      if (tries > 200) throw new Error('the board did not copy the task board')
      await Bun.sleep(50)
    }
  }
  await until(async () => (await rev()) > 0)
  const list = JSON.parse(await cli(box, ['thread', 'list', '--all', '--json'])) as {
    threads: { key: string; status: string; title: string; origin: unknown }[]
  }
  expect(list.threads.map(t => [t.key, t.status, t.title]).sort()).toEqual([
    ['atlas-1', 'doing', 'Draft the import plan'],
    ['atlas-2', 'next', 'Ask ben for the price list'],
  ])
  expect(list.threads[0]?.origin).toMatchObject({ agentBoard: { harness: 'pi', session: PI }, mirrored: true })
  const before = await rev()
  board([
    { ...item, id: 't1', text: 'Draft the import plan', status: 'done', started_at: at, done_at: at },
    { ...item, id: 't2', text: 'Ask ben for the price list', status: 'next' },
  ])
  await until(async () => (await rev()) > before)
  expect(JSON.parse(await cli(box, ['thread', 'show', 'atlas-1', '--json'])).thread.status).toBe('done')
  // On the board it is pi's: the owner's edit is refused with the reason.
  const out = await box.run('cli', { args: ['thread', 'post', 'atlas-2', '--status', 'doing'], env: {} }).exited
  expect(out.code).toBe(1)
  expect(out.stderr).toContain("pi's task board")
})
