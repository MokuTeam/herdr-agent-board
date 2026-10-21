// "Switch over…" and the takeover at wake's first start (#119, Migration): the separate herdr-wake
// plugin's config and sleeping list taken over before it is uninstalled, its hooks moved to the
// board's in every profile that has them (each settings.json backed up first, never a backup
// overwritten), its tg-router workspace closed when nothing but shells and sidebar panes is in it,
// wake turned on and started; what it did said, with the launcher note and the key bindings. The
// old plugin's config and state folders are left where they are. Folders with spaces, Cyrillic
// and %.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import { ROOT } from '../../src/adapters/paths.ts'
import { readWakeTakeover, wakeSessionsFile, wakeTakeoverFile } from '../../src/adapters/wake-files.ts'
import { quote } from '../../src/core/install-plan.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { boardFiles } from '../../src/core/setup.ts'
import { switchOver, takeOverAtFirstStart } from '../../src/services/wake/takeover.ts'
import { unusedPort } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { root, type Sandbox } from '../support/sandbox.ts'
import { endWithSandbox, wakeOnConfig, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const SIDS = [
  '0f8fad5b-d9cb-469f-a165-70867728950e',
  '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  '3b241101-e2bb-4255-8caf-4136c566a962',
  '9a2c5e8f-1b3d-4c6e-8f7a-2d4b6c8e0a1f',
  'c56a4180-65aa-42ec-a945-5fd21dec0538',
]
const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
/** A day ago: the old router saw these sessions before any takeover. */
const T0 = Date.now() - 86_400_000

/** What herdr-wake's install-hooks.mjs wrote: `node "<its config dir>/hook.mjs" <mode>`. */
const oldHook = (configDir: string, mode: string): string => `node "${join(configDir, 'hook.mjs')}" ${mode}`
/** Ours: `"<bun>" "<root>/src/entrypoints/wake-hook.ts" <mode>`. */
const ourHook = (mode: string): string => `${quote(process.execPath)} ${quote(boardFiles(ROOT).wakeHook)} ${mode}`
const BOARD_HOOK = '"C:/Program Files/bun.exe" "C:/agent-board/src/entrypoints/hook.ts"'

/** A settings.json the old plugin wrote into, beside the board's hook and one of the user's own. */
function settingsWithOld(oldConfigDir: string): Record<string, unknown> {
  return {
    model: 'opus',
    hooks: {
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: BOARD_HOOK, timeout: 10 }] },
        {
          matcher: 'SendMessage',
          hooks: [{ type: 'command', command: oldHook(oldConfigDir, 'pre-send'), timeout: 180 }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'ListAgents',
          hooks: [{ type: 'command', command: oldHook(oldConfigDir, 'post-list'), timeout: 10 }],
        },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: oldHook(oldConfigDir, 'session-start'), timeout: 10 }] },
        { hooks: [{ type: 'command', command: 'my-own-start.sh', timeout: 5 }] },
      ],
    },
  }
}

