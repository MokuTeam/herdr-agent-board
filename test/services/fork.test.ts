import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { commandArgs } from '../../src/core/launch/launcher-command.ts'
import { canFork } from '../../src/services/launch/fork.ts'
import { launcherFor } from '../../src/services/launch/launcher.ts'
import { root, sandbox } from '../support/sandbox.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('the launcher of a fork: spawn-agent, a launch.command only with {fork}, launch.agent as for a resume', () => {
  assert.equal(launcherFor(undefined, { fork: true }).kind, 'builtin')
  assert.equal(launcherFor({ command: ['pwsh', '-File', 'start.ps1', '{name}'] }, { fork: true }).kind, 'builtin')
  assert.equal(launcherFor({ command: ['pwsh', '-File', 'start.ps1', '{fork}'] }, { fork: true }).kind, 'command')
  assert.deepEqual(commandArgs(['pwsh', '-File', 'start.ps1', ['-Fork', '{fork}']], { fork: S }).args, [
    '-File',
    'start.ps1',
    '-Fork',
    S,
  ])
  assert.deepEqual(commandArgs(['pwsh', ['-Fork', '{fork}']], { fork: '' }).args, [])
  assert.equal(launcherFor({ agent: 'claude' }, { fork: true }).kind, 'herdr')
  // A new session and a resume go as before.
  assert.equal(launcherFor({ command: ['pwsh', '{name}'] }).kind, 'command')
  assert.equal(launcherFor({ command: ['pwsh', '{name}'] }, { resume: true }).kind, 'builtin')
  assert.equal(launcherFor({ command: ['pwsh', '{resume}'] }, { resume: true }).kind, 'command')
})

test('the board offers a fork where its launcher can make one', () => {
  assert.equal(canFork({}), true)
  assert.equal(canFork({ launch: { claude: ['claude-tg'] } }), true)
  // A launch.command without {fork} leaves it to the board's spawn-agent.
  assert.equal(canFork({ launch: { command: ['pwsh', '{name}'] } }), true)
  assert.equal(canFork({ launch: { agent: 'claude' } }), true)
  assert.equal(canFork({ launch: { agent: 'codex' } }), false)
  assert.equal(canFork({ launch: { agent: 'claude', args: ['--continue'] } }), false)
})

test('the configured Codex launcher itself refuses a Claude fork without the explicit server flag', async () => {
  const box = await sandbox()
  const code = `
    import { herdrLauncher, LaunchError } from ${JSON.stringify(join(root, 'src/services/launch/launcher.ts'))};
    import { t } from ${JSON.stringify(join(root, 'src/core/lang.ts'))};
    try {
      await herdrLauncher({agent: 'codex'}).start({profileArgs: [], resume: null, fork: ${JSON.stringify(S)}}, {step() {}});
      process.exit(2);
    } catch (err) {
      if (!(err instanceof LaunchError) || err.kind !== 'launcher' || err.message !== t('archive.err.cannotResume')) process.exit(3);
      process.stdout.write('refused');
    }
  `
  const proc = Bun.spawn([process.execPath, '-e', code], { env: box.env, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await proc.exited, 0)
  assert.equal(await new Response(proc.stdout).text(), 'refused')
  assert.deepEqual(box.calls(), [])
})
