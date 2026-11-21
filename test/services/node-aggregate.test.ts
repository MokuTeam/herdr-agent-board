// The master's devices in its payload (#500, services/nodes/aggregate.ts), against stand-in links
// and a clock of the test's own: each device's items, launches and schedule entries with its
// prefix and device, the devices' row with what config.json sets, the offline copy written once
// a while and read when a link has brought nothing, and the node's fsToken nowhere.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import type { DeviceView, LinkStatus, NodeStatus } from '../../src/core/nodes.ts'
import type { Config } from '../../src/core/types.ts'
import { createNodeAggregate, SNAPSHOT_MS } from '../../src/services/nodes/aggregate.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import type { NodeLinks } from '../../src/services/nodes/links.ts'
import type { Clock } from '../../src/services/tunnel.ts'

const CANARY = 'fsTokenCanary-7b1d9c'

/** A node's payload as its board sends it: its own fsToken, profiles and setup among it. */
const payload = (id: string, keys: string[]): Record<string, unknown> => ({
  version: '1',
  stale: false,
  fsToken: CANARY,
  profiles: [{ id: 'default', dir: `/home/${id}/.claude` }],
  setup: { ok: true },
  limits: null,
  items: keys.map(key => ({
    key,
    session: null,
    pane: 'p1',
    workspace: null,
    cwd: '/w',
    status: 'idle',
    name: `${id} ${key}`,
    autoName: '',
    category: 'atlas',
    categorySet: true,
    column: 'idle',
    attention: '',
  })),
  launches: [],
  categories: [],
  swatches: [],
  columns: [],
  schedules: [{ id: 'a1b2c3', key: keys[0], text: 'later', next: 9 }],
  scheduleLog: [],
})

/** A clock whose timers run when the test says. */
function manualClock(): Clock & { run(): void; pending(): number } {
  let t = 1795210000000
  const timers = new Map<number, () => void>()
  let n = 0
  return {
    now: () => t,
    setTimeout(fn) {
      n += 1
      timers.set(n, fn)
      return n
    },
    clearTimeout: h => void timers.delete(h as number),
    setInterval: () => 0,
    clearInterval: () => {},
    run() {
      t += SNAPSHOT_MS
      const fns = [...timers.values()]
      timers.clear()
      for (const fn of fns) fn()
    },
    pending: () => timers.size,
  }
}

/** A link stand-in: its payload set by the test, which says when it changed. */
/** A server's status before its owner logged in: no memory figure, no load, the profile not logged in. */
const freshServer = (id: string): NodeStatus => ({
  api: 1,
  id,
  version: '0.1.0',
  commit: 'abc',
  platform: 'linux',
  arch: 'x64',
  cpus: 4,
  memTotalMb: 8000,
  memAvailableMb: null,
  load: null,
  sessions: { awake: 0, working: 0, asleep: 0 },
  launches: 0,
  workRootFreeMb: null,
  profiles: [{ id: 'default', loggedIn: false, bundle: null }],
  agents: ['claude'],
  at: 1,
})

function fakeLink(id: string, state: LinkStatus['state'] = 'online', status: NodeStatus | null = null) {
  let raw: unknown = null
  let at: number | null = null
  const view = (): DeviceView => ({
    id,
    title: id.toUpperCase(),
    kind: 'direct',
    link: {
      state,
      since: 1,
      heardAt: at,
      detail: 'ssh: Permission denied (publickey) for agent-board-link@203.0.113.10',
    },
    status,
    sameCommit: null,
    payloadAt: at,
  })
  return {
    id,
    payload: () => raw,
    view,
    set(p: unknown, when: number) {
      raw = p
      at = when
    },
  }
}

function fakeLinks(cfg: Config, links: ReturnType<typeof fakeLink>[]) {
  const fns = new Set<(id: string) => void>()
  const api: Pick<NodeLinks, 'on' | 'view' | 'link' | 'onChange'> = {
    on: () => !!cfg.nodes,
    view: () => ({
      devices: [
        ...links.map(l => l.view()),
        { id: 'local', title: 'local', kind: null, link: null, status: null, sameCommit: null, payloadAt: null },
      ],
      problems: [],
    }),
    link: id => (links.find(l => l.id === id) as unknown as Link | undefined) ?? null,
    onChange(fn) {
      fns.add(fn)
      return () => fns.delete(fn)
    },
  }
  return {
    api,
    changed: (id: string) => {
      for (const fn of fns) fn(id)
    },
  }
}

const config = (): Config =>
  ({
    nodes: {
      id: 'laptop',
      devices: {
        'server-1': {
          link: { kind: 'direct', url: 'http://127.0.0.1:9' },
          maxSessions: 4,
          minFreeMemMb: 1200,
          maxLoad: 0.9,
        },
        'server-2': { link: { kind: 'direct', url: 'http://127.0.0.1:8' }, paused: true, drain: true },
        local: { maxSessions: 20, minFreeMemMb: 4800 },
      },
    },
  }) as unknown as Config

