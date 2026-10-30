// The rules of secrets through the board (#273, core/secrets.ts): config.json's sinks, strict; what
// a request may ask; templates filled; where a sink writes; a request's status; and the card under
// "Needs me" while one waits, whatever the session does, and as before without one.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { attentionOf, columnOf } from '../../src/core/board.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  checkRequest,
  fillDeep,
  fillText,
  fingerprintOf,
  paramOk,
  parseExpires,
  parseField,
  problemsText,
  requestsOf,
  type SecretField,
  type SecretRequest,
  type Sink,
  safeName,
  scrub,
  secretsConfig,
  secretViews,
  statusLine,
  statusOf,
  targetOf,
  valueProblem,
} from '../../src/core/secrets.ts'
import type { Card } from '../../src/core/types.ts'

const en = translator('en')
const HOME_WIN = 'C:\\Users\\owner'
const HOME_POSIX = '/home/owner'

const SINKS = {
  'mcp-token': {
    kind: 'file',
    title: 'API token for the local MCP server',
    path: '~/.vendor_secrets.json',
    format: 'json',
    at: ['local-user', '{{profile}}'],
    template: { username: 'TOKEN.me', password: '{{token}}', account_id: 'acct-1' },
    params: { profile: '^[a-z0-9-]{1,20}$' },
  },
  netrc: {
    kind: 'file',
    path: '~/.wss_netrc',
    format: 'netrc',
    template: 'machine ws.example.com login {{user}} password {{token}}\n',
  },
  dotenv: {
    kind: 'file',
    folder: '~/env',
    name: '{{file}}.env',
    format: 'env',
    template: { API_TOKEN: '{{token}}' },
    params: { file: 'name' },
  },
  vault: { kind: 'bitwarden', folder: 'Agents', item: '{{item}}', params: { item: 'text' } },
  shell: { kind: 'env', vars: ['VENDOR_TOKEN', 'VENDOR_USER'] },
  vendor: {
    kind: 'http',
    method: 'put',
    url: 'https://api.example.com/v1/connections/{{conn}}/credentials',
    headers: { authorization: 'Bearer {{apiToken}}' },
    body: { consumerKey: '{{consumerKey}}', consumerSecret: '{{consumerSecret}}' },
    params: { conn: '^[0-9a-f-]{8,40}$' },
  },
}

const conf = (platform: 'win32' | 'linux' = 'win32', sinks: unknown = SINKS) =>
  secretsConfig({ sinks }, { home: platform === 'win32' ? HOME_WIN : HOME_POSIX, platform })
const sink = (id: string, platform: 'win32' | 'linux' = 'win32'): Sink => {
  const s = conf(platform).sinks.get(id)
  assert.ok(s, id)
  return s
}
const problemsOf = (raw: unknown, platform: 'win32' | 'linux' = 'linux') =>
  [...conf(platform, { s: raw }).sinks.values()].flatMap(s => s.problems).map(p => `${p.at} ${p.why}`)

test('each kind of sink reads as written, its fields from its template and the request', () => {
  const c = conf()
  assert.deepEqual(c.problems, [])
  for (const s of c.sinks.values()) assert.deepEqual(s.problems, [], s.id)
  const file = sink('mcp-token')
  assert.equal(file.kind, 'file')
  if (file.kind === 'file') {
    assert.equal(file.folder, HOME_WIN)
    assert.equal(file.name, '.vendor_secrets.json')
  }
  assert.deepEqual(file.fields, ['token'])
  assert.deepEqual(sink('netrc').fields, ['user', 'token'])
  assert.deepEqual(sink('vendor').fields, ['apiToken', 'consumerKey', 'consumerSecret'])
  assert.equal(sink('vault').fields, null)
  assert.equal(sink('shell').fields, null)
  assert.equal(sink('vendor').kind === 'http' && (sink('vendor') as { method: string }).method, 'PUT')
})

