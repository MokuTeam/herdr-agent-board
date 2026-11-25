import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  buildOldMasterNodeConfig,
  buildOldMasterRelayNodeConfig,
  buildTargetMasterConfig,
  flipNodesConfig,
  formatHandoverPlan,
  formatHandoverResult,
  HANDOVER_VERSION,
  type HandoverManifest,
  isBackupTargetSelf,
  isSafeHandoverRelPath,
  packHandoverBundle,
  parseMasterCliArgs,
  parseReverseLinkSpec,
  unpackHandoverBundle,
} from '../../src/core/master-handover.ts'

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
  })

  test('flipNodesConfig carries pilotBridge between target device, local, and old master (#730)', () => {
    const withTargetEnabled = flipNodesConfig(
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
    expect((withTargetEnabled.devices as Record<string, Record<string, unknown>>).local?.pilotBridge).toBe(true)
    expect((withTargetEnabled.devices as Record<string, Record<string, unknown>>).laptop?.pilotBridge).toBe(true)

    const withNeitherEnabled = flipNodesConfig(
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
    expect('pilotBridge' in ((withNeitherEnabled.devices as Record<string, Record<string, unknown>>).local ?? {})).toBe(
      false,
    )
    expect(
      'pilotBridge' in ((withNeitherEnabled.devices as Record<string, Record<string, unknown>>).laptop ?? {}),
    ).toBe(false)
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
})
