// Unit and service tests for "Add a computer" (src/services/nodes/computer-setup.ts, #513):
// - Enrols dial public key, builds one-line paste without master token
// - Refuses untrusted hello (missing proof, wrong proof, mismatched cert fingerprint, claimed)
// - Claims on Approve over pinned cert, pins cert, writes config, runs finish steps
// - Removes unclaimed enrolled key on expiry (10m TTL, paced in test), cancel, and sweepExpired
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { joinProof } from '../../src/core/node-join.ts'
import type { Config } from '../../src/core/types.ts'
import { createComputerSetup } from '../../src/services/nodes/computer-setup.ts'
import {
  createRelayForwardPool,
  probeComputerDoor,
  readRelayHostKey,
  verifyComputerHello,
} from '../../src/services/nodes/computer-setup-io.ts'
import { until } from '../support/sandbox.ts'

function makeTestCert(dir: string): { certPem: string; fp: string } {
  const openssl = Bun.which('openssl')
  if (openssl) {
    const key = join(dir, 'k.pem')
    const cert = join(dir, 'c.pem')
    const r = spawnSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
      ],
      { encoding: 'utf8' },
    )
    if (r.status === 0) {
      const certPem = readFileSync(cert, 'utf8')
      const fp = createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
      return { certPem, fp }
    }
  }
  const certPem = '-----BEGIN CERTIFICATE-----\nTESTCERT\n-----END CERTIFICATE-----\n'
  return { certPem, fp: 'ab'.repeat(32) }
}

const FAKE_DIAL_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBTestFakeDialKeyForServiceTests0000000000000000000000000',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

