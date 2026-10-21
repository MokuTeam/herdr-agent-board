import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { cardStore } from '../../src/core/card-store.ts'
import { translator } from '../../src/core/i18n/translator.ts'
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
  herdrHookScript,
  type ProfileSettings,
  report,
  type SetupCheck,
  type SetupFacts,
  type SkillFacts,
  setupSummary,
  skillAction,
  todo,
  tomlValue,
} from '../../src/core/setup.ts'
import type { WakeState } from '../../src/core/wake/status.ts'

const ROOT_A = 'C:\\plugins\\agent-board'
const ROOT_B = 'C:\\plugins\\mokuteam.herdr-agent-board-1a2b'
const BUN = 'C:\\Users\\u\\.bun\\bin\\bun.exe'
const files = boardFiles(ROOT_A)
const pathsOf = (root: string): InstallPaths & { wakeHook: string } => ({
  bun: BUN,
  ...boardFiles(root),
  binDir: 'C:\\Users\\u\\.local\\bin',
})
const hookCommand = (f: BoardFiles) => `${quote(BUN)} ${quote(f.hook)}`
type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[] | undefined> }
const commands = (settings: unknown, event: string) =>
  ((settings as Settings).hooks[event] ?? []).flatMap(e => e.hooks.map(h => h.command))
const SKILL_TEXT =
  '---\nname: herdr-agents\n---\n<!-- agent-board: installed by the install action -->\nHow to work in herdr.\n'

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
    assert.deepEqual(commands(kept.settings, 'PreToolUse'), [hookCommand(files), toastCommand(files.toast)])
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
    // Not an object where hooks should be: replaced rather than crashed on.
    assert.deepEqual(Object.keys((planSettings({ hooks: [] }, pathsOf(ROOT_A)).settings as Settings).hooks), [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
    ])
  })

  test('a board in a folder of another name: its own entries known by the files they run', () => {
    const root = 'D:\\work\\board'
    const notified = planSettings({}, pathsOf(root), { toast: true }).settings
    const again = planSettings(notified, pathsOf(root))
    assert.equal(again.toast, true)
    assert.deepEqual(again.settings, notified)
    assert.deepEqual(commands(again.settings, 'SessionStart'), [hookCommand(boardFiles(root))])
  })

  test('a hook event that is not a list is taken for an empty one, as upstream does', () => {
    const ourHook = { hooks: [{ type: 'command', command: hookCommand(files), timeout: 10 }] }
    const ourAsk = { matcher: 'AskUserQuestion', ...ourHook }
    const notify = { type: 'command', command: toastCommand(files.toast), timeout: 30, async: true }
    const odd = { hooks: { SessionStart: 'text', Stop: { not: 'a list' }, PreToolUse: 5 } }
    // The board's events get its entry; a notification event with nothing to add goes.
    for (const toast of [undefined, false])
      assert.deepEqual(planSettings(odd, pathsOf(ROOT_A), { toast }).settings.hooks, {
        SessionStart: [ourHook],
        UserPromptSubmit: [ourHook],
        PreToolUse: [ourAsk],
      })
    // Notifications going in: the board's entry in its place.
    const on = planSettings(odd, pathsOf(ROOT_A), { toast: true })
    assert.equal(on.toast, true)
    assert.deepEqual(on.settings.hooks, {
      SessionStart: [ourHook],
      Stop: [{ hooks: [notify] }],
      PreToolUse: [ourAsk, { matcher: 'AskUserQuestion', hooks: [notify] }],
      UserPromptSubmit: [ourHook],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: [notify] }],
    })
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

  test('herdr’s own Claude hook: the script its SessionStart entry runs, quoted or not', () => {
    const at = (event: string, command: string): string | null =>
      herdrHookScript({
        hooks: {
          [event]: [{ matcher: '^(startup|resume|clear|compact|fork)$', hooks: [{ type: 'command', command }] }],
        },
      })
    const ps1 = 'C:\\Users\\u\\.claude-work\\hooks\\herdr-agent-state.ps1'
    // As herdr 0.9.5 writes it on Windows.
    expect(at('SessionStart', `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" session`)).toBe(ps1)
    expect(at('SessionStart', "sh '/home/u/.claude/hooks/herdr-agent-state.sh' session")).toBe(
      '/home/u/.claude/hooks/herdr-agent-state.sh',
    )
    expect(at('SessionStart', '/home/u/.claude/hooks/herdr-agent-state.sh session')).toBe(
      '/home/u/.claude/hooks/herdr-agent-state.sh',
    )
    // Someone else's hook, or herdr's on another event: none.
    expect(at('SessionStart', 'python recall.py')).toBeNull()
    expect(at('Stop', `powershell -File "${ps1}" session`)).toBeNull()
    for (const settings of [{}, null, undefined, { hooks: [] }, { hooks: { SessionStart: 'x' } }])
      expect(herdrHookScript(settings)).toBeNull()
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
    mokupilot: {
      state: 'ok',
      configured: false,
      file: 'C:\\Users\\u\\AppData\\Local\\Programs\\MokuPilot\\MokuPilot.exe',
      args: [],
    },
    skill: { file: 'C:\\Users\\u\\.claude\\skills\\herdr-agents\\SKILL.md', installed: SKILL_TEXT, source: SKILL_TEXT },
    herdrHook: { script: 'C:\\Users\\u\\.claude\\hooks\\herdr-agent-state.ps1', found: true },
    ...over,
  }
}
const level = (checks: SetupCheck[], id: string) => checks.find(c => c.id === id)?.level
const check = (checks: SetupCheck[], id: string): SetupCheck => {
  const c = checks.find(x => x.id === id)
  assert.ok(c, id)
  return c
}

