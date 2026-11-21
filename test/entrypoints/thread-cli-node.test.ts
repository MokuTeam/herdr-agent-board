// `board thread`, `board time` and `board cal` on a node (#508, docs/design/nodes 10 items 5 and 6), in
// this process: the command hands its call to the node's board (a stand-in here) and prints what
// the master answered; this computer's database is never opened. Without `node` each command runs
// as it always has, with no request to any board on its way. The running pair is in
// test/server/node-uplink.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { dbFile } from '../../src/adapters/db.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { calCmd } from '../../src/entrypoints/cal-cli.ts'
import {
  fileArgs,
  type NodeCall,
  type NodeCallAnswer,
  type ThreadCmdContext,
  threadCmd,
} from '../../src/entrypoints/thread-cli.ts'
import { timeCmd } from '../../src/entrypoints/time-cli.ts'
import { isolatedHome } from '../support/env.ts'

const NODE = { id: 'server-1', port: 12430, workRoot: '/srv/work' }
const me: Party = { kind: 'session', key: '11111111-1111-4111-8111-111111111111', name: 'atlas-worker' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** `board thread <args>` with `cfg`, its calls to the node's board answered by `answer`. */
async function run(
  args: string[],
  o: { cfg?: ThreadCmdContext['cfg']; actor?: Party; answer?: NodeCallAnswer; over?: Partial<ThreadCmdContext> } = {},
) {
  const calls: NodeCall[] = []
  const asks: string[] = []
  const out: string[] = []
  const err: string[] = []
  const code = await threadCmd(args, {
    cfg: o.cfg ?? { node: NODE, port: 12422 },
    actor: o.actor ?? me,
    lane: 'atlas',
    findSession: async () => null,
    setAsk: q => asks.push(q),
    out: l => out.push(l),
    err: l => err.push(l),
    call: async body => {
      calls.push(body)
      return o.answer === undefined ? { state: 'answered', code: 0, out: ['ok · atlas-1 · doing'], err: [] } : o.answer
    },
    ...o.over,
  })
  return { code, out, err, calls, asks }
}

/** Nothing of the board's under the state folder: no database, no file at all. */
const nothingWritten = (): boolean => !existsSync(stateDir()) || readdirSync(stateDir()).length === 0

test('on a node a post goes to the board as the session, its files by their full paths, with an id of its own', async () => {
  isolatedHome()
  const r = await run(['post', 'atlas-1', '--status', 'doing', '--file', 'report.md', '--summary', '--file', 'note'])
  expect(r.code).toBe(0)
  expect(r.out).toEqual(['ok · atlas-1 · doing'])
  expect(r.calls).toHaveLength(1)
  const [call] = r.calls
  expect(call?.id).toMatch(UUID)
  expect({ ...call, id: undefined }).toEqual({
    id: undefined,
    cmd: 'thread',
    argv: ['post', 'atlas-1', '--status', 'doing', '--file', 'report.md', '--summary', '--file', 'note'],
    session: me.key,
    lane: 'atlas',
    // --summary's value is text, not a file.
    files: [resolve('report.md')],
  })
  // Threads are off in this config.json: on a node it does not matter, the master holds them.
  expect(nothingWritten()).toBe(true)
  expect(existsSync(dbFile())).toBe(false)
})

test('a write the master did not answer in time is kept and succeeds; a read that got none fails, not kept', async () => {
  isolatedHome()
  const kept = await run(['done', 'atlas-1', 'shipped'], { answer: { state: 'kept', id: 'k1' } })
  expect(kept).toMatchObject({ code: 0, out: ["kept, goes to the board's computer when it is reachable"], err: [] })
  const keptJson = await run(['post', 'atlas-1', 'x', '--json'], { answer: { state: 'kept', id: 'k2' } })
  expect(keptJson.out.map(l => JSON.parse(l))).toEqual([{ ok: true, kept: true, id: 'k2' }])

  const read = await run(['list'], { answer: { state: 'unreachable' } })
  expect(read).toMatchObject({ code: 1, out: [], err: ["the board's computer is not reachable"] })
  expect(read.calls[0]?.id).toBeUndefined()
  const readJson = await run(['show', 'atlas-1', '--json'], { answer: { state: 'unreachable' } })
  expect(readJson.code).toBe(1)
  expect(readJson.out.map(l => JSON.parse(l))).toEqual([
    { ok: false, error: 'unreachable', message: "the board's computer is not reachable" },
  ])
  // No board on this computer: nothing went anywhere.
  const none = await run(['post', 'atlas-1', 'x'], { answer: null })
  expect(none).toMatchObject({ code: 1, err: ['the board does not run on this computer: nothing was sent'] })
  expect(nothingWritten()).toBe(true)
})

test("the master's answer is printed as it came, its exit code the command's", async () => {
  isolatedHome()
  const r = await run(['post', 'atlas-9', 'x'], {
    answer: { state: 'answered', code: 1, out: [], err: ['no thread "atlas-9"'] },
  })
  expect(r).toMatchObject({ code: 1, out: [], err: ['no thread "atlas-9"'] })
  const refused = await run(['share', 'atlas-1', 'team'], {
    answer: {
      state: 'answered',
      code: 126,
      out: [],
      err: ['board thread share is for the owner to confirm: not from a node'],
    },
  })
  expect(refused.code).toBe(126)
})

test("an ask puts the question on this session's card here, answered or kept; a failed one does not", async () => {
  isolatedHome()
  expect((await run(['ask', 'atlas-1', 'ship', 'it?'])).asks).toEqual(['ship it?'])
  expect((await run(['ask', 'atlas-1', 'now?'], { answer: { state: 'kept', id: 'k' } })).asks).toEqual(['now?'])
  const failed = await run(['ask', 'atlas-1', 'no?'], { answer: { state: 'answered', code: 1, out: [], err: ['x'] } })
  expect(failed.asks).toEqual([])
})

test('watch takes back the --idle the board command took out of its words; reads carry no id', async () => {
  isolatedHome()
  const w = await run(['watch', 'atlas-1', '--', 'text'], { over: { idle: true } })
  expect(w.calls[0]?.argv).toEqual(['watch', 'atlas-1', '--idle', '--', 'text'])
  expect(w.calls[0]?.id).toMatch(UUID)
  for (const sub of ['list', 'show', 'changes', 'link']) expect((await run([sub])).calls[0]?.id).toBeUndefined()
  for (const sub of ['post', 'ask', 'done', 'new', 'set', 'watch', 'unwatch'])
    expect((await run([sub])).calls[0]?.id).toMatch(UUID)
})

test("outside a session nothing goes: the owner's own commands are not sent from a node", async () => {
  isolatedHome()
  const r = await run(['post', 'atlas-1', 'x'], { actor: { kind: 'owner' } })
  expect(r.calls).toEqual([])
  expect(r).toMatchObject({
    code: 1,
    err: ["run it from a session: on a node, board thread goes to the board's computer as a session's"],
  })
  // The help is this command's own, on a node too.
  const help = await run(['--help'])
  expect(help.calls).toEqual([])
  expect(help.out[0]).toStartWith('board thread new')
})

test("without node: the command writes this computer's database, and asks no board anything", async () => {
  isolatedHome()
  const fetched: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    return new Response('{}')
  }) as typeof fetch
  const made = await run(['new', 'Here'], { cfg: { threads: true, port: 12422 } })
  expect(made).toMatchObject({ code: 0, out: ['ok · atlas-1 · next'], err: [], calls: [] })
  const posted = await run(['post', 'atlas-1', '--status', 'doing', 'on it'], { cfg: { threads: true, port: 12422 } })
  expect(posted).toMatchObject({ code: 0, out: ['ok · atlas-1 · doing'], calls: [] })
  expect(existsSync(dbFile())).toBe(true)
  expect(fetched).toEqual([])
  // `node: false`, or one that does not check out, is no node either.
  for (const node of [false, null, { id: 'Not A Device', port: 1 }]) {
    const r = await run(['list'], { cfg: { threads: true, port: 12422, node } })
    expect([node, r.code, r.calls]).toEqual([node, 0, []])
  }
})

