// The way to the hub in one line (#356, core/team-reach.ts): DNS, TCP per family, TLS, a hint when
// only one family gets through, and whether the way is closed for sure (no other try).
import { expect, test } from 'bun:test'
import { describeReach, type Reach, wayClosed } from '../../src/core/team-reach.ts'

const base: Reach = {
  host: 'hub.example.com',
  port: 443,
  secure: true,
  stepMs: 4000,
  literal: false,
  dns: {
    ok: true,
    ms: 12,
    addresses: [
      { address: '2001:db8::5', family: 6 },
      { address: '203.0.113.5', family: 4 },
    ],
  },
  tcp: [
    { address: '2001:db8::5', family: 6, ok: false, ms: 4000, error: 'timeout' },
    { address: '203.0.113.5', family: 4, ok: true, ms: 30 },
  ],
  tls: { address: '203.0.113.5', ok: true, ms: 80 },
}

test('every step, the dead family named', () => {
  expect(describeReach(base)).toBe(
    'DNS hub.example.com → 2001:db8::5, 203.0.113.5 in 12 ms · TCP [2001:db8::5]:443 no answer in 4 s, 203.0.113.5:443 ok in 30 ms · TLS ok in 80 ms · IPv6 does not get through from here, IPv4 does',
  )
  expect(wayClosed(base)).toBe(false)
})

test('silence is not a no: a slow lookup, every address silent, a slow handshake leave the way open', () => {
  const slowDns: Reach = { ...base, dns: { ok: false, ms: 4000, error: 'timeout', addresses: [] }, tcp: [], tls: null }
  expect(describeReach(slowDns)).toBe('DNS hub.example.com: no answer in 4 s')
  expect(wayClosed(slowDns)).toBe(false)
  const silent: Reach = { ...base, tcp: base.tcp.map(s => ({ ...s, ok: false, error: 'timeout' })), tls: null }
  expect(wayClosed(silent)).toBe(false)
  expect(wayClosed({ ...base, tls: { address: '203.0.113.5', ok: false, ms: 4000, error: 'timeout' } })).toBe(false)
  expect(wayClosed({ ...base, tls: { address: '203.0.113.5', ok: false, ms: 9, error: 'ECONNRESET' } })).toBe(false)
})

test('a name that does not resolve: nothing else to say, no other try', () => {
  const r: Reach = { ...base, dns: { ok: false, ms: 3, error: 'ENOTFOUND', addresses: [] }, tcp: [], tls: null }
  expect(describeReach(r)).toBe('DNS hub.example.com: ENOTFOUND')
  expect(wayClosed(r)).toBe(true)
})

test('an address as the host: no DNS part; a refused port; a failed TLS stops the tries', () => {
  const refused: Reach = {
    ...base,
    host: '127.0.0.1',
    port: 9,
    secure: false,
    literal: true,
    dns: { ok: true, ms: 0, addresses: [{ address: '127.0.0.1', family: 4 }] },
    tcp: [{ address: '127.0.0.1', family: 4, ok: false, ms: 1, error: 'ECONNREFUSED' }],
    tls: null,
  }
  expect(describeReach(refused)).toBe('TCP 127.0.0.1:9 refused')
  expect(wayClosed(refused)).toBe(true)
  const badTls: Reach = { ...base, tls: { address: '203.0.113.5', ok: false, ms: 20, error: 'CERT_HAS_EXPIRED' } }
  expect(describeReach(badTls)).toContain('· TLS CERT_HAS_EXPIRED ·')
  expect(wayClosed(badTls)).toBe(true)
})
