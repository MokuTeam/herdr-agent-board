import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { dayName } from '../../src/core/mokupilot-day.ts'
import { promptOf, type ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { wakeOnConfig, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

// The ListAgents and SendMessage hooks (src/entrypoints/wake-hook.ts) as Claude Code runs them, in a
// sandbox whose home has spaces and Cyrillic, against a stand-in for wake's API on a port of the
// test's (the board's config.json's wake.port).
const HOOK = join(root, 'src', 'entrypoints', 'wake-hook.ts')
const OLD_HOOK = join(root, 'herdr-wake', 'src', 'hook.mjs')

const SID_D = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
const SID_W = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d'
const SID_L = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const SID_O = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'

const ago = (min: number): string => new Date(Date.now() - min * 60_000 - 5_000).toISOString()

type Profile = { dir?: string; id?: string } | null
/** A sleeper as GET /sleeping lists it, asleep for `min` minutes (`-min`: exited by the user); `profile` only when given. */
const sleeper = (name: string, pane: string, session: string, workspace: string, min: number, profile?: Profile) => ({
  name,
  pane,
  session,
  workspace,
  slept_at: ago(Math.abs(min)),
  exited: min < 0,
  ...(profile === undefined ? {} : { profile }),
})
/** A running session as GET /awake lists it, in its status for `min` minutes. */
const running = (
  name: string,
  status: string,
  min: number,
  sleeps: number | null,
  kept: string | null,
  profile?: Profile,
) => ({
  name,
  pane: `p-${name}`,
  workspace: 'Home',
  status,
  since: ago(min),
  sleeps_in_min: sleeps,
  kept,
  ...(profile === undefined ? {} : { profile }),
})

interface World {
  box: Sandbox
  home: string
  dflt: string
  work: string
  env: Record<string, string>
}

/** A sandbox whose home is `…/Иван Петров` with the default and a `.claude-work 100%` profile in it. */
async function world(): Promise<World> {
  const box = await sandbox()
  const home = join(box.dir, 'Иван Петров')
  const dflt = join(home, '.claude')
  const work = join(home, '.claude-work 100%')
  for (const dir of [dflt, work]) mkdirSync(dir, { recursive: true })
  return { box, home, dflt, work, env: { HOME: home, USERPROFILE: home } }
}

/** Sleepers and running sessions of both profiles: Default's "Billing", Work's "Billing" and "Ledger". */
function twoProfiles(w: World) {
  const d = { dir: w.dflt, id: 'default' }
  const k = { dir: w.work, id: 'work' }
  return {
    sleeping: [
      sleeper('Billing', 'p1', SID_D, 'Home', 30, d),
      sleeper('Billing', 'p2', SID_W, 'Office', 40, k),
      sleeper('Ledger', 'p3', SID_L, 'Office', -50, k),
    ],
    awake: [running('Api', 'idle', 5, null, 'reaper off', d), running('Docs', 'working', 7, null, 'reaper off', k)],
  }
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

/** The hook as Claude Code runs it: `input` on stdin (a string as it is), the world's env with `env` on top. */
async function runHook(w: World, mode: string, input: unknown, env: Record<string, string> = {}): Promise<Ran> {
  const proc = Bun.spawn([process.execPath, HOOK, mode], {
    cwd: root,
    env: { ...w.box.env, ...w.env, ...env },
    stdin: new TextEncoder().encode(typeof input === 'string' ? input : JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

const LIST = { hook_event_name: 'PostToolUse', tool_name: 'ListAgents', tool_input: {}, tool_response: {} }
const send = (to: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'SendMessage',
  tool_input: { to, message: 'the invoice is ready' },
})

/** What a ListAgents hook added for Claude, or null when it said nothing. */
function contextOf(r: Ran): string | null {
  expect(r.code).toBe(0)
  expect(r.stderr).toBe('')
  if (!r.stdout) return null
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
  return out.hookSpecificOutput.additionalContext
}

const sleeperRows = (text: string | null): string[] =>
  (text ?? '').split('\n').filter(l => l.includes('  ·  workspace '))
const runningNames = (text: string | null): string[] =>
  (text ?? '')
    .split('\n')
    .filter(l => /^ {2}\S/.test(l) && !l.includes('·  workspace') && !l.startsWith('  ...'))
    .map(l => l.trim().split('  ·  ')[0] ?? '')

test('a Default session’s ListAgents never shows a Work sleeper, nor the other way round', async () => {
  const w = await world()
  const fake = await fakeWake(twoProfiles(w))
  writeBoardConfig(w.box, wakeOnConfig(fake.port))

  const dflt = contextOf(await runHook(w, 'post-list', LIST))
  expect(sleeperRows(dflt)).toEqual(['  Billing  ·  workspace Home  ·  put to sleep 30 min ago'])
  expect(runningNames(dflt)).toEqual(['Api'])

  const work = contextOf(await runHook(w, 'post-list', LIST, { CLAUDE_CONFIG_DIR: w.work }))
  expect(sleeperRows(work)).toEqual([
    '  Billing  ·  workspace Office  ·  put to sleep 40 min ago',
    '  Ledger  ·  workspace Office  ·  exited by the user 50 min ago',
  ])
  expect(runningNames(work)).toEqual(['Docs'])
  expect(work).toContain("put to sleep by the board's wake")
  expect(work).not.toContain('herdr-wake')
})

test('SendMessage from Default to a name both profiles use wakes only Default’s, by its session id', async () => {
  const w = await world()
  const fake = await fakeWake(twoProfiles(w))
  writeBoardConfig(w.box, wakeOnConfig(fake.port))

  const r = await runHook(w, 'pre-send', send('billing [a1b2c3]'))
  expect([r.code, r.stdout, r.stderr]).toEqual([0, '', ''])
  expect(fake.requests().filter(q => q.method === 'POST')).toEqual([
    { method: 'POST', path: '/wake', body: { target: SID_D } },
  ])

  // From Work, the same name is Work's.
  await runHook(w, 'pre-send', send('Billing'), { CLAUDE_CONFIG_DIR: w.work })
  expect(
    fake
      .requests()
      .filter(q => q.method === 'POST')
      .map(q => q.body),
  ).toEqual([{ target: SID_D }, { target: SID_W }])
})

test('SendMessage from Default to a name only Work has: nothing woken, nothing said', async () => {
  const w = await world()
  const fake = await fakeWake(twoProfiles(w))
  writeBoardConfig(w.box, wakeOnConfig(fake.port))

  const r = await runHook(w, 'pre-send', send('Ledger'))
  expect([r.code, r.stdout, r.stderr]).toEqual([0, '', ''])
  expect(fake.requests()).toEqual([{ method: 'GET', path: '/sleeping', body: null }])
})

test('a refused wake: the deny names the board’s wake and the error', async () => {
  const w = await world()
  const fake = await fakeWake({ ...twoProfiles(w), wake: () => ({ ok: false, error: 'timed out waiting for Claude' }) })
  writeBoardConfig(w.box, wakeOnConfig(fake.port))

  const r = await runHook(w, 'pre-send', send('Billing'))
  expect([r.code, r.stderr]).toEqual([0, ''])
  expect(JSON.parse(r.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        "Billing is asleep (the board's wake) and could not be woken: timed out waiting for Claude",
    },
  })
})

test('an unset CLAUDE_CONFIG_DIR is the default folder; one folder spelled with another case, a trailing separator or ~ matches', async () => {
  const w = await world()
  const both = twoProfiles(w)
  const sleeping = [
    ...both.sleeping,
    // Taken over from the old plugin: no profile, so the default folder's.
    sleeper('Legacy', 'p6', SID_O, 'Home', 60),
    // A profile that is there but names no folder anyone could be in: no caller's.
    sleeper('Relative', 'p7', SID_O, 'Home', 61, { dir: '.claude' }),
    sleeper('Nameless', 'p8', SID_O, 'Home', 62, { id: 'default' }),
    sleeper('Null', 'p9', SID_O, 'Home', 63, null),
  ]
  const fake = await fakeWake({ sleeping, awake: both.awake })
  writeBoardConfig(w.box, wakeOnConfig(fake.port))
  const names = async (configDir?: string): Promise<string[]> =>
    sleeperRows(
      contextOf(await runHook(w, 'post-list', LIST, configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir })),
    ).map(l => l.trim().split('  ·  ')[0] ?? '')

  const defaults = ['Billing', 'Legacy']
  expect(await names()).toEqual(defaults)
  expect(await names('')).toEqual(defaults)
  expect(await names('~/.claude')).toEqual(defaults)
  expect(await names(`${w.dflt}${sep}`)).toEqual(defaults)

  const works = ['Billing', 'Ledger']
  expect(await names(join(w.home, '.CLAUDE-WORK 100%'))).toEqual(works)
  expect(await names(`${w.work}${sep}`)).toEqual(works)
  expect(await names('~/.claude-work 100%')).toEqual(works)
  expect(await names(`~${sep}.Claude-Work 100%${sep}`)).toEqual(works)
})

test('wake off, or config.json broken: no HTTP call at all', async () => {
  const w = await world()
  const fake = await fakeWake(twoProfiles(w))
  const configs: (Record<string, unknown> | string)[] = [
    { language: 'en', wake: { enabled: false, port: fake.port } },
    // A switch that cannot be read is off (it fails closed).
    { language: 'en', wake: { enabled: 'yes', port: fake.port } },
    `{ "language": "en", "wake": { "enabled": true, "port": ${fake.port} `,
    '',
  ]
  for (const config of configs) {
    writeBoardConfig(w.box, config)
    for (const [mode, input] of [
      ['post-list', LIST],
      ['pre-send', send('Billing')],
    ] as const) {
      const r = await runHook(w, mode, input)
      expect([r.code, r.stdout, r.stderr]).toEqual([0, '', ''])
    }
  }
  // Wake on, but what Claude handed over does not parse, or names no one.
  writeBoardConfig(w.box, wakeOnConfig(fake.port))
  for (const [mode, input] of [
    ['post-list', '{not json'],
    ['pre-send', '{not json'],
    ['pre-send', '{}'],
    ['pre-send', ''],
    ['nothing', LIST],
  ] as const) {
    const r = await runHook(w, mode, input)
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', ''])
  }
  expect(fake.requests()).toEqual([])
})

const node = Bun.which('node')

test.skipIf(!node)('the context text is herdr-wake’s, word for word but the name and where they wake', async () => {
  const w = await world()
  // One profile's sessions only (the old hook keeps them all): the default folder's, one without a profile.
  const d = { dir: w.dflt, id: 'default' }
  const sleeping = [
    sleeper('Billing', 'p1', SID_D, 'Home', 30, d),
    sleeper('Счета 100%', 'p2', SID_W, 'Проект x', -200),
    sleeper('Ledger', 'p3', SID_L, 'Home', 3 * 1440, d),
    sleeper('Old', 'p4', SID_O, 'Home', 9 * 1440, d),
  ]
  const awake = [
    running('Api', 'idle', 12, 0, null, d),
    running('Docs', 'idle', 20, 40, null, d),
    running('Web', 'working', 95, null, 'status working', d),
    running('Ops', 'idle', 61, null, 'focused'),
    running('Cron', 'idle', 3000, null, 'has scheduled jobs', d),
    running('Ask', 'blocked', 2, null, 'herdr says blocked', d),
    running('Skip', 'idle', 1, null, 'excluded', d),
  ]
  const fake = await fakeWake({ sleeping, awake, wake: () => ({ ok: false, error: 'pane p1 is gone' }) })
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { wake: { listSleepingDays: 5 } }))
  const oldConfig = join(w.box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'herdr-wake')
  mkdirSync(oldConfig, { recursive: true })
  writeFileSync(join(oldConfig, 'config.json'), JSON.stringify({ port: fake.port, listSleepingDays: 5 }))

  const runOld = async (mode: string, input: unknown): Promise<string> => {
    const proc = Bun.spawn([node as string, OLD_HOOK, mode], {
      cwd: root,
      env: { ...w.box.env, ...w.env },
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    return out
  }
  // A sleeper's pane may be closed now (#204): the text says where it wakes instead.
  const named = (text: string): string =>
    text
      .replaceAll('herdr-wake', "the board's wake")
      .replace('their pane is still open.', 'they wake in their pane, or in a new tab when wake closed it.')

  for (const answer of [awake, null]) {
    fake.awake = answer
    const old = await runOld('post-list', LIST)
    expect(old).toContain('herdr-wake')
    expect(old).toContain(`... and 1 asleep longer, not shown (all: http://127.0.0.1:${fake.port}/sleeping)`)
    const ours = await runHook(w, 'post-list', LIST)
    expect([ours.code, ours.stderr]).toEqual([0, ''])
    expect(ours.stdout).toBe(named(old))
  }

  const oldDeny = await runOld('pre-send', send('billing [0f3c]'))
  expect(oldDeny).toContain('herdr-wake')
  const deny = await runHook(w, 'pre-send', send('billing [0f3c]'))
  expect(deny.stdout).toBe(named(oldDeny))
  // The old hook named the pane, ours the session.
  expect(
    fake
      .requests()
      .filter(q => q.method === 'POST')
      .map(q => q.body),
  ).toEqual([{ target: 'p1' }, { target: SID_D }])
})

// #251: with two or more profiles shown, the other profiles' sessions are listed, and SendMessage
// to a name only they have goes through the board (a reminder due now, signed with the caller's
// Claude name and a ref to answer to).
const SID_ME = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b'
const SID_TWIN = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
const SID_OPS = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c'

/** Both profiles listed in config.json, Work hidden when `workHidden`; `more` after them. */
const profilesConfig = (w: World, workHidden = false, more: Record<string, unknown>[] = []) => ({
  profiles: [
    { id: 'default', title: 'Default', dir: w.dflt, color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: w.work, color: 'teal', hidden: workHidden },
    ...more,
  ],
})

/** A running Claude session in `dir`, as Claude's registry file records it (this test's pid: alive). */
function liveIn(dir: string, sessionId: string, name: string, cwd = 'C:\\Work\\Проект 100%'): void {
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(
    join(dir, 'sessions', `${sessionId}.json`),
    JSON.stringify({ pid: process.pid, sessionId, name, cwd, kind: 'interactive' }),
  )
}

const stateOf = (w: World): string => join(w.box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

/** The caller's card, with the name it has on the board. */
function cardOf(w: World, key: string, name: string): void {
  mkdirSync(join(stateOf(w), 'cards'), { recursive: true })
  writeFileSync(join(stateOf(w), 'cards', `${key}.json`), JSON.stringify({ key, name }))
}

/** The schedule's entries, as the board's scheduler reads them, oldest first. */
function scheduled(w: World): ScheduleEntry[] {
  const dir = join(stateOf(w), 'schedule')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /^[0-9a-f]{6}\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScheduleEntry)
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
}

const sendFrom = (to: string, message: unknown, sid: string) => ({
  ...send(to),
  session_id: sid,
  tool_input: { to, message },
})

/** The reason of a deny the hook printed. */
function denied(r: Ran): string {
  expect([r.code, r.stderr]).toEqual([0, ''])
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string> }
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  return out.hookSpecificOutput.permissionDecisionReason ?? ''
}

/** The hook let the call through to Claude Code: no output at all. */
const passed = (r: Ran): void => expect([r.code, r.stdout, r.stderr]).toEqual([0, '', ''])

/** The test's two profiles with a running session `name` in each profile given (its /awake row and registry file). */
function runningIn(w: World, list: [dir: string, id: string, sid: string, name: string][]) {
  const both = twoProfiles(w)
  for (const [dir, , sid, name] of list) liveIn(dir, sid, name)
  return {
    sleeping: both.sleeping,
    awake: [
      ...both.awake,
      ...list.map(([dir, id, , name]) => running(name, 'idle', 3, null, 'reaper off', { dir, id })),
    ],
  }
}

const NO_SCHEDULER = ' Note: no board with the scheduler is running now; it goes out once one runs.'

test('#251 round trip: Default → Work and the reply Work → Default, by the Claude name and ref the prompt gives', async () => {
  const w = await world()
  const fake = await fakeWake(
    runningIn(w, [
      [w.dflt, 'default', SID_ME, 'Monitor'],
      // Another Default session of the same name: the ref picks the sender.
      [w.dflt, 'default', SID_TWIN, 'Monitor'],
      [w.work, 'work', SID_O, 'Centium Ops'],
    ]),
  )
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))
  // The board shows another name on the sender's card: SendMessage does not know it by that one.
  cardOf(w, SID_ME, 'Work Profile Migration')

  const there = await runHook(w, 'pre-send', sendFrom('centium ops', 'mail for you\x1b[31m: case 42', SID_ME))
  expect(denied(there)).toBe(
    "Queued for Centium Ops in profile Work through the board (Claude Code reaches only this profile's sessions, " +
      'so it did not send it): the board types it in as a board reminder from Monitor once Centium Ops is free, ' +
      `waking it first if it sleeps.${NO_SCHEDULER} Do not send it again. The reply comes back the same way, as a ` +
      'board reminder from Centium Ops.',
  )
  const [first] = scheduled(w)
  expect(first).toMatchObject({
    key: SID_O,
    name: 'Centium Ops',
    pane: 'p-Centium Ops',
    cwd: 'C:\\Work\\Проект 100%',
    text: 'mail for you[31m: case 42',
    idle: true,
    by: 'agent',
    from: { key: SID_ME, name: 'Monitor' },
    fromProfile: 'Default',
    replyTo: 'Monitor [3e4f5a6b]',
  })
  expect(first?.next).toBeLessThanOrEqual(Date.now())
  expect(promptOf(first as ScheduleEntry, first?.next ?? 0)).toBe(
    '[board reminder from Monitor; SendMessage from profile Default, answer with SendMessage to Monitor [3e4f5a6b]] ' +
      'mail for you[31m: case 42',
  )

  // The reply, from Work, to the name the prompt gave.
  const work = { CLAUDE_CONFIG_DIR: w.work }
  const back = await runHook(w, 'pre-send', sendFrom(first?.replyTo ?? '', 'done: case 42', SID_O), work)
  expect(denied(back)).toStartWith('Queued for Monitor in profile Default through the board')
  expect(denied(back)).toEndWith('The reply comes back the same way, as a board reminder from Monitor.')
  const [, second, ...more] = scheduled(w)
  expect(more).toEqual([])
  expect(second).toMatchObject({
    key: SID_ME,
    name: 'Monitor',
    text: 'done: case 42',
    from: { key: SID_O, name: 'Centium Ops' },
    fromProfile: 'Work',
    replyTo: 'Centium Ops [2d3e4f5a]',
  })
  // Two Default sessions answer to the name alone: refused, each with its ref.
  const bare = denied(await runHook(w, 'pre-send', sendFrom('Monitor', 'done', SID_O), work))
  expect(bare).toStartWith('Not sent: "monitor" fits more than one session of the other profiles (')
  expect(bare).toContain('Monitor [3e4f5a6b] in profile Default')
  expect(bare).toContain('Monitor [5a6b7c8d] in profile Default')
  expect(scheduled(w)).toHaveLength(2)
  // Nothing woken by the hook: the scheduler wakes a sleeper when it delivers.
  expect(fake.requests().filter(q => q.method === 'POST')).toEqual([])
})

test('#251 Work → Default: SendMessage to a Default sleeper goes through the board, with its pane', async () => {
  const w = await world()
  const d = { dir: w.dflt, id: 'default' }
  const both = twoProfiles(w)
  const fake = await fakeWake({
    ...both,
    sleeping: [...both.sleeping, sleeper('Monitor', 'p9', SID_ME, 'Home', 20, d)],
  })
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))
  liveIn(w.work, SID_O, 'Centium Ops')

  const r = await runHook(w, 'pre-send', sendFrom('Monitor', 'done: case 42', SID_O), { CLAUDE_CONFIG_DIR: w.work })
  const reason = denied(r)
  expect(reason).toStartWith('Queued for Monitor in profile Default through the board')
  expect(reason).toContain('as a board reminder from Centium Ops once Monitor is free')
  expect(scheduled(w)).toMatchObject([
    {
      key: SID_ME,
      name: 'Monitor',
      pane: 'p9',
      text: 'done: case 42',
      idle: true,
      from: { key: SID_O, name: 'Centium Ops' },
      fromProfile: 'Work',
      replyTo: 'Centium Ops [2d3e4f5a]',
    },
  ])
  expect(fake.requests().filter(q => q.method === 'POST')).toEqual([])
})

