// spawn-agent on a node (#760), the master's side: a start a node's session asked for is placed by
// this board's own launches with the node as the folder's device, pinned when --device says so, and
// followed until the board's payload says where it went. Refused before anything ran: exit 3, so the
// node may start it itself; once taken, exit 1 or the line.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type SpawnCall, spawnCallArgv } from '../../src/core/launch/spawn-node.ts'
import type { UplinkCall } from '../../src/core/node-uplink.ts'
import type { Config, Item } from '../../src/core/types.ts'
import type { StartOptions } from '../../src/services/launch/launches.ts'
import { masterProfileOf, type SpawnFromDeps, spawnFrom } from '../../src/services/nodes/spawn-from.ts'

const pace = process.env.BOARD_TEST_PACE
beforeAll(() => {
  process.env.BOARD_TEST_PACE = '0.02'
})
afterAll(() => {
  if (pace === undefined) delete process.env.BOARD_TEST_PACE
  else process.env.BOARD_TEST_PACE = pace
})

const SID = '5d0c6a1e-1111-4222-8333-444455556666'
const NODE_CWD = '/home/anna/work/atlas'
const nodes = {
  id: 'server-2',
  lanes: 'all',
  order: ['local', 'server-1', 'laptop'],
  devices: {
    'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
    laptop: { link: { kind: 'direct', url: 'http://127.0.0.1:2' }, profiles: { default: 'personal' } },
  },
}
const facts = {
  checkout: { url: 'https://example.test/acme/atlas.git', clean: true, headPushed: true, branch: 'main', subdir: '' },
  identity: null,
  localPath: null,
}
const ask = (more: Partial<SpawnCall> = {}): UplinkCall => ({
  id: 'c1',
  cmd: 'spawn',
  argv: spawnCallArgv({
    name: 'Atlas worker',
    cwd: NODE_CWD,
    message: 'Fix the parser.',
    timeoutSec: 5,
    workspace: 'Atlas',
    profile: 'personal',
    facts,
    ...more,
  }),
  session: 'lead-session',
  lane: 'atlas',
  files: [],
})
const card: Item = { key: '@laptop:lead-session', name: 'Lead', profile: 'personal', category: 'atlas' } as Item
const who = { key: '@laptop:lead-session', item: card, lane: 'atlas' }

function deps(
  o: { payload?: (n: number) => Record<string, unknown> | null; offline?: string[]; refuse?: string } = {},
) {
  const started: { body: Record<string, unknown>; options: StartOptions }[] = []
  let polls = 0
  const d: SpawnFromDeps = {
    cfg: { nodes } as unknown as Config,
    hostName: 'server-2',
    start: async (body, options) => {
      started.push({ body: body as Record<string, unknown>, options })
      return o.refuse ? { ok: false, field: 'cwd', error: o.refuse } : { ok: true, id: 'abcd1234', session: SID }
    },
    payload: async () => (o.payload ? o.payload(polls++) : { items: [], launches: [] }),
    profiles: () =>
      ({ list: [{ id: 'default', title: 'Default', dir: '/x', inherited: true }], inheritedDir: '/x' }) as never,
    online: id => !(o.offline ?? []).includes(id),
    workspaces: async () => [{ id: 'w7', label: 'Atlas' }],
    herdrName: async pane => `name-of-${pane}`,
  }
  return { d, started }
}

const onNode = (device: string) => (n: number) =>
  n < 1
    ? { items: [], launches: [{ id: 'abcd1234', name: 'Atlas worker', state: 'starting', place: { device } }] }
    : { items: [{ key: `@${device}:${SID}`, session: SID, pane: 'w4:p2', device, name: 'Atlas worker' }], launches: [] }

