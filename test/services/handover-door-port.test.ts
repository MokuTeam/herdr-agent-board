import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import type { TargetBackupCheck } from '../../src/adapters/handover-store.ts'
import { createNodeStore } from '../../src/adapters/node-store.ts'
import { nodeDir } from '../../src/adapters/paths.ts'
import { NODE_API } from '../../src/core/node-door.ts'
import type { Config } from '../../src/core/types.ts'
import { createNodeListener } from '../../src/server/node-listener.ts'
import { createMasterHandover } from '../../src/services/nodes/handover.ts'
import { unusedPort } from '../support/board-server.ts'

setDefaultTimeout(20_000)

const COMMIT = 'd'.repeat(40)
const ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'HOME', 'BOARD_HANDOVER_VERIFY_MS'] as const
const CLEANUPS: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (CLEANUPS.length) {
    const fn = CLEANUPS.pop()
    if (fn) await fn()
  }
})

function withIsolatedEnv(): string {
  const root = mkdtempSync(join(tmpdir(), 'ab-ho-door-'))
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  process.env.HOME = root
  process.env.APPDATA = join(root, 'config')
  process.env.LOCALAPPDATA = join(root, 'state')
  process.env.BOARD_HANDOVER_VERIFY_MS = '200'
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

const stubLink = (handler: (path: string, init?: RequestInit) => Promise<Response>) => ({
  state: () => ({ state: 'online' as const, since: Date.now(), heardAt: Date.now() }),
  fetch: handler,
})

function makeTargetStub(opts: { verifyNodesDetail?: string } = {}) {
  const calls: string[] = []
  let appliedPayload: Record<string, unknown> = {}
  const link = stubLink(async (path, init) => {
    calls.push(path)
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
      return Response.json({ ok: true, user: 'agent-board-relay-m', hostKeys: ['ssh-ed25519 AAAAC3Key'] })
    }
    if (
      path === '/api/node/handover/prepare' ||
      path === '/api/node/handover/commit' ||
      path === '/api/node/handover/rollback'
    ) {
      return Response.json({ ok: true, id: 'ho-door' })
    }
    if (path === '/api/node/handover/bundle') return Response.json({ ok: true })
    if (path === '/api/node/handover/apply') {
      appliedPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json({ ok: true, id: 'ho-door' })
    }
    if (path === '/api/node/handover/verify') {
      if (opts.verifyNodesDetail) {
        return Response.json({ ok: false, checks: [{ name: 'nodes', ok: false, detail: opts.verifyNodesDetail }] })
      }
      return Response.json({ ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node(s) online' }] })
    }
    return Response.json({ ok: false }, { status: 404 })
  })
  return { link, calls, applied: () => appliedPayload }
}

describe('handover door port check, auto-pick, and verify diagnostics (#742)', () => {
  test('real bind test detects taken port, auto-picks free port in plan, and writes it to node config', async () => {
    withIsolatedEnv()
    const takenPort = await unusedPort()
    const holder = Bun.serve({
      hostname: '127.0.0.1',
      port: takenPort,
      idleTimeout: 0,
      reusePort: false,
      fetch: () => new Response('busy'),
    })
    CLEANUPS.push(() => holder.stop(true))

    const rawCfg = makeCfg({
      node: { id: 'laptop', port: takenPort, workRoot: '~', listen: 'loopback', tls: false, relay: null },
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          local: { title: 'Anna Laptop' },
          'server-1': { title: 'Atlas', link: { kind: 'direct', url: 'http://127.0.0.1:12439' } },
        },
      },
    })
    mkdirSync(dirname(configFile()), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))

    const target = makeTargetStub()
    const ho = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => target.link as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      hostName: () => 'laptop',
      log: () => {},
    })

    const plan = await ho.check({ to: 'server-1' })
    expect(plan.ok).toBe(true)
    expect(plan.nodePort).toBeGreaterThan(takenPort)
    expect(plan.checks.find(c => c.id === 'doorPort')).toEqual({
      id: 'doorPort',
      ok: true,
      blocking: true,
      detail: `127.0.0.1:${takenPort} is in use; auto-picked ${plan.nodePort}`,
    })
    expect(plan.reverseLink).toEqual({ kind: 'direct', url: `http://127.0.0.1:${plan.nodePort}` })

    const run = await ho.run({ to: 'server-1' })
    expect(run.ok).toBe(true)
    const finalCfg = JSON.parse(readFileSync(configFile(), 'utf8')) as { node?: { port?: number } }
    expect(finalCfg.node?.port).toBe(plan.nodePort)
  })

  test('default port 12430 taken auto-picks 12431 for relay and direct handovers, and free port keeps 12430', async () => {
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

    const target = makeTargetStub()
    const hoAuto = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => target.link as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => ({ ok: false }),
      portFree: p => p !== 12430,
      generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
      hostName: () => 'laptop',
      log: () => {},
    })

    const planTaken = await hoAuto.check({ to: 'server-1' })
    expect(planTaken.ok).toBe(true)
    expect(planTaken.nodePort).toBe(12431)
    expect(planTaken.checks.find(c => c.id === 'doorPort')?.detail).toContain('auto-picked 12431')

    const runTaken = await hoAuto.run({ to: 'server-1' })
    expect(runTaken.ok).toBe(true)
    const cfgAfterTaken = JSON.parse(readFileSync(configFile(), 'utf8')) as { node?: { port?: number } }
    expect(cfgAfterTaken.node?.port).toBe(12431)

    // Setup with free 12430 keeps 12430 unchanged
    writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))
    const hoFree = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => target.link as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async ({ nodePort }) => ({
        ok: true,
        host: '100.88.1.2',
        url: `https://100.88.1.2:${nodePort}`,
      }),
      portFree: () => true,
      hostName: () => 'laptop',
      log: () => {},
    })
    const planFree = await hoFree.check({ to: 'server-1' })
    expect(planFree.ok).toBe(true)
    expect(planFree.nodePort).toBe(12430)
    expect(planFree.reverseLink).toEqual({ kind: 'direct', url: 'https://100.88.1.2:12430' })
    expect(planFree.checks.find(c => c.id === 'doorPort')?.detail).toBe('127.0.0.1:12430 is free')
  })

  test('explicit --node-port that is taken refuses in preflight with one plain sentence naming the port', async () => {
    withIsolatedEnv()
    const takenPort = await unusedPort()
    const holder = Bun.serve({
      hostname: '127.0.0.1',
      port: takenPort,
      idleTimeout: 0,
      reusePort: false,
      fetch: () => new Response('busy'),
    })
    CLEANUPS.push(() => holder.stop(true))

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
    const target = makeTargetStub()
    const ho = createMasterHandover({
      cfg: rawCfg,
      links: () => ({ on: () => true, link: () => target.link as never, view: () => ({ devices: [], problems: [] }) }),
      commit: async () => COMMIT,
      setFreeze: () => {},
      beforeDbReplace: () => {},
      afterDbReplace: () => {},
      reloadConfig: async () => {},
      probeDirect: async () => ({ ok: false }),
      hostName: () => 'laptop',
      log: () => {},
    })

    const plan = await ho.check({ to: 'server-1', nodePort: takenPort })
    expect(plan.ok).toBe(false)
    expect(plan.checks.find(c => c.id === 'doorPort')).toEqual({
      id: 'doorPort',
      ok: false,
      blocking: true,
      detail: `node door port ${takenPort} on 127.0.0.1 is already in use`,
    })
    expect(plan.errors).toContain(`node door port ${takenPort} on 127.0.0.1 is already in use`)

    const run = await ho.run({ to: 'server-1', nodePort: takenPort })
    expect(run.ok).toBe(false)
    expect(run.error).toContain(String(takenPort))
    expect(target.calls.some(c => c.includes('/prepare') || c.includes('/apply'))).toBe(false)
  })

  test('handover verify error carries old master door/relay-dial reason when old master is not online', async () => {
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

    const runVerifyWithDiag = async (
      verifyNodesDetail: string,
      diag: Parameters<NonNullable<Parameters<typeof createMasterHandover>[0]['localDoor']>> extends never[]
        ? ReturnType<NonNullable<Parameters<typeof createMasterHandover>[0]['localDoor']>>
        : never,
    ) => {
      writeFileSync(configFile(), JSON.stringify(rawCfg, null, 2))
      const target = makeTargetStub({ verifyNodesDetail })
      const ho = createMasterHandover({
        cfg: rawCfg,
        links: () => ({
          on: () => true,
          link: () => target.link as never,
          view: () => ({ devices: [], problems: [] }),
        }),
        commit: async () => COMMIT,
        setFreeze: () => {},
        beforeDbReplace: () => {},
        afterDbReplace: () => {},
        reloadConfig: async () => {},
        probeDirect: async () => ({ ok: false }),
        portFree: () => true,
        localDoor: () => diag,
        generateKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDialPubKey test' }),
        hostName: () => 'laptop',
        log: () => {},
        verifyTimeoutMs: 20,
        verifyPollMs: 5,
      })
      return ho.run({ to: 'server-1' })
    }

    const doorNotListening = await runVerifyWithDiag('not online: laptop (connecting)', {
      listening: null,
      error: 'Cannot listen on 127.0.0.1:12430: EADDRINUSE',
      relay: null,
    })
    expect(doorNotListening.ok).toBe(false)
    expect(doorNotListening.error).toContain(
      'not online: laptop (connecting); laptop: door not listening on port 12430 (Cannot listen on 127.0.0.1:12430: EADDRINUSE)',
    )
    expect(doorNotListening.verify?.checks.find(c => c.name === 'nodes')?.detail).toContain(
      'door not listening on port 12430',
    )

    const relayIdle = await runVerifyWithDiag('not online: laptop (connecting)', {
      listening: 12430,
      error: null,
      relay: { state: 'off', idleReason: 'no relay key at /state/node/relay-key' },
    })
    expect(relayIdle.ok).toBe(false)
    expect(relayIdle.error).toContain('relay dial not started (no relay key at /state/node/relay-key)')

    const relayExited = await runVerifyWithDiag('not online: laptop (connecting)', {
      listening: 12430,
      error: null,
      relay: { state: 'error', error: 'Permission denied (publickey).' },
    })
    expect(relayExited.ok).toBe(false)
    expect(relayExited.error).toContain('relay dial ssh exited: Permission denied (publickey).')

    // Peer node offline while old master is online should not attach old master local diagnostic
    const peerOnly = await runVerifyWithDiag('not online: server-2 (connecting)', {
      listening: null,
      error: 'Cannot listen on 127.0.0.1:12430: EADDRINUSE',
      relay: null,
    })
    expect(peerOnly.ok).toBe(false)
    expect(peerOnly.error).toBe('new master verification failed: nodes: not online: server-2 (connecting)')
  })

  test('nodeListener.error() reports bind error when port is taken and clears once bound', async () => {
    withIsolatedEnv()
    const takenPort = await unusedPort()
    const holder = Bun.serve({
      hostname: '127.0.0.1',
      port: takenPort,
      idleTimeout: 0,
      reusePort: false,
      fetch: () => new Response('busy'),
    })
    let holderStopped = false
    CLEANUPS.push(async () => {
      if (!holderStopped) await holder.stop(true)
    })

    const cfg = makeCfg({
      node: { id: 'laptop', port: takenPort, workRoot: '~', listen: 'loopback', tls: false, relay: null },
    })
    const listener = createNodeListener({
      cfg,
      routes: [],
      guards: { csrf: () => null, origin: () => null, boardHeader: () => null, ownFiles: () => null } as never,
      hello: () => ({ ok: true, api: 1, name: 'anna', version: '0.1.0', commit: COMMIT }) as never,
      store: createNodeStore({ dir: nodeDir() }),
      doorRoutes: [{ method: 'GET', path: '/api/node/status', handle: () => Response.json({ api: NODE_API }) }],
      log: () => {},
    })
    CLEANUPS.push(() => listener.close())

    await listener.sync()
    expect(listener.listening()).toBeNull()
    expect(listener.error()).toContain(`Cannot listen on 127.0.0.1:${takenPort}`)

    await holder.stop(true)
    holderStopped = true
    await listener.sync()
    expect(listener.listening()).toBe(takenPort)
    expect(listener.error()).toBeNull()
  })
})
