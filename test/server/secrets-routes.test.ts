// Secrets through the board end to end (#273): an agent asks with `board secret request`, its card
// goes under "Needs me" with where the values go, the owner's submit on the board writes the sink,
// and the agent hears ok, declined or expired. Then every file the board and the CLI could have
// written (the sandbox is HOME, the state folder, the config and TMP), the board's log and output,
// its payload and its event stream are searched for the values: they are in the sinks alone.
import { onTestFinished, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretView } from '../../src/core/secrets.ts'
import type { Item } from '../../src/core/types.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeSecretBins } from '../support/fake-secrets-bin.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(60_000)

const KEY = '7d1f0c2e-5b7a-4c39-9e1d-2a6b8c0f4e11'
const FILE_VALUE = 'file-Secret-7Qz!"x\\y'
const BW_VALUE = 'bw-Secret-K2m9pV'
const BW_SESSION = 'bw-session-Rk3LwX0b9'
const HTTP_VALUE = 'http-Secret-Zx81aa'
const VALUES = [FILE_VALUE, BW_VALUE, BW_SESSION, HTTP_VALUE]

const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

/** Every file under `dir`, but those named. */
function filesIn(dir: string, except: readonly string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (except.includes(path)) continue
    if (statSync(path).isDirectory()) out.push(...filesIn(path, except))
    else out.push(path)
  }
  return out
}

