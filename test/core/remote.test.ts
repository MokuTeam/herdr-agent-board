import { expect, test } from 'bun:test'
import { allowedLogin, bearerOf, desktopOnly, remoteConfig } from '../../src/core/remote.ts'

test('remote is off unless config.json turns it on', () => {
  expect(remoteConfig(undefined)).toEqual({ on: false, port: null, allow: [] })
  expect(remoteConfig(false)).toEqual({ on: false, port: null, allow: [] })
  expect(remoteConfig('yes')).toEqual({ on: false, port: null, allow: [] })
  expect(remoteConfig({ on: 'true' })).toEqual({ on: false, port: null, allow: [] })
  expect(remoteConfig(true)).toEqual({ on: true, port: null, allow: [] })
  expect(remoteConfig({ on: true, port: 12500, allow: [' Anna@Example.com ', 'anna@example.com', '', 3] })).toEqual({
    on: true,
    port: 12500,
    allow: ['anna@example.com'],
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

test('the token comes as Authorization: Bearer', () => {
  const token = 'a'.repeat(43)
  expect(bearerOf(`Bearer ${token}`)).toBe(token)
  expect(bearerOf(`bearer  ${token} `)).toBe(token)
  expect(bearerOf(token)).toBeNull()
  expect(bearerOf('Bearer short')).toBeNull()
  expect(bearerOf(null)).toBeNull()
})
