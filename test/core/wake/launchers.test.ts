// claude-tg without Node (#119): the two launchers take the Telegram key from `board tg-key` (else
// the folder) and start Claude with it in TG_KEY; their first comment line marks them ours. Which
// of them a refresh or an Install writes: never over a file without the mark (someone else's).
import { expect, test } from 'bun:test'
import { LAUNCHER_MARK, launcherFiles, launcherPlan } from '../../../src/core/wake/launchers.ts'

/** herdr-wake's own launchers, as its install-launcher.mjs wrote them. */
const OLD_SH =
  '#!/bin/sh\n' +
  "# herdr-wake: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)\n" +
  'TG_KEY="$(node "$(dirname "$0")/claude-tg-key.mjs" 2>/dev/null)"\n' +
  '[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"\n' +
  'export TG_KEY\n' +
  'exec claude "$@"\n'
const OLD_CMD = [
  '@echo off',
  "rem herdr-wake: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)",
  'setlocal DisableDelayedExpansion',
  'set "TG_KEY="',
  'for /f "usebackq delims=" %%k in (`node "%~dp0claude-tg-key.mjs" 2^>nul`) do set "TG_KEY=%%k"',
  'if not defined TG_KEY set "TG_KEY=%CD%"',
  'claude %*',
  '',
].join('\r\n')

test('claude-tg (sh): the key from board tg-key, else the folder, then claude in its place with the arguments', () => {
  const sh = launcherFiles()['claude-tg']
  expect(sh.split('\n')).toEqual([
    '#!/bin/sh',
    "# agent-board: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)",
    'TG_KEY="$(board tg-key 2>/dev/null)"',
    '[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"',
    'export TG_KEY',
    'exec claude "$@"',
    '',
  ])
  expect(sh).not.toContain('\r')
})

test('claude-tg.cmd: the same for cmd and PowerShell, CRLF, no delayed expansion (a ! in a key stays)', () => {
  const cmd = launcherFiles()['claude-tg.cmd']
  expect(cmd.split('\r\n')).toEqual([
    '@echo off',
    "rem agent-board: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)",
    'setlocal DisableDelayedExpansion',
    'set "TG_KEY="',
    'for /f "usebackq delims=" %%k in (`board tg-key 2^>nul`) do set "TG_KEY=%%k"',
    'if not defined TG_KEY set "TG_KEY=%CD%"',
    'claude %*',
    '',
  ])
  // Every line ends in CRLF: cmd.exe reads a batch file with LF alone wrongly at times.
  expect(cmd.replace(/\r\n/g, '')).not.toContain('\n')
  // Neither needs Node, nor the key script herdr-wake put beside them.
  for (const text of Object.values(launcherFiles())) {
    expect(text).not.toMatch(/\bnode\b/)
    expect(text).not.toContain('claude-tg-key.mjs')
  }
})

test('the mark: herdr-wake’s launchers and the board’s are ours to replace; anything else is not', () => {
  for (const text of [OLD_SH, OLD_CMD, ...Object.values(launcherFiles())]) expect(LAUNCHER_MARK.test(text)).toBe(true)
  for (const text of [
    '@echo mine, not from herdr-wake\r\n',
    '#!/bin/sh\n# my own claude-tg\nexec claude "$@"\n',
    '#!/bin/sh\necho "herdr-wake: not a comment"\n',
    '',
  ])
    expect([text, LAUNCHER_MARK.test(text)]).toEqual([text, false])
})

test('a refresh writes only where a launcher of ours is there, and only what changed', () => {
  const ours = launcherFiles()
  // None there: none written.
  expect(launcherPlan({ 'claude-tg': null, 'claude-tg.cmd': null }, { onlyWhereThere: true })).toEqual({
    write: [],
    foreign: [],
  })
  // herdr-wake's: both replaced.
  expect(launcherPlan({ 'claude-tg': OLD_SH, 'claude-tg.cmd': OLD_CMD }, { onlyWhereThere: true })).toEqual({
    write: ['claude-tg', 'claude-tg.cmd'],
    foreign: [],
  })
  // Only the .cmd there: only it.
  expect(launcherPlan({ 'claude-tg': null, 'claude-tg.cmd': OLD_CMD }, { onlyWhereThere: true })).toEqual({
    write: ['claude-tg.cmd'],
    foreign: [],
  })
  // Ours already, as they are now: nothing to write.
  expect(launcherPlan({ ...ours }, { onlyWhereThere: true })).toEqual({ write: [], foreign: [] })
  // Someone else's beside herdr-wake's: theirs stays, herdr-wake's is replaced.
  expect(launcherPlan({ 'claude-tg': OLD_SH, 'claude-tg.cmd': '@echo mine\r\n' }, { onlyWhereThere: true })).toEqual({
    write: ['claude-tg'],
    foreign: ['claude-tg.cmd'],
  })
})

test('an Install writes both, and nothing at all over someone else’s', () => {
  expect(launcherPlan({ 'claude-tg': null, 'claude-tg.cmd': null }, { onlyWhereThere: false })).toEqual({
    write: ['claude-tg', 'claude-tg.cmd'],
    foreign: [],
  })
  expect(launcherPlan({ 'claude-tg': OLD_SH, 'claude-tg.cmd': null }, { onlyWhereThere: false })).toEqual({
    write: ['claude-tg', 'claude-tg.cmd'],
    foreign: [],
  })
  expect(launcherPlan({ 'claude-tg': null, 'claude-tg.cmd': '@echo mine\r\n' }, { onlyWhereThere: false })).toEqual({
    write: [],
    foreign: ['claude-tg.cmd'],
  })
})
