// Secrets on a node (#507, docs/design/nodes 10 items 2 and 3, 14 T11) on running boards: a master and
// its node as sandbox boards (test/support/node-pair.ts), the node's sinks defined in the master's
// config.json (`nodes.devices.<id>.sinks`) and sent with the bundle.
// - A canary typed into the master's form for a node card's request is in the node's sink file and
//   nowhere under the master's folders, in its log or its payload; the master's own audit names
//   where the answer went, never the value.
// - "Give a secret": the same canary through `POST /api/nodes { op: 'secret' }` and `board nodes
//   secret`, written by the node's door only for one of its own sinks with the fingerprint of the
//   sink the bundle wrote; the node's audit and the master's have a line each, without the value.
// - Without `node`: the web board has no `/api/node/sink`; without `nodes`, no `op: 'secret'`.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fingerprintOf, givenFields, secretsConfig } from '../../src/core/secrets.ts'
import { serveBoard } from '../support/board-server.ts'
import { type FakePane, nodePair, type Pair } from '../support/node-pair.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const CANARY = 'canary-T11-9Qx!y4Lm'
const SID = '7c2d4e1a-3b5f-4a69-8d0e-1f2a3b4c5d6e'
const SINKS = {
  wss: {
    kind: 'file',
    title: 'Web services login',
    path: '~/.wss_netrc',
    format: 'netrc',
    template: 'machine ws.example.com login me password {{token}}\n',
  },
  git: {
    kind: 'file',
    title: 'Git over HTTPS',
    path: '~/.git-credentials',
    format: 'text',
    template: 'https://me:{{token}}@git.example.com\n',
  },
  // Its folder is not there on the node: the write fails, and says so without the value.
  lost: {
    kind: 'file',
    title: 'Lost',
    path: '~/no-such-folder/token.txt',
    format: 'text',
    template: '{{token}}',
  },
  // A request names its parameter: no secret is given to it.
  'by-host': {
    kind: 'file',
    title: 'By host',
    folder: '~',
    name: '{{host}}.txt',
    params: { host: 'name' },
    template: '{{token}}',
  },
}

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Every file under `dir` that holds `text`. */
function holding(dir: string, text: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, name)
    try {
      if (readFileSync(path).includes(text)) out.push(path)
    } catch {}
  }
  return out
}

