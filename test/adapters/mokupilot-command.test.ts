// How the board would start MokuPilot (adapters/setup-facts.ts mokupilotCommand) and the command
// line of a call (core/mokupilot.ts callCommand): upstream's test/mokupilot.test.mjs (#44), its
// first two tests, with the platform's own paths whatever system runs them.
import { beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mokupilotCommand } from '../../src/adapters/setup-facts.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { callCommand } from '../../src/core/mokupilot.ts'

beforeEach(() => {
  useLanguage('en')
})
const ID = '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'
const has =
  (...files: string[]) =>
  (f: string) =>
    files.includes(f)

/** The launcher, when it was found. */
function found(launcher: ReturnType<typeof mokupilotCommand>) {
  if (launcher.state !== 'ok') throw new Error(`not found: ${JSON.stringify(launcher)}`)
  return launcher
}

test('MokuPilot on Windows: the installed MokuPilot.exe first, else the checkout of meet.cmd on PATH, run by its own Python', () => {
  const local = 'C:\\Users\\u\\AppData\\Local'
  const exe = `${local}\\Programs\\MokuPilot\\MokuPilot.exe`
  const win = (exists: (f: string) => boolean, over: Record<string, string> = {}) =>
    mokupilotCommand(
      {},
      {
        platform: 'win32',
        env: { LOCALAPPDATA: local, PATH: 'C:\\Windows;C:\\src\\MokuPilot', PATHEXT: '.EXE;.CMD', ...over },
        exists,
      },
    )
  assert.deepEqual(win(has(exe, 'C:\\src\\MokuPilot\\meet.cmd')), {
    state: 'ok',
    configured: false,
    file: exe,
    args: [],
  })
  // meet.cmd stands for its checkout: Bun runs no .cmd without a shell, so its .venv's pythonw runs run.py.
  const repo = ['C:\\src\\MokuPilot\\meet.cmd', 'C:\\src\\MokuPilot\\run.py']
  assert.deepEqual(win(has(...repo, 'C:\\src\\MokuPilot\\.venv\\Scripts\\pythonw.exe')), {
    state: 'ok',
    configured: false,
    file: 'C:\\src\\MokuPilot\\.venv\\Scripts\\pythonw.exe',
    args: ['C:\\src\\MokuPilot\\run.py'],
  })
  assert.equal(
    found(win(has(...repo, 'C:\\src\\MokuPilot\\.venv\\Scripts\\python.exe'))).file,
    'C:\\src\\MokuPilot\\.venv\\Scripts\\python.exe',
  )
  // No .venv: the Python on PATH, as meet.cmd falls back to it.
  assert.equal(
    found(win(has(...repo, 'C:\\Python\\python.exe'), { PATH: 'C:\\Python;C:\\src\\MokuPilot' })).file,
    'C:\\Python\\python.exe',
  )
  assert.deepEqual(win(has()), { state: 'missing', configured: false, file: 'MokuPilot.exe, meet.cmd' })
  // A folder in config.json.
  const dir = mokupilotCommand(
    { mokupilot: { dir: 'D:\\MokuPilot' } },
    {
      platform: 'win32',
      env: { PATH: '' },
      exists: has('D:\\MokuPilot\\run.py', 'D:\\MokuPilot\\.venv\\Scripts\\pythonw.exe'),
    },
  )
  assert.deepEqual(dir, {
    state: 'ok',
    configured: true,
    file: 'D:\\MokuPilot\\.venv\\Scripts\\pythonw.exe',
    args: ['D:\\MokuPilot\\run.py'],
  })
  assert.deepEqual(
    mokupilotCommand({ mokupilot: { dir: 'D:\\Nope' } }, { platform: 'win32', env: { PATH: '' }, exists: has() }),
    { state: 'missing', configured: true, file: 'D:\\Nope\\run.py' },
  )
})

