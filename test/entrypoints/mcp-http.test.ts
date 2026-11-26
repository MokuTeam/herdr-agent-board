// The board's HTTP MCP (#813, entrypoints/mcp-http.ts): which command each tool call runs, what a
// call can never put before the command's `--` (a flag such as --session would name another
// caller), the caller's variables in the child's env with the board's own taken out, and the
// JSON-RPC around it with the caller passed per call.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOLS } from '../../src/entrypoints/mcp.ts'
import {
  callerEnv,
  childRunner,
  createHttpMcp,
  HTTP_TOOLS,
  type Runner,
  toolRun,
} from '../../src/entrypoints/mcp-http.ts'

const bad = (name: string, args: Record<string, unknown>): string => {
  try {
    toolRun(name, args)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error(`${name} ${JSON.stringify(args)} ran`)
}

describe('the tools', () => {
  test('the list: seven, the threads two as the stdio server has them', () => {
    expect(HTTP_TOOLS.map(t => t.name)).toEqual(['card', 'schedule', 'agents', 'threads', 'thread', 'spawn', 'cal'])
    expect(HTTP_TOOLS.filter(t => t.name === 'threads' || t.name === 'thread')).toEqual([...TOOLS])
    for (const t of HTTP_TOOLS) expect(t.inputSchema.additionalProperties).toBe(false)
  })

  test('card: each op as the board command, the text after --', () => {
    expect(toolRun('card', { op: 'doing', text: '--session x' })).toEqual({
      program: 'board',
      argv: ['doing', '--', '--session x'],
    })
    expect(toolRun('card', { op: 'done' }).argv).toEqual(['done'])
    expect(toolRun('card', { op: 'done', text: 'shipped' }).argv).toEqual(['done', '--', 'shipped'])
    expect(toolRun('card', { op: 'cat', lane: 'atlas', text: 'Atlas work' }).argv).toEqual([
      'cat',
      'atlas',
      '--',
      'Atlas work',
    ])
    expect(
      toolRun('card', {
        op: 'ask',
        text: 'Merge it?',
        options: ['yes, merge', 'not yet'],
        recommend: 1,
        default_after: '2h',
      }).argv,
    ).toEqual([
      'ask',
      '--option',
      'yes, merge',
      '--option',
      'not yet',
      '--recommend',
      '1',
      '--default-after',
      '2h',
      '--',
      'Merge it?',
    ])
    expect(
      toolRun('card', { op: 'wait', text: 'CI', probe: 'gh run view 1', every: '10m', timeout: '20s', silence: '3d' })
        .argv,
    ).toEqual(['wait', '--probe', 'gh run view 1', '--every', '10m', '--timeout', '20s', '--silence', '3d', '--', 'CI'])
    expect(toolRun('card', { op: 'wait', text: 'ben' }).argv).toEqual(['wait', '--', 'ben'])
  })

  test('card: refusals, a flag before -- among them', () => {
    expect(bad('card', { op: 'doing' })).toBe('doing needs text')
    expect(bad('card', { op: 'doing', text: '   ' })).toBe('doing needs text')
    expect(bad('card', { op: 'ask', text: 'q', options: ['--session', 'b'] })).toMatch(/not a value for option/)
    expect(bad('card', { op: 'ask', text: 'q', options: ['a\nb', 'c'] })).toMatch(/not a value for option/)
    expect(bad('card', { op: 'ask', text: 'q', recommend: 0 })).toMatch(/recommend/)
    expect(bad('card', { op: 'ask', text: 'q', default_after: '-1h' })).toMatch(/default_after/)
    expect(bad('card', { op: 'wait', text: 'x', probe: '--session other' })).toMatch(/probe/)
    expect(bad('card', { op: 'wait', text: 'x', every: '10m' })).toBe('every goes with probe')
    expect(bad('card', { op: 'cat', lane: '--idle' })).toMatch(/lane/)
    expect(bad('card', { op: 'cat' })).toMatch(/cat needs lane/)
    expect(bad('card', { op: 'clear' })).toMatch(/^op is doing, ask, wait, done, cat/)
  })

  test('schedule: remind, every, list, unschedule', () => {
    expect(toolRun('schedule', { op: 'remind', when: 'in  30m', text: 'check CI' }).argv).toEqual([
      'remind',
      'in',
      '30m',
      '--',
      'check CI',
    ])
    expect(toolRun('schedule', { op: 'remind', when: 'at 15:30', text: 'x', idle: true }).argv).toEqual([
      'remind',
      '--idle',
      'at',
      '15:30',
      '--',
      'x',
    ])
    expect(toolRun('schedule', { op: 'every', cron: '0 9 * * 1-5', text: 'inbox' }).argv).toEqual([
      'every',
      '0 9 * * 1-5',
      '--',
      'inbox',
    ])
    expect(toolRun('schedule', { op: 'list' }).argv).toEqual(['schedule'])
    expect(toolRun('schedule', { op: 'unschedule', id: 'all' }).argv).toEqual(['unschedule', 'all'])
    expect(bad('schedule', { op: 'remind', when: 'in --session x', text: 't' })).toMatch(/when/)
    expect(bad('schedule', { op: 'remind', text: 't' })).toMatch(/remind needs when/)
    expect(bad('schedule', { op: 'every', cron: '0 9 * * *' })).toBe('every needs text')
    expect(bad('schedule', { op: 'unschedule', id: '--all' })).toMatch(/id/)
  })

  test('agents, threads, thread, cal', () => {
    expect(toolRun('agents', { op: 'list' }).argv).toEqual(['agents'])
    expect(toolRun('agents', { op: 'send', to: 'anna [1a2b3c4d]', message: '-- hi' }).argv).toEqual([
      'send',
      '--',
      'anna [1a2b3c4d]',
      '-- hi',
    ])
    expect(bad('agents', { op: 'send', to: '--session', message: 'x' })).toMatch(/to/)
    expect(bad('agents', { op: 'send', to: 'ben' })).toMatch(/send needs message/)
    expect(toolRun('threads', { op: 'show', key: 'atlas-12', last: 3 }).argv).toEqual([
      'thread',
      'show',
      'atlas-12',
      '--last',
      '3',
    ])
    expect(toolRun('thread', { op: 'post', key: 'atlas-12', status: 'done', text: 'shipped' }).argv).toEqual([
      'thread',
      'post',
      'atlas-12',
      '--status',
      'done',
      '--',
      'shipped',
    ])
    expect(toolRun('cal', {}).argv).toEqual(['cal', 'list'])
    expect(toolRun('cal', { day: 'tomorrow', days: 2 }).argv).toEqual([
      'cal',
      'list',
      '--day',
      'tomorrow',
      '--days',
      '2',
    ])
    expect(bad('cal', { from: '--json' })).toMatch(/from/)
    expect(bad('nope', {})).toMatch(/^no tool "nope": card, schedule/)
  })

  test('spawn: spawn-agent with its own options', () => {
    expect(
      toolRun('spawn', {
        name: 'cleo',
        cwd: '/work/c d',
        brief: '-start here',
        profile: 'work',
        device: 'server-1',
        agent: 'codex',
        trust: true,
      }),
    ).toEqual({
      program: 'spawn-agent',
      argv: [
        '--name',
        'cleo',
        '--cwd',
        '/work/c d',
        '--brief',
        '-start here',
        '--profile',
        'work',
        '--device',
        'server-1',
        '--agent',
        'codex',
        '--trust',
      ],
    })
    expect(toolRun('spawn', { name: 'atlas', cwd: 'C:\\Work\\a b' }).argv).toEqual([
      '--name',
      'atlas',
      '--cwd',
      'C:\\Work\\a b',
    ])
    expect(bad('spawn', { cwd: '/w' })).toBe('spawn needs name')
    expect(bad('spawn', { name: 'a', cwd: '/w', agent: 'gpt' })).toMatch(/agent is claude, pi, agy, codex/)
    expect(bad('spawn', { name: 'a', cwd: '/w', profile: '--keep-env' })).toMatch(/profile/)
    expect(bad('spawn', { name: 'a', cwd: '/w', brief: 'x'.repeat(16_001) })).toMatch(/brief is longer/)
  })
})

describe('the caller in the env', () => {
  const board = {
    PATH: '/bin',
    CLAUDE_CODE_SESSION_ID: 'board-own',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_TAB_ID: 't1',
    HERDR_WORKSPACE_ID: 'w1',
    CODEX_THREAD_ID: 'codex-own',
    ANTIGRAVITY_CONVERSATION_ID: 'agy-own',
    CLAUDE_CONFIG_DIR: '/home/anna/.claude-work',
    AGENT_BOARD_PATHCONV: '1',
    BOARD_MCP_CALLER: '1',
    HERDR_ENV: '1',
    APPDATA: '/cfg',
    EMPTY: undefined,
  }

  test("no caller: none of the board's own identity, the rest as it was", () => {
    expect(callerEnv(board, null)).toEqual({ PATH: '/bin', HERDR_ENV: '1', APPDATA: '/cfg' })
  })

  test('a pane, a session, both', () => {
    // BOARD_MCP_CALLER (#815): a named caller is a session to spawn-agent's limits, a pane alone too.
    expect(callerEnv(board, { pane: 'w2:p7' })).toEqual({
      PATH: '/bin',
      HERDR_ENV: '1',
      APPDATA: '/cfg',
      HERDR_PANE_ID: 'w2:p7',
      BOARD_MCP_CALLER: '1',
    })
    expect(callerEnv(board, { session: 'pane-w2:p7', cwd: '/x' })).toEqual({
      PATH: '/bin',
      HERDR_ENV: '1',
      APPDATA: '/cfg',
      CLAUDE_CODE_SESSION_ID: 'pane-w2:p7',
      BOARD_MCP_CALLER: '1',
    })
    expect(callerEnv(board, { pane: '3', session: 'ünïcødé 100%' })).toMatchObject({
      HERDR_PANE_ID: '3',
      CLAUDE_CODE_SESSION_ID: 'ünïcødé 100%',
    })
  })

  test("the caller's Claude folder and workspace replace the board's", () => {
    expect(callerEnv(board, { pane: 'w2:p7', configDir: 'C:\\Users\\anna\\.claude-work', workspace: 'w2' })).toEqual({
      PATH: '/bin',
      HERDR_ENV: '1',
      APPDATA: '/cfg',
      HERDR_PANE_ID: 'w2:p7',
      BOARD_MCP_CALLER: '1',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\anna\\.claude-work',
      HERDR_WORKSPACE_ID: 'w2',
    })
  })
})

describe('the child', () => {
  test("herdr is asked for the pane's workspace for spawn only, and only with a pane", async () => {
    // Stand-ins for the two programs: each prints what it got.
    const root = mkdtempSync(join(tmpdir(), 'mcp-child-'))
    try {
      const dir = join(root, 'src', 'entrypoints')
      mkdirSync(dir, { recursive: true })
      const print =
        "console.log([process.env.HERDR_PANE_ID, process.env.HERDR_WORKSPACE_ID, process.env.CLAUDE_CONFIG_DIR, process.argv.slice(2).join(' ')].join('|'))"
      writeFileSync(join(dir, 'cli.ts'), print)
      writeFileSync(join(dir, 'spawn-agent.ts'), print)
      const asked: string[] = []
      const run = childRunner({
        root,
        env: () => ({ PATH: process.env.PATH, HERDR_WORKSPACE_ID: 'board-own', CLAUDE_CONFIG_DIR: '/board' }),
        cwd: root,
        exists: () => false,
        workspaceOf: async pane => {
          asked.push(pane)
          return 'wA'
        },
      })
      const spawn = { program: 'spawn-agent' as const, argv: ['--name', 'cleo'] }
      const caller = { pane: 'p1', configDir: '/home/anna/.claude-work' }
      expect((await run(spawn, caller)).out).toEqual(['p1|wA|/home/anna/.claude-work|--name cleo'])
      expect((await run({ program: 'board', argv: ['agents'] }, caller)).out).toEqual([
        'p1||/home/anna/.claude-work|agents',
      ])
      expect((await run(spawn, { session: 'ben-1' })).out).toEqual(['|||--name cleo'])
      expect((await run(spawn, null)).out).toEqual(['|||--name cleo'])
      expect(asked).toEqual(['p1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('JSON-RPC', () => {
  function server() {
    const runs: { argv: string[]; caller: unknown }[] = []
    const run: Runner = async (r, caller) => {
      runs.push({ argv: [r.program, ...r.argv], caller })
      await Bun.sleep(caller && typeof caller === 'object' && 'pane' in caller && caller.pane === 'slow' ? 30 : 0)
      return r.argv[0] === 'doing'
        ? { code: 0, out: [`ok · ${JSON.stringify(caller)}`], err: [] }
        : {
            code: 1,
            out: [],
            err: ['board: cannot tell which session this is: run it from a Claude session, or pass --session'],
          }
    }
    return { mcp: createHttpMcp({ version: '9.9.9', run }), runs }
  }
  const call = (id: number, name: string, args: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

  test('initialize, tools/list, a notification', async () => {
    const { mcp } = server()
    const init = JSON.parse(
      (await mcp.handle(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
        null,
      )) ?? '',
    )
    expect(init.result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-board', version: '9.9.9' },
    })
    expect(await mcp.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)).toBeNull()
    const list = JSON.parse(
      (await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), null)) ?? '',
    )
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(HTTP_TOOLS.map(t => t.name))
  })

  test('two callers at once each get their own, in their own answer', async () => {
    const { mcp, runs } = server()
    const [a, b] = await Promise.all([
      mcp.handle(call(1, 'card', { op: 'doing', text: 'a' }), { pane: 'slow' }),
      mcp.handle(call(2, 'card', { op: 'doing', text: 'b' }), { session: 'ben-key' }),
    ])
    expect(JSON.parse(a ?? '').result.content[0].text).toBe('ok · {"pane":"slow"}')
    expect(JSON.parse(b ?? '').result.content[0].text).toBe('ok · {"session":"ben-key"}')
    expect(runs.map(r => r.caller)).toEqual([{ pane: 'slow' }, { session: 'ben-key' }])
  })

  test("the command's own line as a tool error; a refused call runs nothing", async () => {
    const { mcp, runs } = server()
    const failed = JSON.parse((await mcp.handle(call(3, 'card', { op: 'done' }), null)) ?? '')
    expect(failed.result).toEqual({
      content: [
        {
          type: 'text',
          text: 'board: cannot tell which session this is: run it from a Claude session, or pass --session',
        },
      ],
      isError: true,
    })
    const refused = JSON.parse(
      (await mcp.handle(call(4, 'card', { op: 'ask', text: 'q', options: ['--session', 'x'] }), null)) ?? '',
    )
    expect(refused.result.isError).toBe(true)
    expect(runs).toHaveLength(1)
  })
})
