// Verified done on a worker's node (#675): verifier starts on the worker's device in its
// folder (never on the master), runs its verdict over the uplink with herdr-pane identity on the
// node, picks the node's profile for non-Claude workers, sends node failures to the owner, and
// leaves workers on the master down the exact same code as before.
import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { createOutbox } from '../../src/adapters/node-outbox.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { listEntries } from '../../src/adapters/schedule-store.ts'
import { threadByKey } from '../../src/adapters/work-thread-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { NODE_API } from '../../src/core/node-door.ts'
import { type NodeStatus, parseNodeKey } from '../../src/core/nodes.ts'
import { profileSet } from '../../src/core/profiles.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Item } from '../../src/core/types.ts'
import { OWNER, type Party, type ThreadHead, type ThreadsConfig, threadsConfig } from '../../src/core/work-threads.ts'
import { type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { createLaunches, type LaunchState, type StartOptions } from '../../src/services/launch/launches.ts'
import { createNodeLaunch } from '../../src/services/node/launch.ts'
import { createNodeUplink } from '../../src/services/node/uplink.ts'
import { createBundleSync } from '../../src/services/nodes/bundle-sync.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createPlacer } from '../../src/services/nodes/placer.ts'
import { createUplinkRunner } from '../../src/services/nodes/uplink.ts'
import { confirmClose } from '../../src/services/work-threads.ts'
import { createVerifier, paneSelf, type VerifyHost, type VerifyNodeInfo } from '../../src/services/work-verify.ts'
import { isolatedHome } from '../support/env.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const MASTER_UUID = '11111111-1111-4111-8111-111111111111'
const BEN_UUID = '22222222-2222-4222-8222-222222222222'
const CLEO_UUID = '33333333-3333-4333-8333-333333333333'
const master: Party = { kind: 'session', key: MASTER_UUID, name: 'anna' }
const benNode: Party = { kind: 'session', key: `@server-1:${BEN_UUID}`, name: 'ben' }
const benLocal: Party = { kind: 'session', key: BEN_UUID, name: 'ben' }

const scratch: string[] = []
const keptEnv: Record<string, string | undefined> = {}

afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of Object.entries(keptEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete keptEnv[k]
  }
})

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in keptEnv)) keptEnv[k] = process.env[k]
    process.env[k] = v
  }
}

function into(box: Sandbox): void {
  setEnv({ ...box.env, BOARD_TEST_PACE: '0.02' })
}

const nodeStatus = (over: Partial<NodeStatus> = {}): NodeStatus => ({
  api: NODE_API,
  id: 'server-1',
  version: '0.1.0',
  commit: 'abc123',
  platform: 'linux',
  arch: 'x64',
  cpus: 4,
  memTotalMb: 8192,
  memAvailableMb: 4096,
  load: [0.2, 0.2, 0.2],
  sessions: { awake: 1, working: 0, asleep: 0 },
  launches: 0,
  workRootFreeMb: 10000,
  profiles: [{ id: 'default', loggedIn: true, bundle: null }],
  agents: ['claude'],
  at: NOW,
  ...over,
})

function setupHarness({
  threads = { agents: true, verify: { model: 'opus' } },
  workerItem,
  nodeInfo,
  remoteLaunches = new Map<string, LaunchState>(),
}: {
  threads?: unknown
  workerItem: Item
  nodeInfo?: (device: string) => VerifyNodeInfo | null
  remoteLaunches?: Map<string, LaunchState>
}) {
  const dir = isolatedHome()
  let now = NOW
  const sessions: Record<string, Party> = {
    anna: master,
    ben: workerItem.device ? benNode : benLocal,
    cleo: { kind: 'session', key: CLEO_UUID, name: 'cleo' },
  }
  const run = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => sessions[w] ?? null,
      self: async () => (actor.kind === 'session' ? { key: actor.key } : { why: 'it runs in no Claude session' }),
      out: l => out.push(l),
      err: l => err.push(l),
      now,
      ...over,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const head = (key: string): ThreadHead => {
    const db = openDb() as BoardDb
    try {
      return threadByKey(db, key) as ThreadHead
    } finally {
      db.close()
    }
  }
  const items: Item[] = [workerItem]
  const started: { body: Record<string, unknown>; options: StartOptions }[] = []
  const archived: string[] = []
  const launches = new Map<string, LaunchState>()
  let workspacesCalled = 0
  let profilesCalled = 0
  let nodeCalled = 0
  const host: VerifyHost = {
    cfg: {
      threads,
      categories: [{ id: 'atlas', title: 'Atlas', color: 'blue' }],
    } as unknown as VerifyHost['cfg'],
    log: () => {},
    start: async (body, _items, options) => {
      started.push({ body: body as Record<string, unknown>, options })
      const id = `l${started.length}`
      launches.set(id, { state: 'starting', error: '', sessionId: options.sessionId ?? null })
      return { ok: true, id }
    },
    launchState: id => launches.get(id) ?? null,
    workspaces: async () => {
      workspacesCalled++
      return [{ id: 'wP', label: 'Atlas' }]
    },
    archive: async item => {
      archived.push(item.key)
      return 'ok'
    },
    withDb: fn => {
      const db = openDb()
      const out = fn(db)
      if (out instanceof Promise) return out.finally(() => db?.close()) as typeof out
      db?.close()
      return out
    },
    profiles: () => {
      profilesCalled++
      return 1
    },
    ...(nodeInfo && {
      node: (device: string) => {
        nodeCalled++
        return nodeInfo(device)
      },
    }),
    remoteLaunchState: key => remoteLaunches.get(key) ?? null,
    now: () => now,
  }
  const verifier = () => createVerifier(host)
  return {
    dir,
    items,
    run,
    head,
    host,
    verifier,
    started,
    archived,
    launches,
    remoteLaunches,
    counts: () => ({ workspacesCalled, profilesCalled, nodeCalled }),
    at: (t: number) => {
      now = t
    },
  }
}

const limits = (): ScheduleEntry[] => listEntries().filter(e => e.kind === 'verify')

const HERDR_READY = {
  'api snapshot': {
    result: { snapshot: { panes: [], tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Atlas' }] } },
  },
  'workspace list': { result: { workspaces: [{ workspace_id: 'wA', label: 'Atlas', focused: true }] } },
  'workspace create': {
    result: { workspace: { workspace_id: 'wA' }, tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } },
  },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'tab rename': { result: null },
  'pane get': {
    result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } },
  },
  'pane run': { result: null },
  'agent list': { result: { agents: [] } },
  'agent prompt': { result: null },
  'agent rename': { result: null },
  'pane read': { text: 'Session renamed to: verify-atlas-1' },
}