describe('card-store diagnostics', () => {
  test('explicit shared cards report their folder and the separate schedule folder', () => {
    const store = cardStore(
      { LOCALAPPDATA: '/tmp/preview', HERDR_BOARD_CARDS_DIR: '/srv/Team 100%/cards' },
      '/home/u',
      'linux',
    )
    const item = check(checkSetup(facts({ cardStore: store })), 'cards')
    expect(item.level).toBe('ok')
    expect(item.detail).toContain('/srv/Team 100%/cards')
    expect(item.detail).toContain('/tmp/preview/herdr/plugins/agent-board/schedule')
    expect(item.detail).toContain('HERDR_BOARD_CARDS_DIR')
    expect(item.fix).toContain('other processes may have different environments')
  })

  test('a custom Unix state without an explicit card store warns, without claiming a proven mismatch', () => {
    const store = cardStore({ LOCALAPPDATA: '/tmp/preview' }, '/home/u', 'darwin')
    const item = check(checkSetup(facts({ cardStore: store })), 'cards')
    expect(item.level).toBe('warn')
    expect(item.fix).toContain('may still use')
    expect(item.fix).toContain('No files are copied or merged')
    expect(check(checkSetup(facts({ cardStore: cardStore({}, '/home/u', 'linux') })), 'cards').level).toBe('ok')
    const win = cardStore({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32')
    expect(check(checkSetup(facts({ cardStore: win })), 'cards').level).toBe('ok')
  })

  test('an invalid store is an error; Russian diagnostics preserve the literal paths', () => {
    const error = 'HERDR_BOARD_CARDS_DIR must be an absolute directory path'
    expect(check(checkSetup(facts({ cardStore: { error } })), 'cards')).toMatchObject({ level: 'error', detail: error })
    const store = cardStore({ HERDR_BOARD_CARDS_DIR: '/srv/Работа 100%/cards' }, '/home/u', 'linux')
    const ru = check(checkSetup(facts({ cardStore: store }), translator('ru')), 'cards')
    expect(ru.title).toBe('Хранилище карточек')
    expect(ru.detail).toContain('/srv/Работа 100%/cards')
  })
})

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
        ['skill', 'ok'],
        ['herdr', 'ok'],
        ['key', 'ok'],
        ['wake', 'ok'],
        ['launch', 'ok'],
        ['mokupilot', 'ok'],
        ['toast', 'ok'],
      ],
    )
    assert.deepEqual(todo(checks), [])
    assert.match(report(checks), /Everything the board needs is set up\.$/)
    assert.deepEqual(setupSummary(checks), { todo: 0, sig: '' })
  })

  test('hooks from before the question hook: a warning to run the install again, every other check as it was', () => {
    const withAsk = (root: string) => {
      const settings = structuredClone(facts().settings) as Settings
      const ask = { matcher: 'AskUserQuestion', hooks: [{ command: hookCommand(boardFiles(root)) }] }
      settings.hooks.PreToolUse = [ask, ...(settings.hooks.PreToolUse ?? []).slice(1)]
      return settings
    }
    const without = structuredClone(facts().settings) as Settings
    without.hooks.PreToolUse = without.hooks.PreToolUse?.slice(1)
    assert.deepEqual(commands(without, 'PreToolUse'), [toastCommand(files.toast)])
    for (const settings of [without, withAsk(ROOT_B)]) {
      const checks = checkSetup(facts({ settings }))
      const hooks = check(checks, 'hooks')
      assert.equal(hooks.level, 'warn')
      assert.equal(hooks.title, 'Claude Code hooks of an older install: no question hook')
      assert.match(hooks.detail, /auto or plan mode/)
      assert.equal(hooks.code, 'herdr plugin action invoke agent-board.install')
      assert.deepEqual(
        checks.filter(c => c.id !== 'hooks'),
        checkSetup(facts()).filter(c => c.id !== 'hooks'),
      )
    }
    assert.equal(level(checkSetup(facts({ settings: withAsk(ROOT_A) })), 'hooks'), 'ok')
    // The board's own events missing still say so first.
    assert.equal(
      level(checkSetup(facts({ settings: { hooks: { PreToolUse: withAsk(ROOT_A).hooks.PreToolUse } } })), 'hooks'),
      'error',
    )
  })

  test('MokuPilot is optional; only one config.json names and is not there gets a mark', () => {
    const none = checkSetup(
      facts({ mokupilot: { state: 'missing', configured: false, file: 'MokuPilot.exe, meet.cmd' } }),
    )
    assert.equal(level(none, 'mokupilot'), 'off')
    assert.match(check(none, 'mokupilot').code, /"mokupilot": \{ "dir": /)
    assert.equal(level(checkSetup(facts({ mokupilot: { state: 'off', configured: true } })), 'mokupilot'), 'off')
    const gone = checkSetup(facts({ mokupilot: { state: 'missing', configured: true, file: 'D:\\MokuPilot\\run.py' } }))
    assert.equal(level(gone, 'mokupilot'), 'warn')
    assert.match(check(gone, 'mokupilot').title, /MokuPilot not found: D:\\MokuPilot\\run\.py/)
    assert.deepEqual(
      todo(gone).map(c => c.id),
      ['mokupilot'],
    )
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
    // herdr-wake lives in this repository: the commands to copy, and what it runs on (#118).
    assert.equal(
      check(rest, 'wake').code,
      [
        'herdr plugin install MokuTeam/herdr-agent-board/herdr-wake',
        'herdr plugin action invoke herdr-wake.install-hooks',
        'herdr plugin action invoke herdr-wake.start',
      ].join('\n'),
    )
    assert.match(check(rest, 'wake').fix, /Node\.js 20/)
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

  test('the agents’ skill: installed when missing or older, left alone when it is someone else’s', () => {
    assert.equal(skillAction(null, SKILL_TEXT), 'write')
    assert.equal(skillAction(SKILL_TEXT.replace(/\n/g, '\r\n'), SKILL_TEXT), 'same')
    assert.equal(skillAction(SKILL_TEXT.replace('How', 'Once, how'), SKILL_TEXT), 'write')
    assert.equal(skillAction('---\nname: herdr-agents\n---\nmine\n', SKILL_TEXT), 'foreign')
    const base = facts().skill
    assert.ok(base)
    const at = (state: Partial<SkillFacts>): SetupCheck =>
      check(checkSetup(facts({ skill: { ...base, ...state } })), 'skill')
    assert.equal(at({}).level, 'ok')
    assert.deepEqual(
      [at({ installed: null }).level, at({ installed: null }).code],
      ['warn', 'herdr plugin action invoke agent-board.install'],
    )
    assert.match(at({ installed: `${SKILL_TEXT}old\n` }).title, /older copy/)
    assert.match(at({ installed: 'mine' }).title, /not the board/)
    // Facts without the skill (an older gatherFacts): no check for it.
    assert.equal(
      checkSetup(facts({ skill: undefined })).some(c => c.id === 'skill'),
      false,
    )
  })

  test('the summary names the problems in English, whatever the language of the list', () => {
    const checks = checkSetup(facts({ settings: {} }))
    const summary = setupSummary(checks)
    assert.equal(summary.todo, todo(checks).length)
    assert.match(summary.sig, /^hooks:error:Claude Code hooks are missing: SessionStart, UserPromptSubmit\|/)
    assert.match(report(checks), /things need a look\.$/)
    // The list in Russian: its own titles, the same problems; the English summary stays as it was
    // (a sig made from the Russian list would differ, so a language switch would look like news).
    const ru = checkSetup(facts({ settings: {} }), translator('ru'))
    assert.deepEqual(
      ru.map(c => [c.id, c.level]),
      checks.map(c => [c.id, c.level]),
    )
    assert.notEqual(ru.find(c => c.id === 'hooks')?.title, checks.find(c => c.id === 'hooks')?.title)
    assert.equal(todo(ru).length, summary.todo)
    assert.notEqual(setupSummary(ru).sig, summary.sig)
    assert.deepEqual(setupSummary(checkSetup(facts({ settings: {} }))), summary)
  })
})

describe('the checks per profile', () => {
  const FACTS = facts()
  const profile = (
    id: string,
    title: string,
    settings: unknown,
    exists = true,
    installed: string | null = SKILL_TEXT,
  ): ProfileSettings => {
    const dir = id === 'default' ? 'C:\\Users\\u\\.claude' : `C:\\Users\\u\\.claude-${id}`
    const skill = { file: `${dir}\\skills\\herdr-agents\\SKILL.md`, installed, source: SKILL_TEXT }
    const herdrHook = { script: `${dir}\\hooks\\herdr-agent-state.ps1`, found: true }
    const settingsFile = `${dir}\\settings.json`
    return { id, title, dir, exists, settingsFile, settings, settingsError: '', skill, herdrHook }
  }
  const one = profile('default', 'Default', FACTS.settings)
  const privateOk = profile('default', 'Private', FACTS.settings)
  const workWithoutHooks = profile('work', 'Work', {})

  test('one profile: the same checks as before; two: hooks and status line per profile, by name', () => {
    expect(checkSetup({ ...FACTS, profiles: [one] })).toEqual(checkSetup(FACTS))
    expect(checkSetup({ ...FACTS, profiles: [] })).toEqual(checkSetup(FACTS))
    const checks = checkSetup({ ...FACTS, profiles: [privateOk, workWithoutHooks] })
    expect(checks.find(c => c.id === 'hooks:work')).toMatchObject({
      level: 'error',
      title: expect.stringMatching(/^Work: /),
    })
    expect(checks.find(c => c.id === 'hooks:default')?.level).toBe('ok')
    // In today's place, profile after profile; the rest as before.
    expect(checks.map(c => c.id)).toEqual([
      'board',
      'hooks:default',
      'statusline:default',
      'hooks:work',
      'statusline:work',
      'spawn-agent',
      'skill:default',
      'skill:work',
      'herdr:default',
      'herdr:work',
      'key',
      'wake',
      'launch',
      'mokupilot',
      'toast',
    ])
    expect(checks.find(c => c.id === 'hooks:work')).toMatchObject({
      title: 'Work: Claude Code hooks are missing: SessionStart, UserPromptSubmit',
      code: 'herdr plugin action invoke agent-board.install',
    })
    expect(checks.find(c => c.id === 'hooks:default')).toMatchObject({
      title: 'Private: Claude Code hooks',
      detail: 'SessionStart, UserPromptSubmit in C:\\Users\\u\\.claude\\settings.json',
    })
    expect(checks.find(c => c.id === 'statusline:work')).toMatchObject({ level: 'warn', title: 'Work: No status line' })
    expect(checks.find(c => c.id === 'statusline:default')).toMatchObject({
      level: 'ok',
      title: 'Private: Status line',
    })
    expect(setupSummary(checkSetup({ ...FACTS, profiles: [privateOk, workWithoutHooks] })).sig).toContain(
      'hooks:work:error:Work: Claude Code hooks are missing',
    )
    // One that does not parse is said with its own file.
    const broken = { ...workWithoutHooks, settings: null, settingsError: 'not valid JSON (position 1)' }
    expect(checkSetup({ ...FACTS, profiles: [privateOk, broken] }).find(c => c.id === 'hooks:work')).toMatchObject({
      level: 'error',
      title: 'Work: Claude Code settings cannot be read',
      detail: 'C:\\Users\\u\\.claude-work\\settings.json: not valid JSON (position 1)',
    })
    // In Russian: the profile's name, then the check.
    const ru = checkSetup({ ...FACTS, profiles: [privateOk, workWithoutHooks] }, translator('ru'))
    expect(ru.find(c => c.id === 'hooks:work')?.title).toBe(
      'Work: Нет хуков Claude Code: SessionStart, UserPromptSubmit',
    )
  })

  test('a shown profile whose folder is not there: a warning naming it, no hooks to look for', () => {
    const gone = profile('work', 'Work', null, false)
    const checks = checkSetup({ ...FACTS, profiles: [privateOk, gone] })
    expect(checks.find(c => c.id === 'profile:work')).toMatchObject({
      level: 'warn',
      title: 'Work: its folder C:\\Users\\u\\.claude-work is not there',
    })
    expect(checks.some(c => /^(hooks|statusline|skill|herdr):work$/.test(c.id))).toBe(false)
    expect(todo(checks).map(c => c.id)).toEqual(['profile:work'])
    expect(translator('ru')('setup.profile.missing', { profile: 'Work', dir: 'D:\\w' })).not.toBe(
      'Work: its folder D:\\w is not there',
    )
  })

  test('the agents’ skill: one profile, the check as upstream; more, one check per profile, by name', () => {
    // One profile: what upstream checks, in its place (the top-level facts).
    expect(checkSetup({ ...FACTS, profiles: [one] }).filter(c => c.id.startsWith('skill'))).toEqual([
      {
        id: 'skill',
        level: 'ok',
        title: 'Skill herdr-agents for the agents',
        detail:
          'how sessions in herdr start and message others, do things later, run a server and get a dropped MCP server back',
        fix: '',
        code: '',
      },
    ])
    // Several: each its own, its own file named.
    const work = profile('work', 'Work', {}, true, null)
    const games = profile('games', 'Games', {}, true, '---\nname: herdr-agents\n---\nmine\n')
    const old = profile('old', 'Old', {}, true, `${SKILL_TEXT}old\n`)
    const checks = checkSetup({ ...FACTS, profiles: [privateOk, work, games, old] })
    expect(checks.filter(c => c.id.startsWith('skill')).map(c => [c.id, c.level, c.title])).toEqual([
      ['skill:default', 'ok', 'Private: Skill herdr-agents for the agents'],
      ['skill:work', 'warn', 'Work: No skill herdr-agents for the agents'],
      ['skill:games', 'warn', "Games: Skill herdr-agents is not the board's"],
      ['skill:old', 'warn', 'Old: Skill herdr-agents is an older copy'],
    ])
    expect(check(checks, 'skill:work')).toMatchObject({
      fix: 'Run the install:',
      code: 'herdr plugin action invoke agent-board.install',
    })
    expect(check(checks, 'skill:games').detail).toBe(
      "C:\\Users\\u\\.claude-games\\skills\\herdr-agents\\SKILL.md is someone else's skill of that name, so the install leaves it alone.",
    )
    expect(setupSummary(checks).sig).toContain('skill:work:warn:Work: No skill herdr-agents for the agents')
    // In Russian: the profile's name, then the check.
    expect(check(checkSetup({ ...FACTS, profiles: [privateOk, work] }, translator('ru')), 'skill:work').title).toBe(
      'Work: Нет скилла herdr-agents для агентов',
    )
  })

  test('herdr’s own Claude hook: one profile, one check; more, one per profile whose folder is there, by name', () => {
    // One profile: in its place, after the skill (the top-level facts).
    expect(checkSetup({ ...FACTS, profiles: [one] }).filter(c => c.id.startsWith('herdr'))).toEqual([
      {
        id: 'herdr',
        level: 'ok',
        title: 'herdr’s Claude hook',
        detail: 'herdr learns from it which conversation each session has',
        fix: '',
        code: '',
      },
    ])
    expect(check(checkSetup(facts({ herdrHook: { script: null, found: false } })), 'herdr')).toMatchObject({
      level: 'warn',
      title: 'herdr’s Claude hook is missing',
    })
    // Several: each its own. No entry in settings.json, or an entry whose script is gone: missing.
    const work = { ...profile('work', 'Work', {}), herdrHook: { script: null, found: false } }
    const games = {
      ...profile('games', 'Games', {}),
      herdrHook: { script: 'C:\\Users\\u\\.claude-games\\hooks\\herdr-agent-state.ps1', found: false },
    }
    const gone = profile('old', 'Old', null, false)
    const checks = checkSetup({ ...FACTS, profiles: [privateOk, work, games, gone] })
    expect(checks.filter(c => c.id.startsWith('herdr')).map(c => [c.id, c.level, c.title])).toEqual([
      ['herdr:default', 'ok', 'Private: herdr’s Claude hook'],
      ['herdr:work', 'warn', 'Work: herdr’s Claude hook is missing'],
      ['herdr:games', 'warn', 'Games: herdr’s Claude hook is missing'],
    ])
    expect(check(checks, 'herdr:work')).toMatchObject({
      detail:
        'Without it herdr does not see which conversation a session has: its card shows no conversation and no profile.',
      fix: 'Run the install:',
      code: 'herdr plugin action invoke agent-board.install',
    })
    expect(setupSummary(checks).sig).toContain('herdr:work:warn:Work: herdr’s Claude hook is missing')
    // In Russian: the profile's name, then the check.
    expect(check(checkSetup({ ...FACTS, profiles: [privateOk, work] }, translator('ru')), 'herdr:work').title).toBe(
      'Work: Нет хука Claude для herdr',
    )
    // Facts without it (an older gatherFacts): no check for it.
    expect(checkSetup(facts({ herdrHook: undefined })).some(c => c.id.startsWith('herdr'))).toBe(false)
  })
})

describe('the wake line (#119)', () => {
  const LOG = 'C:\\Users\\Иван Петров\\AppData\\Local\\herdr\\plugins\\agent-board\\wake.log'
  const WITH_WAKE = planSettings({}, pathsOf(ROOT_A), { toast: true, wake: true }).settings
  const wakeOn = (state: WakeState, over: Partial<NonNullable<SetupFacts['wakeNew']>> = {}) =>
    facts({
      settings: WITH_WAKE,
      wakeNew: { state, port: 23456, asleep: 2, log: LOG, wakeUrlSet: false, ...over },
    })
  const wakeLine = (f: SetupFacts, t = translator('en')): SetupCheck => check(checkSetup(f, t), 'wake')

  test('old mode: the line is today’s', () => {
    for (const f of [facts(), facts({ wakeNew: null })]) {
      expect(wakeLine(f)).toEqual({
        id: 'wake',
        level: 'ok',
        title: 'herdr-wake',
        detail: 'answers at http://127.0.0.1:12421',
        fix: '',
        code: '',
      })
      expect(checkSetup(f).some(c => c.id.startsWith('wakeHooks') || c.id === 'wakeUrl')).toBe(false)
    }
    expect(wakeLine(facts({ wakeUrl: null, wake: null })).fix).toMatch(/Node\.js 20/)
  })

  test('running', () => {
    expect(wakeLine(wakeOn('running'))).toMatchObject({
      level: 'ok',
      title: 'Sleep and wake runs',
      detail: 'on 127.0.0.1:23456, 2 asleep',
    })
    expect(wakeLine(wakeOn('running', { asleep: 1 }), translator('ru')).detail).toBe('на 127.0.0.1:23456, 1 спит')
  })

  test('off', () => {
    expect(wakeLine(wakeOn('off'))).toMatchObject({
      level: 'off',
      title: 'Sleep and wake is off',
      fix: 'Turn it on in Settings → Sleep and wake…, or set "wake": { "enabled": true } in the board\'s config.json',
    })
  })

  test('crashed: its error and its log', () => {
    expect(wakeLine(wakeOn('crashed', { error: 'TypeError: x is not a function' }))).toMatchObject({
      level: 'error',
      title: 'Sleep and wake crashed',
      detail: 'TypeError: x is not a function',
      fix: `Settings → Sleep and wake… → Start again. Its log: ${LOG}`,
    })
  })

  test('held by the old plugin', () => {
    expect(wakeLine(wakeOn('held'))).toMatchObject({
      level: 'warn',
      title: 'The separate herdr-wake plugin puts sessions to sleep',
      fix: 'Settings → Sleep and wake… → Switch over…',
    })
  })

  test('not answering, or starting past its time', () => {
    expect(wakeLine(wakeOn('notRunning', { error: 'did not end within 20 s' }))).toMatchObject({
      level: 'warn',
      title: 'Sleep and wake is on but does not answer on port 23456',
      detail: 'did not end within 20 s',
      fix: `Settings → Sleep and wake… → Start. Its log: ${LOG}`,
    })
    // Within its time it is starting: nothing to fix yet.
    expect(wakeLine(wakeOn('starting'))).toMatchObject({ level: 'ok', title: 'Sleep and wake is starting' })
  })

  test('port taken', () => {
    expect(wakeLine(wakeOn('portTaken'))).toMatchObject({
      level: 'error',
      title: 'Port 23456 is taken by another program',
      fix: 'Set another "port" in the wake section of the board\'s config.json',
    })
  })

  test('wakeUrl set to something else than the default: a second line', () => {
    const checks = checkSetup(wakeOn('running', { wakeUrlSet: true }))
    const at = checks.findIndex(c => c.id === 'wake')
    expect(checks.slice(at, at + 2).map(c => c.id)).toEqual(['wake', 'wakeUrl'])
    expect(check(checks, 'wakeUrl')).toMatchObject({
      level: 'na',
      title: 'wakeUrl in config.json is not used while Sleep and wake is on',
    })
    expect(checkSetup(wakeOn('running')).some(c => c.id === 'wakeUrl')).toBe(false)
  })

  test('no Node.js 20 in any of it, in either language', () => {
    for (const state of ['running', 'off', 'crashed', 'held', 'notRunning', 'starting', 'portTaken'] as const)
      for (const t of [translator('en'), translator('ru')]) {
        const said = checkSetup(wakeOn(state, { wakeUrlSet: true }), t).filter(c => c.id.startsWith('wake'))
        expect(JSON.stringify(said)).not.toMatch(/Node|herdr plugin install/)
      }
  })

  test('wake on and not held: each shown profile without wake’s hooks is flagged, the old plugin’s shown as theirs', () => {
    const oldPlugin = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'ListAgents',
            hooks: [{ type: 'command', command: 'node "C:\\p\\herdr-wake\\src\\hook.mjs" post-list' }],
          },
        ],
      },
    }
    // One profile: in its place, after the wake line.
    const one = checkSetup(wakeOn('running'))
    expect(
      one
        .map(c => c.id)
        .slice(
          one.findIndex(c => c.id === 'wake'),
          one.findIndex(c => c.id === 'wake') + 2,
        ),
    ).toEqual(['wake', 'wakeHooks'])
    expect(check(one, 'wakeHooks')).toMatchObject({
      level: 'ok',
      title: 'Sleep and wake’s hooks',
      detail: 'ListAgents and SendMessage in C:\\Users\\u\\.claude\\settings.json',
    })
    expect(check(checkSetup({ ...wakeOn('running'), settings: facts().settings }), 'wakeHooks')).toMatchObject({
      level: 'warn',
      title: 'Sleep and wake’s hooks are not in place',
      code: 'herdr plugin action invoke agent-board.install',
    })
    // Several: each by its name.
    const at = (id: string, settings: unknown): ProfileSettings => ({
      id,
      title: id === 'default' ? 'Private' : 'Work',
      dir: `C:\\Users\\u\\.claude-${id}`,
      exists: true,
      settingsFile: `C:\\Users\\u\\.claude-${id}\\settings.json`,
      settings,
      settingsError: '',
    })
    const checks = checkSetup({ ...wakeOn('notRunning'), profiles: [at('default', WITH_WAKE), at('work', oldPlugin)] })
    expect(check(checks, 'wakeHooks:default')).toMatchObject({ level: 'ok', title: 'Private: Sleep and wake’s hooks' })
    expect(check(checks, 'wakeHooks:work')).toMatchObject({
      level: 'warn',
      title: 'Work: The separate herdr-wake plugin’s hooks are in place',
      fix: 'Settings → Sleep and wake… → Switch over…',
    })
    // Off, or held by the old plugin: no hook lines.
    for (const state of ['off', 'held'] as const)
      expect(checkSetup({ ...wakeOn(state), settings: facts().settings }).some(c => c.id.startsWith('wakeHooks'))).toBe(
        false,
      )
  })
})
