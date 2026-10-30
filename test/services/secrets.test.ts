// A secret request's life (#273, services/secrets.ts, entrypoints/secret-cli.ts): asked, expired,
// cancelled, written once even with two submits at a time, a failed write that stays open, and the
// agent's command that waits for the owner.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCard, updateCard } from '../../src/adapters/cards.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { fingerprintOf, requestsOf, type SecretRequest } from '../../src/core/secrets.ts'
import type { Config } from '../../src/core/types.ts'
import { secretCmd } from '../../src/entrypoints/secret-cli.ts'
import {
  askSecret,
  auditFile,
  cancelSecret,
  declineSecret,
  expireIfDue,
  ownRequest,
  secretsOf,
  submitSecret,
} from '../../src/services/secrets.ts'
import { isolatedHome } from '../support/env.ts'

const me = { key: 's1', name: 'One' }
const VALUE = 'svc-Secret-Q9w8e7'

function setUp() {
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const cfg = {
    secrets: {
      sinks: {
        tok: {
          kind: 'file',
          path: join(home, 'token.json'),
          format: 'json',
          at: ['svc'],
          template: { token: '{{token}}' },
        },
      },
    },
  } as unknown as Config
  return { home, cfg }
}

const ask = (cfg: Config, now = Date.now(), expiresMs = 60_000) => {
  const r = askSecret(cfg, me, { title: 'Token', sink: 'tok', params: {}, fields: [], expiresMs }, now)
  assert.ok(r.ok, JSON.stringify(r))
  return r.request
}
const fingerprint = (cfg: Config, r: SecretRequest) => {
  const sink = secretsOf(cfg).sinks.get(r.sink)
  assert.ok(sink)
  return fingerprintOf(sink, r.params, r.fields)
}
const audit = () =>
  existsSync(auditFile())
    ? readFileSync(auditFile(), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as { op: string; who: string })
    : []

test('a request names a sink of config.json, says what it is for, and fits the sink', () => {
  const { cfg } = setUp()
  assert.deepEqual(askSecret(cfg, me, { title: 'x', sink: 'nope', params: {}, fields: [], expiresMs: 60_000 }), {
    ok: false,
    error: 'No sink “nope” in config.json; there are: tok',
  })
  assert.deepEqual(
    askSecret({} as Config, me, { title: 'x', sink: 'tok', params: {}, fields: [], expiresMs: 60_000 }),
    {
      ok: false,
      error: 'No sinks in config.json yet: the owner defines them under secrets.sinks',
    },
  )
  assert.equal(askSecret(cfg, me, { title: '  ', sink: 'tok', params: {}, fields: [], expiresMs: 60_000 }).ok, false)
  assert.equal(
    askSecret(cfg, me, { title: 'x', sink: 'tok', params: { a: 'b' }, fields: [], expiresMs: 60_000 }).ok,
    false,
  )
  const r = ask(cfg)
  assert.deepEqual(requestsOf(readCard('s1')?.secrets), [r])
  assert.deepEqual(r.fields, [{ name: 'token', hidden: true }])
})

test('a request past its time is expired: said once, in the audit, and no submit writes it', async () => {
  const { home, cfg } = setUp()
  const r = ask(cfg, Date.now() - 120_000)
  const now = expireIfDue('s1', r)
  assert.equal(now.status, 'expired')
  assert.equal(expireIfDue('s1', now).status, 'expired')
  const a = await submitSecret(cfg, r.id, { values: { token: VALUE }, fingerprint: fingerprint(cfg, r) })
  assert.deepEqual(a, { status: 409, body: { ok: false, error: 'This request has expired' } })
  assert.equal(existsSync(join(home, 'token.json')), false)
  assert.deepEqual(
    audit().map(x => `${x.op} ${x.who}`),
    ['asked agent', 'expired board'],
  )
})

test('cancelled by the agent or declined by the owner: answered once, never written', async () => {
  const { home, cfg } = setUp()
  const r = ask(cfg)
  assert.equal(cancelSecret('s1', r.id)?.status, 'cancelled')
  assert.equal(cancelSecret('other', r.id), null)
  assert.equal(
    (await submitSecret(cfg, r.id, { values: { token: VALUE }, fingerprint: fingerprint(cfg, r) })).status,
    409,
  )
  const d = ask(cfg)
  assert.equal(declineSecret(d.id).status, 200)
  assert.deepEqual(declineSecret(d.id), { status: 409, body: { ok: false, error: 'This request was declined' } })
  assert.equal(declineSecret('000000000000').status, 404)
  assert.equal(existsSync(join(home, 'token.json')), false)
})

test('one write at a time: a submit while another writes is refused; one that died midway does not hold it', async () => {
  const { home, cfg } = setUp()
  const r = ask(cfg)
  const claim = (writing: number) =>
    updateCard('s1', saved => ({ ...saved, secrets: requestsOf(saved?.secrets).map(x => ({ ...x, writing })) }))
  claim(Date.now())
  const busy = await submitSecret(cfg, r.id, { values: { token: VALUE }, fingerprint: fingerprint(cfg, r) })
  assert.deepEqual(busy, { status: 409, body: { ok: false, error: 'Another submit is writing this request now' } })
  claim(Date.now() - 9 * 60_000)
  const done = await submitSecret(cfg, r.id, { values: { token: ` ${VALUE}\n` }, fingerprint: fingerprint(cfg, r) })
  assert.equal(done.status, 200)
  // what a paste brings around a key is no part of it
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'token.json'), 'utf8')), { svc: { token: VALUE } })
  const saved = ownRequest('s1', r.id)
  assert.equal(saved?.status, 'ok')
  assert.equal(saved?.writing, undefined)
})

