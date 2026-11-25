// The master's set of links (services/nodes/links.ts, #499): one per device of config.json's
// `nodes`, following it live, and one watch for all of them that sends every link to try again
// when the computer slept or its addresses changed. Without `nodes`: no link is made, no ssh can
// start, and no timer exists on the clock or in the process.
import { expect, test } from 'bun:test'
import type { DeviceConfig, LinkStatus } from '../../src/core/nodes.ts'
import type { Config } from '../../src/core/types.ts'
import type { Link, LinkTimes } from '../../src/services/nodes/link.ts'
import { createNodeLinks } from '../../src/services/nodes/links.ts'
import type { Clock } from '../../src/services/tunnel.ts'

/** A clock that counts the timers alive on it and runs them when told. */
function countingClock() {
  let now = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void; every: number }>()
  const add = (fn: () => void, ms: number, every: number): number => {
    timers.set(++seq, { at: now + ms, fn, every })
    return seq
  }
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: h => void timers.delete(h as number),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: h => void timers.delete(h as number),
  }
  return {
    clock,
    live: () => timers.size,
    /** Moves the clock without running anything (the computer asleep), then runs what is due once. */
    jump(ms: number): void {
      now += ms
      for (const t of [...timers.values()])
        if (t.at <= now) {
          t.at = now + t.every
          t.fn()
        }
    },
  }
}

interface Made {
  device: DeviceConfig
  times: LinkTimes
  closed: boolean
  again: string[]
}

/** A stand-in link that records what it was made with and asked. */
function recorder() {
  const made: Made[] = []
  const makeLink = (device: DeviceConfig, times: LinkTimes): Link => {
    const m: Made = { device, times, closed: false, again: [] }
    made.push(m)
    const state: LinkStatus = { state: 'connecting', since: 0, heardAt: null }
    return {
      id: device.id,
      fetch: async () => new Response(''),
      status: async () => null,
      state: () => state,
      payload: () => null,
      view: () => ({
        id: device.id,
        title: device.title,
        kind: device.link?.kind ?? null,
        link: state,
        status: null,
        sameCommit: null,
        payloadAt: null,
      }),
      onPayload: () => () => {},
      onState: () => () => {},
      onStatus: () => () => {},
      reconnect: (why, force) => void m.again.push(force ? `${why} (forced)` : why),
      killNow: () => {},
      close: async () => {
        m.closed = true
      },
    }
  }
  return { made, makeLink }
}

const settle = () => Bun.sleep(5)
const direct = (port: number) => ({ link: { kind: 'direct', url: `http://127.0.0.1:${port}` } })

test('without nodes: no link, no ssh, no timer on the clock or in the process', async () => {
  const c = countingClock()
  const r = recorder()
  // Every timer this process starts meanwhile is counted.
  const started: string[] = []
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval }
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    started.push(`timeout ${ms}`)
    return real.setTimeout(fn, ms)
  }) as typeof setTimeout
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    started.push(`interval ${ms}`)
    return real.setInterval(fn, ms)
  }) as typeof setInterval
  try {
    for (const nodes of [undefined, false, null, 'yes', []]) {
      const cfg = { nodes } as unknown as Config
      const links = createNodeLinks({ cfg, log: () => {}, makeLink: r.makeLink, clock: c.clock, network: () => 'net' })
      await settle()
      links.configChanged()
      await settle()
      expect([nodes, links.on(), links.view(), links.link('server-1'), links.retry('server-1')]).toEqual([
        nodes,
        false,
        { devices: [], problems: [] },
        null,
        false,
      ])
      await links.close()
    }
  } finally {
    globalThis.setTimeout = real.setTimeout
    globalThis.setInterval = real.setInterval
  }
  expect(r.made).toEqual([])
  expect(c.live()).toBe(0)
  expect(started).toEqual([])
})