describe('a node’s start on its master (#760)', () => {
  test('placed by the board’s rule with the node as the folder’s device, its profile as the board names it', async () => {
    const { d, started } = deps({ payload: onNode('server-1') })
    const r = await spawnFrom('laptop', who, ask(), d)
    expect(r).toEqual({
      code: 0,
      out: [`pane=@server-1:w4:p2 name=Atlas worker agent=@server-1:${SID} device=server-1 session=${SID}`],
      err: [],
    })
    expect(started).toEqual([
      {
        body: {
          name: 'Atlas worker',
          cwd: NODE_CWD,
          message: 'Fix the parser.',
          workspace: { id: 'w7', label: 'Atlas' },
          category: 'atlas',
          profile: 'default',
          byHand: false,
        },
        options: { byHand: false, origin: { device: 'laptop', facts } },
      },
    ])
  })

  test('--device pins it: the master’s own id is local; a session run here names this computer', async () => {
    const { d, started } = deps({
      payload: () => ({
        items: [],
        launches: [{ id: 'abcd1234', name: 'Atlas worker', state: 'done', pane: 'w1:p3' }],
      }),
    })
    const r = await spawnFrom('laptop', who, ask({ device: 'server-2' }), d)
    expect(started[0]?.body.pin).toEqual({ device: 'local' })
    expect(r).toEqual({
      code: 0,
      out: [`pane=@server-2:w1:p3 name=Atlas worker agent=name-of-w1:p3 device=server-2 session=${SID}`],
      err: [],
    })
  })

  test('an unknown or offline device is refused before anything starts (exit 3)', async () => {
    const a = deps()
    expect(await spawnFrom('laptop', who, ask({ device: 'server-9' }), a.d)).toEqual({
      code: 3,
      out: [],
      err: ['--device server-9: the board has no such device (it has server-2, server-1, laptop)'],
    })
    const b = deps({ offline: ['server-1'] })
    expect((await spawnFrom('laptop', who, ask({ device: 'server-1' }), b.d)).code).toBe(3)
    expect([...a.started, ...b.started]).toEqual([])
  })

  test('a profile only the node has keeps the start on the node, pinned there; elsewhere it is refused', async () => {
    const { d, started } = deps({ payload: onNode('laptop') })
    const r = await spawnFrom('laptop', who, ask({ profile: 'work' }), d)
    expect(r.code).toBe(0)
    expect(started[0]?.body.pin).toEqual({ device: 'laptop' })
    expect(started[0]?.body.profile).toBe('work')
    expect(started[0]?.options.origin).toEqual({ device: 'laptop', facts, nodeProfile: true })
    const away = deps()
    expect((await spawnFrom('laptop', who, ask({ profile: 'work', device: 'server-1' }), away.d)).code).toBe(3)
    expect(away.started).toEqual([])
  })

  test('the board turning it away is exit 3; refused in placement too; a failure after the start is exit 1', async () => {
    const refused = deps({ refuse: 'no folder there' })
    expect(await spawnFrom('laptop', who, ask(), refused.d)).toEqual({
      code: 3,
      out: [],
      err: ['no folder there (cwd)'],
    })
    const placement = deps({
      payload: () => ({
        items: [],
        launches: [
          {
            id: 'abcd1234',
            state: 'failed',
            error: '',
            place: { refuse: { kind: 'unfit', devices: [{ device: 'server-1', kind: 'paused' }] } },
          },
        ],
      }),
    })
    expect((await spawnFrom('laptop', who, ask(), placement.d)).code).toBe(3)
    // The board's own launch is gone once the node shows it: the node's failure names the device.
    const after = deps({
      payload: () => ({
        items: [],
        launches: [{ id: `@server-1:${SID}`, device: 'server-1', state: 'failed', error: 'claude exited' }],
      }),
    })
    // Followed to the node first (its own launch names the device), then failed there.
    let n = 0
    after.d.payload = async () =>
      n++ < 1
        ? { items: [], launches: [{ id: 'abcd1234', state: 'starting', place: { device: 'server-1' } }] }
        : {
            items: [],
            launches: [{ id: `@server-1:${SID}`, device: 'server-1', state: 'failed', error: 'claude exited' }],
          }
    expect(await spawnFrom('laptop', who, ask({ device: 'server-1' }), after.d)).toEqual({
      code: 1,
      out: [],
      err: ['on server-1: claude exited'],
    })
  })

  test('no folder on the node: one of the device named, never the node’s own', async () => {
    const { d, started } = deps({ payload: onNode('server-1') })
    expect((await spawnFrom('laptop', who, ask({ facts: null, device: 'server-1' }), d)).code).toBe(0)
    expect(started[0]?.options).toEqual({ byHand: false })
    expect(started[0]?.body.pin).toEqual({ device: 'server-1' })
    expect((await spawnFrom('laptop', who, ask({ facts: null }), deps().d)).code).toBe(3)
    expect((await spawnFrom('laptop', who, ask({ facts: null, device: 'laptop' }), deps().d)).code).toBe(3)
  })

  test('a call that is not one is refused', async () => {
    const { d, started } = deps()
    expect((await spawnFrom('laptop', who, { ...ask(), argv: ['{}'] }, d)).code).toBe(3)
    expect(started).toEqual([])
  })
})

