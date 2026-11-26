import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerBoardMcp, registeredLine } from '../../src/adapters/mcp-register.ts'
import { claudeMcpEntry, stdioMcpEntry } from '../../src/core/mcp-register.ts'

// Every file under a temp home of its own: no real profile, Codex, agy or pi folder is read.
const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function homeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'board-mcp-reg-'))
  made.push(d)
  const home = join(d, 'дом anna 100%')
  mkdirSync(home)
  return home
}
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON read field by field
const json = (f: string): Record<string, any> => JSON.parse(readFileSync(f, 'utf8'))
const BUN = '/opt/bun/bin/bun'
const CLI = '/w/agent board/src/entrypoints/cli.ts'
const URL = 'http://127.0.0.1:12422/mcp'

function opts(home: string, extra: Partial<Parameters<typeof registerBoardMcp>[0]> = {}) {
  return {
    on: true,
    port: undefined,
    bun: BUN,
    cli: CLI,
    profiles: [{ id: 'default', dir: join(home, '.claude') }],
    home,
    env: {},
    platform: 'linux',
    ...extra,
  }
}

describe('Claude profiles', () => {
  test("the default profile's ~/.claude.json and another profile's own, every other key and server kept", () => {
    const home = homeDir()
    const work = join(home, 'profiles', 'work ben')
    mkdirSync(work, { recursive: true })
    const state = {
      userID: 'u',
      projects: { '/w': { hasTrustDialogAccepted: true } },
      mcpServers: { telegram: { type: 'http', url: 'https://t/mcp', headers: { Authorization: 'x' } } },
    }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(state))
    const out = registerBoardMcp(
      opts(home, {
        port: 13001,
        profiles: [
          { id: 'default', dir: join(home, '.claude') },
          { id: 'work', dir: work },
        ],
      }),
    )
    expect(out.map(r => [r.harness, r.file, r.action])).toEqual([
      ['claude', join(home, '.claude.json'), 'written'],
      ['claude', join(work, '.claude.json'), 'written'],
    ])
    const entry = claudeMcpEntry('http://127.0.0.1:13001/mcp')
    expect(json(join(home, '.claude.json'))).toEqual({
      ...state,
      mcpServers: { ...state.mcpServers, 'agent-board': entry },
    })
    expect(json(join(work, '.claude.json'))).toEqual({ mcpServers: { 'agent-board': entry } })
    // The file as it was, beside it, once.
    expect(json(join(home, '.claude.json.bak-agent-board'))).toEqual(state)
    expect(existsSync(join(work, '.claude.json.bak-agent-board'))).toBe(false)
  })

  test('a second run changes nothing and writes nothing (no duplicate, no new backup)', () => {
    const home = homeDir()
    writeFileSync(join(home, '.claude.json'), '{"a":1}')
    registerBoardMcp(opts(home))
    const file = join(home, '.claude.json')
    const text = readFileSync(file, 'utf8')
    const at = statSync(file).mtimeMs
    writeFileSync(`${file}.bak-agent-board`, 'kept')
    expect(registerBoardMcp(opts(home)).map(r => r.action)).toEqual(['same'])
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(statSync(file).mtimeMs).toBe(at)
    expect(readFileSync(`${file}.bak-agent-board`, 'utf8')).toBe('kept')
    expect(Object.keys(json(file).mcpServers)).toEqual(['agent-board'])
  })

  test("another profile whose folder is not there is skipped; the file's mode is kept", () => {
    const home = homeDir()
    const file = join(home, '.claude.json')
    writeFileSync(file, '{}', { mode: 0o600 })
    const out = registerBoardMcp(
      opts(home, {
        profiles: [
          { id: 'default', dir: join(home, '.claude') },
          { id: 'gone', dir: join(home, 'nope') },
        ],
      }),
    )
    expect(out).toHaveLength(1)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('a .claude.json that does not parse is left as it was and said', () => {
    const home = homeDir()
    const file = join(home, '.claude.json')
    writeFileSync(file, '{broken')
    const [r] = registerBoardMcp(opts(home))
    expect(r?.action).toBe('failed')
    expect(r?.error).toContain('not valid JSON')
    expect(readFileSync(file, 'utf8')).toBe('{broken')
    expect(existsSync(`${file}.bak-agent-board`)).toBe(false)
    expect(registeredLine(r as NonNullable<typeof r>)).toContain('not changed')
  })
})

describe("Codex, agy and pi only where they are the board's", () => {
  test('nothing is read or written for a harness the board has not set up', () => {
    const home = homeDir()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n')
    writeFileSync(
      join(home, '.codex', 'hooks.json'),
      '{"hooks":{"SessionStart":[{"hooks":[{"command":"herdr-hook"}]}]}}',
    )
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'config', 'hooks.json'), '{"herdr":{}}')
    const out = registerBoardMcp(opts(home, { profiles: [] }))
    expect(out).toEqual([])
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "o3"\n')
    expect(existsSync(join(home, '.gemini', 'config', 'mcp_config.json'))).toBe(false)
    expect(existsSync(join(home, '.pi'))).toBe(false)
  })

  test('Codex with the board hooks: the table in config.toml, through the link of a dedicated home', () => {
    const home = homeDir()
    const codex = join(home, '.codex')
    const dedicated = join(home, '.config', 'herdr', 'codex')
    mkdirSync(codex, { recursive: true })
    mkdirSync(dedicated, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), 'model = "o3"\n')
    symlinkSync(join(codex, 'config.toml'), join(dedicated, 'config.toml'))
    writeFileSync(
      join(dedicated, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ command: 'bun "/w/agent-board/src/entrypoints/codex-hook.ts" --herdr-agent-board-hook' }] },
          ],
        },
      }),
    )
    const out = registerBoardMcp(opts(home, { profiles: [], codexHome: dedicated }))
    expect(out.map(r => [r.harness, r.action])).toEqual([['codex', 'written']])
    const text = readFileSync(join(codex, 'config.toml'), 'utf8')
    expect(text).toContain('model = "o3"')
    expect(text).toContain('[mcp_servers.agent-board]')
    expect(text).toContain(`url = "${URL}"`)
    // Still a link: the dedicated home and ~/.codex share one config.toml.
    expect(readFileSync(join(dedicated, 'config.toml'), 'utf8')).toBe(text)
    expect(readFileSync(join(codex, 'config.toml.bak-agent-board'), 'utf8')).toBe('model = "o3"\n')
    expect(registerBoardMcp(opts(home, { profiles: [], codexHome: dedicated })).map(r => r.action)).toEqual(['same'])
  })

  test("agy with the board's hook group and pi with its folder: the stdio thin client", () => {
    const home = homeDir()
    const agy = join(home, 'Agy дом 100%')
    const pi = join(home, 'pi agent')
    mkdirSync(agy, { recursive: true })
    mkdirSync(pi, { recursive: true })
    writeFileSync(join(agy, 'hooks.json'), JSON.stringify({ herdr: {}, 'agent-board': { SessionStart: [] } }))
    writeFileSync(
      join(agy, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          external: { url: 'https://e/mcp' },
          'agent-board': { command: 'bun', args: ['/old/cli.ts', 'mcp', '--agents'] },
        },
      }),
    )
    const env = { ANTIGRAVITY_CONFIG_DIR: agy, PI_CODING_AGENT_DIR: pi }
    const out = registerBoardMcp(opts(home, { profiles: [], env }))
    expect(out.map(r => [r.harness, r.action])).toEqual([
      ['agy', 'written'],
      ['pi', 'written'],
    ])
    expect(json(join(agy, 'mcp_config.json')).mcpServers).toEqual({
      external: { url: 'https://e/mcp' },
      'agent-board': stdioMcpEntry(BUN, CLI),
    })
    expect(json(join(pi, 'mcp.json'))).toEqual({ mcpServers: { 'agent-board': stdioMcpEntry(BUN, CLI) } })
  })
})