test('node worker starts verifier on its node via placer + node launch + exactSession, and archives on node', async () => {
  const box = await sandbox()
  box.state(HERDR_READY)
  into(box)
  setEnv({ BOARD_NODE_KEPT_MS: '150', BOARD_NODE_READ_MS: '150' })

  const masterHome = box.env.HOME ?? ''
  const masterProfile = join(masterHome, '.claude')
  mkdirSync(masterProfile, { recursive: true })
  writeFileSync(join(masterProfile, '.credentials.json'), '{}')

  // Node folder that does NOT exist on the master (different root inside a separate temp dir).
  const nodeOnlyRoot = mkdtempSync(join(tmpdir(), 'node-only-'))
  scratch.push(nodeOnlyRoot)
  const nodeWorkCwd = join(nodeOnlyRoot, 'atlas-repo')
  mkdirSync(nodeWorkCwd, { recursive: true })

  // Node has its own profile "node-only" which the master does not have at all.
  const nodeProfileDir = join(nodeOnlyRoot, '.claude-node-only')
  mkdirSync(nodeProfileDir, { recursive: true })
  writeFileSync(join(nodeProfileDir, '.credentials.json'), '{}')
  const nodeProfiles = profileSet(
    [{ id: 'node-only', title: 'Node Only', dir: nodeProfileDir, color: 'indigo', hidden: false }],
    nodeProfileDir,
  )

  const nodeCfg = {
    id: 'server-1',
    port: 12430,
    workRoot: nodeOnlyRoot,
    listen: 'loopback' as const,
    tls: false,
    relay: null,
  }
  const nodeBoardCfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    node: nodeCfg,
  })
  const nodeLaunches = createLaunches({
    deps: {
      cfg: nodeBoardCfg,
      profiles: () => nodeProfiles,
      log: () => {},
    } as unknown as Parameters<typeof createLaunches>[0]['deps'],
  })
  const nodeLaunch = createNodeLaunch({
    node: () => nodeCfg,
    start: (body, session, o) =>
      nodeLaunches.start(body, [], {
        node: { session, ...(o?.exactSession && { exactSession: true }) },
      }),
    launch: id => nodeLaunches.list().find(l => l.id === id),
    profiles: () => nodeProfiles,
    workspaces: async () => [{ id: 'wA', label: 'Atlas' }],
    memAvailableMb: async () => 4096,
    dir: join(nodeOnlyRoot, 'launches'),
    platform: 'linux',
  })

  // Master config: lane "atlas" is NOT in nodes.lanes (verifies pinned node verifier still goes to node).
  const masterCfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    threads: { agents: true, verify: { model: 'opus' } },
    nodes: {
      id: 'master-1',
      order: ['local', 'server-1'],
      lanes: [],
      devices: {
        'server-1': {
          title: 'Server 1',
          link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
          maxSessions: 4,
          minFreeMemMb: 512,
          maxLoad: 4,
        },
      },
    },
  })

  const status = nodeStatus({
    commit: 'abc123',
    profiles: [{ id: 'node-only', loggedIn: true, bundle: null }],
  })
  const nodeItems: Item[] = []
  const launchedBodies: unknown[] = []
  const archivedKeys: string[] = []
  const outbox = createOutbox({ dir: join(nodeOnlyRoot, 'outbox') })
  const nodeUplink = createNodeUplink({ outbox, log: () => {} })

  const listeners: ((id: string) => void)[] = []
  const link: Link = {
    id: 'server-1',
    state: () => ({ state: 'online', since: NOW, heardAt: NOW }),
    view: () => ({
      id: 'server-1',
      title: 'Server 1',
      kind: 'direct',
      link: { state: 'online', since: NOW, heardAt: NOW },
      status,
      sameCommit: true,
      payloadAt: NOW,
    }),
    payload: () => null,
    status: async () => status,
    fetch: async (path, init) => {
      if (path === '/api/node/launch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        launchedBodies.push(body)
        const r = await nodeLaunch.answer(body)
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      if (path === '/api/archive') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { keys?: string[] }
        archivedKeys.push(...(body.keys ?? []))
        return new Response(JSON.stringify({ ok: true, done: (body.keys ?? []).map(key => ({ key })), failed: [] }), {
          status: 200,
        })
      }
      if (path === '/api/node/uplink') {
        return nodeUplink.stream(
          new Request('http://127.0.0.1/api/node/uplink', init?.signal ? { signal: init.signal } : undefined),
        )
      }
      const fileMatch = /^\/api\/node\/uplink\/([^/]+)\/file\/(\d+)$/.exec(path)
      if (fileMatch) return nodeUplink.file(fileMatch[1] ?? '', Number(fileMatch[2]))
      const ansMatch = /^\/api\/node\/uplink\/([^/]+)$/.exec(path)
      if (ansMatch) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        const r = nodeUplink.answer(ansMatch[1] ?? '', body)
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    },
    onState: () => () => {},
    onPayload: () => () => {},
    onStatus: () => () => {},
    reconnect: () => {},
    killNow: () => {},
    close: async () => {},
  }
  const onChange = (fn: (id: string) => void) => {
    listeners.push(fn)
    return () => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  const masterProfiles = profileSet(
    [{ id: 'default', title: 'Default', dir: masterProfile, color: 'indigo', hidden: false }],
    masterProfile,
  )
  const bundleSync = createBundleSync({
    cfg: masterCfg,
    links: { link: id => (id === 'server-1' ? link : null) },
    profiles: () => masterProfiles.list,
    store: createDeviceStore(),
    log: () => {},
  })

  let placer!: ReturnType<typeof createPlacer>
  const masterLaunches = createLaunches({
    deps: { cfg: masterCfg, profiles: () => masterProfiles, log: () => {} } as unknown as Parameters<
      typeof createLaunches
    >[0]['deps'],
    placer: () => placer,
  })
  placer = createPlacer({
    cfg: masterCfg,
    links: { link: id => (id === 'server-1' ? link : null), onChange: () => () => {} },
    remote: () => ({
      items: nodeItems,
      launches: [],
      schedules: [],
      devices: [],
    }),
    launches: masterLaunches,
    items: () => [],
    ownStatus: async () => nodeStatus({ id: 'local', commit: 'abc123' }),
    commit: async () => 'abc123',
    bundle: bundleSync,
    log: () => {},
  })

  const masterDb = openDb() as BoardDb
  const allItems = (): Item[] => [
    {
      key: `@server-1:${BEN_UUID}`,
      session: BEN_UUID,
      pane: 'wA:p2',
      workspace: 'Atlas',
      cwd: nodeWorkCwd,
      status: 'idle',
      name: 'ben',
      autoName: 'ben',
      category: 'atlas',
      categorySet: true,
      column: 'work',
      attention: '',
      agent: 'claude',
      profile: 'node-only',
      device: 'server-1',
    },
    ...nodeItems,
  ]

  const runner = createUplinkRunner({
    links: { link: id => (id === 'server-1' ? link : null), onChange },
    find: key => allItems().find(i => i.key === key),
    items: allItems,
    cfg: masterCfg,
    log: () => {},
  })
  for (const fn of listeners) fn('server-1')
  await Bun.sleep(20)

  const verifier = createVerifier({
    cfg: masterCfg,
    log: () => {},
    start: (body, items, options) => masterLaunches.start(body, items, options),
    launchState: id => masterLaunches.state(id),
    workspaces: async () => {
      throw new Error('master workspaces must not be called for a node worker')
    },
    archive: async item => {
      if (item.key.startsWith('@server-1:')) {
        const res = await link.fetch('/api/archive', {
          method: 'POST',
          body: JSON.stringify({ op: 'archive', keys: [item.key.slice('@server-1:'.length)] }),
        })
        return res.ok ? 'ok' : 'busy'
      }
      return 'busy'
    },
    withDb: fn => fn(masterDb),
    profiles: () => {
      throw new Error('master profiles must not be called for a node worker')
    },
    node: device => (device === 'server-1' ? { configured: true, online: true, status, profiles: {} } : null),
  })

  try {
    // 1. Master creates thread for ben (on server-1), ben proposes done -> held.
    await threadCmd(['new', '--to', 'ben', '--verify', 'Check node work'], {
      cfg: { threads: masterCfg.threads, port: 12422 },
      actor: master,
      lane: 'atlas',
      findSession: async w => (w === 'ben' ? benNode : null),
      db: masterDb,
      now: NOW,
      out: () => {},
    })
    await threadCmd(['done', 'atlas-1', 'implemented on node'], {
      cfg: { threads: masterCfg.threads, port: 12422 },
      actor: benNode,
      lane: 'atlas',
      findSession: async () => null,
      db: masterDb,
      now: NOW,
      out: () => {},
    })

    // 2. Sweep starts verifier on server-1.
    await verifier.sweep(async () => allItems())
    const h = threadByKey(masterDb, 'atlas-1') as ThreadHead
    const run = h.verify?.run
    assert.ok(run)
    assert.ok(run.key.startsWith('@server-1:'))
    const rawVerifierId = run.key.slice('@server-1:'.length)

    await until(() => launchedBodies.length === 1 && nodeLaunches.state(rawVerifierId)?.state === 'done', 20_000)

    // Placer sent exactSession + node path + node profile to server-1.
    expect(launchedBodies[0]).toMatchObject({
      id: rawVerifierId,
      name: 'verify-atlas-1',
      category: 'atlas',
      profile: 'node-only',
      agent: 'claude',
      model: 'opus',
      workspace: 'Atlas',
      exactSession: true,
      source: { kind: 'path', cwd: nodeWorkCwd, worktree: null },
    })
    // Node's fake herdr actually started Claude with --session-id <rawVerifierId> in nodeWorkCwd.
    assert.deepEqual(
      box.calls().find(a => a[0] === 'tab' && a[1] === 'create'),
      ['tab', 'create', '--workspace', 'wA', '--cwd', nodeWorkCwd, '--label', 'verify-atlas-1', '--no-focus'],
    )
    assert.equal(
      box.calls().find(a => a[0] === 'pane' && a[1] === 'run')?.[3],
      `claude --model opus --session-id ${rawVerifierId}`,
    )

    // 3. Another session on the node sees "hidden" instead of bare rawVerifierId in `show`.
    const benShowOut: string[] = []
    await threadCmd(['show', 'atlas-1'], {
      cfg: { node: nodeCfg },
      actor: { kind: 'session', key: BEN_UUID, name: 'ben' },
      lane: 'atlas',
      findSession: async () => null,
      call: async body => {
        const res = await nodeUplink.call(body)
        return res.body as Awaited<ReturnType<NonNullable<ThreadCmdContext['call']>>>
      },
      out: l => benShowOut.push(l),
    })
    assert.equal(benShowOut.join('\n').includes(rawVerifierId), false)

    // 4. Verifier on the node runs `board thread verdict` with a report file + herdr paneSelf over uplink.
    const reportPath = join(nodeOnlyRoot, 'report.md')
    writeFileSync(reportPath, 'Checked every line on server-1.\n')
    const verdictOut: string[] = []
    const verdictErr: string[] = []
    const code = await threadCmd(['verdict', 'atlas-1', 'pass', '--file', reportPath, 'all verified on node'], {
      cfg: { node: nodeCfg },
      actor: { kind: 'session', key: rawVerifierId, name: 'verify-atlas-1' },
      lane: 'atlas',
      findSession: async () => null,
      self: () => paneSelf(rawVerifierId, 'wA:p9', async () => rawVerifierId),
      call: async body => {
        const res = await nodeUplink.call(body)
        return res.body as Awaited<ReturnType<NonNullable<ThreadCmdContext['call']>>>
      },
      out: l => verdictOut.push(l),
      err: l => verdictErr.push(l),
    })
    assert.equal(code, 0, verdictErr.join('\n'))
    assert.match(verdictOut[0] ?? '', /^ok · atlas-1 · done · verdict pass/)
    const closed = threadByKey(masterDb, 'atlas-1') as ThreadHead
    assert.equal(closed.status, 'done')
    assert.equal(closed.verify?.last, 'pass')

    // 5. After verdict, due() archives the verifier on server-1 (not locally).
    const verifierItem: Item = {
      key: run.key,
      session: rawVerifierId,
      pane: 'wA:p9',
      workspace: 'Atlas',
      cwd: nodeWorkCwd,
      status: 'idle',
      name: 'verify-atlas-1',
      autoName: 'verify-atlas-1',
      category: 'atlas',
      categorySet: true,
      column: 'idle',
      attention: '',
      agent: 'claude',
      device: 'server-1',
    }
    nodeItems.push(verifierItem)
    await verifier.due(limits()[0] as ScheduleEntry, allItems())
    assert.deepEqual(archivedKeys, [rawVerifierId])
    assert.deepEqual(limits(), [])
  } finally {
    await runner.close()
    nodeUplink.close()
    placer.close()
    bundleSync.close()
    masterDb.close()
  }
}, 40_000)