const auditOf = (box: Sandbox): Record<string, unknown>[] => {
  const file = join(stateFolder(box), 'secrets', 'audit.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as Record<string, unknown>)
    : []
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
}

async function answer(res: Response): Promise<[number, Record<string, unknown>]> {
  return [res.status, (await res.json()) as Record<string, unknown>]
}

const claudePane = (box: Sandbox): FakePane => ({
  pane_id: 'c',
  agent: 'claude',
  agent_session: { value: SID },
  agent_status: 'working',
  cwd: box.dir,
})

/** A master and one node whose sinks the bundle has sent, both boards' config.json on disk as the CLI reads it. */
async function pairWithSinks(): Promise<Pair> {
  const pair = await nodePair({
    panes: (_id, box) => [claudePane(box)],
    deviceCfg: () => ({ sinks: SINKS }),
    // The sandbox board does not read its config.json again as a real one does: the node starts with
    // the sinks the bundle then writes there, and a submit checks what is on disk (loadConfig).
    nodeCfg: () => ({ secrets: { sinks: SINKS } }),
    masterSetup(box) {
      put(join(box.env.HOME as string, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
    },
    nodeSetup(_id, box) {
      put(join(box.env.HOME as string, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }))
      // The node's own config.json on disk, as the bundle finds it: a port nobody listens on keeps
      // its `board` command off every real board.
      put(configPath(box), JSON.stringify({ language: 'en', port: 9 }))
    },
  })
  const [node] = pair.nodes
  if (!node) throw new Error('no node')
  // The master's config.json on disk, for `board nodes`: its devices and the board's own port.
  put(
    configPath(pair.master.box),
    JSON.stringify({ ...pair.masterConfig, port: Number(new URL(pair.master.url).port) }),
  )
  await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
  const [status, synced] = await answer(await post(`${pair.master.url}/api/nodes`, { op: 'sync', id: 'server-1' }))
  expect([status, synced.ok]).toEqual([200, true])
  // The bundle wrote the node's sinks as the master's config.json has them.
  expect(JSON.parse(readFileSync(configPath(node.box), 'utf8')).secrets).toEqual({ sinks: SINKS })
  return pair
}

/** Nothing of `value` on the master: no file under its folders, no log line, nothing in its payload. */
async function nothingOnMaster(pair: Pair, value: string): Promise<void> {
  expect(holding(pair.master.box.dir, value)).toEqual([])
  expect(pair.master.proc.messages.map(m => JSON.stringify(m)).join('\n')).not.toContain(value)
  expect(await (await fetch(`${pair.master.url}/api/board`)).text()).not.toContain(value)
}

describe('secrets on a node', () => {
  test("a canary typed into the master's form is in the node's sink and nowhere on the master; the master's audit says where it went", async () => {
    const pair = await pairWithSinks()
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const remote = `@server-1:${SID}`

    // The session on the node asks, as `board secret request` there does, of a sink the bundle wrote.
    const asked = await node.box.run('cli', {
      args: ['secret', 'request', '--title', 'Node login', '--sink', 'wss', '--field', 'token', '--no-wait'],
      env: { CLAUDE_CODE_SESSION_ID: SID },
    }).exited
    expect(asked.code, `${asked.stdout}${asked.stderr}`).toBe(2)
    const id = /pending · ([0-9a-f]{12}) · wss/.exec(asked.stdout)?.[1] ?? ''
    expect(id).toMatch(/^[0-9a-f]{12}$/)

    // The card is in the master's payload with the form, as the node's board shows it.
    let view: { id: string; fingerprint: string; sink: string } | undefined
    const deadline = Date.now() + 15_000
    while (!view) {
      const board = (await (await fetch(`${pair.master.url}/api/board`)).json()) as {
        items: { key: string; secrets?: { id: string; fingerprint: string; sink: string }[] }[]
      }
      view = board.items.find(i => i.key === remote)?.secrets?.find(s => s.id === id)
      if (!view && Date.now() > deadline) throw new Error('the request never reached the master')
      if (!view) await Bun.sleep(50)
    }
    // The fingerprint the node shows is the master's sink as the bundle sent it.
    const [sink] = [secretsConfig({ sinks: SINKS }, { home: '/' }).sinks.get('wss')]
    if (!sink) throw new Error('no sink')
    const check = givenFields(sink)
    if (!check.ok) throw new Error(check.error)
    expect(view.fingerprint).toBe(fingerprintOf(sink, {}, check.fields))

    const [status, body] = await answer(
      await post(`${pair.master.url}/api/secret/${id}`, {
        op: 'submit',
        values: { token: CANARY },
        fingerprint: view.fingerprint,
      }),
    )
    const nodeHome = node.box.env.HOME as string
    expect([status, body]).toEqual([200, { ok: true, target: join(nodeHome, '.wss_netrc') }])
    expect(readFileSync(join(nodeHome, '.wss_netrc'), 'utf8')).toBe(
      `machine ws.example.com login me password ${CANARY}\n`,
    )
    await nothingOnMaster(pair, CANARY)

    // The master's own audit: the answer went to server-1, by name.
    expect(auditOf(pair.master.box)).toEqual([
      {
        at: expect.any(String),
        op: 'forwarded',
        id,
        key: remote,
        sink: 'wss',
        fields: ['token'],
        device: 'server-1',
        who: 'owner',
        status: 200,
      },
    ])
    // A decline sends no value: the node's audit says it, the master's has no line for it.
    const again = await node.box.run('cli', {
      args: ['secret', 'request', '--title', 'Once more', '--sink', 'wss', '--field', 'token', '--no-wait'],
      env: { CLAUDE_CODE_SESSION_ID: SID },
    }).exited
    const second = /pending · ([0-9a-f]{12}) · wss/.exec(again.stdout)?.[1] ?? ''
    expect(second).toMatch(/^[0-9a-f]{12}$/)
    for (let shown = false; !shown; await Bun.sleep(50)) {
      const board = (await (await fetch(`${pair.master.url}/api/board`)).json()) as {
        items: { key: string; secrets?: { id: string }[] }[]
      }
      shown = !!board.items.find(i => i.key === remote)?.secrets?.some(s => s.id === second)
    }
    expect((await post(`${pair.master.url}/api/secret/${second}`, { op: 'decline' })).status).toBe(200)
    expect(auditOf(pair.master.box).map(l => l.id)).toEqual([id])

    // The node's audit has the requests, the write and the decline, as for a session of its own.
    expect(auditOf(node.box).map(l => l.op)).toEqual(['asked', 'written', 'asked', 'declined'])
    expect(JSON.stringify(auditOf(node.box))).not.toContain(CANARY)
  }, 90_000)

  test('"give a secret": the canary through the master to one of the node\'s own sinks, by the route and by board nodes secret', async () => {
    const pair = await pairWithSinks()
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const nodeHome = node.box.env.HOME as string
    const sink = secretsConfig({ sinks: SINKS }, { home: '/' }).sinks.get('git')
    if (!sink) throw new Error('no sink')
    const check = givenFields(sink)
    if (!check.ok) throw new Error(check.error)
    const fingerprint = fingerprintOf(sink, {}, check.fields)
    const fingerprintFor = (id: string): string => {
      const s = secretsConfig({ sinks: SINKS }, { home: '/' }).sinks.get(id)
      const c = s && givenFields(s)
      if (!s || !c?.ok) throw new Error(id)
      return fingerprintOf(s, {}, c.fields)
    }
    const give = (body: Record<string, unknown>) =>
      post(`${pair.master.url}/api/nodes`, { op: 'secret', id: 'server-1', ...body })

    // Refused, each before anything is written: another sink than the bundle wrote, a sink that
    // takes parameters, a value for a field the sink does not have, an unknown device.
    const refused = [
      await answer(await give({ sink: 'git', values: { token: CANARY }, fingerprint: 'f'.repeat(16) })),
      await answer(await give({ sink: 'nope', values: { token: CANARY }, fingerprint })),
      await answer(await give({ sink: 'by-host', values: { token: CANARY }, fingerprint })),
      await answer(await give({ sink: 'git', values: { token: CANARY, other: 'x' }, fingerprint })),
    ]
    expect(refused.map(([s, b]) => [s, b.ok])).toEqual([
      [409, false],
      [404, false],
      [409, false],
      [400, false],
    ])
    expect(
      await answer(await post(`${pair.master.url}/api/nodes`, { op: 'secret', id: 'server-9', sink: 'git' })),
    ).toEqual([404, { error: 'device' }])
    expect(existsSync(join(nodeHome, '.git-credentials'))).toBe(false)
    expect(holding(node.box.dir, CANARY)).toEqual([])

    // board nodes secret on the master: the field read from stdin (a pipe here, the terminal without
    // echo for the owner), never an argument, never printed.
    const proc = Bun.spawn(
      [process.execPath, join(root, 'src', 'entrypoints', 'cli.ts'), 'nodes', 'secret', 'server-1', 'git'],
      {
        cwd: root,
        env: { ...pair.master.box.env, CLAUDE_CODE_SESSION_ID: '' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    proc.stdin.write(`${CANARY}\n`)
    proc.stdin.end()
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    expect([proc.exitCode, out.trim(), err]).toEqual([
      0,
      `ok · server-1 git written: ${join(nodeHome, '.git-credentials')}`,
      '',
    ])
    expect(readFileSync(join(nodeHome, '.git-credentials'), 'utf8')).toBe(`https://me:${CANARY}@git.example.com\n`)

    // The route with the same values once more: the same write.
    expect(await answer(await give({ sink: 'git', values: { token: CANARY }, fingerprint }))).toEqual([
      200,
      { ok: true, target: join(nodeHome, '.git-credentials') },
    ])
    await nothingOnMaster(pair, CANARY)

    // The node's audit: the given secret by sink and field; the master's: where it went.
    const nodeLines = auditOf(node.box).filter(l => l.op === 'given')
    expect(nodeLines).toHaveLength(2)
    expect(nodeLines[0]).toEqual({
      at: expect.any(String),
      op: 'given',
      sink: 'git',
      fields: ['token'],
      who: 'owner',
      target: join(nodeHome, '.git-credentials'),
    })
    expect(JSON.stringify(auditOf(node.box))).not.toContain(CANARY)
    // A write that fails on the node says why, without the value, in its answer and its audit.
    const [lostStatus, lost] = await answer(
      await give({ sink: 'lost', values: { token: CANARY }, fingerprint: fingerprintFor('lost') }),
    )
    expect([lostStatus, lost.ok, String(lost.error)]).toEqual([400, false, expect.stringContaining('no-such-folder')])
    expect(JSON.stringify(lost)).not.toContain(CANARY)
    expect(auditOf(node.box).at(-1)).toMatchObject({ op: 'failed', sink: 'lost', fields: ['token'] })

    // The sink changed on the node since the bundle (the owner edited its config.json there): the
    // master's fingerprint no longer holds, and nothing is written.
    const nodeConfig = JSON.parse(readFileSync(configPath(node.box), 'utf8'))
    nodeConfig.secrets.sinks.git.template = 'https://other:{{token}}@git.example.com\n'
    writeFileSync(configPath(node.box), JSON.stringify(nodeConfig))
    const [changedStatus, changed] = await answer(
      await give({ sink: 'git', values: { token: 'not-this' }, fingerprint }),
    )
    expect([changedStatus, changed.ok]).toEqual([409, false])
    expect(readFileSync(join(nodeHome, '.git-credentials'), 'utf8')).toBe(`https://me:${CANARY}@git.example.com\n`)

    // The node gone: the master answers so, and sends nothing.
    const sent = auditOf(pair.master.box).length
    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state !== 'online', 15_000)
    expect(await answer(await give({ sink: 'git', values: { token: CANARY }, fingerprint }))).toEqual([
      503,
      { error: 'node-offline', device: 'server-1' },
    ])
    expect(auditOf(pair.master.box)).toHaveLength(sent)
    await nothingOnMaster(pair, CANARY)

    const masterLines = auditOf(pair.master.box)
    expect(masterLines.filter(l => l.status === 200)).toEqual([
      {
        at: expect.any(String),
        op: 'forwarded',
        given: true,
        sink: 'git',
        fields: ['token'],
        device: 'server-1',
        who: 'owner',
        status: 200,
      },
      {
        at: expect.any(String),
        op: 'forwarded',
        given: true,
        sink: 'git',
        fields: ['token'],
        device: 'server-1',
        who: 'owner',
        status: 200,
      },
    ])
  }, 90_000)

  test("without `node` the web board has no /api/node/sink; without `nodes` there is no op 'secret'", async () => {
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en' })
    // As a path the board never had.
    const res = await post(`${url}/api/node/sink/git`, { values: { token: CANARY }, fingerprint: 'x' })
    const never = await post(`${url}/api/node/never-was`, { values: { token: CANARY }, fingerprint: 'x' })
    expect([res.status, await res.text()]).toEqual([never.status, await never.text()])
    const nodes = await post(`${url}/api/nodes`, {
      op: 'secret',
      id: 'server-1',
      sink: 'git',
      values: { token: CANARY },
    })
    expect(nodes.status).toBe(never.status)
    await nodes.body?.cancel()
    expect(existsSync(join(stateFolder(box), 'secrets'))).toBe(false)
    expect(holding(box.dir, CANARY)).toEqual([])
  }, 30_000)
})