/** The same settings.json once the takeover moved its hooks: the old plugin's out, wake's in, the rest as it was. */
const settingsMoved = (): Record<string, unknown> => ({
  model: 'opus',
  hooks: {
    PreToolUse: [
      { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: BOARD_HOOK, timeout: 10 }] },
      { matcher: 'SendMessage', hooks: [{ type: 'command', command: ourHook('pre-send'), timeout: 180 }] },
    ],
    PostToolUse: [{ matcher: 'ListAgents', hooks: [{ type: 'command', command: ourHook('post-list'), timeout: 10 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-start.sh', timeout: 5 }] }],
  },
})

/** The old router's sessions.json: four asleep (one the user /exited), one awake. */
const oldSessions = (): Record<string, unknown> => ({
  'w1:p2': { session: SIDS[0], name: 'Billing chat', cwd: PROJECT, seen_at: T0, slept_at: T0 + 1000 },
  'w1:p3': { session: SIDS[1], name: 'Отчёт 100%', cwd: PROJECT, seen_at: T0, slept_at: T0 + 2000 },
  'w2:p1': { session: SIDS[2], name: 'docs', seen_at: T0, slept_at: T0 + 3000, exited: true },
  'w2:p4': { session: SIDS[3], name: 'ops', seen_at: T0, slept_at: T0 + 4000 },
  'w1:p1': { session: SIDS[4], name: 'Live', seen_at: T0 },
})

/** The old router's config.json, on a port nothing listens on here (never wake's own 12421). */
const OLD_CONFIG = {
  port: 23457,
  wakeCommand: 'claude-tg --resume {session}',
  workspace: 'tg-router',
  wakeTimeoutSec: 90,
  reaper: { enabled: true, idleMinutes: 60, exclude: ['Billing', '/^ops-/'], maxPerRound: 3 },
}
const CLAUDE_JSON = {
  mcpServers: { telegram: { url: 'http://127.0.0.1:8787/mcp', headers: { Authorization: 'Bearer secret' } } },
}
const HERDR_TOML = '[ui]\ntheme = "dark"\n\n[[keys.command]]\nkey = "ctrl+s"\ncommand = "herdr-wake.sleep"\n'

const writeJson = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}
const readJsonFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

/** A folder's files, each with its bytes, under it. */
function filesIn(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, name)
    if (statSync(path).isFile()) out[name] = readFileSync(path, 'utf8')
  }
  return out
}

interface World {
  home: string
  oldConfigDir: string
  oldStateDir: string
  /** Two profiles with the old plugin's hooks (the default one and `.claude-Работа 100%`), one without. */
  withOld: string[]
  other: string
}

/**
 * This computer as the old plugin left it: its config and sleeping list in its folders (under an
 * APPDATA, a LOCALAPPDATA and a home with spaces, Cyrillic and %), its hooks in two profiles, a
 * third profile without them, a herdr key bound to its sleep, tg-mcp in ~/.claude.json, and the
 * board's config.json with wake on.
 */
function world(o: { old?: boolean } = {}): World {
  const dir = isolatedHome()
  process.env.APPDATA = join(dir, 'Роуминг 100%')
  process.env.LOCALAPPDATA = join(dir, 'Local x 50%')
  const home = join(dir, 'Иван Петров 100%')
  process.env.HOME = home
  process.env.USERPROFILE = home
  const oldConfigDir = join(process.env.APPDATA, 'herdr', 'plugins', 'config', 'herdr-wake')
  const oldStateDir = join(process.env.LOCALAPPDATA, 'herdr', 'plugins', 'herdr-wake')
  const withOld = [join(home, '.claude'), join(home, '.claude-Работа 100%')]
  const other = join(home, '.claude-other')
  writeJson(configFile(), { language: 'en', wake: { enabled: true, port: 23456 } })
  writeJson(join(other, 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] } })
  if (o.old === false) {
    mkdirSync(withOld[0] as string, { recursive: true })
    writeJson(join(withOld[0] as string, 'settings.json'), { model: 'opus' })
    return { home, oldConfigDir, oldStateDir, withOld, other }
  }
  writeJson(join(oldConfigDir, 'config.json'), OLD_CONFIG)
  writeFileSync(join(oldConfigDir, 'hook.mjs'), '// herdr-wake\n')
  writeJson(join(oldStateDir, 'sessions.json'), oldSessions())
  writeFileSync(join(oldStateDir, 'router.log'), 'router up\n')
  for (const p of withOld) writeJson(join(p, 'settings.json'), settingsWithOld(oldConfigDir))
  writeJson(join(home, '.claude.json'), CLAUDE_JSON)
  writeJson(join(process.env.APPDATA, 'herdr', 'config.toml'), HERDR_TOML)
  return { home, oldConfigDir, oldStateDir, withOld, other }
}

interface Snap {
  workspaces: { workspace_id: string; label: string }[]
  tabs: { tab_id: string; workspace_id: string }[]
  panes: Record<string, unknown>[]
}