test('a write that fails leaves the request open, with why, and no value in the why or the audit', async () => {
  const { home, cfg } = setUp()
  writeFileSync(join(home, 'token.json'), 'not json')
  const r = ask(cfg)
  const failed = await submitSecret(cfg, r.id, { values: { token: VALUE }, fingerprint: fingerprint(cfg, r) })
  assert.equal(failed.status, 400)
  assert.match(failed.body.error ?? '', /is not a JSON object where the sink writes: nothing written$/)
  assert.equal(ownRequest('s1', r.id)?.status, 'pending')
  assert.equal(ownRequest('s1', r.id)?.writing, undefined)
  assert.deepEqual(
    audit().map(x => x.op),
    ['asked', 'failed'],
  )
  assert.equal(readFileSync(auditFile(), 'utf8').includes(VALUE), false)
  assert.equal(JSON.stringify(readCard('s1')).includes(VALUE), false)
})

test('`board secret request` waits for the owner and prints what came of it; --no-wait and status for later', async () => {
  const { home, cfg } = setUp()
  const lines: string[] = []
  const ctx = { cfg, session: me, out: (l: string) => lines.push(l), pollMs: 20 }
  const waiting = secretCmd(['request', '--title', 'Token', '--sink', 'tok', '--expires', '5m'], ctx)
  // the owner answers while it waits
  let r: SecretRequest | undefined
  for (let i = 0; i < 100 && !r; i++) {
    r = requestsOf(readCard('s1')?.secrets)[0]
    if (!r) await Bun.sleep(10)
  }
  assert.ok(r)
  const done = await submitSecret(cfg, r.id, { values: { token: VALUE }, fingerprint: fingerprint(cfg, r) })
  assert.equal(done.status, 200)
  assert.equal(await waiting, 0)
  assert.match(lines[0] ?? '', /^pending · [0-9a-f]{12} · tok · until .* · the owner fills it in on the board$/)
  assert.match(lines[1] ?? '', new RegExp(`^ok · ${r.id} · .*token\\.json › svc · \\d{4}-`))
  assert.equal(lines.join('\n').includes(VALUE), false)
  assert.ok(readFileSync(join(home, 'token.json'), 'utf8').includes(VALUE))
  lines.length = 0
  assert.equal(await secretCmd(['request', '--title', 'Again', '--sink', 'tok', '--no-wait'], ctx), 2)
  const id = /pending · ([0-9a-f]{12})/.exec(lines[0] ?? '')?.[1] ?? ''
  assert.equal(await secretCmd(['cancel', id], ctx), 0)
  assert.equal(await secretCmd(['status', id], ctx), 3)
  assert.equal(lines.at(-1), `cancelled · ${id} · tok`)
  // usage errors say what is wrong and how it goes
  assert.equal(await secretCmd(['request', '--title', 'x'], ctx), 1)
  assert.match(lines.at(-1) ?? '', /^usage: --sink <id> names where the values go/)
  assert.equal(await secretCmd(['request', '--title', 'x', '--sink', 'tok', '--field', 'a:b'], ctx), 1)
  assert.equal(await secretCmd(['request', '--title', 'x', '--sink', 'tok', '--expires', '3d'], ctx), 1)
  assert.equal(await secretCmd(['list'], { ...ctx, session: null }), 1)
  lines.length = 0
  assert.equal(await secretCmd(['sinks'], { ...ctx, session: null }), 0)
  assert.equal(lines[0], 'tok · file · fields: token')
})

test('a pane-keyed session, a name with spaces and another alphabet, a value with % and Cyrillic: as any other', async () => {
  const { home, cfg } = setUp()
  const pane = { key: 'pane-wP:p8Y', name: 'Сессия с пробелом' }
  const asked = askSecret(cfg, pane, { title: 'Ключ API', sink: 'tok', params: {}, fields: [], expiresMs: 60_000 })
  assert.ok(asked.ok)
  assert.equal(ownRequest(pane.key, asked.request.id)?.by.name, 'Сессия с пробелом')
  const value = 'пароль%20100% ✓'
  const done = await submitSecret(cfg, asked.request.id, {
    values: { token: value },
    fingerprint: fingerprint(cfg, asked.request),
  })
  assert.equal(done.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'token.json'), 'utf8')), { svc: { token: value } })
  assert.equal(ownRequest(pane.key, asked.request.id)?.status, 'ok')
  assert.equal(readFileSync(auditFile(), 'utf8').includes(value), false)
})

test('from the review: no decline, cancel or expiry cuts across a write under way; five waiting at most (#273)', () => {
  const { cfg } = setUp()
  const r = ask(cfg, Date.now() - 50_000, 60_000)
  updateCard('s1', saved => ({
    ...saved,
    secrets: requestsOf(saved?.secrets).map(x => ({ ...x, writing: Date.now() })),
  }))
  assert.deepEqual(declineSecret(r.id), {
    status: 409,
    body: { ok: false, error: 'Another submit is writing this request now' },
  })
  assert.equal(cancelSecret('s1', r.id)?.status, 'pending')
  // past its time while the write goes on: still the write's to settle
  assert.equal(expireIfDue('s1', ownRequest('s1', r.id) as SecretRequest, Date.now() + 30_000).status, 'pending')
  assert.equal(ownRequest('s1', r.id)?.status, 'pending')
  for (let i = 0; i < 4; i++) ask(cfg)
  const sixth = askSecret(cfg, me, { title: 'One more', sink: 'tok', params: {}, fields: [], expiresMs: 60_000 })
  assert.deepEqual(sixth, {
    ok: false,
    error: 'This session has 5 requests waiting already: let the owner answer those first',
  })
})
