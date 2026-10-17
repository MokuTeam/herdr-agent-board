import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  type InstallPaths,
  planSettings,
  planShims,
  quote,
  shimTarget,
  toastCommand,
} from '../../src/core/install-plan.ts'
import {
  type BoardFiles,
  boardFiles,
  boardKey,
  checkSetup,
  report,
  type SetupCheck,
  type SetupFacts,
  setupSummary,
  todo,
  tomlValue,
} from '../../src/core/setup.ts'

const ROOT_A = 'C:\\plugins\\agent-board'
const ROOT_B = 'C:\\plugins\\mokuteam.herdr-agent-board-1a2b'
const BUN = 'C:\\Users\\u\\.bun\\bin\\bun.exe'
const files = boardFiles(ROOT_A)
const pathsOf = (root: string): InstallPaths => ({ bun: BUN, ...boardFiles(root), binDir: 'C:\\Users\\u\\.local\\bin' })
const hookCommand = (f: BoardFiles) => `${quote(BUN)} ${quote(f.hook)}`
type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[] | undefined> }
const commands = (settings: unknown, event: string) =>
  ((settings as Settings).hooks[event] ?? []).flatMap(e => e.hooks.map(h => h.command))

describe('install: the settings it writes', () => {
  test('its hooks once, everyone else’s kept, its own moved to this copy', () => {
    const theirs = {
      model: 'opus',
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'python recall.py' }] },
          { hooks: [{ type: 'command', command: hookCommand(boardFiles(ROOT_B)), timeout: 10 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'python ingest.py' }] }],
      },
      statusLine: { type: 'command', command: 'my-status' },
    }
    const once = planSettings(theirs, pathsOf(ROOT_A))
    assert.equal(once.statusLineSet, false)
    assert.equal(once.toast, false)
    assert.equal(once.settings.model, 'opus')
    assert.deepEqual(once.settings.statusLine, theirs.statusLine)
    assert.deepEqual(commands(once.settings, 'SessionStart'), ['python recall.py', hookCommand(files)])
    assert.deepEqual(commands(once.settings, 'UserPromptSubmit'), [hookCommand(files)])
    assert.deepEqual(commands(once.settings, 'Stop'), ['python ingest.py'])
    assert.deepEqual(planSettings(once.settings, pathsOf(ROOT_A)).settings, once.settings) // idempotent
    assert.deepEqual(theirs.hooks.SessionStart.length, 2) // the input is left alone

    // Notifications: on, kept on (pointed at the copy that installs), off.
    const on = planSettings(once.settings, pathsOf(ROOT_B), { toast: true }).settings
    const hooks = (on as Settings).hooks
    assert.deepEqual(hooks.Stop?.at(-1), {
      hooks: [{ type: 'command', command: toastCommand(boardFiles(ROOT_B).toast), timeout: 30, async: true }],
    })
    assert.equal(hooks.Notification?.[0]?.matcher, 'permission_prompt|elicitation_dialog')
    assert.equal(hooks.PreToolUse?.[0]?.matcher, 'AskUserQuestion')
    const kept = planSettings(on, pathsOf(ROOT_A))
    assert.equal(kept.toast, true)
    assert.deepEqual(commands(kept.settings, 'PreToolUse'), [toastCommand(files.toast)])
    assert.deepEqual(commands(kept.settings, 'Stop'), ['python ingest.py', toastCommand(files.toast)])
    const off = planSettings(kept.settings, pathsOf(ROOT_A), { toast: false }).settings
    assert.deepEqual(commands(off, 'Stop'), ['python ingest.py'])
    assert.equal((off as Settings).hooks.Notification, undefined)

    // No status line yet, or the board's own from another copy: the board's, with forward slashes.
    assert.deepEqual(planSettings({}, pathsOf(ROOT_A)).settings.statusLine, {
      type: 'command',
      command: `${quote(BUN)} ${quote(files.statusline)}`,
    })
    const other = { statusLine: { command: `node "${boardFiles(ROOT_B).statusline}"` } }
    assert.equal(planSettings(other, pathsOf(ROOT_A)).statusLineSet, true)
    // Not an object where hooks should be: upstream replaces it; this branch refuses and leaves
    // settings.json as it was (core/install-plan.ts, kept from the port of main's install).
    assert.throws(() => planSettings({ hooks: [] }, pathsOf(ROOT_A)), /"hooks" is not an object/)
  })

  test('a board in a folder of another name: its own entries known by the files they run', () => {
    const root = 'D:\\work\\board'
    const notified = planSettings({}, pathsOf(root), { toast: true }).settings
    const again = planSettings(notified, pathsOf(root))
    assert.equal(again.toast, true)
    assert.deepEqual(again.settings, notified)
    assert.deepEqual(commands(again.settings, 'SessionStart'), [hookCommand(boardFiles(root))])
  })

  test('a hook list that is not a list: refused when notifications go in, left alone when they stay off', () => {
    const odd = { hooks: { Stop: { not: 'a list' } } }
    assert.deepEqual(planSettings(odd, pathsOf(ROOT_A)).settings.hooks, {
      SessionStart: [{ hooks: [{ type: 'command', command: hookCommand(files), timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand(files), timeout: 10 }] }],
      Stop: { not: 'a list' },
    })
    assert.throws(() => planSettings(odd, pathsOf(ROOT_A), { toast: true }), /not a list/)
  })
})

