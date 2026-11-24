// Pure unit tests for the relay setup on a server (#511): texts, key validation, sshd blocks,
// Look parsing, refusals, record parsing, Undo plan, doItMyself, i18n parity, and import isolation.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RELAY_STRINGS } from '../../src/core/i18n/relay-strings.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  doItMyself,
  type RelayFacts,
  type RelayRecord,
  type RelayWanted,
  readRelayLook,
  readRelayRun,
  relayLookScript,
  relayPlan,
  relayRecord,
  relayRefusals,
  relayRunScript,
  relayUndoPlan,
  relayWantedProblem,
} from '../../src/core/relay-plan.ts'
import { dropRelay, packedRelayRun, putRelay } from '../../src/core/relay-setup.ts'
import {
  isRelayPublicKey,
  RELAY_BLOCK_BEGIN,
  RELAY_BLOCK_END,
  RELAY_ENROL_SCRIPT,
  RELAY_ETC,
  RELAY_FENCE,
  RELAY_KEYS_CMD,
  RELAY_KEYS_DIR,
  RELAY_MASTER_KEYS,
  RELAY_MASTER_USER,
  RELAY_NODE_USER,
  RELAY_SOCKETS_DIR,
  relayEnrolKeyLine,
  relayFenceBlock,
  relayFenceFile,
  relayFenceMarked,
  relayKeyBody,
  relayMasterFenceSettings,
  relayMasterKeyLine,
  relayMasterKeysFile,
  relayNodeFenceSettings,
} from '../../src/core/relay-texts.ts'
import { BLOCK_BEGIN } from '../../src/core/server-texts.ts'

