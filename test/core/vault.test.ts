// The owner's password vault's rules (core/vault.ts): config.json's `vault` in server mode only,
// which paths are the vault's and which of them never go through, what of a request's headers goes
// to Vaultwarden (never the board's login cookie) and what comes back, and Vaultwarden's
// environment file's SIGNUPS_ALLOWED read and set.
import { describe, expect, test } from 'bun:test'
import {
  cookieWithout,
  downstreamHeaders,
  envOn,
  envSetting,
  upstreamHeaders,
  vaultAdminPath,
  vaultConfig,
  vaultOwnerPath,
  vaultPath,
  vaultRegisterPath,
  vaultServerUrl,
  vaultSocketPath,
  withEnvSetting,
} from '../../src/core/vault.ts'

const HOME = '/home/owner'
const LOGIN = '__Host-board-login'

describe('vaultConfig', () => {
  test('off on a PC, without a port, or anything but an object', () => {
    for (const v of [undefined, null, true, 'x', [], {}, { port: 0 }, { port: 70000 }, { port: '8222' }])
      expect([v, vaultConfig(v, { home: HOME, serverMode: true })]).toEqual([v, null])
    expect(vaultConfig({ port: 8222 }, { home: HOME, serverMode: false })).toBeNull()
  })

  test('its defaults, and paths config.json gives (~ the home folder; relative ones are none)', () => {
    expect(vaultConfig({ port: 8222 }, { home: HOME, serverMode: true })).toEqual({
      port: 8222,
      data: `${HOME}/.local/share/vaultwarden`,
      env: `${HOME}/.config/vaultwarden/vaultwarden.env`,
      unit: 'vaultwarden.service',
      bw: `${HOME}/.local/opt/bitwarden-cli/bw`,
      cert: `${HOME}/.config/vaultwarden/tls/cert.pem`,
    })
    const c = vaultConfig(
      { port: 9000, data: '~/vw data', env: '/etc/x.env', unit: 'vw.service', bw: 'bw' },
      { home: HOME, serverMode: true },
    )
    expect(c).toMatchObject({ data: `${HOME}/vw data`, env: '/etc/x.env', unit: 'vw.service' })
    expect(c?.bw).toBe(`${HOME}/.local/opt/bitwarden-cli/bw`)
    expect(vaultConfig({ port: 9000, unit: 'x; rm -rf' }, { home: HOME, serverMode: true })?.unit).toBe(
      'vaultwarden.service',
    )
    expect(vaultServerUrl({ port: 8222 })).toBe('https://127.0.0.1:8222/vault')
  })
})

describe('the vault’s paths', () => {
  test('/vault and under it only; the owner’s answers under /api/vault', () => {
    for (const p of ['/vault', '/vault/', '/vault/api/sync', '/vault/notifications/hub'])
      expect([p, vaultPath(p), vaultOwnerPath(p)]).toEqual([p, true, true])
    for (const p of ['/vaultx', '/vault%2F', '/api/vaults', '/', '/api/secrets'])
      expect([p, vaultPath(p), vaultOwnerPath(p)]).toEqual([p, false, false])
    for (const p of ['/api/vault', '/api/vault/lock', '/api/vault/fill/0123456789ab'])
      expect([p, vaultPath(p), vaultOwnerPath(p)]).toEqual([p, false, true])
  })

  test('the admin page, a new account’s calls, the notifications’ sockets', () => {
    expect(['/vault/admin', '/vault/admin/', '/vault/ADMIN/users'].map(vaultAdminPath)).toEqual([true, true, true])
    expect(vaultAdminPath('/vault/administrator')).toBe(false)
    for (const p of [
      '/vault/identity/accounts/register',
      '/vault/identity/accounts/register/send-verification-email',
      '/vault/identity/accounts/register/finish',
      '/vault/api/accounts/register',
    ])
      expect([p, vaultRegisterPath(p)]).toEqual([p, true])
    expect(vaultRegisterPath('/vault/identity/connect/token')).toBe(false)
    expect(['/vault/notifications/hub', '/vault/notifications/anonymous-hub'].map(vaultSocketPath)).toEqual([
      true,
      true,
    ])
    expect(vaultSocketPath('/vault/notifications/hub/negotiate')).toBe(false)
  })
})