/** herdr with the old router's tg-router workspace (its pane, now a shell, and herdr-sidebar's), and `extra` panes in it. */
const tgRouter = (extra: Record<string, unknown>[] = []): Snap => ({
  workspaces: [
    { workspace_id: 'wT', label: 'tg-router' },
    { workspace_id: 'w1', label: 'Main' },
  ],
  tabs: [
    { tab_id: 'tT', workspace_id: 'wT' },
    { tab_id: 't1', workspace_id: 'w1' },
  ],
  panes: [
    { pane_id: 'wT:p1', tab_id: 'tT', workspace_id: 'wT', cwd: 'C:\\herdr-wake' },
    { pane_id: 'wT:p2', tab_id: 'tT', workspace_id: 'wT', tokens: { 'herdr-sidebar-git': '1' } },
    { pane_id: 'w1:p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' },
    ...extra,
  ],
})

/** An in-memory herdr: herdr-wake installed until it is uninstalled; each call on the timeline. */
function fakeHerdr(o: { installed?: boolean; snap?: Snap; uninstall?: 'fails'; timeline?: string[] } = {}) {
  let installed = o.installed ?? true
  const snap = o.snap ?? tgRouter()
  const calls: string[][] = []
  const herdr = async <T = unknown>(args: string[]): Promise<T> => {
    calls.push(args)
    const said = args.join(' ')
    o.timeline?.push(said)
    const answer = (v: unknown): T => v as T
    if (said === 'plugin list --json')
      return answer({ plugins: [{ plugin_id: 'agent-board' }, ...(installed ? [{ plugin_id: 'herdr-wake' }] : [])] })
    if (said === 'plugin uninstall herdr-wake') {
      if (o.uninstall === 'fails') throw new Error('herdr: the plugin is busy')
      installed = false
      return answer(null)
    }
    if (said === 'api snapshot') return answer({ snapshot: structuredClone(snap) })
    if (args[0] === 'workspace' && args[1] === 'close') return answer(null)
    throw new Error(`unexpected herdr ${said}`)
  }
  return { herdr, calls }
}

const hasOldHook = (dir: string): boolean => readFileSync(join(dir, 'settings.json'), 'utf8').includes('herdr-wake')
const boardConfig = (): Record<string, unknown> => readJsonFile(configFile()) as Record<string, unknown>

test('Switch over takes over the config and the sleeping list before uninstalling, then hooks, tg-router, start, in that order', async () => {
  const w = world()
  const timeline: string[] = []
  /** What was there each time herdr was asked (and when wake was started). */
  const seen: Record<string, unknown>[] = []
  const look = (step: string): void => {
    seen.push({
      step,
      config: (boardConfig().wake as Record<string, unknown>).reaper !== undefined,
      sessions: existsSync(wakeSessionsFile()),
      hooksMoved: w.withOld.map(p => !hasOldHook(p)),
      marker: existsSync(wakeTakeoverFile()),
    })
  }
  const { herdr } = fakeHerdr({ timeline })
  const out = await switchOver({
    uninstall: true,
    herdr: async <T>(args: string[]) => {
      look(args.join(' '))
      return herdr<T>(args)
    },
    home: w.home,
    env: process.env,
    log: () => {},
    oldRouter: async () => null,
    start: () => {
      timeline.push('start')
      look('start')
      return { ok: true }
    },
  })
  expect(out.ok).toBe(true)
  expect(timeline).toEqual([
    'plugin list --json',
    'plugin uninstall herdr-wake',
    'plugin list --json',
    'api snapshot',
    'workspace close wT',
    'start',
  ])
  expect(seen).toEqual([
    { step: 'plugin list --json', config: true, sessions: true, hooksMoved: [false, false], marker: false },
    { step: 'plugin uninstall herdr-wake', config: true, sessions: true, hooksMoved: [false, false], marker: false },
    { step: 'plugin list --json', config: true, sessions: true, hooksMoved: [false, false], marker: false },
    { step: 'api snapshot', config: true, sessions: true, hooksMoved: [true, true], marker: false },
    { step: 'workspace close wT', config: true, sessions: true, hooksMoved: [true, true], marker: false },
    // The marker is down before the start, so the start it makes takes nothing over again.
    { step: 'start', config: true, sessions: true, hooksMoved: [true, true], marker: true },
  ])
  if (!out.ok) return
  expect(out.did.map(line => line.split(':')[0])).toEqual([
    'copied',
    'config',
    'sleeping sessions',
    'launcher',
    'herdr-wake',
    'hooks',
    'hooks',
    'tg-router',
    'wake',
    'key binding',
  ])
  // The marker: when, and what it did.
  const marker = readWakeTakeover()
  expect(marker?.did).toEqual(out.did)
  expect(typeof marker?.at).toBe('number')
})