test('node verifier cwd on master does not bypass remote pinning; fail verdict reopens thread; node refuses non-exactSession launcher', async () => {
  const dir = isolatedHome()
  // Create the exact same path on the master too: remote pinning must STILL pin to server-1 and never stat/run locally.
  const sharedPath = join(dir, 'repo')
  mkdirSync(sharedPath, { recursive: true })
  const masterProfile = join(dir, '.claude')
  mkdirSync(masterProfile, { recursive: true })
  writeFileSync(join(masterProfile, '.credentials.json'), '{}')

  const cfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    nodes: {
      id: 'master-1',
      order: ['local', 'server-1'],
      lanes: ['atlas'],
      devices: {
        'server-1': {
          title: 'Server 1',
          link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
          maxSessions: 4,
        },
      },
    },
  })
  const profiles = profileSet(
    [{ id: 'default', title: 'Default', dir: masterProfile, color: 'indigo', hidden: false }],
    masterProfile,
  )
  const taken: {
    cwd: string
    remote: string | undefined
    pin: unknown
    nodeProfile: true | undefined
    exactSession: boolean | undefined
  }[] = []
  const launches = createLaunches({
    deps: { cfg, profiles: () => profiles, log: () => {} } as unknown as Parameters<typeof createLaunches>[0]['deps'],
    placer: () => ({
      take: l => {
        taken.push({
          cwd: l.cwd,
          remote: l.remote,
          pin: l.pin,
          nodeProfile: l.nodeProfile,
          exactSession: l.exactSession,
        })
      },
      cancel: () => {},
      shown: () => false,
      observe: () => {},
    }),
  })
  const rawId = '44444444-4444-4444-8444-444444444444'
  const r = await launches.start(
    {
      name: 'verify-atlas-1',
      cwd: sharedPath,
      category: 'atlas',
      workspace: { create: 'Atlas' },
      message: 'Verify.',
      profile: 'node-prof',
      pin: { device: 'server-1' },
    },
    [],
    { sessionId: rawId, remote: 'server-1', byHand: false },
  )
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(taken, [
    {
      cwd: sharedPath,
      remote: 'server-1',
      pin: { device: 'server-1' },
      nodeProfile: true,
      exactSession: true,
    },
  ])

  // Node launch refuses a custom launch.command that lacks {sessionId} when exactSession is true.
  const box = await sandbox()
  box.state(HERDR_READY)
  into(box)
  const nodeProfileDir = join(box.env.HOME ?? '', '.claude')
  mkdirSync(nodeProfileDir, { recursive: true })
  writeFileSync(join(nodeProfileDir, '.credentials.json'), '{}')
  const nodeCfg = {
    id: 'server-1',
    port: 12430,
    workRoot: sharedPath,
    listen: 'loopback' as const,
    tls: false,
    relay: null,
  }
  const nodeBoardCfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    launch: { command: ['echo', '{name}'] },
    node: nodeCfg,
  })
  const nodeLaunches = createLaunches({
    deps: {
      cfg: nodeBoardCfg,
      profiles: () =>
        profileSet(
          [{ id: 'default', title: 'Default', dir: nodeProfileDir, color: 'indigo', hidden: false }],
          nodeProfileDir,
        ),
      log: () => {},
    } as unknown as Parameters<typeof createLaunches>[0]['deps'],
  })
  const nodeLaunch = createNodeLaunch({
    node: () => nodeCfg,
    start: (body, session, o) =>
      nodeLaunches.start(body, [], { node: { session, ...(o?.exactSession && { exactSession: true }) } }),
    launch: id => nodeLaunches.list().find(l => l.id === id),
    profiles: () =>
      profileSet(
        [{ id: 'default', title: 'Default', dir: nodeProfileDir, color: 'indigo', hidden: false }],
        nodeProfileDir,
      ),
    workspaces: async () => [{ id: 'wA', label: 'Atlas' }],
    memAvailableMb: async () => 4096,
    dir: join(dir, 'node-launches'),
    platform: 'linux',
  })
  const ans = await nodeLaunch.answer({
    id: rawId,
    name: 'verify-atlas-1',
    category: 'atlas',
    profile: 'default',
    agent: 'claude',
    model: '',
    message: 'Check.',
    workspace: 'Atlas',
    exactSession: true,
    source: { kind: 'path', cwd: sharedPath, worktree: null },
  })
  // Even when body carries agent: 'claude', nodeLaunch with exactSession skips agent choice and
  // commandLauncher refuses at run time because launch.command lacks {sessionId}.
  assert.equal(ans.status, 202)
  await until(() => ['done', 'failed'].includes(nodeLaunches.state(rawId)?.state ?? ''), 10_000)
  assert.equal(nodeLaunches.state(rawId)?.state, 'failed')
  assert.match(nodeLaunches.state(rawId)?.error ?? '', /session id|sessionId|launcher/i)

  // A node with launch.command containing {sessionId} accepts exactSession even when agent: 'claude' was sent.
  const okCmdCfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    launch: { command: ['echo', '{sessionId}', '{name}'] },
    node: nodeCfg,
  })
  const okCmdLaunches = createLaunches({
    deps: {
      cfg: okCmdCfg,
      profiles: () =>
        profileSet(
          [{ id: 'default', title: 'Default', dir: nodeProfileDir, color: 'indigo', hidden: false }],
          nodeProfileDir,
        ),
      log: () => {},
    } as unknown as Parameters<typeof createLaunches>[0]['deps'],
  })
  const okNodeLaunch = createNodeLaunch({
    node: () => nodeCfg,
    start: (body, session, o) =>
      okCmdLaunches.start(body, [], { node: { session, ...(o?.exactSession && { exactSession: true }) } }),
    launch: id => okCmdLaunches.list().find(l => l.id === id),
    profiles: () =>
      profileSet(
        [{ id: 'default', title: 'Default', dir: nodeProfileDir, color: 'indigo', hidden: false }],
        nodeProfileDir,
      ),
    workspaces: async () => [{ id: 'wA', label: 'Atlas' }],
    memAvailableMb: async () => 4096,
    dir: join(dir, 'ok-node-launches'),
    platform: 'linux',
  })
  const okId = '66666666-6666-4666-8666-666666666666'
  const okAns = await okNodeLaunch.answer({
    id: okId,
    name: 'verify-atlas-2',
    category: 'atlas',
    profile: 'default',
    agent: 'claude',
    model: '',
    message: 'Check.',
    workspace: 'Atlas',
    exactSession: true,
    source: { kind: 'path', cwd: sharedPath, worktree: null },
  })
  assert.equal(okAns.status, 202)

  // Fail verdict over uplink reopens thread to doing on master.
  setEnv({ BOARD_NODE_KEPT_MS: '150', BOARD_NODE_READ_MS: '150' })
  const outbox = createOutbox({ dir: join(dir, 'outbox') })
  const up = createNodeUplink({ outbox, log: () => {} })
  const masterDb = openDb() as BoardDb
  const verifierUuid = '55555555-5555-4555-8555-555555555555'
  const listeners2: ((id: string) => void)[] = []
  const link: Link = {
    id: 'server-1',
    state: () => ({ state: 'online', since: NOW, heardAt: NOW }),
    view: () => ({
      id: 'server-1',
      title: 'Server 1',
      kind: 'direct',
      link: { state: 'online', since: NOW, heardAt: NOW },
      status: nodeStatus(),
      sameCommit: true,
      payloadAt: NOW,
    }),
    payload: () => null,
    status: async () => nodeStatus(),
    fetch: async (path, init) => {
      if (path === '/api/node/uplink')
        return up.stream(
          new Request('http://127.0.0.1/api/node/uplink', init?.signal ? { signal: init.signal } : undefined),
        )
      const ansMatch = /^\/api\/node\/uplink\/([^/]+)$/.exec(path)
      if (ansMatch) {
        const r = up.answer(ansMatch[1] ?? '', JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      return new Response('{}', { status: 404 })
    },
    onState: () => () => {},
    onPayload: () => () => {},
    onStatus: () => () => {},
    reconnect: () => {},
    killNow: () => {},
    close: async () => {},
  }
  const runner = createUplinkRunner({
    links: {
      link: id => (id === 'server-1' ? link : null),
      onChange: fn => {
        listeners2.push(fn)
        return () => {}
      },
    },
    find: () => undefined,
    items: () => [],
    cfg: { ...cfg, threads: { agents: true, verify: true } },
    log: () => {},
  })
  for (const fn of listeners2) fn('server-1')
  await Bun.sleep(20)
  try {
    await threadCmd(['new', '--to', 'ben', '--verify', 'Reopen test'], {
      cfg: { threads: { agents: true, verify: true }, port: 12422 },
      actor: master,
      lane: 'atlas',
      findSession: async () => benNode,
      db: masterDb,
      now: NOW,
      out: () => {},
    })
    await threadCmd(['done', 'atlas-1', 'first try'], {
      cfg: { threads: { agents: true, verify: true }, port: 12422 },
      actor: benNode,
      lane: 'atlas',
      findSession: async () => null,
      db: masterDb,
      now: NOW,
      out: () => {},
    })
    const v = createVerifier({
      cfg: { ...cfg, threads: { agents: true, verify: true } },
      log: () => {},
      start: async () => ({ ok: true, id: 'l1' }),
      launchState: () => ({ state: 'done', error: '', sessionId: null }),
      workspaces: async () => [],
      archive: async () => 'ok',
      withDb: fn => fn(masterDb),
      profiles: () => 1,
      node: () => ({ configured: true, online: true, status: nodeStatus() }),
    })
    await v.sweep(async () => [
      {
        key: benNode.key,
        session: BEN_UUID,
        pane: 'wA:p2',
        workspace: 'Atlas',
        cwd: sharedPath,
        status: 'idle',
        name: 'ben',
        autoName: 'ben',
        category: 'atlas',
        categorySet: true,
        column: 'work',
        attention: '',
        agent: 'claude',
        profile: 'default',
        device: 'server-1',
      },
    ])
    const assigned = threadByKey(masterDb, 'atlas-1')?.verify?.run?.key ?? ''
    const assignedRaw = assigned.slice('@server-1:'.length)
    assert.notEqual(assignedRaw, verifierUuid)
    const failCode = await threadCmd(['verdict', 'atlas-1', 'fail', 'tests missing'], {
      cfg: { node: nodeCfg },
      actor: { kind: 'session', key: assignedRaw, name: 'verify-atlas-1' },
      lane: 'atlas',
      findSession: async () => null,
      self: () => paneSelf(assignedRaw, 'wA:p9', async () => assignedRaw),
      call: async body => (await up.call(body)).body as Awaited<ReturnType<NonNullable<ThreadCmdContext['call']>>>,
      out: () => {},
      err: () => {},
    })
    assert.equal(failCode, 0)
    const reopened = threadByKey(masterDb, 'atlas-1') as ThreadHead
    assert.equal(reopened.status, 'doing')
    assert.equal(reopened.verify?.last, 'fail')
    assert.equal(reopened.verify?.fails, 1)
  } finally {
    await runner.close()
    up.close()
    masterDb.close()
  }
}, 40_000)

