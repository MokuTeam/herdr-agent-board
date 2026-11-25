// The node's reverse SSH relay dialer (services/node/relay-dial.ts, #512): the `ssh -R` line,
// tunnel supervisor lifecycle (connecting, connected, backoff, reset after uptime, lasting errors,
// sleep and network restarts, stray pid cleanup), fake-ssh verification, and no-op when `relay` or
// `relay-key` is absent.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { relaySocketsDir } from '../../src/adapters/paths.ts'
import { type PidRecord, readPidRecord, writePidRecord } from '../../src/adapters/ssh.ts'
import type { NodeConfig } from '../../src/core/nodes.ts'
import { RELAY_SOCKETS_DIR } from '../../src/core/relay-texts.ts'
import { createRelayDial, relayDialArgs, relayDialPlan } from '../../src/services/node/relay-dial.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'
import { type FakeChild, fakeChild, fakeClock } from '../support/fake-tunnel.ts'

setDefaultTimeout(30_000)

const RELAY: NonNullable<NodeConfig['relay']> = {
  host: 'relay.example.com',
  sshPort: 2222,
  user: 'agent-board-relay-n',
  socket: 'mac-1',
}

const NODE_CFG: NodeConfig = {
  id: 'mac-1',
  port: 12430,
  workRoot: '~/work',
  listen: 'loopback',
  tls: true,
  relay: RELAY,
}

const HEALTHY = [
  'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2',
  'Authenticated to relay.example.com ([203.0.113.5]:2222) using "publickey".',
]

function dialWorld(initialNode: NodeConfig | null = NODE_CFG) {
  const time = fakeClock()
  const spawns: { bin: string; args: string[]; child: FakeChild }[] = []
  const logs: string[] = []
  let pid = 7000
  const w = {
    time,
    node: initialNode as NodeConfig | null,
    doorPort: 12430 as number | null,
    hasKey: true,
    record: null as PidRecord | null,
    strayEnd: (async () => true) as (r: PidRecord) => Promise<boolean>,
    ended: [] as PidRecord[],
    net: 'en0 192.168.1.10',
    changes: 0,
    spawns,
    logs,
  }
  const dial = createRelayDial({
    node: () => w.node,
    doorPort: () => w.doorPort,
    keyPath: () => '/state/node/relay-key',
    keyExists: () => w.hasKey,
    knownHosts: () => '/state/tunnel/known_hosts',
    socketsDir: () => RELAY_SOCKETS_DIR,
    bin: () => '/usr/bin/ssh',
    spawn: (bin, args) => {
      const child = fakeChild(++pid, null)
      spawns.push({ bin, args, child })
      return child
    },
    stray: {
      read: () => w.record,
      write: r => {
        w.record = r
      },
      end: r => {
        w.ended.push(r)
        return w.strayEnd(r)
      },
    },
    clock: time.clock,
    network: () => w.net,
    random: () => 0.5,
    pace: 1,
    onChange: () => {
      w.changes += 1
    },
    log: text => logs.push(text),
  })
  const child = (): FakeChild => {
    const last = spawns.at(-1)
    if (!last) throw new Error('no ssh started')
    return last.child
  }
  const successLine = () =>
    `debug1: remote forward success for: listen ${RELAY_SOCKETS_DIR}/mac-1.sock:-2, connect 127.0.0.1:12430`
  return Object.assign(w, { dial, child, successLine })
}

