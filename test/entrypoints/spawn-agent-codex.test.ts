import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_NAMING } from '../../src/core/codex.ts'
import { codexCommand } from '../../src/core/launch/agents.ts'
import { parseArgs } from '../../src/core/launch/spawn-args.ts'
import { openInProfile } from '../../src/services/launch/launcher.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// spawn-agent --agent codex (#426, stage B): its command line, its start against the fake herdr,
// and what the other agents' starts must not pick up from it.
const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const SID = '01a1e9be-5ce4-7991-a753-2d63c38efc55'
const CODEX = (extra: Record<string, unknown> = {}) => ({
  result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'codex', agent_status: 'done', ...extra } },
})
const WITH_SESSION = CODEX({ agent_session: { agent: 'codex', kind: 'id', value: SID } })
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, CODEX(), CODEX(), WITH_SESSION] },
  'agent list': { result: { agents: [{ name: 'acme-invoices', pane_id: 'wB:p1' }, { pane_id: 'wA:p9' }] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  // What Codex's screen shows once /rename took: the name ends the status line.
  'pane read': { text: '  GPT-6.1-Sol low · /work/Acme · Acme invoices' },
  'pane send-keys': { result: null },
}

async function runSpawn(box: Sandbox, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, SPAWN, ...args], {
    cwd: root,
    env: { ...box.env, BOARD_TEST_PACE: '0.02', ...extra },
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

/** Codex's model list, as ~/.codex/models_cache.json has it. */
function modelCache(box: Sandbox) {
  const dir = join(box.env.HOME as string, '.codex')
  mkdirSync(dir, { recursive: true })
  const levels = ['low', 'medium', 'high'].map(effort => ({ effort }))
  writeFileSync(
    join(dir, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: levels }] }),
  )
}

async function codexBox(cfg: unknown = {}, state: unknown = STATE) {
  const box = await sandbox()
  box.state(state)
  boardConfig(box, cfg)
  modelCache(box)
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  return { box, dir }
}

const callList = (box: Sandbox) => {
  const calls = box.calls().map(a => (a.slice(0, 2).join(' ') === 'pane get' ? 'pane get' : a.join(' ')))
  return calls.filter((c, i) => c !== 'pane get' || calls[i - 1] !== 'pane get')
}
const cardOf = (box: Sandbox, key: string): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

const BASE = ['--name', 'Acme invoices', '--cwd', '/work/Acme']

test('--agent codex: its options are parsed, and nothing that is only Claude’s is taken with it', () => {
  expect(
    parseArgs([
      ...BASE,
      '--agent',
      'Codex',
      '--model',
      'gpt-6.1-sol',
      '--effort',
      'high',
      '--approval',
      'on-request',
      '--sandbox',
      'workspace-write',
    ]),
  ).toMatchObject({
    agent: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    approval: 'on-request',
    sandbox: 'workspace-write',
  })
  const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
  for (const [flags, shown] of [
    [['--resume', SESSION], '--resume'],
    [['--fork', SESSION], '--fork'],
    [['--session-id', SESSION], '--session-id'],
    [['--profile', 'work'], '--profile'],
    [['--config-dir', '/x'], '--config-dir'],
    [['--keep-env'], '--keep-env'],
    [['--trust'], '--trust'],
    [['--resume', SESSION, '--trust'], '--resume, --trust'],
  ] as const)
    expect(() => parseArgs([...BASE, '--agent', 'codex', ...flags])).toThrow(
      `--agent codex starts a new Codex session: give it no ${shown}`,
    )
  expect(() => parseArgs([...BASE, '--agent', 'codex', '--approval', 'untrusted'])).toThrow(/--approval must be/)
  expect(() => parseArgs([...BASE, '--agent', 'codex', '--sandbox', 'none'])).toThrow(/--sandbox must be/)
  expect(() => parseArgs([...BASE, '--agent', 'codex', '--effort', 'very high'])).toThrow(/--effort must be/)
  expect(() => parseArgs([...BASE, '--agent', 'gemini'])).toThrow('--agent must be claude, pi or codex')
})