test('node verdict identity check: refuses wrong session, --session spoof, missing pane, missing self; non-verdict skips self', async () => {
  const dir = isolatedHome()
  const worker: Item = {
    key: benNode.key,
    session: BEN_UUID,
    pane: 'wA:p2',
    workspace: 'Atlas',
    cwd: '/srv/atlas',
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'claude',
    profile: 'default',
    device: 'server-1',
  }
  const s = setupHarness({
    workerItem: worker,
    nodeInfo: () => ({ configured: true, online: true, status: nodeStatus() }),
  })
  await s.run(master, ['new', '--to', 'ben', '--verify', 'Check security'])
  await s.run(benNode, ['done', 'atlas-1', 'done'])
  await s.verifier().sweep(async () => s.items)
  const vKey = s.head('atlas-1').verify?.run?.key ?? ''
  const vRaw = vKey.slice('@server-1:'.length)

  // Node uplink wired in-memory via createUplinkRunner + createNodeUplink.
  setEnv({ BOARD_NODE_KEPT_MS: '150', BOARD_NODE_READ_MS: '150' })
  const outbox = createOutbox({ dir: join(dir, 'outbox') })
  const up = createNodeUplink({ outbox, log: () => {} })
  const link: Link = {
    id: 'server-1',
    state: () => ({ state: 'online', since: NOW, heardAt: NOW }),
    view: () => ({
      id: 'server-1',
      title: 'Server 1',
      kind: 'direct',
      link: { state: 'online', since: NOW, heardAt: NOW },
      status: nodeStatus(),
      sameCommit: true,
      payloadAt: NOW,
    }),
    payload: () => null,
    status: async () => nodeStatus(),
    fetch: async (path, init) => {
      if (path === '/api/node/uplink')
        return up.stream(
          new Request('http://127.0.0.1/api/node/uplink', init?.signal ? { signal: init.signal } : undefined),
        )
      const m = /^\/api\/node\/uplink\/([^/]+)$/.exec(path)
      if (m) {
        const r = up.answer(m[1] ?? '', JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      return new Response('{}', { status: 404 })
    },
    onState: () => () => {},
    onPayload: () => () => {},
    onStatus: () => () => {},
    reconnect: () => {},
    killNow: () => {},
    close: async () => {},
  }
  const listeners3: ((id: string) => void)[] = []
  const runner = createUplinkRunner({
    links: {
      link: id => (id === 'server-1' ? link : null),
      onChange: fn => {
        listeners3.push(fn)
        return () => {}
      },
    },
    find: key => s.items.find(i => i.key === key),
    items: () => s.items,
    cfg: normalizeConfig({ threads: { agents: true, verify: true }, port: 12422 }),
    log: () => {},
  })
  for (const fn of listeners3) fn('server-1')
  await Bun.sleep(20)

  const nodeCfg = {
    id: 'server-1',
    port: 12430,
    workRoot: '/srv',
    listen: 'loopback' as const,
    tls: false,
    relay: null,
  }
  const runNode = async (actorKey: string, argv: string[], selfFn?: ThreadCmdContext['self']) => {
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(argv, {
      cfg: { node: nodeCfg },
      actor: { kind: 'session', key: actorKey, name: 'x' },
      lane: 'atlas',
      findSession: async () => null,
      ...(selfFn && { self: selfFn }),
      call: async body => (await up.call(body)).body as Awaited<ReturnType<NonNullable<ThreadCmdContext['call']>>>,
      out: l => out.push(l),
      err: l => err.push(l),
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  try {
    // 1. Worker session on the node tries to pass its own work -> not_verifier.
    const r1 = await runNode(BEN_UUID, ['verdict', 'atlas-1', 'fail', 'self-check', '--json'], async () => ({
      key: BEN_UUID,
    }))
    assert.equal(r1.code, 1)
    assert.equal(JSON.parse(r1.out).error, 'not_verifier')

    // 2. Worker runs with --session <verifier> (actor=vRaw, but paneSelf sees BEN_UUID) -> not_verifier.
    const r2 = await runNode(vRaw, ['verdict', 'atlas-1', 'fail', 'spoof', '--json'], () =>
      paneSelf(BEN_UUID, 'wA:p2', async () => BEN_UUID),
    )
    assert.equal(r2.code, 1)
    assert.equal(JSON.parse(r2.out).error, 'not_verifier')

    // 3. Verifier has no HERDR_PANE_ID -> refused with paneSelf's reason.
    const r3 = await runNode(vRaw, ['verdict', 'atlas-1', 'fail', 'no-pane', '--json'], () =>
      paneSelf(vRaw, undefined, async () => vRaw),
    )
    assert.equal(r3.code, 1)
    const j3 = JSON.parse(r3.out)
    assert.equal(j3.error, 'not_verifier')
    assert.match(j3.message, /HERDR_PANE_ID is not set/)

    // 4. Older node / direct uplink call without `self` -> fails closed (not_verifier).
    const r4 = await runNode(vRaw, ['verdict', 'atlas-1', 'fail', 'no-self', '--json'])
    assert.equal(r4.code, 1)
    assert.equal(JSON.parse(r4.out).error, 'not_verifier')

    // 5. Non-verdict commands on a node never ask `ctx.self`.
    let selfCalls = 0
    const r5 = await runNode(BEN_UUID, ['show', 'atlas-1'], async () => {
      selfCalls++
      return { key: BEN_UUID }
    })
    assert.equal(r5.code, 0)
    assert.equal(selfCalls, 0)

    // 6. Node uplink rejects `self` on non-verdict calls directly.
    const badSelf = await up.call({
      cmd: 'thread',
      argv: ['post', 'atlas-1', 'hi'],
      session: BEN_UUID,
      lane: 'atlas',
      files: [],
      self: { key: BEN_UUID },
    })
    assert.equal(badSelf.status, 400)

    // Thread is still held!
    assert.equal(s.head('atlas-1').proposed?.verify, true)
  } finally {
    await runner.close()
    up.close()
  }
})

test('non-Claude worker on a node: per-device verify.profile, mapped profile, or node default Claude profile', async () => {
  const nonClaude = (agent: 'agy' | 'pi' | 'codex'): Item => ({
    key: benNode.key,
    session: BEN_UUID,
    pane: 'wA:p2',
    workspace: 'Atlas',
    cwd: '/srv/atlas',
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent,
    device: 'server-1',
  })

  // 1. Master-only string verify.profile ("work") is NOT blindly sent to server-1; uses node's default.
  const s1 = setupHarness({
    threads: { agents: true, verify: { profile: 'work' } },
    workerItem: nonClaude('agy'),
    nodeInfo: () => ({
      configured: true,
      online: true,
      status: nodeStatus({
        profiles: [
          { id: 'default', loggedIn: true, bundle: null },
          { id: 'other', loggedIn: true, bundle: null },
        ],
      }),
    }),
  })
  await s1.run(master, ['new', '--to', 'ben', '--verify', 'Agy work'])
  await s1.run(benNode, ['done', 'atlas-1', 'done'])
  await s1.verifier().sweep(async () => s1.items)
  assert.equal(s1.started.length, 1)
  assert.equal(s1.started[0]?.body.profile, 'default')
  expect(s1.started[0]?.body.pin).toEqual({ device: 'server-1' })
  assert.equal(s1.started[0]?.options.remote, 'server-1')

  // 2. Per-device threads.verify.profile picks that device's profile ("alt").
  const s2 = setupHarness({
    threads: { agents: true, verify: { profile: { local: 'work', 'server-1': 'alt' } } },
    workerItem: nonClaude('pi'),
    nodeInfo: () => ({
      configured: true,
      online: true,
      status: nodeStatus({
        profiles: [
          { id: 'default', loggedIn: true, bundle: null },
          { id: 'alt', loggedIn: true, bundle: null },
        ],
      }),
    }),
  })
  await s2.run(master, ['new', '--to', 'ben', '--verify', 'Pi work'])
  await s2.run(benNode, ['done', 'atlas-1', 'done'])
  await s2.verifier().sweep(async () => s2.items)
  assert.equal(s2.started.length, 1)
  assert.equal(s2.started[0]?.body.profile, 'alt')

  // 3. String verify.profile mapped via nodes.devices['server-1'].profiles uses the mapped profile.
  const s3 = setupHarness({
    threads: { agents: true, verify: { profile: 'work' } },
    workerItem: nonClaude('codex'),
    nodeInfo: () => ({
      configured: true,
      online: true,
      profiles: { work: 'mapped-work' },
      status: nodeStatus({
        profiles: [
          { id: 'default', loggedIn: true, bundle: null },
          { id: 'mapped-work', loggedIn: true, bundle: null },
        ],
      }),
    }),
  })
  await s3.run(master, ['new', '--to', 'ben', '--verify', 'Codex work'])
  await s3.run(benNode, ['done', 'atlas-1', 'done'])
  await s3.verifier().sweep(async () => s3.items)
  assert.equal(s3.started.length, 1)
  assert.equal(s3.started[0]?.body.profile, 'mapped-work')

  // 4. Node has only one usable logged-in profile ("team") and no default -> uses "team".
  const s4 = setupHarness({
    threads: { agents: true, verify: true },
    workerItem: nonClaude('agy'),
    nodeInfo: () => ({
      configured: true,
      online: true,
      status: nodeStatus({
        profiles: [
          { id: 'default', loggedIn: false, bundle: null },
          { id: 'team', loggedIn: true, bundle: null },
        ],
      }),
    }),
  })
  await s4.run(master, ['new', '--to', 'ben', '--verify', 'Single usable'])
  await s4.run(benNode, ['done', 'atlas-1', 'done'])
  await s4.verifier().sweep(async () => s4.items)
  assert.equal(s4.started.length, 1)
  assert.equal(s4.started[0]?.body.profile, 'team')
})

test('node failures send the thread to the owner with the reason: offline, no claude, no profile, not logged in, and async launch fail', async () => {
  const baseWorker: Item = {
    key: benNode.key,
    session: BEN_UUID,
    pane: 'wA:p2',
    workspace: 'Atlas',
    cwd: '/srv/atlas',
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'agy',
    device: 'server-1',
  }

  const cases: { label: string; info: VerifyNodeInfo | null; match: RegExp }[] = [
    { label: 'offline', info: { configured: true, online: false, status: nodeStatus() }, match: /not reachable/ },
    {
      label: 'no claude',
      info: { configured: true, online: true, status: nodeStatus({ agents: ['agy'] }) },
      match: /cannot start claude/,
    },
    {
      label: 'no profile',
      info: { configured: true, online: true, status: nodeStatus({ profiles: [] }) },
      match: /has no Claude profile/,
    },
    {
      label: 'not logged in',
      info: {
        configured: true,
        online: true,
        status: nodeStatus({ profiles: [{ id: 'default', loggedIn: false, bundle: null }] }),
      },
      match: /is not logged in to Claude/,
    },
  ]

  for (const c of cases) {
    const s = setupHarness({ workerItem: baseWorker, nodeInfo: () => c.info })
    await s.run(master, ['new', '--to', 'ben', '--verify', `Fail ${c.label}`])
    await s.run(benNode, ['done', 'atlas-1', 'done'])
    await s.verifier().sweep(async () => s.items)
    assert.equal(s.started.length, 0, c.label)
    const h = s.head('atlas-1')
    assert.equal(h.status, 'owner', c.label)
    assert.equal(h.verify?.last, 'error', c.label)
    assert.match(h.waitingOn, c.match, c.label)
  }

  // Offline node with worker absent from items -> still reports device is not reachable.
  const noItems = setupHarness({
    workerItem: baseWorker,
    nodeInfo: () => ({ configured: true, online: false, status: null }),
  })
  await noItems.run(master, ['new', '--to', 'ben', '--verify', 'Offline no item'])
  await noItems.run(benNode, ['done', 'atlas-1', 'done'])
  await noItems.verifier().sweep(async () => [])
  assert.equal(noItems.head('atlas-1').status, 'owner')
  assert.match(noItems.head('atlas-1').waitingOn, /not reachable/)

  // Async failure on node after 202 acceptance (remoteLaunchState -> failed) sends thread to owner.
  const remoteLaunches = new Map<string, LaunchState>()
  const asyncFail = setupHarness({
    workerItem: baseWorker,
    nodeInfo: () => ({ configured: true, online: true, status: nodeStatus() }),
    remoteLaunches,
  })
  await asyncFail.run(master, ['new', '--to', 'ben', '--verify', 'Async fail'])
  await asyncFail.run(benNode, ['done', 'atlas-1', 'done'])
  const v = asyncFail.verifier()
  await v.sweep(async () => asyncFail.items)
  const runKey = asyncFail.head('atlas-1').verify?.run?.key ?? ''
  assert.ok(runKey.startsWith('@server-1:'))
  // Master's local handoff finished (202 from node), then node's own launch failed.
  asyncFail.launches.set('l1', { state: 'done', error: '', sessionId: null })
  remoteLaunches.set(runKey, { state: 'failed', error: 'node disk full', sessionId: null })
  await v.sweep(async () => asyncFail.items)
  const failed = asyncFail.head('atlas-1')
  assert.equal(failed.status, 'owner')
  assert.equal(failed.verify?.last, 'error')
  assert.match(failed.waitingOn, /node disk full/)

  // Queued verifier held past LOST_GRACE_MS on master is NOT killed on the tick it hands off 202.
  const qRemoteLaunches = new Map<string, LaunchState>()
  const queuedLong = setupHarness({
    workerItem: baseWorker,
    nodeInfo: () => ({ configured: true, online: true, status: nodeStatus() }),
    remoteLaunches: qRemoteLaunches,
  })
  await queuedLong.run(master, ['new', '--to', 'ben', '--verify', 'Queued long'])
  await queuedLong.run(benNode, ['done', 'atlas-1', 'done'])
  const qv = queuedLong.verifier()
  await qv.sweep(async () => queuedLong.items)
  const qKey = queuedLong.head('atlas-1').verify?.run?.key ?? ''
  // Queued for 4 minutes before placer accepts 202 from node.
  queuedLong.launches.set('l1', { state: 'queued', error: '', sessionId: null })
  queuedLong.at(NOW + 4 * 60_000)
  await qv.sweep(async () => queuedLong.items)
  assert.equal(queuedLong.head('atlas-1').verify?.run?.key, qKey)
  // Now placer gets 202 (master launch becomes 'done'), node payload has not arrived yet: must NOT fail!
  queuedLong.launches.set('l1', { state: 'done', error: '', sessionId: null })
  await qv.sweep(async () => queuedLong.items)
  assert.equal(queuedLong.head('atlas-1').verify?.run?.key, qKey)
  assert.equal(queuedLong.head('atlas-1').status, 'doing')
  // Only if node never reports a card within LOST_GRACE_MS AFTER handoff does it time out to owner.
  queuedLong.at(NOW + 8 * 60_000)
  await qv.sweep(async () => queuedLong.items)
  assert.equal(queuedLong.head('atlas-1').status, 'owner')
  assert.match(queuedLong.head('atlas-1').waitingOn, /gone from the board/)

  // Restarted master with a queued launch (remoteLaunchState reports queued) keeps waiting, not lost.
  const qRestartedRemote = new Map<string, LaunchState>()
  const restarted = setupHarness({
    workerItem: baseWorker,
    nodeInfo: () => ({ configured: true, online: true, status: nodeStatus() }),
    remoteLaunches: qRestartedRemote,
  })
  await restarted.run(master, ['new', '--to', 'ben', '--verify', 'Adopted queued'])
  await restarted.run(benNode, ['done', 'atlas-1', 'done'])
  await restarted.verifier().sweep(async () => restarted.items)
  const rKey = restarted.head('atlas-1').verify?.run?.key ?? ''
  // Simulate master restart: new verifier instance with empty `started` map, 4 min later, still queued.
  restarted.at(NOW + 4 * 60_000)
  qRestartedRemote.set(rKey, { state: 'queued', error: '', sessionId: null })
  const restartedVerifier = restarted.verifier()
  await restartedVerifier.sweep(async () => restarted.items)
  assert.equal(restarted.head('atlas-1').verify?.run?.key, rKey)
  assert.equal(restarted.head('atlas-1').status, 'doing')
  // If that adopted queued launch later fails in placer, owner sees its refusal reason.
  qRestartedRemote.set(rKey, { state: 'failed', error: 'server-1 is revoked', sessionId: null })
  await restartedVerifier.sweep(async () => restarted.items)
  assert.equal(restarted.head('atlas-1').status, 'owner')
  assert.match(restarted.head('atlas-1').waitingOn, /server-1 is revoked/)
})

test('master worker with nodes configured goes down the exact same local code as before', async () => {
  const dir = isolatedHome()
  const workDir = join(dir, 'local-work')
  mkdirSync(workDir, { recursive: true })
  const localWorker: Item = {
    key: BEN_UUID,
    session: BEN_UUID,
    pane: 'wP:p2',
    workspace: 'Atlas',
    cwd: workDir,
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'claude',
    profile: 'default',
  }
  const s = setupHarness({
    threads: { agents: true, verify: { model: 'opus', profile: 'default' } },
    workerItem: localWorker,
    nodeInfo: () => {
      throw new Error('host.node must not be called for a master worker')
    },
  })
  await s.run(master, ['new', '--to', 'ben', '--verify', 'Local task'])
  await s.run(benLocal, ['done', 'atlas-1', 'done locally'])
  await s.verifier().sweep(async () => s.items)
  assert.equal(s.started.length, 1)
  const { body, options } = s.started[0] as (typeof s.started)[number]
  assert.equal('pin' in body, false)
  assert.equal('remote' in options, false)
  assert.equal(options.parent?.key, BEN_UUID)
  assert.equal(s.counts().nodeCalled, 0)
  assert.equal(s.counts().workspacesCalled, 1)
  const run = s.head('atlas-1').verify?.run
  assert.ok(run && !run.key.startsWith('@'))
  assert.equal(options.sessionId, run.key)
})

test('Claude worker on a node without a known profile fails closed', async () => {
  const worker: Item = {
    key: benNode.key,
    session: BEN_UUID,
    pane: 'wA:p2',
    workspace: 'Atlas',
    cwd: '/srv/atlas',
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'claude',
    device: 'server-1',
  }
  const s = setupHarness({
    threads: { agents: true, verify: true },
    workerItem: worker,
    nodeInfo: () => ({
      configured: true,
      online: true,
      status: nodeStatus({
        profiles: [
          { id: 'default', loggedIn: true, bundle: null },
          { id: 'work', loggedIn: true, bundle: null },
        ],
      }),
    }),
  })
  await s.run(master, ['new', '--to', 'ben', '--verify', 'Missing profile'])
  await s.run(benNode, ['done', 'atlas-1', 'done'])
  await s.verifier().sweep(async () => s.items)
  assert.equal(s.started.length, 0)
  const h = s.head('atlas-1')
  assert.equal(h.status, 'owner')
  assert.equal(h.verify?.last, 'error')
  assert.match(h.waitingOn, /the worker's profile on server-1 is not known/)
})

test('queued verifier is cancelled when verification ends (timeout, owner confirm, or post-restart)', async () => {
  const dir = isolatedHome()
  let now = NOW
  const masterProfile = join(dir, '.claude')
  mkdirSync(masterProfile, { recursive: true })
  writeFileSync(join(masterProfile, '.credentials.json'), '{}')
  const masterProfiles = profileSet(
    [{ id: 'default', title: 'Default', dir: masterProfile, color: 'indigo', hidden: false }],
    masterProfile,
  )
  const cfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    threads: { agents: true, verify: { model: 'opus', limitMin: 30 } },
    nodes: {
      id: 'master-1',
      order: ['local', 'server-1'],
      lanes: ['atlas'],
      devices: {
        'server-1': {
          title: 'Server 1',
          link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
          maxSessions: 1,
          minFreeMemMb: 512,
          maxLoad: 4,
        },
      },
    },
  })

  let awakeSessions = 1
  const currentStatus = (): NodeStatus =>
    nodeStatus({
      sessions: { awake: awakeSessions, working: 0, asleep: 0 },
      at: now,
    })
  const nodeLaunchCalls: unknown[] = []
  const statusListeners: ((id: string) => void)[] = []
  const link: Link = {
    id: 'server-1',
    state: () => ({ state: 'online', since: NOW, heardAt: now }),
    view: () => ({
      id: 'server-1',
      title: 'Server 1',
      kind: 'direct',
      link: { state: 'online', since: NOW, heardAt: now },
      status: currentStatus(),
      sameCommit: true,
      payloadAt: now,
    }),
    payload: () => null,
    status: async () => currentStatus(),
    fetch: async (path, init) => {
      if (path === '/api/node/launch') {
        nodeLaunchCalls.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 202 })
      }
      return new Response('{}', { status: 404 })
    },
    onState: () => () => {},
    onPayload: () => () => {},
    onStatus: () => () => {},
    reconnect: () => {},
    killNow: () => {},
    close: async () => {},
  }
  const bundleSync = createBundleSync({
    cfg,
    links: { link: id => (id === 'server-1' ? link : null) },
    profiles: () => masterProfiles.list,
    store: createDeviceStore(),
    log: () => {},
  })
  let placer!: ReturnType<typeof createPlacer>
  const launches = createLaunches({
    deps: { cfg, profiles: () => masterProfiles, log: () => {} } as unknown as Parameters<
      typeof createLaunches
    >[0]['deps'],
    placer: () => placer,
  })
  placer = createPlacer({
    cfg,
    links: {
      link: id => (id === 'server-1' ? link : null),
      onChange: fn => {
        statusListeners.push(fn)
        return () => {}
      },
    },
    remote: () => ({ items: [], launches: [], schedules: [], devices: [] }),
    launches,
    items: () => [],
    ownStatus: async () => nodeStatus({ id: 'local' }),
    commit: async () => 'abc123',
    bundle: bundleSync,
    log: () => {},
  })

  const worker: Item = {
    key: benNode.key,
    session: BEN_UUID,
    pane: 'wA:p2',
    workspace: 'Atlas',
    cwd: '/srv/atlas',
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'claude',
    profile: 'default',
    device: 'server-1',
  }
  const db = openDb() as BoardDb
  const makeVerifier = () =>
    createVerifier({
      cfg,
      log: () => {},
      start: (body, items, options) => launches.start(body, items, options),
      launchState: id => launches.state(id),
      remoteLaunchState: key => {
        const at = parseNodeKey(key)
        const local = at ? launches.sessionState?.(at.key) : null
        return local && local.state !== 'done' ? local : null
      },
      cancelQueued: (launchId, key) => {
        const at = parseNodeKey(key)
        return launches.cancelQueued?.(launchId ?? '', at?.key ?? key) ?? false
      },
      workspaces: async () => [],
      archive: async () => 'ok',
      withDb: fn => fn(db),
      profiles: () => 1,
      node: () => ({ configured: true, online: true, status: currentStatus() }),
      now: () => now,
    })

  const runCmd = (actor: Party, argv: string[]) =>
    threadCmd(argv, {
      cfg: { threads: cfg.threads, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => (w === 'ben' ? benNode : null),
      db,
      now,
      out: () => {},
      err: () => {},
    })

  try {
    // Case A: time limit expires while verifier is still queued on a full node.
    const verifier = makeVerifier()
    await runCmd(master, ['new', '--to', 'ben', '--verify', 'Queued timeout'])
    await runCmd(benNode, ['done', 'atlas-1', 'ready'])
    await verifier.sweep(async () => [worker])
    await until(() => launches.list().some(l => l.name === 'verify-atlas-1' && l.state === 'queued'), 5000)
    assert.equal(limits().length, 1)

    now = NOW + 31 * 60_000
    await verifier.due(limits()[0] as ScheduleEntry, [worker])
    const timedOut = threadByKey(db, 'atlas-1') as ThreadHead
    assert.equal(timedOut.status, 'owner')
    assert.equal(timedOut.verify?.last, 'timeout')
    assert.equal(launches.list().length, 0)
    assert.equal(limits().length, 0)

    // Node becomes free afterwards -> cancelled launch must never be sent to node.
    awakeSessions = 0
    for (const fn of statusListeners) fn('server-1')
    await Bun.sleep(50)
    assert.equal(nodeLaunchCalls.length, 0)

    // Case B: owner confirms done while verifier is queued -> sweep cancels queued launch immediately.
    awakeSessions = 1
    await runCmd(master, ['new', '--to', 'ben', '--verify', 'Queued confirmed'])
    await runCmd(benNode, ['done', 'atlas-2', 'ready'])
    await verifier.sweep(async () => [worker])
    await until(() => launches.list().some(l => l.name === 'verify-atlas-2' && l.state === 'queued'), 5000)
    assert.equal(limits().length, 1)

    const h2 = threadByKey(db, 'atlas-2') as ThreadHead
    confirmClose({ db, cfg: threadsConfig(cfg.threads) as ThreadsConfig, actor: OWNER, now, me: '' }, h2)
    await verifier.sweep(async () => [worker])
    assert.equal(launches.list().length, 0)
    assert.equal(limits().length, 0)

    awakeSessions = 0
    for (const fn of statusListeners) fn('server-1')
    await Bun.sleep(50)
    assert.equal(nodeLaunchCalls.length, 0)

    // Case C: after a master restart (fresh verifier without launchOf entry), due() cancels queued launch by sessionGiven.
    awakeSessions = 1
    await runCmd(master, ['new', '--to', 'ben', '--verify', 'Queued post-restart'])
    await runCmd(benNode, ['done', 'atlas-3', 'ready'])
    await verifier.sweep(async () => [worker])
    await until(() => launches.list().some(l => l.name === 'verify-atlas-3' && l.state === 'queued'), 5000)

    const restartedVerifier = makeVerifier()
    now += 31 * 60_000
    await restartedVerifier.due(limits()[0] as ScheduleEntry, [worker])
    assert.equal(threadByKey(db, 'atlas-3')?.verify?.last, 'timeout')
    assert.equal(launches.list().length, 0)
    assert.equal(limits().length, 0)

    awakeSessions = 0
    for (const fn of statusListeners) fn('server-1')
    await Bun.sleep(50)
    assert.equal(nodeLaunchCalls.length, 0)
  } finally {
    placer.close()
    bundleSync.close()
    db.close()
  }
})

test('node verifier brief lists file names without master paths and points to board thread show; local brief keeps path', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'verify-brief-'))
  scratch.push(workDir)
  const specFile = join(workDir, 'spec-notes.txt')
  const proofFile = join(workDir, 'proof-report.md')
  writeFileSync(specFile, 'spec')
  writeFileSync(proofFile, 'proof')

  // Node worker brief must not expose master disk paths.
  const nodeWorker: Item = {
    key: benNode.key,
    session: BEN_UUID,
    pane: 'wA:p2',
    workspace: 'Atlas',
    cwd: '/srv/atlas',
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'claude',
    profile: 'default',
    device: 'server-1',
  }
  const sNode = setupHarness({
    workerItem: nodeWorker,
    nodeInfo: () => ({ configured: true, online: true, status: nodeStatus() }),
  })
  assert.equal((await sNode.run(master, ['new', '--to', 'ben', '--verify', 'Check attached files'])).code, 0)
  assert.equal((await sNode.run(master, ['post', 'atlas-1', '--file', specFile, 'spec attached'])).code, 0)
  assert.equal((await sNode.run(benNode, ['done', 'atlas-1', '--file', proofFile, 'done with proof'])).code, 0)
  await sNode.verifier().sweep(async () => sNode.items)
  assert.equal(sNode.started.length, 1)
  const nodeMsg = String(sNode.started[0]?.body.message ?? '')
  assert.match(nodeMsg, /spec-notes\.txt/)
  assert.match(nodeMsg, /proof-report\.md/)
  assert.match(nodeMsg, /board thread show atlas-1/)
  assert.equal(nodeMsg.includes(sNode.dir), false)
  assert.equal(nodeMsg.includes('/threads/files/'), false)

  // Local worker brief still keeps the local master path as before.
  const localWorkDir = join(workDir, 'local-repo')
  mkdirSync(localWorkDir, { recursive: true })
  const localWorker: Item = {
    key: BEN_UUID,
    session: BEN_UUID,
    pane: 'wP:p2',
    workspace: 'Atlas',
    cwd: localWorkDir,
    status: 'idle',
    name: 'ben',
    autoName: 'ben',
    category: 'atlas',
    categorySet: true,
    column: 'work',
    attention: '',
    agent: 'claude',
    profile: 'default',
  }
  const sLocal = setupHarness({
    workerItem: localWorker,
  })
  assert.equal((await sLocal.run(master, ['new', '--to', 'ben', '--verify', 'Local files'])).code, 0)
  assert.equal((await sLocal.run(master, ['post', 'atlas-1', '--file', specFile, 'spec attached'])).code, 0)
  assert.equal((await sLocal.run(benLocal, ['done', 'atlas-1', '--file', proofFile, 'done locally'])).code, 0)
  await sLocal.verifier().sweep(async () => sLocal.items)
  assert.equal(sLocal.started.length, 1)
  const localMsg = String(sLocal.started[0]?.body.message ?? '')
  assert.match(localMsg, /proof-report\.md/)
  assert.equal(localMsg.includes(sLocal.dir), true)
})
