// Writing secrets into their sinks (#273, adapters/secret-sinks.ts): files in place with the user's
// rights only, Bitwarden through a fake bw, user variables through a fake PowerShell, HTTP to a
// server of the test's own. No value on a command line, in an error, or anywhere but the sink.
import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTree } from '../../src/adapters/process.ts'
import { ENV_SCRIPT, writeSink } from '../../src/adapters/secret-sinks.ts'
import { checkRequest, type SecretField, type Sink, secretsConfig } from '../../src/core/secrets.ts'
import { isolatedHome } from '../support/env.ts'
import { fakeSecretBins } from '../support/fake-secrets-bin.ts'

const VALUE = 'Tv-9f3!"q\\uote$ x'

function sinkOf(raw: unknown, home: string): Sink {
  const s = secretsConfig({ sinks: { s: raw } }, { home, platform: process.platform }).sinks.get('s')
  assert.ok(s)
  assert.deepEqual(s.problems, [])
  return s
}

/** What the sink writes for a request: its fields checked as a request's would be. */
async function write(
  sink: Sink,
  params: Record<string, string>,
  values: Record<string, string>,
  asked: SecretField[] = [],
  bwSession?: string,
) {
  const r = checkRequest(sink, params, asked)
  assert.ok(r.ok, JSON.stringify(r))
  return writeSink({ sink, params, fields: r.fields, values, ...(bwSession !== undefined && { bwSession }) })
}

/** The file's rights are the user's alone: mode 600, or on Windows one ACE, not inherited. */
function onlyMine(path: string): void {
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600)
    return
  }
  const out = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [path], {
    encoding: 'utf8',
  }).stdout
  const aces = out
    .split(/\r?\n/)
    .map(l => l.replace(path, '').trim())
    .filter(l => /:\(/.test(l))
  assert.equal(aces.length, 1, out)
  assert.equal(/\(I\)/.test(out), false, out)
}

test('a JSON file: the template goes in at its keys, the rest of the file stays, and only the user can read it', async () => {
  const home = join(isolatedHome(), 'home')
  const file = join(home, '.vendor_secrets.json')
  writeFileSync(file, JSON.stringify({ 'local-user': { other: { password: 'kept' } }, top: 1 }))
  const sink = sinkOf(
    {
      kind: 'file',
      path: '~/.vendor_secrets.json',
      format: 'json',
      at: ['local-user', '{{profile}}'],
      template: { username: 'TOKEN.me', password: '{{token}}' },
      params: { profile: 'name' },
    },
    home,
  )
  const r = await write(sink, { profile: 'acme' }, { token: VALUE })
  assert.deepEqual(r, { ok: true, target: `${file} › local-user › acme` })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    'local-user': { other: { password: 'kept' }, acme: { username: 'TOKEN.me', password: VALUE } },
    top: 1,
  })
  onlyMine(file)
  // once: never over a value that is there
  const before = readFileSync(file, 'utf8')
  const again = await write(sink, { profile: 'acme' }, { token: 'other' }, [
    { name: 'token', hidden: true, once: true },
  ])
  assert.equal(again.ok, false)
  assert.equal(!again.ok && again.error, 'secret.err.onceThere')
  assert.equal(readFileSync(file, 'utf8'), before)
  // a file that is not JSON is not replaced by one
  writeFileSync(file, 'not json')
  const bad = await write(sink, { profile: 'acme' }, { token: VALUE })
  assert.equal(!bad.ok && bad.error, 'secret.err.notJson')
  assert.equal(readFileSync(file, 'utf8'), 'not json')
})