test('Codex’s options are for Codex: any other agent, and none, refuses them; their own flags are as they were', () => {
  for (const agent of [[], ['--agent', 'claude'], ['--agent', 'pi']])
    for (const flag of ['--effort', '--approval', '--sandbox'])
      expect(() => parseArgs([...BASE, ...agent, flag, 'low'])).toThrow(`${flag} is for --agent codex`)
  const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
  // As on the commit before: pi refuses --resume, Claude takes the rest with no agent named.
  expect(() => parseArgs([...BASE, '--agent', 'pi', '--resume', SESSION])).toThrow(/--agent pi starts a new session/)
  const claude = parseArgs([...BASE, '--resume', SESSION, '--profile', 'work', '--trust'])
  expect(claude).toMatchObject({ resume: SESSION, profile: 'work', trust: true })
  expect(claude).not.toHaveProperty('agent')
  expect(parseArgs([...BASE, '--agent', 'pi', '--model', 'a/b'])).toMatchObject({ agent: 'pi', model: 'a/b' })
  // A Windows folder, a name with spaces, Cyrillic and %: as given.
  expect(
    parseArgs(['--name', 'Тест 100%', '--cwd', 'C:\\Рабочие файлы\\Acme project', '--agent', 'codex']),
  ).toMatchObject({ name: 'Тест 100%', cwd: 'C:\\Рабочие файлы\\Acme project', agent: 'codex' })
})

test('launch.codex is the program and its arguments, codex when it is unset', () => {
  expect(codexCommand(undefined)).toEqual(['codex'])
  expect(codexCommand('  ')).toEqual(['codex'])
  expect(codexCommand('/opt/bin/codex')).toEqual(['/opt/bin/codex'])
  expect(codexCommand(['codex', '--search'])).toEqual(['codex', '--search'])
  expect(() => codexCommand(['codex', "it's"])).toThrow(/launch\.codex/)
  expect(() => codexCommand(7)).toThrow(/launch\.codex/)
})

test('Codex shows its name at the end of the status line: that is what /rename took', () => {
  const shown = '  GPT-6.1-Sol low · /work/Acme · Acme invoices\n  ← for agents'
  expect(CODEX_NAMING.doneFor?.('Acme invoices').test(shown)).toBe(true)
  expect(CODEX_NAMING.doneFor?.('Acme  invoices').test(shown)).toBe(true)
  expect(CODEX_NAMING.doneFor?.('Other').test(shown)).toBe(false)
  // A name with regex characters, and one the status line cuts.
  expect(CODEX_NAMING.doneFor?.('Case (100%) [a+b]').test('x · /w · Case (100%) [a+b]')).toBe(true)
  expect(CODEX_NAMING.doneFor?.('Тест 100%').test('x · /w · Тест 100%')).toBe(true)
  expect(() => CODEX_NAMING.doneFor?.('\\'.repeat(45))).not.toThrow()
})

