// A start sent to a node makes the node current for its profile first (#584, docs/design/nodes 9.2,
// 8.1 to 8.3, 12): the placer (services/nodes/placer.ts) over the real bundle sync
// (services/nodes/bundle-sync.ts), each node a fake door in this process and a clock of the test's
// own. A node that is behind gets the blobs it lacks and the commit before the start; one that is
// current is asked once and sent nothing; the card says "syncing" meanwhile; a sync that does not end
// well turns the start to the next device as `bundle` (a profile the node lacks as `profile`); two
// starts for one device and profile share one sync; a start that stays here syncs nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueueEntry } from '../../src/adapters/node-queue.ts'
import type { NodeStatus } from '../../src/core/nodes.ts'
import type { Profile } from '../../src/core/profiles.ts'
import type { Config } from '../../src/core/types.ts'
import type { LaunchRequest } from '../../src/services/launch/request.ts'
import { type Launch, newLaunch } from '../../src/services/launch/run.ts'
import { createBundleSync, type SyncReport } from '../../src/services/nodes/bundle-sync.ts'
import { createPlacer } from '../../src/services/nodes/placer.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = 1_800_000_000_000
const ADDRESS = 'https://example.test/acme/atlas.git'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A clock that stands still; its timers fire only when the test moves it. */
function testClock() {
  let now = NOW
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(next, { at: now + ms, fn, every: null })
      return next++
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    setInterval: (fn: () => void, ms: number) => {
      timers.set(next, { at: now + ms, fn, every: ms })
      return next++
    },
    clearInterval: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          if (t.every) t.at = now + t.every
          else timers.delete(id)
          t.fn()
        }
    },
  }
}

function status(id: string, awake = 0, at = NOW, profiles = ['default']): NodeStatus {
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
    profiles: profiles.map(p => ({ id: p, loggedIn: true, bundle: null })),
    agents: ['claude'],
    at,
  }
}

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

/**
 * A node's door as the bundle and a start see it: the bundle it has per profile, the blobs it was
 * sent, the starts it took. `hold` keeps the bundle's first question waiting until released;
 * `commit` answers a commit instead of taking it; `profiles` are the ones it has.
 */
function door(id: string, o: { profiles?: string[]; commit?: () => Response } = {}) {
  const profiles = new Set(o.profiles ?? ['default'])
  const has = new Map<string, { seq: number; hash: string; files: Record<string, string> }>()
  const blobs = new Set<string>()
  const requests: string[] = []
  const starts: Record<string, unknown>[] = []
  let held: Promise<void> | null = null
  let release = () => {}
  const self = {
    id,
    /** The node gone: its link down, a request finds nothing to answer it. */
    down: false,
    requests,
    starts,
    hold() {
      held = new Promise<void>(r => {
        release = r
      })
    },
    release: () => release(),
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const method = init.method ?? 'GET'
      requests.push(`${method} ${path}`)
      if (method === 'POST' && path === '/api/node/launch') {
        starts.push(JSON.parse(String(init.body)))
        return json(202, { ok: true })
      }
      const m = /^\/api\/node\/bundle\/([^/]+)(\/blob\/([0-9a-f]{64})|\/commit)?$/.exec(path)
      if (!m) return json(404, { error: 'route' })
      const profile = decodeURIComponent(m[1] ?? '')
      if (!profiles.has(profile)) return json(404, { error: 'profile' })
      if (!m[2]) {
        if (held) await held
        if (self.down) throw new TypeError('fetch failed')
        const h = has.get(profile)
        return json(200, h ? { seq: h.seq, hash: h.hash, files: h.files } : { seq: 0, hash: '', files: {} })
      }
      if (m[3]) {
        blobs.add(m[3])
        return json(200, { ok: true })
      }
      if (o.commit) return o.commit()
      const body = JSON.parse(String(init.body)) as {
        seq: number
        hash: string
        manifest: { files: { path: string; sha256: string }[] }
      }
      const missing = body.manifest.files.filter(f => !blobs.has(f.sha256)).map(f => f.sha256)
      if (missing.length) return json(409, { error: 'missing-blob', missing })
      const files = Object.fromEntries(body.manifest.files.map(f => [f.path, f.sha256]))
      has.set(profile, { seq: body.seq, hash: body.hash, files })
      return json(200, { ok: true, applied: Object.keys(files), kept: [], backup: null })
    },
  }
  return self
}
type Door = ReturnType<typeof door>

