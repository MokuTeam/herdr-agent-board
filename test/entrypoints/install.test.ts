import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { planShims, quote } from '../../src/core/install-plan.ts'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { oldSource } from '../web/support/old-app.ts'

// The install action end to end, only ever against a sandbox's home (HOME and USERPROFILE).
const entry = (name: string): string => join(root, 'src', 'entrypoints', name)

/** The sandbox's home, after making sure it is one (install writes there). */
function homeOf(box: Sandbox): string {
  for (const dir of [box.env.HOME, box.env.USERPROFILE] as string[]) {
    assert.ok(dir.startsWith(box.dir + sep), `${dir} is outside the sandbox`)
  }
  return box.env.USERPROFILE as string
}

/**
 * The board's config in the sandbox, unless the test wrote one: no herdr-wake and the board's own
 * wake off (#119), so the install writes no wake hook and the check that ends it asks no port on
 * this computer. The tests of wake's hooks turn it on with a port of their own.
 */
function boardConfig(box: Sandbox, cfg: Record<string, unknown> = { language: 'en', wakeUrl: '', wake: false }): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  if (existsSync(join(dir, 'config.json'))) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
}

async function install(box: Sandbox, bun = process.execPath, ...args: string[]) {
  homeOf(box)
  boardConfig(box)
  const proc = Bun.spawn([bun, entry('install.ts'), ...args], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('install: settings.json backed up and rewritten with the Bun path, shims in ~/.local/bin', async () => {
  const box = await sandbox()
  const home = homeOf(box)
  const claude = join(home, '.claude')
  const bin = join(home, '.local', 'bin')
  mkdirSync(claude, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const own = { hooks: [{ type: 'command', command: 'echo hi' }] }
  const before = {
    model: 'opus',
    hooks: {
      SessionStart: [own, { hooks: [{ type: 'command', command: 'node "C:\\x\\agent-board\\src\\hook.mjs"' }] }],
    },
    statusLine: { type: 'command', command: 'node "C:/x/agent-board/src/statusline.mjs"' },
  }
  const original = `${JSON.stringify(before, null, 2)}\n`
  writeFileSync(join(claude, 'settings.json'), original)
  writeFileSync(join(bin, 'board.cmd'), '@echo someone else\r\n')

  const { code, stdout, stderr } = await install(box)
  assert.equal(code, 0, stderr)

  const command = (name: string): string => `${quote(process.execPath)} ${quote(entry(name))}`
  const ours = { hooks: [{ type: 'command', command: command('hook.ts'), timeout: 10 }] }
  assert.equal(readFileSync(join(claude, 'settings.json.bak-agent-board'), 'utf8'), original)
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')), {
    model: 'opus',
    hooks: {
      SessionStart: [own, ours],
      UserPromptSubmit: [ours],
      PreToolUse: [{ matcher: 'AskUserQuestion', ...ours }],
    },
    statusLine: { type: 'command', command: command('statusline.ts') },
  })
  assert.ok(readFileSync(join(bin, 'board'), 'utf8').includes(`\nexec ${command('cli.ts')} "$@"\n`))
  // A board.cmd that is not ours stays.
  assert.equal(readFileSync(join(bin, 'board.cmd'), 'utf8'), '@echo someone else\r\n')
  assert.match(stdout, /skipped .*board\.cmd: exists and is not ours/)
  assert.ok(stdout.includes(`status line: ${entry('statusline.ts')}`), stdout)
})

test('install: a status line someone else set stays, and install says so', async () => {
  const box = await sandbox()
  const claude = join(homeOf(box), '.claude')
  mkdirSync(claude, { recursive: true })
  // Not our status line, though the file it runs has our hook's name.
  const line = { type: 'command', command: 'node "C:/x/agent-board/src/hook.mjs"' }
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ statusLine: line }))
  const { code, stdout, stderr } = await install(box)
  assert.equal(code, 0, stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).statusLine, line)
  assert.ok(stdout.includes(`status line in ${join(claude, 'settings.json')}: left as it was (not ours)`), stdout)
})

