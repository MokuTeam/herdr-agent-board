import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { useLanguage } from '../../src/core/lang.ts'
import { failureKind, launcherError } from '../../src/core/launch/launcher-command.ts'
import {
  choosesSession,
  claudeCommand,
  claudeProgram,
  commandText,
  envSetting,
  parseArgs,
  profileCommand,
  type SpawnArgs,
  shellLine,
  stillTyped,
  typingProblem,
  USAGE,
} from '../../src/core/launch/spawn-args.ts'

const optionsOf = (r: SpawnArgs) => {
  assert.ok(!r.help, 'options, not help')
  return r
}

describe('spawn-agent options', () => {
  test('the board’s --names and the PowerShell -Names alike', () => {
    const ps = parseArgs([
      '-Name',
      'Acme invoices',
      '-Cwd',
      'C:\\Work\\Acme',
      '-Label',
      'Acme 12',
      '-BriefFile',
      'b.txt',
      '-Workspace',
      'w2',
      '-TimeoutSec',
      '90',
    ])
    assert.deepEqual(ps, {
      name: 'Acme invoices',
      cwd: 'C:\\Work\\Acme',
      label: 'Acme 12',
      briefFile: 'b.txt',
      workspace: 'w2',
      timeoutSec: 90,
    })
    const gnu = parseArgs([
      '--name',
      'Acme invoices',
      '--cwd=C:\\Work\\Acme',
      '--label',
      'Acme 12',
      '--brief-file',
      'b.txt',
      '--workspace',
      'w2',
      '--timeout-sec',
      '90',
    ])
    assert.deepEqual(gnu, ps)
    // Case and dashes do not matter; PowerShell's -Name:value works too.
    assert.equal(optionsOf(parseArgs(['-NAME:x', '-cwd', '.'])).name, 'x')
    assert.equal(
      optionsOf(parseArgs(['-name', 'x', '--Cwd', '.', '-brief', '-starts with a dash'])).brief,
      '-starts with a dash',
    )
    assert.equal(optionsOf(parseArgs(['--name', 'x', '--cwd', '.'])).timeoutSec, 120)
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    assert.equal(optionsOf(parseArgs(['--name', 'x', '--cwd', '.', '--session-id', sid])).sessionId, sid)
    assert.equal(parseArgs(['--help']).help, true)
    const fails: [string[], RegExp][] = [
      [['--cwd', '.'], /--name is missing/],
      [['--name', 'x'], /--cwd is missing/],
      [['--name', '', '--cwd', '.'], /--name is empty/],
      [['--name', '/clear', '--cwd', '.'], /must not start/],
      [['--name', 'a\nb', '--cwd', '.'], /control characters/],
      [['--name', 'x', '--cwd', '.', '--bogus', '1'], /unknown option --bogus/],
      [['--name', 'x', '--cwd', '.', 'stray'], /unexpected argument "stray"/],
      [['--name', 'x', '--cwd'], /--cwd needs a value/],
      [['--name', 'x', '--cwd', '.', '--timeout-sec', 'soon'], /--timeout-sec must be a number/],
      [['--name', 'x', '--cwd', '.', '--session-id', 'abc'], /UUID/],
      [['--name', 'x', '--cwd', '.', '--brief', 'a', '--brief-file', 'b'], /not both/],
    ]
    for (const [argv, re] of fails) assert.throws(() => parseArgs(argv), re, argv.join(' '))
    // Option names are checked as names: nothing from Object's prototype passes for one.
    assert.throws(() => parseArgs(['--name', 'x', '--cwd', '.', '--constructor', '1']), /unknown option --constructor/)
    assert.throws(() => parseArgs(['--name', 'x', '--cwd', '.', '--toString', '1']), /unknown option --toString/)
  })

  test('the profile: --profile <id>, or the board’s --config-dir <folder> or --keep-env, one of them', () => {
    expect(parseArgs(['--name', 'A', '--cwd', 'x', '--profile', 'work'])).toMatchObject({ profile: 'work' })
    expect(parseArgs(['-Name', 'A', '-Cwd', 'x', '-KeepEnv'])).toMatchObject({ keepEnv: true })
    expect(parseArgs(['--name', 'A', '--cwd', 'x', '--keep-env'])).toMatchObject({ keepEnv: true })
    expect(parseArgs(['--name', 'A', '--cwd', 'x', '--config-dir', 'C:\\w'])).toMatchObject({ configDir: 'C:\\w' })
    expect(parseArgs(['-Name', 'A', '-Cwd', 'x', '-ConfigDir', 'C:\\w'])).toMatchObject({ configDir: 'C:\\w' })
    // None of them: the options are as before.
    expect(parseArgs(['--name', 'A', '--cwd', 'x'])).toEqual({ name: 'A', cwd: 'x', timeoutSec: 120 })
    expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--profile', 'w', '--keep-env'])).toThrow(
      'give one of --profile, --config-dir and --keep-env',
    )
    expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--profile', 'w', '--config-dir', 'C:\\w'])).toThrow(
      'give one of --profile, --config-dir and --keep-env',
    )
    expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--config-dir', 'C:\\w', '-KeepEnv'])).toThrow(
      'give one of --profile, --config-dir and --keep-env',
    )
    // A flag: it takes no value, and the next word is not one.
    expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--keep-env=no'])).toThrow('--keep-env takes no value')
    expect(() => parseArgs(['--name', 'A', '--keep-env', '--cwd', 'x'])).not.toThrow()
    expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--profile'])).toThrow('--profile needs a value')
    expect(USAGE).toContain('[--profile <id>]')
  })

  test('the agent: --agent pi for a new session; claude, or none, is as before', () => {
    expect(parseArgs(['--name', 'A', '--cwd', 'x', '--agent', 'pi'])).toEqual({
      name: 'A',
      cwd: 'x',
      timeoutSec: 120,
      agent: 'pi',
    })
    expect(parseArgs(['-Name', 'A', '-Cwd', 'x', '-Agent', 'PI'])).toMatchObject({ agent: 'pi' })
    // Claude is what it starts anyway: the options are those of a start that names none.
    expect(parseArgs(['--name', 'A', '--cwd', 'x', '--agent', 'claude'])).toEqual({
      name: 'A',
      cwd: 'x',
      timeoutSec: 120,
    })
    expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--agent', 'codex'])).toThrow(
      '--agent must be claude or pi, not "codex"',
    )
    const id = '0f9c3b8e-1d2a-4c5b-9e8f-7a6b5c4d3e2f'
    for (const picks of [
      ['--resume', id],
      ['--fork', id],
    ])
      expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--agent', 'pi', ...picks])).toThrow(
        '--agent pi starts a new session: give it no --resume or --fork',
      )
    expect(parseArgs(['--name', 'A', '--cwd', 'x', '--agent', 'claude', '--resume', id])).toMatchObject({ resume: id })
    expect(USAGE).toContain('[--agent claude|pi]')
  })
})

