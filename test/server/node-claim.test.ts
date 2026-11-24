// Node door claim tests (#513): wrong code, dead/expired code, five wrong codes ending the
// code, successful claim returning a working bearer token, second claim (sequential and
// concurrent) returning 409, and /api/hello omitting `join` when join.json is absent.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { certFingerprint, pinnedTls, probeDoorCert } from '../../src/adapters/door-cert.ts'
import { createNodeJoinStore } from '../../src/adapters/node-join-store.ts'
import { generateJoinCode, verifyJoinProof } from '../../src/core/node-join.ts'
import { logged, serveBoard, unusedPort } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const PACE = { BOARD_TEST_PACE: '0.02' }
const nodeFolder = (box: Sandbox): string => join(stateFolder(box), 'node')
const listening = (proc: Child, port: number): boolean =>
  logged(proc, `node door: listening on 127.0.0.1:${port} as atlas-node`)

function doorClient(port: number, certPem?: string) {
  const base = `${certPem ? 'https' : 'http'}://127.0.0.1:${port}`
  const host = `127.0.0.1:${port}`
  const tlsOpt = certPem ? { tls: pinnedTls(certPem) } : {}
  return {
    hello: () => fetch(`${base}/api/hello`, { headers: { host }, ...tlsOpt }),
    claim: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/node/claim`, {
        method: 'POST',
        headers: { host, 'content-type': 'application/json', 'x-board': '1', ...headers },
        body: JSON.stringify(body),
        ...tlsOpt,
      }),
    status: (token: string) =>
      fetch(`${base}/api/node/status`, {
        headers: { host, authorization: `Bearer ${token}` },
        ...tlsOpt,
      }),
  }
}

async function setupDoor(cfg: Record<string, unknown> = {}, envExtra: Record<string, string> = {}) {
  const box = await sandbox()
  const doorPort = await unusedPort()
  const { url, proc } = await serveBoard(
    box,
    { language: 'en', node: { id: 'atlas-node', port: doorPort, ...cfg } },
    { ...PACE, ...envExtra },
  )
  await until(() => listening(proc, doorPort))
  const certPem = cfg.tls ? readFileSync(join(nodeFolder(box), 'door-cert.pem'), 'utf8') : undefined
  return { box, url, doorPort, certPem, client: doorClient(doorPort, certPem) }
}

describe('node door /api/node/claim (#513)', () => {
  test('hello omits join when no join.json exists; attaches verified join proof when tls + join.json exist', async () => {
    const { box, url, doorPort, certPem, client } = await setupDoor({ tls: true })
    if (!certPem) throw new Error('expected door-cert.pem to be generated on startup')
    const expectedFp = certFingerprint(certPem)
    const probed = await probeDoorCert(doorPort)
    expect(probed.fingerprint).toBe(expectedFp)

    const localHello = (await (await fetch(`${url}/api/hello`)).json()) as Record<string, unknown>

    // Without join.json: matches #512 main hello (with node.cert and no node.join)
    const h1 = (await (await client.hello()).json()) as { node: Record<string, unknown> }
    expect(h1).toEqual({ ...localHello, node: { api: 1, id: 'atlas-node', claimed: false, cert: expectedFp } })

    // With join.json: hello carries verified proof bound to TLS peer cert fingerprint
    const dir = nodeFolder(box)
    const code = generateJoinCode()
    const expiresAt = Date.now() + 600_000
    createNodeJoinStore({ dir }).write({ code, expiresAt })

    const h2 = (await (await client.hello()).json()) as {
      node: {
        api: number
        id: string
        claimed: boolean
        cert?: string
        join?: { fingerprint: string; proof: string; expiresAt: number }
      }
    }
    expect(h2.node.claimed).toBe(false)
    expect(h2.node.cert).toBe(expectedFp)
    expect(h2.node.join?.fingerprint).toBe(expectedFp)
    expect(h2.node.join?.expiresAt).toBe(expiresAt)
    expect(verifyJoinProof(code, expectedFp, 'atlas-node', h2.node.join?.proof ?? '')).toBe(true)
  }, 30_000)

  test('wrong code returns 403; five wrong codes end the code so the real code returns 410', async () => {
    const { box, client } = await setupDoor()
    const code = generateJoinCode()
    createNodeJoinStore({ dir: nodeFolder(box) }).write({ code, expiresAt: Date.now() + 600_000 })

    for (const remaining of [4, 3, 2, 1]) {
      const res = await client.claim({ code: 'WrongCode_000000000000', master: { name: 'anna-laptop' } })
      expect([res.status, await res.json()]).toEqual([403, { error: 'code', remaining }])
    }

    // 5th wrong code ends the join code and deletes join.json
    const fifth = await client.claim({ code: 'WrongCode_000000000000', master: { name: 'anna-laptop' } })
    expect([fifth.status, await fifth.json()]).toEqual([403, { error: 'code', remaining: 0, ended: true }])
    expect(existsSync(join(nodeFolder(box), 'join.json'))).toBe(false)

    // Real code is now dead (410)
    const after = await client.claim({ code, master: { name: 'anna-laptop' } })
    expect([after.status, await after.json()]).toEqual([410, { error: 'expired' }])
  }, 30_000)

  test('dead / expired code returns 410 and cleans up join.json', async () => {
    const { box, client } = await setupDoor()
    // No join.json at all
    const missing = await client.claim({ code: generateJoinCode(), master: { name: 'anna-laptop' } })
    expect([missing.status, await missing.json()]).toEqual([410, { error: 'expired' }])

    // Expired join.json
    const code = generateJoinCode()
    mkdirSync(nodeFolder(box), { recursive: true })
    writeFileSync(
      join(nodeFolder(box), 'join.json'),
      JSON.stringify({ code, expiresAt: Date.now() - 1000, attempts: 0 }),
    )
    const dead = await client.claim({ code, master: { name: 'anna-laptop' } })
    expect([dead.status, await dead.json()]).toEqual([410, { error: 'expired' }])
    expect(existsSync(join(nodeFolder(box), 'join.json'))).toBe(false)
  }, 30_000)

  test('successful claim issues working token once; second and concurrent claims return 409; guards apply', async () => {
    const { box, client } = await setupDoor()
    const code = generateJoinCode()
    createNodeJoinStore({ dir: nodeFolder(box) }).write({ code, expiresAt: Date.now() + 600_000 })

    // Missing X-Board, Origin present, or >4096-byte streaming body -> 403 / 400
    expect((await client.claim({ code, master: { name: 'm' } }, { 'x-board': '' })).status).toBe(403)
    expect((await client.claim({ code, master: { name: 'm' } }, { origin: 'https://evil.example' })).status).toBe(403)
    const bigStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(2500).fill(97))
        c.enqueue(new Uint8Array(2500).fill(98))
        c.close()
      },
    })
    const bigRes = await fetch(`http://127.0.0.1:${(await setupDoor()).doorPort}/api/node/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: bigStream,
    })
    expect(bigRes.status).toBe(400)

    const claimNonce = 'Nonce_0123456789abcdef'
    // Concurrent claims with different nonces: exactly one succeeds (200), the other is refused (409)
    const [r1, r2] = await Promise.all([
      client.claim({ code, master: { name: 'anna-laptop' }, nonce: claimNonce }),
      client.claim({ code, master: { name: 'ben-laptop' }, nonce: 'OtherNonce_0123456789' }),
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])
    const winner = r1.status === 200 ? r1 : r2
    const winnerNonce = r1.status === 200 ? claimNonce : 'OtherNonce_0123456789'
    const claimed = (await winner.json()) as { token: string; id: string }
    expect(claimed.id).toBe('atlas-node')
    expect(claimed.token.length).toBeGreaterThanOrEqual(32)

    // Repeat claim with the exact same nonce + code is idempotent (200 returning the same token)
    const replay = await client.claim({ code, master: { name: 'anna-laptop' }, nonce: winnerNonce })
    expect([replay.status, await replay.json()]).toEqual([200, claimed])

    // Token works on authenticated door routes, and join.json is gone
    expect((await client.status(claimed.token)).status).toBe(200)
    expect(existsSync(join(nodeFolder(box), 'join.json'))).toBe(false)

    // Subsequent claim with a different nonce or no nonce returns 409
    const second = await client.claim({ code, master: { name: 'cleo-laptop' }, nonce: 'FreshNonce_012345678' })
    expect([second.status, await second.json()]).toEqual([409, { error: 'claimed' }])

    // hello now shows claimed: true and no join field
    const h = (await (await client.hello()).json()) as { node: Record<string, unknown> }
    expect(h.node).toEqual({ api: 1, id: 'atlas-node', claimed: true })
  }, 30_000)

  test('relay node stages fresh keypair on claim and activates it on POST /api/node/relay-key', async () => {
    const sshKeygen = Bun.which('ssh-keygen') ?? ''
    const { box, doorPort, certPem, client } = await setupDoor(
      {
        tls: true,
        relay: { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-n', socket: 'atlas-sock-1' },
      },
      ...(sshKeygen ? [{ BOARD_SSH_KEYGEN_BIN_PATH: sshKeygen }] : []),
    )
    if (!certPem) throw new Error('expected certPem')
    const code = generateJoinCode()
    createNodeJoinStore({ dir: nodeFolder(box) }).write({ code, expiresAt: Date.now() + 600_000 })
    const claimRes = await client.claim({ code, master: { name: 'atlas-master' }, nonce: 'RelayNonce_012345678' })
    expect(claimRes.status).toBe(200)
    const body = (await claimRes.json()) as { token: string; id: string; relayPublicKey?: string }
    expect(typeof body.relayPublicKey).toBe('string')
    expect(body.relayPublicKey).toContain('ssh-ed25519 ')
    expect(existsSync(join(nodeFolder(box), 'relay-key.next'))).toBe(true)

    const tlsOpt = { tls: pinnedTls(certPem) }
    const wrong = await fetch(`https://127.0.0.1:${doorPort}/api/node/relay-key`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${doorPort}`,
        authorization: `Bearer ${body.token}`,
        'content-type': 'application/json',
        'x-board': '1',
      },
      body: JSON.stringify({
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherFakeKeyForTest00000000000000000000',
      }),
      ...tlsOpt,
    })
    expect(wrong.status).toBe(409)

    const act = await fetch(`https://127.0.0.1:${doorPort}/api/node/relay-key`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${doorPort}`,
        authorization: `Bearer ${body.token}`,
        'content-type': 'application/json',
        'x-board': '1',
      },
      body: JSON.stringify({ publicKey: body.relayPublicKey }),
      ...tlsOpt,
    })
    expect([act.status, await act.json()]).toEqual([200, { ok: true, rotated: true }])
    expect(readFileSync(join(nodeFolder(box), 'relay-key.pub'), 'utf8').trim()).toBe(body.relayPublicKey ?? '')

    // Repeat is idempotent
    const actAgain = await fetch(`https://127.0.0.1:${doorPort}/api/node/relay-key`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${doorPort}`,
        authorization: `Bearer ${body.token}`,
        'content-type': 'application/json',
        'x-board': '1',
      },
      body: JSON.stringify({ publicKey: body.relayPublicKey }),
      ...tlsOpt,
    })
    expect([actAgain.status, await actAgain.json()]).toEqual([200, { ok: true, rotated: false }])
  }, 30_000)
})