test('config.json is strict: what does not check out is a problem of that sink, and the others still work', () => {
  expect(problemsOf({ kind: 'file', path: 'relative/file', template: '{{x}}' })).toContain('secrets.sinks.s.path path')
  expect(problemsOf({ kind: 'file', path: '~/f', template: '{{x}}', extra: 1 })).toContain(
    'secrets.sinks.s.extra unknown',
  )
  expect(problemsOf({ kind: 'nope' })).toContain('secrets.sinks.s.kind kind')
  expect(problemsOf({ path: '~/f' })).toContain('secrets.sinks.s.kind required')
  // a secret in a file's name or a JSON key would end up in listings and logs
  expect(problemsOf({ kind: 'file', folder: '~/x', name: '{{token}}.txt', template: '{{token}}' })).toContain(
    'secrets.sinks.s.name param',
  )
  expect(
    problemsOf({ kind: 'file', path: '~/x.json', format: 'json', at: ['{{token}}'], template: { a: '{{v}}' } }),
  ).toContain('secrets.sinks.s.at param')
  expect(problemsOf({ kind: 'file', folder: '~/x', name: '../up', template: '{{v}}' })).toContain(
    'secrets.sinks.s.name name',
  )
  expect(problemsOf({ kind: 'file', path: '~/x', format: 'json', template: 'text' })).toContain(
    'secrets.sinks.s.template template',
  )
  expect(problemsOf({ kind: 'file', path: '~/x', template: 'no fields' })).toContain('secrets.sinks.s.template field')
  expect(problemsOf({ kind: 'file', path: '~/x', template: '{{v}}', params: { p: '[' } })).toContain(
    'secrets.sinks.s.params.p regex',
  )
  // the URL's host is the owner's alone: no template in it, no login, https (http for localhost)
  expect(problemsOf({ kind: 'http', url: 'https://{{host}}/x', body: '{{v}}', params: { host: 'text' } })).toContain(
    'secrets.sinks.s.url origin',
  )
  expect(problemsOf({ kind: 'http', url: 'https://user:pw@api.example.com/x', body: '{{v}}' })).toContain(
    'secrets.sinks.s.url origin',
  )
  expect(problemsOf({ kind: 'http', url: 'http://api.example.com/x', body: '{{v}}' })).toContain(
    'secrets.sinks.s.url scheme',
  )
  assert.deepEqual(problemsOf({ kind: 'http', url: 'http://127.0.0.1:9/x', body: '{{v}}' }), [])
  expect(problemsOf({ kind: 'http', url: 'https://api.example.com/{{v}}', body: '{{w}}' })).toContain(
    'secrets.sinks.s.url param',
  )
  expect(problemsOf({ kind: 'http', method: 'GET', url: 'https://api.example.com/', body: '{{v}}' })).toContain(
    'secrets.sinks.s.method method',
  )
  expect(
    problemsOf({ kind: 'bitwarden', folder: 'A', item: 'x', organization: 'not-a-guid', collection: 'x' }),
  ).toContain('secrets.sinks.s.organization id')
  // a user environment variable is Windows' own
  expect(problemsOf({ kind: 'env', vars: ['A'] }, 'linux')).toContain('secrets.sinks.s platform')
  assert.deepEqual(problemsOf({ kind: 'env', vars: ['A'] }, 'win32'), [])
  const mixed = conf('linux', { bad: { kind: 'nope' }, good: SINKS.netrc })
  assert.deepEqual(mixed.sinks.get('good')?.problems, [])
  expect(problemsText(mixed.sinks.get('bad')?.problems ?? [], en)).toContain('kind is file, bitwarden, env or http')
  assert.deepEqual(conf('linux', 'nope').problems, [{ at: 'secrets.sinks', why: 'type', value: 'nope' }])
  assert.equal(secretsConfig(undefined, { home: HOME_POSIX }).sinks.size, 0)
})