test('MokuPilot on macOS and Linux: `meet` on PATH or in the configured checkout; off, and a command of its own', () => {
  assert.deepEqual(
    mokupilotCommand(
      {},
      { platform: 'darwin', env: { PATH: '/usr/bin:/usr/local/bin' }, exists: has('/usr/local/bin/meet') },
    ),
    { state: 'ok', configured: false, file: '/usr/local/bin/meet', args: [] },
  )
  assert.deepEqual(mokupilotCommand({}, { platform: 'linux', env: { PATH: '/usr/bin' }, exists: has() }), {
    state: 'missing',
    configured: false,
    file: 'meet',
  })
  assert.deepEqual(
    mokupilotCommand(
      { mokupilot: { dir: '/home/u/mokupilot' } },
      { platform: 'linux', env: { PATH: '' }, exists: has('/home/u/mokupilot/meet') },
    ),
    { state: 'ok', configured: true, file: '/home/u/mokupilot/meet', args: [] },
  )
  assert.deepEqual(
    mokupilotCommand({ mokupilot: false }, { platform: 'linux', env: { PATH: '/usr/local/bin' }, exists: () => true }),
    { state: 'off', configured: true },
  )

  const own = mokupilotCommand(
    { mokupilot: { command: ['/opt/mp/MokuPilot', '--profile', 'work'] } },
    { platform: 'linux', env: { PATH: '' }, exists: has('/opt/mp/MokuPilot') },
  )
  assert.deepEqual(own, {
    state: 'ok',
    configured: true,
    file: '/opt/mp/MokuPilot',
    args: ['--profile', 'work'],
    template: null,
  })
  assert.deepEqual(callCommand(found(own), { session: ID, cwd: '/w/acme' }), {
    file: '/opt/mp/MokuPilot',
    args: ['--profile', 'work', 'call', '--claude-session', ID, '--cwd', '/w/acme'],
  })
  assert.deepEqual(callCommand(found(own), { session: ID }).args.slice(2), ['call', '--claude-session', ID])
  // With values in it, the command is the whole line; a group without its value is left out.
  const line = mokupilotCommand(
    { mokupilot: { command: ['mp', 'start', '--fork={session}', ['--in', '{cwd}']] } },
    { platform: 'linux', env: { PATH: '/opt/bin' }, exists: has('/opt/bin/mp') },
  )
  assert.deepEqual(callCommand(found(line), { session: ID, cwd: '/w/acme' }), {
    file: '/opt/bin/mp',
    args: ['start', `--fork=${ID}`, '--in', '/w/acme'],
  })
  assert.deepEqual(callCommand(found(line), { session: ID, cwd: '' }).args, ['start', `--fork=${ID}`])
  const unknown = mokupilotCommand(
    { mokupilot: { command: ['mp', '{name}'] } },
    { platform: 'linux', env: { PATH: '/opt/bin' }, exists: has('/opt/bin/mp') },
  )
  assert.throws(() => callCommand(found(unknown), { session: ID }), /\{name\}/)
  // Never a shell: cmd and .cmd files are refused, as for launch.command.
  const shell = mokupilotCommand(
    { mokupilot: { command: ['C:\\src\\MokuPilot\\meet.cmd'] } },
    { platform: 'win32', env: { PATH: '' }, exists: () => true },
  )
  assert.match(shell.state === 'missing' ? (shell.error ?? '') : '', /not cmd/)
  const notList = mokupilotCommand(
    { mokupilot: { command: 'meet' } },
    { platform: 'linux', env: { PATH: '' }, exists: () => true },
  )
  assert.match(notList.state === 'missing' ? (notList.error ?? '') : '', /a list/)
})

test('a .cmd or .bat found on PATH is not started either: a command by its name is refused plainly, a Python shim passed over', () => {
  const win = (cfg: Parameters<typeof mokupilotCommand>[0], exists: (f: string) => boolean, PATH: string) =>
    mokupilotCommand(cfg, { platform: 'win32', env: { PATH, PATHEXT: '.EXE;.BAT;.CMD' }, exists })
  // ["meet"] is meet.cmd on PATH: the same words as for one written so, not Windows' EINVAL at the start.
  const meet = 'C:\\src\\MokuPilot\\meet.cmd'
  assert.deepEqual(win({ mokupilot: { command: ['meet'] } }, has(meet), 'C:\\src\\MokuPilot'), {
    state: 'missing',
    configured: true,
    file: meet,
    error: 'mokupilot.command in config.json: a program, not cmd or a .cmd or .bat file',
  })
  // A program by its name on PATH still is one.
  const exe = 'D:\\mp\\MokuPilot.exe'
  assert.equal(found(win({ mokupilot: { command: ['MokuPilot'] } }, has(exe), 'D:\\mp')).file, exe)
  // A checkout without its .venv runs the Python on PATH, but not pyenv's python.bat shim.
  const repo = { mokupilot: { dir: 'D:\\MokuPilot' } }
  const run = 'D:\\MokuPilot\\run.py'
  const shims = 'C:\\pyenv\\shims'
  assert.deepEqual(win(repo, has(run, `${shims}\\pythonw.bat`, `${shims}\\python.bat`), shims), {
    state: 'missing',
    configured: true,
    file: 'D:\\MokuPilot\\.venv\\Scripts\\pythonw.exe',
  })
  const python = 'C:\\Python\\python.exe'
  assert.equal(found(win(repo, has(run, `${shims}\\pythonw.bat`, python), `${shims};C:\\Python`)).file, python)
})

test('{ link: true }: a link for the viewer’s browser, nothing looked for here, before command and dir', () => {
  const nothing = () => false
  for (const platform of ['linux', 'win32', 'darwin']) {
    const opts = { platform, env: { PATH: '' }, exists: nothing }
    assert.deepEqual(mokupilotCommand({ mokupilot: { link: true } }, opts), { state: 'link', configured: true })
    assert.deepEqual(mokupilotCommand({ mokupilot: { link: true, command: ['/opt/mp/MokuPilot'] } }, opts), {
      state: 'link',
      configured: true,
    })
    assert.deepEqual(mokupilotCommand({ mokupilot: { link: true, dir: '/opt/mp' } }, opts), {
      state: 'link',
      configured: true,
    })
    // Anything but true is no link: the setting as it was without it.
    for (const link of [false, 'true', 1, null])
      assert.deepEqual(
        mokupilotCommand({ mokupilot: { link, command: ['/opt/mp/MokuPilot'] } }, opts),
        mokupilotCommand({ mokupilot: { command: ['/opt/mp/MokuPilot'] } }, opts),
      )
    assert.deepEqual(mokupilotCommand({ mokupilot: false }, opts), { state: 'off', configured: true })
  }
})
