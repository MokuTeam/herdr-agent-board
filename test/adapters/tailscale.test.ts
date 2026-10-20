import { expect, test } from 'bun:test'
import { parseServe, parseStatus, parseWhois, tailscaleBin } from '../../src/adapters/tailscale.ts'

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

test('status: the names this computer can have an HTTPS certificate for; none while the tailnet has them off', () => {
  expect(parseStatus(JSON.stringify(STATUS)).certDomains).toEqual([])
  expect(parseStatus(JSON.stringify({ ...STATUS, CertDomains: null })).certDomains).toEqual([])
  const on = parseStatus(JSON.stringify({ ...STATUS, CertDomains: ['nicholas-omarchy.tail0.ts.net'] }))
  expect(on.certDomains).toEqual(['nicholas-omarchy.tail0.ts.net'])
})

test('serve status: each port, what it is, and where it forwards /', () => {
  // As Tailscale 1.104's `serve status --json` prints it: empty, and with three ports in use.
  expect(parseServe('{}').size).toBe(0)
  expect(parseServe('').size).toBe(0)
  const ports = parseServe(
    JSON.stringify({
      TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '22': { TCPForward: '127.0.0.1:22' } },
      Web: {
        'box.tail0.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:12423' } } },
        'box.tail0.ts.net:8443': { Handlers: { '/files': { Path: '/srv' } } },
      },
    }),
  )
  expect(ports.get(443)).toEqual({ kind: 'https', proxy: 'http://127.0.0.1:12423' })
  expect(ports.get(8443)).toEqual({ kind: 'https', proxy: null })
  expect(ports.get(22)).toEqual({ kind: 'tcp', proxy: null })
})

test('the CLI: TAILSCALE_BIN_PATH, else tailscale from PATH as before, else where the installer puts it', () => {
  const nowhere = () => false
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe'
  const mac = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  // PATH first, on every platform: what every setup with Tailscale on its PATH ran before.
  for (const platform of ['win32', 'darwin', 'linux'])
    expect(tailscaleBin({ env: {}, platform, onPath: () => true, exists: () => true })).toBe('tailscale')
  expect(tailscaleBin({ env: { TAILSCALE_BIN_PATH: '/x/fake' }, platform: 'win32', onPath: () => true })).toBe(
    '/x/fake',
  )
  // Installed while herdr ran: not on this process's PATH, but where the installer put it.
  const at = (path: string) => (p: string) => p === path
  expect(
    tailscaleBin({ env: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', onPath: nowhere, exists: at(win) }),
  ).toBe(win)
  expect(tailscaleBin({ env: {}, platform: 'win32', onPath: nowhere, exists: at(win) })).toBe(win)
  const d = 'D:\\Apps\\Tailscale\\tailscale.exe'
  expect(tailscaleBin({ env: { ProgramFiles: 'D:\\Apps' }, platform: 'win32', onPath: nowhere, exists: at(d) })).toBe(d)
  expect(tailscaleBin({ env: {}, platform: 'darwin', onPath: nowhere, exists: at(mac) })).toBe(mac)
  // Nowhere: the name, so the error says what it always said.
  expect(tailscaleBin({ env: {}, platform: 'linux', onPath: nowhere, exists: () => true })).toBe('tailscale')
  expect(tailscaleBin({ env: {}, platform: 'win32', onPath: nowhere, exists: nowhere })).toBe('tailscale')
})