test('a request fills only the declared parameters, each by its rule, and never a way out of the folder', () => {
  const dotenv = sink('dotenv')
  assert.equal(checkRequest(dotenv, { file: 'client-a' }, []).ok, true)
  for (const file of ['../escape', 'a/b', 'a\\b', 'CON', 'nul.txt', 'x.', ' lead', '', 'a\nb'])
    assert.equal(checkRequest(dotenv, { file }, []).ok, false, JSON.stringify(file))
  assert.deepEqual(checkRequest(dotenv, {}, []), {
    ok: false,
    error: 'secret.err.paramMissing',
    vars: { name: 'file' },
  })
  assert.deepEqual(checkRequest(dotenv, { file: 'a', other: 'b' }, []), {
    ok: false,
    error: 'secret.err.paramUnknown',
    vars: { name: 'other' },
  })
  // a lax regex cannot let a path through: the name filled in is checked as a name again
  const lax = conf('linux', {
    s: { kind: 'file', folder: '~/x', name: '{{f}}', template: '{{v}}', params: { f: '.*' } },
  }).sinks.get('s') as Sink
  assert.equal(checkRequest(lax, { f: '../../etc/passwd' }, []).ok, false)
  assert.equal(checkRequest(sink('mcp-token'), { profile: 'Bad Profile' }, []).ok, false)
  assert.equal(checkRequest(sink('vendor'), { conn: 'x.evil.com' }, []).ok, false)
  // a broken sink takes nothing
  const broken = conf('linux', { s: { kind: 'file', path: 'rel', template: '{{v}}' } }).sinks.get('s') as Sink
  assert.deepEqual(checkRequest(broken, {}, []), { ok: false, error: 'secret.err.sinkBroken', vars: { sink: 's' } })
})

test('fields: a template asks for its own, masked by default; the others are named by the request within the sink’s rules', () => {
  const r = checkRequest(sink('netrc'), {}, [])
  assert.ok(r.ok)
  assert.deepEqual(r.fields, [
    { name: 'user', hidden: true },
    { name: 'token', hidden: true },
  ])
  const shown = checkRequest(sink('netrc'), {}, [
    { name: 'user', hidden: false },
    { name: 'token', hidden: true },
  ])
  assert.ok(shown.ok)
  assert.equal(checkRequest(sink('netrc'), {}, [{ name: 'token', hidden: true }]).ok, false)
  assert.equal(checkRequest(sink('netrc'), {}, [{ name: 'other', hidden: true }]).ok, false)
  assert.equal(checkRequest(sink('vault'), { item: 'Login' }, []).ok, false)
  assert.equal(checkRequest(sink('vault'), { item: 'Login' }, [{ name: 'password', hidden: true }]).ok, true)
  assert.equal(checkRequest(sink('shell'), {}, [{ name: 'VENDOR_TOKEN', hidden: true }]).ok, true)
  assert.equal(checkRequest(sink('shell'), {}, [{ name: 'PATH', hidden: true }]).ok, false)
  assert.equal(
    checkRequest(sink('vault'), { item: 'x' }, [
      { name: 'a', hidden: true },
      { name: 'a', hidden: true },
    ]).ok,
    false,
  )
  // what the other side holds is no one's to read
  const once: SecretField[] = [
    { name: 'apiToken', hidden: true, once: true },
    { name: 'consumerKey', hidden: true },
    { name: 'consumerSecret', hidden: true },
  ]
  assert.deepEqual(checkRequest(sink('vendor'), { conn: 'abcdef12' }, once), {
    ok: false,
    error: 'secret.err.onceHttp',
  })
  assert.deepEqual(parseField('token'), { name: 'token', hidden: true })
  assert.deepEqual(parseField('user:shown'), { name: 'user', hidden: false })
  assert.deepEqual(parseField('key:hidden:once'), { name: 'key', hidden: true, once: true })
  assert.equal(parseField('key:shown:hidden'), null)
  assert.equal(parseField('key:weird'), null)
})

test('templates: values go in as text, JSON stays JSON whatever they hold, and a URL gets them encoded', () => {
  const nasty = 'a"b\\c\n}{"x":1'
  const filled = fillDeep({ k: '{{v}}', n: 3, list: ['x {{v}}'], '{{p}}': true }, { v: nasty, p: 'key' })
  assert.deepEqual(JSON.parse(JSON.stringify(filled)), { k: nasty, n: 3, list: [`x ${nasty}`], key: true })
  assert.equal(fillText('a {{ v }} b {{missing}}', { v: 'X' }), 'a X b {{missing}}')
  assert.equal(fillText('/c/{{id}}', { id: 'a/../b?x' }, encodeURIComponent), '/c/a%2F..%2Fb%3Fx')
  assert.equal(valueProblem(sink('netrc'), 'token', 'has space'), 'secret.err.valueSpace')
  assert.equal(valueProblem(sink('dotenv'), 'token', 'two\nlines'), 'secret.err.valueLine')
  assert.equal(valueProblem(sink('vendor'), 'apiToken', 'line\r\nbreak'), 'secret.err.valueLine')
  assert.equal(valueProblem(sink('vendor'), 'consumerKey', 'line\nbreak'), null)
  assert.equal(valueProblem(sink('netrc'), 'token', ''), 'secret.err.valueEmpty')
  assert.equal(valueProblem(sink('vault'), 'totp', ''), null)
  assert.equal(safeName('client.env'), true)
  assert.equal(safeName('lpt1'), false)
})