describe('the aggregate', () => {
  test('items of two nodes, each prefixed with its device; their launches and schedules; the devices row', () => {
    const cfg = config()
    const one = fakeLink('server-1')
    const two = fakeLink('server-2', 'refused', freshServer('server-2'))
    const { api, changed } = fakeLinks(cfg, [one, two])
    const store = createDeviceStore({ dir: mkdtempSync(join(tmpdir(), 'agg-')) })
    let published = 0
    const agg = createNodeAggregate({
      links: api,
      cfg,
      log: () => {},
      onChange: () => published++,
      store,
      clock: manualClock(),
      hostName: 'laptop',
    })
    one.set(payload('server-1', ['pane-1', 'abc']), 100)
    two.set(payload('server-2', ['pane-1']), 200)
    changed('server-1')
    changed('server-2')
    expect(published).toBe(2)
    const part = agg.part()
    expect(part?.items.map(i => [i.key, i.device])).toEqual([
      ['@server-1:pane-1', 'server-1'],
      ['@server-1:abc', 'server-1'],
      ['@server-2:pane-1', 'server-2'],
    ])
    expect(part?.schedules.map(e => [e.id, e.key, e.device])).toEqual([
      ['@server-1:a1b2c3', '@server-1:pane-1', 'server-1'],
      ['@server-2:a1b2c3', '@server-2:pane-1', 'server-2'],
    ])
    expect(
      part?.devices.map(d => [
        d.id,
        d.link?.state ?? null,
        d.payloadAt,
        d.paused,
        d.drain,
        d.maxSessions,
        d.minFreeMemMb,
        d.maxLoad,
      ]),
    ).toEqual([
      ['server-1', 'online', 100, false, false, 4, 1200, 0.9],
      ['server-2', 'refused', 200, true, true, null, null, null],
      ['local', null, null, false, false, 20, 4800, null],
    ])
    // A server whose owner has not logged in yet shows as it is.
    expect(part?.devices[1]?.status).toEqual(freshServer('server-2'))
    // What ssh said stays on this computer; nothing of the node's payload but its cards.
    const text = JSON.stringify(part)
    for (const secret of [CANARY, 'Permission denied', '/home/server-1/.claude']) expect(text).not.toContain(secret)
    expect(agg.find('@server-2:pane-1')?.name).toBe('server-2 pane-1')
    expect([agg.find('pane-1'), agg.find('@server-9:pane-1'), agg.find('@server-1:none')]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    agg.close()
  })

  test('the offline copy: written once a while after a payload, 0600, without the fsToken; read when the link has none', () => {
    const cfg = config()
    const dir = mkdtempSync(join(tmpdir(), 'agg-'))
    const store = createDeviceStore({ dir })
    const clock = manualClock()
    const one = fakeLink('server-1')
    const first = fakeLinks(cfg, [one])
    const agg = createNodeAggregate({
      links: first.api,
      cfg,
      log: () => {},
      onChange: () => {},
      store,
      clock,
      hostName: 'laptop',
    })
    one.set(payload('server-1', ['pane-1']), 100)
    first.changed('server-1')
    one.set(payload('server-1', ['pane-1', 'pane-2']), 150)
    first.changed('server-1')
    // One write for both, when its time comes.
    expect(clock.pending()).toBe(1)
    const file = join(dir, 'server-1', 'snapshot.json')
    expect(() => statSync(file)).toThrow()
    clock.run()
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(CANARY)
    expect(JSON.parse(text)).toMatchObject({ at: 150, part: { items: [{ key: 'pane-1' }, { key: 'pane-2' }] } })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    agg.close()

    // A board started again: the link has heard nothing yet.
    const fresh = fakeLink('server-1', 'connecting')
    const again = fakeLinks(cfg, [fresh])
    const after = createNodeAggregate({
      links: again.api,
      cfg,
      log: () => {},
      onChange: () => {},
      store,
      clock,
      hostName: 'laptop',
    })
    const part = after.part()
    expect(part?.items.map(i => [i.key, i.device])).toEqual([
      ['@server-1:pane-1', 'server-1'],
      ['@server-1:pane-2', 'server-1'],
    ])
    expect(part?.devices[0]).toMatchObject({ id: 'server-1', payloadAt: 150, link: { state: 'connecting' } })
    // The link brings a payload: it, not the copy.
    fresh.set(payload('server-1', ['pane-3']), 300)
    again.changed('server-1')
    expect(after.part()?.items.map(i => i.key)).toEqual(['@server-1:pane-3'])
    after.close()
  })

  test('an offline copy that is not one shows nothing; a device not in config.json shows nothing', () => {
    const cfg = config()
    const dir = mkdtempSync(join(tmpdir(), 'agg-'))
    const store = createDeviceStore({ dir })
    store.setSnapshot('server-1', { at: 5, part: { items: [{ key: 'x' }], fsToken: CANARY } })
    store.setSnapshot('server-7', { at: 5, part: { items: [{ key: 'x', name: 'stray' }] } })
    const { api } = fakeLinks(cfg, [fakeLink('server-1', 'connecting')])
    const agg = createNodeAggregate({
      links: api,
      cfg,
      log: () => {},
      onChange: () => {},
      store,
      clock: manualClock(),
      hostName: 'laptop',
    })
    expect(agg.part()?.items).toEqual([])
    expect(agg.find('@server-7:x')).toBeUndefined()
    agg.close()
  })

  test('nodes off: no part, nothing found', () => {
    const cfg = {} as Config
    const { api } = fakeLinks(cfg, [])
    const agg = createNodeAggregate({
      links: api,
      cfg,
      log: () => {},
      onChange: () => {},
      store: createDeviceStore({ dir: mkdtempSync(join(tmpdir(), 'agg-')) }),
      clock: manualClock(),
      hostName: 'laptop',
    })
    expect(agg.part()).toBeNull()
    expect(agg.find('@server-1:pane-1')).toBeUndefined()
    agg.close()
  })
})
