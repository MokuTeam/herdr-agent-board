import { describe, expect, test } from 'bun:test'
import {
  BOARD_MCP,
  boardMcpOff,
  boardMcpUrl,
  claudeMcpEntry,
  codexMcpBlock,
  planCodexToml,
  planMcpServers,
  stdioMcpEntry,
} from '../../src/core/mcp-register.ts'

const URL = 'http://127.0.0.1:12422/mcp'

describe('boardMcpUrl and the entries', () => {
  test("the board's own port, 12422 when config.json sets none", () => {
    expect(boardMcpUrl(undefined)).toBe(URL)
    expect(boardMcpUrl(13001)).toBe('http://127.0.0.1:13001/mcp')
    expect(boardMcpUrl('13002')).toBe('http://127.0.0.1:13002/mcp')
    expect(boardMcpUrl('nope')).toBe(URL)
  })
  test("Claude's entry sends the pane from the session's environment, empty outside herdr", () => {
    expect(claudeMcpEntry(URL)).toEqual({
      type: 'http',
      url: URL,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Claude Code expands
      headers: { 'X-Board-Pane': '${HERDR_PANE_ID:-}' },
    })
  })
  test('the stdio entry runs board mcp --http with the given Bun, Windows paths and spaces as they are', () => {
    expect(stdioMcpEntry('C:\\Users\\anna b\\bun.exe', 'C:\\Work\\board 100%\\src\\entrypoints\\cli.ts')).toEqual({
      command: 'C:\\Users\\anna b\\bun.exe',
      args: ['C:\\Work\\board 100%\\src\\entrypoints\\cli.ts', 'mcp', '--http'],
    })
  })
  test('off only for an explicit false', () => {
    expect(boardMcpOff({ boardMcp: false })).toBe(true)
    for (const raw of [null, undefined, {}, { boardMcp: true }, { boardMcp: 'false' }, []])
      expect(boardMcpOff(raw)).toBe(false)
  })
})

describe('planMcpServers', () => {
  const entry = claudeMcpEntry(URL)
  test('adds the entry, every other server and key kept, the input untouched', () => {
    const before = {
      userID: 'x',
      projects: { '/w': { a: 1 } },
      mcpServers: { telegram: { type: 'http', url: 'https://t/mcp' } },
    }
    const copy = structuredClone(before)
    const next = planMcpServers(before, entry)
    expect(next).toEqual({ ...before, mcpServers: { telegram: before.mcpServers.telegram, [BOARD_MCP]: entry } })
    expect(before).toEqual(copy)
  })
  test('nothing to change when the entry is there as it should be (idempotent)', () => {
    const once = planMcpServers(undefined, entry)
    expect(once).toEqual({ mcpServers: { [BOARD_MCP]: entry } })
    expect(planMcpServers(once, entry)).toBeNull()
  })
  test('replaces an older entry of that name (a moved checkout, another port)', () => {
    const old = { mcpServers: { [BOARD_MCP]: { command: 'bun', args: ['/old/cli.ts', 'mcp', '--agents'] } } }
    expect(planMcpServers(old, stdioMcpEntry('bun', '/new/cli.ts'))?.mcpServers).toEqual({
      [BOARD_MCP]: { command: 'bun', args: ['/new/cli.ts', 'mcp', '--http'] },
    })
  })
  test('removal takes only that entry out; none there is nothing to change', () => {
    const cfg = { theme: 'dark', mcpServers: { other: { command: 'x' }, [BOARD_MCP]: entry } }
    expect(planMcpServers(cfg, null)).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' } } })
    expect(planMcpServers({ theme: 'dark', mcpServers: { other: {} } }, null)).toBeNull()
    expect(planMcpServers(undefined, null)).toBeNull()
  })
  test('a config that is not an object, or mcpServers that is not one, is refused', () => {
    expect(() => planMcpServers([], entry, 'f.json')).toThrow('f.json is not a JSON object')
    expect(() => planMcpServers({ mcpServers: [] }, entry, 'f.json')).toThrow('mcpServers is not an object')
    expect(() => planMcpServers({ mcpServers: 'x' }, null)).toThrow('mcpServers is not an object')
  })
})

