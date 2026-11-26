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
  const mcpFile = join(dir, 'mcp_config.json')
  const before = JSON.stringify({
    herdr: { PreInvocation: [{ type: 'command', command: 'herdr-state' }] },
  })
  const mcpBefore = JSON.stringify({ mcpServers: { external: { url: 'https://example.com/mcp' } } })
  writeFileSync(file, before)
  writeFileSync(mcpFile, mcpBefore)
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

    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
      mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>
    }
    expect(mcp.mcpServers.external).toEqual({ url: 'https://example.com/mcp' })
    expect(mcp.mcpServers['agent-board']).toEqual({
      command: process.execPath,
      args: [join(root, 'src', 'entrypoints', 'cli.ts'), 'mcp', '--http'],
    })
    expect(readFileSync(`${mcpFile}.bak-agent-board`, 'utf8')).toBe(mcpBefore)
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

test('--agy handles an empty mcp_config.json and fails closed on invalid mcp_config.json without writing hooks', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'agy-empty-mcp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp_config.json'), '')
  const ok = await install(box, ['--agy'], { ANTIGRAVITY_CONFIG_DIR: dir })
  expect(ok.code).toBe(0)
  const mcp = JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>
  }
  expect(mcp.mcpServers['agent-board']?.args.slice(-2)).toEqual(['mcp', '--http'])

  const brokenBox = await sandbox()
  const brokenDir = join(brokenBox.dir, 'agy-bad-mcp')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'mcp_config.json'), '{broken')
  const bad = await install(brokenBox, ['--agy'], { ANTIGRAVITY_CONFIG_DIR: brokenDir })
  expect(bad.code).toBe(1)
  expect(existsSync(join(brokenDir, 'hooks.json'))).toBe(false)
  expect(readFileSync(join(brokenDir, 'mcp_config.json'), 'utf8')).toBe('{broken')
  expect(existsSync(join(brokenBox.env.USERPROFILE as string, '.local/bin/board'))).toBe(false)
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

test('normal install on a Windows home with agy.cmd or agy.exe installs agy hooks, MCP, statusLine, skills, and herdr integration', async () => {
  for (const binName of ['agy.cmd', 'agy.exe']) {
    const box = await sandbox()
    const home = box.env.USERPROFILE as string
    const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, '{"language":"en","wakeUrl":"","wake":false}')
    const winBin = join(box.dir, 'win-agy-bin')
    mkdirSync(winBin, { recursive: true })
    writeFileSync(join(winBin, binName), binName.endsWith('.cmd') ? '@echo off\r\n' : '')

    const agyDir = join(home, '.gemini', 'config')
    mkdirSync(agyDir, { recursive: true })
    const hooksBefore = JSON.stringify({
      other: { PreInvocation: [{ type: 'command', command: 'echo other' }] },
    })
    const mcpBefore = JSON.stringify({ mcpServers: { external: { url: 'https://example.com/mcp' } } })
    writeFileSync(join(agyDir, 'hooks.json'), hooksBefore)
    writeFileSync(join(agyDir, 'mcp_config.json'), mcpBefore)

    const env = {
      BOARD_TEST_PLATFORM: 'win32',
      PATH: '',
      Path: `${dirname(process.execPath)};"${winBin}"`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    }
    for (let n = 0; n < 2; n++) {
      const res = await install(box, [], env)
      expect(res.code).toBe(0)
      expect(res.stderr).toBe('')
      const hooks = JSON.parse(readFileSync(join(agyDir, 'hooks.json'), 'utf8')) as Record<
        string,
        Record<string, { command: string }[]>
      >
      expect(hooks.other?.PreInvocation?.[0]?.command).toBe('echo other')
      expect(hooks['agent-board']?.SessionStart?.[0]?.command).toBe(
        `bun "${join(root, 'src', 'entrypoints', 'agy-hook.ts').replace(/\\/g, '/')}" --herdr-agent-board-hook`,
      )
      expect(hooks['agent-board']?.PreInvocation?.[0]?.command).toBe(
        `bun "${join(root, 'src', 'entrypoints', 'agy-hook.ts').replace(/\\/g, '/')}" --herdr-agent-board-hook`,
      )
      expect(readFileSync(join(agyDir, 'hooks.json.bak-agent-board'), 'utf8')).toBe(hooksBefore)

      const mcp = JSON.parse(readFileSync(join(agyDir, 'mcp_config.json'), 'utf8')) as {
        mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>
      }
      expect(mcp.mcpServers.external).toEqual({ url: 'https://example.com/mcp' })
      expect(mcp.mcpServers['agent-board']).toEqual({
        command: process.execPath,
        args: [join(root, 'src', 'entrypoints', 'cli.ts'), 'mcp', '--http'],
      })
      expect(readFileSync(join(agyDir, 'mcp_config.json.bak-agent-board'), 'utf8')).toBe(mcpBefore)
      expect(
        res.stdout.includes(`board MCP (agent-board) for Antigravity CLI: ${join(agyDir, 'mcp_config.json')}`),
      ).toBe(n === 0)
    }
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as {
      statusLine?: { type?: string; command?: string; stack_with_default?: boolean }
    }
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `bun "${join(root, 'src', 'entrypoints', 'agy-statusline.ts').replace(/\\/g, '/')}"`,
      stack_with_default: true,
    })
    expect(existsSync(join(agyDir, 'skills', 'herdr-agents', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agyDir, 'skills', 'agent-board-team', 'SKILL.md'))).toBe(true)
    expect(box.calls()).toContainEqual(['integration', 'install', 'antigravity-cli'])
  }
})

