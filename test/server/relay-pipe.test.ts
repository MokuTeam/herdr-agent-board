// End-to-end tests of the relay pipe and pinned TLS door (#512, docs/design/nodes 14 T17, 20.1):
// - Door with node.tls: true generates door-cert.pem/door-key.pem, answers HTTPS only, exposes cert
//   fingerprint in /api/hello, refuses plain HTTP and wrong pinned cert; tls: false creates no cert.
// - Stand-in relay (two sandbox boards + unix socket via fake-ssh): node ssh -R + master ssh -L,
//   payload aggregation, proxied session route, and rogue cert refusal ('cert') without token leak.
// - Real unprivileged OpenSSH verification: real sshd + real ssh -R and ssh -L + real enrol.
// - Without relay/tls keys: no ssh spawned, no certificate files, same route table and /api/hello.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  certFingerprint,
  doorCertPath,
  doorKeyPath,
  generateDoorCert,
  isCertError,
  pinnedTls,
} from '../../src/adapters/door-cert.ts'
import {
  createDeviceStore,
  createNodeStore,
  nodeRelayKeyPath,
  nodeRelayKnownHostsPath,
  nodeRelayPidFile,
  relayKeyPath,
} from '../../src/adapters/node-store.ts'
import { t as translate } from '../../src/core/lang.ts'
import type { DeviceView } from '../../src/core/nodes.ts'
import {
  relayEnrolKeyLine,
  relayEnrolScript,
  relayMasterFenceSettings,
  relayMasterKeyLine,
  relayNodeFenceSettings,
} from '../../src/core/relay-texts.ts'
import { createRelayEnrol } from '../../src/services/nodes/relay.ts'
import { deviceRows } from '../../web/src/models/devices.ts'
import { logged, serveBoard, unusedPort } from '../support/board-server.ts'
import { sh } from '../support/fake-root.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { PAIR_ENV, showPanes } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { routeTable, stateFolder } from '../support/tunnel-board.ts'

setDefaultTimeout(60_000)

const sshdBin = ['/usr/sbin/sshd', '/sbin/sshd'].find(p => existsSync(p)) ?? null

async function waitPort(port: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock = connect(port, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        sock.destroy()
        resolve(false)
      })
    })
    if (ok) return
    await Bun.sleep(50)
  }
  throw new Error(`port ${port} did not open`)
}

async function waitDevice(url: string, id: string, ok: (d: DeviceView) => boolean, ms = 15_000): Promise<DeviceView> {
  const deadline = Date.now() + ms
  let last: DeviceView | undefined
  for (;;) {
    const res = await fetch(`${url}/api/nodes`)
    if (res.ok) {
      const devices = ((await res.json()) as { devices: DeviceView[] }).devices
      last = devices.find(d => d.id === id)
      if (last && ok(last)) return last
    }
    if (Date.now() > deadline) throw new Error(`device ${id} never matched: ${JSON.stringify(last)}`)
    await Bun.sleep(30)
  }
}