test('install: a settings.json that is not an object is left as it was', async () => {
  const box = await sandbox()
  const claude = join(homeOf(box), '.claude')
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, 'settings.json'), '[]\n')
  const { code, stderr } = await install(box)
  assert.equal(code, 1)
  assert.match(stderr, /not a JSON object/)
  assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), '[]\n')
  assert.ok(!existsSync(join(claude, 'settings.json.bak-agent-board')))
})

test('install: "hooks" that is not an object is replaced with the board’s, as upstream', async () => {
  const box = await sandbox()
  const claude = join(homeOf(box), '.claude')
  mkdirSync(claude, { recursive: true })
  const original = `${JSON.stringify({ model: 'opus', hooks: [] })}\n`
  writeFileSync(join(claude, 'settings.json'), original)
  const { code, stderr } = await install(box)
  assert.equal(code, 0, stderr)
  const ours = {
    hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(entry('hook.ts'))}`, timeout: 10 }],
  }
  const after = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'))
  assert.equal(after.model, 'opus')
  assert.deepEqual(after.hooks, {
    SessionStart: [ours],
    UserPromptSubmit: [ours],
    PreToolUse: [{ matcher: 'AskUserQuestion', ...ours }],
  })
  assert.equal(readFileSync(join(claude, 'settings.json.bak-agent-board'), 'utf8'), original)
})

test('install in a sandbox: the commands, the hooks once, a backup, and notifications only when asked', async () => {
  const box = await sandbox()
  const home = homeOf(box)
  const settingsFile = join(home, '.claude', 'settings.json')
  const run = async (...args: string[]) => {
    const r = await install(box, process.execPath, ...args)
    return { code: r.code, out: r.stdout + r.stderr }
  }
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    settingsFile,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } }),
  )
  const first = await run()
  assert.equal(first.code, 0, first.out)
  for (const name of ['board', 'board.cmd', 'spawn-agent', 'spawn-agent.cmd'])
    assert.ok(existsSync(join(home, '.local', 'bin', name)), name)
  const skill = join(home, '.claude', 'skills', 'herdr-agents', 'SKILL.md')
  assert.equal(readFileSync(skill, 'utf8'), readFileSync(join(root, 'skills', 'herdr-agents', 'SKILL.md'), 'utf8'))
  // Where upstream says it: after the commands, before the hooks.
  assert.match(first.out, new RegExp(`^commands: .*\\nskill: ${literal(skill)}\\nhooks: `, 'm'))
  assert.ok(existsSync(`${settingsFile}.bak-agent-board`))
  const after = JSON.parse(readFileSync(settingsFile, 'utf8'))
  assert.equal(after.hooks.SessionStart.length, 1)
  assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: 'command', command: 'theirs' }] }])
  assert.match(first.out, /commands: board, spawn-agent/)
  assert.match(first.out, /Sleep and wake is off/) // and how to turn it on, from the check
  assert.match(first.out, /things? need/)
  const second = await run(windows ? '--toast' : '--no-toast')
  assert.equal(second.code, 0, second.out)
  const again = JSON.parse(readFileSync(settingsFile, 'utf8'))
  assert.equal(again.hooks.SessionStart.length, 1)
  assert.equal(again.hooks.Stop.length, windows ? 2 : 1)
  // Someone else's command of that name is left alone.
  writeFileSync(join(home, '.local', 'bin', 'spawn-agent'), '#!/bin/sh\necho mine\n')
  assert.match((await run()).out, /skipped .*spawn-agent: exists and is not ours/)
  assert.equal(readFileSync(join(home, '.local', 'bin', 'spawn-agent'), 'utf8'), '#!/bin/sh\necho mine\n')
  // And so is someone else's skill of that name.
  writeFileSync(skill, '---\nname: herdr-agents\n---\nmine\n')
  assert.match((await run()).out, /skipped .*SKILL\.md: a skill of that name that is not ours/)
  assert.equal(readFileSync(skill, 'utf8'), '---\nname: herdr-agents\n---\nmine\n')
  // Windows PowerShell 5.1 writes UTF-8 with a BOM: still read.
  writeFileSync(settingsFile, `\uFEFF${JSON.stringify({ model: 'opus' })}`)
  assert.equal((await run()).code, 0)
  assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).model, 'opus')
  // A settings.json that does not parse: nothing is touched, it says so.
  writeFileSync(settingsFile, '{ "hooks": ')
  const broken = await run()
  assert.equal(broken.code, 1)
  assert.match(broken.out, /not valid JSON/)
  assert.equal(readFileSync(settingsFile, 'utf8'), '{ "hooks": ')
}, 30_000)

// ------------------------------------------------------------------ Claude profiles

const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8')
/** `text` as a regular expression that matches it as it is. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ours = (): unknown => ({
  hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(entry('hook.ts'))}`, timeout: 10 }],
})

