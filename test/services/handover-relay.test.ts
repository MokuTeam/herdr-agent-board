import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import { ensureDoorCert, pinnedTls } from '../../src/adapters/door-cert.ts'
import {
  readHandoverState,
  type TargetBackupCheck,
  takeLocalBackup,
  writeHandoverState,
} from '../../src/adapters/handover-store.ts'
import { createDeviceStore, createNodeStore, nodeRelayKnownHostsReady } from '../../src/adapters/node-store.ts'
import { nodeDir } from '../../src/adapters/paths.ts'
import { formatHandoverPlan } from '../../src/core/master-handover.ts'
import { NODE_API } from '../../src/core/node-door.ts'
import { nodesConfig } from '../../src/core/nodes.ts'
import type { Config } from '../../src/core/types.ts'
import { createNodeListener } from '../../src/server/node-listener.ts'
import { createLocalRelayOps, createNodeHandover, type LocalRelayOps } from '../../src/services/node/handover.ts'
import { createMasterHandover } from '../../src/services/nodes/handover.ts'
import { createLink } from '../../src/services/nodes/link.ts'
import { createRelaySetup } from '../../src/services/nodes/relay-setup.ts'

setDefaultTimeout(20_000)

const COMMIT = 'c'.repeat(40)
const ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'HOME', 'BOARD_HANDOVER_VERIFY_MS'] as const
const CLEANUPS: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (CLEANUPS.length) {
    const fn = CLEANUPS.pop()
    if (fn) await fn()
  }
})