describe('the pinned TLS door', () => {
  test('node with tls: true answers HTTPS only, exposes cert fingerprint in hello, refuses plain HTTP and wrong cert', async () => {
    const box = await sandbox()
    showPanes(box, [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: 's-tls' }, agent_status: 'idle', cwd: box.dir },
    ])
    const nodeDir = join(stateFolder(box), 'node')
    mkdirSync(nodeDir, { recursive: true })
    const { token } = createNodeStore({ dir: nodeDir }).add('master', 'hand')
    const doorPort = await unusedPort()
    const { proc } = await serveBoard(
      box,
      { language: 'en', node: { id: 'nat-1', port: doorPort, workRoot: box.dir, tls: true } },
      PAIR_ENV,
    )
    await until(() => logged(proc, `node door: listening on 127.0.0.1:${doorPort} as nat-1 (tls)`), 10_000)

    const certFile = doorCertPath(nodeDir)
    const keyFile = doorKeyPath(nodeDir)
    expect(existsSync(certFile)).toBe(true)
    expect(existsSync(keyFile)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(certFile).mode & 0o777).toBe(0o600)
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    }
    const certPem = readFileSync(certFile, 'utf8')
    const expectedFp = certFingerprint(certPem)

    // Plain HTTP is refused by the TLS door
    await expect(fetch(`http://127.0.0.1:${doorPort}/api/hello`)).rejects.toThrow()

    // HTTPS with pinned cert succeeds and /api/hello includes `cert`
    const helloRes = await fetch(`https://127.0.0.1:${doorPort}/api/hello`, { tls: pinnedTls(certPem) })
    expect(helloRes.status).toBe(200)
    const hello = (await helloRes.json()) as { node: { api: number; id: string; claimed: boolean; cert?: string } }
    expect(hello.node).toEqual({ api: 1, id: 'nat-1', claimed: true, cert: expectedFp })

    // Authenticated request over pinned TLS works
    const boardRes = await fetch(`https://127.0.0.1:${doorPort}/api/board`, {
      headers: { authorization: `Bearer ${token}` },
      tls: pinnedTls(certPem),
    })
    expect(boardRes.status).toBe(200)

    // Wrong pinned cert is refused as a certificate error
    const other = generateDoorCert('other')
    let wrongErr: unknown
    try {
      await fetch(`https://127.0.0.1:${doorPort}/api/hello`, { tls: pinnedTls(other.cert) })
    } catch (err) {
      wrongErr = err
    }
    expect(isCertError(wrongErr)).toBe(true)
  })

  test('node with tls: false creates no cert files and omits cert from hello', async () => {
    const box = await sandbox()
    const nodeDir = join(stateFolder(box), 'node')
    const doorPort = await unusedPort()
    const { proc } = await serveBoard(
      box,
      { language: 'en', node: { id: 'plain-1', port: doorPort, workRoot: box.dir } },
      PAIR_ENV,
    )
    await until(() => logged(proc, `node door: listening on 127.0.0.1:${doorPort} as plain-1`), 10_000)
    expect(existsSync(doorCertPath(nodeDir))).toBe(false)
    expect(existsSync(doorKeyPath(nodeDir))).toBe(false)
    const hello = (await (await fetch(`http://127.0.0.1:${doorPort}/api/hello`)).json()) as {
      node: Record<string, unknown>
    }
    expect(hello.node).toEqual({ api: 1, id: 'plain-1', claimed: false })
  })
})