describe('headers through the proxy', () => {
  test('to Vaultwarden: the caller’s own, never the board’s login, the domain and the caller’s address', () => {
    const given = new Headers({
      cookie: `${LOGIN}=${'a'.repeat(43)}; other=1`,
      authorization: 'Bearer vault-token',
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.1, 203.0.113.9',
      host: 'evil.example',
      connection: 'keep-alive',
      'accept-encoding': 'gzip',
      'transfer-encoding': 'chunked',
    })
    const out = upstreamHeaders(given, { domain: 'board.example.com', address: '203.0.113.9', cookie: LOGIN })
    expect(out.get('cookie')).toBe('other=1')
    expect(out.get('authorization')).toBe('Bearer vault-token')
    expect(out.get('host')).toBe('board.example.com')
    expect(out.get('x-real-ip')).toBe('203.0.113.9')
    expect(out.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(out.get('x-forwarded-proto')).toBe('https')
    expect(out.get('accept-encoding')).toBe('identity')
    expect(out.get('connection')).toBeNull()
    expect(out.get('transfer-encoding')).toBeNull()
    const only = upstreamHeaders(new Headers({ cookie: `${LOGIN}=x` }), { domain: 'd', address: '', cookie: LOGIN })
    expect(only.get('cookie')).toBeNull()
    expect(only.get('x-real-ip')).toBeNull()
    expect(cookieWithout(` a=1 ;${LOGIN}=2; b=3`, LOGIN)).toBe('a=1; b=3')
  })

  test('back: Vaultwarden’s own, not HSTS (the domain’s to say), a cookie of the board’s login’s name never', () => {
    const given = new Headers({
      'content-type': 'text/html',
      connection: 'close',
      'content-length': '5',
      'strict-transport-security': 'max-age=31536000',
    })
    given.append('set-cookie', `${LOGIN}=forged; Path=/`)
    given.append('set-cookie', 'VW_SSO=1; Path=/vault')
    const out = downstreamHeaders(given, LOGIN)
    expect(out.get('content-type')).toBe('text/html')
    expect(out.get('content-length')).toBe('5')
    expect(out.get('connection')).toBeNull()
    expect(out.get('strict-transport-security')).toBeNull()
    expect(out.getSetCookie()).toEqual(['VW_SSO=1; Path=/vault'])
  })
})

describe('Vaultwarden’s environment file', () => {
  const ENV = 'DOMAIN=https://board.example.com/vault\nSIGNUPS_ALLOWED=true\n# a note\nROCKET_PORT=8222\n'

  test('a setting read, the last one counting, quotes taken off', () => {
    expect(envSetting(ENV, 'SIGNUPS_ALLOWED')).toBe('true')
    expect(envSetting(`${ENV}SIGNUPS_ALLOWED="false"\n`, 'SIGNUPS_ALLOWED')).toBe('false')
    expect(envSetting(ENV, 'ADMIN_TOKEN')).toBeNull()
    expect([envOn('true'), envOn('1'), envOn('false'), envOn(null)]).toEqual([true, true, false, false])
  })

  test('set where it is, a second one commented out, added when missing; the rest as it was', () => {
    expect(withEnvSetting(ENV, 'SIGNUPS_ALLOWED', 'false')).toBe(
      'DOMAIN=https://board.example.com/vault\nSIGNUPS_ALLOWED=false\n# a note\nROCKET_PORT=8222\n',
    )
    expect(withEnvSetting('A=1\nSIGNUPS_ALLOWED=true\nSIGNUPS_ALLOWED=true', 'SIGNUPS_ALLOWED', 'false')).toBe(
      'A=1\nSIGNUPS_ALLOWED=false\n# SIGNUPS_ALLOWED=true',
    )
    expect(withEnvSetting('A=1\n', 'SIGNUPS_ALLOWED', 'false')).toBe('A=1\nSIGNUPS_ALLOWED=false\n')
  })
})