test('the form shows where the values go, and its fingerprint changes with the sink', () => {
  const file = sink('mcp-token')
  const fields: SecretField[] = [{ name: 'token', hidden: true }]
  const target = targetOf(file, { profile: 'centi' }, fields, en, 'win32')
  assert.deepEqual(target, {
    kind: 'file',
    where: 'C:\\Users\\owner\\.vendor_secrets.json',
    detail: 'at local-user › centi; the rest of the file stays as it is',
  })
  assert.equal(
    targetOf(sink('vendor'), { conn: 'abc-123' }, [], en).where,
    'PUT https://api.example.com/v1/connections/abc-123/credentials',
  )
  expect(targetOf(sink('vault'), { item: 'Login' }, [], en).where).toBe(
    'folder “Agents”, item “Login” (made, or updated when it is there)',
  )
  const before = fingerprintOf(file, { profile: 'a' }, fields)
  assert.equal(fingerprintOf(file, { profile: 'a' }, fields), before)
  assert.notEqual(fingerprintOf(file, { profile: 'b' }, fields), before)
  const moved = conf('win32', { ...SINKS, 'mcp-token': { ...SINKS['mcp-token'], path: '~/elsewhere.json' } }).sinks.get(
    'mcp-token',
  ) as Sink
  assert.notEqual(fingerprintOf(moved, { profile: 'a' }, fields), before)
})

test('scrub: no value, nor its trimmed form, survives in a text', () => {
  const out = scrub('Error: bad token  s3cr3t-v4lue  for user; again s3cr3t-v4lue\nline', [' s3cr3t-v4lue ', 'other'])
  assert.equal(out.includes('s3cr3t-v4lue'), false)
  assert.equal(out, 'Error: bad token ••• for user; again ••• line')
})

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: 'abcdef012345',
  title: 'Token',
  sink: 'netrc',
  params: {},
  fields: [{ name: 'token', hidden: true }],
  by: { key: 's1', name: 'One' },
  at: 1000,
  expires: 10_000,
  status: 'pending',
  ...over,
})

test('a request expires by itself, and says so in one line without a value', () => {
  assert.equal(statusOf(request(), 9999), 'pending')
  assert.equal(statusOf(request(), 10_000), 'expired')
  assert.equal(statusOf(request({ status: 'ok' }), 20_000), 'ok')
  expect(statusLine(request({ status: 'ok', target: '/home/owner/.wss_netrc', done: 5000 }), 6000)).toBe(
    'ok · abcdef012345 · /home/owner/.wss_netrc · 1970-01-01T00:00:05.000Z',
  )
  assert.equal(statusLine(request(), 20_000), 'expired · abcdef012345 · netrc')
  assert.equal(parseExpires('30m'), 30 * 60_000)
  assert.equal(parseExpires('2h'), 7_200_000)
  assert.equal(parseExpires('10s'), null)
  assert.equal(parseExpires('2d'), null)
  const views = secretViews(
    conf(),
    { secrets: [request({ expires: Date.now() + 60_000 }), request({ id: 'old000000000' })] },
    en,
  )
  assert.deepEqual(
    views.map(v => [v.id, v.kind, v.where]),
    [['abcdef012345', 'file', 'C:\\Users\\owner\\.wss_netrc']],
  )
  const gone = secretViews(conf('win32', {}), { secrets: [request({ expires: Date.now() + 60_000 })] }, en)
  assert.equal(gone[0]?.problem, 'The sink “netrc” is no longer in config.json')
})

