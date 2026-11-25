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
import { calCmd, calPushFileArg } from '../../src/entrypoints/cal-cli.ts'
import { spendCmd } from '../../src/entrypoints/spend-cli.ts'
import {
  fileArgs,
  type NodeCall,
  type NodeCallAnswer,
  type ThreadCmdContext,
  threadCmd,
} from '../../src/entrypoints/thread-cli.ts'
import { timeCmd, timeImportFileArg } from '../../src/entrypoints/time-cli.ts'
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

test('board cal on a node forwards over the uplink, checks session, carries push --file, and leaves non-node unchanged (#698)', async () => {
  isolatedHome()
  const runCal = async (
    args: string[],
    o: {
      cfg?: Record<string, unknown>
      actor?: { key: string; name: string } | 'user'
      lane?: string | null
      answer?: NodeCallAnswer
    } = {},
  ) => {
    const calls: NodeCall[] = []
    const owners: { cmd: string; argv: string[]; lane?: string }[] = []
    const out: string[] = []
    const err: string[] = []
    const code = await calCmd(args, {
      cfg: (o.cfg ?? { node: NODE, port: 12422 }) as never,
      actor: o.actor ?? { key: me.key, name: me.name },
      lane: o.lane === undefined ? 'atlas' : o.lane,
      out: l => out.push(l),
      err: l => err.push(l),
      call: async body => {
        calls.push(body)
        return o.answer === undefined ? { state: 'answered', code: 0, out: ['ok'], err: [] } : o.answer
      },
      callOwner: async body => {
        owners.push(body)
        return o.answer === undefined ? { state: 'answered', code: 0, out: ['owner ok'], err: [] } : o.answer
      },
    })
    return { code, out, err, calls, owners }
  }

  // Forwarding a read (no call id) and a write (remembered UUID call id) even when calendar is off on the node.
  const listed = await runCal(['list', '--day', 'today'])
  expect(listed).toMatchObject({ code: 0, out: ['ok'], err: [] })
  expect(listed.calls).toEqual([
    { cmd: 'cal', argv: ['list', '--day', 'today'], session: me.key, lane: 'atlas', files: [] },
  ])
  expect(listed.calls[0]?.id).toBeUndefined()
  const added = await runCal(['add', '--title', 'Sync', '--start', '10:00', '--minutes', '30'])
  expect(added).toMatchObject({ code: 0, out: ['ok'], err: [] })
  expect(added.calls[0]?.id).toMatch(UUID)
  expect(nothingWritten()).toBe(true)

  // Push requires --file on a node (stdin is not forwarded) and resolves the file path.
  expect(calPushFileArg(['--source', 'work', '--file', 'events.json'])).toBe(3)
  expect(calPushFileArg(['--source', 'work', '--', '--file'])).toBe(-1)
  const pushNoFile = await runCal(['push', '--source', 'work', '--json'])
  expect(pushNoFile.code).toBe(1)
  expect(pushNoFile.calls).toEqual([])
  expect(JSON.parse(pushNoFile.out[0] ?? '{}')).toEqual({
    ok: false,
    error: 'file_required',
    message: 'board cal push from a node needs --file <events.json> (stdin is not forwarded)',
  })

  const pushed = await runCal(['push', '--source', 'work', '--file', 'events 100%.json'])
  expect(pushed.code).toBe(0)
  expect(pushed.calls[0]?.files).toEqual([resolve('events 100%.json')])

  // Older master (126), unreachable master, stopped board, and non-session caller fail cleanly.
  const older = await runCal(['list', '--json'], {
    answer: {
      state: 'answered',
      code: 126,
      out: [],
      err: ["board cal is not taken from a node: run it on the board's computer"],
    },
  })
  expect(older.code).toBe(1)
  expect(JSON.parse(older.out[0] ?? '{}')).toEqual({
    ok: false,
    error: 'master_outdated',
    message: "board cal is not supported by the board's computer yet: update the master board to a newer version",
  })

  const unreach = await runCal(['list'], { answer: { state: 'unreachable' } })
  expect(unreach).toMatchObject({ code: 1, err: ["the board's computer is not reachable"] })

  // Outside a session (#780): the owner's, up the relay, never the uplink.
  const asUser = await runCal(['list'], { actor: 'user' })
  expect(asUser.calls).toEqual([])
  expect(asUser.owners).toEqual([{ cmd: 'cal', argv: ['list'], lane: 'atlas' }])
  expect(asUser).toMatchObject({ code: 0, out: ['owner ok'], err: [] })
  // A push carries a file: outside a session it is refused here, before anything goes up.
  const ownerPush = await runCal(['push', '--file', 'events.json'], { actor: 'user' })
  expect(ownerPush.owners).toEqual([])
  expect(ownerPush.calls).toEqual([])
  expect(ownerPush.code).toBe(1)

  // Help stays local even on a node.
  const help = await runCal(['--help'])
  expect(help.code).toBe(0)
  expect(help.calls).toEqual([])
  expect(help.out.join('\n')).toContain('board cal list')

  // Without `node`, board cal runs locally with zero fetch calls.
  const fetched: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    return new Response('{}')
  }) as typeof fetch
  const calOff = await calCmd(['list'], { cfg: {}, actor: 'user', out: () => {}, err: () => {} })
  expect(calOff).toBe(1)
  expect(fetched).toEqual([])
})