describe('relayDialArgs and relayDialPlan', () => {
  test('builds the exact ssh -R line for POSIX and Windows paths and rejects invalid socket names', () => {
    expect(
      relayDialArgs({
        relay: RELAY,
        socketPath: `${RELAY_SOCKETS_DIR}/mac-1.sock`,
        key: 'C:\\state\\node\\relay-key',
        knownHosts: 'C:\\state\\tunnel\\known_hosts',
        doorPort: 12430,
        platform: 'win32',
      }),
    ).toEqual([
      '-F',
      'none',
      '-N',
      '-T',
      '-v',
      '-i',
      'C:/state/node/relay-key',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'TCPKeepAlive=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'UserKnownHostsFile="C:/state/tunnel/known_hosts"',
      '-p',
      '2222',
      '-R',
      `${RELAY_SOCKETS_DIR}/mac-1.sock:127.0.0.1:12430`,
      'agent-board-relay-n@relay.example.com',
    ])

    // Suffix .sock on config.relay.socket is normalized without doubling
    const p1 = relayDialPlan({
      node: { ...NODE_CFG, relay: { ...RELAY, socket: 'mac-1.sock' } },
      doorPort: 12430,
      key: '/s/relay-key',
      knownHosts: '/s/known_hosts',
      socketsDir: '/var/lib/agent-board-relay/',
    })
    expect(p1?.forward).toBe('/var/lib/agent-board-relay/mac-1.sock:127.0.0.1:12430')

    // Bad socket names are refused before ssh
    for (const bad of ['../evil', 'Upper', '-flag', 'a/b']) {
      expect(
        relayDialPlan({
          node: { ...NODE_CFG, relay: { ...RELAY, socket: bad } },
          doorPort: 12430,
          key: '/s/relay-key',
          knownHosts: '/s/known_hosts',
        }),
      ).toBeNull()
    }

    // Plaintext door is never forwarded over relay even if relay config is present
    expect(
      relayDialPlan({
        node: { ...NODE_CFG, tls: false },
        doorPort: 12430,
        key: '/s/relay-key',
        knownHosts: '/s/known_hosts',
      }),
    ).toBeNull()
  })

  test('relaySocketsDir defaults to RELAY_SOCKETS_DIR and honours BOARD_TEST_RELAY_SOCKETS_DIR', () => {
    const prev = process.env.BOARD_TEST_RELAY_SOCKETS_DIR
    try {
      delete process.env.BOARD_TEST_RELAY_SOCKETS_DIR
      expect(relaySocketsDir()).toBe(RELAY_SOCKETS_DIR)
      process.env.BOARD_TEST_RELAY_SOCKETS_DIR = '/tmp/test-relay-sockets'
      expect(relaySocketsDir()).toBe('/tmp/test-relay-sockets')
    } finally {
      if (prev === undefined) delete process.env.BOARD_TEST_RELAY_SOCKETS_DIR
      else process.env.BOARD_TEST_RELAY_SOCKETS_DIR = prev
    }
  })
})

