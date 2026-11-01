// A secret request's life (#273, services/secrets.ts, entrypoints/secret-cli.ts): asked, expired,
// cancelled, written once even with two submits at a time, a failed write that stays open, and the
// agent's command that waits for the owner.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCard, updateCard } from '../../src/adapters/cards.ts'
import { t, useLanguage } from '../../src/core/lang.ts'
import { fingerprintOf, requestsOf, type SecretRequest, secretViews } from '../../src/core/secrets.ts'
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
  // no sinks in config.json: the board's own store is the one sink there is
  assert.deepEqual(
    askSecret({} as Config, me, { title: 'x', sink: 'tok', params: {}, fields: [], expiresMs: 60_000 }),
    {
      ok: false,
      error: 'No sink “tok” in config.json; there are: store',
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
  const done = await submitSecret(cfg, r.id, { values: { token: `${VALUE}\n` }, fingerprint: fingerprint(cfg, r) })
  assert.equal(done.status, 200)
  // the line break a paste brings is no part of a key
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
  assert.equal(await secretCmd(['requests'], { ...ctx, session: null }), 1)
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

test('from the second review: a value is written as typed, spaces too; only a line break at either end goes (#273)', async () => {
  const { home, cfg } = setUp()
  const r = ask(cfg)
  const done = await submitSecret(cfg, r.id, {
    values: { token: '\r\n  spaced pass  \n' },
    fingerprint: fingerprint(cfg, r),
  })
  assert.equal(done.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'token.json'), 'utf8')), { svc: { token: '  spaced pass  ' } })
})

test('from the third review: the owner’s once holds at submit, for a request asked before it and a card entry that left it out (#273)', async () => {
  const { home, cfg } = setUp()
  const file = join(home, 'token.json')
  const raw = (cfg.secrets as { sinks: { tok: Record<string, unknown> } }).sinks.tok
  const owned = { secrets: { sinks: { tok: { ...raw, once: ['token'] } } } } as unknown as Config
  /** What the form shows for a request, with the config as it is now: its fields and its fingerprint. */
  const shown = (id: string) => secretViews(secretsOf(owned), readCard('s1'), t).find(v => v.id === id)
  // (c) asked while config.json had no once; the owner adds it before the submit
  const before = ask(cfg)
  writeFileSync(file, JSON.stringify({ svc: { token: 'kept' } }))
  const view = shown(before.id)
  assert.deepEqual(view?.fields, [{ name: 'token', hidden: true, once: true }])
  const c = await submitSecret(owned, before.id, { values: { token: VALUE }, fingerprint: view?.fingerprint })
  assert.equal(c.status, 400)
  assert.match(c.body.error ?? '', /is set already, and this field is written only once/)
  // (b) an entry written on the card by hand, without once
  updateCard('s1', saved => ({
    ...saved,
    secrets: [
      ...requestsOf(saved?.secrets),
      {
        ...before,
        id: 'bbbbbbbbbbbb',
        fields: [{ name: 'token', hidden: true }],
        status: 'pending',
        writing: undefined,
      },
    ],
  }))
  const b = await submitSecret(owned, 'bbbbbbbbbbbb', {
    values: { token: VALUE },
    fingerprint: shown('bbbbbbbbbbbb')?.fingerprint,
  })
  assert.equal(b.status, 400)
  // the fingerprint of the fields as asked, without the owner's once, is not what the form showed
  const stale = await submitSecret(owned, 'bbbbbbbbbbbb', {
    values: { token: VALUE },
    fingerprint: fingerprintOf(secretsOf(owned).sinks.get('tok') as never, {}, [{ name: 'token', hidden: true }]),
  })
  assert.equal(stale.status, 409)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { svc: { token: 'kept' } })
  // spaces alone are no value
  const blank = await submitSecret(cfg, before.id, { values: { token: '   ' }, fingerprint: fingerprint(cfg, before) })
  assert.deepEqual(blank, { status: 400, body: { ok: false, error: '“token” is empty' } })
})

// The board's own store as the sink (core/secrets.ts StoreSink): where config.json defines none, a
// request needs no --sink, its fields are variables, kept sealed for the asking session (or a
// profile's, or every session's) and read back through the store, never through the request.
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const asker = { key: SID, name: 'Сессия с пробелом %' }

/** The request's own fields and fingerprint, as the form shows them now. */
const formOf = (cfg: Config, key: string, id: string) =>
  secretViews(secretsOf(cfg), readCard(key), t).find(v => v.id === id)

