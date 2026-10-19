import { describe, expect, test } from 'bun:test'
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
    // As Windows writes them, whatever system the test runs on.
    const disk: Record<string, string> = {
      'C:\\bin\\spawn-agent.ps1': 'param()',
      'C:\\bin\\spawn-agent.cmd': shims['spawn-agent.cmd'],
      'C:\\bin\\spawn-agent': shims['spawn-agent'],
    }
    const found = findCommand('spawn-agent', {
      env: { PATH: 'C:\\nope;C:\\bin', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      exists: f => f in disk || f === files.spawn.replace(/\\/g, '/'),
      read: f => disk[f] ?? null,
    })
    assert.deepEqual(found.ps, { file: 'C:\\bin\\spawn-agent.ps1', target: null })
    assert.equal(found.sh?.target, files.spawn.replace(/\\/g, '/'))
    assert.equal(found.sh?.gone, undefined)
  })

  test('claude.exe or bun.exe on PATH is hundreds of megabytes: found, never read', () => {
    const big = findCommand('claude', {
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE' },
      platform: 'win32',
      exists: f => f === 'C:\\bin\\claude.exe',
      size: () => 272_000_000,
      read: () => assert.fail('read a big file'),
    })
    assert.deepEqual(big.ps, { file: 'C:\\bin\\claude.exe', target: null })
  })

  test('a command of ours whose script is gone, and Unix shells', () => {
    const shims = planShims({ ...paths, spawn: '/gone/src/entrypoints/spawn-agent.ts' })
    const found = findCommand('spawn-agent', {
      env: { PATH: '/home/u/.local/bin' },
      platform: 'linux',
      exists: f => f === '/home/u/.local/bin/spawn-agent',
      read: () => shims['spawn-agent'],
    })
    assert.deepEqual(Object.keys(found), ['sh'])
    assert.deepEqual(found.sh, {
      file: '/home/u/.local/bin/spawn-agent',
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

  test('each shown profile’s settings.json, the first one’s at the top as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'))
    try {
      const home = join(dir, 'home')
      const env = { PATH: join(dir, 'bin') }
      const options = { root: ROOT_A, env, platform: 'win32', home }
      const at = (name: string): string => join(home, name)
      mkdirSync(at('.claude'), { recursive: true })
      writeFileSync(join(at('.claude'), 'settings.json'), '{ "model": "x" }')
      for (const name of ['.claude-work', '.claude-gamedev']) {
        mkdirSync(at(name))
        writeFileSync(join(at(name), 'settings.json'), '{ "hooks": ')
      }
      // One profile (the others found are hidden): what it was, one entry.
      const one = await gatherFacts({ wakeUrl: null }, options)
      expect(one.settingsFile).toBe(join(at('.claude'), 'settings.json'))
      expect(one.settings).toEqual({ model: 'x' })
      expect(one.profiles?.map(p => p.id)).toEqual(['default'])
      // config.json shows work: its settings.json too; hidden gamedev is left out; a folder not there says so.
      const profiles = [
        { id: 'work', title: 'Work', dir: at('.claude-work'), hidden: false },
        { id: 'gamedev', dir: at('.claude-gamedev'), hidden: true },
        { id: 'old', dir: at('.claude-old') },
      ]
      const two = await gatherFacts({ wakeUrl: null, profiles }, options)
      expect(two.profiles?.map(p => [p.id, p.title, p.exists, p.settingsError.replace(/ \(.*/, '')])).toEqual([
        ['work', 'Work', true, 'not valid JSON'],
        ['old', 'Old', false, ''],
        ['default', 'Default', true, ''],
      ])
      expect(two.profiles?.[0]?.settingsFile).toBe(join(at('.claude-work'), 'settings.json'))
      // The top-level fields are the first profile's.
      expect(two.settingsFile).toBe(join(at('.claude-work'), 'settings.json'))
      expect(two.settingsError).toMatch(/^not valid JSON/)
      // Handed in: those, as they are.
      const mine = { id: 'default', title: 'Private', dir: at('.claude'), color: 'indigo', hidden: false }
      const given = await gatherFacts({ wakeUrl: null, profiles }, { ...options, profiles: [mine] })
      expect(given.profiles).toEqual([
        {
          id: 'default',
          title: 'Private',
          dir: at('.claude'),
          exists: true,
          settingsFile: join(at('.claude'), 'settings.json'),
          settings: { model: 'x' },
          settingsError: '',
          // ROOT_A is no copy of the board on this disk: no skill of its own to compare with.
          skill: { file: join(at('.claude'), 'skills', 'herdr-agents', 'SKILL.md'), installed: null, source: null },
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the agents’ skill in each shown profile, the first one’s at the top, next to this copy’s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'))
    try {
      const home = join(dir, 'home')
      const root = join(dir, 'board')
      const source = '---\nname: herdr-agents\n---\n<!-- agent-board: installed by the install action -->\nours\n'
      const theirs = '---\nname: herdr-agents\n---\nmine\n'
      const skillOf = (folder: string): string => join(home, folder, 'skills', 'herdr-agents', 'SKILL.md')
      for (const [file, text] of [
        [boardFiles(root).skill, source],
        [skillOf('.claude'), source],
        [skillOf('.claude-work'), `\uFEFF${theirs}`],
      ] as const) {
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, text)
      }
      mkdirSync(join(home, '.claude-games'))
      const options = { root, env: { PATH: join(dir, 'bin') }, platform: 'win32', home }
      // One profile: ~/.claude's, as upstream.
      const one = await gatherFacts({ wakeUrl: null }, options)
      expect(one.skill).toEqual({ file: skillOf('.claude'), installed: source, source })
      // Shown ones each; the hidden one is not read.
      const profiles = [
        { id: 'work', title: 'Work', dir: join(home, '.claude-work') },
        { id: 'games', title: 'Games', dir: join(home, '.claude-games'), hidden: true },
        { id: 'default', title: 'Private', dir: join(home, '.claude') },
      ]
      const two = await gatherFacts({ wakeUrl: null, profiles }, options)
      expect(two.profiles?.map(p => [p.id, p.skill])).toEqual([
        ['work', { file: skillOf('.claude-work'), installed: theirs, source }],
        ['default', { file: skillOf('.claude'), installed: source, source }],
      ])
      expect(two.skill).toEqual({ file: skillOf('.claude-work'), installed: theirs, source })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a herdr-wake that answers: up; one that holds its answer: down once the probe gives up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'))
    let hold = false
    const wake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => (hold ? new Promise<Response>(() => {}) : Response.json({ ok: true })),
    })
    try {
      const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: 'win32', home: join(dir, 'home') }
      const wakeUrl = `http://127.0.0.1:${wake.port}/`
      assert.deepEqual((await gatherFacts({ wakeUrl }, options)).wake, { ok: true, status: 200 })
      hold = true
      const started = performance.now()
      const down = await gatherFacts({ wakeUrl }, { ...options, probeMs: 50 })
      assert.equal(down.wake?.ok, false)
      assert.equal(down.wake?.error, 'TimeoutError')
      assert.ok(performance.now() - started < 1000)
    } finally {
      await wake.stop(true)
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