test('what it did is said, with the launcher note and the bindings', async () => {
  const w = world()
  const before = w.withOld.map(p => readFileSync(join(p, 'settings.json'), 'utf8'))
  const otherBefore = readFileSync(join(w.other, 'settings.json'), 'utf8')
  const { herdr } = fakeHerdr()
  const out = await switchOver({
    uninstall: true,
    herdr,
    home: w.home,
    env: process.env,
    log: () => {},
    oldRouter: async () => null,
    start: () => ({ ok: true }),
  })
  expect(out).toMatchObject({
    ok: true,
    summary: { reaper: 'on', minutes: 60, excluded: 2, telegram: true, asleep: 4 },
    launcher: { old: 'claude-tg', now: 'claude' },
    bindings: [{ key: 'ctrl+s', old: 'herdr-wake.sleep', now: 'agent-board.sleep' }],
  })
  // The wake section: the old config's, Telegram on Auto (tg-mcp was in ~/.claude.json), tg-router
  // not carried, the switch and the board's port as they were.
  expect(boardConfig()).toEqual({
    language: 'en',
    wake: {
      enabled: true,
      port: 23457,
      wakeTimeoutSec: 90,
      reaper: { enabled: true, idleMinutes: 60, exclude: ['Billing', '/^ops-/'], maxPerRound: 3 },
      telegram: 'auto',
    },
  })
  // Every session the old router knew, in the default profile.
  const sessions = readJsonFile(wakeSessionsFile()) as Record<string, Record<string, unknown>>
  expect(Object.keys(sessions).sort()).toEqual(['w1:p1', 'w1:p2', 'w1:p3', 'w2:p1', 'w2:p4'])
  for (const entry of Object.values(sessions)) expect(entry.profileDir).toBe(join(w.home, '.claude'))
  expect(sessions['w1:p3']).toMatchObject({ session: SIDS[1], name: 'Отчёт 100%', cwd: PROJECT, slept_at: T0 + 2000 })
  // Each profile with the old hooks: backed up as it was, then the old hooks out and wake's in.
  w.withOld.forEach((p, i) => {
    expect(readJsonFile(join(p, 'settings.json'))).toEqual(settingsMoved())
    expect(readFileSync(join(p, 'settings.json.bak-wake-takeover'), 'utf8')).toBe(before[i] as string)
  })
  // The profile without them: not touched, no backup.
  expect(readFileSync(join(w.other, 'settings.json'), 'utf8')).toBe(otherBefore)
  expect(readdirSync(w.other)).toEqual(['settings.json'])
  // Said in the log's words.
  if (!out.ok) return
  expect(out.did).toContain('launcher: herdr-wake woke sessions with claude-tg; the board starts them with claude')
  expect(out.did).toContain('key binding: ctrl+s herdr-wake.sleep → agent-board.sleep')
  expect(out.did.some(line => line.includes('secret'))).toBe(false)
})

