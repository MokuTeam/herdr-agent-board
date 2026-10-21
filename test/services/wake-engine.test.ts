// The wake engine (src/services/wake/engine.ts) against the in-memory fake herdr, a fake clock and
// a temp home with a Default (.claude) and a Work (.claude-work) profile: a session running in any
// profile's registry is put to sleep and woken in its own profile (#150, #151) through
// `board resume <id> --profile <id>`, never one it could not wake, and nothing but a Claude session.
import { expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { readConfigFile } from '../../src/adapters/config-file.ts'
import { createProfileHomes, type ProfileHomes } from '../../src/adapters/profile-homes.ts'
import { findProfileDirs } from '../../src/adapters/profiles.ts'
import { scheduledJobs } from '../../src/adapters/wake-transcripts.ts'
import { mergeProfiles, type ProfileSet, profileSet } from '../../src/core/profiles.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import { wakeConfig } from '../../src/core/wake/config.ts'
import { CANNOT_WAKE } from '../../src/core/wake/rules.ts'
import type { WakeSessions } from '../../src/core/wake/sessions.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'
import { profilesConfig, runningSession, SID, SID2 } from '../support/wake-fixtures.ts'

/** The home and folders the tests run with, as this file loads: every test gives them back. */
const outside = () => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  homedir: homedir(),
})
const OUTSIDE = outside()

const SID3 = '1b2c3d4e-5f60-4718-8a9b-c0d1e2f3a4b5'
const SID4 = '2c3d4e5f-6071-4829-9bac-d1e2f3a4b5c6'
/** A project folder with spaces, Cyrillic and %. */
const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
const HOUR = 3_600_000

