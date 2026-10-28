// The hub's admin socket and its CLI (#231): invites made, listed and revoked, a peer revoked and
// shut out at once, the socket at mode 0600. A unix socket: skipped on Windows.
import { afterEach, beforeEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Admin, socketPath, startAdmin } from '../../hub/src/admin.ts'
import { parseTtl, run } from '../../hub/src/cli.ts'
import { DEFAULT_LISTEN, isPrivateHost, parseListen } from '../../hub/src/listen.ts'
import { authBytes, type KeyPair, sign } from '../../src/core/team.ts'
import { type Harness, keys, startHarness } from './harness.ts'

const d = process.platform === 'win32' ? describe.skip : describe

d('admin socket', () => {
  let h: Harness
  let dir: string
  let admin: Admin
  let A: KeyPair
  let B: KeyPair
  beforeEach(async () => {
    h = await startHarness()
    dir = mkdtempSync(join(tmpdir(), 'hub-admin-'))
    admin = startAdmin({ dir, db: h.db, hub: h.hub, clock: h.clock })
    ;[A, B] = (await keys(2)) as [KeyPair, KeyPair]
  })
  afterEach(() => {
    admin.stop()
    h.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`http://hub${path}`, {
      method,
      unix: socketPath(dir),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })

  test('the socket is mode 0600', () => {
    assert.equal(statSync(socketPath(dir)).mode & 0o777, 0o600)
  })

  test('invite create, list, revoke; the code works once at the door', async () => {
    const made = await api('POST', '/invites', { ttl_s: 3600, note: 'for anna' })
    assert.equal(made.status, 201)
    const inv = (await made.json()) as { code: string; id: string; expires_at: number }
    assert.match(inv.code, /^hab-/)
    assert.equal(inv.expires_at, h.clock.now() + 3_600_000)
    const list = (await (await api('GET', '/invites')).json()) as Array<{ id: string; state: string; note: string }>
    assert.deepEqual(
      list.map(i => [i.id, i.state, i.note]),
      [[inv.id, 'open', 'for anna']],
    )
    assert.ok(!JSON.stringify(list).includes(inv.code))

    const a = await h.join(A, 'anna', inv.code)
    assert.ok(a)
    assert.equal(((await (await api('GET', '/invites')).json()) as Array<{ state: string }>)[0]?.state, 'used')

    const second = (await (await api('POST', '/invites', {})).json()) as { id: string; expires_at: number }
    assert.equal(second.expires_at, h.clock.now() + 24 * 3600 * 1000)
    assert.equal((await api('POST', `/invites/${second.id}/revoke`)).status, 200)
    assert.equal((await api('POST', `/invites/${second.id}/revoke`)).status, 404)
    assert.equal((await api('POST', `/invites/${inv.id}/revoke`)).status, 404)
    assert.deepEqual(
      h.db
        .auditRows()
        .map(r => r.action)
        .filter(x => x.startsWith('invite')),
      ['invite_create', 'invite_create', 'invite_revoke'],
    )
  })

  test('bad invite requests are 400; unknown routes 404', async () => {
    for (const body of [{ ttl_s: 0 }, { ttl_s: 'x' }, { ttl_s: 1.5 }, { ttl_s: 99_999_999 }, { note: 5 }])
      assert.equal((await api('POST', '/invites', body)).status, 400)
    assert.equal((await api('GET', '/nope')).status, 404)
    assert.equal((await api('DELETE', '/invites')).status, 404)
  })

  test('peers lists who is online; revoke by name closes the socket at once', async () => {
    const a = await h.join(A, 'anna')
    const b = await h.join(B, 'ben')
    await a.settle()
    const peers = (await (await api('GET', '/peers')).json()) as Array<{
      name: string
      online: boolean
      status: string
    }>
    assert.deepEqual(peers.map(p => [p.name, p.online, p.status]).sort(), [
      ['anna', true, 'active'],
      ['ben', true, 'active'],
    ])
    const t0 = Date.now()
    const r = await api('POST', '/peers/ben/revoke')
    assert.equal(r.status, 200)
    assert.equal((await b.closed).code, 4403)
    assert.ok(Date.now() - t0 < 1000)
    assert.equal((await api('POST', `/peers/${B.pub}/revoke`)).status, 404)
    assert.equal((await api('POST', '/peers/nobody/revoke')).status, 404)
    const { c, nonce } = await h.hello(B)
    c.send({ t: 'auth', sig: await sign(B.pkcs8, authBytes({ hub: h.hubId, nonce, peer: B.pub })) })
    assert.equal((await c.closed).code, 4403)
  })

  test('the CLI talks to it: create, list, peers, revoke, and usage errors', async () => {
    const lines: string[] = []
    const errs: string[] = []
    const out = { log: (s: string) => void lines.push(s), error: (s: string) => void errs.push(s) }
    const cli = (...a: string[]) => run(['--dir', dir, ...a], out)
    assert.equal(await cli('invite', 'create', '--ttl', '2h', '--note', 'ben'), 0)
    const code = /invite\s+(hab-\S+)/.exec(lines.join('\n'))?.[1] ?? ''
    assert.ok(code)
    assert.ok(lines.some(l => l.startsWith('id ')))
    lines.length = 0
    assert.equal(await cli('invite', 'list'), 0)
    assert.match(lines[0] ?? '', /open .*ben$/)
    await h.join(B, 'ben', code)
    lines.length = 0
    assert.equal(await cli('peers'), 0)
    assert.match(lines[0] ?? '', /^● ben /)
    lines.length = 0
    assert.equal(await cli('revoke', 'ben'), 0)
    assert.match(lines[0] ?? '', /^ben \(.*\) revoked/)
    assert.equal(await cli('revoke', 'ben'), 1)
    assert.equal(await cli('invite', 'revoke', 'ffffffff'), 1)
    for (const bad of [
      [],
      ['nope'],
      ['invite'],
      ['invite', 'create', '--ttl', 'soon'],
      ['revoke'],
      ['peers', 'x'],
      ['--dir'],
    ]) {
      errs.length = 0
      assert.equal(await run(bad[0] === '--dir' ? bad : ['--dir', dir, ...bad], out), 2, bad.join(' '))
      assert.ok(errs.length > 0)
    }
  })

  test('with no hub behind the socket, the CLI says so', async () => {
    const errs: string[] = []
    const code = await run(['--dir', join(dir, 'nowhere'), 'peers'], { log: () => {}, error: s => void errs.push(s) })
    assert.equal(code, 1)
    assert.match(errs[0] ?? '', /cannot reach the hub/)
  })
})

test('parseTtl: seconds, minutes, hours, days', () => {
  assert.equal(parseTtl('90s'), 90)
  assert.equal(parseTtl('15m'), 900)
  assert.equal(parseTtl('24h'), 86400)
  assert.equal(parseTtl('7d'), 604800)
  for (const bad of ['', '0s', '5', 'h', '1.5h', '-1h', '2w']) assert.equal(parseTtl(bad), null, bad)
})

test('listen: loopback and Tailscale are private, the rest needs --allow-public', () => {
  assert.deepEqual(parseListen(DEFAULT_LISTEN), { hostname: '127.0.0.1', port: 7443 })
  assert.deepEqual(parseListen('[::1]:80'), { hostname: '::1', port: 80 })
  for (const bad of ['', 'host', ':80', 'h:99999', 'h:x', 'a b:1']) assert.equal(parseListen(bad), null, bad)
  for (const ok of [
    '127.0.0.1',
    '127.9.9.9',
    '::1',
    'localhost',
    '100.64.0.1',
    '100.127.255.255',
    'fd7a:115c:a1e0::1',
    'fd7a:115c:a1e0:ab12::7',
  ])
    assert.equal(isPrivateHost(ok), true, ok)
  for (const no of [
    '0.0.0.0',
    '::',
    '192.168.1.5',
    '10.0.0.1',
    '100.63.0.1',
    '100.128.0.1',
    '8.8.8.8',
    'example.com',
    'fd7a:115c:a1e1::1',
  ])
    assert.equal(isPrivateHost(no), false, no)
})