test('no sinks in config.json: a request goes to the board’s own store, for the asking session, and only that session gets it', async () => {
  const { home } = setUp()
  const cfg = {} as Config
  const lines: string[] = []
  const ctx = { cfg, session: asker, out: (l: string) => lines.push(l), pollMs: 20 }
  assert.equal(await secretCmd(['request', '--title', 'GitHub', '--field', 'GH_TOKEN', '--no-wait'], ctx), 2)
  assert.match(lines[0] ?? '', /^pending · [0-9a-f]{12} · store · until /)
  const [r] = requestsOf(readCard(SID)?.secrets)
  assert.ok(r)
  assert.deepEqual(
    [r.sink, r.params, r.fields],
    ['store', { scope: 'session', session: SID }, [{ name: 'GH_TOKEN', hidden: true }]],
  )
  const view = formOf(cfg, SID, r.id)
  assert.deepEqual([view?.kind, view?.where, view?.problem], ['store', 'GH_TOKEN', undefined])
  assert.match(view?.detail ?? '', /^for the session “Сессия с пробелом %” only/)
  const done = await submitSecret(cfg, r.id, { values: { GH_TOKEN: `${VALUE}\n` }, fingerprint: view?.fingerprint })
  assert.deepEqual(done, {
    status: 200,
    body: { ok: true, target: 'secrets: GH_TOKEN (session Сессия с пробелом %)' },
  })
  const { secretsFor, listSecrets } = await import('../../src/adapters/secret-store.ts')
  assert.deepEqual(
    secretsFor({ profile: null, session: SID }).map(s => [s.name, s.value]),
    [['GH_TOKEN', VALUE]],
  )
  assert.deepEqual(secretsFor({ profile: null, session: '11111111-2222-4333-8444-555555555555' }), [])
  assert.deepEqual(
    listSecrets().map(m => [m.id, m.targetName]),
    [[`session:${SID}:GH_TOKEN`, 'Сессия с пробелом %']],
  )
  // the agent's line, the card and the audit hold no value; no file of main's sinks was written
  assert.equal(await secretCmd(['status', r.id], ctx), 0)
  assert.match(
    lines.at(-1) ?? '',
    new RegExp(`^ok · ${r.id} · secrets: GH_TOKEN \\(session Сессия с пробелом %\\) · \\d{4}-`),
  )
  assert.equal(lines.join('\n').includes(VALUE), false)
  assert.equal(JSON.stringify(readCard(SID)).includes(VALUE), false)
  assert.equal(readFileSync(auditFile(), 'utf8').includes(VALUE), false)
  assert.deepEqual(
    audit().map(x => x.op),
    ['asked', 'written'],
  )
  assert.equal(existsSync(join(home, '.env')), false)
  lines.length = 0
  assert.equal(await secretCmd(['sinks'], { ...ctx, session: null }), 0)
  assert.deepEqual(lines, [
    'store · store · fields: the variables you name (board secret get <NAME> reads one) · for: this session, or --profile <id>, or --global',
  ])
})

test('the store’s scope: --global for every session, --profile for one of the board’s profiles, a pane-keyed session asks for one of those', async () => {
  setUp()
  const cfg = {} as Config
  const lines: string[] = []
  const ctx = { cfg, session: asker, out: (l: string) => lines.push(l), pollMs: 20 }
  const { loadProfiles } = await import('../../src/adapters/profiles.ts')
  const profile = loadProfiles()[0]?.id ?? 'default'
  assert.equal(await secretCmd(['request', '--title', 'npm', '--field', 'NPM_TOKEN', '--global', '--no-wait'], ctx), 2)
  assert.equal(
    await secretCmd(['request', '--title', 'npm', '--field', 'NPM_TOKEN', '--profile', profile, '--no-wait'], ctx),
    2,
  )
  const [global, own] = requestsOf(readCard(SID)?.secrets)
  assert.deepEqual([global?.params, own?.params], [{ scope: 'global' }, { scope: 'profile', profile }])
  assert.match(formOf(cfg, SID, global?.id ?? '')?.detail ?? '', /^for every session/)
  // a profile the board does not have, or two scopes at once: refused, nothing asked
  assert.equal(await secretCmd(['request', '--title', 'x', '--field', 'A', '--profile', 'nope'], ctx), 1)
  assert.equal(
    lines.at(-1),
    `error · There is no profile “nope” on the board; there are: ${loadProfiles()
      .map(p => p.id)
      .join(', ')}`,
  )
  assert.equal(await secretCmd(['request', '--title', 'x', '--field', 'A', '--global', '--profile', profile], ctx), 1)
  assert.equal(requestsOf(readCard(SID)?.secrets).length, 2)
  const a = await submitSecret(cfg, global?.id ?? '', {
    values: { NPM_TOKEN: VALUE },
    fingerprint: formOf(cfg, SID, global?.id ?? '')?.fingerprint,
  })
  assert.deepEqual(a.body, { ok: true, target: 'secrets: NPM_TOKEN (every session)' })
  const { secretsFor } = await import('../../src/adapters/secret-store.ts')
  assert.deepEqual(
    secretsFor({ profile: null, session: null }).map(s => s.name),
    ['NPM_TOKEN'],
  )
  // a session keyed by its pane has no session of its own in the store: it asks for a profile or every session
  const pane = { key: 'pane-wP:p8Y', name: 'pi' }
  assert.deepEqual(
    askSecret(cfg, pane, {
      title: 'x',
      sink: 'store',
      params: {},
      fields: [{ name: 'A', hidden: true }],
      expiresMs: 60_000,
    }),
    {
      ok: false,
      error:
        'A secret for a session is for a Claude session: ask with --profile <id> or --global, or --param session=<Claude session id>',
    },
  )
  assert.equal(
    askSecret(cfg, pane, {
      title: 'x',
      sink: 'store',
      params: { scope: 'global' },
      fields: [{ name: 'A', hidden: true }],
      expiresMs: 60_000,
    }).ok,
    true,
  )
})

