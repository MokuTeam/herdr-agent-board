// A start sent to a node makes the node current for its profile first (#584, docs/design/nodes 9.2,
// 8.1 to 8.3, 12): the placer (services/nodes/placer.ts) over the real bundle sync
// (services/nodes/bundle-sync.ts), each node a fake door in this process and a clock of the test's
// own. A node that is behind gets the blobs it lacks and the commit before the start; one that is
// current is asked once and sent nothing; the card says "syncing" meanwhile; a sync that does not end
// well turns the start to the next device as `bundle` (a profile the node lacks as `profile`); two
// starts for one device and profile share one sync; a start that stays here syncs nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeQueue, type NodeQueue, QUEUE_MAX, type QueueEntry } from '../../src/adapters/node-queue.ts'
import type { GitIdentity } from '../../src/core/git-access.ts'
import type { NodeStatus } from '../../src/core/nodes.ts'
import type { Profile } from '../../src/core/profiles.ts'
import type { Config } from '../../src/core/types.ts'
import type { LaunchRequest } from '../../src/services/launch/request.ts'
import { type Launch, newLaunch } from '../../src/services/launch/run.ts'
import { createBundleSync, type SyncReport } from '../../src/services/nodes/bundle-sync.ts'
import { createPlacer, SENT_TTL_MS, SYNC_TRIES } from '../../src/services/nodes/placer.ts'
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
function door(
  id: string,
  o: { profiles?: string[]; commit?: () => Response; launch?: (body: Record<string, unknown>) => Response } = {},
) {
  const profiles = new Set(o.profiles ?? ['default'])
  const has = new Map<string, { seq: number; hash: string; files: Record<string, string> }>()
  const blobs = new Set<string>()
  const requests: string[] = []
  const starts: Record<string, unknown>[] = []
  let held: Promise<void> | null = null
  let release = () => {}
  let launchHeld: Promise<void> | null = null
  let releaseLaunch = () => {}
  const self = {
    id,
    /** The node gone: its link down, a request finds nothing to answer it. */
    down: false,
    /** Override the link state reported to the placer (`connecting` / `offline` / `online`). */
    linkState: null as 'online' | 'connecting' | 'offline' | null,
    /** Its status says it keeps its own profiles (#802, `node.ownProfiles`). */
    ownStatus: false,
    requests,
    starts,
    hold() {
      held = new Promise<void>(r => {
        release = r
      })
    },
    release: () => release(),
    holdLaunch() {
      launchHeld = new Promise<void>(r => {
        releaseLaunch = r
      })
    },
    releaseLaunch: () => releaseLaunch(),
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const method = init.method ?? 'GET'
      requests.push(`${method} ${path}`)
      if (method === 'POST' && path === '/api/node/launch') {
        if (launchHeld) await launchHeld
        if (self.down) throw new TypeError('fetch failed')
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (o.launch) return o.launch(body)
        starts.push(body)
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
  /** This computer's sessions awake, against its maxSessions of 1; a function for a count that moves. */
  localAwake?: number | (() => number)
  /** What the queue's file held when the board started, and whether the board tells the placer its sessions. */
  restored?: QueueEntry[]
  awaitsBoard?: boolean
  whenFull?: 'local' | 'wait'
  lanes?: string[] | 'all'
  sync?: boolean
  /** Each node's maxSessions; 3 when not given. */
  nodeMax?: number
  /** Each node's profiles as its status lists them, and the master's ids mapped to them (`profiles`). */
  nodeProfiles?: string[]
  profileMap?: Record<string, string>
  /** git's author in a folder (adapters/git.ts checkoutIdentity); not asked when not given. */
  identity?: (dir: string) => Promise<GitIdentity | null>
  /** Remote payload override for testing already-shown recovery. */
  remote?: () => { items: unknown[]; launches: unknown[]; schedules: unknown[]; devices: { id: string }[] } | null
  /** Per-device config overrides (e.g. revoked, paused, drain). */
  deviceCfg?: Record<string, Record<string, unknown>>
  /** Optional custom NodeQueue implementation (e.g. real createNodeQueue or throwing put). */
  queue?: NodeQueue
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
      ...o.deviceCfg?.[n.id],
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
  const listeners: ((id: string) => void)[] = []
  const link = (id: string) => {
    const n = byId.get(id)
    if (!n) return null
    const said = (): NodeStatus => ({
      ...status(id, 0, clock.now(), o.nodeProfiles),
      ...(n.ownStatus && { ownProfiles: true as const }),
    })
    return {
      view: () => ({ status: n.linkState === 'connecting' ? null : said() }),
      state: () => ({ state: n.linkState ?? (n.down ? 'offline' : 'online') }),
      status: async () => (n.down || n.linkState ? null : said()),
      fetch: (path: string, init?: RequestInit) => n.fetch(path, init),
    }
  }
  const links = {
    link: (id: string) => link(id) as never,
    onChange: (fn: (id: string) => void) => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  }
  const notifyLink = (id: string) => {
    for (const fn of listeners) fn(id)
  }
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
  for (const e of o.restored ?? []) queued.set(e.id, e)
  const queuePuts: QueueEntry[] = []
  const logs: string[] = []
  const placer = createPlacer({
    cfg,
    links,
    remote: (o.remote as never) ?? (() => null),
    launches: {
      runLocal: (l: Launch) => void ran.push(l),
      adopt: () => {},
      changed: () => {},
    } as never,
    items: () => [],
    ownStatus: async () => status('laptop', typeof o.localAwake === 'function' ? o.localAwake() : (o.localAwake ?? 0)),
    log: text => void logs.push(text),
    ...(o.sync !== false && { bundle }),
    ...(o.awaitsBoard && { awaitsBoard: true }),
    queue: o.queue ?? {
      read: () => o.restored ?? [],
      put: (e: QueueEntry) => {
        queuePuts.push(e)
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
      ...(o.identity && { identity: o.identity }),
    } as never,
    exists: () => false,
  })
  const start = (name: string, byHand = true, pin?: Launch['pin']): Launch => {
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
    if (pin) l.pin = pin
    placer.take(l, byHand)
    return l
  }
  return {
    placer,
    start,
    checkout,
    ran,
    queued,
    queuePuts,
    logs,
    syncs,
    clock,
    notifyLink,
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

describe("the checkout's git identity goes with a start (#611)", () => {
  const AUTHOR = { name: 'Atlas Author', email: 'atlas@example.test' }

  test('a start sent to a node carries the author git gives in its checkout, none when it gives none; one that stays asks git nothing for it', async () => {
    const asked: string[] = []
    const identity = async (dir: string): Promise<GitIdentity | null> => {
      asked.push(dir)
      return AUTHOR
    }
    // Its lane may not leave: it starts here and git is not asked for an author.
    const stays = master({ nodes: [door('server-1')], lanes: [], identity })
    const here = stays.start('atlas 1')
    await until(() => stays.ran.length === 1)
    expect(here.place?.home).toEqual({ kind: 'lane' })
    expect(asked).toEqual([])
    stays.close()

    const one = door('server-1')
    const goes = master({ nodes: [one], identity })
    const l = goes.start('atlas 2')
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(asked).toEqual([goes.checkout])
    expect(one.starts.map(s => s.source)).toEqual([
      {
        kind: 'repo',
        url: ADDRESS,
        ref: 'main',
        subdir: '',
        worktree: null,
        identity: AUTHOR,
      },
    ])
    goes.close()

    // git gives no author there: the source has no identity, the node's own applies.
    const two = door('server-1')
    const none = master({ nodes: [two], identity: async () => null })
    const n = none.start('atlas 3')
    await until(settledOf(n))
    expect(n.state).toBe('done')
    expect(two.starts.map(s => s.source)).toEqual([
      { kind: 'repo', url: ADDRESS, ref: 'main', subdir: '', worktree: null },
    ])
    none.close()
  }, 15_000)
})

describe('the queue after the board starts again (#593)', () => {
  /** A start that waited for room on this computer when the board stopped, as queue.json keeps it. */
  const waited = (dir: string): QueueEntry =>
    ({
      id: 'a1b2c3d4',
      session: '11111111-2222-4333-8444-555555555555',
      master: 'laptop',
      at: NOW - 60_000,
      request: {
        name: 'atlas 1',
        label: '',
        cwd: dir,
        category: 'atlas',
        workspaceId: 'wA',
        workspaceLabel: 'atlas',
        newWorkspace: false,
        message: '',
        worktree: null,
        profile: 'default',
        profileDir: dir,
        configDir: null,
        parent: null,
        profileArgs: [],
        profileCommand: null,
        agent: 'claude',
        model: null,
      },
      task: {
        lane: 'atlas',
        profile: 'default',
        agent: 'claude',
        byHand: true,
        origin: 'local',
        portable: { ok: false, why: { kind: 'lane' } },
      },
      source: null,
      wait: { device: 'local', kind: 'sessions', busy: 1, max: 1 },
    }) as unknown as QueueEntry
  const awakeItem = [{ sleeping: false }] as never

  test('what waited is not tried before the board read herdr: this computer is not taken for empty', async () => {
    // Until the board has read herdr its own status counts no session awake.
    let awake = 0
    const m = master({
      nodes: [door('server-1')],
      lanes: [],
      whenFull: 'wait',
      localAwake: () => awake,
      restored: [waited(tmpdir())],
      awaitsBoard: true,
    })
    // Not at once, not on the queue's own tries: nothing is started here.
    await Bun.sleep(50)
    m.clock.advance(60_000)
    await Bun.sleep(50)
    expect(m.ran).toEqual([])
    // The board read herdr: one session is awake here, against a most of 1. It still waits.
    awake = 1
    m.placer.observe(awakeItem)
    await Bun.sleep(50)
    expect(m.ran).toEqual([])
    // That session went to sleep: now there is room, and the start goes.
    awake = 0
    m.placer.observe([])
    await until(() => m.ran.length === 1)
    expect(m.ran[0]?.id).toBe('a1b2c3d4')
    m.close()
  }, 15_000)

  test('a placer nothing observes tries its queue as it is made', async () => {
    const m = master({ nodes: [door('server-1')], lanes: [], whenFull: 'wait', restored: [waited(tmpdir())] })
    await until(() => m.ran.length === 1)
    m.close()
  }, 15_000)
})

describe('a start on its way to a node survives a master restart (#588)', () => {
  const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
    id: 'e1f2a3b4',
    session: randomUUID(),
    master: 'laptop',
    at: NOW - 10_000,
    request: {
      name: 'atlas 1',
      label: '',
      cwd: tmpdir(),
      category: 'atlas',
      workspaceId: 'wA',
      workspaceLabel: 'atlas',
      newWorkspace: false,
      message: '',
      worktree: null,
      profile: 'default',
      profileDir: tmpdir(),
      configDir: null,
      parent: null,
      profileArgs: [],
      profileCommand: null,
      agent: 'claude',
      model: null,
    },
    task: {
      lane: 'atlas',
      profile: 'default',
      agent: 'claude',
      byHand: true,
      origin: 'local',
      portable: { ok: true },
    },
    source: { kind: 'repo', url: ADDRESS, ref: 'main', subdir: '', worktree: null },
    ...over,
  })

  test('while syncing and while POST /api/node/launch awaits acknowledgement, the start is kept in the queue and removed on 202', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one] })
    one.hold()
    one.holdLaunch()
    const l = m.start('atlas 1')
    await until(() => l.step === 'syncing')
    expect(m.queued.get(l.id)?.syncing).toBe('server-1')
    expect(m.queued.get(l.id)?.sent).toBeUndefined()
    expect(m.queued.get(l.id)?.session).toBe(l.sessionGiven ?? '')
    one.release()
    await until(() => one.requests.includes('POST /api/node/launch'))
    expect(m.queued.get(l.id)?.sent).toBe('server-1')
    expect(m.queued.get(l.id)?.sentAt).toBe(NOW)
    expect(m.queued.get(l.id)?.syncing).toBeUndefined()
    one.releaseLaunch()
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('restart during syncing: waits while the node is connecting, then syncs and starts there with the same session id', async () => {
    const one = door('server-1')
    one.linkState = 'connecting'
    const two = door('server-2')
    const saved = entry({ syncing: 'server-1' })
    const m = master({ nodes: [one, two], restored: [saved], whenFull: 'local' })
    await Bun.sleep(50)
    // Connecting: waits on server-1 instead of dumping to server-2 or local.
    expect(one.starts).toEqual([])
    expect(two.starts).toEqual([])
    expect(m.ran).toEqual([])
    expect(m.queued.get(saved.id)?.syncing).toBe('server-1')
    one.linkState = null
    m.notifyLink('server-1')
    await until(() => one.starts.length === 1)
    expect(one.starts[0]?.id).toBe(saved.session)
    expect(two.starts).toEqual([])
    expect(m.ran).toEqual([])
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('restart during syncing when the node goes offline falls through to the next device', async () => {
    const one = door('server-1')
    one.down = true
    const two = door('server-2')
    const saved = entry({ syncing: 'server-1' })
    const m = master({ nodes: [one, two], restored: [saved] })
    await until(() => two.starts.length === 1)
    expect(two.starts[0]?.id).toBe(saved.session)
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('restart with sent: waits for that node even when another node and local have room, then retries POST /api/node/launch without re-syncing', async () => {
    const one = door('server-1')
    one.linkState = 'connecting'
    const two = door('server-2')
    const saved = entry({ sent: 'server-1' })
    const m = master({ nodes: [one, two], restored: [saved], whenFull: 'local' })
    await Bun.sleep(50)
    expect(one.starts).toEqual([])
    expect(two.starts).toEqual([])
    expect(m.ran).toEqual([])
    expect(m.queued.get(saved.id)?.sent).toBe('server-1')
    one.linkState = null
    m.notifyLink('server-1')
    await until(() => one.starts.length === 1)
    expect(one.starts[0]?.id).toBe(saved.session)
    // Retries POST /api/node/launch directly without running bundle sync again.
    expect(m.syncs).toEqual([])
    expect(two.starts).toEqual([])
    expect(m.ran).toEqual([])
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('restart with sent when the node already shows the session settles without sending again', async () => {
    const one = door('server-1')
    const saved = entry({ sent: 'server-1' })
    const m = master({
      nodes: [one],
      restored: [saved],
      remote: () => ({
        items: [{ device: 'server-1', key: `@server-1:${saved.session}`, session: saved.session }],
        launches: [],
        schedules: [],
        devices: [{ id: 'server-1' }],
      }),
    })
    await until(() => !m.queued.has(saved.id))
    expect(one.requests).toEqual([])
    expect(one.starts).toEqual([])
    m.close()
  }, 15_000)

  test('restart with sent when that node answers 409 full clears sent and places on the next device with the same id', async () => {
    const one = door('server-1', { launch: () => json(409, { error: 'full' }) })
    const two = door('server-2')
    const saved = entry({ sent: 'server-1' })
    const m = master({ nodes: [one, two], restored: [saved] })
    await until(() => two.starts.length === 1)
    expect(two.starts[0]?.id).toBe(saved.session)
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('restart with sent when that device was revoked places on the next device', async () => {
    const one = door('server-1')
    const two = door('server-2')
    const saved = entry({ sent: 'server-1' })
    const m = master({
      nodes: [one, two],
      restored: [saved],
      deviceCfg: { 'server-1': { revoked: true } },
    })
    await until(() => two.starts.length === 1)
    expect(one.starts).toEqual([])
    expect(two.starts[0]?.id).toBe(saved.session)
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('restart with sent when that device is paused or draining clears sent and places on the next device', async () => {
    for (const flag of ['paused', 'drain'] as const) {
      const one = door('server-1')
      const two = door('server-2')
      const saved = entry({ sent: 'server-1', sentAt: NOW - 10_000 })
      const m = master({
        nodes: [one, two],
        restored: [saved],
        deviceCfg: { 'server-1': { [flag]: true } },
      })
      await until(() => two.starts.length === 1)
      expect(one.starts).toEqual([])
      expect(one.requests).toEqual([])
      expect(two.starts[0]?.id).toBe(saved.session)
      expect(m.queued.size).toBe(0)
      m.close()
    }
  }, 15_000)

  test('sent pin expires after SENT_TTL_MS and falls back to decide(), checking nodeShows first', async () => {
    const one = door('server-1')
    one.down = true
    const two = door('server-2')
    const saved = entry({ sent: 'server-1', sentAt: NOW })
    const m = master({ nodes: [one, two], restored: [saved], whenFull: 'local' })
    await Bun.sleep(40)
    // Inside SENT_TTL_MS: stays pinned to server-1 even though server-2 and local have room.
    expect(two.starts).toEqual([])
    expect(m.ran).toEqual([])
    // Past SENT_TTL_MS: pin expires and decide() places it on server-2 with the same session id.
    m.clock.advance(SENT_TTL_MS)
    await until(() => two.starts.length === 1)
    expect(two.starts[0]?.id).toBe(saved.session)
    expect(m.queued.size).toBe(0)
    m.close()

    // Past SENT_TTL_MS when the node already shows the session: "there" check settles it first.
    const oneAgain = door('server-1')
    oneAgain.down = true
    const twoAgain = door('server-2')
    const shownSaved = entry({ id: 'expired-there', sent: 'server-1', sentAt: NOW - SENT_TTL_MS - 1000 })
    const m2 = master({
      nodes: [oneAgain, twoAgain],
      restored: [shownSaved],
      remote: () => ({
        items: [{ device: 'server-1', key: `@server-1:${shownSaved.session}`, session: shownSaved.session }],
        launches: [],
        schedules: [],
        devices: [{ id: 'server-1' }],
      }),
    })
    await until(() => !m2.queued.has(shownSaved.id))
    expect(twoAgain.starts).toEqual([])
    expect(oneAgain.starts).toEqual([])
    m2.close()
  }, 15_000)

  test('50 waiting starts in queue.json do not block a start that has room on a node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'placer-max-'))
    scratch.push(dir)
    const file = join(dir, 'queue.json')
    const realQueue = createNodeQueue({ file })
    for (let i = 1; i <= QUEUE_MAX; i++) {
      expect(
        realQueue.put(
          entry({
            id: `wait-${i}`,
            session: `5d0c6a1e-1111-4222-8333-${String(i).padStart(12, '0')}`,
            // Pinned to an offline node so restored waiting entries stay queued during the test.
            task: {
              lane: 'atlas',
              profile: 'default',
              agent: 'claude',
              byHand: false,
              origin: 'local',
              portable: { ok: true },
              pin: { device: 'server-2' },
            },
          }),
        ),
      ).toBe(true)
    }
    const one = door('server-1')
    const two = door('server-2')
    two.down = true
    const m = master({ nodes: [one, two], queue: realQueue })
    const l = m.start('atlas has room')
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(one.starts.map(s => s.id)).toEqual([l.sessionGiven])
    // All 50 waiting entries stay intact on disk, and the acknowledged start is gone.
    expect(realQueue.read('laptop').length).toBe(QUEUE_MAX)
    m.close()
  }, 15_000)

  test('a queue write error during in-flight persistence logs and lets the start proceed', async () => {
    const one = door('server-1')
    const m = master({
      nodes: [one],
      queue: {
        read: () => [],
        put: () => {
          throw new Error('disk full')
        },
        remove: () => {},
      },
    })
    const l = m.start('atlas unpersisted')
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(one.starts.map(s => s.id)).toEqual([l.sessionGiven])
    expect(m.logs.some(x => x.includes('placer: the queue: disk full'))).toBe(true)
    m.close()
  }, 15_000)

  test('restart with sent when that node answers 400 launch refusal marks failed and removes from queue', async () => {
    const one = door('server-1', {
      launch: () => json(400, { error: 'launch', field: 'cwd', detail: 'bad folder' }),
    })
    const two = door('server-2')
    const saved = entry({ sent: 'server-1' })
    const m = master({ nodes: [one, two], restored: [saved] })
    await until(() => !m.queued.has(saved.id))
    expect(two.starts).toEqual([])
    expect(m.ran).toEqual([])
    m.close()
  }, 15_000)

  test('a sync loss or 409 turn onto a full fallback clears stale syncing/sent markers on disk', async () => {
    const one = door('server-1')
    const m1 = master({ nodes: [one], localAwake: 1, whenFull: 'wait' })
    one.hold()
    const l1 = m1.start('atlas sync-drop', false)
    await until(() => l1.step === 'syncing')
    expect(m1.queued.get(l1.id)?.syncing).toBe('server-1')
    one.down = true
    one.release()
    await until(settledOf(l1))
    expect(l1.state).toBe('queued')
    expect(m1.queued.get(l1.id)?.syncing).toBeUndefined()
    expect(m1.queued.get(l1.id)?.sent).toBeUndefined()
    m1.close()

    const oneFull = door('server-1', { launch: () => json(409, { error: 'full' }) })
    const m2 = master({ nodes: [oneFull], localAwake: 1, whenFull: 'wait', sync: false })
    const l2 = m2.start('atlas turn-full', false)
    await until(settledOf(l2))
    expect(l2.state).toBe('queued')
    expect(m2.queued.get(l2.id)?.sent).toBeUndefined()
    expect(m2.queued.get(l2.id)?.syncing).toBeUndefined()
    m2.close()
  }, 15_000)

  test('graceful close while syncing or launching keeps the persisted entry in the queue', async () => {
    const one = door('server-1')
    one.hold()
    const syncingMaster = master({ nodes: [one] })
    const l1 = syncingMaster.start('atlas 1')
    await until(() => l1.step === 'syncing')
    syncingMaster.close()
    one.release()
    await Bun.sleep(40)
    expect(syncingMaster.queued.get(l1.id)?.syncing).toBe('server-1')
    expect(syncingMaster.ran).toEqual([])

    const two = door('server-1')
    two.holdLaunch()
    const sentMaster = master({ nodes: [two], sync: false })
    const l2 = sentMaster.start('atlas 2')
    await until(() => two.requests.includes('POST /api/node/launch'))
    sentMaster.close()
    two.releaseLaunch()
    await Bun.sleep(40)
    expect(sentMaster.queued.get(l2.id)?.sent).toBe('server-1')
    expect(sentMaster.ran).toEqual([])
  }, 15_000)

  test('a start that stays on this computer never writes to the queue', async () => {
    const one = door('server-1')
    const m = master({ nodes: [one], lanes: [] })
    const l = m.start('atlas local')
    await until(() => m.ran.length === 1)
    expect(l.place?.home).toEqual({ kind: 'lane' })
    expect(m.queuePuts).toEqual([])
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)
})

describe('a device with its own profiles gets no bundle (#802)', () => {
  test('marked in config.json: the start goes there with no sync and no bundle request', async () => {
    const own = door('laptop-old')
    const m = master({ nodes: [own], deviceCfg: { 'laptop-old': { ownProfiles: true } } })
    const l = m.start('atlas 1')
    await until(settledOf(l))
    expect([l.state, l.place?.device]).toEqual(['done', 'laptop-old'])
    expect(m.syncs).toEqual([])
    expect(bundleCalls(own)).toEqual([])
    expect(own.requests).toEqual(['POST /api/node/launch'])
    m.close()
  }, 15_000)

  test('said by its status alone (a master whose config has no mark yet): no sync either', async () => {
    const own = door('laptop-old')
    own.ownStatus = true
    const m = master({ nodes: [own] })
    const l = m.start('atlas 1', false, { device: 'laptop-old' })
    await until(settledOf(l))
    expect([l.state, l.place?.device]).toEqual(['done', 'laptop-old'])
    expect(bundleCalls(own)).toEqual([])
    expect(own.starts.length).toBe(1)
    m.close()
  }, 15_000)

  test('a profile it does not have: a plain refusal at once, nothing sent, no hang', async () => {
    const own = door('laptop-old', { profiles: ['work'] })
    const m = master({
      nodes: [own],
      nodeProfiles: ['work'],
      deviceCfg: { 'laptop-old': { ownProfiles: true } },
      localAwake: 1,
      whenFull: 'wait',
    })
    const l = m.start('atlas 1', false, { device: 'laptop-old' })
    await until(settledOf(l))
    expect(l.state).toBe('failed')
    expect(l.place?.refuse).toEqual({
      kind: 'unfit',
      devices: [{ device: 'laptop-old', kind: 'no-profile', profile: 'default' }],
    })
    expect(own.requests).toEqual([])
    expect(m.queued.size).toBe(0)
    m.close()
  }, 15_000)

  test('a helper node without the mark is still made current first, as before', async () => {
    const helper = door('server-1')
    const m = master({ nodes: [helper] })
    const l = m.start('atlas 1')
    await until(settledOf(l))
    expect(l.state).toBe('done')
    expect(m.syncs).toEqual(['server-1/default'])
    expect(helper.requests[0]).toBe('GET /api/node/bundle/default')
    expect(helper.requests.at(-1)).toBe('POST /api/node/launch')
    m.close()
  }, 15_000)
})

describe('a sync that keeps failing gives up with the reason (#802)', () => {
  test(`after ${SYNC_TRIES} failed syncs the start stops and the card says why; nothing is tried after`, async () => {
    const one = door('server-1', { commit: () => json(409, { error: 'path', path: 'skills/brandkit/SKILL.md' }) })
    const m = master({ nodes: [one], localAwake: 1, whenFull: 'wait' })
    const l = m.start('atlas 1', false, { device: 'server-1' })
    const commits = () => one.requests.filter(r => r.endsWith('/commit')).length
    await until(() => commits() === 1 && settledOf(l)())
    // Before the last try it waits as it did: queued, the device asked again once its status moves.
    expect(l.state).toBe('queued')
    for (let n = 2; n <= SYNC_TRIES; n++) {
      for (let i = 0; i < 6 && commits() < n; i++) {
        m.clock.advance(15_000)
        await Bun.sleep(20)
      }
      await until(() => commits() === n && settledOf(l)())
    }
    expect(l.state).toBe('failed')
    expect(l.error).toContain(`stopped after ${SYNC_TRIES} tries`)
    expect(l.error).toContain('skills/brandkit/SKILL.md')
    expect(one.starts).toEqual([])
    expect(m.queued.has(l.id)).toBe(false)
    for (let i = 0; i < 4; i++) {
      m.clock.advance(15_000)
      await Bun.sleep(10)
    }
    expect(commits()).toBe(SYNC_TRIES)
    m.close()
  }, 15_000)

  test('a link that is down does not count: the start waits for the node as before', async () => {
    const one = door('server-1')
    one.down = true
    const m = master({ nodes: [one], localAwake: 1, whenFull: 'wait' })
    const l = m.start('atlas 1', false, { device: 'server-1' })
    await until(settledOf(l))
    for (let i = 0; i < SYNC_TRIES + 2; i++) {
      m.clock.advance(15_000)
      await Bun.sleep(10)
    }
    expect(l.state).toBe('queued')
    m.close()
  }, 15_000)
})
