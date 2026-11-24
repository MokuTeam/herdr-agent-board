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

async function setupDoor(cfg: Record<string, unknown> = {}) {
  const box = await sandbox()
  const doorPort = await unusedPort()
  const { url, proc } = await serveBoard(
    box,
    { language: 'en', node: { id: 'atlas-node', port: doorPort, ...cfg } },
    PACE,
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

    // Missing X-Board or Origin present -> 403
    expect((await client.claim({ code, master: { name: 'm' } }, { 'x-board': '' })).status).toBe(403)
    expect((await client.claim({ code, master: { name: 'm' } }, { origin: 'https://evil.example' })).status).toBe(403)

    // Concurrent claims: exactly one succeeds (200), the other is refused (409)
    const [r1, r2] = await Promise.all([
      client.claim({ code, master: { name: 'anna-laptop' } }),
      client.claim({ code, master: { name: 'ben-laptop' } }),
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])
    const winner = r1.status === 200 ? r1 : r2
    const claimed = (await winner.json()) as { token: string; id: string }
    expect(claimed.id).toBe('atlas-node')
    expect(claimed.token.length).toBeGreaterThanOrEqual(32)

    // Token works on authenticated door routes, and join.json is gone
    expect((await client.status(claimed.token)).status).toBe(200)
    expect(existsSync(join(nodeFolder(box), 'join.json'))).toBe(false)

    // Subsequent claim returns 409 even with another code
    const second = await client.claim({ code, master: { name: 'cleo-laptop' } })
    expect([second.status, await second.json()]).toEqual([409, { error: 'claimed' }])

    // hello now shows claimed: true and no join field
    const h = (await (await client.hello()).json()) as { node: Record<string, unknown> }
    expect(h.node).toEqual({ api: 1, id: 'atlas-node', claimed: true })
  }, 30_000)
})