test('#251 a message longer than a reminder carries is refused, not cut; it is measured without control characters', async () => {
  const w = await world()
  const fake = await fakeWake(
    runningIn(w, [
      [w.dflt, 'default', SID_ME, 'Monitor'],
      [w.work, 'work', SID_O, 'Centium Ops'],
    ]),
  )
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))

  const long = denied(await runHook(w, 'pre-send', sendFrom('Centium Ops', 'я'.repeat(2001), SID_ME)))
  expect(long).toBe(
    'Not sent: 2001 characters, the board carries 2000; send it in parts, or write it to a file and send the path.',
  )
  expect(scheduled(w)).toEqual([])
  const fits = denied(await runHook(w, 'pre-send', sendFrom('Centium Ops', `${'я'.repeat(2000)}\x1b\x07`, SID_ME)))
  expect(fits).toStartWith('Queued for Centium Ops in profile Work')
  expect(scheduled(w).map(e => e.text)).toEqual(['я'.repeat(2000)])
})

test('#251 left to Claude Code: a running session herdr does not run, a message that is no text', async () => {
  const w = await world()
  const fake = await fakeWake(runningIn(w, [[w.work, 'work', SID_O, 'Centium Ops']]))
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))
  liveIn(w.dflt, SID_ME, 'Monitor')
  // In Work's registry, not in /awake (a Claude outside herdr): the board could not type into it.
  liveIn(w.work, SID_OPS, 'Ghost')

  passed(await runHook(w, 'pre-send', sendFrom('Ghost', 'hi', SID_ME)))
  passed(await runHook(w, 'pre-send', sendFrom('Centium Ops', { type: 'shutdown_request' }, SID_ME)))
  passed(await runHook(w, 'pre-send', sendFrom('Centium Ops', ' \x1b ', SID_ME)))
  expect(scheduled(w)).toEqual([])
})