describe('command files', () => {
  test('what they run, and which ones are the board’s', () => {
    const shims = planShims(pathsOf(ROOT_A))
    assert.deepEqual(Object.keys(shims), ['board', 'board.cmd', 'spawn-agent', 'spawn-agent.cmd'])
    assert.equal(shimTarget(shims['spawn-agent.cmd']), files.spawn)
    assert.equal(shimTarget(shims['spawn-agent']), files.spawn.replace(/\\/g, '/'))
    assert.equal(shimTarget(shims['board.cmd']), files.cli)
    assert.match(shims.board, /^#!\/bin\/sh\n/)
    assert.equal(shimTarget('#!/bin/sh\nexec pwsh -File spawn-agent.ps1 "$@"'), null)
    // main's command files: node and the script.
    assert.equal(shimTarget('@rem agent-board\r\n@node "C:\\b\\src\\cli.mjs" %*\r\n'), 'C:\\b\\src\\cli.mjs')
    assert.equal(shimTarget('#!/bin/sh\n# agent-board\nexec node "C:/b/src/spawn.mjs" "$@"\n'), 'C:/b/src/spawn.mjs')
  })
})

describe('herdr’s config', () => {
  test('the board’s key, and a value in a section', () => {
    const toml = `onboarding = false\n\n[ui.toast]\ndelivery = "system" # loud\n\n[[keys.command]]\nkey = "prefix+g"\ntype = "shell"\ncommand = "lazygit"\n\n[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\n`
    assert.equal(boardKey(toml), 'prefix+a')
    assert.equal(boardKey('[[keys.command]]\nkey = "x"\ncommand = "other.open"\n'), null)
    assert.equal(boardKey(null), null)
    assert.equal(tomlValue(toml, 'ui.toast', 'delivery'), 'system')
    assert.equal(tomlValue(toml, 'ui', 'delivery'), undefined)
    assert.equal(tomlValue('[ui.toast]\n# delivery = "herdr"\n', 'ui.toast', 'delivery'), undefined)
  })
})

// What gatherFacts would find on a computer set up all the way, to spoil one thing at a time.
function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  const ours = (name: string) => ({
    file: `C:\\Users\\u\\.local\\bin\\${name}.cmd`,
    target: name === 'board' ? files.cli : files.spawn,
  })
  const settings = planSettings({}, pathsOf(ROOT_A), { toast: true }).settings
  return {
    platform: 'win32',
    root: ROOT_A,
    node: '22.5.0',
    binDir: 'C:\\Users\\u\\.local\\bin',
    path: 'C:\\Windows;C:\\Users\\u\\.local\\bin',
    files,
    commands: {
      board: { ps: ours('board'), sh: { ...ours('board'), file: 'C:\\Users\\u\\.local\\bin\\board' } },
      'spawn-agent': { ps: ours('spawn-agent'), sh: ours('spawn-agent') },
    },
    settingsFile: 'C:\\Users\\u\\.claude\\settings.json',
    settings,
    settingsError: '',
    herdrConfigFile: 'C:\\Users\\u\\AppData\\Roaming\\herdr\\config.toml',
    herdrConfig:
      '[ui.toast]\ndelivery = "off"\n\n[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\n',
    wakeUrl: 'http://127.0.0.1:12421',
    wake: { ok: true, status: 200 },
    launcher: { kind: 'builtin', claude: ['claude'], error: '', program: { file: 'C:\\bin\\claude.exe', found: true } },
    ...over,
  }
}
const level = (checks: SetupCheck[], id: string) => checks.find(c => c.id === id)?.level
const check = (checks: SetupCheck[], id: string): SetupCheck => {
  const c = checks.find(x => x.id === id)
  assert.ok(c, id)
  return c
}

