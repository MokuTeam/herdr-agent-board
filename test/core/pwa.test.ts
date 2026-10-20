import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  clearCookie,
  cookieToken,
  forwardedFor,
  phoneChecks,
  pwaHosts,
  pwaPage,
  pwaPort,
  pwaUrl,
  serveUse,
  tokenCookie,
} from '../../src/core/pwa.ts'

const t = translator('en')
const TOKEN = 'a'.repeat(43)

test("the HTTPS address: the computer's Tailscale name, with the port unless 443", () => {
  expect(pwaUrl('box.tail0.ts.net', 443)).toBe('https://box.tail0.ts.net')
  expect(pwaUrl('box.tail0.ts.net', 8443)).toBe('https://box.tail0.ts.net:8443')
  expect([...pwaHosts('Box.tail0.ts.net', 443)]).toEqual(['box.tail0.ts.net', 'box.tail0.ts.net:443'])
  expect([...pwaHosts('box.tail0.ts.net', 8443)]).toEqual(['box.tail0.ts.net:8443'])
  expect(pwaPort({ on: true, https: 443, port: null }, 12422)).toBe(12423)
  expect(pwaPort({ on: true, https: 443, port: 12600 }, 12422)).toBe(12600)
})

test("the caller's address as serve gives it: one address, else nothing", () => {
  expect(forwardedFor('100.78.86.80')).toBe('100.78.86.80')
  expect(forwardedFor(' ::ffff:100.78.86.80 ')).toBe('100.78.86.80')
  expect(forwardedFor('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
  // Serve sets it, over anything the caller sent: a list or a name is not serve's.
  expect(forwardedFor('100.78.86.80, 1.2.3.4')).toBeNull()
  expect(forwardedFor('box.tail0.ts.net')).toBeNull()
  expect(forwardedFor(null)).toBeNull()
})

test('the token rides in a cookie the page cannot read, sent to this name over HTTPS only', () => {
  expect(cookieToken(`theme=dark; __Host-board=${TOKEN}; x=1`)).toBe(TOKEN)
  expect(cookieToken('__Host-board=short')).toBeNull()
  expect(cookieToken(`board=${TOKEN}`)).toBeNull()
  expect(cookieToken(null)).toBeNull()
  const set = tokenCookie(TOKEN)
  expect(set.startsWith(`__Host-board=${TOKEN};`)).toBe(true)
  for (const part of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) expect(set).toContain(part)
  expect(set).not.toContain('Domain')
  expect(clearCookie()).toContain('Max-Age=0')
})

test("the page for a phone's browser is marked and installable; the board's own stays as it is", () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
  const page = pwaPage(html, 'a1b2c3d4e5f6')
  expect(page).toContain('<html data-remote lang="en">')
  expect(page).toContain('<link rel="manifest" href="manifest.webmanifest">')
  expect(page.indexOf('styles/pwa.css')).toBeGreaterThan(page.indexOf('styles/profiles.css'))
  // The script by its build (#116): the service worker keeps each apart, and the page says which ran.
  expect(page).toContain('<script type="module" src="app.js?v=a1b2c3d4e5f6"></script>')
  // Only what was added: take it out again and the page is the board's own, marked.
  const added = /\n\s*<(link|meta) [^>]*(manifest|theme-color|apple-|mobile-web-app|pwa\.css)[^>]*>/g
  expect(page.replace(added, '').replace('?v=a1b2c3d4e5f6', '')).toBe(html.replace('<html ', '<html data-remote '))
  expect(html).not.toContain('manifest')
  expect(html).not.toContain('data-remote')
  expect(html).toContain('<script type="module" src="app.js"></script>')
})

test("serve's port: forwarded to the board, free, or someone else's", () => {
  const target = 'http://127.0.0.1:12423'
  expect(serveUse(undefined, target)).toBe('free')
  expect(serveUse({ proxy: target }, target)).toBe('ours')
  expect(serveUse({ proxy: 'http://127.0.0.1:3000' }, target)).toBe('other')
  expect(serveUse({ proxy: null }, target)).toBe('other')
})

test('board doctor: Tailscale, the HTTPS certificates, and the address', () => {
  const on = { on: true, https: 443, port: null }
  const off = { ...on, on: false }
  const ok = { ok: true as const, dnsName: 'box.tail0.ts.net' }
  const levels = (checks: { id: string; level: string }[]) => checks.map(c => `${c.id}:${c.level}`)
  const down = phoneChecks({ tailscale: { ok: false, why: 'x' }, certs: false, conf: on, serve: null, url: null }, t)
  expect(levels(down)).toEqual(['remote-tailscale:error'])
  const noCerts = phoneChecks({ tailscale: ok, certs: false, conf: off, serve: null, url: null }, t)
  expect(levels(noCerts)).toEqual(['remote-tailscale:ok', 'remote-certs:off', 'remote-pwa:off'])
  expect(noCerts[1]?.title).toBe('HTTPS certificates are off for the tailnet')
  expect(noCerts[1]?.fix).toContain('DNS page')
  expect(noCerts[1]?.code).toBe('https://login.tailscale.com/admin/dns')
  expect(levels(phoneChecks({ tailscale: ok, certs: false, conf: on, serve: 'free', url: null }, t))).toEqual([
    'remote-tailscale:ok',
    'remote-certs:error',
    'remote-pwa:warn',
  ])
  const url = 'https://box.tail0.ts.net'
  const served = phoneChecks({ tailscale: ok, certs: true, conf: on, serve: 'ours', url }, t)
  expect(levels(served)).toEqual(['remote-tailscale:ok', 'remote-certs:ok', 'remote-pwa:ok'])
  expect(served[2]?.detail).toBe(url)
  expect(phoneChecks({ tailscale: ok, certs: true, conf: on, serve: 'other', url }, t)[2]?.title).toContain('Port 443')
})