const SID_DAY = '9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e'

/** MokuPilot's day running today in the world's home, its Claude session `session` (#331). */
function mokupilotDay(w: World, session: string, over: Record<string, unknown> = {}): void {
  const folder = join(w.home, '.meeting-copilot', 'day', dayName(new Date()))
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'state.json'),
    JSON.stringify({ provider: 'claude', fork_session: session, ended_at: null, ...over }),
  )
}

test("#331 to MokuPilot's day session from another profile: queued through the board although herdr does not run it", async () => {
  const w = await world()
  const fake = await fakeWake(runningIn(w, [[w.work, 'work', SID_O, 'Centium Ops']]))
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))
  // In Default's registry, not in /awake: MokuPilot runs it as `claude -p` with its hooks off.
  liveIn(w.dflt, SID_DAY, 'work-a7', 'C:\\Work')
  mokupilotDay(w, SID_DAY)

  const work = { CLAUDE_CONFIG_DIR: w.work }
  const r = denied(await runHook(w, 'pre-send', sendFrom('work-a7', 'done: case 42', SID_O), work))
  expect(r).toStartWith('Queued for work-a7 in profile Default through the board')
  expect(r).toEndWith('The reply comes back the same way, as a board reminder from work-a7.')
  const [entry, ...more] = scheduled(w)
  expect(more).toEqual([])
  expect(entry).toMatchObject({
    key: SID_DAY,
    name: 'work-a7',
    cwd: 'C:\\Work',
    text: 'done: case 42',
    from: { key: SID_O, name: 'Centium Ops' },
    fromProfile: 'Work',
    replyTo: 'Centium Ops [2d3e4f5a]',
  })
  expect(entry).not.toHaveProperty('pane')
})

