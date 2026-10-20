import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  writeFileSync(config, '{"language":"en","wakeUrl":""}')
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