test('the links follow config.json: a device added, its link changed, removed; nodes off ends them all', async () => {
  const c = countingClock()
  const r = recorder()
  const cfg = { nodes: { id: 'laptop', devices: { 'server-1': direct(1001) } } } as unknown as Config
  const links = createNodeLinks({ cfg, log: () => {}, makeLink: r.makeLink, clock: c.clock, network: () => 'net' })
  await settle()
  expect(r.made.map(m => m.device.id)).toEqual(['server-1'])
  // the watch: a tick and an address poll
  expect(c.live()).toBe(2)
  expect(links.view().devices.map(d => [d.id, d.kind])).toEqual([
    ['server-1', 'direct'],
    ['local', null],
  ])

  // A title changes: the same link. A second device: a link of its own.
  cfg.nodes = {
    id: 'laptop',
    order: ['server-2', 'server-1', 'local'],
    devices: { 'server-1': { ...direct(1001), title: 'One' }, 'server-2': direct(1002) },
  }
  links.configChanged()
  await settle()
  expect(r.made.map(m => [m.device.id, m.closed])).toEqual([
    ['server-1', false],
    ['server-2', false],
  ])
  expect(links.view().devices.map(d => [d.id, d.title])).toEqual([
    ['server-2', 'server-2'],
    ['server-1', 'One'],
    ['local', 'laptop'],
  ])
  expect(links.view().devices.map(d => [d.id, d.selfId])).toEqual([
    ['server-2', undefined],
    ['server-1', undefined],
    ['local', 'laptop'],
  ])

  // server-1's link changes: its link starts over. server-2 removed: its link ends.
  cfg.nodes = { id: 'laptop', devices: { 'server-1': direct(1003) } }
  links.configChanged()
  await settle()
  expect(r.made.map(m => [m.device.id, m.closed])).toEqual([
    ['server-1', true],
    ['server-2', true],
    ['server-1', false],
  ])

  // A device with a problem has no link and is named.
  cfg.nodes = { id: 'laptop', devices: { 'server-1': direct(1003), 'server-3': { link: { kind: 'ssh' } } } }
  links.configChanged()
  await settle()
  expect(r.made).toHaveLength(3)
  expect(links.view().problems.map(p => [p.device, p.key])).toEqual([
    ['server-3', 'link.host'],
    ['server-3', 'link.user'],
  ])

  // nodes off: every link ends, and the watch with them.
  cfg.nodes = undefined
  links.configChanged()
  await settle()
  expect(r.made.every(m => m.closed)).toBe(true)
  expect(c.live()).toBe(0)
  expect(links.on()).toBe(false)
  await links.close()
})

test('after a sleep, or when the addresses change, every link tries again at once', async () => {
  const c = countingClock()
  const r = recorder()
  let net = 'wifi 192.168.1.5'
  const cfg = {
    nodes: { id: 'laptop', devices: { 'server-1': direct(1001), 'server-2': direct(1002) } },
  } as unknown as Config
  const links = createNodeLinks({ cfg, log: () => {}, makeLink: r.makeLink, clock: c.clock, network: () => net })
  await settle()
  c.jump(5000)
  expect(r.made.flatMap(m => m.again)).toEqual([])
  c.jump(45_000)
  expect(r.made.map(m => m.again)).toEqual([
    ['45 s between two ticks (the computer slept)'],
    ['45 s between two ticks (the computer slept)'],
  ])
  net = 'ethernet 10.0.0.7'
  c.jump(5000)
  c.jump(5000)
  expect(r.made.map(m => m.again.at(-1))).toEqual([
    "this computer's addresses changed",
    "this computer's addresses changed",
  ])
  // a token stored: that one link, past a refusal's minute
  expect(links.retry('server-2')).toBe(true)
  expect(r.made.map(m => m.again.at(-1))).toEqual(["this computer's addresses changed", 'a token stored (forced)'])
  await links.close()
  expect(c.live()).toBe(0)
})

