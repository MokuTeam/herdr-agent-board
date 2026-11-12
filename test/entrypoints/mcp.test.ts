// `board mcp` (#394, entrypoints/mcp.ts): the threads' two tools over stdio JSON-RPC, each call the
// `board thread` command run in this process against a temp state folder. The tool list is exactly
// the design's two tools (5.4); a write answers the one line the command prints; a refusal and a
// call the server cannot read come back as errors, never as a crash; nothing but the protocol is
// written.
import { describe, expect, test } from 'bun:test'
import type { Party } from '../../src/core/work-threads.ts'
import { createMcpServer, readArgv, serve, type ThreadRun, TOOLS, writeArgv } from '../../src/entrypoints/mcp.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const worker: Party = { kind: 'session', key: '22222222-2222-4222-8222-222222222222', name: 'atlas-mapper' }

/** A server whose calls run `board thread` as `worker` in lane atlas, threads on or off. */
function server(threads: unknown = true) {
  isolatedHome()
  const runs: string[][] = []
  const run = async (argv: string[]): Promise<ThreadRun> => {
    runs.push(argv)
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(argv, {
      cfg: { ...(threads !== undefined && { threads }), port: 12422 },
      actor: worker,
      lane: 'atlas',
      findSession: async () => null,
      out: l => out.push(l),
      err: l => err.push(l),
      now: NOW,
    })
    return { code, out, err }
  }
  return { mcp: createMcpServer({ version: '9.9.9', run }), runs }
}

/** The lines written back for these requests, read as JSON. */
async function exchange(mcp: ReturnType<typeof createMcpServer>, ...msgs: (object | string)[]): Promise<unknown[]> {
  const written: string[] = []
  async function* input(): AsyncGenerator<string> {
    // Split across chunks the way a pipe may deliver them.
    const text = msgs.map(m => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n')
    const cut = Math.floor(text.length / 2)
    yield text.slice(0, cut)
    yield `${text.slice(cut)}\n`
  }
  await serve(mcp, input(), line => written.push(line))
  for (const w of written) expect(w.endsWith('\n') && !w.slice(0, -1).includes('\n')).toBe(true)
  return written.map(w => JSON.parse(w))
}

/** An answer as the tests read it. */
interface Answer {
  jsonrpc?: string
  id?: unknown
  result?: {
    content?: { type: string; text: string }[]
    isError?: true
    tools?: { name: string }[]
    [k: string]: unknown
  }
  error?: { code: number; message: string }
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
})

describe('board mcp', () => {
  test('initialize names the server and echoes the protocol; a notification gets no answer; two tools, no more', async () => {
    const { mcp } = server()
    const [init, list, ping] = (await exchange(
      mcp,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    )) as Answer[]
    expect(init).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-board', version: '9.9.9' },
      },
    })
    expect(list?.id).toBe(2)
    expect(list?.result?.tools?.map(t => t.name)).toEqual(['threads', 'thread'])
    expect(ping).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
    // The schema every session carries stays small.
    expect(JSON.stringify(TOOLS).length).toBeLessThan(2500)
  })

  test('a thread made, posted to and listed through the tools: the lines the command prints', async () => {
    const { mcp, runs } = server()
    const answers = (await exchange(
      mcp,
      call(1, 'thread', { op: 'new', title: '--Map the 2019 price columns', status: 'doing' }),
      call(2, 'thread', {
        op: 'post',
        key: 'atlas-1',
        status: 'done',
        summary: '217 rows mapped',
        text: '--two header rows',
      }),
      call(3, 'threads', { op: 'list' }),
      call(4, 'threads', { op: 'show', key: 'atlas-1', last: 2 }),
    )) as Answer[]
    const text = (i: number): string => answers[i]?.result?.content?.[0]?.text ?? ''
    expect(answers.every(a => a.result?.isError === undefined)).toBe(true)
    expect(text(0)).toBe('ok · atlas-1 · doing')
    expect(text(1)).toBe('ok · atlas-1 · done')
    // The thread's list holds no open one now; a closed one is listed with --done only.
    expect(text(2)).toBe('no open threads')
    expect(text(3)).toContain('217 rows mapped')
    expect(text(3)).toContain('--two header rows')
    // A title or a text that starts with -- goes after a lone --, never as a flag.
    expect(runs[0]).toEqual(['new', '--doing', '--', '--Map the 2019 price columns'])
    expect(runs[1]).toEqual([
      'post',
      'atlas-1',
      '--status',
      'done',
      '--summary',
      '217 rows mapped',
      '--',
      '--two header rows',
    ])
  })

  test('refusals come back as tool errors: the command refuses, the server will not read a call, threads off', async () => {
    const { mcp, runs } = server()
    const [missing, flag, unknown, bad] = (await exchange(
      mcp,
      call(1, 'thread', { op: 'post', key: 'atlas-9', text: 'x' }),
      call(2, 'threads', { op: 'show', key: '--full' }),
      call(3, 'board', { op: 'list' }),
      call(4, 'thread', { op: 'post', key: 'atlas-1', status: 'finished' }),
    )) as Answer[]
    expect(missing?.result).toEqual({
      content: [{ type: 'text', text: 'no thread "atlas-9" on this board' }],
      isError: true,
    })
    expect(flag?.result?.isError).toBe(true)
    expect(unknown?.result?.content?.[0]?.text).toContain('no tool "board"')
    expect(bad?.result?.isError).toBe(true)
    // Only the first reached the command: the others were refused before it ran.
    expect(runs).toHaveLength(1)

    const off = server(false)
    const [r] = (await exchange(off.mcp, call(1, 'threads', { op: 'list' }))) as Answer[]
    expect(r?.result).toEqual({ content: [{ type: 'text', text: 'threads are off' }], isError: true })
  })

  test('JSON-RPC errors: a line that is no JSON, an unknown method; an empty line says nothing', async () => {
    const { mcp } = server()
    const [parse, method] = (await exchange(mcp, 'not json', '', {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
    })) as Answer[]
    expect(parse).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    expect(method?.id).toBe(7)
    expect(method?.error?.code).toBe(-32601)
  })

  test('the argv each op builds', () => {
    expect(readArgv({ op: 'list', mine: true, lane: 'atlas' })).toEqual(['list', '--mine', '--lane', 'atlas'])
    expect(readArgv({ op: 'changes' })).toEqual(['changes'])
    expect(writeArgv({ op: 'ask', key: 'atlas-2', text: 'which price list wins?' })).toEqual([
      'ask',
      'atlas-2',
      '--',
      'which price list wins?',
    ])
    expect(writeArgv({ op: 'set', key: 'atlas-2', to: 'none', title: 'New title' })).toEqual([
      'set',
      'atlas-2',
      '--title',
      'New title',
      '--assignee',
      'none',
    ])
    expect(writeArgv({ op: 'post', key: 'atlas-2', files: ['out/report.md'] })).toEqual([
      'post',
      'atlas-2',
      '--file',
      'out/report.md',
    ])
    expect(writeArgv({ op: 'watch' })).toEqual(['watch', '--mine'])
    expect(() => writeArgv({ op: 'post', key: 'atlas 2' })).toThrow()
    expect(() => readArgv({ op: 'show' })).toThrow('show needs key')
  })
})