test('netrc and .env files: the whole netrc from its template, the .env with its other lines kept', async () => {
  const home = join(isolatedHome(), 'home')
  const netrc = sinkOf(
    {
      kind: 'file',
      path: '~/.wss_netrc',
      format: 'netrc',
      template: 'machine ws.example.com login {{user}} password {{token}}\n',
    },
    home,
  )
  assert.equal((await write(netrc, {}, { user: 'me', token: 'tok-1' })).ok, true)
  assert.equal(readFileSync(join(home, '.wss_netrc'), 'utf8'), 'machine ws.example.com login me password tok-1\n')
  onlyMine(join(home, '.wss_netrc'))
  mkdirSync(join(home, 'env'))
  const envFile = join(home, 'env', 'client.env')
  writeFileSync(envFile, '# keep me\r\nOTHER=1\r\nAPI_TOKEN=old\r\nexport API_TOKEN=older\r\n')
  const dotenv = sinkOf(
    {
      kind: 'file',
      folder: '~/env',
      name: '{{file}}.env',
      format: 'env',
      template: { API_TOKEN: '{{token}}', API_USER: 'me' },
      params: { file: 'name' },
    },
    home,
  )
  assert.equal((await write(dotenv, { file: 'client' }, { token: 'a b#c' })).ok, true)
  assert.equal(readFileSync(envFile, 'utf8'), "# keep me\r\nOTHER=1\r\nAPI_TOKEN='a b#c'\r\nAPI_USER=me\r\n")
  // the folder is the owner's: one that is not there is not made
  const missing = await write(dotenv, { file: 'x' }, { token: 't' })
  assert.equal(missing.ok, true)
  const gone = sinkOf({ kind: 'file', folder: '~/nowhere', name: 'f', template: '{{v}}' }, home)
  const r = await write(gone, {}, { v: VALUE })
  assert.equal(!r.ok && r.error, 'secret.err.noFolder')
})

test('a link where the file goes is not followed', async () => {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const elsewhere = join(dir, 'elsewhere.txt')
  writeFileSync(elsewhere, 'untouched')
  try {
    symlinkSync(elsewhere, join(home, 'link.txt'))
  } catch {
    return // no symlink rights here (Windows without developer mode)
  }
  const r = await write(sinkOf({ kind: 'file', path: '~/link.txt', template: '{{v}}' }, home), {}, { v: VALUE })
  assert.equal(!r.ok && r.error, 'secret.err.notFile')
  assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched')
})

async function withFakes() {
  const dir = isolatedHome()
  const fakes = await fakeSecretBins(dir)
  for (const [k, v] of Object.entries(fakes.env)) process.env[k] = v
  onTestFinished(() => {
    for (const k of Object.keys(fakes.env)) if (k.startsWith('FAKE_')) delete process.env[k]
  })
  return { dir, home: join(dir, 'home'), ...fakes }
}

test('Bitwarden: the item made in the sink’s folder, then updated by name; the session in bw’s env, the values on its stdin', async () => {
  const f = await withFakes()
  f.vault({ session: 'sess-1', folders: [], items: [] })
  const sink = sinkOf({ kind: 'bitwarden', folder: 'Agents', item: '{{item}}', params: { item: 'text' } }, f.home)
  const fields: SecretField[] = [
    { name: 'username', hidden: false },
    { name: 'password', hidden: true },
    { name: 'totp', hidden: true },
    { name: 'API key', hidden: true },
  ]
  // a custom field's name with a space is no field name a request may give
  assert.equal(checkRequest(sink, { item: 'ERP login' }, fields).ok, false)
  fields.pop()
  fields.push({ name: 'apiKey', hidden: true })
  const made = await write(
    sink,
    { item: 'ERP login' },
    { username: 'me', password: VALUE, totp: '', apiKey: 'k-1' },
    fields,
    'sess-1',
  )
  assert.deepEqual(made, { ok: true, target: 'Bitwarden: Agents › ERP login' })
  let v = f.readVault()
  assert.deepEqual(
    v.folders.map(x => x.name),
    ['Agents'],
  )
  assert.equal(v.items.length, 1)
  const item = v.items[0] as { folderId: string; name: string; login: Record<string, unknown>; fields: unknown[] }
  assert.equal(item.folderId, v.folders[0]?.id)
  assert.deepEqual(
    [item.name, item.login.username, item.login.password, item.login.totp],
    ['ERP login', 'me', VALUE, null],
  )
  assert.deepEqual(item.fields, [{ name: 'apiKey', value: 'k-1', type: 1 }])
  // updated by name: the same item, the new password, what was not given kept
  const again = await write(
    sink,
    { item: 'ERP login' },
    { password: 'second' },
    [{ name: 'password', hidden: true }],
    'sess-1',
  )
  assert.equal(again.ok, true)
  v = f.readVault()
  assert.equal(v.items.length, 1)
  const updated = v.items[0] as { login: Record<string, unknown>; fields: unknown[] }
  assert.deepEqual([updated.login.username, updated.login.password], ['me', 'second'])
  assert.deepEqual(updated.fields, [{ name: 'apiKey', value: 'k-1', type: 1 }])
  for (const call of f.bwCalls()) {
    assert.equal(call.session, true, call.argv.join(' '))
    assert.equal(call.noInteraction, 'true')
    assert.equal(
      call.argv.some(a => a.includes('sess-1') || a.includes(VALUE) || a.includes('second') || a.includes('ERP')),
      false,
    )
  }
  assert.ok(f.bwCalls().some(c => c.argv.join(' ') === 'create item' && c.stdin))
  // once: a password that is there stays
  const once = await write(
    sink,
    { item: 'ERP login' },
    { password: 'third' },
    [{ name: 'password', hidden: true, once: true }],
    'sess-1',
  )
  assert.equal(!once.ok && once.error, 'secret.err.onceThere')
  assert.equal((f.readVault().items[0] as { login: { password: string } }).login.password, 'second')
})

