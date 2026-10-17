import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { failureKind } from '../../src/core/launch/launcher-command.ts'
import { absoluteDir } from '../../src/services/launch/spawn-agent.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// spawn-agent end to end against the sandbox's fake herdr.
const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
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