test('a pending request puts the card under "Needs me", working or not; an expired or answered one does not', () => {
  const pending: Card = { secrets: [request({ expires: Date.now() + 60_000 })] }
  assert.equal(columnOf('working', pending), 'me')
  assert.equal(attentionOf('working', pending), 'ask')
  assert.equal(columnOf('idle', pending), 'me')
  // a dialog in the terminal is still the decision it was
  assert.equal(attentionOf('blocked', pending), 'decision')
  // the user's own drag still wins, as for `board ask`
  assert.equal(columnOf('idle', { ...pending, pin: 'done' }), 'done')
  assert.equal(columnOf('working', { ...pending, pin: 'done' }), 'work')
  const old: Card = { secrets: [request({ expires: Date.now() - 1 })] }
  assert.equal(columnOf('working', old), 'work')
  assert.equal(columnOf('idle', old), 'idle')
  assert.equal(columnOf('working', { secrets: [request({ status: 'ok', expires: Date.now() + 60_000 })] }), 'work')
  // a card without requests (every setup before #273) goes where it went
  for (const status of ['working', 'idle', 'blocked', 'done', 'sleeping'])
    for (const card of [{}, { ask: 'q' }, { wait: 'w' }, { pin: 'me' as const }])
      assert.equal(
        columnOf(status, { ...card, secrets: [] }),
        columnOf(status, card),
        `${status} ${JSON.stringify(card)}`,
      )
})

test('from the review: no object key, no dot segment, under any rule; a netrc parameter without a space (#273)', () => {
  for (const rule of [{ kind: 'name' }, { kind: 'text' }, { kind: 'regex', source: '.*' }] as const)
    for (const value of ['__proto__', 'constructor', 'prototype', '.', '..', '...'])
      assert.equal(paramOk(rule, value), false, `${rule.kind} ${value}`)
  const json = conf('linux', {
    s: {
      kind: 'file',
      path: '~/x.json',
      format: 'json',
      at: ['{{a}}', '{{b}}'],
      template: { t: '{{v}}' },
      params: { a: 'text', b: 'text' },
    },
  }).sinks.get('s') as Sink
  assert.equal(checkRequest(json, { a: '__proto__', b: 'toString' }, []).ok, false)
  assert.equal(checkRequest(json, { a: 'ok', b: 'constructor' }, []).ok, false)
  assert.equal(checkRequest(json, { a: 'ok', b: 'fine' }, []).ok, true)
  const http = conf('linux', {
    s: { kind: 'http', url: 'https://api.example.com/v1/projects/{{p}}/secrets', body: '{{v}}', params: { p: 'text' } },
  }).sinks.get('s') as Sink
  for (const p of ['..', '.']) assert.equal(checkRequest(http, { p }, []).ok, false, p)
  const netrc = conf('linux', {
    s: {
      kind: 'file',
      path: '~/.n',
      format: 'netrc',
      template: 'machine {{host}} password {{v}}',
      params: { host: 'text' },
    },
  }).sinks.get('s') as Sink
  assert.equal(checkRequest(netrc, { host: 'a.example.com login evil' }, []).ok, false)
  assert.equal(checkRequest(netrc, { host: 'a.example.com' }, []).ok, true)
  // what config.json holds as a password is not said back by a problem
  const said = problemsText(
    [
      ...conf('linux', {
        s: { kind: 'http', url: 'https://u:pw-in-config@api.example.com/', auth: 'pw-in-config', body: '{{v}}' },
      }).sinks.values(),
    ][0]?.problems ?? [],
    en,
  )
  assert.equal(said.includes('pw-in-config'), false, said)
  assert.equal(scrub(`echo ${Buffer.from('k3y-value').toString('base64')}`, ['k3y-value']), 'echo •••')
})

test('from the review: an entry on a card that is not wholly a request is left out, and a write under way does not expire', () => {
  const good = request({ expires: Date.now() + 60_000 })
  const bad = [
    { ...good, fields: [null] },
    { ...good, fields: [{ name: 'x' }] },
    { ...good, params: { a: 1 } },
    { ...good, by: null },
    { ...good, at: 'now' },
  ]
  assert.deepEqual(requestsOf([...bad, good]), [good])
  assert.equal(secretViews(conf(), { secrets: [...bad, good] }, en).length, 1)
  const writing = request({ expires: 10_000, writing: 9_000 })
  assert.equal(statusOf(writing, 20_000), 'pending')
  assert.equal(statusOf(writing, 9_000 + 9 * 60_000), 'expired')
})
