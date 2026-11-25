// A terminal with no session on a node (#780, entrypoints/node-call.ts forwardNodeCall): the owner's
// few commands go up the relay (callOwner), never the uplink; every other command is refused as
// before, and a session's call goes down the uplink as it did.
import { expect, test } from 'bun:test'
import { forwardNodeCall, type NodeCall } from '../../src/entrypoints/node-call.ts'

async function forward(o: { cmd: NodeCall['cmd']; argv?: string[]; session: string | null; json?: boolean }) {
  const calls: NodeCall[] = []
  const owners: { cmd: string; argv: string[] }[] = []
  const out: string[] = []
  const err: string[] = []
  const code = await forwardNodeCall({
    cmd: o.cmd,
    argv: o.argv ?? [],
    session: o.session,
    port: 12422,
    json: o.json,
    call: async body => {
      calls.push(body)
      return { state: 'answered', code: 0, out: ['as the session'], err: [] }
    },
    callOwner: async body => {
      owners.push(body)
      return { state: 'answered', code: 0, out: ['as the owner'], err: [] }
    },
    out: l => out.push(l),
    err: l => err.push(l),
  })
  return { code, out, err, calls, owners }
}

test('no session: presence, away, journal, decisions, cats and cal go up as the owner', async () => {
  for (const cmd of ['presence', 'away', 'journal', 'decisions', 'cats', 'cal'] as const) {
    const r = await forward({ cmd, argv: ['x ünï 100%'], session: null })
    expect(r).toMatchObject({ code: 0, out: ['as the owner'], calls: [] })
    expect(r.owners).toEqual([{ cmd, argv: ['x ünï 100%'] }])
  }
})

test('no session: any other command is refused as before, and nothing is sent', async () => {
  for (const cmd of ['thread', 'send', 'team', 'remind', 'spawn'] as const) {
    const r = await forward({ cmd, session: null, json: true })
    expect(r.calls).toEqual([])
    expect(r.owners).toEqual([])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out[0] ?? '{}').error).toBe('no_session')
  }
})

test("a session's call goes down the uplink as before, with its session", async () => {
  const r = await forward({ cmd: 'presence', argv: ['away'], session: 'pane-1' })
  expect(r.owners).toEqual([])
  expect(r.calls).toHaveLength(1)
  expect(r.calls[0]).toMatchObject({ cmd: 'presence', argv: ['away'], session: 'pane-1' })
  expect(r.out).toEqual(['as the session'])
})

test("the lane of the terminal's folder goes up with the owner's call; none when there is none", async () => {
  const owners: unknown[] = []
  const callOwner = async (body: unknown) => {
    owners.push(body)
    return { state: 'answered' as const, code: 0, out: [], err: [] }
  }
  await forwardNodeCall({ cmd: 'time', argv: ['list'], session: null, lane: 'atlas', port: 1, callOwner })
  await forwardNodeCall({ cmd: 'time', argv: ['list'], session: null, lane: null, port: 1, callOwner })
  expect(owners).toEqual([
    { cmd: 'time', argv: ['list'], lane: 'atlas' },
    { cmd: 'time', argv: ['list'] },
  ])
})

test("the master away: the owner's call says the board's computer is not reachable", async () => {
  const out: string[] = []
  const code = await forwardNodeCall({
    cmd: 'presence',
    argv: [],
    session: null,
    port: 12422,
    json: true,
    callOwner: async () => ({ state: 'unreachable' }),
    out: l => out.push(l),
  })
  expect(code).toBe(1)
  expect(JSON.parse(out[0] ?? '{}')).toEqual({
    ok: false,
    error: 'unreachable',
    message: "the board's computer is not reachable",
  })
})