test('#331 left to Claude Code: a session outside herdr that is not the running day, an ended day, "mokupilot": false', async () => {
  const w = await world()
  const fake = await fakeWake(runningIn(w, [[w.work, 'work', SID_O, 'Centium Ops']]))
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))
  liveIn(w.dflt, SID_DAY, 'work-a7')
  liveIn(w.dflt, SID_ME, 'Ghost')
  const work = { CLAUDE_CONFIG_DIR: w.work }

  mokupilotDay(w, SID_DAY)
  passed(await runHook(w, 'pre-send', sendFrom('Ghost', 'hi', SID_O), work))
  mokupilotDay(w, SID_DAY, { ended_at: 1793870263.9 })
  passed(await runHook(w, 'pre-send', sendFrom('work-a7', 'hi', SID_O), work))
  mokupilotDay(w, SID_DAY)
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: { ...profilesConfig(w), mokupilot: false } }))
  passed(await runHook(w, 'pre-send', sendFrom('work-a7', 'hi', SID_O), work))
  expect(scheduled(w)).toEqual([])
})

test('#251 no reply path: a caller with no Claude name, or in a profile the board does not show', async () => {
  const w = await world()
  const ops = join(w.home, '.claude-ops')
  const fake = await fakeWake(runningIn(w, [[w.work, 'work', SID_O, 'Centium Ops']]))
  const hiddenOps = { id: 'ops', title: 'Ops', dir: ops, color: 'pink', hidden: true }
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w, false, [hiddenOps]) }))
  liveIn(ops, SID_OPS, 'Ops Desk')

  const nameless = denied(await runHook(w, 'pre-send', sendFrom('Centium Ops', 'hi', SID_ME)))
  expect(nameless).toEndWith('No reply comes back this way: this session has no name.')
  expect(nameless).toContain('as a board reminder from 3e4f5a6b once')
  const hidden = denied(
    await runHook(w, 'pre-send', sendFrom('Centium Ops', 'hi again', SID_OPS), { CLAUDE_CONFIG_DIR: ops }),
  )
  expect(hidden).toEndWith('No reply comes back this way: this profile is not shown on the board.')
  const [a, b] = scheduled(w)
  expect([a?.replyTo, b?.replyTo]).toEqual(['', ''])
  expect(promptOf(a as ScheduleEntry, a?.next ?? 0)).toBe(
    '[board reminder from 3e4f5a6b; SendMessage from profile Default, no reply path] hi',
  )
  expect(promptOf(b as ScheduleEntry, b?.next ?? 0)).toBe(
    '[board reminder from Ops Desk; SendMessage from profile Ops, no reply path] hi again',
  )
})

