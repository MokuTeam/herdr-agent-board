import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

async function install(box: Sandbox, args = ['--agy'], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/install.ts'), ...args], {
    cwd: root,
    env: { ...box.env, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('--agy installs hooks, skills, shims and herdr integration, preserving herdr hooks and original backup', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'Agy дом 100%')
  mkdirSync(dir)
  const file = join(dir, 'hooks.json')
  const before = JSON.stringify({
    herdr: { PreInvocation: [{ type: 'command', command: 'herdr-state' }] },
  })
  writeFileSync(file, before)
  for (let n = 0; n < 2; n++) {
    const result = await install(box, ['--agy'], { ANTIGRAVITY_CONFIG_DIR: dir })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as Record<string, Record<string, { command: string }[]>>
    expect(parsed.herdr?.PreInvocation?.[0]?.command).toBe('herdr-state')
    expect(parsed['agent-board']?.SessionStart).toHaveLength(1)
    expect(parsed['agent-board']?.PreInvocation).toHaveLength(1)
    expect(text.match(/agy-hook\.ts/g)).toHaveLength(2)
    expect(readFileSync(`${file}.bak-agent-board`, 'utf8')).toBe(before)
  }
  expect(existsSync(join(dir, 'skills', 'herdr-agents', 'SKILL.md'))).toBe(true)
  expect(existsSync(join(dir, 'skills', 'agent-board-team', 'SKILL.md'))).toBe(true)
  expect(existsSync(join(box.env.USERPROFILE as string, '.claude'))).toBe(false)
  expect(existsSync(join(box.env.USERPROFILE as string, '.codex'))).toBe(false)
  expect(existsSync(join(box.env.USERPROFILE as string, '.local/bin/board'))).toBe(true)
  expect(box.calls()).toEqual([
    ['integration', 'install', 'antigravity-cli'],
    ['integration', 'install', 'antigravity-cli'],
  ])
})

test('--agy warns when bun is not on PATH and rejects incompatible flags before writing anything', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'agy-cfg')
  const warn = await install(box, ['--agy'], { ANTIGRAVITY_CONFIG_DIR: dir, PATH: box.dir })
  expect(warn.code).toBe(0)
  expect(warn.stdout).toContain('warning: bun is not on PATH')

  const clean = await sandbox()
  const cleanDir = join(clean.dir, 'clean-agy')
  for (const flags of [
    ['--agy', '--toast'],
    ['--agy', '--no-toast'],
    ['--agy', '--codex'],
  ]) {
    const res = await install(clean, flags, { ANTIGRAVITY_CONFIG_DIR: cleanDir })
    expect(res.code).toBe(1)
    expect(existsSync(cleanDir)).toBe(false)
    expect(existsSync(join(clean.env.USERPROFILE as string, '.local/bin/board'))).toBe(false)
  }
})

test('invalid hooks.json stops --agy before writing anything, and normal Claude install leaves it alone', async () => {
  const box = await sandbox()
  const dir = join(box.env.USERPROFILE as string, '.gemini', 'config')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'hooks.json')
  writeFileSync(file, '{broken')
  const bad = await install(box, ['--agy'])
  expect(bad.code).toBe(1)
  expect(readFileSync(file, 'utf8')).toBe('{broken')
  expect(existsSync(`${file}.bak-agent-board`)).toBe(false)
  expect(existsSync(join(box.env.USERPROFILE as string, '.local/bin/board'))).toBe(false)

  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"language":"en","wakeUrl":"","wake":false}')
  const claude = await install(box, [])
  expect(claude.code).toBe(0)
  expect(readFileSync(file, 'utf8')).toBe('{broken')
  expect(existsSync(join(box.env.USERPROFILE as string, '.claude/settings.json'))).toBe(true)
})
