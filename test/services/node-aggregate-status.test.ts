// Statuses in the master's `devices` row (#500, services/nodes/aggregate.ts): a node's as its link
// last told it, this computer's own asked every status interval, each held while its shown
// figures round the same, so a status every 30 s pushes the board to no page; one past its
// rounding publishes once.
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import type { DeviceView, NodeStatus } from '../../src/core/nodes.ts'
import type { Config } from '../../src/core/types.ts'
import { createNodeAggregate } from '../../src/services/nodes/aggregate.ts'
import type { NodeLinks } from '../../src/services/nodes/links.ts'
import type { Clock } from '../../src/services/tunnel.ts'

const status = (id: string, more: Partial<NodeStatus> = {}): NodeStatus => ({
  api: 1,
  id,
  version: '0.1.0',
  commit: 'abc',
  platform: 'linux',
  arch: 'x64',
  cpus: 8,
  memTotalMb: 32013,
  memAvailableMb: 21480,
  load: [0.42, 0.61, 0.58],
  sessions: { awake: 2, working: 1, asleep: 5 },
  launches: 0,
  workRootFreeMb: 148000,
  profiles: [{ id: 'default', loggedIn: true, bundle: null }],
  agents: ['claude'],
  at: 1,
  ...more,
})

/** A clock whose intervals run when the test says. */
function stepClock() {
  const every = new Map<number, () => void>()
  let n = 0
  const clock: Clock = {
    now: () => 1795210000000,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval(fn) {
      every.set(++n, fn)
      return n
    },
    clearInterval: h => void every.delete(h as number),
  }
  return { clock, live: () => every.size, tick: () => [...every.values()].forEach(fn => void fn()) }
}

const settle = () => Bun.sleep(5)

const cfg = {
  nodes: { id: 'laptop', devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:9' } } } },
} as unknown as Config

function setup(own: () => NodeStatus | null) {
  let nodeStatus: NodeStatus | null = null
  const view = (): DeviceView[] => [
    {
      id: 'server-1',
      title: 'server-1',
      kind: 'direct',
      link: { state: 'online', since: 1, heardAt: null },
      status: nodeStatus,
      sameCommit: null,
      payloadAt: null,
    },
    { id: 'local', title: 'local', kind: null, link: null, status: null, sameCommit: null, payloadAt: null },
  ]
  const links: Pick<NodeLinks, 'on' | 'view' | 'link' | 'onChange'> = {
    on: () => true,
    view: () => ({ devices: view(), problems: [] }),
    link: () => null,
    onChange: () => () => {},
  }
  const c = stepClock()
  let published = 0
  const agg = createNodeAggregate({
    links,
    cfg,
    log: () => {},
    onChange: () => published++,
    store: createDeviceStore({ dir: mkdtempSync(join(tmpdir(), 'agg-status-')) }),
    clock: c.clock,
    hostName: 'laptop',
    ownStatus: async () => own(),
    statusMs: 300,
  })
  return {
    agg,
    c,
    published: () => published,
    setNode: (s: NodeStatus) => {
      nodeStatus = s
    },
  }
}

test("this computer's own status in its row: asked every interval, published only when its figures move", async () => {
  let own = status('laptop')
  const s = setup(() => own)
  await settle()
  expect(s.published()).toBe(1)
  expect(s.agg.part()?.devices.find(d => d.id === 'local')?.status).toEqual(own)
  const first = JSON.stringify(s.agg.part())
  // Every 30 s a new status that rounds the same: nothing published, the row as it was.
  for (let i = 2; i < 5; i++) {
    own = status('laptop', { at: i, memAvailableMb: 21_480 + i * 10 })
    s.c.tick()
    await settle()
  }
  expect(s.published()).toBe(1)
  expect(JSON.stringify(s.agg.part())).toBe(first)
  // Past its rounding: published once, the row shows it.
  own = status('laptop', { at: 9, memAvailableMb: null })
  s.c.tick()
  await settle()
  s.c.tick()
  await settle()
  expect(s.published()).toBe(2)
  expect(s.agg.part()?.devices.find(d => d.id === 'local')?.status?.memAvailableMb).toBeNull()
  s.agg.close()
  expect(s.c.live()).toBe(0)
})

test("a node's status in its row is held while its figures round the same", async () => {
  const s = setup(() => null)
  s.setNode(status('server-1'))
  const first = JSON.stringify(s.agg.part())
  s.setNode(status('server-1', { at: 2, load: [1, 0.63, 1] }))
  expect(JSON.stringify(s.agg.part())).toBe(first)
  s.setNode(status('server-1', { at: 3, sessions: { awake: 3, working: 1, asleep: 4 } }))
  expect(s.agg.part()?.devices[0]?.status?.at).toBe(3)
  s.agg.close()
})

test('an ask that answers after close publishes nothing', async () => {
  let answer: (s: NodeStatus) => void = () => {}
  const c = stepClock()
  let published = 0
  const agg = createNodeAggregate({
    links: { on: () => true, view: () => ({ devices: [], problems: [] }), link: () => null, onChange: () => () => {} },
    cfg,
    log: () => {},
    onChange: () => published++,
    store: createDeviceStore({ dir: mkdtempSync(join(tmpdir(), 'agg-status-')) }),
    clock: c.clock,
    hostName: 'laptop',
    ownStatus: () => new Promise(resolve => (answer = resolve)),
    statusMs: 300,
  })
  agg.close()
  answer(status('laptop'))
  await settle()
  expect([published, c.live()]).toEqual([0, 0])
})

test('without ownStatus: no timer', async () => {
  const c = stepClock()
  const agg = createNodeAggregate({
    links: { on: () => true, view: () => ({ devices: [], problems: [] }), link: () => null, onChange: () => () => {} },
    cfg,
    log: () => {},
    onChange: () => {},
    store: createDeviceStore({ dir: mkdtempSync(join(tmpdir(), 'agg-status-')) }),
    clock: c.clock,
    hostName: 'laptop',
  })
  expect(c.live()).toBe(0)
  agg.close()
})