test('Bitwarden refuses without its session, locked, or with two items of the name; what bw says is scrubbed', async () => {
  const f = await withFakes()
  const sink = sinkOf({ kind: 'bitwarden', folder: 'Agents', item: 'Fixed' }, f.home)
  const fields: SecretField[] = [{ name: 'password', hidden: true }]
  f.vault({ session: 'sess-1', folders: [{ id: 'f1', name: 'Agents' }], items: [] })
  assert.equal((await write(sink, {}, { password: VALUE }, fields, '')).ok, false)
  const locked = await write(sink, {}, { password: VALUE }, fields, 'wrong')
  assert.equal(!locked.ok && locked.error, 'secret.err.bwLocked')
  f.vault({
    session: 'sess-1',
    folders: [{ id: 'f1', name: 'Agents' }],
    items: [
      { id: 'a', name: 'Fixed', folderId: 'f1' },
      { id: 'b', name: 'Fixed', folderId: 'f1' },
    ],
  })
  const twice = await write(sink, {}, { password: VALUE }, fields, 'sess-1')
  assert.equal(!twice.ok && twice.error, 'secret.err.bwTwice')
  // bw's error echoes what it was given: none of it comes back
  f.vault({ session: 'sess-1', folders: [{ id: 'f1', name: 'Agents' }], items: [], fail: 'create item' })
  const failed = await write(sink, {}, { password: VALUE }, fields, 'sess-1')
  assert.equal(!failed.ok && failed.error, 'secret.err.bwFailed')
  const text = JSON.stringify(failed)
  assert.equal(text.includes(VALUE), false, text)
  assert.equal(text.includes('sess-1'), false, text)
})

test('user environment variables through PowerShell: the values on stdin as base64, never in its argv; once keeps a set one', async () => {
  const f = await withFakes()
  const sink = secretsConfig(
    { sinks: { s: { kind: 'env', vars: ['VENDOR_TOKEN', 'VENDOR_USER'] } } },
    { home: f.home, platform: 'win32' },
  ).sinks.get('s') as Sink
  const fields: SecretField[] = [
    { name: 'VENDOR_TOKEN', hidden: true },
    { name: 'VENDOR_USER', hidden: false },
  ]
  const r = await write(sink, {}, { VENDOR_TOKEN: VALUE, VENDOR_USER: 'me' }, fields)
  assert.deepEqual(r, { ok: true, target: 'VENDOR_TOKEN, VENDOR_USER' })
  assert.deepEqual(f.userEnv(), { VENDOR_TOKEN: VALUE, VENDOR_USER: 'me' })
  const argv = JSON.stringify(f.psCalls())
  assert.equal(argv.includes(VALUE), false)
  assert.equal(argv.includes(Buffer.from(VALUE).toString('base64')), false)
  const once = await write(sink, {}, { VENDOR_TOKEN: 'new' }, [{ name: 'VENDOR_TOKEN', hidden: true, once: true }])
  assert.equal(!once.ok && once.error, 'secret.err.onceThere')
  assert.equal(f.userEnv().VENDOR_TOKEN, VALUE)
})

