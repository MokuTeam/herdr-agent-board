import { expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

async function install(box: Sandbox, args = ['--codex'], extra = {}) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/install.ts'), ...args], {
    cwd: root,
    env: { ...box.env, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('Codex install warns when the hook cannot find Bun on PATH', async () => {
  const box = await sandbox()
  const result = await install(box, ['--codex'], { PATH: box.dir })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('warning: bun is not on PATH')
  expect(result.stdout).toContain('add Bun to PATH before starting Codex')
})

test('--codex installs only Codex hooks and commands, preserving herdr and the original backup on repeated installs', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'Codex дом 100%')
  mkdirSync(dir)
  const file = join(dir, 'hooks.json')
  const before = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-state' }] }] } })
  writeFileSync(file, before)
  let afterHerdr = ''
  for (let n = 0; n < 2; n++) {
    const result = await install(box, ['--codex'], { CODEX_HOME: dir })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('review and trust these hooks in /hooks')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('herdr-state')
    expect(text.match(/codex-hook\.ts/g)).toHaveLength(2)
    expect(readFileSync(`${file}.bak-agent-board`, 'utf8')).toBe(before)
    if (n === 0) {
      // herdr's real installer appends its own hook after ours.
      const settings = JSON.parse(text)
      settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'herdr-installed-later' }] })
      afterHerdr = JSON.stringify(settings)
      writeFileSync(file, afterHerdr)
    } else expect(text).toBe(afterHerdr)
  }
  expect(existsSync(join(box.env.USERPROFILE as string, '.claude'))).toBe(false)
  expect(existsSync(join(box.env.USERPROFILE as string, '.local/bin/board.cmd'))).toBe(true)
  expect(box.calls()).toEqual([
    ['integration', 'install', 'codex'],
    ['integration', 'install', 'codex'],
  ])
})

test('an empty Codex hooks file is a new configuration, and the first backup is never overwritten', async () => {
  const box = await sandbox()
  const dir = join(box.env.USERPROFILE as string, '.codex')
  mkdirSync(dir)
  const file = join(dir, 'hooks.json')
  writeFileSync(file, '')
  expect((await install(box)).code).toBe(0)
  expect(readFileSync(`${file}.bak-agent-board`, 'utf8')).toBe('')
  // A changed source path forces a rewrite, but the original backup must still survive.
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replaceAll('entrypoints/codex-hook.ts', 'previous/entrypoints/codex-hook.ts'),
  )
  expect((await install(box)).code).toBe(0)
  expect(readFileSync(`${file}.bak-agent-board`, 'utf8')).toBe('')
  expect(readFileSync(file, 'utf8')).not.toContain('previous/entrypoints')
})

test('an invalid Codex hooks file stops before writing hooks, backup or command shims', async () => {
  const box = await sandbox()
  const dir = join(box.env.USERPROFILE as string, '.codex')
  mkdirSync(dir)
  const file = join(dir, 'hooks.json')
  for (const text of ['{broken', '{"hooks":[]}']) {
    writeFileSync(file, text)
    const result = await install(box)
    expect(result.code).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(existsSync(`${file}.bak-agent-board`)).toBe(false)
    expect(existsSync(join(box.env.USERPROFILE as string, '.local/bin/board'))).toBe(false)
  }
})

test('the normal Claude install leaves an invalid Codex configuration alone', async () => {
  const box = await sandbox()
  const dir = join(box.env.USERPROFILE as string, '.codex')
  mkdirSync(dir)
  writeFileSync(join(dir, 'hooks.json'), '{broken')
  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"language":"en","wakeUrl":"","wake":false}')
  const result = await install(box, [])
  expect(result.code).toBe(0)
  expect(readFileSync(join(dir, 'hooks.json'), 'utf8')).toBe('{broken')
  expect(existsSync(join(dir, 'hooks.json.bak-agent-board'))).toBe(false)
  expect(existsSync(join(box.env.USERPROFILE as string, '.claude/settings.json'))).toBe(true)
})

test('Codex install rejects Claude notification flags before writing anything', async () => {
  const box = await sandbox()
  for (const option of ['--toast', '--no-toast']) {
    const result = await install(box, ['--codex', option])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--codex does not take --toast or --no-toast')
    expect(existsSync(join(box.env.USERPROFILE as string, '.codex'))).toBe(false)
    expect(existsSync(join(box.env.USERPROFILE as string, '.local/bin/board'))).toBe(false)
  }
})