test('#251 the caller’s own profile wins, running or asleep; a name no profile has is left to Claude Code', async () => {
  const w = await world()
  const fake = await fakeWake(
    runningIn(w, [
      [w.dflt, 'default', SID_ME, 'Docs'],
      [w.work, 'work', SID_O, 'Docs'],
    ]),
  )
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))

  // Docs runs in both: Default's own, Claude Code sends it.
  passed(await runHook(w, 'pre-send', sendFrom('Docs', 'hi', SID_D)))
  // Billing sleeps in both: Default's is woken, as before.
  passed(await runHook(w, 'pre-send', sendFrom('Billing', 'hi', SID_D)))
  expect(fake.requests().filter(q => q.method === 'POST')).toEqual([
    { method: 'POST', path: '/wake', body: { target: SID_D } },
  ])
  passed(await runHook(w, 'pre-send', sendFrom('Nobody', 'hi', SID_D)))
  expect(scheduled(w)).toEqual([])
})

test('#251 a name sessions of two other profiles share is refused, each listed with its ref; nothing scheduled', async () => {
  const w = await world()
  const ops = join(w.home, '.claude-ops')
  const fake = await fakeWake(
    runningIn(w, [
      [w.work, 'work', SID_O, 'Ledger'],
      [ops, 'ops', SID_OPS, 'ledger'],
    ]),
  )
  const third = { id: 'ops', title: 'Ops', dir: ops, color: 'pink', hidden: false }
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w, false, [third]) }))

  const reason = denied(await runHook(w, 'pre-send', sendFrom('Ledger', 'hi', SID_D)))
  expect(reason).toStartWith('Not sent: "ledger" fits more than one session of the other profiles (')
  for (const part of [
    'Ledger [2d3e4f5a] in profile Work',
    'Ledger [1c2d3e4f] in profile Work',
    'ledger [4f5a6b7c] in profile Ops',
  ])
    expect(reason).toContain(part)
  expect(scheduled(w)).toEqual([])
})

