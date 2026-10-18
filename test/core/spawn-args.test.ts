import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { failureKind, launcherError } from '../../src/core/launch/launcher-command.ts'
import {
  choosesSession,
  claudeCommand,
  parseArgs,
  type SpawnArgs,
  shellLine,
  stillTyped,
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
  })
})