// Read only: the real Windows PowerShell runs the board's script with nothing to set, so this
// computer's variables are only looked at (one that every Windows user has, and one nobody has).
test.skipIf(process.platform !== 'win32')(
  'the env script runs as written in the real Windows PowerShell, setting nothing here',
  async () => {
    const ps = join(process.env.SystemRoot || 'C:Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const run = (check: string[]) =>
      runTree(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ENV_SCRIPT], {
        input: JSON.stringify({ check, set: {} }),
        timeout: 60_000,
      })
    const free = await run(['AGENT_BOARD_TEST_NO_SUCH_VARIABLE'])
    assert.deepEqual([free.code, free.stdout.trim()], [0, 'ok'], free.stderr)
    const taken = await run(['TEMP', 'AGENT_BOARD_TEST_NO_SUCH_VARIABLE'])
    assert.deepEqual([taken.code, taken.stdout.trim()], [3, 'taken:TEMP'], taken.stderr)
  },
  60_000,
)

test('HTTP: the board makes the call to the sink’s host, follows no redirect, and keeps only the status', async () => {
  isolatedHome()
  const seen: { method: string; path: string; auth: string | null; body: string }[] = []
  const other: string[] = []
  const elsewhere = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: req => {
      other.push(req.url)
      return new Response('x')
    },
  })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get('authorization'),
        body: await req.text(),
      })
      if (url.pathname.includes('redirect')) return Response.redirect(`http://127.0.0.1:${elsewhere.port}/stolen`, 302)
      return new Response(`echo ${VALUE}`, { status: url.pathname.includes('nope') ? 403 : 201 })
    },
  })
  onTestFinished(() => {
    server.stop(true)
    elsewhere.stop(true)
  })
  const sink = sinkOf(
    {
      kind: 'http',
      method: 'PUT',
      url: `http://127.0.0.1:${server.port}/v1/{{conn}}/credentials`,
      headers: { authorization: 'Bearer {{apiToken}}' },
      body: { consumerSecret: '{{secret}}', n: 1 },
      params: { conn: 'text' },
    },
    '/home/x',
  )
  const r = await write(sink, { conn: 'a/b c' }, { apiToken: 'api-1', secret: VALUE })
  assert.deepEqual(r, { ok: true, target: `PUT http://127.0.0.1:${server.port}/v1/a%2Fb%20c/credentials`, status: 201 })
  assert.deepEqual(seen[0], {
    method: 'PUT',
    path: '/v1/a%2Fb%20c/credentials',
    auth: 'Bearer api-1',
    body: JSON.stringify({ consumerSecret: VALUE, n: 1 }),
  })
  assert.equal(JSON.stringify(r).includes(VALUE), false)
  const refused = await write(sink, { conn: 'nope' }, { apiToken: 'api-1', secret: VALUE })
  assert.deepEqual(refused, {
    ok: false,
    error: 'secret.err.httpStatus',
    vars: { status: '403', host: `127.0.0.1:${server.port}` },
    status: 403,
  })
  const moved = await write(sink, { conn: 'redirect' }, { apiToken: 'api-1', secret: VALUE })
  assert.equal(!moved.ok && moved.status, 302)
  assert.deepEqual(other, [])
  const port = server.port
  server.stop(true)
  const down = await write(sink, { conn: 'x' }, { apiToken: 'api-1', secret: VALUE })
  assert.deepEqual(down, { ok: false, error: 'secret.err.httpFailed', vars: { host: `127.0.0.1:${port}` } })
})