test('#251 one profile shown: SendMessage and ListAgents as before, no other call', async () => {
  const w = await world()
  const fake = await fakeWake(twoProfiles(w))
  liveIn(w.work, SID_O, 'Centium Ops')
  for (const config of [{}, profilesConfig(w, true)]) {
    writeBoardConfig(w.box, wakeOnConfig(fake.port, { config }))
    const r = await runHook(w, 'pre-send', sendFrom('Centium Ops', 'hi', SID_D))
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', ''])
    const list = contextOf(await runHook(w, 'post-list', LIST))
    expect(list).not.toContain('other Claude profiles')
    expect(list).not.toContain('Ledger')
  }
  expect(scheduled(w)).toEqual([])
  expect(fake.requests().map(q => `${q.method} ${q.path}`)).toEqual([
    'GET /sleeping',
    'GET /sleeping',
    'GET /awake',
    'GET /sleeping',
    'GET /sleeping',
    'GET /awake',
  ])
})

test('#251 ListAgents with two profiles shown: the other one’s running and sleeping sessions, each with its profile', async () => {
  const w = await world()
  const fake = await fakeWake(twoProfiles(w))
  writeBoardConfig(w.box, wakeOnConfig(fake.port, { config: profilesConfig(w) }))
  const othersOf = (text: string): string[] =>
    text.slice(text.indexOf('Sessions of the other Claude profiles')).split('\n').slice(1)

  const dflt = contextOf(await runHook(w, 'post-list', LIST)) ?? ''
  // Its own as before.
  expect(sleeperRows(dflt)).toEqual(['  Billing  ·  workspace Home  ·  put to sleep 30 min ago'])
  expect(dflt).toContain('SendMessage to one by name goes through the board')
  expect(othersOf(dflt)).toEqual([
    '  Docs  ·  profile Work  ·  working 7 min',
    '  Billing  ·  profile Work  ·  asleep 40 min',
    '  Ledger  ·  profile Work  ·  asleep 50 min',
  ])

  const work = contextOf(await runHook(w, 'post-list', LIST, { CLAUDE_CONFIG_DIR: w.work })) ?? ''
  expect(othersOf(work)).toEqual([
    '  Api  ·  profile Default  ·  idle 5 min',
    '  Billing  ·  profile Default  ·  asleep 30 min',
  ])
})