describe('what spawn-agent types into the tab’s shell', () => {
  test('launch.claude, or claude with launch.args', () => {
    assert.deepEqual(claudeCommand(undefined), ['claude'])
    assert.deepEqual(claudeCommand('claude-tg'), ['claude-tg'])
    assert.deepEqual(claudeCommand(['claude', '--model', 'opus']), ['claude', '--model', 'opus'])
    // launch.args, from before the board had its own launcher, still reach claude; launch.claude wins.
    assert.deepEqual(claudeCommand(undefined, ['--model', 'opus']), ['claude', '--model', 'opus'])
    assert.deepEqual(claudeCommand(['claude-tg'], ['--model', 'opus']), ['claude-tg'])
    for (const bad of [[], [''], [3], ['x', 'y', 5], {}])
      assert.throws(() => claudeCommand(bad), /launch\.claude/, JSON.stringify(bad))
  })

  test('plain words as they are, anything else in single quotes; quotes and controls refused', () => {
    const host = process.platform === 'win32'
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    assert.equal(
      shellLine(['claude', '--dangerously-skip-permissions', '--session-id', sid], host),
      `claude --dangerously-skip-permissions --session-id ${sid}`,
    )
    // Anything but a plain word goes in single quotes, which PowerShell, bash, zsh and fish all take literally.
    assert.equal(
      shellLine(
        ['claude', '--append-system-prompt', 'Be brief; no $HOME & no `x`', '--allowedTools', 'Read,Write', ''],
        host,
      ),
      "claude --append-system-prompt 'Be brief; no $HOME & no `x`' --allowedTools 'Read,Write' ''",
    )
    assert.equal(shellLine(['C:\\tools\\start-claude.ps1'], true), 'C:\\tools\\start-claude.ps1')
    assert.throws(() => shellLine(['C:\\tools\\start-claude.ps1'], false), /program must be a name on PATH/) // a backslash means something to sh
    assert.throws(() => shellLine(['C:\\Program Files\\claude.exe'], true), /program must be a name on PATH/)
    assert.throws(() => shellLine(['-x'], host), /starts with a dash/)
    assert.throws(() => shellLine(['claude', "it's"], host), /a quote/)
    assert.throws(() => shellLine(['claude', 'Don’t stop'], true), /a quote/) // PowerShell ends a string at it too
    assert.throws(() => shellLine(['claude', 'a\u2028b'], host), /control character/) // a line separator
    assert.throws(() => shellLine(['claude', 'a\tb'], host), /control character/)
    assert.throws(() => shellLine(['claude', 'a\nb'], host), /control character/)
    // A backslash means something to sh: quoted in an argument, on Windows too (a Git Bash tab).
    assert.equal(shellLine(['claude', '--mcp-config', 'C:\\a\\b.json'], true), "claude --mcp-config 'C:\\a\\b.json'")
  })

  test('a command that picks its own session gets no --session-id', () => {
    assert.equal(choosesSession(['claude', '--resume', 'x']), true)
    assert.equal(choosesSession(['claude-tg', '-c']), true)
    assert.equal(choosesSession(['claude', '--session-id=x']), true)
    assert.equal(choosesSession(['claude', '--model', 'opus']), false)
  })

  test('typed text still on screen, wrapped by a narrow pane, or as a pasted-text chip', () => {
    assert.equal(
      stillTyped('❯ Check the invo\nices in the ledger and rep', 'Check the invoices in the ledger and report'),
      true,
    )
    assert.equal(stillTyped('[Pasted text #1 +12 lines]', 'whatever'), true)
    assert.equal(stillTyped('❯ ', 'Check the invoices'), false)
  })
})