test('the board’s profile for a node’s: mapped, else the same id when the board has it', () => {
  const set = { list: [{ id: 'default' }, { id: 'work' }, { id: 'ghost', hidden: true }] } as never
  expect(masterProfileOf({ default: 'personal' }, set, 'personal')).toBe('default')
  expect(masterProfileOf(undefined, set, 'work')).toBe('work')
  expect(masterProfileOf(undefined, set, 'ghost')).toBeNull()
  expect(masterProfileOf(undefined, set, 'other')).toBeNull()
  // The board's `work` is the node's `w2`: the node's own `work` is not the board's.
  expect(masterProfileOf({ work: 'w2' }, set, 'work')).toBeNull()
  expect(masterProfileOf({ work: 'w2' }, set, 'w2')).toBe('work')
})

test('the start is noted as taken before it is followed, never when refused; a Windows folder names its workspace', async () => {
  const a = deps({ payload: onNode('server-1') })
  const order: string[] = []
  a.d.taken = () => order.push('taken')
  const payload = a.d.payload
  a.d.payload = async () => {
    order.push('followed')
    return payload()
  }
  await spawnFrom('laptop', who, ask({ workspace: '', cwd: 'C:\\Users\\anna\\work\\Atlas tools' }), a.d)
  expect(order.slice(0, 2)).toEqual(['taken', 'followed'])
  expect(a.started[0]?.body.workspace).toEqual({ create: 'Atlas tools' })
  const b = deps({ refuse: 'no' })
  let taken = false
  b.d.taken = () => {
    taken = true
  }
  await spawnFrom('laptop', who, ask(), b.d)
  expect(taken).toBe(false)
})

/** What the board's own launch shows once the placer failed it before anything ran. */
const failedAt =
  (place: Record<string, unknown>, error = '') =>
  () => ({
    items: [],
    launches: [{ id: 'abcd1234', name: 'Atlas worker', state: 'failed', error, place }],
  })
/** The ids the board is asked to take off its list (launches.dismiss, #798). */
const dismissing = (d: SpawnFromDeps): string[] => {
  const ids: string[] = []
  d.dismiss = id => {
    ids.push(id)
  }
  return ids
}