test('board spend on a node stays local and never forwards over uplink or fetch (#698)', async () => {
  isolatedHome()
  const fetched: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    return new Response('{}')
  }) as typeof fetch

  for (const cfg of [
    { node: NODE, port: 12422 },
    { language: 'en', categories: [], placement: 'workspace', workspace: 'Board', refreshSec: 2 },
  ]) {
    const out: string[] = []
    const err: string[] = []
    const code = await spendCmd(['--day', '2026-11-20'], {
      cfg: cfg as never,
      deps: {
        profiles: () => ({ inheritedDir: '', inherited: null, list: [] }),
        homes: { liveSessions: () => new Map() } as never,
        codex: { sessions: () => [] } as never,
      },
      codexRoots: [],
      piRoots: [],
      out: l => out.push(l),
      err: l => err.push(l),
    })
    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out[0]).toContain('no token spend')
  }
  expect(fetched).toEqual([])
})

test('board time on a node forwards all subcommands over the uplink, checks session, and explains older masters (#644)', async () => {
  isolatedHome()
  const actor = { key: me.key, name: me.name }
  const runTime = async (
    args: string[],
    o: {
      cfg?: Record<string, unknown>
      actor?: { key: string; name: string } | 'user'
      lane?: string | null
      answer?: NodeCallAnswer
    } = {},
  ) => {
    const calls: NodeCall[] = []
    const owners: { cmd: string; argv: string[]; lane?: string }[] = []
    const out: string[] = []
    const err: string[] = []
    const code = await timeCmd(args, {
      cfg: (o.cfg ?? { node: NODE, port: 12422 }) as never,
      actor: o.actor ?? actor,
      lane: o.lane === undefined ? 'atlas' : o.lane,
      out: l => out.push(l),
      err: l => err.push(l),
      call: async body => {
        calls.push(body)
        return o.answer === undefined ? { state: 'answered', code: 0, out: ['ok'], err: [] } : o.answer
      },
      callOwner: async body => {
        owners.push(body)
        return o.answer === undefined ? { state: 'answered', code: 0, out: ['owner ok'], err: [] } : o.answer
      },
    })
    return { code, out, err, calls, owners }
  }

  // Forwarding a write (remembered UUID id) and a read (no id) with session and lane, even when time is off on the node.
  const added = await runTime(['add', '--project', 'Support', '--minutes', '45', 'Client work'])
  expect(added).toMatchObject({ code: 0, out: ['ok'], err: [] })
  expect(added.calls[0]?.id).toMatch(UUID)
  expect(added.calls[0]).toMatchObject({
    cmd: 'time',
    argv: ['add', '--project', 'Support', '--minutes', '45', 'Client work'],
    session: me.key,
    lane: 'atlas',
    files: [],
  })
  const listedTime = await runTime(['list'])
  expect(listedTime.calls[0]?.id).toBeUndefined()
  expect(nothingWritten()).toBe(true)
  expect(existsSync(dbFile())).toBe(false)

  // Import attaches the resolved file path to `files` (and respects flags + `--`).
  expect(timeImportFileArg(['toggl.csv', '--tz', 'UTC'])).toBe(0)
  expect(timeImportFileArg(['--tz', 'UTC', '--dry-run', 'toggl.csv'])).toBe(3)
  expect(timeImportFileArg(['--dry-run', '--', '--odd.csv'])).toBe(2)
  expect(timeImportFileArg(['--tz', 'UTC'])).toBe(-1)
  const imp = await runTime(['import', '--tz', 'UTC', 'toggl 100%.csv', '--dry-run'])
  expect(imp.calls[0]?.files).toEqual([resolve('toggl 100%.csv')])

  // Older master (refuses cmd 'time' with 126): clear "update the master" error in human and JSON modes.
  const older: NodeCallAnswer = {
    state: 'answered',
    code: 126,
    out: [],
    err: ['board time is not taken from a node: only board thread, board send and board agents'],
  }
  const oldHuman = await runTime(['list'], { answer: older })
  expect(oldHuman.code).toBe(1)
  expect(oldHuman.err[0]).toContain('update the master')
  const oldJson = await runTime(['list', '--json'], { answer: older })
  expect(oldJson.code).toBe(1)
  expect(JSON.parse(oldJson.out[0] ?? '{}')).toEqual({
    ok: false,
    error: 'master_outdated',
    message: "board time is not supported by the board's computer yet: update the master board to a newer version",
  })

  // Unreachable master, stopped node board, and non-session caller fail cleanly.
  const unreach = await runTime(['list', '--json'], { answer: { state: 'unreachable' } })
  expect(unreach.code).toBe(1)
  expect(JSON.parse(unreach.out[0] ?? '{}')).toEqual({
    ok: false,
    error: 'unreachable',
    message: "the board's computer is not reachable",
  })
  const noBoard = await runTime(['list'], { answer: null })
  expect(noBoard).toMatchObject({ code: 1, err: ['the board does not run on this computer: nothing was sent'] })
  // Outside a session (#780): the owner's, up the relay, never the uplink; an import's file stays with a session.
  const asUser = await runTime(['list'], { actor: 'user' })
  expect(asUser.calls).toEqual([])
  expect(asUser.owners).toEqual([{ cmd: 'time', argv: ['list'], lane: 'atlas' }])
  expect(asUser).toMatchObject({ code: 0, out: ['owner ok'], err: [] })
  const ownerAway = await runTime(['list', '--json'], { actor: 'user', answer: { state: 'unreachable' } })
  expect(JSON.parse(ownerAway.out[0] ?? '{}')).toMatchObject({ ok: false, error: 'unreachable' })
  const ownerImport = await runTime(['import', 'entries.csv'], { actor: 'user' })
  expect(ownerImport.owners).toEqual([])
  expect(ownerImport.code).toBe(1)

  // Help stays local even on a node.
  const help = await runTime(['add', '--help'])
  expect(help.code).toBe(0)
  expect(help.calls).toEqual([])
  expect(help.out.join('\n')).toContain('board time add')

  // Without `node`, board time runs locally with zero fetch calls.
  const fetched: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    return new Response('{}')
  }) as typeof fetch
  for (const node of [undefined, false, null, { id: 'Not A Device', port: 1 }]) {
    const out: string[] = []
    const code = await timeCmd(['list', '--json'], {
      cfg: { language: 'en', ...(node !== undefined && { node }) } as never,
      actor,
      lane: 'atlas',
      out: l => out.push(l),
    })
    expect(code).toBe(1)
    expect(JSON.parse(out[0] ?? '{}').error).toBe('off')
  }
  expect(fetched).toEqual([])
})

// Case files (#488): the master runs a node session's command with its own config, so a node needs
// no cases of its own to pass --ref, --state and brief on; the master refuses them when it has them off.
test('case files on a node: --ref, --state and brief go to the master as typed; a state that reads like --file is a value', async () => {
  isolatedHome()
  expect(fileArgs('post', ['k', '--state', '--file', '--file', 'r.md'])).toEqual([4])
  expect(fileArgs('done', ['k', '--state', 'Mapped.', '--file', 'r.md'])).toEqual([4])
  expect(fileArgs('new', ['--ref', '--file', 'T'])).toEqual([])
  for (const args of [
    ['brief', 'atlas-1'],
    ['new', '--ref', 'ABC-12', 'Import'],
    ['post', 'atlas-1', '--state', 'Mapped 217 rows.'],
    ['list', '--ref', 'ABC-12'],
  ]) {
    const r = await run(args)
    expect([args, r.code, r.calls.map(c => c.argv)]).toEqual([args, 0, [args]])
  }
  const r = await run(['post', 'atlas-1', '--state', '--file', '--file', 'r.md'])
  expect(r.calls[0]?.files).toEqual([resolve('r.md')])
  expect(nothingWritten()).toBe(true)
})