// #619: with `nodes` in config.json the sessions on the board's nodes are listed, and SendMessage to a
// name only a node's session has goes through the board: an entry for its prefixed key, which the
// scheduler sends through the node. The board's payload comes from a stand-in on the fake wake's port.
const SID_N1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
const SID_N2 = '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f'
const SID_N3 = '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a'
const SID_N4 = 'ad0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2b'

const nodeCard = (device: string, sid: string, name: string, more: Record<string, unknown> = {}) => ({
  key: `@${device}:${sid}`,
  session: sid,
  name,
  autoName: name,
  device,
  pane: 'w5:p2',
  cwd: '/home/agent-board/work',
  status: 'idle',
  activity: 200,
  ...more,
})

/** The web board's payload: this computer's caller "Laptop Work", the nodes' cards, server-1 offline. */
const nodesBoard = (cards: Record<string, unknown>[]) => ({
  items: [{ key: SID_ME, session: SID_ME, name: 'Laptop Work', pane: 'p-me', status: 'working' }, ...cards],
  devices: [
    { id: 'server-2', link: { state: 'online' } },
    { id: 'local', link: null, status: { id: 'laptop' } },
    { id: 'server-1', link: { state: 'offline' } },
  ],
})

const NODE_CARDS = [
  nodeCard('server-2', SID_N1, 'Agent-board Master'),
  // The card of the session the Master's pane held before: another session is there now.
  nodeCard('server-2', SID_N2, 'Old Master', { activity: 100 }),
  nodeCard('server-2', SID_N3, 'board-self-update', { pane: 'w5:p3', status: 'working' }),
  nodeCard('server-1', SID_N4, 'Server-NS-login', { pane: null, sleeping: true, status: 'sleeping' }),
  // Awake with no pane: nothing to type into.
  nodeCard('server-1', SID_O, 'Paneless', { pane: null }),
]

/** A world with one profile whose config.json has `nodes` (or not), wake and the board on the stand-in's port. */
async function nodesWorld(cards: Record<string, unknown>[], nodes = true) {
  const w = await world()
  const fake = await fakeWake({ ...twoProfiles(w), board: nodesBoard(cards) })
  writeBoardConfig(
    w.box,
    wakeOnConfig(fake.port, { config: { port: fake.port, ...(nodes && { nodes: { id: 'laptop' } }) } }),
  )
  liveIn(w.dflt, SID_ME, 'Monitor')
  return { w, fake, boardAsked: () => fake.requests().filter(q => q.path === '/api/board').length }
}

test('#619 ListAgents lists the nodes’ sessions with their node and state; a replaced card and one with no pane are left out', async () => {
  const { w } = await nodesWorld(NODE_CARDS)
  const text = contextOf(await runHook(w, 'post-list', LIST)) ?? ''
  const part = text.slice(text.indexOf("Sessions on the board's nodes"))
  expect(part.split('\n').slice(1)).toEqual([
    '  Agent-board Master [7b8c9d0e]  ·  node server-2  ·  idle',
    '  board-self-update [9d0e1f2a]  ·  node server-2  ·  working',
    '  Server-NS-login [ad0e1f2a]  ·  node server-1  ·  asleep  ·  node offline now: goes out once it is back',
  ])
  // This computer's part is as before.
  expect(sleeperRows(text)).toEqual(['  Billing  ·  workspace Home  ·  put to sleep 30 min ago'])
})

