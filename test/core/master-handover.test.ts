import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  buildOldMasterNodeConfig,
  buildOldMasterRelayNodeConfig,
  buildTargetMasterConfig,
  collectDirectProbeAddresses,
  describeOldMasterLinkProblem,
  flipNodesConfig,
  formatDirectHttpsUrl,
  formatHandoverPlan,
  formatHandoverResult,
  HANDOVER_VERSION,
  type HandoverManifest,
  isBackupTargetSelf,
  isDirectProbeIp,
  isNodeListedOffline,
  isSafeHandoverRelPath,
  packHandoverBundle,
  parseMasterCliArgs,
  parseReverseLinkSpec,
  relayTargetEndpoint,
  resolveHandoverDoorPort,
  unpackHandoverBundle,
} from '../../src/core/master-handover.ts'
import { nodesConfig } from '../../src/core/nodes.ts'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

describe('core/master-handover (#697)', () => {
  test('isSafeHandoverRelPath rejects traversal, absolute, Windows drive, and control paths', () => {
    expect(isSafeHandoverRelPath('board.db')).toBe(true)
    expect(isSafeHandoverRelPath('calendar/secret/cal-1.json')).toBe(true)
    expect(isSafeHandoverRelPath('nodes/server-1/link-key')).toBe(true)

    for (const bad of [
      '',
      '/etc/passwd',
      '\\windows\\system32',
      '../board.db',
      'schedule/../../config.json',
      'schedule/./a.json',
      'C:/Users/anna/x',
      'a//b',
      'bad\x00path',
      'bad\npath',
    ]) {
      expect(isSafeHandoverRelPath(bad)).toBe(false)
    }
  })

  test('packHandoverBundle and unpackHandoverBundle round-trip and reject corruption', () => {
    const b1 = Buffer.from('hello db bytes')
    const b2 = Buffer.from('{"secret":"ok"}')
    const manifest: HandoverManifest = {
      v: HANDOVER_VERSION,
      id: 'ho-1',
      from: 'laptop',
      to: 'server-1',
      createdAt: 1700000000000,
      files: [
        { path: 'board.db', category: 'db', size: b1.length, sha256: sha(b1) },
        { path: 'access.json', category: 'access', size: b2.length, sha256: sha(b2), mode: 0o600 },
      ],
      credentials: [{ id: 'laptop', token: 'a'.repeat(43) }],
    }
    const packed = packHandoverBundle(manifest, [b1, b2])
    const unpacked = unpackHandoverBundle(packed)
    expect(unpacked.manifest).toEqual(manifest)
    expect(Buffer.from(unpacked.bodies[0] ?? []).toString()).toBe('hello db bytes')
    expect(Buffer.from(unpacked.bodies[1] ?? []).toString()).toBe('{"secret":"ok"}')

    // Bad magic
    const badMagic = new Uint8Array(packed)
    badMagic[0] = 0x58
    expect(() => unpackHandoverBundle(badMagic)).toThrow(/bad magic/)

    // Truncated body
    expect(() => unpackHandoverBundle(packed.subarray(0, packed.length - 2))).toThrow(/truncated/)

    // Trailing bytes
    const extra = new Uint8Array(packed.length + 1)
    extra.set(packed)
    expect(() => unpackHandoverBundle(extra)).toThrow(/trailing/)
  })

  test('isBackupTargetSelf detects loopback, target hostname, short hostname, and local IPs', () => {
    const selfNames = ['atlas-srv.internal', '192.168.1.40', '100.64.0.9']
    expect(isBackupTargetSelf('localhost', selfNames)).toBe(true)
    expect(isBackupTargetSelf('127.0.0.1', selfNames)).toBe(true)
    expect(isBackupTargetSelf('[::1]', selfNames)).toBe(true)
    expect(isBackupTargetSelf('ATLAS-SRV', selfNames)).toBe(true)
    expect(isBackupTargetSelf('atlas-srv.internal', selfNames)).toBe(true)
    expect(isBackupTargetSelf('100.64.0.9', selfNames)).toBe(true)
    expect(isBackupTargetSelf('backup-box.example.com', selfNames)).toBe(false)
    expect(isBackupTargetSelf('192.168.1.99', selfNames)).toBe(false)
  })

  test('parseReverseLinkSpec defaults to direct or relay and parses ssh/relay/direct specs', () => {
    expect(
      parseReverseLinkSpec({
        oldMasterId: 'laptop',
        oldMasterNodePort: 12431,
        targetLink: { kind: 'direct', url: 'http://127.0.0.1:12430' },
        hasRelay: false,
      }),
    ).toEqual({ ok: true, link: { kind: 'direct', url: 'http://127.0.0.1:12431' } })

    expect(
      parseReverseLinkSpec({
        oldMasterId: 'laptop',
        targetLink: { kind: 'ssh', host: 'srv.example.com', sshPort: 22, user: 'agent-board-link', port: 12430 },
        hasRelay: true,
      }),
    ).toEqual({ ok: true, link: { kind: 'relay', socket: 'laptop' } })

    expect(
      parseReverseLinkSpec({
        oldMasterId: 'laptop',
        targetLink: { kind: 'ssh', host: 'srv.example.com', sshPort: 22, user: 'agent-board-link', port: 12430 },
        hasRelay: false,
      }).ok,
    ).toBe(false)

    expect(
      parseReverseLinkSpec({
        spec: 'ssh:anna@home.example.com:2222?port=12440',
        oldMasterId: 'laptop',
        targetLink: null,
        hasRelay: false,
      }),
    ).toEqual({
      ok: true,
      link: { kind: 'ssh', host: 'home.example.com', sshPort: 2222, user: 'anna', port: 12440 },
    })

    expect(
      parseReverseLinkSpec({
        spec: 'relay:laptop-nat',
        oldMasterId: 'laptop',
        targetLink: null,
        hasRelay: true,
      }),
    ).toEqual({ ok: true, link: { kind: 'relay', socket: 'laptop-nat' } })

    expect(
      parseReverseLinkSpec({
        spec: 'direct:http://192.168.1.5:12430',
        oldMasterId: 'laptop',
        targetLink: null,
        hasRelay: false,
      }).ok,
    ).toBe(false)

    // Non-loopback direct target refuses loopback default and explicit loopback override (Item 7)
    const remoteDirect = { kind: 'direct' as const, url: 'https://atlas.example.com:12430' }
    expect(parseReverseLinkSpec({ oldMasterId: 'laptop', targetLink: remoteDirect, hasRelay: false }).ok).toBe(false)
    expect(
      parseReverseLinkSpec({
        spec: 'direct:http://127.0.0.1:12430',
        oldMasterId: 'laptop',
        targetLink: remoteDirect,
        hasRelay: false,
      }).ok,
    ).toBe(false)
  })

  test('flipNodesConfig, buildTargetMasterConfig, and buildOldMasterNodeConfig preserve device settings and flip roles', () => {
    const oldNodes = {
      id: 'laptop',
      order: ['server-1', 'local', 'server-2', 'revoked-box'],
      whenFull: 'local',
      lanes: ['atlas', 'agent-board'],
      relay: { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-m' },
      devices: {
        local: { title: 'Anna Laptop', maxSessions: 4, minFreeMemMb: 2048, tags: ['mac'] },
        'server-1': {
          title: 'Atlas Server',
          link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 22, user: 'agent-board-link', port: 12430 },
          maxSessions: 12,
          tags: ['linux'],
        },
        'server-2': {
          title: 'Ben Node',
          link: { kind: 'relay', socket: 'server-2' },
          maxSessions: 8,
        },
        'revoked-box': {
          title: 'Gone',
          link: { kind: 'direct', url: 'http://127.0.0.1:19999' },
          revoked: true,
        },
      },
    }
    const flipped = flipNodesConfig(oldNodes, {
      oldMasterId: 'laptop',
      targetId: 'server-1',
      reverseLink: { kind: 'relay', socket: 'laptop' },
    })
    expect(flipped.id).toBe('server-1')
    expect(flipped.order).toEqual(['local', 'laptop', 'server-2'])
    expect(flipped.whenFull).toBe('local')
    expect(flipped.lanes).toEqual(['atlas', 'agent-board'])
    expect((flipped.devices as Record<string, unknown>)['server-1']).toBeUndefined()
    expect((flipped.devices as Record<string, unknown>)['revoked-box']).toBeUndefined()
    expect((flipped.devices as Record<string, unknown>).local).toEqual({
      title: 'Atlas Server',
      maxSessions: 12,
      tags: ['linux'],
    })
    expect((flipped.devices as Record<string, unknown>).laptop).toEqual({
      title: 'Anna Laptop',
      maxSessions: 4,
      minFreeMemMb: 2048,
      tags: ['mac'],
      link: { kind: 'relay', socket: 'laptop' },
    })

    const oldCfg = {
      port: 12422,
      profiles: [{ id: 'default', dir: '/Users/anna/.claude' }],
      categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
      threads: true,
      time: true,
      calendar: { sources: [] },
      watches: { everySec: 60 },
      todos: true,
      decisions: true,
      journal: true,
      workdesk: { workers: [] },
      workdeskDialog: true,
      boardEvents: true,
      remote: { on: true },
      presence: { on: true },
      team: { hub: 'wss://hub.example.com', name: 'anna' },
      tunnel: {
        on: true,
        host: 'srv.example.com',
        user: 'boardtunnel',
        key: '/Users/anna/.ssh/custom',
        domain: 'b.example.com',
      },
      backup: { server: { host: 'bak.example.com', port: 22, admin: { user: 'u', key: '' }, set: '2026-11-01' } },
      nodes: oldNodes,
    }
    const targetLocalCfg = {
      port: 12425,
      profiles: [{ id: 'work', dir: '/home/node/.claude-work' }],
      node: { id: 'server-1', port: 12430, workRoot: '/srv/work' },
    }

    const stagedTarget = buildTargetMasterConfig(oldCfg, targetLocalCfg, {
      flippedNodes: flipped,
      keepTargetNode: true,
      normalizeTunnelKey: true,
      carryBackupServer: true,
    })
    expect(stagedTarget.port).toBe(12425)
    expect(stagedTarget.profiles).toEqual(targetLocalCfg.profiles)
    expect(stagedTarget.node).toEqual(targetLocalCfg.node)
    expect(stagedTarget.nodes).toEqual(flipped)
    expect(stagedTarget.threads).toBe(true)
    expect((stagedTarget.tunnel as Record<string, unknown>).key).toBeUndefined()
    expect((stagedTarget.backup as Record<string, unknown>).server).toEqual(oldCfg.backup.server)

    const committedOld = buildOldMasterNodeConfig(oldCfg, {
      nodeConfig: {
        id: 'laptop',
        port: 12430,
        tls: true,
        relay: buildOldMasterRelayNodeConfig(oldNodes.relay, 'laptop'),
      },
      keepNodesFrozen: false,
    })
    expect(committedOld.nodes).toBeUndefined()
    expect(committedOld.team).toBeUndefined()
    expect(committedOld.threads).toBeUndefined()
    expect(committedOld.time).toBeUndefined()
    expect(committedOld.calendar).toBeUndefined()
    expect(committedOld.watches).toBeUndefined()
    expect(committedOld.todos).toBeUndefined()
    expect(committedOld.decisions).toBeUndefined()
    expect(committedOld.journal).toBeUndefined()
    expect(committedOld.workdesk).toBeUndefined()
    expect(committedOld.workdeskDialog).toBeUndefined()
    expect(committedOld.boardEvents).toBeUndefined()
    expect(committedOld.remote).toBeUndefined()
    expect(committedOld.presence).toBeUndefined()
    expect(committedOld.port).toBe(12422)
    expect((committedOld.tunnel as Record<string, unknown>).on).toBe(false)
    expect(committedOld.node).toEqual({
      id: 'laptop',
      port: 12430,
      tls: true,
      relay: { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-n', socket: 'laptop' },
    })

    const committedOptOut = buildOldMasterNodeConfig(
      {
        ...oldCfg,
        nodes: { ...oldNodes, devices: { ...oldNodes.devices, local: { title: 'Laptop', pilotBridge: false } } },
      },
      {
        nodeConfig: {
          id: 'laptop',
          port: 12430,
          tls: true,
          relay: buildOldMasterRelayNodeConfig(oldNodes.relay, 'laptop'),
        },
        keepNodesFrozen: false,
      },
    )
    expect((committedOptOut.node as Record<string, unknown>).pilotBridge).toBe(false)
  })

  test('flipNodesConfig carries pilotBridge: false between target device, local, and old master (#730, #738)', () => {
    const withBothDisabled = flipNodesConfig(
      {
        id: 'laptop',
        order: ['local', 'server-1'],
        devices: {
          local: { title: 'Laptop', pilotBridge: false },
          'server-1': {
            title: 'Server 1',
            pilotBridge: false,
            link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
          },
        },
      },
      {
        oldMasterId: 'laptop',
        targetId: 'server-1',
        reverseLink: { kind: 'direct', url: 'http://127.0.0.1:12431' },
      },
    )
    expect((withBothDisabled.devices as Record<string, Record<string, unknown>>).local?.pilotBridge).toBe(false)
    expect((withBothDisabled.devices as Record<string, Record<string, unknown>>).laptop?.pilotBridge).toBe(false)

    const withDefaultEnabled = flipNodesConfig(
      {
        id: 'laptop',
        order: ['local', 'server-1'],
        devices: {
          local: { title: 'Laptop' },
          'server-1': {
            title: 'Server 1',
            link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
          },
        },
      },
      {
        oldMasterId: 'laptop',
        targetId: 'server-1',
        reverseLink: { kind: 'direct', url: 'http://127.0.0.1:12431' },
      },
    )
    expect('pilotBridge' in ((withDefaultEnabled.devices as Record<string, Record<string, unknown>>).local ?? {})).toBe(
      false,
    )
    expect(
      'pilotBridge' in ((withDefaultEnabled.devices as Record<string, Record<string, unknown>>).laptop ?? {}),
    ).toBe(false)

    const withExplicitTrue = flipNodesConfig(
      {
        id: 'laptop',
        order: ['local', 'server-1'],
        devices: {
          local: { title: 'Laptop', pilotBridge: true },
          'server-1': {
            title: 'Server 1',
            pilotBridge: true,
            link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
          },
        },
      },
      {
        oldMasterId: 'laptop',
        targetId: 'server-1',
        reverseLink: { kind: 'direct', url: 'http://127.0.0.1:12431' },
      },
    )
    expect('pilotBridge' in ((withExplicitTrue.devices as Record<string, Record<string, unknown>>).local ?? {})).toBe(
      false,
    )
    expect('pilotBridge' in ((withExplicitTrue.devices as Record<string, Record<string, unknown>>).laptop ?? {})).toBe(
      false,
    )
  })

  test('parseMasterCliArgs and formatters handle handover, dry-run, rollback, and status', () => {
    expect(parseMasterCliArgs(['handover', '--to', 'server-1', '--dry-run', '--reverse-link', 'relay:lap'])).toEqual({
      ok: true,
      cmd: {
        op: 'handover',
        to: 'server-1',
        dryRun: true,
        reverseLink: 'relay:lap',
        allowOfflineNodes: false,
        json: false,
      },
    })
    expect(parseMasterCliArgs(['handover']).ok).toBe(false)
    expect(parseMasterCliArgs(['rollback', '--id', 'ho-1', '--local-only', '--json'])).toEqual({
      ok: true,
      cmd: { op: 'rollback', id: 'ho-1', localOnly: true, discardSinceCommit: false, json: true },
    })
    expect(parseMasterCliArgs(['rollback', '--discard-since-commit'])).toEqual({
      ok: true,
      cmd: { op: 'rollback', localOnly: false, discardSinceCommit: true, json: false },
    })
    expect(parseMasterCliArgs(['status', '--json'])).toEqual({ ok: true, cmd: { op: 'status', json: true } })

    const lines = formatHandoverPlan({
      ok: true,
      from: 'laptop',
      to: 'server-1',
      targetTitle: 'Atlas',
      commit: 'abc12345',
      reverseLink: { kind: 'direct', url: 'http://127.0.0.1:12430' },
      checks: [{ id: 'online', ok: true, detail: 'server-1 is online', blocking: true }],
      items: [{ category: 'db', files: 1, bytes: 4096 }],
      totalFiles: 1,
      totalBytes: 4096,
      requiredFreeMb: 64,
      targetFreeMb: 2000,
      rekey: { dbChanges: 2, scheduleEntries: 1, watchEntries: 0, ownerWatchSessions: 0 },
      otherNodes: [],
      carryBackupServer: false,
      normalizeTunnelKey: false,
      errors: [],
      warnings: [],
    })
    expect(lines.some(l => l.includes('dry-run') && l.includes('ready'))).toBe(true)
    expect(lines.some(l => l.includes('database (board.db)'))).toBe(true)

    const resLines = formatHandoverResult({
      ok: true,
      id: 'ho-1',
      from: 'laptop',
      to: 'server-1',
      verify: { ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node(s) online' }] },
    })
    expect(resLines[0]).toContain('ok · handover ho-1 complete')
  })

  test('direct probe helpers, relay endpoint, flipNodesConfig with relay, and relay dry-run output (#740)', () => {
    expect(isDirectProbeIp('127.0.0.1')).toBe(false)
    expect(isDirectProbeIp('::1')).toBe(false)
    expect(isDirectProbeIp('169.254.1.2')).toBe(false)
    expect(isDirectProbeIp('fe80::1')).toBe(false)
    expect(isDirectProbeIp('100.88.1.2')).toBe(true)
    expect(isDirectProbeIp('192.168.1.10')).toBe(true)
    expect(
      collectDirectProbeAddresses(['127.0.0.1', '192.168.1.10', '203.0.113.5', '100.88.1.2', '100.88.1.2']),
    ).toEqual(['100.88.1.2', '192.168.1.10', '203.0.113.5'])
    expect(formatDirectHttpsUrl('100.88.1.2', 12430)).toBe('https://100.88.1.2:12430')
    expect(formatDirectHttpsUrl('fd7a:115c:a1e0::1', 12430)).toBe('https://[fd7a:115c:a1e0::1]:12430')

    expect(
      relayTargetEndpoint({ kind: 'ssh', host: 'atlas.example.com', sshPort: 2222, user: 'agent-board', port: 12430 }),
    ).toEqual({ host: 'atlas.example.com', sshPort: 2222 })
    expect(relayTargetEndpoint({ kind: 'direct', url: 'https://192.168.1.50:12430' })).toEqual({
      host: '192.168.1.50',
      sshPort: 22,
    })
    expect(relayTargetEndpoint({ kind: 'direct', url: 'http://127.0.0.1:12430' })).toBeNull()
    expect(relayTargetEndpoint({ kind: 'relay', socket: 'node-1' })).toBeNull()

    const flipped = flipNodesConfig(
      {
        id: 'laptop',
        order: ['local', 'server-1'],
        devices: {
          local: { title: 'Anna Laptop' },
          'server-1': {
            title: 'Atlas',
            link: { kind: 'ssh', host: 'atlas.example.com', sshPort: 2222, user: 'agent-board', port: 12430 },
          },
        },
      },
      {
        oldMasterId: 'laptop',
        targetId: 'server-1',
        reverseLink: { kind: 'relay', socket: 'laptop' },
        relay: { host: 'atlas.example.com', sshPort: 2222, user: 'agent-board-relay-m' },
      },
    )
    const parsed = nodesConfig(flipped)
    expect(parsed?.problems).toEqual([])
    expect(parsed?.relay).toEqual({ host: 'atlas.example.com', sshPort: 2222, user: 'agent-board-relay-m' })

    const lines = formatHandoverPlan({
      ok: true,
      from: 'laptop',
      to: 'server-1',
      targetTitle: 'Atlas',
      commit: 'abc12345',
      reverseLink: { kind: 'relay', socket: 'laptop' },
      checks: [{ id: 'reverseLink', ok: true, detail: 'relay will be set up on server-1', blocking: true }],
      items: [{ category: 'db', files: 1, bytes: 4096 }],
      totalFiles: 1,
      totalBytes: 4096,
      requiredFreeMb: 64,
      targetFreeMb: 2000,
      rekey: { dbChanges: 0, scheduleEntries: 0, watchEntries: 0, ownerWatchSessions: 0 },
      otherNodes: [],
      carryBackupServer: false,
      normalizeTunnelKey: false,
      relaySetup: { host: 'atlas.example.com', sshPort: 2222, user: 'agent-board-relay-m', needsSudoPassword: false },
      errors: [],
      warnings: [],
    })
    expect(lines.some(l => l.includes('relay') && l.includes('atlas.example.com:2222'))).toBe(true)
  })

  test('resolveHandoverDoorPort checks bindability, auto-picks when default is taken, and refuses explicit taken port (#742)', async () => {
    expect(await resolveHandoverDoorPort({ preferred: 12430, isFree: () => true })).toEqual({
      ok: true,
      port: 12430,
      preferred: 12430,
      autoPicked: false,
      alreadyListening: false,
    })

    // Taken default skips 12430 and reserved board ports 12421/12422
    const taken = new Set([12420, 12421, 12422, 12423])
    expect(await resolveHandoverDoorPort({ preferred: 12420, isFree: p => !taken.has(p) })).toEqual({
      ok: true,
      port: 12424,
      preferred: 12420,
      autoPicked: true,
      alreadyListening: false,
    })

    // Explicit taken port refuses with plain sentence naming the port
    const explicitTaken = await resolveHandoverDoorPort({ explicit: 12430, preferred: 12430, isFree: () => false })
    expect(explicitTaken).toEqual({
      ok: false,
      error: 'node door port 12430 on 127.0.0.1 is already in use',
    })

    // Own door already listening passes without invoking isFree
    let probed = false
    expect(
      await resolveHandoverDoorPort({
        preferred: 12430,
        ownListeningPort: 12430,
        isFree: () => {
          probed = true
          return false
        },
      }),
    ).toEqual({
      ok: true,
      port: 12430,
      preferred: 12430,
      autoPicked: false,
      alreadyListening: true,
    })
    expect(probed).toBe(false)

    // Range exhausted
    expect(await resolveHandoverDoorPort({ preferred: 12430, range: 2, isFree: () => false })).toEqual({
      ok: false,
      error: 'no free node door port on 127.0.0.1 (tried 12430-12432)',
    })
  })

  test('isNodeListedOffline and describeOldMasterLinkProblem identify exact nodes and local door/relay causes (#742)', () => {
    expect(isNodeListedOffline('not online: laptop (connecting), server-2 (offline)', 'laptop')).toBe(true)
    expect(isNodeListedOffline('missing: laptop; not online: server-2 (connecting)', 'laptop')).toBe(true)
    expect(isNodeListedOffline('not online: laptop-2 (connecting)', 'laptop')).toBe(false)
    expect(isNodeListedOffline('master node links are not active', 'laptop')).toBe(false)

    expect(
      describeOldMasterLinkProblem(
        { listening: null, error: 'Cannot listen on 127.0.0.1:12430: EADDRINUSE', relay: null },
        { port: 12430, usesRelay: true },
      ),
    ).toBe('door not listening on port 12430 (Cannot listen on 127.0.0.1:12430: EADDRINUSE)')

    expect(
      describeOldMasterLinkProblem(
        { listening: 12430, error: null, relay: { state: 'off', idleReason: 'no relay key at /s/node/relay-key' } },
        { port: 12430, usesRelay: true },
      ),
    ).toBe('relay dial not started (no relay key at /s/node/relay-key)')

    expect(
      describeOldMasterLinkProblem(
        {
          listening: 12430,
          error: null,
          relay: { state: 'error', error: 'ssh line 1\nPermission denied (publickey).' },
        },
        { port: 12430, usesRelay: true },
      ),
    ).toBe('relay dial ssh exited: Permission denied (publickey).')

    expect(
      describeOldMasterLinkProblem(
        { listening: 12430, error: null, relay: { state: 'connected' } },
        { port: 12430, usesRelay: true },
      ),
    ).toBeNull()

    expect(
      describeOldMasterLinkProblem({ listening: 12430, error: null, relay: null }, { port: 12430, usesRelay: false }),
    ).toBeNull()
  })
})
