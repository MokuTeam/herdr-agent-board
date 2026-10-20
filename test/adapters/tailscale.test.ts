import { expect, test } from 'bun:test'
import { parseStatus, parseWhois } from '../../src/adapters/tailscale.ts'

// Shaped as Tailscale 1.104's `status --json` and `whois --json` print them, cut down.
const STATUS = {
  BackendState: 'Running',
  Self: {
    ID: 'n1',
    HostName: 'Nicholas-Omarchy',
    DNSName: 'nicholas-omarchy.tail0.ts.net.',
    OS: 'linux',
    UserID: 11,
    TailscaleIPs: ['100.101.226.105', 'fd7a:115c:a1e0::1'],
    Online: true,
  },
  Peer: {
    'nodekey:a': {
      HostName: 'Xiaomi 17',
      DNSName: 'xiaomi-17.tail0.ts.net.',
      OS: 'android',
      UserID: 11,
      TailscaleIPs: ['100.78.86.80'],
      Online: true,
    },
    'nodekey:b': {
      HostName: 'zep',
      DNSName: 'nicholas-zep.tail0.ts.net.',
      OS: 'windows',
      UserID: 12,
      TailscaleIPs: ['100.98.210.7'],
      Online: false,
    },
  },
  User: { '11': { LoginName: 'me@example.com' }, '12': { LoginName: 'tagged-devices' } },
}

test('status: this computer, its user, and the other devices', () => {
  const s = parseStatus(JSON.stringify(STATUS))
  expect(s.running).toBe(true)
  expect(s.self).toEqual({
    name: 'nicholas-omarchy',
    dnsName: 'nicholas-omarchy.tail0.ts.net',
    ips: ['100.101.226.105', 'fd7a:115c:a1e0::1'],
    os: 'linux',
    online: true,
    login: 'me@example.com',
  })
  expect(s.peers.map(p => [p.name, p.online, p.login])).toEqual([
    ['xiaomi-17', true, 'me@example.com'],
    ['nicholas-zep', false, 'tagged-devices'],
  ])
})

test('status: logged out', () => {
  const s = parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { TailscaleIPs: [] } }))
  expect(s.running).toBe(false)
  expect(s.peers).toEqual([])
})

test('whois: the calling device and its user', () => {
  const whois = {
    Node: {
      ID: 6502897243772082,
      StableID: 'nPhnJr5Bns11CNTRL',
      Name: 'xiaomi-17.tail0.ts.net.',
      ComputedName: 'xiaomi-17',
      Hostinfo: { Hostname: 'Xiaomi 17', OS: 'android' },
    },
    UserProfile: { LoginName: 'me@example.com', DisplayName: 'Me' },
  }
  expect(parseWhois(JSON.stringify(whois))).toEqual({
    login: 'me@example.com',
    node: 'nPhnJr5Bns11CNTRL',
    device: 'xiaomi-17',
    os: 'android',
  })
  expect(parseWhois('{}')).toBeNull()
  expect(parseWhois(JSON.stringify({ ...whois, UserProfile: {} }))).toBeNull()
})
