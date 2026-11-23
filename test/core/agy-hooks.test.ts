import { describe, expect, test } from 'bun:test'
import { AGY_HOOK_EVENTS, AGY_HOOK_KEY, AGY_MCP_KEY, planAgyHooks, planAgyMcp } from '../../src/core/agy-hooks.ts'

const SCRIPT = '/home/agent-board/agent-board/src/entrypoints/agy-hook.ts'

describe('Antigravity CLI hooks.json planning (core/agy-hooks.ts)', () => {
  test('adds SessionStart and PreInvocation under agent-board while preserving herdr and other hooks', () => {
    const existing = {
      herdr: {
        PreInvocation: [
          { type: 'command', command: "bash '/home/u/.gemini/config/hooks/herdr-agent-state.sh' session", timeout: 10 },
        ],
      },
      'my-linter': {
        PostToolUse: [{ matcher: 'edit_file', hooks: [{ type: 'command', command: './lint.sh' }] }],
      },
    }
    const next = planAgyHooks(existing, SCRIPT)
    expect(next.herdr).toEqual(existing.herdr)
    expect(next['my-linter']).toEqual(existing['my-linter'])
    const group = next[AGY_HOOK_KEY] as Record<string, { type: string; command: string; timeout: number }[]>
    for (const event of AGY_HOOK_EVENTS) {
      expect(group[event]).toHaveLength(1)
      expect(group[event]?.[0]).toEqual({
        type: 'command',
        command: `bun "${SCRIPT}" --herdr-agent-board-hook`,
        timeout: 10,
      })
    }
    // Idempotent on second run.
    expect(planAgyHooks(next, SCRIPT)).toEqual(next)
  })

  test('replaces moved checkout hook while preserving unrelated commands in the same group', () => {
    const before = {
      'agent-board': {
        SessionStart: [
          { type: 'command', command: 'echo custom-hook' },
          {
            type: 'command',
            command: 'bun "/old/location/src/entrypoints/agy-hook.ts" --herdr-agent-board-hook',
            timeout: 10,
          },
        ],
      },
    }
    const after = planAgyHooks(before, SCRIPT)
    const group = after['agent-board'] as Record<string, { command: string }[]>
    expect(group.SessionStart?.map(h => h.command)).toEqual([
      'echo custom-hook',
      `bun "${SCRIPT}" --herdr-agent-board-hook`,
    ])
    expect(group.PreInvocation?.map(h => h.command)).toEqual([`bun "${SCRIPT}" --herdr-agent-board-hook`])
  })

  test('refuses non-object root, non-object group, and non-array event entries', () => {
    expect(() => planAgyHooks([], SCRIPT)).toThrow('not a JSON object')
    expect(() => planAgyHooks({ 'agent-board': [] }, SCRIPT)).toThrow('not an object')
    expect(() => planAgyHooks({ 'agent-board': { SessionStart: {} } }, SCRIPT)).toThrow('not a list')
  })
})

describe('Antigravity CLI mcp_config.json planning (core/agy-hooks.ts)', () => {
  const BUN = 'C:\\Users\\Иван 100%\\.bun\\bin\\bun.exe'
  const CLI = 'C:\\Work\\herdr-agent-board\\src\\entrypoints\\cli.ts'

  test('adds agent-board MCP server while preserving existing servers and top-level keys', () => {
    const existing = {
      customFlag: true,
      mcpServers: {
        other: { command: 'node', args: ['server.js'] },
      },
    }
    const next = planAgyMcp(existing, BUN, CLI)
    expect(next.customFlag).toBe(true)
    const servers = next.mcpServers as Record<string, unknown>
    expect(servers.other).toEqual({ command: 'node', args: ['server.js'] })
    expect(servers[AGY_MCP_KEY]).toEqual({ command: BUN, args: [CLI, 'mcp', '--agents'] })
    expect(planAgyMcp(next, BUN, CLI)).toEqual(next)
    // Undefined config starts fresh cleanly.
    expect(planAgyMcp(undefined, BUN, CLI)).toEqual({
      mcpServers: { [AGY_MCP_KEY]: { command: BUN, args: [CLI, 'mcp', '--agents'] } },
    })
  })

  test('refuses non-object root and non-object mcpServers', () => {
    expect(() => planAgyMcp([], BUN, CLI)).toThrow('not a JSON object')
    expect(() => planAgyMcp({ mcpServers: [] }, BUN, CLI)).toThrow('not an object')
  })
})