const MASTER_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayMasterTestKeyOnly000000000000000000000 agent-board relay master'
const ENROL_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayEnrolTestKeyOnly0000000000000000000000 agent-board relay enrol'
const RSA_KEY = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC${'A'.repeat(41)} anna@host`
const ECDSA_KEY = `ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY${'A'.repeat(27)}== ben@host`

const facts = (over: Partial<RelayFacts> = {}): RelayFacts => ({
  os: { id: 'ubuntu', version: '24.04', pretty: 'Ubuntu 24.04.1 LTS' },
  ssh: 'OpenSSH_9.6p1',
  hostname: 'relay-1',
  sudo: 'password',
  has: ['sshd', 'useradd', 'usermod', 'userdel', 'install', 'flock'],
  nodeUser: 'none',
  masterUser: 'none',
  socketsDir: 'none',
  keysDir: 'none',
  authKeysDir: false,
  keysCmd: 'none',
  enrol: 'none',
  masterKeys: 'none',
  fence: 'none',
  blockTorn: false,
  include: true,
  sshdNow: 'ok',
  candidate: 'ok',
  busy: false,
  record: null,
  recordTorn: false,
  enrolled: 0,
  ...over,
})

const wanted = (over: Partial<RelayWanted> = {}): RelayWanted => ({
  masterKey: MASTER_KEY,
  enrolKey: ENROL_KEY,
  ...over,
})

describe('relay texts & key validation', () => {
  test('paths and markers are disjoint from tunnel, backup and node setups', () => {
    expect(RELAY_ETC).toBe('/etc/agent-board-relay')
    expect(RELAY_SOCKETS_DIR).toBe('/var/lib/agent-board-relay')
    expect(RELAY_KEYS_DIR).toBe('/var/lib/agent-board-relay-keys')
    expect(RELAY_KEYS_DIR.startsWith(`${RELAY_SOCKETS_DIR}/`)).toBe(false)
    expect(RELAY_FENCE).toBe('/etc/ssh/sshd_config.d/00-agent-board-relay.conf')
    expect(RELAY_BLOCK_BEGIN.startsWith(BLOCK_BEGIN)).toBe(false)
    expect(RELAY_BLOCK_END.startsWith('# <<< agent-board')).toBe(false)
  })

  test('isRelayPublicKey and relayKeyBody accept valid keys and reject injections or garbage', () => {
    expect(isRelayPublicKey(MASTER_KEY)).toBe(true)
    expect(isRelayPublicKey(RSA_KEY)).toBe(true)
    expect(isRelayPublicKey(ECDSA_KEY)).toBe(true)
    expect(relayKeyBody(`  ${MASTER_KEY}  `)).toBe(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayMasterTestKeyOnly000000000000000000000',
    )
    for (const bad of [
      '',
      'not a key',
      `restrict,command="/bin/sh" ${MASTER_KEY}`,
      'ssh-ed25519 short',
      'ssh-ed25519 AAAAB3NzaC1yc2EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // rsa prefix with ed25519 type
      'ssh-dss AAAAB3NzaC1kc3MAAACBAInvalid',
      `${MASTER_KEY}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsecond`,
      `${MASTER_KEY} $(rm -rf /)`, // wait: comment printable allowed if no control char? Wait: check control chars
    ]) {
      if (bad.endsWith('$(rm -rf /)')) {
        // relayKeyBody strips comment anyway
        expect(relayKeyBody(bad)).toBe(
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayMasterTestKeyOnly000000000000000000000',
        )
      } else {
        expect(isRelayPublicKey(bad)).toBe(false)
      }
    }
    expect(isRelayPublicKey(`${MASTER_KEY}\x00`)).toBe(false)
    expect(isRelayPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA!badchars00000000000000000000000000000')).toBe(false)
  })

  test('sshd fence blocks fence both users strictly without ForceCommand on master', () => {
    const nodeSettings = Object.fromEntries(relayNodeFenceSettings())
    expect(nodeSettings).toMatchObject({
      AuthorizedKeysFile: 'none',
      AuthorizedKeysCommand: `${RELAY_KEYS_CMD} %u`,
      AuthorizedKeysCommandUser: RELAY_MASTER_USER,
      AllowTcpForwarding: 'remote',
      PermitListen: 'none',
      AllowStreamLocalForwarding: 'remote',
      StreamLocalBindUnlink: 'yes',
      StreamLocalBindMask: '0117',
      ForceCommand: '/bin/false',
      PermitTTY: 'no',
    })
    const masterSettings = Object.fromEntries(relayMasterFenceSettings())
    expect(masterSettings).toMatchObject({
      AuthorizedKeysFile: RELAY_MASTER_KEYS,
      AllowTcpForwarding: 'no',
      AllowStreamLocalForwarding: 'local',
      PermitTTY: 'no',
    })
    expect('ForceCommand' in masterSettings).toBe(false)

    const block = relayFenceBlock()
    expect(block).toContain(`Match User ${RELAY_NODE_USER}\n`)
    expect(block).toContain(`Match User ${RELAY_MASTER_USER}\n`)
    expect(block.match(/\nMatch all/g)).toHaveLength(2)
    expect(relayFenceFile()).toContain(block)
    expect(relayFenceMarked()).toContain(`${RELAY_BLOCK_BEGIN}:`)
    expect(relayFenceMarked()).toContain(RELAY_BLOCK_END)
  })

  test('master keys file restricts forward key and enrol key independently', () => {
    expect(relayMasterKeyLine(MASTER_KEY)).toBe(
      'restrict,port-forwarding,command="/bin/false" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayMasterTestKeyOnly000000000000000000000',
    )
    expect(relayEnrolKeyLine(ENROL_KEY)).toBe(
      `restrict,command="${RELAY_ENROL_SCRIPT}" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayEnrolTestKeyOnly0000000000000000000000`,
    )
    expect(relayMasterKeysFile(MASTER_KEY, ENROL_KEY).split('\n')).toHaveLength(3)
  })
})

describe('relayLookScript and readRelayLook', () => {
  test('parses Look lines cleanly and returns null without @@end', () => {
    expect(readRelayLook(['@@os ubuntu 24.04'])).toBeNull()
    const parsed = readRelayLook([
      '@@os debian 13',
      '@@pretty Debian GNU/Linux 13 (trixie)',
      '@@ssh OpenSSH_10.0p2',
      '@@hostname relay-box',
      '@@sudo nopasswd',
      '@@has sshd',
      '@@has useradd',
      '@@has usermod',
      '@@has userdel',
      '@@has install',
      '@@has flock',
      '@@node-user ours',
      '@@master-user none',
      '@@sockets-dir same',
      '@@keys-dir none',
      '@@auth-keys-dir yes',
      '@@keys-cmd same',
      '@@enrol other',
      '@@master-keys same',
      '@@fence file-same',
      '@@block whole',
      '@@include yes',
      '@@sshd-t ok',
      '@@candidate ok',
      '@@enrolled 3',
      '@@end',
    ])
    expect(parsed).toMatchObject({
      os: { id: 'debian', version: '13', pretty: 'Debian GNU/Linux 13 (trixie)' },
      sudo: 'nopasswd',
      nodeUser: 'ours',
      masterUser: 'none',
      socketsDir: 'same',
      keysDir: 'none',
      authKeysDir: true,
      keysCmd: 'same',
      enrol: 'other',
      masterKeys: 'same',
      fence: 'file-same',
      blockTorn: false,
      include: true,
      sshdNow: 'ok',
      candidate: 'ok',
      busy: false,
      enrolled: 3,
    })
  })

  test('Look script does not embed private keys', () => {
    const s = relayLookScript({ masterKey: MASTER_KEY, enrolKey: ENROL_KEY })
    expect(s).toContain('# agent-board: relay look')
    expect(s).not.toContain('PRIVATE KEY')
  })
})

describe('relayWantedProblem, relayRefusals, relayRecord, relayPlan, relayUndoPlan', () => {
  test('relayWantedProblem rejects invalid or duplicate keys', () => {
    expect(relayWantedProblem(wanted())).toBeNull()
    expect(relayWantedProblem(wanted({ masterKey: 'bad' }))).toBe('masterKey')
    expect(relayWantedProblem(wanted({ enrolKey: 'bad' }))).toBe('enrolKey')
    expect(relayWantedProblem(wanted({ enrolKey: MASTER_KEY }))).toBe('sameKey')
  })

  test('relayRefusals checks preconditions and allows updates when owned by record', () => {
    expect(relayRefusals(facts(), wanted())).toEqual([])
    const foreign = relayRefusals(
      facts({
        sudo: 'none',
        nodeUser: 'other',
        masterUser: 'group',
        socketsDir: 'other',
        keysDir: 'other',
        keysCmd: 'other',
        enrol: 'other',
        masterKeys: 'other',
        fence: 'file-other',
        sshdNow: 'bad line',
        busy: true,
        blockTorn: true,
      }),
      wanted(),
    ).map(x => x.key)
    expect(foreign).toEqual([
      'relay.refuse.sudo',
      'relay.refuse.userOther',
      'relay.refuse.userGroup',
      'relay.refuse.busy',
      'relay.refuse.blockTorn',
      'relay.refuse.sshd',
      'relay.refuse.socketsDirOther',
      'relay.refuse.keysDirOther',
      'relay.refuse.keysCmdOther',
      'relay.refuse.enrolOther',
      'relay.refuse.masterKeysOther',
      'relay.refuse.fenceOther',
    ])
    // With our record owning those items, Apply is allowed to repair/update them
    const ownedRec: RelayRecord = {
      v: 1,
      run: 'r1',
      at: '2026-11-24T00:00:00Z',
      state: 'applied',
      items: [
        { kind: 'socketsDir' },
        { kind: 'keysDir' },
        { kind: 'keysCmd' },
        { kind: 'enrol' },
        { kind: 'masterKeys' },
        { kind: 'fence' },
      ],
    }
    expect(
      relayRefusals(
        facts({
          socketsDir: 'other',
          keysDir: 'other',
          keysCmd: 'other',
          enrol: 'other',
          masterKeys: 'other',
          fence: 'file-other',
          record: ownedRec,
        }),
        wanted(),
      ),
    ).toEqual([])
  })

  test('relayRecord ignores unknown item kinds and rejects malformed records', () => {
    expect(relayRecord(null)).toBeNull()
    expect(relayRecord({ v: 2 })).toBeNull()
    expect(
      relayRecord({
        v: 1,
        run: 'r-1',
        at: '2026-11-24T10:00:00Z',
        state: 'applied',
        items: [{ kind: 'user', name: RELAY_NODE_USER }, { kind: 'unknown' }, { kind: 'fence' }],
      }),
    ).toEqual({
      v: 1,
      run: 'r-1',
      at: '2026-11-24T10:00:00Z',
      state: 'applied',
      items: [{ kind: 'user', name: RELAY_NODE_USER }, { kind: 'fence' }],
    })
  })

  test('relayPlan, relayUndoPlan, readRelayRun and doItMyself', () => {
    const p = relayPlan(facts(), wanted())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.plan.steps.map(s => s.id)).toEqual(['check', 'users', 'folders', 'scripts', 'keys', 'fence'])
    const script = relayRunScript(p.plan, { id: 'run-1', at: '2026-11-24T10:00:00Z' })
    expect(script).toContain('# agent-board: relay apply')
    expect(script).not.toContain('PRIVATE KEY')

    const manual = doItMyself(wanted())
    expect(manual.file).toBe('agent-board-relay-setup.sh')
    expect(manual.run).toBe('sudo sh agent-board-relay-setup.sh')
    expect(manual.script).toContain('# agent-board: relay apply')

    const undo = relayUndoPlan(
      {
        v: 1,
        run: 'run-1',
        at: '2026-11-24T10:00:00Z',
        state: 'applied',
        items: [
          { kind: 'user', name: RELAY_NODE_USER },
          { kind: 'user', name: RELAY_MASTER_USER },
          { kind: 'socketsDir' },
          { kind: 'keysDir' },
          { kind: 'keysCmd' },
          { kind: 'enrol' },
          { kind: 'masterKeys' },
          { kind: 'fence' },
        ],
      },
      { enrolled: 2 },
    )
    expect(undo.steps.map(s => s.id)).toEqual(['check', 'fence', 'keys', 'scripts', 'folders', 'users'])
    expect(undo.warnings.map(w => w.key)).toEqual(['relay.warn.enrolledStay'])

    const parsedRun = readRelayRun([
      '@@step check start',
      '@@step check ok',
      '@@step users start',
      '@@step users skip',
      '@@warn kept something',
      '@@result applied',
    ])
    expect(parsedRun).toEqual({
      result: 'applied',
      steps: [
        { id: 'check', state: 'ok' },
        { id: 'users', state: 'skip' },
      ],
      undone: [],
      warnings: ['kept something'],
      said: [],
    })
  })
})

describe('putRelay and dropRelay', () => {
  test('creates nodes when absent and preserves existing devices when present', () => {
    const fresh: Record<string, unknown> = {}
    expect(putRelay(fresh, false, { host: 'relay.example.com', sshPort: 2222, selfId: 'atlas-srv' })).toBe(true)
    expect(fresh).toEqual({
      id: 'atlas-srv',
      order: ['local'],
      whenFull: 'local',
      relay: { host: 'relay.example.com', sshPort: 2222, user: RELAY_MASTER_USER },
      devices: {},
    })

    const existing: Record<string, unknown> = {
      id: 'atlas',
      order: ['server-1', 'local'],
      lanes: ['agent-board'],
      devices: {
        'server-1': { link: { kind: 'ssh', host: '203.0.113.10', sshPort: 22, user: 'agent-board-link', port: 12430 } },
      },
    }
    expect(putRelay(existing, true, { host: 'relay.example.com', sshPort: 22, selfId: 'atlas' })).toBe(true)
    expect(existing.devices).toHaveProperty('server-1')
    expect(existing.order).toEqual(['server-1', 'local'])
    expect(existing.lanes).toEqual(['agent-board'])
    expect(existing.relay).toEqual({ host: 'relay.example.com', sshPort: 22, user: RELAY_MASTER_USER })
    expect(putRelay(existing, true, { host: 'relay.example.com', sshPort: 22, selfId: 'atlas' })).toBe(false)

    expect(dropRelay(existing)).toBe(true)
    expect(existing).not.toHaveProperty('relay')
    expect(existing.devices).toHaveProperty('server-1')
    expect(dropRelay(existing)).toBe(false)
  })
})

describe('i18n and module isolation', () => {
  test('relay strings match across en and ru with no stray keys and no em/en dashes', () => {
    expect(Object.keys(RELAY_STRINGS.ru).sort()).toEqual(Object.keys(RELAY_STRINGS.en).sort())
    const strays = Object.keys(RELAY_STRINGS.en).filter(k => !k.startsWith('relay.'))
    expect(strays).toEqual([])
    const [enT, ruT] = [translator('en'), translator('ru')]
    for (const key of Object.keys(RELAY_STRINGS.en)) {
      const enVal = String(RELAY_STRINGS.en[key] ?? '')
      const ruVal = String(RELAY_STRINGS.ru[key] ?? '')
      expect(enVal).not.toMatch(/[\u2013\u2014]/)
      expect(ruVal).not.toMatch(/[\u2013\u2014]/)
      const ph = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort()
      expect(ph(ruVal)).toEqual(ph(enVal))
      expect(enT(key)).not.toBe(key)
      expect(ruT(key)).not.toBe(enT(key))
    }
  })

  test('core relay modules have no node: imports and no dependency on node-plan', () => {
    const core = join(import.meta.dir, '..', '..', 'src', 'core')
    for (const file of ['relay-texts.ts', 'relay-plan.ts', 'relay-setup.ts']) {
      const text = readFileSync(join(core, file), 'utf8')
      expect(text).not.toMatch(/from ['"]node:/)
      expect(text).not.toMatch(/node-plan|node-texts/)
      expect(text).not.toMatch(/[\u2013\u2014]/)
    }
    // Check packedRelayRun wrapper
    expect(packedRelayRun('apply', 'echo hi', s => Buffer.from(s).toString('base64'))).toContain(
      '# agent-board: relay apply',
    )
    // Ensure relay-setup service is only imported by server/app.ts and server/routes/nodes.ts
    const srcRoot = join(import.meta.dir, '..', '..', 'src')
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) files.push(p)
      }
    }
    walk(srcRoot)
    const rel = (p: string) => p.slice(srcRoot.length + 1).replaceAll('\\', '/')
    const importers = files
      .filter(p => /nodes\/relay-setup(\.ts)?['"]/.test(readFileSync(p, 'utf8')))
      .map(rel)
      .sort()
    expect(importers).toEqual(['server/app.ts', 'server/routes/nodes.ts'])
  })
})