/** Where a value shows: as it is, as UTF-16 (a Windows tool's output), in base64, JSON-escaped. */
function holds(bytes: Buffer, value: string): boolean {
  const forms = [value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64')]
  return forms.some(f => bytes.includes(Buffer.from(f, 'utf8')) || bytes.includes(Buffer.from(f, 'utf16le')))
}

/** The card's one pending request, as the page gets it. */
function viewOf(item: Item | undefined): SecretView {
  const list = item?.secrets as SecretView[] | undefined
  assert.ok(list?.[0], JSON.stringify(item))
  return list[0]
}

async function agent(box: Sandbox, args: string[]) {
  const out = await box.run('cli', { args: ['secret', ...args], env: { CLAUDE_CODE_SESSION_ID: KEY } }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

test('an agent asks, the owner writes from the board, and the values are in their sinks and nowhere else', async () => {
  const box = await sandbox()
  const fakes = await fakeSecretBins(box.dir)
  fakes.vault({ session: BW_SESSION, folders: [], items: [] })
  const home = box.env.HOME as string
  // the vendor's API: what it got, kept in this process's memory only
  const got: { path: string; auth: string | null; body: string }[] = []
  const vendor = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      got.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.text() })
      return new Response(`stored ${HTTP_VALUE}`, { status: 200 })
    },
  })
  onTestFinished(() => void vendor.stop(true))
  const cfg = {
    language: 'en',
    secrets: {
      sinks: {
        wss: {
          kind: 'file',
          title: 'Web services login',
          path: '~/.wss_netrc',
          format: 'netrc',
          template: 'machine ws.example.com login {{user}} password {{token}}\n',
        },
        vault: { kind: 'bitwarden', folder: 'Agents', item: '{{item}}', params: { item: 'text' } },
        vendor: {
          kind: 'http',
          method: 'PUT',
          url: `http://127.0.0.1:${vendor.port}/connections/{{conn}}`,
          headers: { authorization: 'Bearer {{apiToken}}' },
          body: { secret: '{{secret}}' },
          params: { conn: '^[a-z0-9-]{1,20}$' },
        },
      },
    },
  }
  // config.json as the owner wrote it: the CLI reads it, and so does a submit
  const confDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(confDir, { recursive: true })
  writeFileSync(join(confDir, 'config.json'), JSON.stringify({ ...cfg, port: 9 }))
  // the session asks in the middle of its turn
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            { pane_id: 'p1', agent: 'claude', agent_session: { value: KEY }, agent_status: 'working', cwd: box.dir },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const { url, proc } = await serveBoard(box, cfg, fakes.env)
  // the event stream, read all along
  let events = ''
  const stream = await fetch(`${url}/api/events`)
  const reader = stream.body?.getReader()
  void (async () => {
    for (;;) {
      const next = await reader?.read().catch(() => null)
      if (!next || next.done) return
      events += new TextDecoder().decode(next.value)
    }
  })()
  onTestFinished(() => void reader?.cancel().catch(() => {}))
  const items = async () => ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items
  const mine = async (ok: (i: Item | undefined) => boolean): Promise<Item | undefined> => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const i = (await items()).find(x => x.key === KEY)
      if (ok(i) || Date.now() > deadline) return i
      await Bun.sleep(50)
    }
  }
  assert.equal((await mine(i => i?.column === 'work'))?.column, 'work')

  // 1. a file sink: asked, shown, guarded, written
  const asked = await agent(box, [
    'request',
    '--title',
    'WSS login',
    '--sink',
    'wss',
    '--field',
    'user:shown',
    '--field',
    'token',
    '--no-wait',
  ])
  assert.equal(asked.code, 2, asked.out)
  const id = /pending · ([0-9a-f]{12}) · wss/.exec(asked.out)?.[1]
  assert.ok(id, asked.out)
  const shown = await mine(i => !!i?.secrets)
  assert.equal(shown?.column, 'me')
  assert.equal(shown?.question, 'Fill in: WSS login')
  const view = viewOf(shown)
  assert.equal(view.where, join(home, '.wss_netrc'))
  assert.equal(view.sinkTitle, 'Web services login')
  assert.deepEqual(view.fields, [
    { name: 'user', hidden: false },
    { name: 'token', hidden: true },
  ])
  const at = `${url}/api/secret/${id}`
  const submit = { op: 'submit', values: { user: 'me', token: FILE_VALUE }, fingerprint: view.fingerprint }
  assert.equal((await post(at, submit, {})).status, 403)
  assert.equal((await post(at, submit, { 'x-board': '1', origin: 'https://evil.example' })).status, 403)
  const stale = await post(at, { ...submit, fingerprint: 'not-it' })
  assert.equal(stale.status, 409)
  assert.equal(
    ((await stale.json()) as { error: string }).error,
    'Where the values go changed since the form was shown: look again',
  )
  assert.equal((await post(at, { ...submit, values: { user: 'me' } })).status, 400)
  assert.equal((await post(at, { ...submit, values: { user: 'me', token: FILE_VALUE, extra: 'x' } })).status, 400)
  const wrote = await post(at, submit)
  const answer = await wrote.text()
  assert.equal(wrote.status, 200, answer)
  assert.deepEqual(JSON.parse(answer), { ok: true, target: join(home, '.wss_netrc') })
  assert.equal(
    readFileSync(join(home, '.wss_netrc'), 'utf8'),
    `machine ws.example.com login me password ${FILE_VALUE}\n`,
  )
  assert.equal((await post(at, submit)).status, 409)
  const heard = await agent(box, ['status', id])
  assert.equal(heard.code, 0, heard.out)
  assert.match(heard.out, new RegExp(`^ok · ${id} · .*\\.wss_netrc · \\d{4}-`))
  assert.equal((await mine(i => !i?.secrets))?.column, 'work')

  // 2. Bitwarden: the owner's session with the submit, used once
  const bw = await agent(box, [
    'request',
    '--title',
    'ERP login',
    '--sink',
    'vault',
    '--param',
    'item=ERP login',
    '--field',
    'username:shown',
    '--field',
    'password',
    '--no-wait',
  ])
  const bwId = /pending · ([0-9a-f]{12})/.exec(bw.out)?.[1] as string
  const bwView = viewOf(await mine(i => !!i?.secrets))
  assert.equal(bwView.where, 'folder “Agents”, item “ERP login” (made, or updated when it is there)')
  const noSession = await post(`${url}/api/secret/${bwId}`, {
    op: 'submit',
    values: { username: 'me', password: BW_VALUE },
    fingerprint: bwView.fingerprint,
  })
  assert.equal(noSession.status, 400)
  const bwDone = await post(`${url}/api/secret/${bwId}`, {
    op: 'submit',
    values: { username: 'me', password: BW_VALUE },
    fingerprint: bwView.fingerprint,
    session: BW_SESSION,
  })
  assert.equal(bwDone.status, 200, await bwDone.clone().text())
  const item = fakes.readVault().items[0] as { name: string; login: { password: string } }
  assert.deepEqual([item.name, item.login.password], ['ERP login', BW_VALUE])

  // 3. an HTTP call the board makes itself; then a request the owner declines
  const http = await agent(box, [
    'request',
    '--title',
    'Vendor keys',
    '--sink',
    'vendor',
    '--param',
    'conn=c-1',
    '--no-wait',
  ])
  const httpId = /pending · ([0-9a-f]{12})/.exec(http.out)?.[1] as string
  const httpView = viewOf(await mine(i => !!i?.secrets))
  assert.deepEqual(
    httpView.fields.map(f => f.name),
    ['apiToken', 'secret'],
  )
  const called = await post(`${url}/api/secret/${httpId}`, {
    op: 'submit',
    values: { apiToken: 'tok', secret: HTTP_VALUE },
    fingerprint: httpView.fingerprint,
  })
  const calledText = await called.text()
  assert.deepEqual(JSON.parse(calledText), {
    ok: true,
    target: `PUT http://127.0.0.1:${vendor.port}/connections/c-1`,
    httpStatus: 200,
  })
  assert.deepEqual(got, [
    { path: '/connections/c-1', auth: 'Bearer tok', body: JSON.stringify({ secret: HTTP_VALUE }) },
  ])
  const no = await agent(box, ['request', '--title', 'Another', '--sink', 'wss', '--no-wait'])
  const noId = /pending · ([0-9a-f]{12})/.exec(no.out)?.[1] as string
  await mine(i => !!i?.secrets)
  assert.equal((await post(`${url}/api/secret/${noId}`, { op: 'decline' })).status, 200)
  const declined = await agent(box, ['status', noId])
  assert.equal(declined.code, 3)
  assert.equal(declined.out, `declined · ${noId} · wss`)

  // what the agent sees of it all: its list, without a value
  const list = await agent(box, ['requests'])
  assert.equal(list.out.split('\n').length, 4, list.out)

  // the audit: a line per step, who and what, never a value
  const audit = readFileSync(
    join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/secrets/audit.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as { op: string; sink: string; fields: string[]; asked: { key: string } })
  assert.deepEqual(
    audit.map(a => `${a.op} ${a.sink}`),
    [
      'asked wss',
      'written wss',
      'asked vault',
      'written vault',
      'asked vendor',
      'written vendor',
      'asked wss',
      'declined wss',
    ],
  )
  assert.deepEqual(audit[0]?.fields, ['user', 'token'])
  assert.equal(audit[0]?.asked.key, KEY)

  // and the search: the values are in their sinks and nowhere else
  const payload = Buffer.from(await (await fetch(`${url}/api/board`)).text())
  await Bun.sleep(300)
  proc.kill()
  const ended = await proc.exited
  const said = Buffer.from(
    `${ended.stdout}${ended.stderr}${JSON.stringify(proc.messages)}${events}${answer}${calledText}`,
  )
  const sinks = [join(home, '.wss_netrc'), fakes.files.bwState]
  const files = filesIn(box.dir, sinks)
  assert.ok(files.some(f => f.endsWith('audit.jsonl')))
  assert.ok(files.some(f => f.endsWith(`${KEY}.json`)))
  assert.ok(events.includes('Fill in: WSS login'), 'the stream carried the board')
  for (const value of VALUES) {
    for (const file of files) assert.equal(holds(readFileSync(file), value), false, `${value} in ${file}`)
    assert.equal(holds(payload, value), false, `${value} in the payload`)
    assert.equal(holds(said, value), false, `${value} in the log, output, events or answers`)
  }
})

test('the form is for the phone too: no remote listener refuses its route', () => {
  assert.equal(remoteRefusal('/api/secret/0123456789ab', '/api/secret/0123456789ab'), null)
})
