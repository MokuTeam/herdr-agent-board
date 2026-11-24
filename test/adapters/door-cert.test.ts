// Self-signed TLS certificate and SHA-256 pinning (adapters/door-cert.ts) and DeviceStore's
// pinned certificate storage (adapters/node-store.ts).
import { describe, expect, test } from 'bun:test'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  certFingerprint,
  doorCertPath,
  doorKeyPath,
  ensureDoorCert,
  generateDoorCert,
  isCertError,
  isValidCertPem,
  pinnedTls,
  readDoorCert,
} from '../../src/adapters/door-cert.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'

describe('door certificate generation and storage', () => {
  test('generateDoorCert produces a valid ECDSA X.509 v3 cert with loopback SANs and fingerprint', () => {
    const pair = generateDoorCert('mac-1')
    expect(isValidCertPem(pair.cert)).toBe(true)
    expect(pair.key).toContain('-----BEGIN PRIVATE KEY-----')
    expect(pair.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(certFingerprint(pair.cert)).toBe(pair.fingerprint)

    const x509 = new X509Certificate(pair.cert)
    expect(x509.subject).toContain('CN=agent-board-node:mac-1')
    expect(x509.ca).toBe(false)
    expect(x509.subjectAltName).toContain('DNS:localhost')
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(x509.subjectAltName).toContain('IP Address:0:0:0:0:0:0:0:1')
    expect(createHash('sha256').update(x509.raw).digest('hex')).toBe(pair.fingerprint)
  })

  test('ensureDoorCert persists 0600 files once, recovers from key-only state, and refuses cert-only or mismatched state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-door-cert-'))
    try {
      expect(readDoorCert(dir)).toBeNull()
      const first = ensureDoorCert('node-a', dir)
      expect(existsSync(doorCertPath(dir))).toBe(true)
      expect(existsSync(doorKeyPath(dir))).toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(doorCertPath(dir)).mode & 0o777).toBe(0o600)
        expect(statSync(doorKeyPath(dir)).mode & 0o777).toBe(0o600)
      }
      const second = ensureDoorCert('node-a', dir)
      expect(second).toEqual(first)

      // Crash after writing door-key.pem before door-cert.pem: treated as absent and regenerated cleanly
      rmSync(doorCertPath(dir))
      expect(readDoorCert(dir)).toBeNull()
      const regenerated = ensureDoorCert('node-a', dir)
      expect(isValidCertPem(regenerated.cert)).toBe(true)
      expect(regenerated.fingerprint).not.toBe(first.fingerprint)
      expect(readDoorCert(dir)).toEqual(regenerated)

      // Cert-only state (missing key) throws instead of silently rotating a pinned cert
      rmSync(doorKeyPath(dir))
      expect(() => readDoorCert(dir)).toThrow('incomplete')
      expect(() => ensureDoorCert('node-a', dir)).toThrow('incomplete')

      // Mismatched key/cert throws
      const other = generateDoorCert('node-b')
      writeFileSync(doorKeyPath(dir), other.key)
      expect(() => readDoorCert(dir)).toThrow('does not match')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pinnedTls and isCertError', () => {
  test('pinnedTls accepts matching cert over HTTPS and SSE, refuses other cert, and distinguishes non-cert errors', async () => {
    const a = generateDoorCert('node-a')
    const b = generateDoorCert('node-b')
    const srv = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: a.cert, key: a.key },
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/events') {
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
                c.close()
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(req.headers.get('host') ?? 'ok')
      },
    })
    const plainSrv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('plain') })
    const resetSrv = createServer(s => s.destroy())
    await new Promise<void>(r => resetSrv.listen(0, '127.0.0.1', r))
    const resetPort = (resetSrv.address() as { port: number }).port

    try {
      // Matching pinned cert works for request and SSE stream, even with a custom Host header
      const res = await fetch(`https://127.0.0.1:${srv.port}/hello`, {
        headers: { host: '127.0.0.1:12430' },
        tls: pinnedTls(a.cert),
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('127.0.0.1:12430')

      const sse = await fetch(`https://127.0.0.1:${srv.port}/events`, { tls: pinnedTls(a.cert) })
      expect(sse.status).toBe(200)
      expect(await sse.text()).toBe('data: {"ok":true}\n\n')

      // Different pinned cert fails and isCertError() classifies it as a cert error
      let mismatchErr: unknown
      try {
        await fetch(`https://127.0.0.1:${srv.port}/hello`, { tls: pinnedTls(b.cert) })
      } catch (err) {
        mismatchErr = err
      }
      expect(mismatchErr).toBeDefined()
      expect(isCertError(mismatchErr)).toBe(true)

      // Plain HTTP to TLS door fails
      await expect(fetch(`http://127.0.0.1:${srv.port}/hello`)).rejects.toThrow()

      // HTTPS to plain HTTP server is a protocol error, NOT a cert mismatch
      let plainErr: unknown
      try {
        await fetch(`https://127.0.0.1:${plainSrv.port}/`, { tls: pinnedTls(a.cert) })
      } catch (err) {
        plainErr = err
      }
      expect(plainErr).toBeDefined()
      expect(isCertError(plainErr)).toBe(false)

      // Immediate TCP reset (e.g. ssh -L while remote socket is not listening yet) is NOT a cert mismatch
      let resetErr: unknown
      try {
        await fetch(`https://127.0.0.1:${resetPort}/`, { tls: pinnedTls(a.cert) })
      } catch (err) {
        resetErr = err
      }
      expect(resetErr).toBeDefined()
      expect(isCertError(resetErr)).toBe(false)
    } finally {
      srv.stop(true)
      plainSrv.stop(true)
      resetSrv.close()
    }
  })

  test('isCertError matches message-only pinning failures and ignores unrelated errors', () => {
    expect(isCertError(new Error('door certificate does not match the pinned certificate'))).toBe(true)
    expect(isCertError(new Error('door certificate missing raw DER bytes'))).toBe(true)
    expect(isCertError(new Error('socket hang up'))).toBe(false)
  })
})

describe('DeviceStore pinned cert persistence', () => {
  test('cert reads valid PEM on disk, rejects corrupt PEM, and dropCredentials removes door-cert.pem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-store-cert-'))
    try {
      const store = createDeviceStore({ dir })
      const pair = generateDoorCert('mac-1')
      expect(store.cert('mac-1')).toBeNull()

      mkdirSync(store.dir('mac-1'), { recursive: true })
      writeFileSync(store.certPath('mac-1'), pair.cert, { mode: 0o600 })
      expect(store.cert('mac-1')).toBe(pair.cert)
      if (process.platform !== 'win32') expect(statSync(store.certPath('mac-1')).mode & 0o777).toBe(0o600)
      expect(readFileSync(store.certPath('mac-1'), 'utf8')).toBe(pair.cert)

      // Corrupt file on disk returns null instead of throwing
      mkdirSync(store.dir('mac-2'), { recursive: true })
      writeFileSync(store.certPath('mac-2'), 'corrupt\n')
      expect(store.cert('mac-2')).toBeNull()

      store.dropCredentials('mac-1')
      expect(existsSync(store.certPath('mac-1'))).toBe(false)
      expect(store.cert('mac-1')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