/** The home's profile folders, each with this settings.json; config.json lists them as given (the rest shown). */
function profilesIn(box: Sandbox, folders: Record<string, string | null>, hidden: string[] = []): string {
  const home = homeOf(box)
  const profiles = Object.entries(folders).map(([name, settings], i) => {
    const dir = join(home, name)
    if (settings !== null) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'settings.json'), settings)
    }
    const id = name === '.claude' ? 'default' : name.replace(/^\.claude-/, '')
    const title = id === 'default' ? 'Private' : id.charAt(0).toUpperCase() + id.slice(1)
    return { id, title, dir, color: ['indigo', 'teal', 'pink'][i], hidden: hidden.includes(id) }
  })
  boardConfig(box, { language: 'en', wakeUrl: '', wake: false, profiles })
  return home
}

test('install writes into every shown profile and touches no hidden one', async () => {
  const box = await sandbox()
  const before = `${JSON.stringify({ model: 'x' }, null, 2)}\n`
  const home = profilesIn(box, { '.claude': before, '.claude-work': before, '.claude-gamedev': before }, ['gamedev'])
  const { code, stdout, stderr } = await install(box)
  expect(code).toBe(0)
  expect(stderr).toBe('')
  const skill = read(root, 'skills', 'herdr-agents', 'SKILL.md')
  for (const p of ['.claude', '.claude-work']) {
    expect(JSON.parse(read(home, p, 'settings.json')).hooks.SessionStart.at(-1)).toEqual(ours())
    expect(read(home, p, 'settings.json.bak-agent-board')).toBe(before)
    // The agents' skill too, each profile its own copy, said before its hooks.
    expect(read(home, p, 'skills', 'herdr-agents', 'SKILL.md')).toBe(skill)
    expect(stdout).toContain(
      `skill: ${join(home, p, 'skills', 'herdr-agents', 'SKILL.md')}\nhooks: SessionStart, UserPromptSubmit, PreToolUse (AskUserQuestion) -> ${entry('hook.ts')} in ${join(home, p, 'settings.json')}\nstatus line: ${entry('statusline.ts')}\n`,
    )
  }
  expect(read(home, '.claude-gamedev', 'settings.json')).toBe(before)
  expect(readdirSync(join(home, '.claude-gamedev'))).toEqual(['settings.json'])
  expect(readdirSync(join(home, '.claude-work')).sort()).toEqual([
    'settings.json',
    'settings.json.bak-agent-board',
    'skills',
  ])
  expect(readdirSync(join(home, '.claude-work', 'skills'))).toEqual(['herdr-agents'])
  expect(readdirSync(join(home, '.claude-work', 'skills', 'herdr-agents'))).toEqual(['SKILL.md'])
  // The commands once; the check after it per shown profile, by name, and not the hidden one.
  expect(stdout.match(/^commands: /gm)).toHaveLength(1)
  expect(stdout).toMatch(/^ok Private: Claude Code hooks · /m)
  expect(stdout).toMatch(/^ok Work: Claude Code hooks · /m)
  expect(stdout).toMatch(/^ok Work: Status line · /m)
  expect(stdout).toMatch(/^ok Private: Skill herdr-agents for the agents · /m)
  expect(stdout).toMatch(/^ok Work: Skill herdr-agents for the agents · /m)
  expect(stdout).not.toContain('gamedev')
  expect(stdout).not.toContain('Gamedev')
}, 30_000)

