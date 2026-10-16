import { beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { useLanguage } from '../../src/core/lang.ts'
import {
  commandArgs,
  failureKind,
  isRefusedProgram,
  launcherError,
  launcherLabel,
  parseLauncherOutput,
  usesPlaceholder,
} from '../../src/core/launch/launcher-command.ts'

beforeEach(() => {
  useLanguage('en')
})

test('launch.command: one argument per element, optional groups, no values in the program', () => {
  const vars = {
    name: 'Acme "quoted" & co',
    cwd: 'C:\\Work\\My Folder',
    workspace: 'w2',
    message: '',
    messageFile: '',
    label: 'Acme',
    category: 'acme',
    workspaceLabel: '',
    sessionId: '',
  }
  const tpl = [
    'pwsh',
    '-File',
    'C:\\bin\\spawn-agent.ps1',
    '-Name',
    '{name}',
    '-Cwd',
    '{cwd}',
    '-Workspace',
    '{workspace}',
    ['-BriefFile', '{messageFile}'],
    '--tag={category}',
  ]
  assert.deepEqual(commandArgs(tpl, vars), {
    file: 'pwsh',
    args: [
      '-File',
      'C:\\bin\\spawn-agent.ps1',
      '-Name',
      'Acme "quoted" & co',
      '-Cwd',
      'C:\\Work\\My Folder',
      '-Workspace',
      'w2',
      '--tag=acme',
    ],
  })
  assert.deepEqual(commandArgs(tpl, { ...vars, messageFile: 'C:\\t\\m.txt' }).args.slice(8, 10), [
    '-BriefFile',
    'C:\\t\\m.txt',
  ])
  assert.throws(() => commandArgs(['run', '{shell}'], vars), /unknown placeholder \{shell\}/)
  assert.throws(() => commandArgs(['{cwd}\\evil.exe'], vars), /program itself/)
  assert.throws(() => commandArgs('pwsh -File x.ps1', vars), /must be a list/)
  assert.throws(() => commandArgs(['pwsh', 3], vars), /must be a list/)
  // cmd.exe reads its own command line: no cmd, .bat or .cmd as the program, by any spelling.
  for (const program of ['cmd', 'CMD.EXE', 'C:\\Windows\\System32\\cmd.exe', 'C:/tools/start.bat', 'launch.CMD'])
    assert.throws(() => commandArgs([program, '/c', '{name}'], vars), /cmd/, program)
  assert.doesNotThrow(() => commandArgs(['cmdlet-runner', '{name}'], vars))
  assert.ok(usesPlaceholder(tpl, 'messageFile'))
  assert.ok(!usesPlaceholder(tpl, 'sessionId'))
  assert.equal(launcherLabel(tpl), 'spawn-agent')
  assert.equal(launcherLabel(['/usr/local/bin/launch-claude', '{name}']), 'launch-claude')
})

test('what a launcher said: its pane when it worked, the reason when it did not', () => {
  assert.deepEqual(parseLauncherOutput('waiting…\npane=w2:p14 name=Acme agent=acme\n'), {
    pane: 'w2:p14',
    agent: 'acme',
  })
  assert.deepEqual(parseLauncherOutput('nothing'), {})
  // PowerShell 7 wraps the message over "| " lines under the code it points at, in color.
  const pwsh =
    '\x1b[31;1mException: \x1b[0mC:\\bin\\spawn-agent.ps1:46\x1b[0m\r\n\x1b[36;1mLine |\x1b[0m\r\n\x1b[36;1m  46 | \x1b[0m …   \x1b[36;1mthrow "Claude in $pane waits for a dialog"\x1b[0m\r\n\x1b[36;1m     | \x1b[31;1m     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\x1b[0m\r\n\x1b[36;1m     | \x1b[31;1mClaude in w2:p14 waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt w2:p14\x1b[0m\r\n\x1b[36;1m     | \x1b[31;1m"/rename x" and send the brief.\x1b[0m\r\n'
  const e = launcherError('', pwsh)
  assert.equal(
    e.message,
    'Claude in w2:p14 waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt w2:p14 "/rename x" and send the brief.',
  )
  assert.equal(e.pane, 'w2:p14')
  assert.equal(failureKind(e.message), 'dialog')
  // Windows PowerShell puts it first, cut at the console's width, then where it was thrown.
  const legacy = `${'Claude in w2:p14 waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt w2:p14 "/rename x" and send the brief.'.replace(/^(.{120})/, '$1\r\n')}\r\nAt C:\\bin\\spawn-agent.ps1:46 char:5\r\n+     throw "Claude in $pane waits for a dialog"\r\n+     ~~~~~~~~~~\r\n    + CategoryInfo          : OperationStopped: (Claude in w2:p1...send the brief.:String) [], RuntimeException\r\n    + FullyQualifiedErrorId : Claude in w2:p14 waits\r\n`
  assert.equal(launcherError('', legacy).message, e.message)
  assert.equal(
    launcherError('', '\x1b[31mError: No such folder: C:\\nope\x1b[0m\n').message,
    'No such folder: C:\\nope',
  )
  assert.equal(failureKind('Claude did not get ready in w2:p1 within 120 s'), 'timeout')
  assert.equal(failureKind('No such folder: C:\\x'), 'folder')
  assert.equal(failureKind('anything', 'ENOENT'), 'launcher')
})

test('programs a launcher may not be: cmd, .bat and .cmd, by any spelling', () => {
  for (const program of [
    'cmd',
    'cmd.exe',
    'x.bat',
    'X.CMD',
    'CMD.EXE',
    'C:\\Windows\\System32\\cmd.exe',
    'C:/tools/start.bat',
  ])
    assert.ok(isRefusedProgram(program), program)
  for (const program of ['pwsh', 'node', 'bun.exe', 'cmdlet-runner', 'C:\\bin\\spawn-agent.ps1'])
    assert.ok(!isRefusedProgram(program), program)
})
