import { expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
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
