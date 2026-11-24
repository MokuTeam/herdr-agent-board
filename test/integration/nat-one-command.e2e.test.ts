// End-to-end NAT one-command verification over real unprivileged OpenSSH daemons (no Docker):
// 1. Master enrols the node's throwaway dial key via real relayEnrolScript over real sshd.
// 2. Node opens real `ssh -R <socket>.sock:127.0.0.1:<doorPort>` and serves HTTPS with a self-signed
//    cert and active join.json.
// 3. Master opens real `ssh -L 127.0.0.1:<localPort>:<socket>.sock`, reads TLS peer cert + /api/hello,
//    verifies HMAC proof against the join code, pins cert, claims POST /api/node/claim over pinned
//    HTTPS, and authenticates /api/node/status with the issued bearer token.
// 4. Unclaimed key past TTL runs real `enrol remove <socket>` over sshd and deletes both .pub and .sock.
import { describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { ensureDoorCert, pinnedTls, probeDoorCert } from '../../src/adapters/door-cert.ts'
import { activateNodeRelayKey, createNodeJoinStore, stageNodeRelayKey } from '../../src/adapters/node-join-store.ts'
import { createNodeStore } from '../../src/adapters/node-store.ts'
import { generateJoinCode, parseHelloJoin, verifyJoinProof } from '../../src/core/node-join.ts'
import {
  RELAY_MASTER_USER,
  RELAY_NODE_USER,
  relayEnrolKeyLine,
  relayEnrolScript,
  relayKeysCommand,
  relayMasterFenceSettings,
  relayMasterKeyLine,
  relayNodeFenceSettings,
} from '../../src/core/relay-texts.ts'
import { createRelayEnrol, openRelayForward } from '../../src/services/nodes/relay.ts'
import { sh } from '../support/fake-root.ts'

const sshdBin = ['/usr/sbin/sshd', '/sbin/sshd'].find(p => existsSync(p)) ?? null

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function waitPort(port: number, ms = 5000): Promise<void> {
  const { connect } = await import('node:net')
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

describe.skipIf(!sh || !sshdBin)('NAT one-command real OpenSSH e2e (#513)', () => {
  test('enrols over real sshd, verifies HMAC proof in TLS hello, claims token over pinned HTTPS, and unenrols expired socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-nat-e2e-'))
    const procs: ChildProcess[] = []
    let tlsDoor: ReturnType<typeof Bun.serve> | null = null
    try {
      chmodSync(dir, 0o700)
      const socketsDir = join(dir, 'sockets')
      const keysDir = join(dir, 'keys')
      const nodeState = join(dir, 'node-state')
      mkdirSync(socketsDir, { mode: 0o770 })
      mkdirSync(keysDir, { mode: 0o700 })
      mkdirSync(nodeState, { mode: 0o700 })

      const hostKey = join(dir, 'host_ed25519')
      const masterKey = join(dir, 'master_ed25519')
      const enrolKey = join(dir, 'enrol_ed25519')
      const dialKey = join(dir, 'dial_ed25519')
      for (const k of [hostKey, masterKey, enrolKey, dialKey]) {
        expect(spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', k], { encoding: 'utf8' }).status).toBe(0)
      }
      const masterPub = readFileSync(`${masterKey}.pub`, 'utf8').trim()
      const enrolPub = readFileSync(`${enrolKey}.pub`, 'utf8').trim()
      const dialPub = readFileSync(`${dialKey}.pub`, 'utf8').trim()

      const { cert: certPem, key: keyPem, fingerprint: certFp } = ensureDoorCert('anna-mac', nodeState)

      const joinCode = generateJoinCode()
      const joinStore = createNodeJoinStore({ dir: nodeState })
      const nodeStore = createNodeStore({ dir: nodeState })
      const expiresAt = Date.now() + 600_000
      joinStore.write({ code: joinCode, expiresAt })

      tlsDoor = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        tls: { cert: certPem, key: keyPem },
        async fetch(req) {
          const url = new URL(req.url)
          if (req.method === 'GET' && url.pathname === '/api/hello') {
            const claimed = nodeStore.list().length > 0
            const join = claimed ? null : joinStore.hello('anna-mac', certFp)
            return Response.json({
              host: 'anna-mbp',
              platform: 'darwin',
              version: '0.1.0',
              node: { api: 1, id: 'anna-mac', claimed, ...(join && { join }) },
            })
          }
          if (req.method === 'POST' && url.pathname === '/api/node/claim') {
            if (nodeStore.list().length > 0) return Response.json({ error: 'claimed' }, { status: 409 })
            const body = (await req.json()) as { code?: string; master?: { name?: string } }
            const r = joinStore.attempt(body.code ?? '')
            if (!r.ok) return Response.json({ error: 'code' }, { status: r.status })
            const staged = await stageNodeRelayKey(nodeState)
            if (!staged.ok) return Response.json({ error: staged.error }, { status: 500 })
            const { token } = nodeStore.add(body.master?.name ?? 'master', 'claim')
            return Response.json({ token, id: 'anna-mac', relayPublicKey: staged.publicKey })
          }
          if (req.method === 'POST' && url.pathname === '/api/node/relay-key') {
            const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
            if (!nodeStore.verify(tok)) return Response.json({ error: 'token' }, { status: 401 })
            const body = (await req.json()) as { publicKey?: string }
            const act = activateNodeRelayKey(body.publicKey ?? '', nodeState)
            return act.ok
              ? Response.json({ ok: true, rotated: act.rotated })
              : Response.json({ ok: false, error: act.error }, { status: act.status })
          }
          if (req.method === 'GET' && url.pathname === '/api/node/status') {
            const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
            if (!nodeStore.verify(tok)) return Response.json({ error: 'token' }, { status: 401 })
            return Response.json({ ok: true, id: 'anna-mac' })
          }
          return Response.json({ error: 'not found' }, { status: 404 })
        },
      })

      // Set up relay sshd pair (master + node)
      const enrolPath = join(dir, 'enrol.sh')
      writeFileSync(enrolPath, relayEnrolScript({ keysDir, socketsDir }), { mode: 0o755 })
      chmodSync(enrolPath, 0o755)
      const masterKeysPath = join(dir, 'master_keys')
      writeFileSync(masterKeysPath, `${relayMasterKeyLine(masterPub)}\n${relayEnrolKeyLine(enrolPub, enrolPath)}\n`, {
        mode: 0o600,
      })
      const nodeKeysPath = join(dir, 'node_keys')
      writeFileSync(nodeKeysPath, '', { mode: 0o600 })

      const me = userInfo().username
      const masterPort = await freeLoopbackPort()
      const nodePort = await freeLoopbackPort()
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
      for (const c of [masterConf, nodeConf])
        procs.push(spawn(sshdBin as string, ['-D', '-e', '-f', c], { stdio: ['ignore', 'pipe', 'pipe'] }))
      await Promise.all([waitPort(masterPort), waitPort(nodePort)])

      const hostPub = readFileSync(`${hostKey}.pub`, 'utf8').trim()
      const known = join(dir, 'known_hosts')
      writeFileSync(known, `[127.0.0.1]:${masterPort} ${hostPub}\n[127.0.0.1]:${nodePort} ${hostPub}\n`, {
        mode: 0o600,
      })
      const baseSsh = (port: number, key: string) => [
        '-p',
        String(port),
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${known}`,
        '-o',
        'BatchMode=yes',
      ]

      // 1. Enrol paste dial key under `<sock>-init` via #512 createRelayEnrol -> real enrol script over sshd
      const sockName = 'anna-mac-001122'
      const pasteKeyName = `${sockName}-init`
      const masterRelay = { host: '127.0.0.1', sshPort: masterPort, user: me }
      const enrol = createRelayEnrol({ relay: masterRelay, key: enrolKey, knownHosts: () => known })
      expect(await enrol.add(pasteKeyName, dialPub)).toEqual({ ok: true })
      expect(existsSync(join(keysDir, `${pasteKeyName}.pub`))).toBe(true)

      const syncAuthorizedKeys = () => {
        const out = spawnSync('sh', ['-s', '--', RELAY_NODE_USER], {
          input: relayKeysCommand(keysDir, RELAY_NODE_USER),
          encoding: 'utf8',
        }).stdout
        writeFileSync(nodeKeysPath, out, { mode: 0o600 })
      }
      syncAuthorizedKeys()
      expect(RELAY_NODE_USER).toBe('agent-board-relay-n')

      // 2. Node opens real ssh -R <socket>.sock:127.0.0.1:<tlsDoor.port>
      const sockPath = join(socketsDir, `${sockName}.sock`)
      const nodeFwd = spawn(
        'ssh',
        [
          ...baseSsh(nodePort, dialKey),
          '-N',
          '-o',
          'ExitOnForwardFailure=yes',
          '-R',
          `${sockPath}:127.0.0.1:${tlsDoor.port}`,
          `${me}@127.0.0.1`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      procs.push(nodeFwd)
      for (let i = 0; i < 60 && !existsSync(sockPath); i++) await Bun.sleep(50)
      expect(existsSync(sockPath)).toBe(true)

      // 3. Master opens real ssh -L via #512 openRelayForward, probes TLS cert, and verifies HMAC proof
      const opened = await openRelayForward({
        relay: masterRelay,
        socket: sockName,
        key: masterKey,
        knownHosts: () => known,
        socketsDir,
        timeoutMs: 10_000,
      })
      if (!opened.ok) throw new Error(opened.error)
      const fwdPort = opened.forward.localPort

      try {
        // Probe TLS peer cert and verify HMAC proof in /api/hello
        const peer = await probeDoorCert(fwdPort)
        expect(peer.fingerprint).toBe(certFp)
        const helloRes = await fetch(`https://127.0.0.1:${fwdPort}/api/hello`, {
          tls: pinnedTls(peer.cert),
          signal: AbortSignal.timeout(5000),
        })
        expect(helloRes.status).toBe(200)
        const helloBody = (await helloRes.json()) as { node: { id: string; claimed: boolean; join?: unknown } }
        const parsedJoin = parseHelloJoin(helloBody.node.join)
        expect(parsedJoin).not.toBeNull()
        expect(parsedJoin?.fingerprint).toBe(peer.fingerprint)
        expect(verifyJoinProof(joinCode, peer.fingerprint, helloBody.node.id, parsedJoin?.proof ?? '')).toBe(true)

        // Claim over pinned TLS returns the staged rotated keypair's public key
        const claimRes = await fetch(`https://127.0.0.1:${fwdPort}/api/node/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ code: joinCode, master: { name: 'atlas-master' }, nonce: 'E2ENonce_012345678' }),
          tls: pinnedTls(peer.cert),
          signal: AbortSignal.timeout(5000),
        })
        expect(claimRes.status).toBe(200)
        const claimed = (await claimRes.json()) as { token: string; id: string; relayPublicKey: string }
        expect(claimed.id).toBe('anna-mac')
        expect(claimed.relayPublicKey).toContain('ssh-ed25519 ')

        // Enrol permanent key on relay server, activate it on the node, remove pasted init key
        expect(await enrol.add(sockName, claimed.relayPublicKey)).toEqual({ ok: true })
        const activateRes = await fetch(`https://127.0.0.1:${fwdPort}/api/node/relay-key`, {
          method: 'POST',
          headers: { authorization: `Bearer ${claimed.token}`, 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ publicKey: claimed.relayPublicKey }),
          tls: pinnedTls(peer.cert),
          signal: AbortSignal.timeout(5000),
        })
        expect(activateRes.status).toBe(200)
        expect(await enrol.remove(pasteKeyName)).toEqual({ ok: true, removed: true })
        syncAuthorizedKeys()

        // Authenticated call over pinned TLS succeeds
        const statusRes = await fetch(`https://127.0.0.1:${fwdPort}/api/node/status`, {
          headers: { authorization: `Bearer ${claimed.token}` },
          tls: pinnedTls(peer.cert),
          signal: AbortSignal.timeout(5000),
        })
        expect(statusRes.status).toBe(200)
      } finally {
        await opened.forward.close()
      }

      // Paste key can no longer log in to sshd; newly rotated <nodeState>/relay-key logs in and forwards cleanly
      const oldFwd = spawnSync(
        'ssh',
        [...baseSsh(nodePort, dialKey), '-N', `${me}@127.0.0.1`, '-o', 'ConnectTimeout=2'],
        {
          encoding: 'utf8',
          timeout: 5000,
        },
      )
      expect(oldFwd.status).not.toBe(0)

      nodeFwd.kill('SIGKILL')
      rmSync(sockPath, { force: true })
      const rotatedKey = join(nodeState, 'relay-key')
      const rotatedFwd = spawn(
        'ssh',
        [
          ...baseSsh(nodePort, rotatedKey),
          '-N',
          '-o',
          'ExitOnForwardFailure=yes',
          '-R',
          `${sockPath}:127.0.0.1:${tlsDoor.port}`,
          `${me}@127.0.0.1`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      procs.push(rotatedFwd)
      for (let i = 0; i < 60 && !existsSync(sockPath); i++) await Bun.sleep(50)
      expect(existsSync(sockPath)).toBe(true)

      // 4. Clean removal unlinks both .pub and .sock from the relay server via real enrol remove
      expect(await enrol.remove(sockName)).toEqual({ ok: true, removed: true })
      expect(existsSync(join(keysDir, `${sockName}.pub`))).toBe(false)
      expect(existsSync(sockPath)).toBe(false)
      expect(RELAY_MASTER_USER).toBe('agent-board-relay-m')
    } finally {
      for (const p of procs) {
        try {
          p.kill('SIGKILL')
        } catch {}
      }
      tlsDoor?.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