describe('stand-in relay pipe between two sandbox boards', () => {
  test('connects master and node through unix socket, aggregates cards, proxies actions, and refuses rogue cert', async () => {
    const fake = await fakeSshBin()
    const socketsDir = mkdtempSync(join(tmpdir(), 'board-relay-standin-'))
    try {
      // 1. Node board behind NAT with tls: true and relay config
      const nodeBox = await sandbox()
      showPanes(nodeBox, [
        { pane_id: 'p1', agent: 'claude', agent_session: { value: 's-nat-1' }, agent_status: 'idle', cwd: nodeBox.dir },
      ])
      const nDir = join(stateFolder(nodeBox), 'node')
      mkdirSync(nDir, { recursive: true })
      const { token } = createNodeStore({ dir: nDir }).add('master', 'hand')
      writeFileSync(nodeRelayKeyPath(nDir), 'fake-node-relay-key\n', { mode: 0o600 })

      const nodeSshState = join(nodeBox.dir, 'ssh-state.json')
      writeFileSync(nodeSshState, JSON.stringify({ ssh: { mode: 'forward', unixForward: true } }))
      const nodeDoorPort = await unusedPort()
      const { proc: nodeProc } = await serveBoard(
        nodeBox,
        {
          language: 'en',
          node: {
            id: 'nat-1',
            port: nodeDoorPort,
            workRoot: nodeBox.dir,
            tls: true,
            relay: { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-n', socket: 'nat-1' },
          },
        },
        {
          ...PAIR_ENV,
          BOARD_SSH_BIN_PATH: fake,
          BOARD_SSH_KEYGEN_BIN_PATH: fake,
          FAKE_SSH_STATE: nodeSshState,
          FAKE_SSH_LOG: join(nodeBox.dir, 'ssh.jsonl'),
          BOARD_RELAY_SOCKETS_DIR: socketsDir,
        },
      )
      await until(() => logged(nodeProc, `node door: listening on 127.0.0.1:${nodeDoorPort} as nat-1 (tls)`), 10_000)
      const sockPath = join(socketsDir, 'nat-1.sock')
      await until(() => existsSync(sockPath), 10_000)
      const certPem = readFileSync(doorCertPath(nDir), 'utf8')

      // 2. Master board with relay device and pinned door-cert.pem
      const masterBox = await sandbox()
      const mNodesDir = join(stateFolder(masterBox), 'nodes')
      const store = createDeviceStore({ dir: mNodesDir })
      store.setToken('nat-1', token)
      store.setCert('nat-1', certPem)
      mkdirSync(join(mNodesDir, 'relay'), { recursive: true })
      writeFileSync(relayKeyPath('master', mNodesDir), 'fake-master-relay-key\n', { mode: 0o600 })

      const masterSshState = join(masterBox.dir, 'ssh-state.json')
      writeFileSync(masterSshState, JSON.stringify({ ssh: { mode: 'forward' } }))
      const { url: masterUrl } = await serveBoard(
        masterBox,
        {
          language: 'en',
          nodes: {
            id: 'laptop',
            relay: { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-m' },
            devices: { 'nat-1': { link: { kind: 'relay', socket: 'nat-1' } } },
          },
        },
        {
          ...PAIR_ENV,
          BOARD_SSH_BIN_PATH: fake,
          BOARD_SSH_KEYGEN_BIN_PATH: fake,
          FAKE_SSH_STATE: masterSshState,
          FAKE_SSH_LOG: join(masterBox.dir, 'ssh.jsonl'),
          BOARD_RELAY_SOCKETS_DIR: socketsDir,
        },
      )

      const online = await waitDevice(
        masterUrl,
        'nat-1',
        d => d.link?.state === 'online' && d.payloadAt !== null && d.status !== null,
      )
      expect(online.kind).toBe('relay')
      expect(online.status?.id).toBe('nat-1')

      // Aggregated payload contains the node's prefixed card
      await until(async () => {
        const res = await fetch(`${masterUrl}/api/board`)
        const body = (await res.json()) as { items: { key: string; device?: string }[] }
        return body.items.some(i => i.key === '@nat-1:s-nat-1' && i.device === 'nat-1')
      }, 10_000)

      // Proxied card sheet request works over the relay pipe
      const sheetRes = await fetch(`${masterUrl}/api/session/${encodeURIComponent('@nat-1:s-nat-1')}`)
      expect(sheetRes.status).toBe(200)

      // 3. Rogue door with a different cert behind a new unix socket -> master refuses with 'cert' and never leaks token
      const rogueCert = generateDoorCert('rogue')
      const rogueAuths: string[] = []
      const rogueSrv = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        tls: { cert: rogueCert.cert, key: rogueCert.key },
        fetch(req) {
          const auth = req.headers.get('authorization')
          if (auth) rogueAuths.push(auth)
          return new Response(JSON.stringify({ node: { api: 1, id: 'nat-1', claimed: true } }))
        },
      })
      const rogueSocketsDir = mkdtempSync(join(tmpdir(), 'board-relay-rogue-'))
      const rogueSock = join(rogueSocketsDir, 'nat-1.sock')
      const roguePort = rogueSrv.port ?? 0
      const rogueUnix = createServer(client => {
        const peer = connect(roguePort, '127.0.0.1')
        client.pipe(peer)
        peer.pipe(client)
        client.on('error', () => peer.destroy())
        peer.on('error', () => client.destroy())
      })
      await new Promise<void>(r => rogueUnix.listen(rogueSock, r))
      try {
        const rogueMaster = await sandbox()
        const rmNodesDir = join(stateFolder(rogueMaster), 'nodes')
        const rmStore = createDeviceStore({ dir: rmNodesDir })
        rmStore.setToken('nat-1', token)
        rmStore.setCert('nat-1', certPem)
        mkdirSync(join(rmNodesDir, 'relay'), { recursive: true })
        writeFileSync(relayKeyPath('master', rmNodesDir), 'fake-master-relay-key\n', { mode: 0o600 })
        const rmSshState = join(rogueMaster.dir, 'ssh-state.json')
        writeFileSync(rmSshState, JSON.stringify({ ssh: { mode: 'forward' } }))
        const { url: rmUrl } = await serveBoard(
          rogueMaster,
          {
            language: 'en',
            nodes: {
              id: 'laptop',
              relay: { host: 'ssh.example.com', sshPort: 22, user: 'agent-board-relay-m' },
              devices: { 'nat-1': { link: { kind: 'relay', socket: 'nat-1' } } },
            },
          },
          {
            ...PAIR_ENV,
            BOARD_SSH_BIN_PATH: fake,
            BOARD_SSH_KEYGEN_BIN_PATH: fake,
            FAKE_SSH_STATE: rmSshState,
            BOARD_RELAY_SOCKETS_DIR: rogueSocketsDir,
          },
        )
        const refused = await waitDevice(rmUrl, 'nat-1', d => d.link?.state === 'refused')
        expect(refused.link?.reason).toBe('cert')
        expect(rogueAuths).toEqual([])
        const nodesRes = await (await fetch(`${rmUrl}/api/nodes`)).json()
        const [row] = deviceRows((nodesRes as { devices: never[] }).devices, Date.now(), translate)
        expect(row?.link).toBe('Refused: it answers with another certificate')
      } finally {
        rogueUnix.close()
        rogueSrv.stop(true)
        rmSync(rogueSocketsDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(socketsDir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!sh || !sshdBin)('real unprivileged OpenSSH relay pipe verification', () => {
  test('real sshd + real ssh -R + real ssh -L + real enrol + pinned TLS door end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-relay-real-'))
    const procs: ChildProcess[] = []
    try {
      chmodSync(dir, 0o700)
      const socketsDir = join(dir, 'sockets')
      const keysDir = join(dir, 'keys')
      mkdirSync(socketsDir, { mode: 0o770 })
      mkdirSync(keysDir, { mode: 0o700 })

      const hostKey = join(dir, 'host_ed25519')
      const masterKey = join(dir, 'master_ed25519')
      const enrolKey = join(dir, 'enrol_ed25519')
      const nodeKey = join(dir, 'node_ed25519')
      for (const k of [hostKey, masterKey, enrolKey, nodeKey]) {
        const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', k], { encoding: 'utf8' })
        expect(r.status).toBe(0)
      }
      const masterPub = readFileSync(`${masterKey}.pub`, 'utf8').trim()
      const enrolPub = readFileSync(`${enrolKey}.pub`, 'utf8').trim()
      const nodePub = readFileSync(`${nodeKey}.pub`, 'utf8').trim()

      const enrolPath = join(dir, 'enrol.sh')
      writeFileSync(enrolPath, relayEnrolScript({ keysDir, socketsDir }), { mode: 0o755 })
      chmodSync(enrolPath, 0o755)

      const masterKeysPath = join(dir, 'master_keys')
      writeFileSync(masterKeysPath, `${relayMasterKeyLine(masterPub)}\n${relayEnrolKeyLine(enrolPub, enrolPath)}\n`, {
        mode: 0o600,
      })

      const nodeKeysPath = join(dir, 'node_keys')
      const nodeBody = nodePub.split(/\s+/).slice(0, 2).join(' ')
      writeFileSync(nodeKeysPath, `restrict,port-forwarding ${nodeBody}\n`, { mode: 0o600 })

      const me = userInfo().username
      const masterPort = await unusedPort()
      const nodePort = await unusedPort()

      const masterConf = join(dir, 'sshd_master.conf')
      writeFileSync(
        masterConf,
        [
          `Port ${masterPort}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${hostKey}`,
          'StrictModes no',
          'PidFile none',
          'UsePAM no',
          'LogLevel ERROR',
          `Match User ${me}`,
          ...relayMasterFenceSettings(masterKeysPath).map(([k, v]) => `    ${k} ${v}`),
          'Match all',
          '',
        ].join('\n'),
      )

      const nodeFenceOnly = relayNodeFenceSettings().filter(
        ([k]) => k !== 'AuthorizedKeysFile' && k !== 'AuthorizedKeysCommand' && k !== 'AuthorizedKeysCommandUser',
      )
      const nodeConf = join(dir, 'sshd_node.conf')
      writeFileSync(
        nodeConf,
        [
          `Port ${nodePort}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${hostKey}`,
          'StrictModes no',
          'PidFile none',
          'UsePAM no',
          'LogLevel ERROR',
          `Match User ${me}`,
          `    AuthorizedKeysFile ${nodeKeysPath}`,
          ...nodeFenceOnly.map(([k, v]) => `    ${k} ${v}`),
          'Match all',
          '',
        ].join('\n'),
      )

      for (const conf of [masterConf, nodeConf]) {
        procs.push(spawn(sshdBin as string, ['-D', '-e', '-f', conf], { stdio: ['ignore', 'pipe', 'pipe'] }))
      }
      await Promise.all([waitPort(masterPort), waitPort(nodePort)])

      // 1. Real enrol client against real sshd
      const enrol = createRelayEnrol({
        relay: { host: '127.0.0.1', sshPort: masterPort, user: me },
        key: enrolKey,
        knownHosts: () => join(dir, 'enrol_known_hosts'),
      })
      expect(await enrol.check()).toEqual({ ok: true, version: 1 })
      expect(await enrol.add('nat-real', nodePub)).toEqual({ ok: true })
      expect(await enrol.list()).toEqual({ ok: true, names: ['nat-real'] })

      // 2. Node board dials real nodeSshd with real ssh -R
      const nodeBox = await sandbox()
      showPanes(nodeBox, [
        {
          pane_id: 'p1',
          agent: 'claude',
          agent_session: { value: 's-real-1' },
          agent_status: 'idle',
          cwd: nodeBox.dir,
        },
      ])
      const nDir = join(stateFolder(nodeBox), 'node')
      mkdirSync(nDir, { recursive: true })
      const { token } = createNodeStore({ dir: nDir }).add('master', 'hand')
      copyFileSync(nodeKey, nodeRelayKeyPath(nDir))
      chmodSync(nodeRelayKeyPath(nDir), 0o600)

      const nodeDoorPort = await unusedPort()
      const realSsh = Bun.which('ssh') ?? '/usr/bin/ssh'
      const realKeygen = Bun.which('ssh-keygen') ?? '/usr/bin/ssh-keygen'
      const { proc: nodeProc } = await serveBoard(
        nodeBox,
        {
          language: 'en',
          node: {
            id: 'nat-real',
            port: nodeDoorPort,
            workRoot: nodeBox.dir,
            tls: true,
            relay: { host: '127.0.0.1', sshPort: nodePort, user: me, socket: 'nat-real' },
          },
        },
        {
          ...PAIR_ENV,
          BOARD_SSH_BIN_PATH: realSsh,
          BOARD_SSH_KEYGEN_BIN_PATH: realKeygen,
          BOARD_RELAY_SOCKETS_DIR: socketsDir,
        },
      )
      await until(() => logged(nodeProc, `node door: listening on 127.0.0.1:${nodeDoorPort} as nat-real (tls)`), 10_000)
      const sockPath = join(socketsDir, 'nat-real.sock')
      await until(() => existsSync(sockPath), 15_000)

      // 3. Master board dials real masterSshd with real ssh -L and pinned cert
      const masterBox = await sandbox()
      const mNodesDir = join(stateFolder(masterBox), 'nodes')
      const store = createDeviceStore({ dir: mNodesDir })
      store.setToken('nat-real', token)
      store.setCert('nat-real', readFileSync(doorCertPath(nDir), 'utf8'))
      mkdirSync(join(mNodesDir, 'relay'), { recursive: true })
      copyFileSync(masterKey, relayKeyPath('master', mNodesDir))
      chmodSync(relayKeyPath('master', mNodesDir), 0o600)

      const { url: masterUrl } = await serveBoard(
        masterBox,
        {
          language: 'en',
          nodes: {
            id: 'laptop',
            relay: { host: '127.0.0.1', sshPort: masterPort, user: me },
            devices: { 'nat-real': { link: { kind: 'relay', socket: 'nat-real' } } },
          },
        },
        {
          ...PAIR_ENV,
          BOARD_SSH_BIN_PATH: realSsh,
          BOARD_SSH_KEYGEN_BIN_PATH: realKeygen,
          BOARD_RELAY_SOCKETS_DIR: socketsDir,
        },
      )

      const online = await waitDevice(
        masterUrl,
        'nat-real',
        d => d.link?.state === 'online' && d.payloadAt !== null && d.status !== null,
        20_000,
      )
      expect(online.kind).toBe('relay')
      expect(online.status?.id).toBe('nat-real')

      // 4. Enrol remove deletes both .pub and .sock on the server
      expect(await enrol.remove('nat-real')).toEqual({ ok: true, removed: true })
      expect(existsSync(join(keysDir, 'nat-real.pub'))).toBe(false)
      expect(existsSync(sockPath)).toBe(false)
    } finally {
      for (const p of procs) {
        try {
          p.kill('SIGKILL')
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('without relay keys: other setups stay unchanged', () => {
  test('plain board and non-relay node/master spawn no ssh, create no certs, and keep route table identical', async () => {
    const fake = await fakeSshBin()
    const envWithFake = (box: Sandbox) => ({
      ...PAIR_ENV,
      TEST_ROUTE_TABLE: '1',
      BOARD_SSH_BIN_PATH: fake,
      BOARD_SSH_KEYGEN_BIN_PATH: fake,
      FAKE_SSH_LOG: join(box.dir, 'ssh.jsonl'),
    })

    const plainBox = await sandbox()
    const plain = await serveBoard(plainBox, { language: 'en' }, envWithFake(plainBox))

    const nodeBox = await sandbox()
    const doorPort = await unusedPort()
    const node = await serveBoard(
      nodeBox,
      { language: 'en', node: { id: 'server-1', port: doorPort, workRoot: nodeBox.dir } },
      envWithFake(nodeBox),
    )

    const masterBox = await sandbox()
    await serveBoard(
      masterBox,
      {
        language: 'en',
        nodes: {
          id: 'laptop',
          devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:9' } } },
        },
      },
      envWithFake(masterBox),
    )

    await Bun.sleep(400)

    // Route table of plain vs node without relay/tls is identical
    expect(routeTable(node.proc)).toEqual(routeTable(plain.proc))
    expect(await (await fetch(`${node.url}/api/hello`)).text()).toBe(
      await (await fetch(`${plain.url}/api/hello`)).text(),
    )

    // No ssh calls and no relay/cert files created
    expect(existsSync(join(plainBox.dir, 'ssh.jsonl'))).toBe(false)
    expect(existsSync(join(nodeBox.dir, 'ssh.jsonl'))).toBe(false)
    expect(existsSync(join(masterBox.dir, 'ssh.jsonl'))).toBe(false)
    expect(existsSync(doorCertPath(join(stateFolder(nodeBox), 'node')))).toBe(false)
    expect(existsSync(nodeRelayPidFile(join(stateFolder(nodeBox), 'node')))).toBe(false)
    expect(existsSync(nodeRelayKnownHostsPath(join(stateFolder(nodeBox), 'node')))).toBe(false)
    expect(existsSync(join(stateFolder(masterBox), 'nodes', 'relay'))).toBe(false)
  })
})