test('herdr’s own Claude hook: herdr writes it into every shown profile, CLAUDE_CONFIG_DIR set to each, not a hidden one', async () => {
  const box = await sandbox()
  const home = profilesIn(box, { '.claude': '{}', '.claude-work': '{}', '.claude-gamedev': '{}' }, ['gamedev'])
  box.state({ 'integration install claude': { claudeHook: true } })
  const { code, stdout, stderr } = await install(box)
  expect(code).toBe(0)
  expect(stderr).toBe('')
  expect(box.calls()).toEqual([
    ['integration', 'install', 'claude'],
    ['integration', 'install', 'claude'],
  ])
  for (const p of ['.claude', '.claude-work']) {
    expect(existsSync(join(home, p, 'hooks', 'herdr-agent-state.ps1'))).toBe(true)
    // herdr's entry next to the board's.
    const start = JSON.parse(read(home, p, 'settings.json')).hooks.SessionStart
    expect(start).toContainEqual(ours())
    expect(JSON.stringify(start)).toContain('herdr-agent-state.ps1')
    // After the board's own, per profile.
    expect(stdout).toMatch(
      new RegExp(
        `^status line: .*\\n(desktop notifications: .*\\n)?herdr's hook: claude integration in ${literal(join(home, p))}$`,
        'm',
      ),
    )
  }
  expect(readdirSync(join(home, '.claude-gamedev'))).toEqual(['settings.json'])
  // The check after it finds it in each.
  expect(stdout).toMatch(/^ok Private: herdr’s Claude hook · /m)
  expect(stdout).toMatch(/^ok Work: herdr’s Claude hook · /m)
}, 30_000)

test('a herdr that cannot install its hook: said per profile, the rest installed all the same', async () => {
  const box = await sandbox()
  const home = profilesIn(box, { '.claude': '{}', '.claude-work': '{}' })
  box.state({ 'integration install claude': { error: 'no such command' } })
  const { code, stdout, stderr } = await install(box)
  expect(code).toBe(0)
  expect(stderr).toBe('')
  for (const p of ['.claude', '.claude-work']) {
    expect(JSON.parse(read(home, p, 'settings.json')).hooks.SessionStart).toEqual([ours()])
    expect(existsSync(join(home, p, 'skills', 'herdr-agents', 'SKILL.md'))).toBe(true)
    expect(stdout).toContain(
      `herdr's hook in ${join(home, p)}: not installed: herdr integration install: no such command\n`,
    )
  }
  expect(stdout).toMatch(/^! {2}Work: herdr’s Claude hook is missing$/m)
  expect(stdout).toContain('herdr plugin action invoke agent-board.install')
}, 30_000)