test('spawn-agent --agent codex: codex in a new tab, named with /rename, briefed; no env, no session id', async () => {
  const { box, dir } = await codexBox()
  const r = await runSpawn(box, [
    '--name',
    'Acme invoices',
    '--cwd',
    dir,
    '--workspace',
    'wA',
    '--agent',
    'codex',
    '--model',
    'gpt-6.1-sol',
    '--brief',
    '-Check the invoices.',
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2 kind=codex')
  assert.deepEqual(callList(box), [
    `tab create --workspace wA --cwd ${dir} --label Acme invoices --no-focus`,
    'pane run wA:p9 codex --model gpt-6.1-sol',
    'pane get',
    'agent list',
    'agent rename wA:p9 acme-invoices-2',
    'agent prompt wA:p9 /rename Acme invoices',
    'pane read wA:p9 --source visible',
    'agent prompt wA:p9  -Check the invoices.',
    'pane get',
  ])
  // Codex has its id only after the first prompt: the card of the model is written under it then.
  expect(cardOf(box, SID)).toMatchObject({ key: SID, modelWant: 'gpt-6.1-sol' })
}, 30_000)

/** A `codex` on PATH that answers --help with `help`. */
function fakeCodex(box: Sandbox, help: string): Record<string, string> {
  const bin = join(box.dir, 'bin-codex')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\necho '${help}'\n`, { mode: 0o755 })
  return { PATH: `${bin}:${box.env.PATH}` }
}

test('a Codex that takes --no-daemon gets it, so the session runs with the pane’s env and herdr learns its id; one that does not, or a line that has it, is left as it is', async () => {
  if (process.platform === 'win32') return
  const ask = (box: Sandbox, dir: string, env: Record<string, string>) =>
    runSpawn(
      box,
      ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--agent', 'codex', '--model', 'gpt-6.1-sol'],
      env,
    )
  const yes = await codexBox()
  const r = await ask(
    yes.box,
    yes.dir,
    fakeCodex(yes.box, '      --no-daemon\n          Run without the shared background server'),
  )
  assert.equal(r.code, 0, r.stderr)
  assert.equal(callList(yes.box)[1], 'pane run wA:p9 codex --no-daemon --model gpt-6.1-sol')
  const old = await codexBox()
  await ask(old.box, old.dir, fakeCodex(old.box, '      --search'))
  assert.equal(callList(old.box)[1], 'pane run wA:p9 codex --model gpt-6.1-sol')
  const own = await codexBox({ launch: { codex: ['codex', '--no-daemon'] } })
  await ask(own.box, own.dir, fakeCodex(own.box, '      --no-daemon'))
  assert.equal(callList(own.box)[1], 'pane run wA:p9 codex --no-daemon --model gpt-6.1-sol')
}, 60_000)

test('--effort, --approval and --sandbox become -c, -a and -s after the model; launch.codex is typed first', async () => {
  const { box, dir } = await codexBox({ launch: { codex: ['codex', '--search'] } })
  const r = await runSpawn(box, [
    '--name',
    'Acme invoices',
    '--cwd',
    dir,
    '--workspace',
    'wA',
    '--agent',
    'codex',
    '--model',
    'gpt-6.1-sol',
    '--effort',
    'high',
    '--approval',
    'on-request',
    '--sandbox',
    'workspace-write',
  ])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(
    callList(box)[1],
    'pane run wA:p9 codex --search --model gpt-6.1-sol -c model_reasoning_effort=high -a on-request -s workspace-write',
  )
}, 30_000)

test('with no options Codex is started as it is: the user’s config.toml decides, nothing is passed', async () => {
  const { box, dir } = await codexBox()
  const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--agent', 'codex'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(callList(box)[0], `tab create --workspace wA --cwd ${dir} --label Helper --no-focus`)
  assert.equal(callList(box)[1], 'pane run wA:p9 codex')
  // No brief and no model: nothing waits for a session id, and no card is made.
  expect(callList(box).filter(c => c === 'pane get')).toHaveLength(1)
}, 30_000)

test('codexHome in config.json is CODEX_HOME of the new tab; without it the tab has no env', async () => {
  const home = '/Users/me/.config/herdr/codex 100%'
  const set = await codexBox({ codexHome: home })
  const r = await runSpawn(set.box, ['--name', 'Helper', '--cwd', set.dir, '--workspace', 'wA', '--agent', 'codex'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(
    callList(set.box)[0],
    `tab create --workspace wA --cwd ${set.dir} --label Helper --env CODEX_HOME=${home} --no-focus`,
  )
  // A pane keeps the env it has: with the home set, --pane is refused before herdr is asked.
  const pane = await runSpawn(set.box, ['--name', 'Helper', '--cwd', set.dir, '--pane', 'wA:p3', '--agent', 'codex'])
  assert.equal(pane.code, 1)
  assert.match(pane.stderr, /--pane keeps the env the pane has, so it cannot get CODEX_HOME/)
  // Blank, or not a string: none.
  for (const codexHome of ['', 7, null]) {
    const none = await codexBox({ codexHome })
    await runSpawn(none.box, ['--name', 'Helper', '--cwd', none.dir, '--workspace', 'wA', '--agent', 'codex'])
    assert.equal(callList(none.box)[0], `tab create --workspace wA --cwd ${none.dir} --label Helper --no-focus`)
  }
}, 60_000)

test('an effort needs a model whose levels Codex lists; refused before herdr is asked', async () => {
  const { box, dir } = await codexBox()
  const ask = (...extra: string[]) =>
    runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--agent', 'codex', ...extra])
  const none = await ask('--effort', 'high')
  assert.match(none.stderr, /--effort needs --model/)
  const unknown = await ask('--model', 'gpt-9', '--effort', 'high')
  assert.match(unknown.stderr, /no model gpt-9/)
  const bad = await ask('--model', 'gpt-6.1-sol', '--effort', 'extreme')
  assert.match(bad.stderr, /--effort extreme: gpt-6.1-sol takes low, medium, high/)
  assert.deepEqual(box.calls(), [])
}, 30_000)

test('Codex waiting for a dialog, or never coming up: said as Codex’s; another agent in the tab is not taken for it', async () => {
  const blocked = await codexBox(
    {},
    {
      ...STATE,
      'pane get': {
        seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, CODEX({ agent_status: 'blocked' })],
      },
    },
  )
  const b = await runSpawn(blocked.box, [
    ...['--name', 'Helper', '--cwd', blocked.dir, '--workspace', 'wA', '--agent', 'codex'],
  ])
  assert.equal(b.code, 1)
  assert.match(b.stderr, /Codex in wA:p9 waits for a dialog .*\/rename Helper/)
  const claude = await codexBox(
    {},
    { ...STATE, 'pane get': { result: { pane: { pane_id: 'wA:p9', agent: 'claude', agent_status: 'idle' } } } },
  )
  const c = await runSpawn(claude.box, [
    ...['--name', 'Helper', '--cwd', claude.dir, '--workspace', 'wA', '--agent', 'codex', '--timeout-sec', '1'],
  ])
  assert.equal(c.code, 1)
  assert.match(c.stderr, /Codex did not get ready in wA:p9 within 1 s/)
  expect(claude.box.calls().some(a => a[0] === 'agent' && a[1] === 'prompt')).toBe(false)
}, 30_000)

// openInProfile: what a start from the board's window opens its tab or workspace with.
const dirs: string[] = []
const savedAppData = process.env.APPDATA
afterEach(() => {
  if (savedAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = savedAppData
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function withConfig(config: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), 'codex-env-'))
  dirs.push(dir)
  process.env.APPDATA = join(dir, 'config')
  const file = join(dir, 'config/herdr/plugins/config/agent-board/config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(config))
}

const envOf = (l: Parameters<typeof openInProfile>[0]) => openInProfile(l, async env => env)

test('a Codex start from the board’s window opens its tab with CODEX_HOME when config.json names a home; no one else does', async () => {
  withConfig({ codexHome: '/h/codex 100%' })
  expect(await envOf({ configDir: null, agent: 'codex' })).toEqual({ CODEX_HOME: '/h/codex 100%' })
  // Claude and pi: the env is what it was, whatever config.json says about Codex.
  expect(await envOf({ configDir: null, agent: 'claude' })).toBeUndefined()
  expect(await envOf({ configDir: null, agent: 'pi' })).toBeUndefined()
  expect(await envOf({ configDir: null })).toBeUndefined()
  expect(await envOf({ configDir: '/c/Рабочий профиль', agent: 'claude' })).toEqual({
    CLAUDE_CONFIG_DIR: '/c/Рабочий профиль',
  })
  // A fork is looked up where it was made: it keeps the env it had.
  expect(await envOf({ configDir: null, agent: 'codex', codexFork: true })).toBeUndefined()
  withConfig({})
  expect(await envOf({ configDir: null, agent: 'codex' })).toBeUndefined()
})

test('herdr without --env: a Codex start says CODEX_HOME, not the Claude profile', async () => {
  withConfig({ codexHome: '/h/codex' })
  const old = async () => {
    throw new Error("error: unexpected argument '--env' found")
  }
  await expect(openInProfile({ configDir: null, agent: 'codex' }, old)).rejects.toThrow(/CODEX_HOME=\/h\/codex/)
  await expect(openInProfile({ configDir: null, agent: 'claude' }, old)).rejects.toThrow(/unexpected argument/)
})