describe('a node’s start with --trust on its master (#798)', () => {
  test('trust goes on to the board’s start as an option; a start without it has no trust key, body or options', async () => {
    const trusted = deps({ payload: onNode('server-1') })
    expect((await spawnFrom('laptop', who, ask({ trust: true }), trusted.d)).code).toBe(0)
    expect(trusted.started[0]?.options).toEqual({ byHand: false, origin: { device: 'laptop', facts }, trust: true })
    const plain = deps({ payload: onNode('server-1') })
    expect((await spawnFrom('laptop', who, ask(), plain.d)).code).toBe(0)
    expect(Object.keys(plain.started[0]?.options ?? {}).sort()).toEqual(['byHand', 'origin'])
    // The body is the same either way: --trust is the start's option, never one of the request's fields.
    expect(trusted.started[0]?.body).toEqual(plain.started[0]?.body)
    expect('trust' in (plain.started[0]?.body ?? {})).toBe(false)
    expect('trust' in (trusted.started[0]?.body ?? {})).toBe(false)
  })

  test('with no folder on the node, a device named takes it with trust; without it the options hold byHand only', async () => {
    const trusted = deps({ payload: onNode('server-1') })
    expect(
      (await spawnFrom('laptop', who, ask({ facts: null, device: 'server-1', trust: true }), trusted.d)).code,
    ).toBe(0)
    expect(trusted.started[0]?.options).toEqual({ byHand: false, trust: true })
    const plain = deps({ payload: onNode('server-1') })
    expect((await spawnFrom('laptop', who, ask({ facts: null, device: 'server-1' }), plain.d)).code).toBe(0)
    expect(Object.keys(plain.started[0]?.options ?? {})).toEqual(['byHand'])
  })

  test('a trust that is not true is no call the board reads: refused before anything starts (exit 3)', async () => {
    const { d, started } = deps()
    for (const trust of [false, 'yes', 1, null]) {
      const argv = [JSON.stringify({ ...JSON.parse(ask().argv[0] ?? '{}'), trust })]
      expect((await spawnFrom('laptop', who, { ...ask(), argv }, d)).code).toBe(3)
    }
    expect(started).toEqual([])
  })

  test('a start refused in placement is taken off the board, with or without trust; one the board cannot take off still answers exit 3', async () => {
    for (const trust of [true, undefined]) {
      for (const place of [
        { refuse: { kind: 'unfit', devices: [{ device: 'server-1', kind: 'paused' }] } },
        { queueFull: true },
        { checkout: 'could not clone it' },
      ]) {
        const { d } = deps({ payload: failedAt(place) })
        const dismissed = dismissing(d)
        const r = await spawnFrom('laptop', who, ask(trust ? { trust } : {}), d)
        expect(r.code, JSON.stringify(place)).toBe(3)
        expect(dismissed, JSON.stringify(place)).toEqual(['abcd1234'])
      }
    }
    // A board that gives no way to take it off (an older caller) answers the same.
    const bare = deps({ payload: failedAt({ queueFull: true }) })
    expect((await spawnFrom('laptop', who, ask(), bare.d)).code).toBe(3)
  })

  test('a start that failed after the board took it is not taken off its card: exit 1, the card stays', async () => {
    // The board's own launch failed with an error of its own, none of placement's.
    const own = deps({ payload: failedAt({}, 'claude exited') })
    const ids = dismissing(own.d)
    expect(await spawnFrom('laptop', who, ask(), own.d)).toEqual({ code: 1, out: [], err: ['claude exited'] })
    expect(ids).toEqual([])
    // The node's launch, once it shows it, failed there.
    const away = deps()
    const gone = dismissing(away.d)
    let n = 0
    away.d.payload = async () =>
      n++ < 1
        ? { items: [], launches: [{ id: 'abcd1234', state: 'starting', place: { device: 'server-1' } }] }
        : {
            items: [],
            launches: [{ id: `@server-1:${SID}`, device: 'server-1', state: 'failed', error: 'claude exited' }],
          }
    expect((await spawnFrom('laptop', who, ask({ device: 'server-1', trust: true }), away.d)).code).toBe(1)
    expect(gone).toEqual([])
    // A launch the board still holds in a state that is not a failure is left alone too.
    const waiting = deps({
      payload: () => ({ items: [], launches: [{ id: 'abcd1234', state: 'trust', place: { device: 'laptop' } }] }),
    })
    const kept = dismissing(waiting.d)
    expect((await spawnFrom('laptop', who, ask({ trust: true }), waiting.d)).code).toBe(1)
    expect(kept).toEqual([])
  })

  test('a start the board itself turns away dismisses nothing: there is no launch to take off', async () => {
    const { d } = deps({ refuse: 'no folder there' })
    const dismissed = dismissing(d)
    expect(await spawnFrom('laptop', who, ask({ trust: true }), d)).toEqual({
      code: 3,
      out: [],
      err: ['no folder there (cwd)'],
    })
    expect(dismissed).toEqual([])
  })
})