// Claude Code's input box as `herdr agent read --ansi` captures it, with nothing typed in it.
const RULE = `\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const EMPTY_BOX = ['● done', '', RULE, `❯ \x1b[2mTry "fix the tests"\x1b[0m`, RULE, '  ⏵⏵ bypass permissions on'].join(
  '\n',
)

interface Folders {
  home: string
  claude: string
  work: string
}

/**
 * A temp home with a Default and a Work profile folder, a fake herdr with these panes (each with an
 * empty input box), the session file, wake on with the reaper off unless `reaper` says otherwise,
 * and a clock that moves on at once by what is slept. The profiles are the board's own (Default)
 * and the folders found, unless `profiles` gives them.
 */
function world(
  o: {
    panes?: FakePane[]
    shells?: Record<string, string>
    sessions?: (f: Folders) => WakeSessions | string
    profiles?: (f: Folders) => ProfileSet
    boardOnPath?: boolean
    reaper?: Record<string, unknown>
  } = {},
) {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const folders: Folders = { home, claude: join(home, '.claude'), work: join(home, '.claude-work') }
  for (const folder of [folders.claude, folders.work]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'settings.json'), '{}')
  }
  const file = join(dir, 'state', 'wake-sessions.json')
  const sessions = o.sessions?.(folders)
  if (sessions !== undefined) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof sessions === 'string' ? sessions : JSON.stringify(sessions))
  }
  const panes = o.panes ?? []
  const io = fakeWakeHerdr({
    panes,
    workspaces: [{ workspace_id: 'w1', label: 'Main' }],
    shells: o.shells ?? {},
    inputBoxes: Object.fromEntries(panes.map(p => [p.pane_id, EMPTY_BOX])),
  })
  const set =
    o.profiles?.(folders) ??
    profileSet(mergeProfiles(undefined, findProfileDirs(home), home, folders.claude).list, folders.claude)
  const settings = wakeConfig({ enabled: true, reaper: { enabled: false, ...o.reaper } })
  const clock = { at: Date.now() }
  const log: string[] = []
  const deps: WakeEngineDeps = {
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => set,
    settings: () => settings,
    sessionsFile: file,
    boardOnPath: () => o.boardOnPath ?? true,
    scheduled: path => scheduledJobs(path, clock.at),
    log: text => {
      log.push(text)
    },
    now: () => clock.at,
    sleep: ms => {
      clock.at += ms
      return Promise.resolve()
    },
  }
  return { ...folders, dir, file, io, set, settings, log, clock, deps }
}

const claudePane = (pane: string, session: string, status = 'idle'): FakePane => ({
  pane_id: pane,
  tab_id: 't1',
  workspace_id: 'w1',
  cwd: PROJECT,
  agent: 'claude',
  agent_status: status,
  agent_session: { value: session },
})
const shellPane = (pane: string): FakePane => ({ pane_id: pane, tab_id: 't1', workspace_id: 'w1', cwd: PROJECT })

const is =
  (...words: string[]) =>
  (argv: string[]) =>
    words.every((w, i) => argv[i] === w)

/** Claude leaves the pane on /exit, and its registry entry (`registry`) goes with it. */
function exitsOnPrompt(io: FakeWakeHerdr, pane: FakePane, registry: string): void {
  io.on(is('agent', 'prompt', pane.pane_id, '/exit'), () => {
    pane.agent = null
    pane.agent_session = null
    delete pane.agent_status
    io.busy.delete(pane.pane_id)
    rmSync(registry, { force: true })
  })
}

/** Claude comes up idle in the pane once the wake line runs there, registered in `dir`. */
function startsOnRun(io: FakeWakeHerdr, pane: FakePane, dir: string, s: { id: string; name: string; n: number }) {
  io.on(is('pane', 'run', pane.pane_id), () => {
    pane.agent = 'claude'
    pane.agent_status = 'idle'
    pane.agent_session = { value: s.id }
    io.busy.add(pane.pane_id)
    runningSession(dir, { ...s, cwd: PROJECT })
  })
}

const readSessions = (file: string): WakeSessions => JSON.parse(readFileSync(file, 'utf8'))
/** What was typed or pressed in a pane. */
const typed = (io: FakeWakeHerdr): string[][] =>
  io.calls.filter(c => (c[0] === 'pane' && ['run', 'send-keys', 'send-text'].includes(c[1] ?? '')) || c[1] === 'prompt')
/** The panes /exit was typed into, in order. */
const exits = (io: FakeWakeHerdr): string[] =>
  io.calls.filter(c => c[0] === 'agent' && c[1] === 'prompt' && c[3] === '/exit').map(c => c[2] ?? '')

test('#150: a Work session is put to sleep, its registry read in Work’s folder', async () => {
  const pane = claudePane('w1:p1', SID)
  const w = world({ panes: [pane] })
  runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  exitsOnPrompt(w.io, pane, join(w.work, 'sessions', '1.json'))
  const engine = createWakeEngine(w.deps)

  expect(await engine.sleep(SID)).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  const entry = readSessions(w.file)['w1:p1']
  expect(entry).toMatchObject({ session: SID, name: 'Billing', cwd: PROJECT, profileDir: w.work, profile: 'work' })
  expect(entry?.slept_at).toBeNumber()
  expect(w.io.calls.at(-1)).toEqual(['pane', 'send-text', 'w1:p1', `board resume ${SID} --profile work`])
  expect(pane.label).toBe('💤 Billing')
  expect(await engine.sleeping()).toMatchObject([
    { name: 'Billing', pane: 'w1:p1', session: SID, workspace: 'Main', profile: { dir: w.work, id: 'work' } },
  ])
})

test('#151: a sleeping Work session wakes through board resume --profile work, wherever the shell’s profile points', async () => {
  const pane = shellPane('w1:p1')
  const at = Date.now() - HOUR
  const w = world({
    panes: [pane],
    shells: { 'w1:p1': 'pwsh.exe' },
    sessions: f => ({
      'w1:p1': { session: SID, name: 'Billing', seen_at: at, slept_at: at, profileDir: f.work, profile: 'work' },
    }),
  })
  // The board's own profile is Default: only the typed line names Work, so whatever profile the
  // pane's shell would fall back to, Work is the one the session comes back in.
  expect(w.set.inheritedDir).toBe(w.claude)
  startsOnRun(w.io, pane, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.wake('Billing')).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  expect(typed(w.io)).toEqual([
    ['pane', 'send-keys', 'w1:p1', 'esc'],
    ['pane', 'run', 'w1:p1', `board resume ${SID} --profile work`],
  ])
  expect(readSessions(w.file)['w1:p1']).not.toHaveProperty('slept_at')
  expect(w.io.calls).toContainEqual(['pane', 'rename', 'w1:p1', '--clear'])
  expect(w.log).toContain(`woke Billing in w1:p1 on request`)
  expect(await engine.wake('Billing')).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing', already: true })
  expect(await engine.wake('nobody')).toEqual({ ok: false, error: 'no session named nobody in herdr' })
})

test('the Telegram router’s wake: the pane’s known session, in its profile; a pane without one is refused', async () => {
  const pane = shellPane('w1:p1')
  const at = Date.now() - HOUR
  const w = world({
    panes: [pane, shellPane('w1:p2')],
    shells: { 'w1:p1': 'bash' },
    sessions: f => ({
      'w1:p1': { session: SID, name: 'Billing', seen_at: at, slept_at: at, profileDir: f.work, profile: 'work' },
    }),
  })
  startsOnRun(w.io, pane, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.wakePane('w1:p1')).toEqual({ ok: true })
  expect(typed(w.io)).toEqual([
    ['pane', 'send-keys', 'w1:p1', 'ctrl+u'],
    ['pane', 'run', 'w1:p1', `board resume ${SID} --profile work`],
  ])
  expect(readSessions(w.file)['w1:p1']).not.toHaveProperty('slept_at')
  expect(await engine.wakePane('w1:p2')).toMatchObject({ ok: false, why: 'line' })
  expect(typed(w.io)).toHaveLength(2)
})

// The old plugin read only ~/.claude: its sleepers are the default folder's, and wake in the
// default profile even without a card, wherever the pane's shell's profile points (#151).
test.each([
  ['wakes in the default profile: --profile with the default folder’s listed id', undefined, ' --profile default'],
  [
    'whose default folder’s listed id is not a plain word wakes without --profile',
    (f: Folders): ProfileSet =>
      profileSet(
        mergeProfiles([{ id: 'личный', dir: f.claude }], findProfileDirs(f.home), f.home, f.claude).list,
        f.claude,
      ),
    '',
  ],
])('a sleeper without a profile (the old plugin’s) %s', async (_, profiles, flag) => {
  const pane = shellPane('w1:p1')
  const at = Date.now() - HOUR
  const w = world({
    panes: [pane],
    sessions: () => ({ 'w1:p1': { session: SID, name: 'Old', seen_at: at, slept_at: at } }),
    ...(profiles && { profiles }),
  })
  startsOnRun(w.io, pane, w.claude, { id: SID, name: 'Old', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.wake('Old')).toEqual({ ok: true, pane: 'w1:p1', name: 'Old' })
  expect(w.io.calls.filter(c => c[1] === 'run')).toEqual([['pane', 'run', 'w1:p1', `board resume ${SID}${flag}`]])
})

test('a profile folder with spaces, Cyrillic and %: the line carries its id only', async () => {
  const pane = claudePane('w1:p1', SID)
  const w = world({
    panes: [pane],
    profiles: f => {
      profilesConfig(String(process.env.APPDATA), [{ id: 'ivan', title: 'Иван', dir: join(f.home, 'Профиль 100%') }])
      return profileSet(
        mergeProfiles(readConfigFile()?.profiles, findProfileDirs(f.home), f.home, f.claude).list,
        f.claude,
      )
    },
  })
  const ivan = join(w.home, 'Профиль 100%')
  runningSession(ivan, { id: SID, name: 'Счёт 50%', cwd: PROJECT, n: 1 })
  exitsOnPrompt(w.io, pane, join(ivan, 'sessions', '1.json'))
  startsOnRun(w.io, pane, ivan, { id: SID, name: 'Счёт 50%', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.sleep('Счёт 50%')).toEqual({ ok: true, pane: 'w1:p1', name: 'Счёт 50%' })
  expect(readSessions(w.file)['w1:p1']).toMatchObject({ profileDir: ivan, profile: 'ivan' })
  expect(await engine.wake('Счёт 50%')).toEqual({ ok: true, pane: 'w1:p1', name: 'Счёт 50%' })
  const line = `board resume ${SID} --profile ivan`
  expect(w.io.calls.filter(c => c[1] === 'send-text' || c[1] === 'run')).toEqual([
    ['pane', 'send-text', 'w1:p1', line],
    ['pane', 'run', 'w1:p1', line],
  ])
})

test('a folder no listed profile has: board resume without --profile', async () => {
  const pane = claudePane('w1:p1', SID)
  const w = world({
    panes: [pane],
    profiles: f => ({
      list: mergeProfiles(undefined, findProfileDirs(f.home), f.home).list,
      inheritedDir: join(f.home, 'elsewhere'),
      inherited: null,
    }),
  })
  const elsewhere = join(w.home, 'elsewhere')
  runningSession(elsewhere, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  exitsOnPrompt(w.io, pane, join(elsewhere, 'sessions', '1.json'))
  startsOnRun(w.io, pane, elsewhere, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.sleep(SID)).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  const entry = readSessions(w.file)['w1:p1']
  expect(entry?.profileDir).toBe(elsewhere)
  expect(entry).not.toHaveProperty('profile')
  expect(w.io.calls.at(-1)).toEqual(['pane', 'send-text', 'w1:p1', `board resume ${SID}`])
  expect(await engine.wake(SID)).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  expect(w.io.calls).toContainEqual(['pane', 'run', 'w1:p1', `board resume ${SID}`])
})

/** Profile homes whose transcript lookup throws, as a stat Windows refuses (EPERM) does. */
function unreadableTranscripts(homes: ProfileHomes): ProfileHomes {
  const refuse = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted, stat'), { code: 'EPERM' })
  }
  return {
    ...homes,
    liveSessions: dirs =>
      new Map(
        [...homes.liveSessions(dirs)].map(([id, hit]) => [
          id,
          { ...hit, home: { ...hit.home, transcriptPath: refuse } },
        ]),
      ),
  }
}

// One world (one temp home) per test: each test's cleanup gives back the home it found.
test.each([
  [
    'no board on PATH',
    CANNOT_WAKE.board,
    () => {
      const w = world({ panes: [claudePane('w1:p1', SID)], boardOnPath: false })
      runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT })
      return w
    },
  ],
  [
    'an unknown profile folder',
    CANNOT_WAKE.profile,
    () => {
      // The board's own profile named relative to wherever it runs: no profile's folder.
      const w = world({
        panes: [claudePane('w1:p1', SID)],
        profiles: f => ({ list: [], inheritedDir: relative(process.cwd(), join(f.home, 'here')), inherited: null }),
      })
      expect(isAbsolute(w.set.inheritedDir)).toBe(false)
      runningSession(join(w.home, 'here'), { id: SID, name: 'Billing', cwd: PROJECT })
      return w
    },
  ],
  [
    'no transcript',
    CANNOT_WAKE.transcript,
    () => {
      const w = world({ panes: [claudePane('w1:p1', SID)] })
      runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT })
      rmSync(join(w.work, 'projects'), { recursive: true })
      return w
    },
  ],
  [
    'a transcript that cannot be read',
    'its transcript cannot be read: EPERM: operation not permitted, stat',
    () => {
      const w = world({ panes: [claudePane('w1:p1', SID)] })
      runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT })
      return { ...w, deps: { ...w.deps, homes: unreadableTranscripts(w.deps.homes) } }
    },
  ],
])('%s: not put to sleep, and the reason said', async (_, why, make) => {
  const w = make()
  const engine = createWakeEngine(w.deps)

  // Refused on request with the reason, kept up by the reaper with it, and /exit never typed.
  expect(await engine.sleep(SID)).toEqual({ ok: false, error: `Billing cannot be put to sleep: ${why}` })
  expect((await engine.plan()).find(p => p.pane === 'w1:p1')).toMatchObject({
    sleep: false,
    reason: `cannot wake: ${why}`,
  })
  w.settings.reaper.enabled = true
  expect(await engine.awake()).toMatchObject([{ pane: 'w1:p1', kept: `cannot wake: ${why}` }])
  await engine.reapRound()
  expect(w.io.calls.filter(c => c[0] === 'agent' && c[1] === 'prompt')).toEqual([])
  expect(typed(w.io)).toEqual([])
})

test('the reaper puts nobody to sleep while it is off; on, at most maxPerRound, never a session it could not wake', async () => {
  const panes = [
    claudePane('w1:p1', SID4), // no transcript
    claudePane('w1:p2', SID),
    claudePane('w1:p3', SID2),
    claudePane('w1:p4', SID3),
  ]
  const w = world({ panes, reaper: { maxPerRound: 2 } })
  const where: [string, string, number][] = [
    [SID4, w.claude, 1],
    [SID, w.claude, 2],
    [SID2, w.work, 3],
    [SID3, w.work, 4],
  ]
  for (const [i, [id, dir, n]] of where.entries()) {
    runningSession(dir, { id, name: `s${n}`, cwd: PROJECT, n })
    const pane = panes[i]
    if (pane) exitsOnPrompt(w.io, pane, join(dir, 'sessions', `${n}.json`))
  }
  rmSync(join(w.claude, 'projects', projectFolderName(PROJECT), `${SID4}.jsonl`))
  const engine = createWakeEngine(w.deps)

  await engine.reapRound()
  expect(w.io.calls).toEqual([])
  w.settings.reaper.enabled = true
  await engine.reapRound()
  expect(exits(w.io)).toEqual(['w1:p2', 'w1:p3'])
  await engine.reapRound()
  expect(exits(w.io)).toEqual(['w1:p2', 'w1:p3', 'w1:p4'])
  await engine.reapRound()
  expect(exits(w.io)).toEqual(['w1:p2', 'w1:p3', 'w1:p4'])
  expect((await engine.plan()).find(p => p.pane === 'w1:p1')).toMatchObject({
    sleep: false,
    reason: `cannot wake: ${CANNOT_WAKE.transcript}`,
  })
  expect(readSessions(w.file)).toMatchObject({
    'w1:p2': { session: SID, profileDir: w.claude, profile: 'default' },
    'w1:p3': { session: SID2, profileDir: w.work, profile: 'work' },
    'w1:p4': { session: SID3, profileDir: w.work, profile: 'work' },
  })
  expect(w.io.calls).toContainEqual(['pane', 'send-text', 'w1:p2', `board resume ${SID} --profile default`])
  expect(w.io.calls).toContainEqual(['pane', 'send-text', 'w1:p3', `board resume ${SID2} --profile work`])
})

test('a session that scheduled jobs for itself stays up: its transcript read in its own profile', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)], reaper: { enabled: true } })
  const call = { type: 'tool_use', id: 'toolu_1', name: 'CronCreate', input: {} }
  const line = { type: 'assistant', timestamp: new Date(w.clock.at - HOUR).toISOString(), message: { content: [call] } }
  runningSession(w.work, { id: SID, name: 'Cron', cwd: PROJECT, lines: [JSON.stringify(line)] })
  const engine = createWakeEngine(w.deps)

  expect(await engine.plan()).toMatchObject([{ pane: 'w1:p1', sleep: false, reason: 'has scheduled jobs' }])
  await engine.reapRound()
  expect(exits(w.io)).toEqual([])
})

test('a pane-<id> key and a pi pane are never woken nor put to sleep', async () => {
  const at = Date.now() - HOUR
  const keyed = shellPane('w1:p3')
  const pi: FakePane = {
    ...shellPane('w1:p4'),
    agent: 'pi',
    agent_status: 'idle',
    agent_session: { value: 'pane-w1:p4' },
  }
  const bridged = claudePane('w1:p5', 'pane-w1:p5')
  const w = world({
    panes: [keyed, pi, bridged],
    reaper: { enabled: true },
    sessions: () => ({
      'w1:p3': { session: 'pane-w1:p3', name: 'helper', seen_at: at, slept_at: at },
      'w1:p4': { session: SID2, name: 'was here', seen_at: at, slept_at: at },
    }),
  })
  w.io.busy.add('w1:p4') // pi runs in its pane's foreground
  // Claude's registry lists the bridged pane's key as an idle session.
  mkdirSync(join(w.claude, 'sessions'), { recursive: true })
  writeFileSync(
    join(w.claude, 'sessions', '5.json'),
    JSON.stringify({
      pid: process.pid,
      sessionId: 'pane-w1:p5',
      kind: 'interactive',
      name: 'bridged',
      cwd: PROJECT,
      status: 'idle',
      statusUpdatedAt: at - 3 * HOUR,
    }),
  )
  const engine = createWakeEngine(w.deps)

  for (const target of ['helper', 'w1:p3', 'pane-w1:p3', 'was here', 'w1:p4'])
    expect(await engine.wake(target)).toMatchObject({ ok: false })
  for (const target of ['bridged', 'w1:p5', 'pane-w1:p5', 'w1:p4'])
    expect(await engine.sleep(target)).toMatchObject({ ok: false })
  for (const pane of ['w1:p3', 'w1:p4', 'w1:p5']) expect(await engine.wakePane(pane)).toMatchObject({ ok: false })
  await engine.reapRound()
  expect(typed(w.io)).toEqual([])
  expect(w.io.calls.filter(c => c[1] === 'rename')).toEqual([])
  expect(await engine.sleeping()).toEqual([])
  expect(Object.keys(readSessions(w.file))).toEqual(['w1:p3', 'w1:p4'])
})

test('the sleeping list carries each session’s profile; /awake too', async () => {
  const at = Date.now() - HOUR
  const w = world({
    panes: [shellPane('w1:p1'), shellPane('w1:p2'), claudePane('w1:p3', SID3), claudePane('w1:p4', SID4, 'working')],
    reaper: { enabled: true },
    sessions: f => ({
      'w1:p1': {
        session: SID,
        name: 'Default one',
        seen_at: at,
        slept_at: at,
        profileDir: f.claude,
        profile: 'default',
      },
      'w1:p2': { session: SID2, name: 'Work one', seen_at: at, slept_at: at, profileDir: f.work, profile: 'work' },
    }),
  })
  runningSession(w.claude, { id: SID3, name: 'Default two', cwd: PROJECT })
  runningSession(w.work, { id: SID4, name: 'Work two', cwd: PROJECT, status: 'busy' })
  const engine = createWakeEngine(w.deps)

  const sleeping = [
    {
      name: 'Default one',
      pane: 'w1:p1',
      session: SID,
      workspace: 'Main',
      slept_at: new Date(at).toISOString(),
      exited: false,
      profile: { dir: w.claude, id: 'default' },
    },
    {
      name: 'Work one',
      pane: 'w1:p2',
      session: SID2,
      workspace: 'Main',
      slept_at: new Date(at).toISOString(),
      exited: false,
      profile: { dir: w.work, id: 'work' },
    },
  ]
  expect(await engine.sleeping()).toEqual(sleeping)
  expect(await engine.awake()).toMatchObject([
    {
      name: 'Default two',
      pane: 'w1:p3',
      status: 'idle',
      sleeps_in_min: 0,
      kept: null,
      profile: { dir: w.claude, id: 'default' },
    },
    {
      name: 'Work two',
      pane: 'w1:p4',
      status: 'busy',
      sleeps_in_min: null,
      kept: 'status busy',
      profile: { dir: w.work, id: 'work' },
    },
  ])
  const status = await engine.status()
  expect(Object.keys(status)).toEqual([
    'pid',
    'started',
    'lastPoll',
    'lastError',
    'reaper',
    'sleeping',
    'sessions',
    'telegram',
  ])
  expect(status).toMatchObject({
    pid: process.pid,
    lastPoll: null,
    lastError: null,
    reaper: w.settings.reaper,
    sleeping,
    telegram: { state: 'off' },
  })
  expect(Object.keys(status.sessions)).toEqual(['w1:p1', 'w1:p2'])
})

test('a session whose idle time Claude did not record: /awake gives no since, and the reaper keeps it up', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)], reaper: { enabled: true } })
  runningSession(w.work, { id: SID, name: 'Unknown', cwd: PROJECT, statusUpdatedAt: null })
  const engine = createWakeEngine(w.deps)

  expect(await engine.awake()).toMatchObject([
    { pane: 'w1:p1', since: '', sleeps_in_min: null, kept: 'idle time unknown' },
  ])
  await engine.reapRound()
  expect(exits(w.io)).toEqual([])
})

test('a profile id that is not a plain word: such a session elsewhere is never put to sleep; in the default folder it sleeps and wakes without --profile', async () => {
  const own = claudePane('w1:p1', SID)
  const w = world({
    panes: [own, claudePane('w1:p2', SID2)],
    profiles: f => {
      const listed = [
        { id: 'личный', dir: f.claude },
        { id: 'работа', dir: f.work },
      ]
      return profileSet(mergeProfiles(listed, findProfileDirs(f.home), f.home, f.claude).list, f.claude)
    },
  })
  runningSession(w.claude, { id: SID, name: 'Mine', cwd: PROJECT, n: 1 })
  runningSession(w.work, { id: SID2, name: 'Work', cwd: PROJECT, n: 2 })
  exitsOnPrompt(w.io, own, join(w.claude, 'sessions', '1.json'))
  startsOnRun(w.io, own, w.claude, { id: SID, name: 'Mine', n: 1 })
  const engine = createWakeEngine(w.deps)

  const why = 'its profile id is not a plain word'
  expect(await engine.sleep('Work')).toEqual({ ok: false, error: `Work cannot be put to sleep: ${why}` })
  expect((await engine.plan()).find(p => p.pane === 'w1:p2')).toMatchObject({
    sleep: false,
    reason: `cannot wake: ${why}`,
  })
  expect(exits(w.io)).toEqual([])

  expect(await engine.sleep('Mine')).toEqual({ ok: true, pane: 'w1:p1', name: 'Mine' })
  expect(readSessions(w.file)['w1:p1']).toMatchObject({ profileDir: w.claude, profile: 'личный' })
  expect(w.io.calls.at(-1)).toEqual(['pane', 'send-text', 'w1:p1', `board resume ${SID}`])
  expect(await engine.wake('Mine')).toEqual({ ok: true, pane: 'w1:p1', name: 'Mine' })
  expect(w.io.calls).toContainEqual(['pane', 'run', 'w1:p1', `board resume ${SID}`])
})

test('a session file with an entry that does not read: copied aside once and saved at once, so no start makes another copy', () => {
  const w = world({
    sessions: () =>
      JSON.stringify({
        'w1:p1': { session: SID, name: 'Kept', seen_at: 1 },
        'w1:p2': { session: SID2, name: 'Broken', seen_at: 'yesterday' },
      }),
  })
  createWakeEngine(w.deps)
  createWakeEngine(w.deps)

  const copies = readdirSync(dirname(w.file)).filter(name => name.startsWith('wake-sessions.json.broken-'))
  expect(copies).toHaveLength(1)
  expect(Object.keys(readSessions(w.file))).toEqual(['w1:p1'])
  expect(w.log.filter(line => line.includes('w1:p2'))).toHaveLength(1)
})

test('busy() counts a sleep under way', async () => {
  const pane = claudePane('w1:p1', SID)
  const w = world({ panes: [pane] })
  runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  exitsOnPrompt(w.io, pane, join(w.work, 'sessions', '1.json'))
  let reached = () => {}
  const atExit = new Promise<void>(resolve => {
    reached = resolve
  })
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  const engine = createWakeEngine({
    ...w.deps,
    herdr: {
      ...w.io,
      prompt: async (p, text) => {
        reached()
        await opened
        await w.io.prompt(p, text)
      },
    },
  })

  expect(engine.busy()).toBe(0)
  const sleeping = engine.sleep(SID)
  await atExit
  expect(engine.busy()).toBe(1)
  open()
  expect(await sleeping).toMatchObject({ ok: true })
  expect(engine.busy()).toBe(0)
})

test('wake turned off with its reaper still on: no round starts, and a round under way finishes its sleep and starts no other', async () => {
  const panes = [claudePane('w1:p1', SID), claudePane('w1:p2', SID2)]
  const w = world({ panes, reaper: { enabled: true, maxPerRound: 3 } })
  for (const [i, id] of [SID, SID2].entries()) {
    runningSession(w.claude, { id, name: `s${i + 1}`, cwd: PROJECT, n: i + 1 })
    const pane = panes[i]
    if (pane) exitsOnPrompt(w.io, pane, join(w.claude, 'sessions', `${i + 1}.json`))
  }
  let reached = () => {}
  const atExit = new Promise<void>(resolve => {
    reached = resolve
  })
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  const engine = createWakeEngine({
    ...w.deps,
    herdr: {
      ...w.io,
      prompt: async (p, text) => {
        reached()
        await opened
        await w.io.prompt(p, text)
      },
    },
  })

  // Off from the start: the round looks at nothing.
  w.settings.enabled = false
  await engine.reapRound()
  expect(w.io.calls).toEqual([])

  // On: the first sleep is under way when wake goes off.
  w.settings.enabled = true
  const round = engine.reapRound()
  await atExit
  w.settings.enabled = false
  expect(engine.busy()).toBe(1)
  open()
  await round
  expect(exits(w.io)).toEqual(['w1:p1'])
  expect(engine.busy()).toBe(0)
  expect(w.io.calls.filter(c => c[2] === 'w1:p2')).toEqual([])
})

test('read only (--reap-dry): a session file that does not read is neither set aside nor written', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)], sessions: () => '{ "w1:p1": { "session": ' })
  runningSession(w.claude, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  const engine = createWakeEngine({ ...w.deps, readOnly: true })
  expect((await engine.plan()).map(p => p.pane)).toEqual(['w1:p1'])
  expect(readdirSync(dirname(w.file))).toEqual(['wake-sessions.json'])
  expect(readFileSync(w.file, 'utf8')).toBe('{ "w1:p1": { "session": ')
  expect(w.log).toEqual([])
})

// Last in the file: the files bun runs after this one in the same process find the home and the
// folders as they were, not a temp folder a test has deleted.
test('every test gives back the home and folders it found', () => {
  expect(outside()).toEqual(OUTSIDE)
})