test('the waits are the knobs in a test and as written otherwise', async () => {
  const { linkTimes } = await import('../../src/services/nodes/links.ts')
  const saved = {
    dead: process.env.BOARD_NODE_DEAD_MS,
    status: process.env.BOARD_NODE_STATUS_MS,
    pace: process.env.BOARD_TEST_PACE,
  }
  try {
    delete process.env.BOARD_NODE_DEAD_MS
    delete process.env.BOARD_NODE_STATUS_MS
    delete process.env.BOARD_TEST_PACE
    expect(linkTimes()).toEqual({ deadMs: 90_000, statusMs: 30_000, pace: 1 })
    process.env.BOARD_NODE_DEAD_MS = '1500'
    process.env.BOARD_NODE_STATUS_MS = '300'
    process.env.BOARD_TEST_PACE = '0.02'
    expect(linkTimes()).toEqual({ deadMs: 1500, statusMs: 300, pace: 0.02 })
  } finally {
    for (const [k, v] of [
      ['BOARD_NODE_DEAD_MS', saved.dead],
      ['BOARD_NODE_STATUS_MS', saved.status],
      ['BOARD_TEST_PACE', saved.pace],
    ] as const)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
})

test('onChange: a payload or a state change of any link, and a link that goes, name its device (#500)', async () => {
  const c = countingClock()
  const fired = new Map<string, { payload: Set<() => void>; state: Set<() => void>; status: Set<() => void> }>()
  const makeLink = (device: DeviceConfig): Link => {
    const fns = { payload: new Set<() => void>(), state: new Set<() => void>(), status: new Set<() => void>() }
    fired.set(device.id, fns)
    const state: LinkStatus = { state: 'connecting', since: 0, heardAt: null }
    return {
      id: device.id,
      fetch: async () => new Response(''),
      status: async () => null,
      state: () => state,
      payload: () => null,
      view: () => ({
        id: device.id,
        title: device.title,
        kind: 'direct',
        link: state,
        status: null,
        sameCommit: null,
        payloadAt: null,
      }),
      onPayload: fn => {
        const f = () => fn({} as never)
        fns.payload.add(f)
        return () => fns.payload.delete(f)
      },
      onState: fn => {
        const f = () => fn(state)
        fns.state.add(f)
        return () => fns.state.delete(f)
      },
      onStatus: fn => {
        const f = () => fn({} as never)
        fns.status.add(f)
        return () => fns.status.delete(f)
      },
      reconnect: () => {},
      killNow: () => {},
      close: async () => {},
    }
  }
  const cfg = {
    nodes: { id: 'laptop', devices: { 'server-1': direct(1001), 'server-2': direct(1002) } },
  } as unknown as Config
  const links = createNodeLinks({ cfg, log: () => {}, makeLink, clock: c.clock, network: () => 'net' })
  await settle()
  const heard: string[] = []
  const off = links.onChange(id => heard.push(id))
  for (const f of fired.get('server-2')?.payload ?? []) f()
  for (const f of fired.get('server-1')?.state ?? []) f()
  for (const f of fired.get('server-1')?.status ?? []) f()
  expect(heard).toEqual(['server-2', 'server-1', 'server-1'])
  // server-2 leaves config.json: its link goes, said once, and what it held is let go.
  cfg.nodes = { id: 'laptop', devices: { 'server-1': direct(1001) } }
  links.configChanged()
  await settle()
  expect(heard).toEqual(['server-2', 'server-1', 'server-1', 'server-2'])
  expect([
    fired.get('server-2')?.payload.size,
    fired.get('server-2')?.state.size,
    fired.get('server-2')?.status.size,
  ]).toEqual([0, 0, 0])
  off()
  for (const f of fired.get('server-1')?.payload ?? []) f()
  expect(heard.length).toBe(4)
  await links.close()
})

test('renaming a device updates view() immediately, keeps its link open, and notifies onChange (#601)', async () => {
  const c = countingClock()
  const r = recorder()
  const cfg = { nodes: { id: 'laptop', devices: { 'server-1': direct(1001) } } } as unknown as Config
  const links = createNodeLinks({ cfg, log: () => {}, makeLink: r.makeLink, clock: c.clock, network: () => 'net' })
  await settle()
  const heard: string[] = []
  links.onChange(id => heard.push(id))

  cfg.nodes = { id: 'laptop', devices: { 'server-1': { ...direct(1001), title: 'Atlas Box' } } }
  // Even before configChanged() finishes syncNow(), view() reads the live title.
  expect(links.view().devices.map(d => [d.id, d.title])).toEqual([
    ['server-1', 'Atlas Box'],
    ['local', 'laptop'],
  ])
  links.configChanged()
  await settle()
  expect(r.made).toHaveLength(1)
  expect(r.made[0]?.closed).toBe(false)
  expect(heard).toEqual(['server-1'])
  await links.close()
})
