import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import type { Caller } from '../../src/adapters/tailscale.ts'
import { PAIR_MAX, PAIR_TTL_MS } from '../../src/core/remote.ts'
import { createRemote, devicesFile, hashToken } from '../../src/services/remote.ts'
import { isolatedHome } from '../support/env.ts'

const phone: Caller = { login: 'me@example.com', node: 'nPhone', device: 'xiaomi-17', os: 'android' }
const tablet: Caller = { login: 'me@example.com', node: 'nTablet', device: 'tab', os: 'android' }

function setup() {
  isolatedHome()
  let clock = 1_000_000
  let changes = 0
  const remote = createRemote({ onChange: () => changes++, now: () => clock })
  return { remote, tick: (ms: number) => (clock += ms), changes: () => changes }
}

test('a phone asks, the user approves, the phone gets its token once', () => {
  const { remote, changes } = setup()
  const r = remote.request('My phone', phone)
  if (!r.ok) throw new Error('refused')
  expect(remote.pending().map(p => [p.name, p.device, p.login])).toEqual([['My phone', 'xiaomi-17', 'me@example.com']])
  expect(remote.poll(r.id, phone)).toEqual({ status: 'pending' })
  // Asking again while it waits is the same request.
  expect(remote.request('My phone', phone)).toEqual({ ok: true, id: r.id })
  // Another device cannot read how it stands.
  expect(remote.poll(r.id, tablet)).toEqual({ status: 'gone' })
  expect(remote.approve(r.id)).toBe(true)
  const answer = remote.poll(r.id, phone)
  if (answer.status !== 'approved') throw new Error(answer.status)
  expect(answer.token).toMatch(/^[\w-]{43}$/)
  expect(remote.poll(r.id, phone)).toEqual({ status: 'gone' })
  expect(remote.pending()).toEqual([])
  expect(changes()).toBe(2)
  // Only the hash is kept, in a file only this user reads.
  const saved = readFileSync(devicesFile(), 'utf8')
  expect(saved).not.toContain(answer.token)
  expect(saved).toContain(hashToken(answer.token))
  if (process.platform !== 'win32') expect(statSync(devicesFile()).mode & 0o777).toBe(0o600)
  // The token works from that device only.
  expect(remote.verify(answer.token, phone)?.device).toBe('xiaomi-17')
  expect(remote.verify(answer.token, tablet)).toBeNull()
  expect(remote.verify('x'.repeat(43), phone)).toBeNull()
})

test('denied, expired, and too many at once', () => {
  const { remote, tick } = setup()
  const a = remote.request('A', phone)
  if (!a.ok) throw new Error('refused')
  expect(remote.deny(a.id)).toBe(true)
  expect(remote.approve(a.id)).toBe(false)
  expect(remote.poll(a.id, phone)).toEqual({ status: 'denied' })
  const b = remote.request('B', phone)
  if (!b.ok) throw new Error('refused')
  tick(PAIR_TTL_MS + 1)
  expect(remote.pending()).toEqual([])
  expect(remote.approve(b.id)).toBe(false)
  for (let i = 0; i < PAIR_MAX; i++) expect(remote.request('x', { ...phone, node: `n${i}` }).ok).toBe(true)
  expect(remote.request('x', { ...phone, node: 'one-more' })).toEqual({ ok: false, status: 429, error: 'busy' })
  expect(remote.request('  ', { ...phone, node: 'nameless' })).toEqual({ ok: false, status: 400, error: 'name' })
})

test('pairing a device again replaces its old token; revoking ends it', () => {
  const { remote } = setup()
  const pair = (): string => {
    const r = remote.request('Phone', phone)
    if (!r.ok) throw new Error('refused')
    remote.approve(r.id)
    const answer = remote.poll(r.id, phone)
    if (answer.status !== 'approved') throw new Error(answer.status)
    return answer.token
  }
  const first = pair()
  const second = pair()
  expect(remote.devices()).toHaveLength(1)
  expect(remote.verify(first, phone)).toBeNull()
  const device = remote.verify(second, phone)
  expect(device).not.toBeNull()
  expect(remote.revoke(device?.id ?? '')).toBe(true)
  expect(remote.verify(second, phone)).toBeNull()
  expect(remote.revoke('nope')).toBe(false)
})

test('the app and the browser on one phone are paired each on its own; unpairing tells who watches', () => {
  const { remote } = setup()
  const pair = (kind?: 'browser'): string => {
    const r = remote.request(kind ? 'Board in Chrome' : 'App', phone, kind)
    if (!r.ok) throw new Error('refused')
    remote.approve(r.id)
    const answer = remote.poll(r.id, phone)
    if (answer.status !== 'approved') throw new Error(answer.status)
    return answer.token
  }
  // Waiting requests of both kinds at once are two requests.
  const app = remote.request('App', phone)
  const browser = remote.request('Board in Chrome', phone, 'browser')
  expect(app.ok && browser.ok && app.id !== browser.id).toBe(true)
  expect(remote.pending().map(r => r.kind ?? 'app')).toEqual(['app', 'browser'])

  const appToken = pair()
  const browserToken = pair('browser')
  expect(remote.devices().map(d => d.kind ?? 'app')).toEqual(['app', 'browser'])
  const appDevice = remote.verify(appToken, phone)
  const browserDevice = remote.verify(browserToken, phone)
  expect(appDevice && browserDevice && appDevice.id !== browserDevice.id).toBe(true)

  const gone: string[] = []
  remote.watch(browserDevice?.id ?? '', () => gone.push('browser'))
  remote.watch(appDevice?.id ?? '', () => gone.push('app'))
  const unwatched = remote.watch(appDevice?.id ?? '', () => gone.push('never'))
  unwatched()
  // Pairing the browser again ends the old browser token only.
  const again = pair('browser')
  expect(gone).toEqual(['browser'])
  expect(remote.verify(browserToken, phone)).toBeNull()
  expect(remote.verify(again, phone)).not.toBeNull()
  expect(remote.verify(appToken, phone)).not.toBeNull()
  expect(remote.revoke(appDevice?.id ?? '')).toBe(true)
  expect(gone).toEqual(['browser', 'app'])
})