test('normal install on a Windows home without agy creates neither agy hooks nor agy MCP', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"language":"en","wakeUrl":"","wake":false}')
  const res = await install(box, [], { BOARD_TEST_PLATFORM: 'win32' })
  expect(res.code).toBe(0)
  expect(res.stdout).not.toContain('Antigravity CLI')
  expect(existsSync(join(home, '.gemini'))).toBe(false)
  expect(box.calls().filter(c => c[2] === 'antigravity-cli')).toEqual([])
})

test('normal install prints "not changed:" when ~/.gemini/config or ANTIGRAVITY_CONFIG_DIR exists without agy binary or board hooks', async () => {
  for (const useCustomDir of [false, true]) {
    const box = await sandbox()
    const home = box.env.USERPROFILE as string
    const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, '{"language":"en","wakeUrl":"","wake":false}')
    const agyDir = useCustomDir ? join(box.dir, 'custom-agy-config') : join(home, '.gemini', 'config')
    mkdirSync(agyDir, { recursive: true })
    const hooksBefore = JSON.stringify({ herdr: {} })
    writeFileSync(join(agyDir, 'hooks.json'), hooksBefore)

    const env: Record<string, string> = {
      BOARD_TEST_PLATFORM: 'win32',
      ...(useCustomDir ? { ANTIGRAVITY_CONFIG_DIR: agyDir } : {}),
    }
    const res = await install(box, [], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(`Antigravity CLI hooks: not changed: ${agyDir} exists, but agy was not found on PATH`)
    expect(res.stdout).toContain('board MCP (agent-board) for Antigravity CLI: not changed:')
    expect(readFileSync(join(agyDir, 'hooks.json'), 'utf8')).toBe(hooksBefore)
    expect(existsSync(join(agyDir, 'mcp_config.json'))).toBe(false)
  }
})

test('install --mcp and broken hooks.json print "not changed:" when agy is installed without board hooks', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"language":"en","wakeUrl":"","wake":false}')
  const winBin = join(box.dir, 'win-agy-bin')
  mkdirSync(winBin, { recursive: true })
  writeFileSync(join(winBin, 'agy.cmd'), '@echo off\r\n')
  const agyDir = join(home, '.gemini', 'config')
  mkdirSync(agyDir, { recursive: true })
  writeFileSync(join(agyDir, 'hooks.json'), JSON.stringify({ herdr: {} }))

  const env = {
    BOARD_TEST_PLATFORM: 'win32',
    PATH: `${dirname(process.execPath)};${winBin}`,
    PATHEXT: '.EXE;.CMD',
  }
  const mcpOnly = await install(box, ['--mcp'], env)
  expect(mcpOnly.code).toBe(0)
  expect(mcpOnly.stdout).toContain('board MCP (agent-board) for Antigravity CLI: not changed:')
  expect(mcpOnly.stdout).toContain('Antigravity CLI board hooks are missing')
  expect(existsSync(join(agyDir, 'mcp_config.json'))).toBe(false)

  // Broken hooks.json during normal install leaves Claude install green and logs why agy MCP was skipped.
  writeFileSync(join(agyDir, 'hooks.json'), '{broken')
  const normal = await install(box, [], env)
  expect(normal.code).toBe(0)
  expect(normal.stdout).toContain('Antigravity CLI hooks: not changed:')
  expect(normal.stdout).toContain('board MCP (agent-board) for Antigravity CLI: not changed:')
  expect(readFileSync(join(agyDir, 'hooks.json'), 'utf8')).toBe('{broken')
  expect(existsSync(join(agyDir, 'mcp_config.json'))).toBe(false)
})