test('the agents’ skill per shown profile: someone else’s in one is left alone there, and the check says so', async () => {
  const box = await sandbox()
  const home = profilesIn(box, { '.claude': '{}', '.claude-work': '{}' })
  const theirs = join(home, '.claude-work', 'skills', 'herdr-agents', 'SKILL.md')
  mkdirSync(dirname(theirs), { recursive: true })
  writeFileSync(theirs, '---\nname: herdr-agents\n---\nmine\n')
  const { code, stdout, stderr } = await install(box)
  expect(code).toBe(0)
  expect(stderr).toBe('')
  expect(read(theirs)).toBe('---\nname: herdr-agents\n---\nmine\n')
  expect(stdout).toContain(`skipped ${theirs}: a skill of that name that is not ours\n`)
  expect(read(home, '.claude', 'skills', 'herdr-agents', 'SKILL.md')).toBe(
    read(root, 'skills', 'herdr-agents', 'SKILL.md'),
  )
  expect(stdout).toMatch(/^ok Private: Skill herdr-agents for the agents · /m)
  expect(stdout).toMatch(/^! {2}Work: Skill herdr-agents is not the board's$/m)
}, 30_000)

test('the skill install copies is upstream’s, word for word, but for what `board sleep` added', () => {
  // Pinned to the newest web merge ported, b2c5afa (#50 brought it, #51 changed it, #56 last, its `board archive`
  // line; nothing since, up to f0cef14); a later upstream change moves the pin. #60 added `board sleep`: its
  // section, the line pointing to it and its words in the description, taken out here; #130 its `--self`, in
  // the same section and words. #279: what becomes of an archived session's reminders, after `board archive`.
  // The board on its own server: wake's key on its port, a CLI's browser login in the agent's own browser, and
  // the owner's secrets (the store and an agent's request, #273), each a line or a section of its own.
  const ours = read(root, 'skills', 'herdr-agents', 'SKILL.md')
    .replace(
      ' On the board\'s own server (`board doctor` says "Server mode") add `-H "X-Board-Key: $(cat ~/.local/state/herdr/plugins/agent-board/local-key)"`.',
      '',
    )
    .replace(
      /\nOn the board's own server \(your browser tools are `mcp__board-browser__\*`\)[\s\S]*?(?=\n## Restart yourself\n)/,
      '',
    )
    .replace(/\n## Secrets\n[\s\S]*?(?=\n## Do not\n)/, '')
    .replace(
      ' Its board reminders wait with it, parked: `board schedule --session <name>` lists them, `board schedule --move <id>` moves one to you, `board unschedule <id>` removes one.',
      '',
    )
    .replace(' put the sessions it coordinates to sleep in one call (itself too, once its run is over),', '')
    .replace('- Putting sessions to sleep that you coordinate: see the next section, one call for all of them.\n', '')
    .replace(/## Put the sessions you are done with to sleep\n[\s\S]*?(?=## Do something later\n)/, '')
  expect(ours).toBe(oldSource('skills/herdr-agents/SKILL.md', 'b2c5afa'))
})

test('one shown profile’s settings.json that does not parse: nothing is written anywhere', async () => {
  const box = await sandbox()
  const before = `${JSON.stringify({ model: 'x' })}\n`
  const home = profilesIn(box, { '.claude': before, '.claude-work': '{' })
  const broken = await install(box)
  expect(broken.code).toBe(1)
  expect(broken.stdout).toContain(
    `${join(home, '.claude-work', 'settings.json')} is not valid JSON: fix it, then run the install again. Nothing was changed.`,
  )
  const untouched = (): void => {
    expect(read(home, '.claude', 'settings.json')).toBe(before)
    expect(readdirSync(join(home, '.claude'))).toEqual(['settings.json'])
    expect(readdirSync(join(home, '.claude-work'))).toEqual(['settings.json'])
    expect(existsSync(join(home, '.local'))).toBe(false) // no commands either
  }
  untouched()
  // One that is no JSON object: the same, the file named.
  writeFileSync(join(home, '.claude-work', 'settings.json'), '[]')
  const list = await install(box)
  expect(list.code).toBe(1)
  expect(list.stderr).toContain(`${join(home, '.claude-work', 'settings.json')}: settings.json is not a JSON object`)
  expect(read(home, '.claude-work', 'settings.json')).toBe('[]')
  untouched()
}, 30_000)

test('a shown profile whose folder is gone is skipped, saying so', async () => {
  const box = await sandbox()
  const home = profilesIn(box, { '.claude': '{}', '.claude-work': null })
  const { code, stdout, stderr } = await install(box)
  expect(code).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toContain(`skipped ${join(home, '.claude-work')}: the folder is not there\n`)
  expect(existsSync(join(home, '.claude-work'))).toBe(false)
  expect(JSON.parse(read(home, '.claude', 'settings.json')).hooks.SessionStart).toEqual([ours()])
  expect(stdout).toMatch(new RegExp(`^!  Work: its folder ${literal(join(home, '.claude-work'))} is not there$`, 'm'))
}, 30_000)

// board.cmd under a Windows user name that is not ASCII: Bun itself lives under it (%USERPROFILE%\.bun).
const windows = process.platform === 'win32'
const cmdExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')

/** This Bun under a Cyrillic folder in the sandbox: a hard link, else a copy. */
function cyrillicBun(box: Sandbox): string {
  const dir = join(box.dir, 'Имя пользователя', '.bun', 'bin')
  mkdirSync(dir, { recursive: true })
  const bun = join(dir, 'bun.exe')
  try {
    linkSync(process.execPath, bun)
  } catch {
    copyFileSync(process.execPath, bun)
  }
  return bun
}

/** `cmd /c` with the console in code page `cp`, running `line`; System32 on PATH, as in any console. */
function underCodePage(box: Sandbox, cp: string, line: string) {
  const env = { ...box.env, PATH: `${dirname(cmdExe)};${box.env.PATH}` }
  const proc = Bun.spawnSync([cmdExe, '/d', '/s', '/c', `"chcp ${cp} >nul & ${line}"`], {
    env,
    windowsVerbatimArguments: true,
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

test.skipIf(!windows)(
  'board.cmd with Cyrillic paths runs under code pages 866, 437 and 65001: arguments through, exit code and code page kept',
  async () => {
    const box = await sandbox()
    const bun = cyrillicBun(box)
    const cli = join(box.dir, 'Имя пользователя', 'плагин', 'cli.ts')
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(3)\n')
    const shim = join(box.dir, 'Имя пользователя', 'board.cmd')
    // As install writes it: a string, so UTF-8 without a BOM.
    writeFileSync(
      shim,
      planShims({ bun, cli, hook: '', statusline: '', spawn: '', toast: '', binDir: dirname(shim) })['board.cmd'],
    )
    for (const cp of ['866', '437', '65001']) {
      const run = underCodePage(box, cp, `"${shim}" one "two words" Жук`)
      assert.equal(run.code, 3, `${cp}: ${run.stdout}${run.stderr}`)
      assert.equal(run.stdout, '["one","two words","Жук"]\n', cp)
      assert.equal(run.stderr, '', cp)
      const after = underCodePage(box, cp, `call "${shim}" & chcp`)
      assert.match(after.stdout.trim().split('\n').at(-1) ?? '', new RegExp(`\\b${cp}\\b`), `${cp}: ${after.stdout}`)
    }
  },
  20_000,
)

test.skipIf(!windows)(
  'install run by a Bun under a Cyrillic folder writes a board.cmd (UTF-8, no BOM) that runs under code page 866',
  async () => {
    const box = await sandbox()
    const bun = cyrillicBun(box)
    const { code, stderr } = await install(box, bun)
    assert.equal(code, 0, stderr)
    const shim = join(homeOf(box), '.local', 'bin', 'board.cmd')
    const bytes = readFileSync(shim)
    assert.deepEqual([...bytes.subarray(0, 4)], [...Buffer.from('@rem')], 'no BOM')
    const expected = planShims({
      bun,
      cli: entry('cli.ts'),
      hook: '',
      statusline: '',
      spawn: '',
      toast: '',
      binDir: '',
    })['board.cmd']
    assert.deepEqual(bytes, Buffer.from(expected, 'utf8'))
    const help = underCodePage(box, '866', `"${shim}" help`)
    assert.equal(help.code, 0, help.stdout + help.stderr)
    assert.match(help.stdout, /^board \[cat <id>/)
    const unknown = underCodePage(box, '866', `"${shim}" frobnicate --session 11111111-2222-3333-4444-555555555555`)
    assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr)
    assert.match(unknown.stderr, /^board: unknown command "frobnicate"/)
  },
  20_000,
)

// ------------------------------------------------------------------ wake's hooks (#119)

const wakeEntry = (matcher: string, mode: string, timeout: number) => ({
  matcher,
  hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(entry('wake-hook.ts'))} ${mode}`, timeout }],
})
const SEND = wakeEntry('SendMessage', 'pre-send', 180)
const LIST = wakeEntry('ListAgents', 'post-list', 10)
const THEIRS = { hooks: [{ type: 'command', command: 'theirs' }] }
const THEIR_BASH = { matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }
const wakeAdded = (home: string, p: string): string =>
  `wake hooks: ListAgents, SendMessage -> ${entry('wake-hook.ts')} in ${join(home, p, 'settings.json')}\n`
const WAKE_HELD =
  "wake hooks: not added: the separate herdr-wake plugin's are there (Settings → Sleep and wake… → Switch over…)\n"

/** config.json's `wake` (undefined: no such key) on top of what profilesIn wrote. */
function wakeIs(box: Sandbox, wake: unknown): void {
  const file = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  const { wake: _, ...cfg } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify(wake === undefined ? cfg : { ...cfg, wake }))
}
const wakeOn = async (): Promise<Record<string, unknown>> => ({ enabled: true, port: await unusedPort() })
type Hooks = Record<string, unknown[] | undefined>
const hooksIn = (home: string, p: string): Hooks => JSON.parse(read(home, p, 'settings.json')).hooks as Hooks
/** An entry that runs wake's hook, any copy's. */
const isWake = (e: unknown): boolean => JSON.stringify(e).includes('wake-hook.ts')
const wakeOf = (hooks: Hooks, event: string): unknown[] => (hooks[event] ?? []).filter(isWake)
const othersOf = (hooks: Hooks, event: string): unknown[] => (hooks[event] ?? []).filter(e => !isWake(e))

test('install with wake on writes the two hooks into every shown profile, once, with a backup', async () => {
  const box = await sandbox()
  const before = `${JSON.stringify({ hooks: { SessionStart: [THEIRS], PreToolUse: [THEIR_BASH] } }, null, 2)}\n`
  const home = profilesIn(box, { '.claude': before, '.claude-work': before, '.claude-gamedev': before }, ['gamedev'])
  wakeIs(box, await wakeOn())
  const first = await install(box)
  expect([first.code, first.stderr]).toEqual([0, ''])
  for (const p of ['.claude', '.claude-work']) {
    expect(read(home, p, 'settings.json.bak-agent-board')).toBe(before)
    expect(first.stdout).toContain(wakeAdded(home, p))
  }
  const again = await install(box)
  expect([again.code, again.stderr]).toEqual([0, ''])
  for (const p of ['.claude', '.claude-work']) {
    const hooks = hooksIn(home, p)
    expect(wakeOf(hooks, 'PreToolUse')).toEqual([SEND])
    expect(othersOf(hooks, 'PreToolUse')[0]).toEqual(THEIR_BASH)
    expect(hooks.PostToolUse).toEqual([LIST])
    expect(hooks.SessionStart).toEqual([THEIRS, ours()])
    expect(again.stdout).toContain(wakeAdded(home, p))
  }
  // The hidden profile: nothing.
  expect(read(home, '.claude-gamedev', 'settings.json')).toBe(before)
  expect(readdirSync(join(home, '.claude-gamedev'))).toEqual(['settings.json'])
}, 30_000)

/** Install with config.json's `wake` as given: no wake hook goes in, and ours from before stay as they were. */
async function noWakeHook(wake: unknown): Promise<void> {
  const box = await sandbox()
  const earlier = `${JSON.stringify({ hooks: { PreToolUse: [SEND], PostToolUse: [LIST] } })}\n`
  const home = profilesIn(box, { '.claude': '{}', '.claude-work': earlier })
  wakeIs(box, wake)
  const { code, stdout, stderr } = await install(box)
  expect([code, stderr]).toEqual([0, ''])
  expect(stdout).not.toContain('wake hooks')
  expect(read(home, '.claude', 'settings.json')).not.toContain('wake-hook.ts')
  expect(hooksIn(home, '.claude').PostToolUse).toBeUndefined()
  const kept = hooksIn(home, '.claude-work')
  expect([wakeOf(kept, 'PreToolUse'), kept.PostToolUse]).toEqual([[SEND], [LIST]])
}

test('with wake off, no wake hook is written', async () => {
  await noWakeHook(false)
  await noWakeHook({ enabled: false, port: 9 })
  // A switch that cannot be read is off (it fails closed).
  await noWakeHook('off')
}, 90_000)

test.skipIf(WAKE_SHIPPED)(
  'with no wake section (wake not shipped yet), no wake hook is written',
  async () => {
    await noWakeHook(undefined)
  },
  30_000,
)

// On by default: a section without the switch (only a port of the test's, so the check that ends
// the install asks none of this computer's) is wake on, and the install writes its hooks.
test.skipIf(!WAKE_SHIPPED)(
  'with no switch in the wake section, wake is on: the install writes its hooks into every shown profile',
  async () => {
    const box = await sandbox()
    const home = profilesIn(box, { '.claude': '{}', '.claude-work': '{}' })
    wakeIs(box, { port: await unusedPort() })
    const { code, stdout, stderr } = await install(box)
    expect([code, stderr]).toEqual([0, ''])
    for (const p of ['.claude', '.claude-work']) {
      expect(stdout).toContain(wakeAdded(home, p))
      const hooks = hooksIn(home, p)
      expect([wakeOf(hooks, 'PreToolUse'), hooks.PostToolUse]).toEqual([[SEND], [LIST]])
    }
  },
  30_000,
)

test('never beside the old plugin’s hooks', async () => {
  const box = await sandbox()
  // As herdr-wake's install-hooks.mjs writes them into ~/.claude/settings.json.
  const hookMjs = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'herdr-wake', 'hook.mjs')
  const old = (matcher: string | null, mode: string, timeout: number) => ({
    ...(matcher && { matcher }),
    hooks: [{ type: 'command', command: `node "${hookMjs}" ${mode}`, timeout }],
  })
  const plugin = {
    hooks: {
      PreToolUse: [old('SendMessage', 'pre-send', 180)],
      PostToolUse: [old('ListAgents', 'post-list', 10)],
      SessionStart: [old(null, 'session-start', 10)],
    },
  }
  const home = profilesIn(box, { '.claude': JSON.stringify(plugin), '.claude-work': '{}' })
  wakeIs(box, await wakeOn())
  const { code, stdout, stderr } = await install(box)
  expect([code, stderr]).toEqual([0, ''])
  const hooks = hooksIn(home, '.claude')
  expect(hooks.PreToolUse?.[0]).toEqual(plugin.hooks.PreToolUse[0])
  expect(hooks.PostToolUse).toEqual(plugin.hooks.PostToolUse)
  expect(hooks.SessionStart).toEqual([...plugin.hooks.SessionStart, ours()])
  expect(read(home, '.claude', 'settings.json')).not.toContain('wake-hook.ts')
  expect(stdout).toContain(WAKE_HELD)
  expect(stdout).not.toContain(wakeAdded(home, '.claude'))
  // Another profile, without them: ours.
  expect(wakeOf(hooksIn(home, '.claude-work'), 'PreToolUse')).toEqual([SEND])
  expect(stdout).toContain(wakeAdded(home, '.claude-work'))
}, 30_000)

test('the every-prompt hook and SessionStart entries are as on main', async () => {
  // What main's install writes for these events and the status line (run against main's files: the same).
  const main = () => ({
    SessionStart: [THEIRS, ours()],
    UserPromptSubmit: [ours()],
    statusLine: { type: 'command', command: `${quote(process.execPath)} ${quote(entry('statusline.ts'))}` },
  })
  const installed: Record<string, Record<string, unknown>>[] = []
  for (const wake of [await wakeOn(), false]) {
    const box = await sandbox()
    const home = profilesIn(box, {
      '.claude': JSON.stringify({ hooks: { SessionStart: [THEIRS], UserPromptSubmit: [ours()] } }),
      '.claude-work': JSON.stringify({ hooks: { SessionStart: [THEIRS] } }),
    })
    wakeIs(box, wake)
    const { code, stderr } = await install(box)
    expect([code, stderr]).toEqual([0, ''])
    const each: Record<string, Record<string, unknown>> = {}
    for (const p of ['.claude', '.claude-work']) {
      const settings = JSON.parse(read(home, p, 'settings.json'))
      expect({
        SessionStart: settings.hooks.SessionStart,
        UserPromptSubmit: settings.hooks.UserPromptSubmit,
        statusLine: settings.statusLine,
      }).toEqual(main())
      // Everything but wake's entries, to compare wake on with wake off.
      const hooks: Hooks = {}
      for (const [event, list] of Object.entries(settings.hooks as Hooks)) {
        const left = (list ?? []).filter(e => !isWake(e))
        if (left.length) hooks[event] = left
      }
      each[p] = { ...settings, hooks }
    }
    installed.push(each)
  }
  // With wake on, settings.json is wake off's plus wake's two entries.
  expect(installed[0]).toEqual(installed[1] as Record<string, Record<string, unknown>>)
}, 60_000)
