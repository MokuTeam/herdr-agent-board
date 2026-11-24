// Master side of the relay pipe (services/nodes/relay.ts, services/nodes/link.ts, #512):
// ssh -L forward line, enrolment client (check/list/add/remove), openRelayForward, and createLink
// with relayPipeDeps (cert missing, wrong cert refused with 'cert' before sending bearer token,
// wrong host-key, missing master key, and EN/RU device row rendering).
import { describe, expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateDoorCert } from '../../src/adapters/door-cert.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { t as translate } from '../../src/core/lang.ts'
import type { DeviceConfig, LinkConfig } from '../../src/core/nodes.ts'
import { RELAY_SOCKETS_DIR } from '../../src/core/relay-texts.ts'
import { createLink, type Link, type LinkDeps } from '../../src/services/nodes/link.ts'
import {
  createRelayEnrol,
  openRelayForward,
  relayEnrolArgs,
  relayForwardArgs,
  relayPipeDeps,
} from '../../src/services/nodes/relay.ts'
import { realClock } from '../../src/services/tunnel.ts'
import { deviceRows, linkWords } from '../../web/src/models/devices.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'

const RELAY = { host: 'ssh.example.com', sshPort: 2222, user: 'agent-board-relay-m' }
const PUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEENROLNODEKEY0000000000000000000 node-a'
const TIMES = { deadMs: 1500, statusMs: 300, pace: 0.02 }

const device = (id: string, link: LinkConfig): DeviceConfig => ({
  id,
  title: id,
  link,
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
})

function linkTo(d: DeviceConfig, deps: Partial<LinkDeps> & Pick<LinkDeps, 'token'>): Link {
  const link = createLink({ device: d, cfg: TIMES, deps: { clock: realClock, log: () => {}, ...deps } })
  onTestFinished(() => link.close())
  return link
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`never came to that: ${JSON.stringify(v)}`)
    await Bun.sleep(10)
  }
}

describe('relayForwardArgs and relayEnrolArgs', () => {
  test('builds ssh -L and forced-command enrol arguments for POSIX and Windows paths', () => {
    expect(
      relayForwardArgs({
        relay: RELAY,
        socketPath: `${RELAY_SOCKETS_DIR}/mac-1.sock`,
        key: 'C:\\state\\nodes\\relay\\master-key',
        knownHosts: 'C:\\state\\tunnel\\known_hosts',
        localPort: 50123,
        platform: 'win32',
      }),
    ).toEqual([
      '-F',
      'none',
      '-N',
      '-T',
      '-v',
      '-i',
      'C:/state/nodes/relay/master-key',
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
      '-L',
      `127.0.0.1:50123:${RELAY_SOCKETS_DIR}/mac-1.sock`,
      'agent-board-relay-m@ssh.example.com',
    ])

    expect(
      relayEnrolArgs({
        relay: RELAY,
        key: '/state/nodes/relay/enrol-key',
        knownHosts: '/state/tunnel/known_hosts',
        command: 'check',
      }),
    ).toEqual([
      '-F',
      'none',
      '-T',
      '-i',
      '/state/nodes/relay/enrol-key',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'UserKnownHostsFile="/state/tunnel/known_hosts"',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '-p',
      '2222',
      'agent-board-relay-m@ssh.example.com',
      'check',
    ])
  })
})

