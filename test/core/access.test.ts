import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  clearLoginCookie,
  deviceLabel,
  forwardedAddress,
  LOGIN_MS,
  lockWaitMs,
  loginCookie,
  loginToken,
  passwordProblem,
  RATES,
  RateLimiter,
} from '../../src/core/access.ts'
import { useLanguage } from '../../src/core/lang.ts'

const TOKEN = 'A1b2-_'.repeat(8).slice(0, 43)

test("the login's cookie: its own name, over HTTPS only, never to the page's scripts or another site", () => {
  expect(TOKEN).toHaveLength(43)
  expect(loginCookie(TOKEN, LOGIN_MS / 1000)).toBe(
    `__Host-board-login=${TOKEN}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict`,
  )
  // what is left of the 30 days, in whole seconds: a browser ignores a Max-Age with a fraction
  expect(loginCookie(TOKEN, 59.9)).toContain('; Max-Age=59;')
  expect(clearLoginCookie()).toBe('__Host-board-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict')
})

test("the login's token is read from its own cookie only, and only a 43-character one", () => {
  expect(loginToken(`a=1; __Host-board-login=${TOKEN}; __Host-board=x`)).toBe(TOKEN)
  expect(loginToken(`__Host-board-login=${TOKEN.slice(1)}`)).toBeNull()
  expect(loginToken(`__Host-board=${TOKEN}`)).toBeNull()
  expect(loginToken(null)).toBeNull()
})

test('a password has at least 12 characters, no other rule', () => {
  useLanguage('en')
  expect(passwordProblem('x'.repeat(11))).toBe('A password has at least 12 characters')
  expect(passwordProblem('x'.repeat(12))).toBeNull()
  expect(passwordProblem(42)).toBe('A password has at least 12 characters')
})

test('the lockout: from the 5th failure in a row, 1 minute doubling to 1 hour', () => {
  expect([0, 4, 5, 6, 7, 10, 11, 20].map(lockWaitMs)).toEqual([0, 0, 60000, 120000, 240000, 1920000, 3600000, 3600000])
})

test('the rate limits per address and overall, per minute', () => {
  expect(RATES).toEqual({
    password: { perAddress: 10, overall: 30, windowMs: 60_000 },
    passkey: { perAddress: 20, overall: 60, windowMs: 60_000 },
    open: { perAddress: 120, overall: 600, windowMs: 60_000 },
  })
})

test('a rate limiter refuses without recording, and says when to come back', () => {
  const limit = new RateLimiter({ perAddress: 2, overall: 3, windowMs: 60000 })
  expect(limit.take('a', 0)).toEqual({ ok: true })
  expect(limit.take('a', 1)).toEqual({ ok: true })
  expect(limit.take('a', 2)).toEqual({ ok: false, retryAfterS: 60 })
  expect(limit.take('b', 3)).toEqual({ ok: true })
  expect(limit.take('c', 4)).toEqual({ ok: false, retryAfterS: 60 })
  expect(limit.take('a', 60001)).toEqual({ ok: true })
})

test("a device's label from its User-Agent, not translated", () => {
  const labels: [string | null, string][] = [
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Safari on iPad',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari on Mac',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    ['', 'A browser'],
    [null, 'A browser'],
    ['curl/8.0', 'A browser'],
  ]
  for (const [ua, label] of labels) expect(deviceLabel(ua)).toBe(label)
})

test("the caller's address: X-Forwarded-For's rightmost entry, an address only", () => {
  expect(forwardedAddress('203.0.113.9')).toBe('203.0.113.9')
  expect(forwardedAddress('198.51.100.1, 203.0.113.9')).toBe('203.0.113.9')
  expect(forwardedAddress('::ffff:203.0.113.9')).toBe('203.0.113.9')
  expect(forwardedAddress('2001:db8::5')).toBe('2001:db8::5')
  for (const none of ['', null, 'evil']) expect(forwardedAddress(none)).toBe('')
})

test('the page can import it: no node: import', () => {
  expect(readFileSync('src/core/access.ts', 'utf8')).not.toMatch(/from 'node:/)
})