test('--codex --codex-home puts hooks, links and skills in the dedicated folder and leaves ~/.codex alone', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const global = join(home, '.codex')
  mkdirSync(join(global, 'skills/mine'), { recursive: true })
  writeFileSync(join(global, 'auth.json'), '{"t":1}')
  writeFileSync(join(global, 'config.toml'), 'model = "m"\n')
  const globalHooks = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"herdr-state"}]}]}}'
  writeFileSync(join(global, 'hooks.json'), globalHooks)
  const dir = join(box.dir, 'Codex дом 100%')
  const run = () => install(box, ['--codex', '--codex-home', dir], { CODEX_HOME: global })
  for (let n = 0; n < 2; n++) {
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(readFileSync(join(dir, 'hooks.json'), 'utf8').match(/codex-hook\.ts/g)).toHaveLength(2)
    // Named in Codex's /hooks instead of "Unnamed hook", once each however often it runs.
    expect(readFileSync(join(dir, 'hooks.json'), 'utf8').match(/"statusMessage"/g)).toHaveLength(2)
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('{"t":1}')
    expect(lstatSync(join(dir, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dir, 'skills/mine')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dir, 'skills')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(dir, 'skills/agent-board-threads/SKILL.md'))).toBe(true)
  }
  // The global folder keeps its hooks, and nothing of the board went into it.
  expect(readFileSync(join(global, 'hooks.json'), 'utf8')).toBe(globalHooks)
  expect(existsSync(join(global, 'hooks.json.bak-agent-board'))).toBe(false)
  expect(existsSync(join(global, 'skills/agent-board-threads'))).toBe(false)
  expect(existsSync(join(global, 'rules'))).toBe(false)
  expect(readFileSync(join(dir, 'rules/agent-board.rules'), 'utf8')).toContain('prefix_rule')
  // The board is told where the rollouts of these sessions are.
  const config = JSON.parse(
    readFileSync(join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'), 'utf8'),
  )
  expect(config.codexHome).toBe(dir)
  expect(box.calls()).toEqual([
    ['integration', 'install', 'codex'],
    ['integration', 'install', 'codex'],
  ])
})

test('--codex-home without a folder takes ~/.config/herdr/codex; a plain --codex stays as it was', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const result = await install(box, ['--codex', '--codex-home'])
  expect(result.code).toBe(0)
  expect(existsSync(join(home, '.config/herdr/codex/hooks.json'))).toBe(true)
  expect(existsSync(join(home, '.codex'))).toBe(false)
  const plain = await install(box, ['--codex'])
  expect(plain.stdout).not.toContain('Codex home:')
  // A plain --codex writes its hooks unnamed, as before: a name would change their trusted hash.
  expect(readFileSync(join(home, '.codex/hooks.json'), 'utf8')).not.toContain('statusMessage')
})

test('--codex-master adds the herdr agent rule to the dedicated home; without it, and with a plain --codex, there is none', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const dir = join(box.dir, 'Codex master')
  const plain = await install(box, ['--codex', '--codex-home', dir])
  expect(plain.code).toBe(0)
  expect(plain.stdout).not.toContain('ignored')
  expect(readFileSync(join(dir, 'rules/agent-board.rules'), 'utf8')).not.toContain('"herdr"')
  const master = await install(box, ['--codex', '--codex-home', dir, '--codex-master'])
  expect(master.code).toBe(0)
  expect(master.stdout).not.toContain('ignored')
  expect(readFileSync(join(dir, 'rules/agent-board.rules'), 'utf8')).toContain('["prompt", "read", "list", "get"]')
  // Without a dedicated home there is no rule file to put it in: said, and nothing written.
  const alone = await install(box, ['--codex', '--codex-master'], { CODEX_HOME: join(box.dir, 'plain') })
  expect(alone.stdout).toContain('ignored --codex-master')
  expect(existsSync(join(box.dir, 'plain/rules'))).toBe(false)
  expect(existsSync(join(home, '.config/herdr/codex'))).toBe(false)
})

test("the dedicated home gets the Codex herdr-agents skill; Claude's skill file is the one it was", async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'Codex skill')
  expect((await install(box, ['--codex', '--codex-home', dir])).code).toBe(0)
  const codex = readFileSync(join(dir, 'skills/herdr-agents/SKILL.md'), 'utf8')
  expect(codex).toBe(readFileSync(join(root, 'skills/herdr-agents/SKILL.codex.md'), 'utf8'))
  expect(codex).toContain('agent-board: installed by')
  expect(codex).not.toMatch(/SendMessage|ListAgents|CronCreate|claude --resume/)
  for (const need of ['herdr agent prompt', 'thread new', 'thread done', '--agent', 'board restart [note]'])
    expect(codex).toContain(need)
  expect(readFileSync(join(root, 'skills/herdr-agents/SKILL.md'), 'utf8')).toContain('SendMessage')
  // A second run changes nothing; Claude's install writes the Claude one.
  expect((await install(box, ['--codex', '--codex-home', dir])).stdout).toContain('skill:')
  expect(readFileSync(join(dir, 'skills/herdr-agents/SKILL.md'), 'utf8')).toBe(codex)
})