test('uninstalled by hand: the takeover runs once at the first start, without the uninstall; the marker stops a second', async () => {
  const box = await wakeSandbox()
  const home = box.env.HOME as string
  const oldConfigDir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'herdr-wake')
  const oldStateDir = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'herdr-wake')
  const port = await unusedPort()
  writeJson(join(oldConfigDir, 'config.json'), { ...OLD_CONFIG, port })
  writeJson(join(oldStateDir, 'sessions.json'), oldSessions())
  writeJson(join(home, '.claude', 'settings.json'), settingsWithOld(oldConfigDir))
  writeBoardConfig(box, wakeOnConfig(port))
  box.state({
    'plugin list': { result: { type: 'plugin_list', plugins: [{ plugin_id: 'agent-board' }] } },
    'api snapshot': { result: { snapshot: tgRouter() } },
    'workspace create': { result: { workspace: { workspace_id: 'wW', label: 'Wake' }, tab: { tab_id: 'tW0' } } },
    'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'wW:p1' } } } },
    'tab close': { result: null },
    'workspace close': { result: null },
  })
  const first = await runStart(box)
  expect(first).toEqual({ code: 0, stdout: "wake's start: opened\n" })
  const calls = box.calls()
  expect(calls.some(c => c[0] === 'plugin' && c[1] === 'uninstall')).toBe(false)
  expect(calls).toContainEqual(['workspace', 'close', 'wT'])
  const boardFile = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  const stateDir = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  const wake = (readJsonFile(boardFile) as { wake: Record<string, unknown> }).wake
  expect(wake).toEqual({
    enabled: true,
    port,
    wakeTimeoutSec: 90,
    reaper: { enabled: true, idleMinutes: 60, exclude: ['Billing', '/^ops-/'], maxPerRound: 3 },
  })
  expect(Object.keys(readJsonFile(join(stateDir, 'wake-sessions.json')) as object)).toHaveLength(5)
  expect(readJsonFile(join(home, '.claude', 'settings.json'))).toEqual(settingsMoved())
  const marker = readFileSync(join(stateDir, 'wake-takeover.json'), 'utf8')
  expect(readFileSync(join(stateDir, 'wake.log'), 'utf8')).toContain(
    'takeover: herdr-wake: not installed (removed by hand)',
  )

  // The second start: nothing taken over again, even from an old config.json changed since.
  writeJson(join(oldConfigDir, 'config.json'), { ...OLD_CONFIG, port, reaper: { enabled: false } })
  const config = readFileSync(boardFile, 'utf8')
  const seen = box.calls().length
  expect((await runStart(box)).code).toBe(0)
  const again = box.calls().slice(seen)
  expect(again.some(c => c[0] === 'workspace' && c[1] === 'close')).toBe(false)
  expect(readFileSync(boardFile, 'utf8')).toBe(config)
  expect(readFileSync(join(stateDir, 'wake-takeover.json'), 'utf8')).toBe(marker)
})

