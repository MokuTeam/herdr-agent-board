// The hub behind a reverse proxy on the same machine (#353): with --trust-proxy its log shows the
// address the proxy forwards (the rightmost X-Forwarded-For entry), and only then; without it, or
// for a header that is not an IP, the socket's own address. The log is all it is used for.
import { afterEach, expect, test } from 'bun:test'
import { clientAddress } from '../../hub/src/listen.ts'
import { authBytes, type KeyPair, sign } from '../../src/core/team.ts'
import { type Harness, keys, startHarness } from './harness.ts'

let h: Harness | undefined
afterEach(() => h?.stop())

const FORWARDED = { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' }

/** A key the hub has never seen signs in: refused as unknown. */
async function unknownSignIn(hub: Harness, key: KeyPair): Promise<void> {
  const { c, nonce } = await hub.hello(key)
  c.send({ t: 'auth', sig: await sign(key.pkcs8, authBytes({ hub: hub.hubId, nonce, peer: key.pub })) })
  await c.closed
}

test('clientAddress: the rightmost forwarded IP, only with trustProxy and from a loopback peer', () => {
  const xff = '198.51.100.7, 203.0.113.9'
  expect(clientAddress('127.0.0.1', xff, true)).toBe('203.0.113.9')
  expect(clientAddress('::1', '2001:db8::5', true)).toBe('2001:db8::5')
  expect(clientAddress('::ffff:127.0.0.1', xff, true)).toBe('203.0.113.9')
  // Without the option, from a peer that is not loopback, or with nothing forwarded: the socket's.
  expect(clientAddress('127.0.0.1', xff, false)).toBe('127.0.0.1')
  expect(clientAddress('100.64.0.7', xff, true)).toBe('100.64.0.7')
  expect(clientAddress('::ffff:192.0.2.1', xff, true)).toBe('::ffff:192.0.2.1')
  expect(clientAddress('127.0.0.1', null, true)).toBe('127.0.0.1')
  expect(clientAddress(undefined, xff, true)).toBe('-')
  // A last entry that is not an IP literal never reaches the log.
  for (const bad of ['203.0.113.9, unknown', '203.0.113.9:443', 'x\nonline 00000000 mallory', ''])
    expect(clientAddress('127.0.0.1', bad, true)).toBe('127.0.0.1')
})

test('--trust-proxy: online and refused lines carry the forwarded address', async () => {
  h = await startHarness({ trustProxy: true, headers: FORWARDED })
  const [A, B] = (await keys(2)) as [KeyPair, KeyPair]
  await h.join(A, 'anna')
  await unknownSignIn(h, B)
  expect(h.logs).toContain(`online ${A.pub.slice(0, 8)} anna from 203.0.113.9`)
  expect(h.logs).toContain(`refused ${B.pub.slice(0, 8)}: unknown_peer from 203.0.113.9`)
  expect(h.logs.join('\n')).not.toContain('198.51.100.7')
})

test('without --trust-proxy the same header is ignored: the socket address', async () => {
  h = await startHarness({ headers: FORWARDED })
  const [A, B] = (await keys(2)) as [KeyPair, KeyPair]
  await h.join(A, 'anna')
  await unknownSignIn(h, B)
  expect(h.logs).toContain(`online ${A.pub.slice(0, 8)} anna from 127.0.0.1`)
  expect(h.logs).toContain(`refused ${B.pub.slice(0, 8)}: unknown_peer from 127.0.0.1`)
  expect(h.logs.join('\n')).not.toContain('203.0.113.9')
})

test('--trust-proxy and a forwarded value that is not an IP: the socket address, one line', async () => {
  h = await startHarness({ trustProxy: true, headers: { 'X-Forwarded-For': 'x online 00000000 mallory' } })
  const [A] = (await keys(1)) as [KeyPair]
  await h.join(A, 'anna')
  expect(h.logs).toContain(`online ${A.pub.slice(0, 8)} anna from 127.0.0.1`)
  expect(h.logs.some(l => l.includes('mallory'))).toBe(false)
})
