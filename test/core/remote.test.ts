import { expect, test } from 'bun:test'
import {
  allowedLogin,
  bearerOf,
  deskSteps,
  desktopOnly,
  localOnly,
  remoteConfig,
  STATUS_RETRY_MS,
  statusVerdict,
} from '../../src/core/remote.ts'

const PWA_OFF = { on: false, https: 443, port: null }

test('remote is off unless config.json turns it on', () => {
  expect(remoteConfig(undefined)).toEqual({ on: false, port: null, allow: [], pwa: PWA_OFF })
  expect(remoteConfig(false)).toEqual({ on: false, port: null, allow: [], pwa: PWA_OFF })
  expect(remoteConfig('yes')).toEqual({ on: false, port: null, allow: [], pwa: PWA_OFF })
  expect(remoteConfig({ on: 'true' })).toEqual({ on: false, port: null, allow: [], pwa: PWA_OFF })
  expect(remoteConfig(true)).toEqual({ on: true, port: null, allow: [], pwa: PWA_OFF })
  expect(remoteConfig({ on: true, port: 12500, allow: [' Anna@Example.com ', 'anna@example.com', '', 3] })).toEqual({
    on: true,
    port: 12500,
    allow: ['anna@example.com'],
    pwa: PWA_OFF,
  })
  expect(remoteConfig({ on: true, port: 70000 }).port).toBeNull()
  expect(remoteConfig({ on: true, port: 1.5 }).port).toBeNull()
})

test("who may call: the computer's own Tailscale user, or one config.json allows", () => {
  expect(allowedLogin('me@x.com', 'me@x.com', [])).toBe(true)
  expect(allowedLogin('Me@X.com', 'me@x.com', [])).toBe(true)
  expect(allowedLogin('other@x.com', 'me@x.com', [])).toBe(false)
  expect(allowedLogin('other@x.com', 'me@x.com', ['other@x.com'])).toBe(true)
  // A computer shared with tags has no user: only the list counts.
  expect(allowedLogin('me@x.com', null, [])).toBe(false)
  expect(allowedLogin(null, 'me@x.com', [])).toBe(false)
})

test("what acts on this computer's screen is not for a phone", () => {
  for (const path of [
    '/api/fs/open',
    '/api/open-url',
    '/api/reveal',
    '/api/session/s1/focus',
    `/api/session/${encodeURIComponent('/home/me/.pi/agent/sessions/a.jsonl')}/focus`,
    '/api/launch/abc-1/focus',
    '/api/term/s1/shell/focus',
  ])
    expect(desktopOnly(path)).toBe(true)
  for (const path of [
    '/api/board',
    '/api/events',
    '/api/session/s1',
    '/api/session/s1/message',
    '/api/session/s1/wake',
    '/api/fs/preview',
    '/api/fs/raw',
    '/api/term/s1/agent/input',
    '/api/launch',
  ])
    expect(desktopOnly(path)).toBe(false)
})

test("the remote mode's, Remote access's and wake's management are for the board on this computer only", () => {
  for (const path of ['/api/remote', '/api/remote/x', '/api/access', '/api/access/x', '/api/wake', '/api/wake/x'])
    expect(localOnly(path)).toBe(true)
  for (const path of ['/api/accessories', '/api/remotes', '/api/wakes', '/api/session/s1/wake', '/api/probe/x'])
    expect(localOnly(path)).toBe(false)
  expect(localOnly('/api/login/password')).toBe(false)
})

test('the token comes as Authorization: Bearer', () => {
  const token = 'a'.repeat(43)
  expect(bearerOf(`Bearer ${token}`)).toBe(token)
  expect(bearerOf(`bearer  ${token} `)).toBe(token)
  expect(bearerOf(token)).toBeNull()
  expect(bearerOf('Bearer short')).toBeNull()
  expect(bearerOf(null)).toBeNull()
})

test("the board in a phone's browser is off unless remote.pwa turns it on", () => {
  expect(remoteConfig({ on: true, pwa: true }).pwa).toEqual({ on: true, https: 443, port: null })
  expect(remoteConfig({ on: true, pwa: { on: true, https: 8443, port: 12600 } }).pwa).toEqual({
    on: true,
    https: 8443,
    port: 12600,
  })
  expect(remoteConfig({ on: true, pwa: { https: 8443 } }).pwa).toEqual({ on: false, https: 8443, port: null })
  expect(remoteConfig({ on: true, pwa: { on: true, https: 0, port: 'x' } }).pwa).toEqual({
    on: true,
    https: 443,
    port: null,
  })
  expect(remoteConfig({ on: true, pwa: 'yes' }).pwa).toEqual(PWA_OFF)
})

test('a look at Tailscale that failed keeps the listeners; only failures in a row take them down (#108)', () => {
  expect(statusVerdict(1)).toEqual({ down: false, retryMs: 5_000 })
  expect(statusVerdict(2)).toEqual({ down: false, retryMs: 15_000 })
  expect(statusVerdict(3)).toEqual({ down: false, retryMs: 30_000 })
  expect(statusVerdict(4)).toEqual({ down: true })
  expect(statusVerdict(0)).toEqual({ down: true })
  // About fifty seconds of no answer: longer than a relay switch (24 s in the log that found it).
  expect(STATUS_RETRY_MS.reduce((a, b) => a + b, 0)).toBe(50_000)
})

test('marking a desk says how to attach herdr from it: user, host, ssh config, herdr --remote', () => {
  const lines = deskSteps('claude', 'vps.tail1.ts.net').join('\n')
  expect(lines).toContain('~claude/.ssh/authorized_keys')
  expect(lines).toContain('ssh claude@vps.tail1.ts.net')
  expect(lines).toContain('HostName vps.tail1.ts.net  User claude')
  expect(lines).toContain('herdr --remote board')
  expect(deskSteps('claude', null).join('\n')).toContain('ssh claude@<this computer>')
})