describe('createRelayEnrol and openRelayForward against fake-ssh', () => {
  test('enrol check, list, add, remove work through fake-ssh and validate names/keys locally first', async () => {
    const ssh = await useFakeSsh()
    const keysDir = join(ssh.dir, 'server-keys')
    const socketsDir = join(ssh.dir, 'server-sockets')
    mkdirSync(socketsDir, { recursive: true })
    ssh.state({ enrol: { keysDir, socketsDir } })

    const enrolKey = join(ssh.dir, 'enrol-key')
    writeFileSync(enrolKey, 'fake-enrol-key\n')
    const enrol = createRelayEnrol({
      relay: { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-m' },
      key: enrolKey,
      knownHosts: () => join(ssh.dir, 'known_hosts'),
    })

    expect(await enrol.check()).toEqual({ ok: true, version: 1 })
    expect(await enrol.list()).toEqual({ ok: true, names: [] })
    expect(await enrol.add('mac-1', PUB_KEY)).toEqual({ ok: true })
    expect(await enrol.list()).toEqual({ ok: true, names: ['mac-1'] })
    expect(readFileSync(join(keysDir, 'mac-1.pub'), 'utf8')).toContain('mac-1')

    // Local validation refuses bad names and keys before spawning ssh
    const callsBefore = ssh.calls().length
    expect((await enrol.add('../evil', PUB_KEY)).ok).toBe(false)
    expect((await enrol.add('mac-2', 'not-a-key')).ok).toBe(false)
    expect((await enrol.remove('BadName')).ok).toBe(false)
    expect(ssh.calls()).toHaveLength(callsBefore)

    // Remove unlinks .pub and .sock
    writeFileSync(join(socketsDir, 'mac-1.sock'), '')
    expect(await enrol.remove('mac-1')).toEqual({ ok: true, removed: true })
    expect(await enrol.remove('mac-1')).toEqual({ ok: true, removed: false })
  })

  test('openRelayForward forwards bytes over a unix socket and closes cleanly', async () => {
    const ssh = await useFakeSsh()
    ssh.state({ ssh: { mode: 'forward' } })
    const socketsDir = mkdtempSync(join(tmpdir(), 'board-relay-open-'))
    const httpSrv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('hello-unix') })
    const sockPath = join(socketsDir, 'mac-1.sock')
    const httpPort = httpSrv.port ?? 0
    const unixProxy = createServer(client => {
      const { connect } = require('node:net') as typeof import('node:net')
      const peer = connect(httpPort, '127.0.0.1')
      client.pipe(peer)
      peer.pipe(client)
      client.on('error', () => peer.destroy())
      peer.on('error', () => client.destroy())
    })
    await new Promise<void>(r => unixProxy.listen(sockPath, r))
    try {
      const masterKey = join(ssh.dir, 'master-key')
      writeFileSync(masterKey, 'fake-master-key\n')
      const opened = await openRelayForward({
        relay: { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-m' },
        socket: 'mac-1',
        key: masterKey,
        knownHosts: () => join(ssh.dir, 'known_hosts'),
        socketsDir,
      })
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      try {
        const res = await fetch(`http://127.0.0.1:${opened.forward.localPort}/`)
        expect(await res.text()).toBe('hello-unix')
      } finally {
        await opened.forward.close()
      }
    } finally {
      unixProxy.close()
      httpSrv.stop(true)
      rmSync(socketsDir, { recursive: true, force: true })
    }
  })
})

