import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCommand, gatherFacts, herdrConfigFile, readText } from '../../src/adapters/setup-facts.ts'
import { type InstallPaths, planShims } from '../../src/core/install-plan.ts'
import { boardFiles } from '../../src/core/setup.ts'

const ROOT_A = 'C:\\plugins\\agent-board'
const files = boardFiles(ROOT_A)
const paths: InstallPaths = { bun: 'C:\\bun.exe', ...files, binDir: 'C:\\Users\\u\\.local\\bin' }

describe('findCommand', () => {
  test('PowerShell takes a .ps1 before a .cmd in the same folder; Git Bash the file of that name', () => {
    const shims = planShims(paths)
    // As the host joins them (a Windows PATH read on another OS joins with its own separator).
    const disk: Record<string, string> = {
      [join('C:\\bin', 'spawn-agent.ps1')]: 'param()',
      [join('C:\\bin', 'spawn-agent.cmd')]: shims['spawn-agent.cmd'],
      [join('C:\\bin', 'spawn-agent')]: shims['spawn-agent'],
    }
    const found = findCommand('spawn-agent', {
      env: { PATH: 'C:\\nope;C:\\bin', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      exists: f => f in disk || f === files.spawn.replace(/\\/g, '/'),
      read: f => disk[f] ?? null,
    })
    assert.deepEqual(found.ps, { file: join('C:\\bin', 'spawn-agent.ps1'), target: null })
    assert.equal(found.sh?.target, files.spawn.replace(/\\/g, '/'))
    assert.equal(found.sh?.gone, undefined)
  })

  test('claude.exe or bun.exe on PATH is hundreds of megabytes: found, never read', () => {
    const big = findCommand('claude', {
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE' },
      platform: 'win32',
      exists: f => f === join('C:\\bin', 'claude.exe'),
      size: () => 272_000_000,
      read: () => assert.fail('read a big file'),
    })
    assert.deepEqual(big.ps, { file: join('C:\\bin', 'claude.exe'), target: null })
  })

  test('a command of ours whose script is gone, and Unix shells', () => {
    const shims = planShims({ ...paths, spawn: '/gone/src/entrypoints/spawn-agent.ts' })
    const found = findCommand('spawn-agent', {
      env: { PATH: '/home/u/.local/bin' },
      platform: 'linux',
      exists: f => f === join('/home/u/.local/bin', 'spawn-agent'),
      read: () => shims['spawn-agent'],
    })
    assert.deepEqual(Object.keys(found), ['sh'])
    assert.deepEqual(found.sh, {
      file: join('/home/u/.local/bin', 'spawn-agent'),
      target: '/gone/src/entrypoints/spawn-agent.ts',
      gone: true,
    })
  })
})

describe('gatherFacts', () => {
  test('a home without anything: settings.json missing, a broken one said where, the launcher as config says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'))
    try {
      const home = join(dir, 'home')
      const env = { PATH: join(dir, 'bin'), APPDATA: join(dir, 'appdata') }
      const none = await gatherFacts({ wakeUrl: null }, { root: ROOT_A, env, platform: 'win32', home })
      assert.equal(none.settings, null)
      assert.equal(none.settingsError, '')
      assert.equal(none.herdrConfigFile, join(dir, 'appdata', 'herdr', 'config.toml'))
      assert.equal(none.herdrConfig, null)
      assert.equal(none.wake, null)
      assert.deepEqual(none.commands, { board: { ps: null, sh: null }, 'spawn-agent': { ps: null, sh: null } })
      assert.deepEqual(none.launcher, {
        kind: 'builtin',
        claude: ['claude'],
        error: '',
        program: { file: 'claude', found: false },
      })

      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), '\uFEFF{ "hooks": ')
      const broken = await gatherFacts({ launch: { claude: ["it's"] } }, { root: ROOT_A, env, platform: 'win32', home })
      assert.match(broken.settingsError, /^not valid JSON/)
      assert.equal(broken.settings, null)
      assert.equal(broken.launcher?.kind, 'builtin')
      assert.match(broken.launcher?.kind === 'builtin' ? broken.launcher.error : '', /launch\.claude/)

      const herdr = await gatherFacts({ launch: { agent: 'codex' } }, { root: ROOT_A, env, platform: 'win32', home })
      assert.deepEqual(herdr.launcher, { kind: 'herdr', agent: 'codex' })
      const script = join(dir, 'start.ps1')
      const command = await gatherFacts(
        { launch: { command: [join(dir, 'pwsh.exe'), '-File', script, '{name}'] } },
        { root: ROOT_A, env, platform: 'win32', home },
      )
      assert.deepEqual(command.launcher, {
        kind: 'command',
        name: 'start',
        program: { file: join(dir, 'pwsh.exe'), found: false },
        script: { file: script, found: false },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('herdr’s config.toml under %APPDATA%, else ~/.config; a text file without its BOM', () => {
    assert.equal(
      herdrConfigFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'),
      join('C:\\Users\\u\\AppData\\Roaming', 'herdr', 'config.toml'),
    )
    assert.equal(herdrConfigFile({}, '/home/u'), join('/home/u', '.config', 'herdr', 'config.toml'))
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'))
    try {
      writeFileSync(join(dir, 'a.toml'), '\uFEFFkey = 1\n')
      assert.equal(readText(join(dir, 'a.toml')), 'key = 1\n')
      assert.equal(readText(join(dir, 'missing.toml')), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