function harness(
  opts: {
    joinTtlMs?: number
    pollMs?: number
    retryBaseMs?: number
    retryMaxMs?: number
    now?: () => number
    removeBehavior?: (socket: string) => { ok: true } | { ok: false; error: string }
    activateRelayKey?: (socket: string, pub: string) => { ok: true } | { ok: false; status?: number; error: string }
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-csetup-'))
  const enrolled = new Map<string, string>()
  const removed: string[] = []
  const pinnedCerts = new Map<string, string>()
  const activatedKeys: string[] = []
  const store = createDeviceStore({ dir: join(dir, 'nodes') })
  const cfg: Config = {
    language: 'en',
    placement: 'workspace',
    workspace: '',
    refreshSec: 2,
    wakeUrl: null,
    scheduleWaitMin: 1,
    categories: [{ id: 'other', title: 'Other', color: 'gray', paths: [] }],
    nodes: { id: 'atlas-master', relay: { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-m' } },
  }
  const cert = makeTestCert(dir)
  let nextProbe: ((socket: string) => Awaited<ReturnType<Parameters<typeof createComputerSetup>[0]['probe']>>) | null =
    null
  let nextClaim:
    | ((
        socket: string,
        req: { certPem: string; code: string; masterName: string; nonce?: string },
      ) =>
        | { ok: true; token: string; id: string; relayPublicKey?: string }
        | { ok: false; status?: number; error: string })
    | null = null
  let clockNow = 1_800_000_000_000
  const now = opts.now ?? (() => clockNow)
  const pendingFile = join(dir, 'nodes', 'relay', 'pending-enrols.json')

  const setup = createComputerSetup({
    cfg,
    relayHostKey: async () => 'relay.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeRelayHostKey',
    generateDialKey: async () => ({
      ok: true,
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeDialPubKey',
      privateKey: FAKE_DIAL_KEY,
    }),
    enrol: {
      add: async (_relay, socket, pub) => {
        enrolled.set(socket, pub)
        return { ok: true }
      },
      remove: async (_relay, socket) => {
        const res = opts.removeBehavior ? opts.removeBehavior(socket) : { ok: true as const }
        if (!res.ok) return res
        enrolled.delete(socket)
        removed.push(socket)
        return { ok: true }
      },
    },
    probe: async (_relay, socket) => (nextProbe ? nextProbe(socket) : null),
    claim: async (_relay, socket, req) =>
      nextClaim
        ? nextClaim(socket, req)
        : { ok: true, token: 'T'.repeat(43), id: 'anna-mac', relayPublicKey: 'ssh-ed25519 AAAAPermKey' },
    activateRelayKey: async (_relay, socket, req) => {
      if (opts.activateRelayKey) return opts.activateRelayKey(socket, req.publicKey)
      activatedKeys.push(req.publicKey)
      return { ok: true }
    },
    pinCert: (id, pem) => pinnedCerts.set(id, pem),
    store,
    editNodes: change => {
      const nodes = (cfg.nodes ?? {}) as Record<string, unknown>
      change(nodes, true)
      return { ok: true }
    },
    follow: () => {},
    links: () => ({
      link: id =>
        id
          ? ({
              state: () => ({ state: 'online', since: now(), heardAt: now() }),
              status: async () => ({
                api: 1,
                id,
                version: '0.1.0',
                commit: 'c',
                platform: 'darwin',
                arch: 'arm64',
                cpus: 8,
                memTotalMb: 16384,
                memAvailableMb: 8192,
                load: [0.5, 0.5, 0.5],
                sessions: { awake: 0, working: 0, asleep: 0 },
                launches: 0,
                workRootFreeMb: 50_000,
                profiles: [{ id: 'default', loggedIn: false, bundle: null }],
                agents: ['claude'],
                at: now(),
              }),
            } as never)
          : null,
      retry: () => true,
    }),
    bundles: () => ({
      syncIfBehind: async id => ({
        ok: true,
        device: id,
        profile: 'default',
        nodeProfile: 'default',
        seq: 1,
        hash: 'a'.repeat(64),
        sent: 1,
        applied: ['skills/a.md'],
        kept: [],
        backup: null,
        lines: [],
        at: now(),
      }),
    }),
    commit: async () => 'c1585a76',
    hostName: () => 'atlas-master',
    pendingFile: () => pendingFile,
    onChange: () => {},
    log: () => {},
    now,
    newId: () => 'id-1',
    joinTtlMs: opts.joinTtlMs ?? 60_000,
    pollMs: opts.pollMs ?? 20,
    linkWaitMs: 2000,
    retryBaseMs: opts.retryBaseMs ?? 20,
    retryMaxMs: opts.retryMaxMs ?? 80,
    pause: ms => Bun.sleep(Math.min(ms, 20)),
  })

  return {
    dir,
    cfg,
    cert,
    enrolled,
    removed,
    pinnedCerts,
    activatedKeys,
    store,
    pendingFile,
    setup,
    advance: (ms: number) => {
      clockNow += ms
    },
    setProbe: (fn: typeof nextProbe) => {
      nextProbe = fn
    },
    setClaim: (fn: typeof nextClaim) => {
      nextClaim = fn
    },
    cleanup: () => {
      setup.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('createComputerSetup service (#513)', () => {
  test('enrols key, verifies HMAC proof in hello, claims over pinned cert, and updates config', async () => {
    const h = harness()
    try {
      const started = await h.setup.start()
      expect(started.status).toBe(200)
      const v1 = h.setup.view()
      const pasteKeyName = `${v1.socket}-init`
      expect(v1.phase).toBe('waiting')
      expect(v1.command).toMatch(
        /^echo [A-Za-z0-9+/=]+ \| \{ case \$\(uname -s\) in Darwin\) base64 -D;; \*\) base64 -d;; esac; \} \| gunzip \| sh$/,
      )
      expect(h.enrolled.has(pasteKeyName)).toBe(true)
      expect(existsSync(h.pendingFile)).toBe(true)

      // Extract the join code from the generated script to simulate the node's hello
      const script = gunzipSync(Buffer.from((v1.command ?? '').split(' ')[1] ?? '', 'base64')).toString('utf8')
      const m = /JOIN_JSON='([^']+)'/.exec(script)
      const joinCode = (JSON.parse(m?.[1] ?? '{}') as { code: string }).code

      // Wrong proof / wrong cert / claimed hello are all ignored and never reach 'found'
      let probeCalls = 0
      h.setProbe(() => {
        probeCalls++
        if (probeCalls === 1) {
          return {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: h.cert.fp,
            hello: {
              host: 'anna-mbp',
              platform: 'darwin',
              version: '0.1.0',
              node: {
                api: 1,
                id: 'anna-mac',
                claimed: false,
                join: { fingerprint: h.cert.fp, proof: '0'.repeat(64), expiresAt: v1.expiresAt },
              },
            },
          }
        }
        if (probeCalls === 2) {
          return {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: 'ff'.repeat(32),
            hello: {
              host: 'anna-mbp',
              platform: 'darwin',
              version: '0.1.0',
              node: {
                api: 1,
                id: 'anna-mac',
                claimed: false,
                join: {
                  fingerprint: h.cert.fp,
                  proof: joinProof(joinCode, h.cert.fp, 'anna-mac'),
                  expiresAt: v1.expiresAt,
                },
              },
            },
          }
        }
        return {
          ok: true,
          certPem: h.cert.certPem,
          certFingerprint: h.cert.fp,
          hello: {
            host: 'anna-mbp',
            platform: 'darwin',
            version: '0.1.0',
            node: {
              api: 1,
              id: 'anna-mac',
              claimed: false,
              join: {
                fingerprint: h.cert.fp,
                proof: joinProof(joinCode, h.cert.fp, 'anna-mac'),
                expiresAt: v1.expiresAt,
              },
            },
          },
        }
      })

      await until(() => h.setup.view().phase === 'found', 5000)
      expect(probeCalls).toBeGreaterThanOrEqual(3)
      expect(h.setup.view().found).toEqual({
        id: 'anna-mac',
        host: 'anna-mbp',
        platform: 'darwin',
        version: '0.1.0',
        fingerprint: h.cert.fp,
      })

      const mismatched = await h.setup.approve({ id: 'renamed-id' })
      expect(mismatched.status).toBe(409)
      expect(h.setup.view().phase).toBe('found')

      const approved = await h.setup.approve({ id: 'anna-mac' })
      expect([approved.status, approved.body]).toEqual([200, { ok: true, id: 'anna-mac' }])
      const vDone = h.setup.view()
      expect(vDone.phase).toBe('done')
      expect(vDone.command).toBeNull()
      expect(vDone.script).toBeNull()
      expect(h.pinnedCerts.get('anna-mac')).toBe(h.cert.certPem)
      expect(h.activatedKeys).toEqual(['ssh-ed25519 AAAAPermKey'])
      // Paste key was removed and replaced by the node's own rotated relay key under socket name
      expect(h.enrolled.has(`${v1.socket}-init`)).toBe(false)
      expect(h.enrolled.get(v1.socket ?? '')).toBe('ssh-ed25519 AAAAPermKey')
      h.store.setCert('anna-mac', h.cert.certPem)
      expect(h.store.cert('anna-mac')).toBe(`${h.cert.certPem.trim()}\n`)
      expect(h.store.token('anna-mac')).toBe('T'.repeat(43))
      expect((h.cfg.nodes as { devices: Record<string, unknown> }).devices['anna-mac']).toMatchObject({
        link: { kind: 'relay', socket: v1.socket },
      })
      expect(existsSync(h.pendingFile)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('verifyComputerHello and computer setup never pin on forged hellos and expose waiting hints (#513)', async () => {
    const h = harness({ pollMs: 15 })
    try {
      const code = 'JoinCode_0123456789abcdef'
      const proof = joinProof(code, h.cert.fp, 'anna-mac')
      expect(
        verifyComputerHello(
          {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: h.cert.fp,
            hello: {
              host: 'anna',
              platform: 'darwin',
              version: '0.1',
              node: {
                api: 1,
                id: 'anna-mac',
                claimed: false,
                cert: h.cert.fp,
                join: { fingerprint: h.cert.fp, proof, expiresAt: 2e12 },
              },
            },
          },
          'WrongCode_0123456789abcdef',
        ),
      ).toEqual({ ok: false, reason: 'bad-proof' })
      expect(
        verifyComputerHello(
          {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: h.cert.fp,
            hello: {
              host: 'anna',
              platform: 'darwin',
              version: '0.1',
              node: {
                api: 1,
                id: 'other-node',
                claimed: false,
                cert: h.cert.fp,
                join: { fingerprint: h.cert.fp, proof, expiresAt: 2e12 },
              },
            },
          },
          code,
        ),
      ).toEqual({ ok: false, reason: 'bad-proof' })
      expect(
        verifyComputerHello(
          {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: 'ee'.repeat(32),
            hello: {
              host: 'anna',
              platform: 'darwin',
              version: '0.1',
              node: {
                api: 1,
                id: 'anna-mac',
                claimed: false,
                cert: h.cert.fp,
                join: { fingerprint: h.cert.fp, proof, expiresAt: 2e12 },
              },
            },
          },
          code,
        ),
      ).toEqual({ ok: false, reason: 'bad-fingerprint' })
      expect(
        verifyComputerHello(
          {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: h.cert.fp,
            hello: {
              host: 'anna',
              platform: 'darwin',
              version: '0.1',
              node: { api: 1, id: 'anna-mac', claimed: true },
            },
          },
          code,
        ),
      ).toEqual({ ok: false, reason: 'claimed' })
      expect(
        verifyComputerHello(
          {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: h.cert.fp,
            hello: {
              host: 'anna',
              platform: 'darwin',
              version: '0.1',
              node: { api: 1, id: 'anna-mac', claimed: false, cert: h.cert.fp },
            },
          },
          code,
        ),
      ).toEqual({ ok: false, reason: 'burned-code' })
      expect(
        verifyComputerHello(
          {
            ok: true,
            certPem: h.cert.certPem,
            certFingerprint: h.cert.fp,
            hello: {
              host: 'anna',
              platform: 'darwin',
              version: '0.1',
              node: { api: 1, id: 'anna-mac', claimed: false },
            },
          },
          code,
        ),
      ).toEqual({ ok: false, reason: 'old-plugin' })

      // Service sets UI hints during waiting and never calls pinCert for forged/claimed hellos
      h.setProbe(() => ({
        ok: true,
        certPem: h.cert.certPem,
        certFingerprint: h.cert.fp,
        hello: { host: 'anna', platform: 'darwin', version: '0.1', node: { api: 1, id: 'anna-mac', claimed: true } },
      }))
      await h.setup.start()
      await until(() => h.setup.view().next?.key === 'node.computer.hint.claimed', 3000)
      expect(h.pinnedCerts.size).toBe(0)
      expect(h.setup.view().phase).toBe('waiting')
    } finally {
      h.cleanup()
    }
  })

  test('claim is idempotent across transient errors, and genuine 409 keeps relay key with board node forget hint', async () => {
    const h = harness()
    try {
      await h.setup.start()
      const script = gunzipSync(Buffer.from((h.setup.view().command ?? '').split(' ')[1] ?? '', 'base64')).toString(
        'utf8',
      )
      const joinCode = (JSON.parse((/JOIN_JSON='([^']+)'/.exec(script) ?? [])[1] ?? '{}') as { code: string }).code
      h.setProbe(() => ({
        ok: true,
        certPem: h.cert.certPem,
        certFingerprint: h.cert.fp,
        hello: {
          host: 'anna',
          platform: 'darwin',
          version: '0.1',
          node: {
            api: 1,
            id: 'anna-mac',
            claimed: false,
            join: {
              fingerprint: h.cert.fp,
              proof: joinProof(joinCode, h.cert.fp, 'anna-mac'),
              expiresAt: h.setup.view().expiresAt ?? Date.now() + 60_000,
            },
          },
        },
      }))
      await until(() => h.setup.view().phase === 'found', 3000)

      // 1st Approve suffers aborted reply after the door processed claim
      const nonces: (string | undefined)[] = []
      let attempts = 0
      h.setClaim((_sock, req) => {
        attempts++
        nonces.push(req.nonce)
        if (attempts === 1) return { ok: false, error: 'The operation was aborted due to timeout' }
        return { ok: true, token: 'T'.repeat(43), id: 'anna-mac' }
      })
      const r1 = await h.setup.approve({ id: 'anna-mac' })
      expect(r1.status).toBe(502)
      expect(h.setup.view().phase).toBe('failed')

      // 2nd Approve sends the exact same nonce and succeeds
      const r2 = await h.setup.approve({ id: 'anna-mac' })
      expect(r2.status).toBe(200)
      expect(nonces[0]).toBeTruthy()
      expect(nonces[1]).toBe(nonces[0])
      expect(h.setup.view().phase).toBe('done')

      // Separate genuine 409 from another master: key is kept and owner told to run board node forget
      const h2 = harness()
      try {
        await h2.setup.start()
        const sock = h2.setup.view().socket ?? ''
        const pasteKey = `${sock}-init`
        const sc2 = gunzipSync(Buffer.from((h2.setup.view().command ?? '').split(' ')[1] ?? '', 'base64')).toString(
          'utf8',
        )
        const c2 = (JSON.parse((/JOIN_JSON='([^']+)'/.exec(sc2) ?? [])[1] ?? '{}') as { code: string }).code
        h2.setProbe(() => ({
          ok: true,
          certPem: h2.cert.certPem,
          certFingerprint: h2.cert.fp,
          hello: {
            host: 'anna',
            platform: 'darwin',
            version: '0.1',
            node: {
              api: 1,
              id: 'anna-mac',
              claimed: false,
              join: { fingerprint: h2.cert.fp, proof: joinProof(c2, h2.cert.fp, 'anna-mac'), expiresAt: 2e12 },
            },
          },
        }))
        await until(() => h2.setup.view().phase === 'found', 3000)
        h2.setClaim(() => ({ ok: false, status: 409, error: 'claimed' }))
        const r409 = await h2.setup.approve({ id: 'anna-mac' })
        expect(r409.status).toBe(409)
        expect(h2.enrolled.has(pasteKey)).toBe(true)
        expect(h2.removed).toEqual([])
        expect(h2.setup.view().next?.key).toBe('node.computer.next.claimed')
      } finally {
        h2.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  test('enrolled key removal on expiry retries with backoff, preserves pending entry, and shows failure in view.error', async () => {
    let failures = 2
    const h = harness({
      joinTtlMs: 60,
      pollMs: 15,
      retryBaseMs: 25,
      retryMaxMs: 60,
      now: Date.now,
      removeBehavior: () => (failures-- > 0 ? { ok: false, error: 'relay unreachable' } : { ok: true }),
    })
    try {
      await h.setup.start()
      const pasteKey = `${h.setup.view().socket}-init`
      await until(() => h.setup.view().phase === 'expired', 3000)
      // Failed first removal keeps pending entry and surfaces error in view.error
      expect(h.setup.view().error).toContain('relay unreachable')
      expect(h.enrolled.has(pasteKey)).toBe(true)
      expect(existsSync(h.pendingFile)).toBe(true)

      // Backoff retries succeed and clean up pending-enrols.json + error
      await until(() => !existsSync(h.pendingFile) && !h.enrolled.has(pasteKey), 3000)
      expect(h.setup.view().error).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('relay forward pool reuses live forward across repeated polls and readRelayHostKey normalizes lines', async () => {
    let opens = 0
    let closes = 0
    const pool = createRelayForwardPool(async () => {
      opens++
      return {
        ok: true,
        forward: {
          localPort: 45123,
          alive: () => true,
          close: async () => {
            closes++
          },
          killNow: () => {},
        },
      }
    })
    const relay = { host: 'relay.example.com', sshPort: 2222, user: 'agent-board-relay-m' }
    let fetchCalls = 0
    const tmpCertDir = mkdtempSync(join(tmpdir(), 'ab-pool-cert-'))
    const poolCert = makeTestCert(tmpCertDir)
    try {
      const probeOpts = {
        pool,
        probeCert: async () => ({ cert: poolCert.certPem, fingerprint: poolCert.fp }),
        fetchFn: async () => {
          fetchCalls++
          return Response.json({
            host: 'anna',
            platform: 'darwin',
            version: '0.1',
            node: { api: 1, id: 'anna-mac', claimed: false },
          })
        },
      }
      expect((await probeComputerDoor(relay, 'anna-1', probeOpts))?.ok).toBe(true)
      expect((await probeComputerDoor(relay, 'anna-1', probeOpts))?.ok).toBe(true)
      expect(opens).toBe(1)
      expect(fetchCalls).toBe(2)
      await pool.closeAll()
      expect(closes).toBe(1)
    } finally {
      rmSync(tmpCertDir, { recursive: true, force: true })
    }

    const tmp = mkdtempSync(join(tmpdir(), 'ab-rkh-'))
    try {
      const kh = join(tmp, 'kh')
      writeFileSync(kh, 'placeholder\n')
      const normalized = await readRelayHostKey('Relay.Example.com', 2222, {
        bin: () => '/usr/bin/ssh-keygen',
        knownHosts: () => kh,
        run: async () => ({
          code: 0,
          killed: false,
          error: null,
          stdout: '# Host found\n|1|salt|hash ssh-ed25519 AAAAC3NzaComment\n',
          stderr: '',
        }),
      })
      expect(normalized).toBe('[relay.example.com]:2222 ssh-ed25519 AAAAC3NzaComment')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('enrolled key not claimed within TTL is removed from the server automatically', async () => {
    const h = harness({ joinTtlMs: 80, pollMs: 15, now: Date.now })
    try {
      await h.setup.start()
      const sock = h.setup.view().socket ?? ''
      const pasteKey = `${sock}-init`
      expect(h.enrolled.has(pasteKey)).toBe(true)

      await until(() => h.setup.view().phase === 'expired', 3000)
      expect(h.enrolled.has(pasteKey)).toBe(false)
      expect(h.removed).toContain(pasteKey)
      expect(h.setup.view().command).toBeNull()
      expect(existsSync(h.pendingFile)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('cancel removes enrolled key, and sweepExpired cleans leftover expired keys after restart', async () => {
    const h = harness()
    try {
      await h.setup.start()
      const sock = h.setup.view().socket ?? ''
      const pasteKey = `${sock}-init`
      expect(h.enrolled.has(pasteKey)).toBe(true)
      await h.setup.cancel()
      expect(h.enrolled.has(pasteKey)).toBe(false)
      expect(h.removed).toContain(pasteKey)
      expect(h.removed).toContain(sock)
      expect(h.setup.view().phase).toBe('idle')

      // Simulate restart with an expired pending enrolment on disk
      mkdirSync(join(h.dir, 'nodes', 'relay'), { recursive: true })
      h.enrolled.set('stale-sock-1', 'ssh-ed25519 AAAA')
      writeFileSync(h.pendingFile, JSON.stringify([{ socket: 'stale-sock-1', expiresAt: 1000 }]))
      await h.setup.sweepExpired()
      expect(h.enrolled.has('stale-sock-1')).toBe(false)
      expect(h.removed).toContain('stale-sock-1')
      expect(existsSync(h.pendingFile)).toBe(false)
    } finally {
      h.cleanup()
    }
  })
})