/**
 * A master with these nodes (each with a door) and this computer, the placer over the real bundle
 * sync; the profile `default` is a folder with a skill and a CLAUDE.md.
 */
function master(o: {
  nodes: Door[]
  /** This computer's sessions awake, against its maxSessions of 1. */
  localAwake?: number
  whenFull?: 'local' | 'wait'
  lanes?: string[] | 'all'
  sync?: boolean
  /** Each node's maxSessions; 3 when not given. */
  nodeMax?: number
  /** Each node's profiles as its status lists them, and the master's ids mapped to them (`profiles`). */
  nodeProfiles?: string[]
  profileMap?: Record<string, string>
}) {
  isolatedHome()
  const dir = mkdtempSync(join(tmpdir(), 'placer-sync-'))
  scratch.push(dir)
  const profileDir = join(dir, 'profile')
  mkdirSync(join(profileDir, 'skills', 'a'), { recursive: true })
  writeFileSync(join(profileDir, 'skills', 'a', 'SKILL.md'), 'A1')
  writeFileSync(join(profileDir, 'CLAUDE.md'), 'rules')
  const checkout = join(dir, 'atlas')
  mkdirSync(checkout)
  const clock = testClock()
  const devices: Record<string, unknown> = {
    local: { maxSessions: 1, minFreeMemMb: 0, maxLoad: 100 },
  }
  for (const [i, n] of o.nodes.entries())
    devices[n.id] = {
      link: { kind: 'direct', url: `http://127.0.0.1:${i + 1}` },
      maxSessions: o.nodeMax ?? 3,
      minFreeMemMb: 0,
      maxLoad: 100,
      ...(o.profileMap && { profiles: o.profileMap }),
    }
  const cfg = {
    language: 'en',
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue' }],
    models: [],
    nodes: {
      id: 'laptop',
      order: [...o.nodes.map(n => n.id), 'local'],
      whenFull: o.whenFull ?? 'local',
      lanes: o.lanes ?? 'all',
      devices,
    },
  } as unknown as Config
  const byId = new Map(o.nodes.map(n => [n.id, n]))
  const link = (id: string) => {
    const n = byId.get(id)
    if (!n) return null
    return {
      view: () => ({ status: status(id, 0, clock.now(), o.nodeProfiles) }),
      state: () => ({ state: n.down ? 'offline' : 'online' }),
      status: async () => status(id, 0, clock.now(), o.nodeProfiles),
      fetch: (path: string, init?: RequestInit) => n.fetch(path, init),
    }
  }
  const links = { link: (id: string) => link(id) as never, onChange: () => () => {} }
  const record = new Map<string, unknown>()
  const real = createBundleSync({
    cfg,
    links,
    profiles: () => [{ id: 'default', title: 'Default', dir: profileDir, color: '', hidden: false } as Profile],
    store: {
      bundle: (id: string) => (record.get(id) as never) ?? null,
      setBundle: (id: string, rec: unknown) => void record.set(id, rec),
    } as never,
    log: () => {},
    home: join(dir, 'home'),
    hostName: 'laptop',
    // The computer's clock: the test's moves the placer's time, never a sync's own deadline.
  })
  const syncs: string[] = []
  const bundle = {
    syncIfBehind: (device: string, profile?: string): Promise<SyncReport> => {
      syncs.push(`${device}/${profile}`)
      return real.syncIfBehind(device, profile)
    },
  }
  const ran: Launch[] = []
  const queued = new Map<string, QueueEntry>()
  const logs: string[] = []
  const placer = createPlacer({
    cfg,
    links,
    remote: () => null,
    launches: {
      runLocal: (l: Launch) => void ran.push(l),
      adopt: () => {},
      changed: () => {},
    } as never,
    items: () => [],
    ownStatus: async () => status('laptop', o.localAwake ?? 0),
    log: text => void logs.push(text),
    ...(o.sync !== false && { bundle }),
    queue: {
      read: () => [],
      put: (e: QueueEntry) => {
        queued.set(e.id, e)
        return true
      },
      remove: (id: string) => void queued.delete(id),
    },
    clock,
    hostName: 'laptop',
    commit: async () => 'c1',
    git: {
      checkout: async () => ({
        root: checkout,
        remote: { name: 'origin', url: ADDRESS, address: 'example.test/acme/atlas' },
        clean: true,
        headPushed: true,
      }),
      info: async () => ({ root: checkout, branch: 'main' }),
      pushed: async () => true,
    } as never,
    exists: () => false,
  })
  const start = (name: string, byHand = true): Launch => {
    const request = {
      name,
      label: '',
      cwd: checkout,
      category: 'atlas',
      workspaceId: 'wA',
      workspaceLabel: 'atlas',
      newWorkspace: false,
      message: '',
      worktree: null,
      profile: 'default',
      profileDir,
      configDir: null,
      parent: null,
      profileArgs: [],
      profileCommand: null,
      agent: 'claude',
      model: null,
    } as LaunchRequest
    const l = newLaunch(request, [])
    placer.take(l, byHand)
    return l
  }
  return {
    placer,
    start,
    ran,
    queued,
    logs,
    syncs,
    clock,
    close: () => {
      placer.close()
      real.close()
    },
  }
}