test('nothing of the old plugin here: the first start takes nothing over and asks herdr nothing more', async () => {
  const box = await wakeSandbox()
  writeBoardConfig(box, wakeOnConfig(await unusedPort()))
  const config = readFileSync(
    join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json'),
    'utf8',
  )
  box.state({
    'plugin list': { result: { type: 'plugin_list', plugins: [{ plugin_id: 'agent-board' }] } },
    'api snapshot': { result: { snapshot: tgRouter() } },
    'workspace create': { result: { workspace: { workspace_id: 'wW', label: 'Wake' }, tab: { tab_id: 'tW0' } } },
    'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'wW:p1' } } } },
    'tab close': { result: null },
  })
  expect((await runStart(box)).code).toBe(0)
  // The start's own calls, as before there was a takeover.
  expect(box.calls().map(c => c.slice(0, 2).join(' '))).toEqual([
    'plugin list',
    'api snapshot',
    'workspace create',
    'plugin pane',
    'tab close',
  ])
  const stateDir = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  expect(existsSync(join(stateDir, 'wake-takeover.json'))).toBe(false)
  expect(existsSync(join(stateDir, 'wake-sessions.json'))).toBe(false)
  expect(
    readFileSync(join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json'), 'utf8'),
  ).toBe(config)

  // And in the service: no herdr call, no file.
  const w = world({ old: false })
  const settings = readFileSync(join(w.withOld[0] as string, 'settings.json'), 'utf8')
  const { herdr, calls } = fakeHerdr()
  expect(await takeOverAtFirstStart({ herdr, home: w.home, env: process.env, log: () => {} })).toBeNull()
  expect(calls).toEqual([])
  expect(existsSync(wakeTakeoverFile())).toBe(false)
  expect(readFileSync(join(w.withOld[0] as string, 'settings.json'), 'utf8')).toBe(settings)
  expect(boardConfig()).toEqual({ language: 'en', wake: { enabled: true, port: 23456 } })
})

test('a tg-router workspace with an agent in it is left open', async () => {
  for (const extra of [
    { pane_id: 'wT:p3', tab_id: 'tT', workspace_id: 'wT', agent: 'claude', agent_status: 'working', cwd: PROJECT },
    // The board's own pane (board.json's) is never closed with it either.
    { pane_id: 'wT:p9', tab_id: 'tT', workspace_id: 'wT', cwd: ROOT },
  ]) {
    const w = world()
    if (extra.pane_id === 'wT:p9') {
      const boardJson = join(process.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'board.json')
      writeJson(boardJson, { pane: 'wT:p9', pid: process.pid })
    }
    const { herdr, calls } = fakeHerdr({ snap: tgRouter([extra]) })
    const out = await switchOver({ uninstall: true, herdr, home: w.home, env: process.env, log: () => {} })
    expect(out.ok).toBe(true)
    expect(calls.some(c => c[0] === 'workspace' && c[1] === 'close')).toBe(false)
    if (out.ok) expect(out.did).toContain('tg-router: left open, something else is in it')
  }
})

test('the old config and state folders are left where they are', async () => {
  const w = world()
  const oldConfig = filesIn(w.oldConfigDir)
  const oldState = filesIn(w.oldStateDir)
  const { herdr } = fakeHerdr()
  const out = await switchOver({ uninstall: true, herdr, home: w.home, env: process.env, log: () => {} })
  expect(out.ok).toBe(true)
  expect(filesIn(w.oldConfigDir)).toEqual(oldConfig)
  expect(filesIn(w.oldStateDir)).toEqual(oldState)
  // And copied into the board's state folder first, in case herdr's uninstall takes them.
  const copies = join(process.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  const folder = readdirSync(copies).find(name => name.startsWith('herdr-wake-takeover-'))
  expect(folder).toBeDefined()
  expect(filesIn(join(copies, folder as string))).toEqual({
    'config.json': oldConfig['config.json'] as string,
    'sessions.json': oldState['sessions.json'] as string,
  })
})

test('Switch over twice: nothing lost, nothing twice, no backup written over', async () => {
  const w = world()
  const before = readFileSync(join(w.withOld[0] as string, 'settings.json'), 'utf8')
  const first = fakeHerdr()
  expect(
    (await switchOver({ uninstall: true, herdr: first.herdr, home: w.home, env: process.env, log: () => {} })).ok,
  ).toBe(true)
  const settings = w.withOld.map(p => readFileSync(join(p, 'settings.json'), 'utf8'))
  const sessions = readFileSync(wakeSessionsFile(), 'utf8')
  // The old plugin is gone now (L9: not installed counts as done for the uninstall).
  const second = fakeHerdr({ installed: false, snap: { workspaces: [], tabs: [], panes: [] } })
  const out = await switchOver({ uninstall: true, herdr: second.herdr, home: w.home, env: process.env, log: () => {} })
  expect(out.ok).toBe(true)
  expect(second.calls).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
  ])
  expect(w.withOld.map(p => readFileSync(join(p, 'settings.json'), 'utf8'))).toEqual(settings)
  expect(readFileSync(join(w.withOld[0] as string, 'settings.json.bak-wake-takeover'), 'utf8')).toBe(before)
  expect(readdirSync(w.withOld[0] as string).sort()).toEqual(['settings.json', 'settings.json.bak-wake-takeover'])
  expect(readFileSync(wakeSessionsFile(), 'utf8')).toBe(sessions)
  if (out.ok) expect(out.did).toContain('herdr-wake: not installed (removed by hand)')

  // The old plugin's hooks back (it was installed again), and the profile changed since: a new
  // backup beside the first one, which stays as it was.
  const changed = { ...settingsWithOld(w.oldConfigDir), model: 'sonnet' }
  writeJson(join(w.withOld[0] as string, 'settings.json'), changed)
  const third = fakeHerdr({ installed: false, snap: { workspaces: [], tabs: [], panes: [] } })
  expect(
    (await switchOver({ uninstall: true, herdr: third.herdr, home: w.home, env: process.env, log: () => {} })).ok,
  ).toBe(true)
  expect(readFileSync(join(w.withOld[0] as string, 'settings.json.bak-wake-takeover'), 'utf8')).toBe(before)
  expect(readJsonFile(join(w.withOld[0] as string, 'settings.json.bak-wake-takeover-1'))).toEqual(changed)
  expect(readJsonFile(join(w.withOld[0] as string, 'settings.json'))).toEqual({ ...settingsMoved(), model: 'sonnet' })
})