test('fileArgs: the value of each --file of a post or a done, as the command reads them', () => {
  expect(fileArgs('post', ['k', '--file', 'a', '--file', 'b'])).toEqual([2, 4])
  expect(fileArgs('done', ['k', '--file', 'a', 'summary'])).toEqual([2])
  // A value of another flag, and text after a lone --, are none.
  expect(fileArgs('post', ['k', '--summary', '--file', '--waiting', 'x'])).toEqual([])
  expect(fileArgs('post', ['k', '--', '--file', 'a'])).toEqual([])
  expect(fileArgs('post', ['k', '--file'])).toEqual([])
  // Commands that take no file.
  expect(fileArgs('new', ['--file', 'a'])).toEqual([])
  expect(fileArgs('import', ['tasks.json'])).toEqual([])
})

test('board time and board cal on a node say they are not here yet, in one line, and fail', async () => {
  isolatedHome()
  const lines: string[] = []
  const timeJson = await timeCmd(['list', '--json'], {
    cfg: { node: NODE, time: { clients: {} } } as never,
    actor: 'user',
    lane: null,
    out: l => lines.push(l),
  })
  expect(timeJson).toBe(1)
  expect(lines.map(l => JSON.parse(l))).toEqual([
    { ok: false, error: 'node', message: "board time is not available on a node yet: it runs on the board's computer" },
  ])
  await expect(
    timeCmd(['list'], { cfg: { node: NODE } as never, actor: 'user', lane: null, out: () => {} }),
  ).rejects.toThrow("board time is not available on a node yet: it runs on the board's computer")
  const out: string[] = []
  const err: string[] = []
  const cal = await calCmd(['list'], {
    cfg: { node: NODE },
    actor: 'user',
    out: l => out.push(l),
    err: l => err.push(l),
  })
  expect([cal, out, err]).toEqual([
    1,
    [],
    ["board cal is not available on a node yet: it runs on the board's computer"],
  ])
  expect(nothingWritten()).toBe(true)
  // Without node, as before: off says off.
  const off: string[] = []
  const offErr: string[] = []
  const calOff = await calCmd(['list'], { cfg: {}, actor: 'user', out: l => off.push(l), err: l => offErr.push(l) })
  expect(calOff).toBe(1)
  expect(offErr.join('\n')).not.toContain('node')
})