/** Waits (real time, the work is promises) until `ok` holds. */
async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('never came')
    await Bun.sleep(5)
  }
}

const settledOf = (l: Launch) => () => l.state === 'done' || l.state === 'queued' || l.state === 'failed'
const bundleCalls = (d: Door) => d.requests.filter(r => r.includes('/api/node/bundle/'))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('a start on a node syncs the profile first (#584)', () => {
  test('a node that is behind gets the blobs and the commit, then the start; the card says syncing meanwhile', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one] })
    one.hold()
    const l = m.start('atlas 1')
    await until(() => one.requests.length === 1)
    // Waiting on the sync: on its way to server-1, the card's step is syncing (12).
    expect([l.state, l.step, l.place?.device]).toEqual(['starting', 'syncing', 'server-1'])
    expect(one.starts).toEqual([])
    one.release()
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(m.syncs).toEqual(['server-1/default'])
    // The blobs went in whatever order; the question first, the commit and the start last.
    expect(one.requests[0]).toBe('GET /api/node/bundle/default')
    expect(one.requests.slice(-2)).toEqual(['POST /api/node/bundle/default/commit', 'POST /api/node/launch'])
    expect(one.requests.filter(r => r.startsWith('PUT')).sort()).toEqual(
      [sha('A1'), sha('rules')].map(s => `PUT /api/node/bundle/default/blob/${s}`).sort(),
    )
    m.close()
  }, 15_000)

  test('a node already current is asked once and sent no blob before the start', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one] })
    const a = m.start('atlas 1')
    await until(settledOf(a))
    one.requests.length = 0
    const b = m.start('atlas 2')
    await until(settledOf(b))
    expect(b.state).toBe('done')
    expect(one.requests).toEqual(['GET /api/node/bundle/default', 'POST /api/node/launch'])
    m.close()
  }, 15_000)

  test('a sync that does not end well turns the start to the next device as bundle, and it starts there', async () => {
    const one = door('server-1', { commit: () => json(409, { error: 'settings-parse', file: 'settings.json' }) })
    const two = door('server-2')
    const m = master({ nodes: [one, two] })
    const l = m.start('atlas 1')
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(l.place?.turned).toEqual([{ device: 'server-1', error: 'bundle' }])
    expect(l.place?.device).toBe('server-2')
    expect(one.starts).toEqual([])
    expect(two.starts.length).toBe(1)
    expect(two.requests.at(-1)).toBe('POST /api/node/launch')
    // The reason is data on the card; the log names what the sync said.
    expect(m.logs.some(x => x.includes('not synced to server-1: node (settings-parse: settings.json)'))).toBe(true)
    m.close()
  }, 15_000)

  test('a profile the node does not have is the turn profile, not a new one', async () => {
    const one = door('server-1', { profiles: ['work'] })
    const m = master({ nodes: [one] })
    const l = m.start('atlas 1')
    await until(() => m.ran.length === 1)
    expect(l.place?.turned).toEqual([{ device: 'server-1', error: 'profile' }])
    // Every device but this computer turned it away: a start by hand comes here (whenFull local).
    expect(l.state).toBe('starting')
    expect(m.ran).toEqual([l])
    expect(one.starts).toEqual([])
    m.close()
  }, 15_000)

  test('turned away by its only node with this computer full: an agent’s start waits, a person’s comes here by whenFull', async () => {
    const fail = () => json(500, { error: 'server' })
    const agent = master({ nodes: [door('server-1', { commit: fail })], localAwake: 1, whenFull: 'local' })
    const a = agent.start('atlas 1', false)
    await until(settledOf(a))
    expect(a.state).toBe('queued')
    expect(a.place?.turned).toEqual([{ device: 'server-1', error: 'bundle' }])
    expect(agent.ran).toEqual([])
    expect([...agent.queued.keys()]).toEqual([a.id])
    agent.close()

    const person = master({ nodes: [door('server-1', { commit: fail })], localAwake: 1, whenFull: 'local' })
    const p = person.start('atlas 2', true)
    await until(() => person.ran.length === 1)
    expect(p.place?.turned).toEqual([{ device: 'server-1', error: 'bundle' }])
    person.close()

    const waits = master({ nodes: [door('server-1', { commit: fail })], localAwake: 1, whenFull: 'wait' })
    const w = waits.start('atlas 3', true)
    await until(settledOf(w))
    expect(w.state).toBe('queued')
    expect(waits.ran).toEqual([])
    waits.close()
  }, 15_000)

  test('two starts for one device and profile at once share one sync', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one] })
    one.hold()
    const a = m.start('atlas 1')
    const b = m.start('atlas 2')
    await until(() => a.step === 'syncing' && b.step === 'syncing')
    expect(m.syncs).toEqual(['server-1/default', 'server-1/default'])
    one.release()
    await until(() => settledOf(a)() && settledOf(b)())
    expect([a.state, b.state]).toEqual(['done', 'done'])
    // One question, one commit, two starts.
    expect(bundleCalls(one).filter(r => r.startsWith('GET')).length).toBe(1)
    expect(bundleCalls(one).filter(r => r.endsWith('/commit')).length).toBe(1)
    expect(one.starts.length).toBe(2)
    m.close()
  }, 15_000)

  test('a start still syncing counts against its node however long the sync takes', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one], nodeMax: 1, localAwake: 1, whenFull: 'wait' })
    one.hold()
    const a = m.start('atlas 1')
    await until(() => a.step === 'syncing')
    // Longer than a reservation lives (180 s): the node still has no room for a second start.
    m.clock.advance(200_000)
    const b = m.start('atlas 2', false)
    await until(settledOf(b))
    expect(b.state).toBe('queued')
    expect(b.place?.wait).toEqual({ device: 'server-1', kind: 'sessions', busy: 1, max: 1 })
    one.release()
    await until(settledOf(a))
    expect(a.state).toBe('done')
    expect(one.starts.map(s => s.name)).toEqual(['atlas 1'])
    m.close()
  }, 15_000)

  test('the profile map: the node is synced and started on under its own id, the master’s asked for', async () => {
    const one = door('server-1', { profiles: ['main'] })
    const m = master({ nodes: [one], nodeProfiles: ['main'], profileMap: { default: 'main' } })
    const l = m.start('atlas 1')
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(m.syncs).toEqual(['server-1/default'])
    expect(one.requests[0]).toBe('GET /api/node/bundle/main')
    expect(one.requests.slice(-2)).toEqual(['POST /api/node/bundle/main/commit', 'POST /api/node/launch'])
    expect(one.starts.map(s => s.profile)).toEqual(['main'])
    m.close()
  }, 15_000)

  test('a start turned away by a sync that failed goes to that node again once a status of it came after', async () => {
    let fails = 1
    const one = door('server-1', {
      commit: () => {
        if (fails-- > 0) return json(500, { error: 'server' })
        return json(200, { ok: true, applied: [], kept: [], backup: null })
      },
    })
    const m = master({ nodes: [one], localAwake: 1, whenFull: 'wait' })
    const l = m.start('atlas 1', false)
    await until(() => l.state === 'queued')
    expect(l.place?.turned).toEqual([{ device: 'server-1', error: 'bundle' }])
    // Not on its way to server-1 any more: the card says the board chooses again.
    expect([l.step, l.place?.device]).toEqual(['placing', undefined])
    // The queue's tries (every 15 s): a status of server-1 newer than the turn, then the start goes.
    for (let i = 0; i < 4 && l.state !== 'done'; i++) {
      m.clock.advance(15_000)
      await Bun.sleep(30)
    }
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(one.starts.map(s => s.name)).toEqual(['atlas 1'])
    m.close()
  }, 15_000)

  test('a link that drops during the sync puts the start back in the queue, as a lost answer, not a turn', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one] })
    one.hold()
    const l = m.start('atlas 1')
    await until(() => l.step === 'syncing')
    one.down = true
    one.release()
    await until(settledOf(l))
    expect(l.state).toBe('queued')
    expect(l.place?.wait).toEqual({ device: 'server-1', kind: 'offline' })
    expect(l.place?.turned).toBeUndefined()
    expect([...m.queued.keys()]).toEqual([l.id])
    expect(one.starts).toEqual([])
    m.close()
  }, 15_000)

  test('a start cancelled while it syncs goes nowhere', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one] })
    one.hold()
    const l = m.start('atlas 1')
    await until(() => l.step === 'syncing')
    m.placer.cancel(l.id)
    one.release()
    await until(() => one.requests.includes('POST /api/node/bundle/default/commit'))
    await Bun.sleep(50)
    expect(one.starts).toEqual([])
    expect(m.ran).toEqual([])
    expect([...m.queued.keys()]).toEqual([])
    m.close()
  }, 15_000)

  test('a start sent after a long sync counts against its node from then, as one just decided', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one], nodeMax: 1, localAwake: 1, whenFull: 'wait' })
    one.hold()
    const a = m.start('atlas 1')
    await until(() => a.step === 'syncing')
    // No decision meanwhile: nothing renews its reservation until the sync ends.
    m.clock.advance(170_000)
    one.release()
    await until(settledOf(a))
    expect(a.state).toBe('done')
    // 190 s after the decision, 20 s after the start went: the node has no room for a second one yet.
    m.clock.advance(20_000)
    const b = m.start('atlas 2', false)
    await until(settledOf(b))
    expect(b.state).toBe('queued')
    expect(b.place?.wait).toEqual({ device: 'server-1', kind: 'sessions', busy: 1, max: 1 })
    m.close()
  }, 15_000)

  test('a start that stays on this computer makes no sync and no call to a node', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one], lanes: [] })
    const l = m.start('atlas 1')
    await until(() => m.ran.length === 1)
    expect(l.place?.home).toEqual({ kind: 'lane' })
    expect(m.syncs).toEqual([])
    expect(one.requests).toEqual([])
    m.close()
  }, 15_000)
})