describe('planCodexToml', () => {
  const block = codexMcpBlock(URL).join('\n')
  test('the table: url and the pane header from HERDR_PANE_ID', () => {
    expect(block).toBe(
      ['[mcp_servers.agent-board]', `url = "${URL}"`, 'env_http_headers = { "X-Board-Pane" = "HERDR_PANE_ID" }'].join(
        '\n',
      ),
    )
  })
  test('no file, an empty one: just the table', () => {
    expect(planCodexToml(null, URL)).toBe(`${block}\n`)
    expect(planCodexToml('', URL)).toBe(`${block}\n`)
  })
  test('appended after the rest with one blank line, then nothing to change', () => {
    const text = 'model = "gpt-5"\n\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n\n\n'
    const next = planCodexToml(text, URL)
    expect(next).toBe(`model = "gpt-5"\n\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n\n${block}\n`)
    expect(planCodexToml(next, URL)).toBeNull()
  })
  test('an older table of ours is replaced where it stood, sub-tables too; the comment of the next table stays', () => {
    const text = [
      'a = 1',
      '[mcp_servers."agent-board"]',
      'url = "http://127.0.0.1:1/mcp"',
      'command = "bun"',
      '[mcp_servers.agent-board.env]',
      'X = "1"',
      '',
      '# the projects',
      '[projects."/w"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')
    expect(planCodexToml(text, URL)).toBe(
      ['a = 1', block, '', '# the projects', '[projects."/w"]', 'trust_level = "trusted"', ''].join('\n'),
    )
  })
  test('CRLF files keep CRLF', () => {
    const text = 'a = 1\r\n'
    expect(planCodexToml(text, URL)).toBe(`a = 1\r\n\r\n${codexMcpBlock(URL).join('\r\n')}\r\n`)
  })
  test('removal gives the file back as it was before the install', () => {
    const text = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n'
    const installed = planCodexToml(text, URL) as string
    expect(planCodexToml(installed, null)).toBe(text)
    expect(planCodexToml(text, null)).toBeNull()
    expect(planCodexToml(null, null)).toBeNull()
  })
  test('removal from the middle or the top of the file leaves no extra blank lines', () => {
    const middle = 'a = 1\n\n[mcp_servers.agent-board]\nurl = "x"\n\n[projects.x]\nt = 1\n'
    expect(planCodexToml(middle, null)).toBe('a = 1\n\n[projects.x]\nt = 1\n')
    const top = '[mcp_servers.agent-board]\nurl = "x"\n\n[projects.x]\nt = 1\n'
    expect(planCodexToml(top, null)).toBe('[projects.x]\nt = 1\n')
    // A comment that belongs to the next table stays, after one blank line.
    const commented = 'a = 1\n\n[mcp_servers.agent-board]\nurl = "x"\n\n# projects\n[projects.x]\n'
    expect(planCodexToml(commented, null)).toBe('a = 1\n\n# projects\n[projects.x]\n')
  })
  test('a table header inside a multi-line string is not a table', () => {
    const text = 'notes = """\n[mcp_servers.agent-board]\n"""\n'
    expect(planCodexToml(text, URL)).toBe(`${text}\n${block}\n`)
  })
  test('the board server defined another way is refused, the file left as it was', () => {
    for (const text of [
      '[mcp_servers]\nagent-board = { url = "x" }\n',
      '[mcp_servers]\n"agent-board".url = "x"\n',
      'mcp_servers.agent-board.url = "x"\n',
      'mcp_servers = { agent-board = { url = "x" } }\n',
    ])
      expect(() => planCodexToml(text, URL)).toThrow('another way')
    // A server of another name in the same shapes is not ours.
    expect(planCodexToml('[mcp_servers]\nother = { url = "x" }\n', URL)).toContain('[mcp_servers.agent-board]')
  })
})
