// The placer's `next` (#510): the device a plain start would go to now, for the quiet mark in
// Settings, Devices. The same rules as a start: the first device in the order with room, this
// computer when every device is full and `whenFull` is local, none when it would wait, and this
// computer when no lane may leave. Nothing reserved: asking twice answers the same.
import { describe, expect, test } from 'bun:test'
import type { NodeStatus } from '../../src/core/nodes.ts'
import type { Config } from '../../src/core/types.ts'
import { createPlacer } from '../../src/services/nodes/placer.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = 1_800_000_000_000

function status(id: string, awake: number): NodeStatus {
  return {
    api: 1,
    id,
    version: 'v',
    commit: 'c1',
    platform: 'linux',
    arch: 'x64',
    cpus: 4,
    memTotalMb: 16_000,
    memAvailableMb: 12_000,
    load: null,
    sessions: { awake, working: 0, asleep: 0 },
    launches: 0,
    workRootFreeMb: null,
    profiles: [{ id: 'default', loggedIn: true, bundle: null }],
    agents: ['claude'],
    at: NOW,
  }
}

function placer(nodes: Record<string, unknown>, awake: Record<string, number>) {
  isolatedHome()
  const link = (id: string) => ({
    view: () => ({ status: status(id, awake[id] ?? 0) }),
    state: () => ({ state: 'online' }),
  })
  return createPlacer({
    cfg: { nodes } as unknown as Config,
    links: { link: id => link(id) as never, onChange: () => () => {} },
    remote: () => null,
    launches: { runLocal: () => {}, adopt: () => {}, changed: () => {} } as never,
    items: () => [],
    ownStatus: async () => status('laptop', awake.local ?? 0),
    log: () => {},
    clock: { now: () => NOW } as never,
    hostName: 'laptop',
    commit: async () => 'c1',
  })
}

const direct = (port: number) => ({ link: { kind: 'direct', url: `http://127.0.0.1:${port}` } })
const two = (more: Record<string, unknown> = {}) => ({
  id: 'laptop',
  order: ['server-1', 'server-2', 'local'],
  lanes: 'all',
  devices: {
    'server-1': { ...direct(1), maxSessions: 2, minFreeMemMb: 0, maxLoad: 9 },
    'server-2': { ...direct(2), maxSessions: 2, minFreeMemMb: 0, maxLoad: 9 },
    local: { maxSessions: 1, minFreeMemMb: 0, maxLoad: 9 },
  },
  ...more,
})

describe('the placer’s next (#510)', () => {
  test('the first device in the order with room; asking again reserves nothing', async () => {
    const p = placer(two(), { 'server-1': 1 })
    expect(await p.next('atlas', 'default')).toBe('server-1')
    expect(await p.next('atlas', 'default')).toBe('server-1')
    p.close()
  })

  test('a full device is passed over; all full: this computer, or none with whenFull wait', async () => {
    const full = { 'server-1': 2, 'server-2': 1 }
    expect(await placer(two(), full).next('atlas', 'default')).toBe('server-2')
    const all = { 'server-1': 2, 'server-2': 2, local: 1 }
    expect(await placer(two(), all).next('atlas', 'default')).toBe('local')
    expect(await placer(two({ whenFull: 'wait' }), all).next('atlas', 'default')).toBeNull()
  })

  test('no lane may leave: this computer', async () => {
    expect(await placer(two({ lanes: [] }), {}).next('', 'default')).toBe('local')
  })

  test('nodes off: none', async () => {
    const p = placer(two(), {})
    p.close()
    expect(await p.next('atlas', 'default')).toBeNull()
  })
})