function withIsolatedEnv(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-ho-relay-'))
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  process.env.HOME = root
  process.env.APPDATA = join(root, 'config')
  process.env.LOCALAPPDATA = join(root, 'state')
  process.env.BOARD_HANDOVER_VERIFY_MS = '1000'
  CLEANUPS.push(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

const okBackup = (): TargetBackupCheck => ({
  ok: true,
  detail: 'ready',
  target: 'folder',
  hasKey: true,
})

const makeCfg = (overrides: Partial<Config> = {}): Config =>
  ({
    port: 12422,
    host: '127.0.0.1',
    refreshSec: 2,
    categories: [],
    launch: {
      profiles: [{ id: 'default', title: 'Default', env: {} }],
      claudePath: 'claude',
    },
    tunnel: { on: false },
    team: {},
    ...overrides,
  }) as Config

const stubLink = (handler: (path: string, init?: RequestInit) => Promise<Response>, state = 'online' as const) => ({
  state: () => ({ state, since: Date.now(), heardAt: Date.now() }),
  fetch: handler,
})

describe('handover direct probe & automatic relay setup (#740)', () => {
  test('node-listener tailnet+tls binds on 0.0.0.0, accepts own addresses, and links via directTls while loopback remains unchanged', async () => {
    withIsolatedEnv()
    const cfg = makeCfg({
      node: { id: 'anna-laptop', port: 0, workRoot: '~', listen: 'loopback', tls: false, relay: null },
    })
    const nodeStore = createNodeStore({ dir: nodeDir() })
    const { token } = nodeStore.add('atlas', 'hand')
    const doorCert = ensureDoorCert('anna-laptop', nodeDir())

    // Pick a free port cleanly
    const probeSrv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
    const port = probeSrv.port as number
    await probeSrv.stop(true)
    cfg.node = { id: 'anna-laptop', port, workRoot: '~', listen: 'tailnet', tls: true, relay: null }

    const listener = createNodeListener({
      cfg,
      routes: [
        {
          method: 'GET',
          path: '/api/events',
          handle: () => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        },
      ],
      guards: { csrf: () => null, origin: () => null, boardHeader: () => null, ownFiles: () => null } as never,
      hello: () => ({ ok: true, api: 1, name: 'anna', version: '0.1.0', commit: COMMIT }) as never,
      store: nodeStore,
      doorRoutes: [
        {
          method: 'GET',
          path: '/api/node/status',
          handle: () => Response.json({ api: NODE_API, id: 'anna-laptop' }),
        },
      ],
      doorCert: () => doorCert,
      ownAddresses: () => ['100.88.1.2'],
      hostName: () => 'anna-laptop',
      log: () => {},
    })
    CLEANUPS.push(() => listener.close())
    await listener.sync()
    expect(listener.listening()).toBe(port)

    // Own tailnet address in Host header succeeds with pinned TLS
    const okRes = await fetch(`https://127.0.0.1:${port}/api/hello`, {
      headers: { host: `100.88.1.2:${port}` },
      tls: pinnedTls(doorCert.cert),
    })
    expect(okRes.status).toBe(200)

    // Untrusted Host header is rejected with 403
    const badHost = await fetch(`https://127.0.0.1:${port}/api/hello`, {
      headers: { host: 'evil.example:12430' },
      tls: pinnedTls(doorCert.cert),
    })
    expect(badHost.status).toBe(403)

    // Switching back to loopback must reject non-loopback Host (existing behavior unchanged)
    cfg.node = { id: 'anna-laptop', port, workRoot: '~', listen: 'loopback', tls: false, relay: null }
    await listener.sync()
    const loopbackReject = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      headers: { host: `100.88.1.2:${port}` },
    })
    expect(loopbackReject.status).toBe(403)

    // And createLink direct https:// uses pinned directTls cleanly
    cfg.node = { id: 'anna-laptop', port, workRoot: '~', listen: 'tailnet', tls: true, relay: null }
    await listener.sync()
    const link = createLink({
      device: {
        id: 'anna-laptop',
        title: 'Anna Laptop',
        link: { kind: 'direct', url: `https://127.0.0.1:${port}` },
        maxSessions: null,
        minFreeMemMb: null,
        maxLoad: null,
        tags: [],
        profiles: {},
        paused: false,
        drain: false,
        sinks: {},
        mcp: {},
        accept: [],
      },
      cfg: { deadMs: 5000, statusMs: 5000, pace: 0.05 },
      deps: {
        token: () => token,
        directTls: () => pinnedTls(doorCert.cert),
        clock: {
          now: Date.now,
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
          setInterval: (fn, ms) => setInterval(fn, ms),
          clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
        },
        log: () => {},
      },
    })
    CLEANUPS.push(() => link.close())
    const hello = await link.fetch('/api/hello')
    expect(hello.status === 200 || hello.status === 503).toBe(true)
  })

  test('node/handover probe checks HTTPS + nonce + pinned cert and rejects loopback unless allowed', async () => {
    withIsolatedEnv()
    const doorCert = ensureDoorCert('anna-laptop', nodeDir())
    const nonce = 'probe-nonce-123'
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: doorCert.cert, key: doorCert.key },
      fetch(req) {
        if (new URL(req.url).pathname === '/probe' && req.headers.get('x-probe-nonce') === nonce) {
          return Response.json({ ok: true, nonce })
        }
        return Response.json({ ok: false }, { status: 404 })
      },
    })
    CLEANUPS.push(() => srv.stop(true))

    const nhDefault = createNodeHandover({
      cfg: makeCfg({ node: { id: 'atlas', port: 12430, workRoot: '~', listen: 'loopback', tls: false, relay: null } }),
      nodeStore: createNodeStore({ dir: nodeDir() }),
      commit: async () => COMMIT,
      nodeLinks: () => null,
      tunnelStatus: () => ({ state: 'off', since: Date.now(), attempt: 0, url: null }),
      teamState: () => 'off',
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      log: () => {},
    })
    const rejectedLoopback = await nhDefault.probe({
      urls: [`https://127.0.0.1:${srv.port}`],
      nonce,
      cert: doorCert.cert,
    })
    expect(rejectedLoopback).toEqual({ status: 200, body: { ok: false, error: 'direct-unreachable' } })

    const nhAllowed = createNodeHandover({
      cfg: makeCfg({ node: { id: 'atlas', port: 12430, workRoot: '~', listen: 'loopback', tls: false, relay: null } }),
      nodeStore: createNodeStore({ dir: nodeDir() }),
      commit: async () => COMMIT,
      nodeLinks: () => null,
      tunnelStatus: () => ({ state: 'off', since: Date.now(), attempt: 0, url: null }),
      teamState: () => 'off',
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      allowLoopbackProbe: true,
      log: () => {},
    })
    const matched = await nhAllowed.probe({
      urls: [`https://127.0.0.1:${srv.port}`],
      nonce,
      cert: doorCert.cert,
    })
    expect(matched).toEqual({
      status: 200,
      body: { ok: true, url: `https://127.0.0.1:${srv.port}`, host: '127.0.0.1' },
    })
  })

  test('direct reachability (Tailscale/private IP) picks direct https with tailnet+tls and sets up no relay', async () => {
    withIsolatedEnv()
    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Anna Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 2222, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    let appliedRelay = false
    let appliedPayload: Record<string, unknown> = {}
    const targetLink = stubLink(async (path, init) => {
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: 'linux',
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      if (
        path === '/api/node/handover/prepare' ||
        path === '/api/node/handover/commit' ||
        path === '/api/node/handover/rollback'
      ) {
        return Response.json({ ok: true, id: 'ho-1' })
      }
      if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
      if (path === '/api/node/handover/apply') {
        appliedPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return Response.json({ ok: true, id: 'ho-1' })
      }
      if (path === '/api/node/handover/verify') {
        return Response.json({ ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node online' }] })
      }
      if (path === '/api/node/handover/relay') {
        appliedRelay = true
        return Response.json({ ok: true })
      }
      return Response.json({ ok: false, error: `unexpected ${path}` }, { status: 404 })
    })

    const ho = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      ownAddresses: () => ['127.0.0.1', '100.88.1.2'],
      probeDirect: async ({ addresses, nodePort }) => {
        expect(addresses).toEqual(['100.88.1.2'])
        return { ok: true, host: '100.88.1.2', url: `https://100.88.1.2:${nodePort}` }
      },
      portFree: () => true,
      hostName: () => 'anna-laptop',
      log: () => {},
    })

    const plan = await ho.check({ to: 'server-1' })
    expect(plan.ok).toBe(true)
    expect(plan.relaySetup).toBeUndefined()
    expect(plan.reverseLink).toEqual({ kind: 'direct', url: 'https://100.88.1.2:12430' })
    expect(appliedRelay).toBe(false)

    const res = await ho.run({ to: 'server-1' })
    expect(res.ok).toBe(true)
    expect(appliedRelay).toBe(false)
    expect(appliedPayload?.relayApplied).toBeUndefined()
    const flipped = appliedPayload?.flippedNodes as Record<string, unknown>
    expect(flipped.relay).toBeUndefined()
    const finalCfg = JSON.parse(readFileSync(configFile(), 'utf8')) as { node?: Record<string, unknown> }
    expect(finalCfg.node).toMatchObject({ id: 'laptop', listen: 'tailnet', tls: true })
    expect(finalCfg.node?.relay).toBeUndefined()
  })

  test('behind NAT without relay sets up relay on Linux target, enrols dial key, writes valid nodes.relay, and dry-run lists it', async () => {
    withIsolatedEnv()
    const store = createDeviceStore()
    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Anna Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 2222, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    const relayCalls: Record<string, unknown>[] = []
    let appliedPayload: Record<string, unknown> = {}
    const nh = createNodeHandover({
      cfg: makeCfg({
        node: { id: 'server-1', port: 12430, workRoot: '~', listen: 'loopback', tls: false, relay: null },
      }),
      nodeStore: createNodeStore({ dir: nodeDir() }),
      commit: async () => COMMIT,
      nodeLinks: () => null,
      tunnelStatus: () => ({ state: 'off', since: Date.now(), attempt: 0, url: null }),
      teamState: () => 'off',
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      relayOps: {
        async check(o) {
          relayCalls.push({ op: 'check', ...o })
          return { ok: true, user: 'agent-board-relay-m' }
        },
        async apply(o) {
          relayCalls.push({ op: 'apply', ...o })
          return {
            ok: true,
            user: 'agent-board-relay-m',
            hostKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey'],
          }
        },
        async enrolAdd(o) {
          relayCalls.push({ op: 'enrol-add', ...o })
          return { ok: true, user: 'agent-board-relay-m' }
        },
        async undo(o) {
          relayCalls.push({ op: 'undo', ...o })
          return { ok: true, user: 'agent-board-relay-m' }
        },
      },
      log: () => {},
    })

    const targetLink = stubLink(async (path, init) => {
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: 'linux',
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      if (path === '/api/node/handover/relay') {
        const r = await nh.relay(JSON.parse(String(init?.body ?? '{}')))
        return Response.json(r.body, { status: r.status })
      }
      if (path === '/api/node/handover/prepare' || path === '/api/node/handover/commit') {
        return Response.json({ ok: true, id: 'ho-1' })
      }
      if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
      if (path === '/api/node/handover/apply') {
        appliedPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return Response.json({ ok: true, id: 'ho-1' })
      }
      if (path === '/api/node/handover/verify') {
        return Response.json({ ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node online' }] })
      }
      return Response.json({ ok: false }, { status: 404 })
    })

    const ho = createMasterHandover({
      cfg: rawCfg,
      store,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      ownAddresses: () => ['127.0.0.1'],
      probeDirect: async () => ({ ok: false }),
      portFree: () => true,
      generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
      hostName: () => 'anna-laptop',
      log: () => {},
    })

    const plan = await ho.check({ to: 'server-1' })
    expect(plan.ok).toBe(true)
    expect(plan.relaySetup).toEqual({
      host: 'atlas.example.com',
      sshPort: 2222,
      user: 'agent-board-relay-m',
      needsSudoPassword: false,
    })
    expect(formatHandoverPlan(plan).some(l => l.includes('relay') && l.includes('atlas.example.com:2222'))).toBe(true)

    const res = await ho.run({ to: 'server-1' })
    expect(res.ok).toBe(true)
    expect(relayCalls.map(c => c.op)).toEqual(['check', 'check', 'apply', 'enrol-add'])
    expect(appliedPayload?.relayApplied).toBe(true)
    const flipped = appliedPayload?.flippedNodes as Record<string, unknown>
    const parsed = nodesConfig(flipped)
    expect(parsed?.problems).toEqual([])
    expect(parsed?.relay).toEqual({ host: 'atlas.example.com', sshPort: 2222, user: 'agent-board-relay-m' })
    const kh = readFileSync(nodeRelayKnownHostsReady(nodeDir()), 'utf8')
    expect(kh).toContain('[atlas.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey')
    expect(readHandoverState()?.relayApplied).toBe(true)
  })

  test('prompts once for sudo password when required, keeps it memory-only, and refuses incompatible targets plainly', async () => {
    withIsolatedEnv()
    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 22, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    let targetPlatform = 'darwin'
    let sudoCheckResult: Awaited<ReturnType<LocalRelayOps['check']>> = {
      ok: false,
      need: 'sudoPassword',
      error: 'sudo password required',
    }
    const logs: string[] = []
    const nh = createNodeHandover({
      cfg: makeCfg({
        node: { id: 'server-1', port: 12430, workRoot: '~', listen: 'loopback', tls: false, relay: null },
      }),
      nodeStore: createNodeStore({ dir: nodeDir() }),
      commit: async () => COMMIT,
      nodeLinks: () => null,
      tunnelStatus: () => ({ state: 'off', since: Date.now(), attempt: 0, url: null }),
      teamState: () => 'off',
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      relayOps: {
        check: async ({ sudoPassword }) => {
          if (sudoPassword === 'top-secret-pw') return { ok: true, user: 'agent-board-relay-m' }
          return sudoCheckResult
        },
        apply: async ({ sudoPassword }) => {
          if (sudoPassword === 'top-secret-pw') return { ok: true, user: 'agent-board-relay-m' }
          return { ok: false, need: 'sudoPassword', error: 'sudo password required' }
        },
        enrolAdd: async () => ({ ok: true, user: 'agent-board-relay-m' }),
        undo: async () => ({ ok: true, user: 'agent-board-relay-m' }),
      },
      log: t => logs.push(t),
    })

    const targetLink = stubLink(async (path, init) => {
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: targetPlatform,
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      if (path === '/api/node/handover/relay') {
        const r = await nh.relay(JSON.parse(String(init?.body ?? '{}')))
        return Response.json(r.body, { status: r.status })
      }
      if (
        path === '/api/node/handover/prepare' ||
        path === '/api/node/handover/apply' ||
        path === '/api/node/handover/commit'
      ) {
        return Response.json({ ok: true, id: 'ho-1' })
      }
      if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
      if (path === '/api/node/handover/verify') {
        return Response.json({ ok: true, checks: [{ name: 'nodes', ok: true, detail: 'ok' }] })
      }
      return Response.json({ ok: false }, { status: 404 })
    })

    const ho = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => ({ ok: false }),
      portFree: () => true,
      generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
      hostName: () => 'laptop',
      log: t => logs.push(t),
    })

    // Non-Linux target refused in one plain sentence
    const darwinPlan = await ho.check({ to: 'server-1' })
    expect(darwinPlan.ok).toBe(false)
    expect(darwinPlan.errors[0]).toContain('darwin')
    expect(darwinPlan.errors[0]).toContain('Linux')

    // Missing sshd / missing root refused plainly
    targetPlatform = 'linux'
    sudoCheckResult = { ok: false, error: 'target server cannot run relay setup without root or sudo access' }
    const noRootPlan = await ho.check({ to: 'server-1' })
    expect(noRootPlan.ok).toBe(false)
    expect(noRootPlan.errors[0]).toContain('root or sudo')

    // Password sudo prompts once, then succeeds when supplied and never saves/logs it
    sudoCheckResult = { ok: false, need: 'sudoPassword', error: 'sudo password required' }
    const needPwPlan = await ho.check({ to: 'server-1' })
    expect(needPwPlan.ok).toBe(false)
    expect(needPwPlan.relaySetup?.needsSudoPassword).toBe(true)
    expect(ho.view().need).toBe('sudoPassword')

    const runOk = await ho.run({ to: 'server-1', sudoPassword: 'top-secret-pw' })
    expect(runOk.ok).toBe(true)
    expect(logs.join('\n')).not.toContain('top-secret-pw')
    expect(readFileSync(configFile(), 'utf8')).not.toContain('top-secret-pw')
    expect(JSON.stringify(readHandoverState())).not.toContain('top-secret-pw')
  })

  test('pre-commit autoRollback and post-commit rollback undo the relay setup performed by handover', async () => {
    withIsolatedEnv()
    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 22, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    const relayOpsLog: string[] = []
    const nh = createNodeHandover({
      cfg: makeCfg({
        node: { id: 'server-1', port: 12430, workRoot: '~', listen: 'loopback', tls: false, relay: null },
      }),
      nodeStore: createNodeStore({ dir: nodeDir() }),
      commit: async () => COMMIT,
      nodeLinks: () => null,
      tunnelStatus: () => ({ state: 'off', since: Date.now(), attempt: 0, url: null }),
      teamState: () => 'off',
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      relayOps: {
        check: async () => ({ ok: true, user: 'agent-board-relay-m' }),
        apply: async () => {
          relayOpsLog.push('target-apply')
          return { ok: true, user: 'agent-board-relay-m' }
        },
        enrolAdd: async () => {
          relayOpsLog.push('target-enrol-add')
          return { ok: true, user: 'agent-board-relay-m' }
        },
        undo: async () => {
          relayOpsLog.push('target-undo')
          return { ok: true, user: 'agent-board-relay-m' }
        },
      },
      log: () => {},
    })

    const targetLink = stubLink(async (path, init) => {
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: 'linux',
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      if (path === '/api/node/handover/relay') {
        const r = await nh.relay(JSON.parse(String(init?.body ?? '{}')))
        return Response.json(r.body, { status: r.status })
      }
      if (path === '/api/node/handover/prepare') {
        const r = await nh.prepare(JSON.parse(String(init?.body ?? '{}')))
        return Response.json(r.body, { status: r.status })
      }
      if (path === '/api/node/handover/rollback') {
        const r = await nh.rollback(JSON.parse(String(init?.body ?? '{}')))
        return Response.json(r.body, { status: r.status })
      }
      if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
      if (path === '/api/node/handover/apply') return Response.json({ ok: true, id: 'ho-fail' })
      if (path === '/api/node/handover/verify') {
        return Response.json({ ok: true, checks: [{ name: 'nodes', ok: false, detail: 'simulated failure' }] })
      }
      return Response.json({ ok: false }, { status: 404 })
    })

    const hoOld = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => ({ ok: false }),
      portFree: () => true,
      generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
      hostName: () => 'laptop',
      log: () => {},
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    })

    const failed = await hoOld.run({ to: 'server-1' })
    expect(failed.ok).toBe(false)
    expect(failed.rolledBack).toBe(true)
    expect(relayOpsLog).toContain('target-apply')
    expect(relayOpsLog).toContain('target-undo')

    // Committed rollback on new-master also invokes undoLocalRelay
    const localUndoCalls: string[] = []
    takeLocalBackup('ho-committed', Date.now())
    writeHandoverState({
      v: 1,
      id: 'ho-committed',
      role: 'new-master',
      phase: 'committed',
      from: 'laptop',
      to: 'server-1',
      peerId: 'laptop',
      otherNodes: [],
      enrolledSocket: 'laptop',
      relayApplied: true,
      at: Date.now(),
    })
    const newMasterCfg = makeCfg({
      nodes: {
        id: 'server-1',
        order: ['local', 'laptop'],
        relay: { host: 'atlas.example.com', sshPort: 2222, user: 'agent-board-relay-m' },
        devices: { local: { title: 'Atlas' }, laptop: { title: 'Laptop', link: { kind: 'relay', socket: 'laptop' } } },
      },
    })
    let remoteRollbackCalled = false
    const oldMasterLink = stubLink(async () => {
      remoteRollbackCalled = true
      return Response.json({ ok: true, restored: 0, removed: 0 })
    })
    const hoNew = createMasterHandover({
      cfg: newMasterCfg,
      links: () => ({
        on: () => true,
        link: () => oldMasterLink as never,
        view: () => ({ devices: [], problems: [] }),
      }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      enrolRemove: async () => ({ ok: true, removed: true }),
      checkLocalRelay: async ({ sudoPassword }) => {
        if (sudoPassword === 'good-pw') return { ok: true, user: 'agent-board-relay-m' }
        return { ok: false, need: 'sudoPassword', error: 'sudo password required or wrong' }
      },
      undoLocalRelay: async uo => {
        localUndoCalls.push(`${uo.host}:${uo.sshPort}`)
        return { ok: true, user: 'agent-board-relay-m' }
      },
      log: () => {},
    })
    const rbBad = await hoNew.rollback({ discardSinceCommit: true, sudoPassword: 'wrong-pw' })
    expect(rbBad.ok).toBe(false)
    expect(rbBad.need).toBe('sudoPassword')
    expect(hoNew.view().need).toBe('sudoPassword')
    expect(remoteRollbackCalled).toBe(false)

    const rb = await hoNew.rollback({ discardSinceCommit: true, sudoPassword: 'good-pw' })
    expect(rb.ok).toBe(true)
    expect(remoteRollbackCalled).toBe(true)
    expect(localUndoCalls).toEqual(['atlas.example.com:2222'])
    expect(readHandoverState()?.phase).toBe('rolled-back')
  })

  test('setups with existing nodes.relay, loopback direct, or --reverse-link do not invoke direct probe or target relay setup', async () => {
    withIsolatedEnv()
    const nodesDirPath = join(process.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'nodes', 'relay')
    mkdirSync(nodesDirPath, { recursive: true })
    writeFileSync(join(nodesDirPath, 'master-key'), 'fake')
    writeFileSync(join(nodesDirPath, 'enrol-key'), 'fake')

    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        relay: { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-m' },
        devices: {
          local: { title: 'Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 22, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    let touchedProbeOrRelay = false
    const targetLink = stubLink(async path => {
      if (path === '/api/node/handover/probe' || path === '/api/node/handover/relay') {
        touchedProbeOrRelay = true
      }
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: 'linux',
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      return Response.json({ ok: false }, { status: 404 })
    })

    const ho = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => {
        touchedProbeOrRelay = true
        return { ok: false }
      },
      portFree: () => true,
      hostName: () => 'laptop',
      log: () => {},
    })

    const planExistingRelay = await ho.check({ to: 'server-1' })
    expect(planExistingRelay.ok).toBe(true)
    expect(planExistingRelay.relaySetup).toBeUndefined()
    expect(planExistingRelay.reverseLink).toEqual({ kind: 'relay', socket: 'laptop' })

    const planOverride = await ho.check({ to: 'server-1', reverseLink: 'direct:https://custom.example.com:12430' })
    expect(planOverride.ok).toBe(true)
    expect(planOverride.relaySetup).toBeUndefined()
    expect(planOverride.reverseLink).toEqual({ kind: 'direct', url: 'https://custom.example.com:12430' })

    const loopbackCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Laptop' },
          'server-1': { title: 'Atlas', link: { kind: 'direct', url: 'http://127.0.0.1:12430' } },
        },
      },
    })
    const hoLoopback = createMasterHandover({
      cfg: loopbackCfg,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => {
        touchedProbeOrRelay = true
        return { ok: false }
      },
      portFree: () => true,
      hostName: () => 'laptop',
      log: () => {},
    })
    const planLoopback = await hoLoopback.check({ to: 'server-1' })
    expect(planLoopback.ok).toBe(true)
    expect(planLoopback.relaySetup).toBeUndefined()
    expect(planLoopback.reverseLink).toEqual({ kind: 'direct', url: 'http://127.0.0.1:12430' })
    expect(touchedProbeOrRelay).toBe(false)
  })

  test('--local-only rollback on old-master skips local relay undo even when relayApplied is set (#741 review)', async () => {
    withIsolatedEnv()
    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: { local: { title: 'Laptop' } },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))
    takeLocalBackup('ho-old-local', Date.now())
    writeHandoverState({
      v: 1,
      id: 'ho-old-local',
      role: 'old-master',
      phase: 'committed',
      from: 'laptop',
      to: 'server-1',
      peerId: 'server-1',
      otherNodes: [],
      enrolledSocket: 'laptop',
      relayApplied: true,
      at: Date.now(),
    })

    let undoCalled = false
    const ho = createMasterHandover({
      cfg: rawCfg,
      links: () => null,
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      undoLocalRelay: async () => {
        undoCalled = true
        return { ok: false, error: 'must not run on old-master' }
      },
      log: () => {},
    })
    const res = await ho.rollback({ localOnly: true })
    expect(res.ok).toBe(true)
    expect(undoCalled).toBe(false)
    expect(readHandoverState()?.phase).toBe('rolled-back')
  })

  test('failed target relay undo in autoRollback and pre-commit manual rollback is logged, reported, and not treated as rolled back (#741 review)', async () => {
    withIsolatedEnv()
    const rawCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 2222, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    const logs: string[] = []
    const targetLinkAuto = stubLink(async (path, init) => {
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: 'linux',
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      if (path === '/api/node/handover/relay') {
        const b = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
        if (b.op === 'check' || b.op === 'apply' || b.op === 'enrol-add') {
          return Response.json({ ok: true, user: 'agent-board-relay-m', hostKeys: ['ssh-ed25519 AAAAC3Key'] })
        }
        if (b.op === 'undo') {
          return Response.json(
            { ok: false, need: 'sudoPassword', error: 'sudo password required for undo' },
            { status: 409 },
          )
        }
      }
      if (
        path === '/api/node/handover/prepare' ||
        path === '/api/node/handover/apply' ||
        path === '/api/node/handover/rollback'
      ) {
        return Response.json({ ok: true, id: 'ho-x' })
      }
      if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
      if (path === '/api/node/handover/verify') {
        return Response.json({ ok: true, checks: [{ name: 'nodes', ok: false, detail: 'verify failed' }] })
      }
      return Response.json({ ok: false }, { status: 404 })
    })

    const hoAuto = createMasterHandover({
      cfg: rawCfg,
      links: () => ({
        on: () => true,
        link: () => targetLinkAuto as never,
        view: () => ({ devices: [], problems: [] }),
      }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => ({ ok: false }),
      portFree: () => true,
      generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
      hostName: () => 'laptop',
      log: t => logs.push(t),
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    })

    const autoRes = await hoAuto.run({ to: 'server-1' })
    expect(autoRes.ok).toBe(false)
    expect(autoRes.rolledBack).toBe(false)
    expect(autoRes.error).toContain('target relay undo failed: sudo password required for undo')
    expect(autoRes.need).toBe('sudoPassword')
    expect(hoAuto.view().phase).toBe('failed')
    expect(logs.some(l => l.includes('target relay undo failed: sudo password required for undo'))).toBe(true)

    // Pre-commit manual rollback on old-master checks relay undo response as well
    logs.length = 0
    takeLocalBackup('ho-precommit', Date.now())
    writeHandoverState({
      v: 1,
      id: 'ho-precommit',
      role: 'old-master',
      phase: 'prepared',
      from: 'laptop',
      to: 'server-1',
      peerId: 'server-1',
      otherNodes: [],
      enrolledSocket: 'laptop',
      relayApplied: true,
      at: Date.now(),
    })
    const manualRes = await hoAuto.rollback()
    expect(manualRes.ok).toBe(false)
    expect(manualRes.error).toContain('target relay undo failed: sudo password required for undo')
    expect(manualRes.need).toBe('sudoPassword')
    expect(hoAuto.view().phase).toBe('failed')
    expect(hoAuto.view().rolledBack).toBe(false)
    expect(logs.some(l => l.includes('target relay undo failed: sudo password required for undo'))).toBe(true)
  })

  test('createLocalRelayOps with real createRelaySetup + stubbed spawnLocal produces nodes.relay and rejects empty SSH host keys (#741 review)', async () => {
    withIsolatedEnv()
    const rawCfg = makeCfg({
      node: { id: 'server-1', port: 12430, workRoot: '~', listen: 'loopback', tls: false, relay: null },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    const spawnCalls: string[] = []
    const stubSpawnLocal = (command: string) => {
      const listeners: ((line: string, from: 'out' | 'err') => void)[] = []
      const b64 = /echo ([A-Za-z0-9+/=]+) \| base64/.exec(command)?.[1] ?? ''
      const script = Buffer.from(b64, 'base64').toString('utf8')
      const done = (async () => {
        await Promise.resolve()
        const emit = (lines: string[]) => {
          for (const line of lines) for (const fn of listeners) fn(line, 'out')
        }
        if (script.includes('# agent-board: probe')) {
          spawnCalls.push('probe')
          emit(['@@uid 0', '@@sudo ok', '@@flavor Sudo version 1.9.16p2'])
          return { code: 0, error: null }
        }
        if (script.includes('@@sshd-t')) {
          spawnCalls.push('look')
          emit([
            '@@os debian 13',
            '@@pretty Debian 13',
            '@@ssh OpenSSH_9.6p1',
            '@@hostname atlas',
            '@@sudo root',
            '@@has sshd',
            '@@has useradd',
            '@@has usermod',
            '@@has userdel',
            '@@has install',
            '@@has flock',
            '@@node-user none',
            '@@master-user none',
            '@@sockets-dir none',
            '@@keys-dir none',
            '@@auth-keys-dir yes',
            '@@keys-cmd none',
            '@@enrol none',
            '@@master-keys none',
            '@@fence none',
            '@@block whole',
            '@@include yes',
            '@@sshd-t ok',
            '@@candidate ok',
            '@@enrolled 0',
            '@@end',
          ])
          return { code: 0, error: null }
        }
        spawnCalls.push('apply')
        emit(['@@result applied'])
        return { code: 0, error: null }
      })()
      return {
        onLine: (fn: (line: string, from: 'out' | 'err') => void) => void listeners.push(fn),
        done,
        kill: () => {},
      }
    }

    // Missing SSH host keys fails cleanly
    const opsNoKeys = createLocalRelayOps({
      cfg: rawCfg,
      createSetup: deps => createRelaySetup(deps as never),
      platform: () => 'linux',
      spawnLocal: stubSpawnLocal,
      sshHostKeys: () => [],
      hostName: () => 'atlas',
      log: () => {},
    })
    const noKeysRes = await opsNoKeys.apply({ host: 'atlas.example.com', sshPort: 2222 })
    expect(noKeysRes.ok).toBe(false)
    expect(noKeysRes.ok ? '' : noKeysRes.error).toContain('no local SSH host public keys')

    // With host keys present, look + apply + finish run through real createRelaySetup and produce valid nodes.relay
    const ops = createLocalRelayOps({
      cfg: rawCfg,
      createSetup: deps => createRelaySetup(deps as never),
      platform: () => 'linux',
      spawnLocal: stubSpawnLocal,
      sshHostKeys: () => ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRealSetupHostKey'],
      hostName: () => 'atlas',
      log: () => {},
    })
    const nh = createNodeHandover({
      cfg: rawCfg,
      nodeStore: createNodeStore({ dir: nodeDir() }),
      commit: async () => COMMIT,
      nodeLinks: () => null,
      tunnelStatus: () => ({ state: 'off', since: Date.now(), attempt: 0, url: null }),
      teamState: () => 'off',
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      relayOps: ops,
      log: () => {},
    })

    const masterCfg = makeCfg({
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 2222, user: 'agent-board', port: 12430 },
          },
        },
      },
    })
    writeFileSync(configFile(), JSON.stringify(masterCfg, null, 2))
    let appliedPayload: Record<string, unknown> = {}
    const targetLink = stubLink(async (path, init) => {
      if (path.startsWith('/api/node/handover/check')) {
        return Response.json({
          ok: true,
          id: 'server-1',
          commit: COMMIT,
          platform: 'linux',
          arch: 'x64',
          hostname: 'atlas',
          selfNames: ['atlas'],
          hasNodes: false,
          freeMb: 5000,
          backup: okBackup(),
        })
      }
      if (path === '/api/node/handover/relay') {
        const b = JSON.parse(String(init?.body ?? '{}')) as { op?: string }
        if (b.op === 'enrol-add') return Response.json({ ok: true, user: 'agent-board-relay-m' })
        const r = await nh.relay(b)
        return Response.json(r.body, { status: r.status })
      }
      if (path === '/api/node/handover/prepare' || path === '/api/node/handover/commit') {
        return Response.json({ ok: true, id: 'ho-real' })
      }
      if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
      if (path === '/api/node/handover/apply') {
        appliedPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return Response.json({ ok: true, id: 'ho-real' })
      }
      if (path === '/api/node/handover/verify') {
        return Response.json({ ok: true, checks: [{ name: 'nodes', ok: true, detail: 'ok' }] })
      }
      return Response.json({ ok: false }, { status: 404 })
    })

    const ho = createMasterHandover({
      cfg: masterCfg,
      links: () => ({ on: () => true, link: () => targetLink as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => ({ ok: false }),
      portFree: () => true,
      generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
      hostName: () => 'laptop',
      log: () => {},
    })

    const res = await ho.run({ to: 'server-1' })
    expect(res.ok).toBe(true)
    expect(spawnCalls).toContain('probe')
    expect(spawnCalls).toContain('look')
    expect(spawnCalls).toContain('apply')
    const flipped = appliedPayload.flippedNodes as Record<string, unknown>
    expect(nodesConfig(flipped)?.relay).toEqual({
      host: 'atlas.example.com',
      sshPort: 2222,
      user: 'agent-board-relay-m',
    })
  })
})