describe('createRelayDial supervisor lifecycle', () => {
  test('connects on forwardAccepted, records pid, and stops cleanly when relay is removed', async () => {
    const w = dialWorld()
    await w.dial.sync()
    expect(w.spawns).toHaveLength(1)
    expect(w.dial.status().state).toBe('connecting')
    expect(w.dial.running()).toBe(true)
    expect(w.record?.forward).toBe(`${RELAY_SOCKETS_DIR}/mac-1.sock:127.0.0.1:12430`)

    w.child().line(...HEALTHY, w.successLine())
    expect(w.dial.status().state).toBe('connected')

    w.node = { ...NODE_CFG, relay: null }
    await w.dial.sync()
    expect(w.dial.status().state).toBe('off')
    expect(w.dial.running()).toBe(false)
    expect(w.record).toBeNull()
  })

  test('without relay, without tls, or without relay-key: spawns no ssh and creates no pid record', async () => {
    const wNoRelay = dialWorld({ ...NODE_CFG, relay: null })
    await wNoRelay.dial.sync()
    await wNoRelay.dial.sync()
    expect(wNoRelay.spawns).toHaveLength(0)
    expect(wNoRelay.record).toBeNull()
    expect(wNoRelay.dial.status().state).toBe('off')
    expect(wNoRelay.dial.idleReason()).toBe('node.relay is not configured')
    expect(wNoRelay.logs.filter(l => l.includes('node.relay is not configured'))).toHaveLength(1)

    const wNoTls = dialWorld({ ...NODE_CFG, tls: false })
    await wNoTls.dial.sync()
    await wNoTls.dial.sync()
    expect(wNoTls.spawns).toHaveLength(0)
    expect(wNoTls.record).toBeNull()
    expect(wNoTls.dial.status().state).toBe('off')
    expect(wNoTls.logs.filter(l => l.includes('plaintext door'))).toHaveLength(1)

    const wNoKey = dialWorld(NODE_CFG)
    wNoKey.hasKey = false
    await wNoKey.dial.sync()
    await wNoKey.dial.sync()
    expect(wNoKey.spawns).toHaveLength(0)
    expect(wNoKey.record).toBeNull()
    expect(wNoKey.dial.status().state).toBe('off')
    expect(wNoKey.logs.filter(l => l.includes('no relay key'))).toHaveLength(1)

    // Door not listening logs once per state change, clears when listening, and logs once again if door drops (#742)
    const wNoDoor = dialWorld(NODE_CFG)
    wNoDoor.doorPort = null
    await wNoDoor.dial.sync()
    await wNoDoor.dial.sync()
    expect(wNoDoor.spawns).toHaveLength(0)
    expect(wNoDoor.dial.idleReason()).toBe('node door is not listening on port 12430')
    expect(wNoDoor.logs.filter(l => l.includes('node door is not listening on port 12430'))).toHaveLength(1)
    wNoDoor.doorPort = 12430
    await wNoDoor.dial.sync()
    expect(wNoDoor.spawns).toHaveLength(1)
    expect(wNoDoor.dial.idleReason()).toBeNull()
    wNoDoor.doorPort = null
    await wNoDoor.dial.sync()
    expect(wNoDoor.logs.filter(l => l.includes('node door is not listening on port 12430'))).toHaveLength(2)
    await wNoDoor.dial.close()

    // Invalid socket name logs once per state change (#742)
    const wBadSock = dialWorld({ ...NODE_CFG, relay: { ...RELAY, socket: '../evil' } })
    await wBadSock.dial.sync()
    await wBadSock.dial.sync()
    expect(wBadSock.spawns).toHaveLength(0)
    expect(wBadSock.dial.idleReason()).toContain('invalid relay socket name')
    expect(wBadSock.logs.filter(l => l.includes('invalid relay socket name'))).toHaveLength(1)
  })

  test('backoff grows on exits, resets after 60 s connected, and lasting errors retry every 60 s', async () => {
    const w = dialWorld()
    await w.dial.sync()
    w.child().line('Connection timed out')
    w.child().exit(255)
    await w.time.advance(0)
    expect(w.dial.status().state).toBe('reconnecting')
    expect(w.dial.status().attempt).toBe(1)
    const w1 = (w.dial.status().nextAt ?? 0) - w.time.now()
    expect(w1).toBe(1000)
    await w.time.advance(w1)
    expect(w.spawns).toHaveLength(2)

    // Connects, stays up > 60 s, drops -> attempt resets to 1
    w.child().line(w.successLine())
    await w.time.advance(61_000)
    w.child().exit(255)
    await w.time.advance(0)
    expect(w.dial.status().attempt).toBe(1)
    await w.time.advance(1000)
    expect(w.spawns).toHaveLength(3)

    // Lasting publickey error -> state 'error', retries in 60 s
    w.child().line('agent-board-relay-n@relay.example.com: Permission denied (publickey).')
    w.child().exit(255)
    await w.time.advance(0)
    expect(w.dial.status()).toMatchObject({ state: 'error', hint: 'publickey' })
    await w.time.advance(60_000)
    expect(w.spawns).toHaveLength(4)
    await w.dial.close()
  })

  test('restarts immediately on sleep gap and network change, and cleans up stray pid first', async () => {
    const w = dialWorld()
    w.record = { pid: 9999, forward: `${RELAY_SOCKETS_DIR}/mac-1.sock:127.0.0.1:12430`, at: 1 }
    await w.dial.sync()
    expect(w.ended).toHaveLength(1)
    expect(w.spawns).toHaveLength(1)
    w.child().line(w.successLine())
    expect(w.dial.status().state).toBe('connected')

    // Sleep jump > 30 s triggers immediate restart on next tick
    w.time.jump(40_000)
    await w.time.advance(5000)
    expect(w.spawns).toHaveLength(2)
    w.child().line(w.successLine())

    // Network change triggers immediate restart on next poll
    w.net = 'en0 10.0.0.5'
    await w.time.advance(10_000)
    expect(w.spawns).toHaveLength(3)
    await w.dial.close()
  })

  test('runs against fake-ssh executable, logs -R args, and clears pid file on close', async () => {
    const ssh = await useFakeSsh()
    ssh.state({ ssh: { mode: 'forward' } })
    const nodeDir = join(ssh.dir, 'node')
    mkdirSync(nodeDir, { recursive: true })
    const key = join(nodeDir, 'relay-key')
    const pidFile = join(nodeDir, 'relay-pid.json')
    const knownHosts = join(ssh.dir, 'known_hosts')
    writeFileSync(key, 'fake-key\n')

    const dial = createRelayDial({
      node: () => ({ ...NODE_CFG, relay: { ...RELAY, host: 'ssh.example.com' } }),
      doorPort: () => 12430,
      keyPath: () => key,
      knownHosts: () => knownHosts,
      socketsDir: () => RELAY_SOCKETS_DIR,
      stray: {
        read: () => readPidRecord(pidFile),
        write: r => writePidRecord(r, pidFile),
        end: async () => true,
      },
      pace: 0.02,
      log: () => {},
    })
    await dial.sync()
    const deadline = Date.now() + 5000
    while (dial.status().state !== 'connected' && Date.now() < deadline) await Bun.sleep(10)
    expect(dial.status().state).toBe('connected')
    expect(readPidRecord(pidFile)?.forward).toBe(`${RELAY_SOCKETS_DIR}/mac-1.sock:127.0.0.1:12430`)
    const calls = ssh.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('-R')
    expect(calls[0]).toContain(`${RELAY_SOCKETS_DIR}/mac-1.sock:127.0.0.1:12430`)
    await dial.close()
    expect(existsSync(pidFile) && readPidRecord(pidFile) !== null).toBe(false)
  })
})