describe('taking it out', () => {
  test('every harness file that has it, whatever its hooks say; the rest stays', () => {
    const home = homeDir()
    const agy = join(home, '.gemini', 'config')
    mkdirSync(agy, { recursive: true })
    mkdirSync(join(home, '.codex'))
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    const reg = opts(home)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ a: 1, mcpServers: { other: { command: 'x' } } }))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n')
    writeFileSync(join(home, '.codex', 'hooks.json'), '{"x":"/w/agent-board/src/entrypoints/codex-hook.ts"}')
    writeFileSync(join(agy, 'hooks.json'), '{"agent-board":{}}')
    registerBoardMcp(reg)
    // Hooks gone since: the entries still come out.
    rmSync(join(home, '.codex', 'hooks.json'))
    rmSync(join(agy, 'hooks.json'))
    const out = registerBoardMcp({ ...reg, on: false })
    expect(out.map(r => [r.harness, r.action])).toEqual([
      ['claude', 'removed'],
      ['codex', 'removed'],
      ['agy', 'removed'],
      ['pi', 'removed'],
    ])
    expect(json(join(home, '.claude.json'))).toEqual({ a: 1, mcpServers: { other: { command: 'x' } } })
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe('model = "o3"\n')
    expect(json(join(agy, 'mcp_config.json'))).toEqual({ mcpServers: {} })
    expect(registerBoardMcp({ ...reg, on: false }).map(r => r.action)).toEqual(['same', 'same', 'same', 'same'])
  })
  test('no file is made to take nothing out of', () => {
    const home = homeDir()
    expect(registerBoardMcp(opts(home, { on: false }))).toEqual([])
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })
})