describe('createLink with relayPipeDeps', () => {
  test('refuses missing cert, missing master key, and wrong ssh host key without contacting a door', async () => {
    const ssh = await useFakeSsh()
    const store = createDeviceStore({ dir: join(ssh.dir, 'nodes') })
    const relayLink: LinkConfig = { kind: 'relay', socket: 'mac-1' }
    const deps = relayPipeDeps(
      'mac-1',
      relayLink,
      { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-m' },
      store,
      {
        knownHosts: () => join(ssh.dir, 'known_hosts'),
      },
    )

    // No pinned cert yet -> refused 'cert', zero ssh calls
    const lNoCert = linkTo(device('mac-1', relayLink), { token: () => 'T'.repeat(43), relay: deps })
    const sNoCert = await until(
      () => lNoCert.state(),
      s => s.state === 'refused',
    )
    expect(sNoCert.reason).toBe('cert')
    expect(ssh.calls()).toHaveLength(0)

    // Pinned cert set, no master key -> refused 'key', zero ssh calls
    const certA = generateDoorCert('mac-1')
    store.setCert('mac-1', certA.cert)
    const lNoKey = linkTo(device('mac-1', relayLink), { token: () => 'T'.repeat(43), relay: deps })
    const sNoKey = await until(
      () => lNoKey.state(),
      s => s.state === 'refused',
    )
    expect(sNoKey.reason).toBe('key')
    expect(ssh.calls()).toHaveLength(0)

    // Master key present, ssh host key mismatch -> refused 'host-key'
    mkdirSync(join(ssh.dir, 'nodes', 'relay'), { recursive: true })
    writeFileSync(store.relayKeyPath('master'), 'fake-master-key\n')
    ssh.state({ ssh: { mode: 'hostkey' } })
    const lBadHost = linkTo(device('mac-1', relayLink), { token: () => 'T'.repeat(43), relay: deps })
    const sBadHost = await until(
      () => lBadHost.state(),
      s => s.state === 'refused',
    )
    expect(sBadHost.reason).toBe('host-key')
  })

  test('refuses a door presenting another certificate with reason "cert", never leaks token, and UI renders it', async () => {
    const ssh = await useFakeSsh()
    ssh.state({ ssh: { mode: 'forward' } })
    const socketsDir = mkdtempSync(join(tmpdir(), 'board-relay-cert-'))
    const certExpected = generateDoorCert('mac-1')
    const certRogue = generateDoorCert('rogue')
    const seenHeaders: Record<string, string>[] = []
    const rogueDoor = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: certRogue.cert, key: certRogue.key },
      fetch(req) {
        seenHeaders.push(Object.fromEntries(req.headers))
        return new Response(JSON.stringify({ node: { api: 1, id: 'mac-1', claimed: true } }))
      },
    })
    const sockPath = join(socketsDir, 'mac-1.sock')
    const roguePort = rogueDoor.port ?? 0
    const unixProxy = createServer(client => {
      const { connect } = require('node:net') as typeof import('node:net')
      const peer = connect(roguePort, '127.0.0.1')
      client.pipe(peer)
      peer.pipe(client)
      client.on('error', () => peer.destroy())
      peer.on('error', () => client.destroy())
    })
    await new Promise<void>(r => unixProxy.listen(sockPath, r))
    try {
      const store = createDeviceStore({ dir: join(ssh.dir, 'nodes') })
      store.setCert('mac-1', certExpected.cert)
      mkdirSync(join(ssh.dir, 'nodes', 'relay'), { recursive: true })
      writeFileSync(store.relayKeyPath('master'), 'fake-master-key\n')
      const relayLink: LinkConfig = { kind: 'relay', socket: 'mac-1' }
      const deps = relayPipeDeps(
        'mac-1',
        relayLink,
        { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-m' },
        store,
        {
          knownHosts: () => join(ssh.dir, 'known_hosts'),
          socketsDir,
        },
      )
      const link = linkTo(device('mac-1', relayLink), { token: () => 'S'.repeat(43), relay: deps })
      const st = await until(
        () => link.state(),
        s => s.state === 'refused',
      )
      expect(st.reason).toBe('cert')
      expect(seenHeaders).toHaveLength(0)

      // UI model renders the 'cert' refusal clearly in EN and RU
      const view = link.view()
      expect(linkWords(view, Date.now(), translate, false)).toBe('Refused: it answers with another certificate')
      const [row] = deviceRows(
        [
          {
            id: view.id,
            title: view.title,
            kind: view.kind,
            link: view.link,
            status: null,
            sameCommit: null,
            payloadAt: null,
            maxSessions: null,
            minFreeMemMb: null,
            maxLoad: null,
            paused: false,
            drain: false,
          },
        ],
        Date.now(),
        translate,
      )
      expect(row?.link).toBe('Refused: it answers with another certificate')
      const ruT = Object.assign(
        (k: string, p?: Record<string, unknown>) =>
          k === 'node.dev.why.cert'
            ? 'отвечает с другим сертификатом'
            : k === 'node.dev.link.refused'
              ? `Отказ: ${String(p?.why ?? '')}`
              : k,
        { lang: 'ru' as const },
      )
      expect(linkWords(view, Date.now(), ruT, false)).toBe('Отказ: отвечает с другим сертификатом')
    } finally {
      unixProxy.close()
      rogueDoor.stop(true)
      rmSync(socketsDir, { recursive: true, force: true })
    }
  })
})
