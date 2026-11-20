import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { findCommand, gatherFacts, herdrConfigFile, readText } from '../../src/adapters/setup-facts.ts'
import {
  wakeSessionsFile,
  wakeTakeoverSeen,
  writeWakeStatus,
  writeWakeTakeover,
} from '../../src/adapters/wake-files.ts'
import { type InstallPaths, planShims } from '../../src/core/install-plan.ts'
import { defaultProfileDir } from '../../src/core/profiles.ts'
import { boardFiles } from '../../src/core/setup.ts'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { isolatedHome } from '../support/env.ts'

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
      const none = await gatherFacts({ wakeUrl: null, wake: false }, { root: ROOT_A, env, platform: 'win32', home })
      assert.equal(none.settings, null)
      assert.equal(none.settingsError, '')
      // Joined with Windows' rules, the platform passed in, on any host (#483).
      assert.equal(none.herdrConfigFile, win32.join(dir, 'appdata', 'herdr', 'config.toml'))
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
      const broken = await gatherFacts(
        { wake: false, launch: { claude: ["it's"] } },
        { root: ROOT_A, env, platform: 'win32', home },
      )
      assert.match(broken.settingsError, /^not valid JSON/)
      assert.equal(broken.settings, null)
      assert.equal(broken.launcher?.kind, 'builtin')
      assert.match(broken.launcher?.kind === 'builtin' ? broken.launcher.error : '', /launch\.claude/)

      const herdr = await gatherFacts(
        { wake: false, launch: { agent: 'codex' } },
        { root: ROOT_A, env, platform: 'win32', home },
      )
      assert.deepEqual(herdr.launcher, { kind: 'herdr', agent: 'codex' })
      const script = join(dir, 'start.ps1')
      const command = await gatherFacts(
        { wake: false, launch: { command: [join(dir, 'pwsh.exe'), '-File', script, '{name}'] } },
        { root: ROOT_A, env, platform: 'win32', home },
      )
      assert.deepEqual(command.launcher, {
        kind: 'command',
        name: 'start',
        program: { file: win32.resolve(join(dir, 'pwsh.exe')), found: false },
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
      // The home is this disk's, where the default folder is looked for: the host's platform.
      const options = { root: ROOT_A, env, platform: process.platform, home }
      const at = (name: string): string => join(home, name)
      mkdirSync(at('.claude'), { recursive: true })
      writeFileSync(join(at('.claude'), 'settings.json'), '{ "model": "x" }')
      for (const name of ['.claude-work', '.claude-gamedev']) {
        mkdirSync(at(name))
        writeFileSync(join(at(name), 'settings.json'), '{ "hooks": ')
      }
      // One profile (the others found are hidden): what it was, one entry.
      const one = await gatherFacts({ wakeUrl: null, wake: false }, options)
      expect(one.settingsFile).toBe(join(at('.claude'), 'settings.json'))
      expect(one.settings).toEqual({ model: 'x' })
      expect(one.profiles?.map(p => p.id)).toEqual(['default'])
      // config.json shows work: its settings.json too; hidden gamedev is left out; a folder not there says so.
      const profiles = [
        { id: 'work', title: 'Work', dir: at('.claude-work'), hidden: false },
        { id: 'gamedev', dir: at('.claude-gamedev'), hidden: true },
        { id: 'old', dir: at('.claude-old') },
      ]
      const two = await gatherFacts({ wakeUrl: null, wake: false, profiles }, options)
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
      const given = await gatherFacts({ wakeUrl: null, wake: false, profiles }, { ...options, profiles: [mine] })
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
          herdrHook: { script: null, found: false },
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
      // The home is this disk's, where the default folder is looked for: the host's platform.
      const options = { root, env: { PATH: join(dir, 'bin') }, platform: process.platform, home }
      // One profile: ~/.claude's, as upstream.
      const one = await gatherFacts({ wakeUrl: null, wake: false }, options)
      expect(one.skill).toEqual({ file: skillOf('.claude'), installed: source, source })
      // Shown ones each; the hidden one is not read.
      const profiles = [
        { id: 'work', title: 'Work', dir: join(home, '.claude-work') },
        { id: 'games', title: 'Games', dir: join(home, '.claude-games'), hidden: true },
        { id: 'default', title: 'Private', dir: join(home, '.claude') },
      ]
      const two = await gatherFacts({ wakeUrl: null, wake: false, profiles }, options)
      expect(two.profiles?.map(p => [p.id, p.skill])).toEqual([
        ['work', { file: skillOf('.claude-work'), installed: theirs, source }],
        ['default', { file: skillOf('.claude'), installed: source, source }],
      ])
      expect(two.skill).toEqual({ file: skillOf('.claude-work'), installed: theirs, source })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('herdr’s own Claude hook in each shown profile, the first one’s at the top', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-setup-'))
    try {
      const home = join(dir, 'home')
      const scriptOf = (folder: string): string => join(home, folder, 'hooks', 'herdr-agent-state.ps1')
      const entry = (folder: string): string =>
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptOf(folder)}" session`,
                  },
                ],
              },
            ],
          },
        })
      // ~/.claude: herdr's, as herdr writes it; work: none; games: the entry, its script gone.
      for (const [folder, settings, script] of [
        ['.claude', entry('.claude'), true],
        ['.claude-work', '{}', false],
        ['.claude-games', entry('.claude-games'), false],
      ] as const) {
        mkdirSync(join(home, folder, 'hooks'), { recursive: true })
        writeFileSync(join(home, folder, 'settings.json'), settings)
        if (script) writeFileSync(scriptOf(folder), '# installed by herdr\n')
      }
      // The home is this disk's, where the default folder is looked for: the host's platform.
      const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: process.platform, home }
      // One profile: ~/.claude's.
      const one = await gatherFacts({ wakeUrl: null, wake: false }, options)
      expect(one.herdrHook).toEqual({ script: scriptOf('.claude'), found: true })
      const profiles = [
        { id: 'work', title: 'Work', dir: join(home, '.claude-work') },
        { id: 'games', title: 'Games', dir: join(home, '.claude-games') },
        { id: 'default', title: 'Private', dir: join(home, '.claude') },
      ]
      const two = await gatherFacts({ wakeUrl: null, wake: false, profiles }, options)
      expect(two.profiles?.map(p => [p.id, p.herdrHook])).toEqual([
        ['work', { script: null, found: false }],
        ['games', { script: scriptOf('.claude-games'), found: false }],
        ['default', { script: scriptOf('.claude'), found: true }],
      ])
      expect(two.herdrHook).toEqual({ script: null, found: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('profiles are read for the platform passed in, whatever the host (#300)', async () => {
    const shownDirs = async (platform: string, home: string, profiles?: unknown[], own?: string) => {
      const env = { PATH: '', ...(own && { CLAUDE_CONFIG_DIR: own }) }
      const facts = await gatherFacts(
        { wakeUrl: null, wake: false, ...(profiles && { profiles }) } as Parameters<typeof gatherFacts>[0],
        { root: ROOT_A, env, platform, home },
      )
      return facts.profiles?.map(p => [p.id, p.dir])
    }
    // The homes are no folders on this disk (findProfileDirs finds nothing there).
    // Windows: a listed C:\ folder is absolute and the default folder is joined with \, on any host.
    const anna = 'C:\\Users\\anna'
    expect(await shownDirs('win32', anna)).toEqual([['default', 'C:\\Users\\anna\\.claude']])
    const work = 'C:\\Users\\anna\\.claude-work'
    expect(await shownDirs('win32', anna, [{ id: 'work', title: 'Work', dir: work }], work)).toEqual([['work', work]])
    // CLAUDE_CONFIG_DIR with ~, listed nowhere: the board's own profile, joined for the platform.
    expect(await shownDirs('win32', anna, undefined, '~/.claude-work')).toEqual([['work', work]])
    // No profile shown (handed in empty): the default folder's settings.json, read on this disk.
    const none = await gatherFacts(
      { wakeUrl: null, wake: false },
      { root: ROOT_A, env: {}, platform: 'win32', home: anna, profiles: [] },
    )
    expect(none.settingsFile).toBe(join(defaultProfileDir(anna, 'win32'), 'settings.json'))
    // Linux: ~ joined with /, a /c/ folder left as it is (Git Bash's spelling only on Windows).
    const ben = '/home/ben'
    expect(await shownDirs('linux', ben)).toEqual([['default', '/home/ben/.claude']])
    expect(await shownDirs('linux', ben, undefined, '~/.claude-work')).toEqual([['work', '/home/ben/.claude-work']])
    const listed = [
      { id: 'work', title: 'Work', dir: '/home/ben/.claude-work' },
      { id: 'games', title: 'Games', dir: '~/.claude-games' },
      { id: 'scratch', title: 'Scratch', dir: '/c/scratch' },
    ]
    expect(await shownDirs('linux', ben, listed, '/home/ben/.claude-work')).toEqual([
      ['work', '/home/ben/.claude-work'],
      ['games', '/home/ben/.claude-games'],
      ['scratch', '/c/scratch'],
    ])
  })

  test('bin folder, herdr config and a launcher path joined for the platform passed in (#483)', async () => {
    const facts = (platform: string, home: string, env: Record<string, string>, command: string) =>
      gatherFacts(
        { wakeUrl: null, wake: false, launch: { command: [command] } },
        {
          root: ROOT_A,
          env: { PATH: '', ...env },
          platform,
          home,
        },
      )
    // Windows on any host: \ throughout, a C:\ program taken as it is.
    const win = await facts('win32', 'C:\\Users\\anna', {}, 'C:\\Tools\\claude.exe')
    expect(win.binDir).toBe('C:\\Users\\anna\\.local\\bin')
    expect(win.herdrConfigFile).toBe('C:\\Users\\anna\\.config\\herdr\\config.toml')
    expect(win.launcher).toMatchObject({ kind: 'command', program: { file: 'C:\\Tools\\claude.exe' } })
    const roaming = await facts('win32', 'C:\\Users\\anna', { APPDATA: 'C:\\Users\\anna\\AppData\\Roaming' }, 'claude')
    expect(roaming.herdrConfigFile).toBe('C:\\Users\\anna\\AppData\\Roaming\\herdr\\config.toml')
    // Linux on any host: / throughout, a /opt program with no drive put in front.
    const linux = await facts('linux', '/home/ben', {}, '/opt/claude/bin/claude')
    expect(linux.binDir).toBe('/home/ben/.local/bin')
    expect(linux.herdrConfigFile).toBe('/home/ben/.config/herdr/config.toml')
    expect(linux.launcher).toMatchObject({ kind: 'command', program: { file: '/opt/claude/bin/claude' } })
  })

  // Before wake ships, wake off is herdr-wake's line at wakeUrl; once it ships the board's own wake
  // has the line whether on or off, and herdr-wake is not asked (the twin below).
  test.skipIf(WAKE_SHIPPED)(
    'a herdr-wake that answers: up; one that holds its answer: down once the probe gives up',
    async () => {
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
        assert.deepEqual((await gatherFacts({ wakeUrl, wake: false }, options)).wake, { ok: true, status: 200 })
        hold = true
        const started = performance.now()
        const down = await gatherFacts({ wakeUrl, wake: false }, { ...options, probeMs: 50 })
        assert.equal(down.wake?.ok, false)
        assert.equal(down.wake?.error, 'TimeoutError')
        assert.ok(performance.now() - started < 1000)
      } finally {
        await wake.stop(true)
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('wake that answers on its port: running; one that holds its answer: not answering once the probe gives up', async () => {
    // Wake's status file is read from the board's state folder: a temp one here.
    const dir = isolatedHome()
    let hold = false
    const wake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => (hold ? new Promise<Response>(() => {}) : Response.json({ pid: 4242, sessions: {}, sleeping: [] })),
    })
    try {
      const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: 'win32', home: join(dir, 'home') }
      const port = Number(wake.port)
      // wakeUrl at a port no one listens on: never asked while the board's own wake is on.
      const cfg = { wakeUrl: `http://127.0.0.1:${port + 1}`, wake: { enabled: true, port } }
      const up = await gatherFacts(cfg, options)
      assert.equal(up.wakeNew?.state, 'running')
      // herdr-wake's line is not asked for while the board's own wake has it.
      assert.equal(up.wake, null)
      hold = true
      const started = performance.now()
      const down = await gatherFacts(cfg, { ...options, probeMs: 50 })
      assert.equal(down.wakeNew?.state, 'notRunning')
      assert.ok(performance.now() - started < 1000)
    } finally {
      await wake.stop(true)
    }
  })

  /** A wake on a port of the test's own answering `answer` per path; the paths asked, in order. */
  function wakeOnPort(answer: (path: string) => Response | Promise<Response>) {
    const asked: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: req => {
        const path = new URL(req.url).pathname
        asked.push(path)
        return answer(path)
      },
    })
    return { port: Number(server.port), asked, stop: () => server.stop(true) }
  }
  /** The separate herdr-wake plugin's router: /status only (no Telegram state), a 404 for the rest. */
  const oldRouter = (path: string): Response =>
    path === '/status' ? Response.json({ pid: 4242, sessions: {} }) : new Response(null, { status: 404 })

  test('wake that answers its /alive runs though its /status (a herdr snapshot) hangs; the old router on its port does not', async () => {
    const dir = isolatedHome()
    writeWakeStatus({ state: 'running', at: Date.now(), pid: 4242 })
    mkdirSync(dirname(wakeSessionsFile()), { recursive: true })
    writeFileSync(
      wakeSessionsFile(),
      JSON.stringify({ 'w1:p2': { session: 's-bill', name: 'Billing', seen_at: 1, slept_at: 2 } }),
    )
    const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: 'win32', home: join(dir, 'home') }
    const board = wakeOnPort(path =>
      path === '/alive' ? Response.json({ pid: 4242 }) : new Promise<Response>(() => {}),
    )
    const router = wakeOnPort(oldRouter)
    try {
      const up = await gatherFacts(
        { wakeUrl: null, wake: { enabled: true, port: board.port } },
        { ...options, probeMs: 300 },
      )
      // Its sleepers from its session file, as /status gave none in time.
      assert.deepEqual([up.wakeNew?.state, up.wakeNew?.asleep], ['running', 1])
      assert.equal(board.asked[0], '/alive')
      writeWakeStatus({ state: 'stopped', at: Date.now() })
      const old = await gatherFacts({ wakeUrl: null, wake: { enabled: true, port: router.port } }, options)
      assert.equal(old.wakeNew?.state, 'notRunning')
      assert.deepEqual(router.asked, ['/alive'])
    } finally {
      await board.stop()
      await router.stop()
    }
  })

  test('port taken: by the separate plugin’s router, its process named; by another program, none', async () => {
    const dir = isolatedHome()
    const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: 'win32', home: join(dir, 'home') }
    const router = wakeOnPort(oldRouter)
    const other = wakeOnPort(() => new Response('<html>not wake</html>'))
    try {
      const taken = (port: number) => {
        writeWakeStatus({ state: 'portTaken', at: Date.now(), port, error: `Port ${port} is taken` })
        return gatherFacts({ wakeUrl: null, wake: { enabled: true, port } }, options)
      }
      const byRouter = (await taken(router.port)).wakeNew
      assert.deepEqual([byRouter?.state, byRouter?.router], ['portTaken', 4242])
      const byOther = (await taken(other.port)).wakeNew
      assert.deepEqual([byOther?.state, byOther?.router], ['portTaken', undefined])
    } finally {
      await router.stop()
      await other.stop()
    }
  })

  test('wake off ("wake": false, or off with a port): no question on its port', async () => {
    const dir = isolatedHome()
    writeWakeStatus({ state: 'running', at: Date.now(), pid: 4242 })
    const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: 'win32', home: join(dir, 'home') }
    const wake = wakeOnPort(() => Response.json({ pid: 4242, sessions: {}, telegram: { state: 'off' } }))
    try {
      for (const off of [false, { enabled: false, port: wake.port }]) {
        const facts = await gatherFacts({ wakeUrl: null, wake: off }, options)
        assert.equal(facts.wakeNew?.state ?? null, WAKE_SHIPPED ? 'off' : null)
      }
      assert.deepEqual(wake.asked, [])
    } finally {
      await wake.stop()
    }
  })

  test('the takeover at wake’s first start: its sleeping sessions while its marker is unseen; none once seen, or for Switch over…', async () => {
    const dir = isolatedHome()
    const options = { root: ROOT_A, env: { PATH: join(dir, 'bin') }, platform: 'win32', home: join(dir, 'home') }
    const cfg = { wakeUrl: null, wake: { enabled: true, port: 9 } }
    const summary = { reaper: 'off', minutes: 60, excluded: 2, telegram: false, asleep: 4 } as const
    writeWakeTakeover({ at: 1, did: ['config: reaper'], summary, launcher: null, bindings: [], unseen: true })
    assert.equal((await gatherFacts(cfg, options)).wakeNew?.takenOver, 4)
    wakeTakeoverSeen()
    assert.equal((await gatherFacts(cfg, options)).wakeNew?.takenOver, undefined)
    // Switch over… (said in the panel at once): no unseen mark, no line.
    writeWakeTakeover({ at: 1, did: [], summary, launcher: null, bindings: [] })
    assert.equal((await gatherFacts(cfg, options)).wakeNew?.takenOver, undefined)
  })

  test('herdr’s config.toml under %APPDATA%, else ~/.config; a text file without its BOM', () => {
    assert.equal(
      herdrConfigFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u'),
      join('C:\\Users\\u\\AppData\\Roaming', 'herdr', 'config.toml'),
    )
    assert.equal(herdrConfigFile({}, '/home/u'), join('/home/u', '.config', 'herdr', 'config.toml'))
    // The platform passed in, whatever the host (#483).
    assert.equal(herdrConfigFile({}, '/home/u', 'linux'), '/home/u/.config/herdr/config.toml')
    assert.equal(
      herdrConfigFile({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u', 'win32'),
      'C:\\Users\\u\\AppData\\Roaming\\herdr\\config.toml',
    )
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
