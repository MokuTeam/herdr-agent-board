import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { failureKind } from '../../src/core/launch/launcher-command.ts'
import { parseArgs } from '../../src/core/launch/spawn-args.ts'
import { profileReport, profileTag, sessionProfile } from '../../src/core/profiles.ts'
import { absoluteDir } from '../../src/services/launch/spawn-agent.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// spawn-agent end to end against the sandbox's fake herdr.
const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] },
  'agent list': { result: { agents: [{ name: 'acme-invoices', pane_id: 'wB:p1' }, { pane_id: 'wA:p9' }] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  'pane read': { text: 'Session renamed to: Acme invoices' },
  'pane send-keys': { result: null },
}

async function runSpawn(box: Sandbox, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, SPAWN, ...args], {
    cwd: root,
    env: { ...box.env, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

function boardConfig(box: Sandbox, cfg: unknown) {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
}

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const panesFile = (box: Sandbox) =>
  join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'profile-panes.json')
const cardOf = (box: Sandbox, key: string): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/**
 * A sandbox whose home has the profile folders .claude, .claude-work and .claude-gamedev, listed in
 * the board's config: default and work shown (work with its own Claude arguments), gamedev hidden.
 */
const notListed = (dir: string) =>
  `--config-dir ${dir} is not the folder of a profile the board knows: see the board's Settings → Profiles`

async function profileBox(
  launch: unknown = {},
  extra: (home: string) => unknown[] = () => [],
  fields: { default?: Record<string, unknown>; work?: Record<string, unknown> } = {},
) {
  const box = await sandbox()
  box.state(STATE)
  const home = box.env.HOME as string
  const dirs = {
    default: join(home, '.claude'),
    work: join(home, '.claude-work'),
    gamedev: join(home, '.claude-gamedev'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  boardConfig(box, {
    language: 'en',
    launch,
    profiles: [
      { id: 'default', title: 'Private', dir: dirs.default, color: 'indigo', hidden: false, ...fields.default },
      {
        id: 'work',
        title: 'Work',
        dir: dirs.work,
        color: 'teal',
        hidden: false,
        args: ['--model', 'sonnet'],
        ...fields.work,
      },
      { id: 'gamedev', title: 'Gamedev', dir: dirs.gamedev, color: 'pink', hidden: true },
      ...extra(home),
    ],
  })
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  return { box, home, dir, ...dirs }
}

/** The calls in a row, a run of `pane get` (the wait for Claude) as one. */
const callList = (box: Sandbox) => {
  const calls = box.calls().map(a => (a.slice(0, 2).join(' ') === 'pane get' ? 'pane get' : a.join(' ')))
  return calls.filter((c, i) => c !== 'pane get' || calls[i - 1] !== 'pane get')
}

test('a folder as given: ~ is the home folder', () => {
  assert.equal(absoluteDir('~'), absoluteDir(process.env.USERPROFILE || process.env.HOME || ''))
  assert.equal(absoluteDir('"C:\\Work"'), absoluteDir('C:\\Work'))
})

test('spawn-agent starts Claude in a new tab, names it in herdr and Claude, sends the brief, and says where', async () => {
  const box = await sandbox()
  box.state(STATE)
  boardConfig(box, { launch: { claude: ['claude-tg', '--model', 'opus 4'] } })
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  const brief = join(box.dir, 'brief.txt')
  writeFileSync(brief, '\uFEFF-Check the invoices.\nThen report.\n')
  const sid = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const r = await runSpawn(box, [
    '-Name',
    'Acme invoices',
    '-Cwd',
    dir,
    '-Workspace',
    'wA',
    '-BriefFile',
    brief,
    '--session-id',
    sid,
  ])
  assert.equal(r.code, 0, r.stderr)
  // The pane and the name the board links sessions by; another agent had the name already.
  assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2')
  const calls = box.calls().map(a => (a.slice(0, 2).join(' ') === 'pane get' ? 'pane get' : a.join(' ')))
  assert.deepEqual(
    calls.filter((c, i) => c !== 'pane get' || calls[i - 1] !== 'pane get'),
    [
      `tab create --workspace wA --cwd ${dir} --label Acme invoices --no-focus`,
      `pane run wA:p9 claude-tg --model 'opus 4' --session-id ${sid}`,
      'pane get',
      'agent list',
      'agent rename wA:p9 acme-invoices-2',
      'agent prompt wA:p9 /rename Acme invoices',
      'pane read wA:p9 --source visible',
      // A leading dash would read as an option to herdr: a space goes before it.
      'agent prompt wA:p9  -Check the invoices.\nThen report.',
    ],
  )
}, 30_000)

test('spawn-agent: a dialog before Claude is ready, a brief herdr calls stalled, and a folder that is not there', async () => {
  const box = await sandbox()
  box.state({
    ...STATE,
    'pane get': { result: { pane: { pane_id: 'wA:p9', agent: 'claude', agent_status: 'blocked' } } },
  })
  const blocked = await runSpawn(box, ['--name', 'Fresh', '--cwd', box.dir, '--workspace', 'wA', '--brief', 'Hi'])
  assert.equal(blocked.code, 1)
  assert.match(blocked.stderr, /^spawn-agent: Claude in wA:p9 waits for a dialog \(folder trust\?\)/)
  assert.equal(
    box.calls().some(a => a[0] === 'agent' && a[1] === 'prompt'),
    false,
  )

  // Text still on screen after "stalled" only needs its Enter; the session runs, so it is no failure.
  const box2 = await sandbox()
  box2.state({
    ...STATE,
    'agent prompt': { code: 'agent_prompt_stalled', error: 'agent_prompt_stalled: no turn' },
    'pane read': { text: 'Session renamed\n❯ Hello there, a long brief' },
  })
  const stalled = await runSpawn(box2, ['--name', 'Calm', '--cwd', box2.dir, '--brief', 'Hello there, a long brief'], {
    HERDR_WORKSPACE_ID: 'wA',
  })
  assert.equal(stalled.code, 0, stalled.stderr)
  assert.ok(box2.calls().some(a => a.join(' ') === 'pane send-keys wA:p9 enter'))

  const missing = await runSpawn(box2, ['--name', 'Nowhere', '--cwd', join(box2.dir, 'nope'), '--workspace', 'wA'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /No such folder/)
  const noWorkspace = await runSpawn(box2, ['--name', 'Nowhere', '--cwd', box2.dir])
  assert.match(noWorkspace.stderr, /No herdr workspace/)
}, 30_000)

test('spawn-agent --pane starts Claude in a pane that is there, its tab named after the session', async () => {
  const box = await sandbox()
  box.state({
    ...STATE,
    'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: null } } }, READY] },
  })
  const r = await runSpawn(box, ['--name', 'Here', '--cwd', box.dir, '--pane', 'wA:p9'])
  assert.equal(r.code, 0, r.stderr)
  const calls = box.calls().map(a => a.join(' '))
  assert.equal(
    calls.some(c => c.startsWith('tab create')),
    false,
  )
  assert.ok(calls.includes('tab rename wA:t9 Here'))
  assert.ok(calls.includes('pane run wA:p9 claude'))
}, 30_000)

test('spawn-agent: a /rename herdr refuses is a warning; a brief it refuses fails as "did not reach", which the board does not retry', async () => {
  const box = await sandbox()
  box.state({
    ...STATE,
    'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] },
    'agent prompt': { code: 'agent_busy', error: 'agent_busy: the agent is busy' },
  })
  const r = await runSpawn(box, ['--name', 'Busy', '--cwd', box.dir, '--workspace', 'wA', '--brief', 'Go.'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /spawn-agent: \/rename in wA:p9: .*agent_busy/)
  const last = r.stderr.trim().split('\n').at(-1) ?? ''
  assert.match(last, /^spawn-agent: The brief did not reach Claude in wA:p9: /)
  assert.equal(failureKind(last), 'message')
}, 30_000)

test('spawn-agent --pane refuses a pane that runs an agent: the command would be typed into it', async () => {
  const box = await sandbox()
  box.state({ ...STATE, 'pane get': READY })
  const r = await runSpawn(box, ['--name', 'Here', '--cwd', box.dir, '--pane', 'wA:p9'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /wA:p9 already runs claude/)
  assert.equal(
    box.calls().some(a => a[0] === 'pane' && a[1] === 'run'),
    false,
  )
}, 30_000)

test('spawn-agent with launch.args and no launch.claude: claude with those arguments; --help says how', async () => {
  const box = await sandbox()
  box.state(STATE)
  boardConfig(box, { launch: { args: ['--model', 'opus'] } })
  const r = await runSpawn(box, ['--name', 'Args', '--cwd', box.dir, '--workspace', 'wA'])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(box.calls().some(a => a.join(' ') === 'pane run wA:p9 claude --model opus'))
  const help = await runSpawn(box, ['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /^spawn-agent --name <Name> --cwd <folder>/)
}, 30_000)

test('unset, ~/.claude, a trailing slash and another drive case start the child as before, without --env', async () => {
  // Another case of the drive letter, where there is one.
  const otherCase = (path: string) =>
    path.replace(/^[A-Za-z]:/, d => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()))
  const variants: ((home: string) => string | undefined)[] = [
    () => undefined,
    () => '~/.claude',
    home => `${join(home, '.claude')}/`,
    home => otherCase(join(home, '.claude')),
  ]
  await Promise.all(
    variants.map(async variant => {
      const { box, home, dir } = await profileBox({ claude: ['claude-tg', '--model', 'opus 4'] })
      const brief = join(box.dir, 'brief.txt')
      writeFileSync(brief, '﻿-Check the invoices.\nThen report.\n')
      const own = variant(home)
      const r = await runSpawn(
        box,
        ['-Name', 'Acme invoices', '-Cwd', dir, '-Workspace', 'wA', '-BriefFile', brief, '--session-id', SID],
        own === undefined ? {} : { CLAUDE_CONFIG_DIR: own },
      )
      assert.equal(r.code, 0, `${own}: ${r.stderr}`)
      assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2')
      // Exactly the calls of the first test above.
      assert.deepEqual(
        callList(box),
        [
          `tab create --workspace wA --cwd ${dir} --label Acme invoices --no-focus`,
          `pane run wA:p9 claude-tg --model 'opus 4' --session-id ${SID}`,
          'pane get',
          'agent list',
          'agent rename wA:p9 acme-invoices-2',
          'agent prompt wA:p9 /rename Acme invoices',
          'pane read wA:p9 --source visible',
          'agent prompt wA:p9  -Check the invoices.\nThen report.',
        ],
        String(own),
      )
      assert.equal(existsSync(panesFile(box)), false, String(own))
      // A start that keeps the env still says the profile it is meant to be in: herdr's env may
      // point elsewhere, and the hooks' report then shows the session in the wrong profile.
      expect(cardOf(box, SID)).toEqual({ key: SID, profileWant: 'default', updatedAt: expect.any(Number) })
    }),
  )
}, 60_000)

test('a private agent’s helper leaves the env alone and says it is meant for default: herdr’s env in work shows as the wrong profile', async () => {
  const { box, dir, default: own, work } = await profileBox()
  const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID])
  assert.equal(r.code, 0, r.stderr)
  // No --env: herdr's env is taken to be the default profile's.
  assert.equal(callList(box)[0], `tab create --workspace wA --cwd ${dir} --label Helper --no-focus`)
  const card = cardOf(box, SID)
  expect(card).toMatchObject({ profileWant: 'default' })
  // herdr's server runs with CLAUDE_CONFIG_DIR at work after all: the hooks in the new tab report
  // work, and the session is in the wrong profile, which its card's red tag and herdr say.
  const meant = { id: 'default', title: 'Private', dir: own, color: 'indigo', hidden: false }
  const list = [meant, { id: 'work', title: 'Work', dir: work, color: 'teal', hidden: false }]
  const reported = sessionProfile({ ...card, ...profileReport(card, work, list) }, list)
  expect(reported).toEqual({ profile: 'work', profileWanted: 'default' })
  expect(profileTag(reported, list)).toEqual({ kind: 'wrong', wantId: 'default', want: meant })
  // Reported in default, as meant: no warning.
  expect(sessionProfile({ ...card, ...profileReport(card, own, list) }, list)).toEqual({ profile: 'default' })
}, 30_000)

test('an agent in a work session starts its helper in work: --env on the tab, the pane recorded, work’s args, the card wants work', async () => {
  const { box, dir, work } = await profileBox()
  const r = await runSpawn(box, ['-Name', 'Acme invoices', '-Cwd', dir, '-Workspace', 'wA', '--session-id', SID], {
    CLAUDE_CONFIG_DIR: work,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(box.calls()[0], [
    'tab',
    'create',
    '--workspace',
    'wA',
    '--cwd',
    dir,
    '--label',
    'Acme invoices',
    '--env',
    `CLAUDE_CONFIG_DIR=${work}`,
    '--no-focus',
  ])
  const calls = callList(box)
  assert.equal(calls[1], `pane run wA:p9 claude --model sonnet --session-id ${SID}`)
  // With the terminal herdr opened it with: a pane id it gives out again later is not this pane.
  expect(JSON.parse(readFileSync(panesFile(box), 'utf8'))).toMatchObject({
    'wA:p9': { profile: 'work', terminal: 'term-9' },
  })
  expect(cardOf(box, SID)).toMatchObject({ profileWant: 'work' })
}, 30_000)

test('a hidden parent profile is kept: gamedev gets its --env', async () => {
  const { box, dir, gamedev } = await profileBox()
  // Written with ~, as a shell alias would.
  const r = await runSpawn(box, ['--name', 'Level', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], {
    CLAUDE_CONFIG_DIR: '~/.claude-gamedev',
  })
  assert.equal(r.code, 0, r.stderr)
  const calls = callList(box)
  assert.equal(
    calls[0],
    `tab create --workspace wA --cwd ${dir} --label Level --env CLAUDE_CONFIG_DIR=${gamedev} --no-focus`,
  )
  assert.equal(calls[1], `pane run wA:p9 claude --session-id ${SID}`)
  expect(JSON.parse(readFileSync(panesFile(box), 'utf8'))).toMatchObject({ 'wA:p9': { profile: 'gamedev' } })
  expect(cardOf(box, SID)).toMatchObject({ profileWant: 'gamedev' })
}, 30_000)

test('refused before herdr is asked: a folder the board does not know, --profile nope, --profile gamedev, a profile folder that is gone, a --config-dir no profile has', async () => {
  const { box, home, dir } = await profileBox({}, home => [
    { id: 'gone', title: 'Gone', dir: join(home, '.claude-gone'), color: 'brown', hidden: false },
  ])
  const odd = join(box.dir, 'odd')
  mkdirSync(odd)
  const gone = join(home, '.claude-gone')
  const cases: [string[], Record<string, string>, string][] = [
    [
      [],
      { CLAUDE_CONFIG_DIR: odd },
      `this session's Claude folder ${odd} is not a profile the board knows: pass --profile <id>`,
    ],
    // Named relative to wherever the agent runs: never a profile.
    [
      [],
      { CLAUDE_CONFIG_DIR: '.claude-work' },
      "this session's Claude folder .claude-work is not a profile the board knows: pass --profile <id>",
    ],
    [['--profile', 'nope'], {}, 'no profile "nope": see the board\'s Settings → Profiles'],
    [['--profile', 'gamedev'], {}, 'the profile "gamedev" is hidden: show it on the board first'],
    [['--profile', 'gone'], {}, `the profile folder ${gone} is not there`],
    [[], { CLAUDE_CONFIG_DIR: gone }, `the profile folder ${gone} is not there`],
    // The board's own start in a listed profile whose folder is gone.
    [['--config-dir', gone], {}, `the profile folder ${gone} is not there`],
    // A folder no listed profile has, there or not: nothing could say which profile its session is in.
    [['--config-dir', odd], {}, notListed(odd)],
    [['--config-dir', join(home, '.claude-elsewhere')], {}, notListed(join(home, '.claude-elsewhere'))],
    // Named relative to the tab, it would be another folder there: no listed profile's.
    [['--config-dir', '.claude-work'], {}, notListed('.claude-work')],
  ]
  for (const [args, env, message] of cases) {
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', ...args], env)
    assert.equal(r.code, 1, `${args} ${JSON.stringify(env)}`)
    assert.equal(r.stderr.trim(), `spawn-agent: ${message}`)
    assert.deepEqual(box.calls(), [], message)
  }
  assert.equal(existsSync(panesFile(box)), false)
}, 60_000)

test('herdr that refuses --env: nothing was started', async () => {
  const { box, dir, work } = await profileBox()
  box.state({ ...STATE, 'tab create': { error: "unexpected argument '--env' found" } })
  const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], {
    CLAUDE_CONFIG_DIR: work,
  })
  assert.equal(r.code, 1)
  const last = r.stderr.trim().split('\n').at(-1) ?? ''
  assert.equal(
    last,
    'spawn-agent: herdr cannot set CLAUDE_CONFIG_DIR for the new tab (--env needs herdr 0.9.5 or newer): nothing was started',
  )
  assert.equal(failureKind(last), 'launcher')
  assert.deepEqual(
    box.calls().map(a => a.slice(0, 2).join(' ')),
    ['tab create'],
  )
  assert.equal(existsSync(panesFile(box)), false)
  assert.equal(cardOf(box, SID), null)
}, 30_000)

test('--keep-env leaves the tab as herdr makes it, even from a work env; --config-dir sets it as given', async () => {
  const kept = await profileBox()
  const r = await runSpawn(
    kept.box,
    ['--name', 'Keep', '--cwd', kept.dir, '--workspace', 'wA', '--session-id', SID, '--keep-env'],
    { CLAUDE_CONFIG_DIR: kept.work },
  )
  assert.equal(r.code, 0, r.stderr)
  const calls = callList(kept.box)
  assert.equal(calls[0], `tab create --workspace wA --cwd ${kept.dir} --label Keep --no-focus`)
  // The profile of the env it runs in gives its arguments.
  assert.equal(calls[1], `pane run wA:p9 claude --model sonnet --session-id ${SID}`)
  assert.equal(existsSync(panesFile(kept.box)), false)
  // The profile of the env it runs in is the one it is meant to be in.
  expect(cardOf(kept.box, SID)).toMatchObject({ profileWant: 'work' })

  // The board's start in a profile its own env does not point to.
  const set = await profileBox()
  const s = await runSpawn(set.box, [
    '--name',
    'Set',
    '--cwd',
    set.dir,
    '--workspace',
    'wA',
    '--session-id',
    SID,
    '--config-dir',
    set.work,
  ])
  assert.equal(s.code, 0, s.stderr)
  const setCalls = callList(set.box)
  assert.equal(
    setCalls[0],
    `tab create --workspace wA --cwd ${set.dir} --label Set --env CLAUDE_CONFIG_DIR=${set.work} --no-focus`,
  )
  assert.equal(setCalls[1], `pane run wA:p9 claude --model sonnet --session-id ${SID}`)
  expect(JSON.parse(readFileSync(panesFile(set.box), 'utf8'))).toMatchObject({ 'wA:p9': { profile: 'work' } })
  expect(cardOf(set.box, SID)).toMatchObject({ profileWant: 'work' })
}, 30_000)

test('--profile default starts the child as before, without --env, even from a work env', async () => {
  const { box, dir, work } = await profileBox({ claude: ['claude-tg', '--model', 'opus 4'] })
  const brief = join(box.dir, 'brief.txt')
  writeFileSync(brief, '\uFEFF-Check the invoices.\nThen report.\n')
  const r = await runSpawn(
    box,
    [
      ...['-Name', 'Acme invoices', '-Cwd', dir, '-Workspace', 'wA', '-BriefFile', brief, '--session-id', SID],
      ...['-Profile', 'default'],
    ],
    { CLAUDE_CONFIG_DIR: work },
  )
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2')
  // The default folder is the one herdr's env is taken to be: exactly the calls of the first test above.
  assert.deepEqual(callList(box), [
    `tab create --workspace wA --cwd ${dir} --label Acme invoices --no-focus`,
    `pane run wA:p9 claude-tg --model 'opus 4' --session-id ${SID}`,
    'pane get',
    'agent list',
    'agent rename wA:p9 acme-invoices-2',
    'agent prompt wA:p9 /rename Acme invoices',
    'pane read wA:p9 --source visible',
    'agent prompt wA:p9  -Check the invoices.\nThen report.',
  ])
  assert.equal(existsSync(panesFile(box)), false)
  // No --env, but the card says default is meant: herdr's env pointing elsewhere shows as the wrong profile.
  expect(cardOf(box, SID)).toMatchObject({ profileWant: 'default' })
}, 30_000)

/**
 * A profileBox whose pane wA:p9 waits at a shell prompt in tab wA:t9, holding the terminal
 * `terminal` (null: herdr does not say); `record` is written as profile-panes.json.
 */
async function paneBox(terminal: string | null, record?: Record<string, unknown>) {
  const b = await profileBox()
  const shell = { pane_id: 'wA:p9', tab_id: 'wA:t9', ...(terminal ? { terminal_id: terminal } : {}), agent: null }
  b.box.state({ ...STATE, 'pane get': { seq: [{ result: { pane: shell } }, READY] } })
  if (record) writePanes(b.box, record)
  return b
}
/** profile-panes.json, as herdr's launches left it. */
const writePanes = (box: Sandbox, record: Record<string, unknown>) => {
  mkdirSync(join(panesFile(box), '..'), { recursive: true })
  writeFileSync(panesFile(box), JSON.stringify(record))
}
const HERE = ['--name', 'Here', '--pane', 'wA:p9']
const notOpenedIn = (profile: string) =>
  `spawn-agent: --pane wA:p9 was not opened in profile ${profile}: leave out --pane to get a new tab`
const asked = (box: Sandbox) => box.calls().map(a => a.join(' '))

test('--pane with a profile takes only a pane recorded in it', async () => {
  // Not recorded at all, then recorded in another profile: refused before herdr is asked.
  const none = await paneBox('term-9')
  const unrecorded = await runSpawn(none.box, [...HERE, '--cwd', none.dir], { CLAUDE_CONFIG_DIR: none.work })
  assert.equal(unrecorded.code, 1)
  assert.equal(unrecorded.stderr.trim(), notOpenedIn('work'))
  writePanes(none.box, { 'wA:p9': { profile: 'gamedev', terminal: 'term-9', at: 1 } })
  const other = await runSpawn(none.box, [...HERE, '--cwd', none.dir], { CLAUDE_CONFIG_DIR: none.work })
  assert.equal(other.code, 1)
  assert.equal(other.stderr.trim(), notOpenedIn('work'))
  assert.deepEqual(none.box.calls(), [])

  // Recorded in work, and the pane still holds the terminal it was opened with.
  const same = await paneBox('term-9', { 'wA:p9': { profile: 'work', terminal: 'term-9', at: 1 } })
  const r = await runSpawn(same.box, [...HERE, '--cwd', same.dir], { CLAUDE_CONFIG_DIR: same.work })
  assert.equal(r.code, 0, r.stderr)
  const calls = asked(same.box)
  assert.equal(
    calls.some(c => c.startsWith('tab create')),
    false,
  )
  assert.ok(calls.includes('tab rename wA:t9 Here'))
  assert.ok(calls.includes('pane run wA:p9 claude --model sonnet'))
}, 60_000)

test('a start that leaves the env alone never takes a pane opened in another profile: Claude would run in that one', async () => {
  const record = { 'wA:p9': { profile: 'work', terminal: 'term-9', at: 1 } }
  // From the default env, and with --profile default from a work env: herdr is only asked which pane it is.
  for (const fromWork of [false, true]) {
    const b = await paneBox('term-9', record)
    const r = await runSpawn(
      b.box,
      [...HERE, '--cwd', b.dir, ...(fromWork ? ['--profile', 'default'] : [])],
      fromWork ? { CLAUDE_CONFIG_DIR: b.work } : {},
    )
    assert.equal(r.code, 1, String(fromWork))
    assert.equal(r.stderr.trim(), notOpenedIn('default'))
    assert.deepEqual(asked(b.box), ['pane get wA:p9'])
  }
}, 60_000)

test('a terminal herdr does not prove: a pane recorded in work is refused to a start that leaves the env alone, and to one in work', async () => {
  const cases: [string, string | null, Record<string, unknown>][] = [
    // The record names no terminal (herdr's tab create did not say one).
    ['no terminal recorded', 'term-9', { profile: 'work', at: 1 }],
    // herdr's pane get does not say which terminal the pane holds.
    ['no terminal from herdr', null, { profile: 'work', terminal: 'term-9', at: 1 }],
  ]
  for (const [why, terminal, entry] of cases) {
    const record = { 'wA:p9': entry }
    // From the default env: the pane could still be work's, where Claude would run in work.
    const plain = await paneBox(terminal, record)
    const r = await runSpawn(plain.box, [...HERE, '--cwd', plain.dir])
    assert.equal(r.code, 1, why)
    assert.equal(r.stderr.trim(), notOpenedIn('default'), why)
    assert.deepEqual(asked(plain.box), ['pane get wA:p9'], why)
    // The record stays to block the next start too.
    expect(JSON.parse(readFileSync(panesFile(plain.box), 'utf8'))).toEqual(record)
    // In work: nothing proves the pane is the one opened in work.
    const work = await paneBox(terminal, record)
    const w = await runSpawn(work.box, [...HERE, '--cwd', work.dir], { CLAUDE_CONFIG_DIR: work.work })
    assert.equal(w.code, 1, why)
    assert.equal(w.stderr.trim(), notOpenedIn('work'), why)
    assert.deepEqual(asked(work.box), ['pane get wA:p9'], why)
  }
}, 90_000)

test('a pane id herdr gave out again is not the pane it recorded: refused for work, a plain shell for default', async () => {
  // wA:p9 was opened in work; herdr started over and wA:p9 is now another terminal's, with herdr's env.
  const record = { 'wA:p9': { profile: 'work', terminal: 'term-1', at: 1 } }
  const work = await paneBox('term-9', record)
  const refused = await runSpawn(work.box, [...HERE, '--cwd', work.dir], { CLAUDE_CONFIG_DIR: work.work })
  assert.equal(refused.code, 1)
  assert.equal(refused.stderr.trim(), notOpenedIn('work'))
  // Nothing was typed or renamed: herdr was only asked which pane it is.
  assert.deepEqual(asked(work.box), ['pane get wA:p9'])

  const plain = await paneBox('term-9', record)
  const r = await runSpawn(plain.box, [...HERE, '--cwd', plain.dir])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(asked(plain.box).includes('pane run wA:p9 claude'))
}, 60_000)

test('a work agent’s helper types work’s start command, a string or a list, with --env and work’s args; launch.claude and launch.args go', async () => {
  const cases: [unknown, string][] = [
    ['cld-work', `cld-work --model sonnet --session-id ${SID}`],
    [' cld-work  --verbose ', `cld-work --verbose --model sonnet --session-id ${SID}`],
    [
      ['cld-work', '--append-system-prompt', 'be brief'],
      `cld-work --append-system-prompt 'be brief' --model sonnet --session-id ${SID}`,
    ],
  ]
  for (const [command, typed] of cases) {
    // No launch.claude: claudeCommand gives ['claude', '--x'], and the start command replaces all of it.
    const { box, dir, work } = await profileBox({ args: ['--x'] }, () => [], { work: { command } })
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], {
      CLAUDE_CONFIG_DIR: work,
    })
    assert.equal(r.code, 0, r.stderr)
    const calls = callList(box)
    assert.equal(
      calls[0],
      `tab create --workspace wA --cwd ${dir} --label Helper --env CLAUDE_CONFIG_DIR=${work} --no-focus`,
    )
    assert.equal(calls[1], `pane run wA:p9 ${typed}`)
    expect(cardOf(box, SID)).toMatchObject({ profileWant: 'work' })
  }
}, 60_000)
test('no start command, or a blank one, types launch.claude as before', async () => {
  for (const work of [{}, { command: '' }, { command: '   ' }, { command: null }]) {
    const { box, dir, work: workDir } = await profileBox({}, () => [], { work })
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], {
      CLAUDE_CONFIG_DIR: workDir,
    })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(callList(box)[1], `pane run wA:p9 claude --model sonnet --session-id ${SID}`, JSON.stringify(work))
  }
}, 60_000)
test('the board’s own profile types its start command too, its env left alone; --keep-env and --config-dir alike', async () => {
  const own = await profileBox({}, () => [], { default: { command: 'cld' } })
  const r = await runSpawn(own.box, [
    '--name',
    'Helper',
    '--cwd',
    own.dir,
    '--workspace',
    'wA',
    '--session-id',
    SID,
    '--keep-env',
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(callList(own.box).slice(0, 2), [
    `tab create --workspace wA --cwd ${own.dir} --label Helper --no-focus`,
    `pane run wA:p9 cld --session-id ${SID}`,
  ])
  const set = await profileBox({}, () => [], { work: { command: 'cld-work' } })
  const s = await runSpawn(set.box, [
    '--name',
    'Set',
    '--cwd',
    set.dir,
    '--workspace',
    'wA',
    '--session-id',
    SID,
    '--config-dir',
    set.work,
  ])
  assert.equal(s.code, 0, s.stderr)
  assert.equal(callList(set.box)[1], `pane run wA:p9 cld-work --model sonnet --session-id ${SID}`)
}, 60_000)
test('a start command that picks its session itself gets no --session-id', async () => {
  const { box, dir, work } = await profileBox({}, () => [], { work: { command: 'cld-work --resume' } })
  const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], {
    CLAUDE_CONFIG_DIR: work,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(callList(box)[1], 'pane run wA:p9 cld-work --resume --model sonnet')
}, 30_000)
test('a bad start command is refused before herdr is asked', async () => {
  const cases: [unknown, string][] = [
    ['-cld', 'A start command begins with a program, not “-cld”, which starts with a dash'],
    [
      "cld-work 'x'",
      'The start command’s argument "\'x\'" has a quote or a control character in it, which cannot be typed into a shell',
    ],
    [
      ['cld-work', 3],
      'A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]',
    ],
    [
      'env CLAUDE_CONFIG_DIR=/x claude',
      'A start command can’t set environment variables (“CLAUDE_CONFIG_DIR=/x”): the board sets CLAUDE_CONFIG_DIR for the profile itself. Put them in your alias',
    ],
  ]
  for (const [command, message] of cases) {
    const { box, dir, work } = await profileBox({}, () => [], { work: { command } })
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], {
      CLAUDE_CONFIG_DIR: work,
    })
    assert.equal(r.code, 1)
    assert.equal(r.stderr.trim(), `spawn-agent: ${message}`)
    assert.deepEqual(box.calls(), [], message)
  }
}, 60_000)

test('a new tab opened without --env drops the record of a pane of that id; other records stay', async () => {
  const { box, dir } = await profileBox()
  writePanes(box, {
    'wA:p9': { profile: 'work', terminal: 'term-1', at: 1 },
    'wB:p1': { profile: 'gamedev', terminal: 'term-5', at: 1 },
  })
  const r = await runSpawn(box, ['--name', 'Fresh', '--cwd', dir, '--workspace', 'wA', '--session-id', SID])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(callList(box)[0], `tab create --workspace wA --cwd ${dir} --label Fresh --no-focus`)
  expect(JSON.parse(readFileSync(panesFile(box), 'utf8'))).toEqual({
    'wB:p1': { profile: 'gamedev', terminal: 'term-5', at: 1 },
  })
  expect(cardOf(box, SID)).toMatchObject({ profileWant: 'default' })
}, 30_000)

// ---------------------------------------------------------------- --resume (the board's archive)

/** Claude's conversation of `session`, run in `cwd`, in the profile folder `claudeDir`. */
function transcript(claudeDir: string, cwd: string, session = SID): void {
  const project = join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${session}.jsonl`), `${JSON.stringify({ type: 'user', cwd, sessionId: session })}\n`)
}

test('spawn-agent --resume brings a session back by its id: no /rename, no brief, its herdr name', async () => {
  assert.equal((parseArgs(['--name', 'x', '--cwd', '.', '--resume', SID]) as { resume?: string }).resume, SID)
  assert.throws(() => parseArgs(['--name', 'x', '--cwd', '.', '--resume', 'abc']), /--resume must be a session id/)
  assert.throws(() => parseArgs(['--name', 'x', '--cwd', '.', '--resume', SID, '--session-id', SID]), /not both/)
  const box = await sandbox()
  box.state(STATE)
  boardConfig(box, { launch: { claude: ['claude-tg', '--dangerously-skip-permissions'] } })
  // Its conversation, in the one profile there is (an agent's resume runs where it ran).
  transcript(join(box.env.HOME as string, '.claude'), box.dir)
  const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', box.dir, '--workspace', 'wA', '--resume', SID])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2')
  const calls = box.calls().map(a => a.join(' '))
  assert.ok(calls.includes(`pane run wA:p9 claude-tg --dangerously-skip-permissions --resume ${SID}`), calls.join('\n'))
  assert.ok(calls.includes('agent rename wA:p9 acme-invoices-2'))
  assert.equal(
    calls.some(c => c.startsWith('agent prompt')),
    false,
  )
  // The default profile leaves herdr's env alone, as for any start in it.
  assert.equal(
    calls.some(c => c.includes('--env')),
    false,
  )
  // A launch.claude that picks its own session cannot resume another one.
  const box2 = await sandbox()
  box2.state(STATE)
  boardConfig(box2, { launch: { claude: ['claude', '--continue'] } })
  transcript(join(box2.env.HOME as string, '.claude'), box2.dir)
  const no = await runSpawn(box2, ['--name', 'x', '--cwd', box2.dir, '--workspace', 'wA', '--resume', SID])
  assert.equal(no.code, 1)
  assert.match(no.stderr, /picks its own session/)
  assert.deepEqual(box2.calls(), [])
}, 30_000)

test('an agent resumes a session in the profile whose folder holds its conversation: a work one gets --env work, the pane recorded, the card wants work', async () => {
  const { box, dir, work } = await profileBox()
  transcript(work, dir)
  // Whatever the agent's own profile is: the session's conversation decides.
  const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', dir, '--workspace', 'wA', '--resume', SID])
  assert.equal(r.code, 0, r.stderr)
  const calls = callList(box)
  assert.equal(
    calls[0],
    `tab create --workspace wA --cwd ${dir} --label Acme invoices --env CLAUDE_CONFIG_DIR=${work} --no-focus`,
  )
  assert.equal(calls[1], `pane run wA:p9 claude --model sonnet --resume ${SID}`)
  assert.equal(
    calls.some(c => c.startsWith('agent prompt')),
    false,
  )
  expect(JSON.parse(readFileSync(panesFile(box), 'utf8'))).toMatchObject({ 'wA:p9': { profile: 'work' } })
  expect(cardOf(box, SID)).toMatchObject({ profileWant: 'work' })
  // A default conversation from a work agent: default, without --env, never the agent's own folder.
  const second = await profileBox()
  transcript(second.default, second.dir)
  const own = await runSpawn(
    second.box,
    ['--name', 'Acme invoices', '--cwd', second.dir, '--workspace', 'wA', '--resume', SID],
    { CLAUDE_CONFIG_DIR: second.work },
  )
  assert.equal(own.code, 0, own.stderr)
  assert.equal(
    callList(second.box)[0],
    `tab create --workspace wA --cwd ${second.dir} --label Acme invoices --no-focus`,
  )
  expect(cardOf(second.box, SID)).toMatchObject({ profileWant: 'default' })
  // A hidden profile's conversation is its own: gamedev's resumes in gamedev.
  const third = await profileBox()
  transcript(third.gamedev, third.dir)
  const hidden = await runSpawn(third.box, [
    '--name',
    'Level',
    '--cwd',
    third.dir,
    '--workspace',
    'wA',
    '--resume',
    SID,
  ])
  assert.equal(hidden.code, 0, hidden.stderr)
  assert.equal(
    callList(third.box)[0],
    `tab create --workspace wA --cwd ${third.dir} --label Level --env CLAUDE_CONFIG_DIR=${third.gamedev} --no-focus`,
  )
}, 60_000)

test('an agent’s resume is refused before herdr is asked: --profile default for a work conversation, one not found, one in two profiles', async () => {
  const { box, dir, work } = await profileBox()
  transcript(work, dir)
  const named = await runSpawn(box, [
    '--name',
    'Acme invoices',
    '--cwd',
    dir,
    '--workspace',
    'wA',
    '--resume',
    SID,
    '--profile',
    'default',
  ])
  assert.equal(named.code, 1)
  assert.equal(
    named.stderr.trim(),
    `spawn-agent: The conversation of ${SID} is not in the profile default: a session is resumed only in the profile it ran in`,
  )
  assert.deepEqual(box.calls(), [])
  // The profile that holds it is taken when named.
  const inWork = await runSpawn(box, [
    '--name',
    'x',
    '--cwd',
    dir,
    '--workspace',
    'wA',
    '--resume',
    SID,
    '--profile',
    'work',
  ])
  assert.equal(inWork.code, 0, inWork.stderr)
  assert.match(callList(box)[0] ?? '', /--env CLAUDE_CONFIG_DIR=/)

  const other = await profileBox()
  const none = await runSpawn(
    other.box,
    ['--name', 'Acme invoices', '--cwd', other.dir, '--workspace', 'wA', '--resume', SID],
    { CLAUDE_CONFIG_DIR: other.work },
  )
  assert.equal(none.code, 1)
  assert.equal(
    none.stderr.trim(),
    'spawn-agent: “Acme invoices” cannot come back: its conversation is not on this computer any more',
  )
  transcript(other.default, other.dir)
  transcript(other.work, other.dir)
  const both = await runSpawn(other.box, ['--name', 'x', '--cwd', other.dir, '--workspace', 'wA', '--resume', SID])
  assert.equal(both.code, 1)
  assert.equal(
    both.stderr.trim(),
    `spawn-agent: The conversation of ${SID} is in more than one profile (default, work): pass --profile <id> to say which`,
  )
  // Nothing was asked of herdr, no card written.
  assert.deepEqual(other.box.calls(), [])
  assert.equal(cardOf(other.box, SID), null)
}, 60_000)

// A profile whose start command starts pi: herdr says pi came up, and the session is named and
// carded as pi's. pi's session is keyed by its file, whose name holds the id the start gave it.
const PI_FILE = `/home/me/.pi/agent/sessions/--w--/2026-10-20T08-15-48-746Z_${SID}.jsonl`
const PI_READY = {
  result: {
    pane: {
      pane_id: 'wA:p9',
      tab_id: 'wA:t9',
      agent: 'pi',
      agent_status: 'idle',
      agent_session: { agent: 'pi', kind: 'path', value: PI_FILE },
    },
  },
}
const PI_CARD = PI_FILE.replace(/[^A-Za-z0-9_-]/g, '_')

test('a start command that starts pi: pi is named with /name, briefed, and its file’s card wants the profile', async () => {
  const { box, dir } = await profileBox({}, () => [], { default: { command: 'pi' } })
  box.state({
    ...STATE,
    'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, PI_READY] },
    'pane read': { text: 'Session name set: Acme invoices' },
  })
  const args = ['--name', 'Acme invoices', '--cwd', dir, '--workspace', 'wA', '--brief', 'Check the invoices.']
  const r = await runSpawn(box, [...args, '--session-id', SID])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2 kind=pi')
  assert.deepEqual(callList(box), [
    `tab create --workspace wA --cwd ${dir} --label Acme invoices --no-focus`,
    `pane run wA:p9 pi --session-id ${SID}`,
    'pane get',
    'agent list',
    'agent rename wA:p9 acme-invoices-2',
    'agent prompt wA:p9 /name Acme invoices',
    'pane read wA:p9 --source visible',
    'agent prompt wA:p9 Check the invoices.',
  ])
  // The card is pi's, under its file; the one written under the id before pi was up is gone.
  expect(cardOf(box, PI_CARD)).toMatchObject({ key: PI_FILE, profileWant: 'default' })
  expect(cardOf(box, SID)).toBeNull()
}, 30_000)

test('pi’s first Enter takes the completion of /name: the line still in its editor gets one more', async () => {
  const { box, dir } = await profileBox({}, () => [], { default: { command: 'pi' } })
  box.state({
    ...STATE,
    'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, PI_READY] },
    'pane read': {
      seq: [
        { text: '> /name Acme invoices' },
        { text: '> /name Acme invoices' },
        { text: 'Session name set: Acme invoices' },
      ],
    },
  })
  const r = await runSpawn(box, ['--name', 'Acme invoices', '--cwd', dir, '--workspace', 'wA'])
  assert.equal(r.code, 0, r.stderr)
  const calls = callList(box)
  const named = calls.indexOf('agent prompt wA:p9 /name Acme invoices')
  expect(calls.slice(named)).toEqual([
    'agent prompt wA:p9 /name Acme invoices',
    'pane read wA:p9 --source visible',
    'pane read wA:p9 --source visible',
    'pane send-keys wA:p9 enter',
    'pane read wA:p9 --source visible',
  ])
  // Without --session-id no card is written, pi's or another.
  expect(cardOf(box, PI_CARD)).toBeNull()
}, 30_000)

test('pi waiting for a dialog before it is ready: said as pi’s, with /name to type, nothing typed', async () => {
  const { box, dir } = await profileBox({}, () => [], { default: { command: 'pi' } })
  box.state({
    ...STATE,
    'pane get': { result: { pane: { pane_id: 'wA:p9', agent: 'pi', agent_status: 'blocked' } } },
  })
  const r = await runSpawn(box, ['--name', 'Fresh', '--cwd', dir, '--workspace', 'wA', '--brief', 'Hi'])
  assert.equal(r.code, 1)
  assert.equal(
    r.stderr.trim(),
    'spawn-agent: pi in wA:p9 waits for a dialog. Answer it in that tab, then: herdr agent prompt wA:p9 "/name Fresh" and send the brief.',
  )
  // The board reads it as a dialog, as Claude's.
  assert.equal(failureKind(r.stderr), 'dialog')
  assert.equal(
    box.calls().some(a => a[0] === 'agent' && a[1] === 'prompt'),
    false,
  )
}, 30_000)