describe('doctor', () => {
  test('a computer set up all the way', () => {
    const checks = checkSetup(facts())
    assert.deepEqual(
      checks.map(c => [c.id, c.level]),
      [
        ['board', 'ok'],
        ['hooks', 'ok'],
        ['statusline', 'ok'],
        ['spawn-agent', 'ok'],
        ['key', 'ok'],
        ['wake', 'ok'],
        ['launch', 'ok'],
        ['toast', 'ok'],
      ],
    )
    assert.deepEqual(todo(checks), [])
    assert.match(report(checks), /Everything the board needs is set up\.$/)
    assert.deepEqual(setupSummary(checks), { todo: 0, sig: '' })
  })

  test('each missing piece, what it costs and how to fix it', () => {
    const noHooks = checkSetup(facts({ settings: {} }))
    assert.equal(level(noHooks, 'hooks'), 'error')
    assert.equal(level(noHooks, 'statusline'), 'warn')
    assert.equal(level(noHooks, 'toast'), 'off') // optional: no mark on the board for it
    assert.equal(check(noHooks, 'hooks').code, 'herdr plugin action invoke agent-board.install')

    // The plugin moved (a new copy): hooks and commands still run the old one.
    const m = checkSetup(facts({ root: ROOT_B, files: boardFiles(ROOT_B) }))
    for (const id of ['board', 'hooks', 'statusline', 'spawn-agent', 'toast']) assert.notEqual(level(m, id), 'ok', id)
    assert.match(check(m, 'hooks').title, /another copy/)

    // Someone's own spawn-agent.ps1 wins in PowerShell.
    const own = checkSetup(
      facts({
        commands: {
          ...facts().commands,
          'spawn-agent': {
            ps: { file: 'C:\\Users\\u\\.local\\bin\\spawn-agent.ps1', target: null },
            sh: { file: 'C:\\Users\\u\\.local\\bin\\spawn-agent', target: null },
          },
        },
      }),
    )
    assert.equal(level(own, 'spawn-agent'), 'warn')
    assert.match(
      check(own, 'spawn-agent').detail,
      /instead of the board.s: \S+spawn-agent\.ps1 \(PowerShell\), \S+spawn-agent \(Git Bash\)/,
    )

    const noPath = checkSetup(
      facts({
        path: 'C:\\Windows',
        commands: { board: { ps: null, sh: null }, 'spawn-agent': { ps: null, sh: null } },
      }),
    )
    assert.equal(level(noPath, 'board'), 'error')
    assert.match(check(noPath, 'board').title, /not on PATH/)

    const rest = checkSetup(
      facts({
        herdrConfig: '[ui.toast]\ndelivery = "system"\n',
        wake: { ok: false, error: 'ECONNREFUSED' },
        launcher: { kind: 'builtin', claude: ['claude-tg'], error: '', program: { file: 'claude-tg', found: false } },
      }),
    )
    assert.equal(level(rest, 'key'), 'warn')
    assert.match(check(rest, 'key').code, /command = "agent-board\.open"/)
    assert.equal(level(rest, 'wake'), 'off')
    assert.match(check(rest, 'wake').detail, /Put to sleep/)
    assert.equal(level(rest, 'launch'), 'warn')
    assert.equal(level(rest, 'toast'), 'warn') // herdr's own notifications on top of the board's
    assert.deepEqual(
      todo(rest).map(c => c.id),
      ['key', 'launch', 'toast'],
    )

    const linux = checkSetup(
      facts({
        platform: 'linux',
        commands: {
          board: { sh: facts().commands.board?.sh ?? null },
          'spawn-agent': { sh: facts().commands['spawn-agent']?.sh ?? null },
        },
      }),
    )
    assert.equal(level(linux, 'toast'), 'na')
    assert.equal(level(linux, 'board'), 'ok')
    const gone = facts({
      launcher: {
        kind: 'command',
        name: 'spawn-agent',
        program: { file: 'pwsh', found: true },
        script: { file: 'C:\\gone.ps1', found: false },
      },
    })
    assert.equal(level(checkSetup(gone), 'launch'), 'warn')
    assert.equal(level(checkSetup(facts({ settings: null, settingsError: 'Unexpected token' })), 'hooks'), 'error')
    assert.equal(level(checkSetup(facts({ node: '18.19.0' })), 'node'), 'error')

    // A notification hook of one's own from before: alone it is fine, beside the board's it doubles them.
    const theirs = {
      type: 'command',
      command: 'powershell -File "C:\\Users\\u\\.claude\\hooks\\claude-toast.ps1"',
      async: true,
    }
    const both = planSettings({ hooks: { Stop: [{ hooks: [theirs] }] } }, pathsOf(ROOT_A), { toast: true }).settings
    const twice = check(checkSetup(facts({ settings: both })), 'toast')
    assert.equal(twice.level, 'warn')
    assert.match(twice.detail, /claude-toast\.ps1/)
    const alone = planSettings({ hooks: { Stop: [{ hooks: [theirs] }] } }, pathsOf(ROOT_A)).settings
    assert.equal(check(checkSetup(facts({ settings: alone })), 'toast').level, 'ok')
    // The launch check names the program only: arguments can carry a whole prompt.
    const secret = check(
      checkSetup(
        facts({
          launcher: {
            kind: 'builtin',
            claude: ['cl', '--append-system-prompt', 'secret words'],
            error: '',
            program: { file: 'cl', found: false },
          },
        }),
      ),
      'launch',
    )
    assert.doesNotMatch(`${secret.title} ${secret.detail}`, /secret words/)
  })

  test('the summary names the problems in English, whatever the language of the list', () => {
    const checks = checkSetup(facts({ settings: {} }))
    const summary = setupSummary(checks)
    assert.equal(summary.todo, todo(checks).length)
    assert.match(summary.sig, /^hooks:error:Claude Code hooks are missing: SessionStart, UserPromptSubmit\|/)
    assert.match(report(checks), /things need a look\.$/)
  })
})