test('#619 SendMessage to a node session’s name is queued for its prefixed key; the prompt says how to answer from there', async () => {
  const { w, fake } = await nodesWorld(NODE_CARDS)
  const r = await runHook(w, 'pre-send', sendFrom('agent-board master', 'ping from the laptop', SID_ME))
  expect(denied(r)).toBe(
    "Queued for Agent-board Master on node server-2 through the board (Claude Code reaches only this computer's " +
      'sessions, so it did not send it): the board types it in as a board reminder from Laptop Work once ' +
      `Agent-board Master is free, waking it first if it sleeps.${NO_SCHEDULER} Do not send it again. The reply ` +
      'comes back the same way, as a board reminder from Agent-board Master.',
  )
  const [entry, ...more] = scheduled(w)
  expect(more).toEqual([])
  expect(entry).toMatchObject({
    key: `@server-2:${SID_N1}`,
    name: 'Agent-board Master',
    text: 'ping from the laptop',
    idle: true,
    by: 'agent',
    from: { key: SID_ME, name: 'Laptop Work' },
    replyTo: 'Laptop Work [3e4f5a6b]',
    replyBy: 'board',
    fromDevice: 'laptop',
  })
  // A node's pane and folder mean nothing here: the scheduler sends by the key, through the node.
  expect(entry?.pane).toBeUndefined()
  expect(entry?.cwd).toBeUndefined()
  expect(promptOf(entry as ScheduleEntry, entry?.next ?? 0)).toBe(
    '[board reminder from Laptop Work; from laptop, answer with board send "Laptop Work [3e4f5a6b]" ' +
      '"<your answer>"] ping from the laptop',
  )
  // The replaced card is no target: left to Claude Code. A sleeping one on an offline node is.
  passed(await runHook(w, 'pre-send', sendFrom('Old Master', 'x', SID_ME)))
  expect(denied(await runHook(w, 'pre-send', sendFrom('Server-NS-login', 'x', SID_ME)))).toStartWith(
    'Queued for Server-NS-login on node server-1 through the board',
  )
  expect(scheduled(w)).toHaveLength(2)
  expect(fake.requests().filter(q => q.method === 'POST')).toEqual([])
})

test('#619 a name sessions on two nodes share is refused with their refs; the ref picks one; too long is refused', async () => {
  const { w } = await nodesWorld([
    nodeCard('server-2', SID_N1, 'Worker'),
    nodeCard('server-1', SID_N3, 'Worker', { pane: 'w1:p1' }),
  ])
  const both = denied(await runHook(w, 'pre-send', sendFrom('worker', 'x', SID_ME)))
  expect(both).toBe(
    'Not sent: "worker" fits more than one session on the board\'s nodes (Worker [7b8c9d0e] on node server-2, ' +
      'Worker [9d0e1f2a] on node server-1). Send it to one of them as listed: its name with its ref, or its key.',
  )
  expect(scheduled(w)).toEqual([])
  expect(denied(await runHook(w, 'pre-send', sendFrom('Worker [9d0e1f2a]', 'x', SID_ME)))).toStartWith(
    'Queued for Worker on node server-1',
  )
  expect(scheduled(w)).toMatchObject([{ key: `@server-1:${SID_N3}` }])
  expect(denied(await runHook(w, 'pre-send', sendFrom('Worker [7b8c9d0e]', 'я'.repeat(2001), SID_ME)))).toBe(
    'Not sent: 2001 characters, the board carries 2000; send it in parts, or write it to a file and send the path.',
  )
  expect(scheduled(w)).toHaveLength(1)
})

test('#619 without nodes in config.json the board is asked nothing; with them, a name of this profile stays Claude Code’s', async () => {
  const plain = await nodesWorld(NODE_CARDS, false)
  passed(await runHook(plain.w, 'pre-send', sendFrom('Agent-board Master', 'x', SID_ME)))
  const text = contextOf(await runHook(plain.w, 'post-list', LIST)) ?? ''
  expect(text).not.toContain("board's nodes")
  expect(plain.boardAsked()).toBe(0)
  expect(scheduled(plain.w)).toEqual([])

  // A running session of this profile with a node session's name: SendMessage's own.
  const { w } = await nodesWorld(NODE_CARDS)
  liveIn(w.dflt, SID_OPS, 'board-self-update')
  passed(await runHook(w, 'pre-send', sendFrom('board-self-update', 'x', SID_ME)))
  expect(scheduled(w)).toEqual([])
})

test('#619 several profiles and nodes: another profile’s name is still the board’s profile path; a name only a node has goes to the node', async () => {
  const w = await world()
  const fake = await fakeWake({
    ...runningIn(w, [[w.work, 'work', SID_O, 'Centium Ops']]),
    board: nodesBoard(NODE_CARDS),
  })
  writeBoardConfig(
    w.box,
    wakeOnConfig(fake.port, { config: { ...profilesConfig(w), port: fake.port, nodes: { id: 'laptop' } } }),
  )
  liveIn(w.dflt, SID_ME, 'Monitor')
  expect(denied(await runHook(w, 'pre-send', sendFrom('Centium Ops', 'x', SID_ME)))).toStartWith(
    'Queued for Centium Ops in profile Work through the board',
  )
  expect(denied(await runHook(w, 'pre-send', sendFrom('board-self-update', 'y', SID_ME)))).toStartWith(
    'Queued for board-self-update on node server-2 through the board',
  )
  expect(scheduled(w)).toMatchObject([
    { key: SID_O, fromProfile: 'Default' },
    { key: `@server-2:${SID_N3}`, replyBy: 'board', fromDevice: 'laptop' },
  ])
  // ListAgents: the other profile's part, then the nodes'.
  const text = contextOf(await runHook(w, 'post-list', LIST)) ?? ''
  expect(text.indexOf('Sessions of the other Claude profiles')).toBeGreaterThan(-1)
  expect(text.indexOf("Sessions on the board's nodes")).toBeGreaterThan(
    text.indexOf('Sessions of the other Claude profiles'),
  )
})