test('the store takes variables’ names only, and keeps a :once one that is set already', async () => {
  setUp()
  const cfg = {} as Config
  const ask1 = (fields: { name: string; hidden: boolean; once?: true }[], params: Record<string, string> = {}) =>
    askSecret(cfg, asker, { title: 'x', sink: 'store', params, fields, expiresMs: 60_000 })
  assert.deepEqual(ask1([{ name: 'PATH', hidden: true }]), {
    ok: false,
    error: '“PATH” is read by the shell, Claude Code, herdr or the board itself: ask for another name',
  })
  assert.deepEqual(ask1([{ name: '1A', hidden: true }]), { ok: false, error: 'The sink takes no field “1A”' })
  assert.deepEqual(ask1([]), { ok: false, error: 'Name the fields: --field <name>[:shown][:once]' })
  assert.deepEqual(ask1([{ name: 'A', hidden: true }], { scope: 'everywhere' }), {
    ok: false,
    error: 'The parameter “scope” is not what the sink allows',
  })
  assert.deepEqual(ask1([{ name: 'A', hidden: true }], { path: '/tmp' }), {
    ok: false,
    error: 'The sink takes no parameter “path”',
  })
  const { setSecret } = await import('../../src/adapters/secret-store.ts')
  setSecret({ scope: 'session', target: SID }, 'KEPT', 'old')
  const once = ask1([{ name: 'KEPT', hidden: true, once: true }])
  assert.ok(once.ok)
  const view = formOf(cfg, SID, once.request.id)
  const r = await submitSecret(cfg, once.request.id, { values: { KEPT: VALUE }, fingerprint: view?.fingerprint })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'KEPT is set already, and this field is written only once: nothing written')
  const nul = ask1([{ name: 'B', hidden: true }])
  assert.ok(nul.ok)
  const bad = await submitSecret(cfg, nul.request.id, {
    values: { B: 'a\0b' },
    fingerprint: formOf(cfg, SID, nul.request.id)?.fingerprint,
  })
  assert.deepEqual(bad, {
    status: 400,
    body: { ok: false, error: '“B” has a NUL character, which no environment variable holds' },
  })
})

test('with sinks in config.json the store is a sink only where one says kind store; the store’s flags are refused elsewhere', async () => {
  const { cfg } = setUp()
  const lines: string[] = []
  const ctx = { cfg, session: asker, out: (l: string) => lines.push(l), pollMs: 20 }
  assert.deepEqual([...secretsOf(cfg).sinks.keys()], ['tok'])
  assert.equal(await secretCmd(['request', '--title', 'x', '--field', 'A'], ctx), 1)
  assert.match(lines.at(-1) ?? '', /^usage: --sink <id> names where the values go/)
  assert.equal(await secretCmd(['request', '--title', 'x', '--sink', 'tok', '--global'], ctx), 1)
  assert.match(
    lines.at(-1) ?? '',
    /^usage: --global and --profile are for the board’s own store, and the sink “tok” is none/,
  )
  const both = {
    secrets: { sinks: { ...(cfg.secrets as { sinks: object }).sinks, vault: { kind: 'store', title: 'Board' } } },
  } as unknown as Config
  assert.deepEqual([...secretsOf(both).sinks.keys()], ['tok', 'vault'])
  const asked = askSecret(both, asker, {
    title: 'x',
    sink: 'vault',
    params: { scope: 'global' },
    fields: [{ name: 'A', hidden: true }],
    expiresMs: 60_000,
  })
  assert.ok(asked.ok)
  assert.equal(formOf(both, SID, asked.request.id)?.sinkTitle, 'Board')
})