test('the uninstall fails: nothing after it is done, and it is said', async () => {
  const w = world()
  const settings = w.withOld.map(p => readFileSync(join(p, 'settings.json'), 'utf8'))
  const { herdr, calls } = fakeHerdr({ uninstall: 'fails' })
  let started = 0
  const out = await switchOver({
    uninstall: true,
    herdr,
    home: w.home,
    env: process.env,
    log: () => {},
    start: () => {
      started++
      return { ok: true }
    },
  })
  expect(out).toEqual({
    ok: false,
    error: 'Switch over stopped: herdr plugin uninstall herdr-wake: herdr: the plugin is busy',
  })
  expect(calls.map(c => c.join(' '))).toEqual([
    'plugin list --json',
    'plugin uninstall herdr-wake',
    'plugin list --json',
  ])
  expect(w.withOld.map(p => readFileSync(join(p, 'settings.json'), 'utf8'))).toEqual(settings)
  expect([existsSync(wakeTakeoverFile()), started]).toEqual([false, 0])
})

test('a board config.json that does not parse: nothing is taken over, nothing written', async () => {
  const w = world()
  writeFileSync(configFile(), '{ "wake": { "enabled": tr')
  const { herdr, calls } = fakeHerdr()
  const out = await switchOver({ uninstall: true, herdr, home: w.home, env: process.env, log: () => {} })
  expect(out.ok).toBe(false)
  expect(calls).toEqual([])
  expect(readFileSync(configFile(), 'utf8')).toBe('{ "wake": { "enabled": tr')
  expect(existsSync(wakeSessionsFile())).toBe(false)
  expect(w.withOld.every(hasOldHook)).toBe(true)
})

/** wake-start.ts run to its end in the sandbox: its exit code and what it printed. */
async function runStart(box: Sandbox): Promise<{ code: number | null; stdout: string }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'wake-start.ts')], {
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

test('the old router still answers on the port after the uninstall: waited for, then wake is not started, and it is said', async () => {
  const w = world()
  let started = 0
  const probed: number[] = []
  const start = () => {
    started++
    return { ok: true as const }
  }
  // Still there after every look (its pane was left open, say).
  const stays = await switchOver({
    uninstall: true,
    herdr: fakeHerdr().herdr,
    home: w.home,
    env: process.env,
    log: () => {},
    start,
    oldRouter: async port => {
      probed.push(port)
      return 4242
    },
    sleep: async () => {},
  })
  expect(stays).toEqual({
    ok: false,
    error:
      'The herdr-wake plugin’s router still answers on port 23457 (process 4242): close its pane, then Switch over… again',
  })
  expect(started).toBe(0)
  expect(existsSync(wakeTakeoverFile())).toBe(false)
  expect(new Set(probed)).toEqual(new Set([23457]))
  expect(probed.length).toBeGreaterThan(1)

  // Gone a moment after its workspace closed: wake is started.
  let looks = 0
  const goes = await switchOver({
    uninstall: true,
    herdr: fakeHerdr({ installed: false }).herdr,
    home: w.home,
    env: process.env,
    log: () => {},
    start,
    oldRouter: async () => (++looks < 3 ? 4242 : null),
    sleep: async () => {},
  })
  expect(goes.ok).toBe(true)
  expect([started, looks]).toEqual([1, 3])
  expect(existsSync(wakeTakeoverFile())).toBe(true)
})