describe('what the board reads of spawn-agent’s failures', () => {
  test('its prefix goes; a brief that did not reach is no reason to start again', () => {
    const e = launcherError(
      '',
      'spawn-agent: Claude in wA:p9 waits for a dialog (folder trust?). Answer it in that tab',
    )
    assert.equal(e.message, 'Claude in wA:p9 waits for a dialog (folder trust?). Answer it in that tab')
    assert.equal(e.pane, 'wA:p9')
    assert.equal(failureKind(e.message), 'dialog')
    assert.equal(failureKind('spawn-agent: The brief did not reach Claude in wA:p9: agent_busy'), 'message')
    // A brief that did not reach because the agent is blocked is still only the brief.
    assert.equal(failureKind('The brief did not reach Claude in wA:p9: blocked'), 'message')
    // herdr that cannot set the profile's folder for the tab: the launcher's to fix.
    assert.equal(
      failureKind(
        'herdr cannot set CLAUDE_CONFIG_DIR for the new tab (--env needs herdr 0.9.5 or newer): nothing was started',
      ),
      'launcher',
    )
  })
})

describe('a profile’s start command', () => {
  test('none, a string split on spaces, a list as it is', () => {
    for (const none of [undefined, null, '', '   ']) expect(profileCommand(none, false)).toBeNull()
    expect(profileCommand('cld-work', false)).toEqual(['cld-work'])
    expect(profileCommand('  cld-work   --verbose ', false)).toEqual(['cld-work', '--verbose'])
    expect(profileCommand(['cld-work', '--append-system-prompt', 'be brief'], false)).toEqual([
      'cld-work',
      '--append-system-prompt',
      'be brief',
    ])
    // A path with backslashes only on Windows, as for launch.claude.
    expect(profileCommand('C:\\tools\\cld.cmd', true)).toEqual(['C:\\tools\\cld.cmd'])
  })
  test('refused by launch.claude’s rules, in the board’s words', () => {
    useLanguage('en')
    const shape =
      'A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]'
    for (const bad of [[], [''], ['  '], ['cld-work', 3], 42, {}, true])
      expect(() => profileCommand(bad, false)).toThrow(shape)
    expect(() => profileCommand('-cld', false)).toThrow(
      'A start command begins with a program, not “-cld”, which starts with a dash',
    )
    expect(() => profileCommand(['cld work'], true)).toThrow(
      'The start command is typed at the new tab’s shell prompt, so its program “cld work” must be one word: a name the shell knows (cld-work) or a path, without spaces or quotes',
    )
    expect(() => profileCommand('C:\\tools\\cld.cmd', false)).toThrow(
      'its program “C:\\tools\\cld.cmd” must be one word',
    )
    expect(() => profileCommand("cld-work --name 'x'", false)).toThrow(
      'The start command’s argument "\'x\'" has a quote or a control character in it, which cannot be typed into a shell',
    )
    expect(() => profileCommand(['cld-work', 'a\nb'], false)).toThrow('argument "a\\nb" has a quote')
    expect(() => profileCommand('cld-work Don’t', true)).toThrow('argument "Don’t" has a quote')
    useLanguage('ru')
    expect(() => profileCommand('-cld', false)).toThrow(
      'Команда запуска начинается с программы, а не с «-cld»: здесь в начале дефис',
    )
    useLanguage('en')
  })
  test('refused when it sets an environment variable: the board sets CLAUDE_CONFIG_DIR for the profile', () => {
    useLanguage('en')
    const refused = (word: string) =>
      `A start command can’t set environment variables (“${word}”): the board sets CLAUDE_CONFIG_DIR for the profile itself. Put them in your alias`
    const cases: [unknown, string][] = [
      // The owner's alias body, pasted: refused for the assignment, not for its `$`.
      ['CLAUDE_CONFIG_DIR=$HOME/.claude-work command claude', 'CLAUDE_CONFIG_DIR=$HOME/.claude-work'],
      [
        'CLAUDE_CONFIG_DIR=~/.claude-work claude --allow-dangerously-skip-permissions',
        'CLAUDE_CONFIG_DIR=~/.claude-work',
      ],
      ['FOO=1 cld-work', 'FOO=1'],
      [['_x=', 'claude'], '_x='],
      ['env CLAUDE_CONFIG_DIR=/x claude', 'CLAUDE_CONFIG_DIR=/x'],
      ['env -i FOO=1 claude', 'FOO=1'],
      ['/usr/bin/env FOO=1 claude', 'FOO=1'],
      ['cld-work --settings CLAUDE_CONFIG_DIR=/x', 'CLAUDE_CONFIG_DIR=/x'],
      [['cld-work', 'claude_config_dir=C:\\x'], 'claude_config_dir=C:\\x'],
      // An append assignment is one too (bash takes NAME+=value before a command).
      ['CLAUDE_CONFIG_DIR+=/x claude', 'CLAUDE_CONFIG_DIR+=/x'],
      ['FOO+=1 claude', 'FOO+=1'],
      ['cld-work CLAUDE_CONFIG_DIR+=/x', 'CLAUDE_CONFIG_DIR+=/x'],
      // env is refused whatever follows: -u and -i drop the board's folder, -S sets it.
      ['env claude', 'env'],
      ['env -u CLAUDE_CONFIG_DIR claude', 'env'],
      ['/usr/bin/env -i claude', '/usr/bin/env'],
      [['ENV.EXE', '-S', 'claude'], 'ENV.EXE'],
    ]
    for (const [command, word] of cases) {
      for (const win of [false, true]) expect(() => profileCommand(command, win)).toThrow(refused(word))
    }
    useLanguage('ru')
    expect(() => profileCommand('env CLAUDE_CONFIG_DIR=/x claude', false)).toThrow(
      'Команда запуска не может задавать переменные окружения («CLAUDE_CONFIG_DIR=/x»): CLAUDE_CONFIG_DIR для профиля задаёт сама доска. Перенеси их в свой алиас',
    )
    useLanguage('en')
    // Not an assignment: an `=` further on, or after a program other than env.
    expect(profileCommand('cld-work --model=opus', false)).toEqual(['cld-work', '--model=opus'])
    expect(profileCommand('cld-work FOO=1', false)).toEqual(['cld-work', 'FOO=1'])
    expect(profileCommand('environ FOO=1', false)).toEqual(['environ', 'FOO=1'])
    expect(envSetting(['cld-work', '--verbose'])).toBeNull()
    expect(envSetting(['C:\\tools\\env.exe', 'X=1'])).toBe('X=1')
    expect(envSetting(['C:\\tools\\env.exe', '--unset=CLAUDE_CONFIG_DIR', 'claude'])).toBe('C:\\tools\\env.exe')
    // launch.claude keeps its rules: shellLine types an assignment as it did.
    expect(shellLine(['claude', 'CLAUDE_CONFIG_DIR=/x'], false)).toBe('claude CLAUDE_CONFIG_DIR=/x')
    expect(claudeCommand(['FOO=1', 'claude'])).toEqual(['FOO=1', 'claude'])
  })
  test('shellLine’s rules, named', () => {
    expect(typingProblem(['cld-work', '--model', 'opus 4'], false)).toBeNull()
    expect(typingProblem(['-x'], false)).toEqual({ why: 'dash', word: '-x' })
    expect(typingProblem(['C:\\tools\\cld.cmd'], false)).toEqual({ why: 'program', word: 'C:\\tools\\cld.cmd' })
    expect(typingProblem(['C:\\tools\\cld.cmd'], true)).toBeNull()
    expect(typingProblem(['cld', "it's"], true)).toEqual({ why: 'chars', word: "it's" })
  })
  test('as the Profiles panel shows it, and the program a profile without one types', () => {
    expect(commandText('  cld-work --verbose ')).toBe('cld-work --verbose')
    expect(commandText(['cld-work', '--append-system-prompt', 'be brief'])).toBe(
      'cld-work --append-system-prompt be brief',
    )
    for (const none of [undefined, null, 42, ['cld', 3], {}]) expect(commandText(none)).toBe('')
    expect(claudeProgram(undefined)).toBe('claude')
    expect(claudeProgram(undefined, ['--model', 'opus'])).toBe('claude')
    expect(claudeProgram('claude-tg')).toBe('claude-tg')
    expect(claudeProgram(['claude-tg', '--model', 'opus'])).toBe('claude-tg')
    expect(claudeProgram([])).toBe('claude')
  })
})
