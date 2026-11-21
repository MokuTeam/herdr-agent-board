// `board thread` from a node's session (#508, docs/design/nodes 5, 6.2, 10 item 5, 14 T12) on running
// boards: a master and its node as sandbox boards (test/support/node-pair.ts), each with a fake herdr
// of its own, and the `board` command run in the node's sandbox as an agent there runs it.
// - A post from the node's session is in the master's database under the session's prefixed key and
//   the lane its card has on the master, whatever lane the node says; a `--file` report is in the
//   master's thread files, the same bytes.
// - With the link cut, a post is kept and delivered once: its result lost on the way back, the node
//   sends it again on the next stream and the master answers from its ledger without running it.
// - A read with the link cut fails at once and says why; nothing of it stays in the outbox.
// - A command off the allowlist, a call with no session and the owner's own commands are refused
//   on the master with 126, whatever the node sends.
// - The door serves a file a call registered, by its number only, and sends waiting calls first
//   without their paths; `POST /api/node/call` is not on the door.
// - A thread notice the master holds for the node's session is typed into the node's fake herdr.
// - Without `node`: no `/api/node/call`, and `board thread` writes this board's own database.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type FakePane, nodeBoard, nodePair, PAIR_ENV, type PairNode } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { SCREEN } from '../support/sleeper-fixtures.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const S = 's-server-1'
const K = `@server-1:${S}`
/** The waits of the node's board: a write kept after KEPT_MS, a read given up after READ_MS. */
const KEPT_MS = 1500
const READ_MS = 6000
const ENV = { ...PAIR_ENV, BOARD_NODE_KEPT_MS: String(KEPT_MS), BOARD_NODE_READ_MS: String(READ_MS) }

/** The board's config.json in a sandbox, which the `board` command run there reads. */
function writeConfig(box: Sandbox, cfg: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
}

const portOf = (url: string): number => Number(new URL(url).port)

/** The node's config.json as its board runs: `node` and the board's port, so the command finds it. */
function nodeConfigFile(node: PairNode): void {
  writeConfig(node.box, {
    language: 'en',
    port: portOf(node.url),
    node: { id: node.id, port: node.doorPort, workRoot: node.box.dir },
  })
}

/** `board <args>` in a sandbox, as the node's session when `--session` names it. */
async function cli(box: Sandbox, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return box.run('cli', { args, env: {} }).exited
}

/** A fake herdr whose pane takes a prompt: a node's session that hears its notices. */
function herdrOf(box: Sandbox, panes: FakePane[]): void {
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    'agent get': {
      result: { agent: { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle' } },
    },
    'agent prompt': { result: {} },
    // An empty prompt on the screen: no draft of the session's own is in the way.
    'agent read': { text: SCREEN },
  })
}

const pane = (box: Sandbox): FakePane[] => [
  { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
]

const prompts = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')

interface EntryView {
  id: string
  type: string
  text: string
  set?: Record<string, unknown>
  author: { kind: string; key?: string; name?: string }
  files?: { name: string; size: number; ref: string; path: string }[]
}

/** A thread on the master as its page reads it; null while there is none. */
async function thread(
  url: string,
  key: string,
): Promise<{ head: { lane: string; status: string; createdBy: unknown }; entries: EntryView[] } | null> {
  const res = await fetch(`${url}/api/threads/${encodeURIComponent(key)}?full=1`)
  if (!res.ok) return null
  return (await res.json()) as { head: { lane: string; status: string; createdBy: unknown }; entries: EntryView[] }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`never came: ${what}`)
    await Bun.sleep(50)
  }
}

/** The master's card of the node's session, once its lane is `lane`. */
async function cardLane(url: string, lane: string): Promise<void> {
  await waitFor(`the master's card in lane ${lane}`, async () => {
    const payload = (await (await fetch(`${url}/api/board`)).json()) as { items: { key: string; category: string }[] }
    return payload.items.some(i => i.key === K && i.category === lane)
  })
}

const outboxOf = (node: PairNode): string => join(stateFolder(node.box), 'node', 'outbox')
const outboxCount = (node: PairNode): number =>
  existsSync(outboxOf(node)) ? readdirSync(outboxOf(node)).filter(n => n.endsWith('.json')).length : 0

/** A request to the node's own board, as its `board thread` makes it. */
async function call(node: PairNode, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${node.url}/api/node/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

/** A pair whose master has threads on and runs its scheduler; both config.json files written. */
async function threadPair() {
  const pair = await nodePair({
    env: ENV,
    masterCfg: { threads: true, scheduleTickSec: 0.2 },
    panes: (_id, box) => pane(box),
    masterPanes: () => [],
  })
  const node = pair.nodes[0] as PairNode
  herdrOf(node.box, pane(node.box))
  nodeConfigFile(node)
  writeConfig(pair.master.box, { language: 'en', port: portOf(pair.master.url), threads: true })
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  // The node's session in lane atlas, on its card there and so in the master's aggregate.
  expect((await cli(node.box, ['cat', 'atlas', '--session', S])).code).toBe(0)
  await cardLane(pair.master.url, 'atlas')
  return { pair, node }
}

test("a post from the node's session lands in the master's database as that session, in its card's lane, with its file", async () => {
  const { pair, node } = await threadPair()
  const made = await cli(node.box, ['thread', 'new', '--session', S, 'T12 check'])
  expect(made).toEqual({ code: 0, stdout: 'ok · atlas-1 · next\n', stderr: '' })

  const report = join(node.box.dir, 'report 12 атлас%.md')
  writeFileSync(report, '# Report\n\nthe node wrote this\n')
  const posted = await cli(node.box, [
    'thread',
    'post',
    '--session',
    S,
    'atlas-1',
    '--status',
    'doing',
    '--summary',
    'on it',
    '--file',
    report,
    'first note',
  ])
  expect(posted).toEqual({ code: 0, stdout: 'ok · atlas-1 · doing · 1 file\n', stderr: '' })

  const t = await thread(pair.master.url, 'atlas-1')
  expect(t?.head.lane).toBe('atlas')
  expect(t?.head.createdBy).toEqual({ kind: 'session', key: K, name: 'p1' })
  const entry = t?.entries.find(e => e.text === 'first note')
  expect(entry?.author).toEqual({ kind: 'session', key: K, name: 'p1' })
  expect(entry?.set).toEqual({ status: 'doing', summary: 'on it' })
  // The report: in the master's thread files, the same bytes, named as a local post names the file.
  const [f] = entry?.files ?? []
  expect(f?.name).toBe('report-12-атлас.md')
  expect(f?.path.startsWith(join(stateFolder(pair.master.box), 'thread-files'))).toBe(true)
  expect(readFileSync(f?.path as string, 'utf8')).toBe('# Report\n\nthe node wrote this\n')
  // Nothing of the call is left on either side: the node's outbox, the master's copies of the files.
  expect(outboxCount(node)).toBe(0)
  const copies = join(stateFolder(pair.master.box), 'nodes', node.id, 'uplink')
  expect(existsSync(copies) ? readdirSync(copies) : []).toEqual([])

  // A lane the node claims is not taken while the master has the card: atlas, not elsewhere.
  const claimed = await call(node, { cmd: 'thread', argv: ['new', 'claimed lane'], session: S, lane: 'elsewhere' })
  expect(claimed).toEqual({ state: 'answered', code: 0, out: ['ok · atlas-2 · next'], err: [] })

  // A read: what the master prints, printed on the node.
  const shown = await cli(node.box, ['thread', 'list', '--session', S, '--all'])
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain('atlas-1 · doing · T12 check')
}, 60_000)

test('with the link cut a post is kept, and delivered once over two reconnects', async () => {
  const { pair, node } = await threadPair()
  expect((await cli(node.box, ['thread', 'new', '--session', S, 'Away'])).code).toBe(0)

  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
  const away = join(node.box.dir, 'away.md')
  writeFileSync(away, 'written while the master was away\n')
  const kept = await cli(node.box, ['thread', 'post', '--session', S, 'atlas-1', '--file', away, 'while away'])
  expect(kept).toEqual({ code: 0, stdout: "kept, goes to the board's computer when it is reachable\n", stderr: '' })
  expect(outboxCount(node)).toBe(1)
  const id =
    readdirSync(outboxOf(node))
      .find(n => n.endsWith('.json'))
      ?.replace(/\.json$/, '') ?? ''
  // The agent removes its file meanwhile: the post goes with the file as it was posted.
  rmSync(away)

  // The first reconnect: the master runs it, but its result is lost on the way back.
  let lost = 0
  node.proxy.intercept = async (method, path) => {
    if (method !== 'POST' || !path.startsWith('/api/node/uplink/') || lost) return null
    lost++
    return new Response('', { status: 502 })
  }
  node.proxy.restore()
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  await waitFor('the post on the master', async () =>
    (await thread(pair.master.url, 'atlas-1'))?.entries.some(e => e.text === 'while away'),
  )
  await until(() => lost === 1, 10_000)
  expect(outboxCount(node)).toBe(1)

  // The second: the node sends the call again, the master answers it from its ledger.
  node.proxy.intercept = null
  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
  node.proxy.restore()
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  await until(() => outboxCount(node) === 0, 10_000)
  const t = await thread(pair.master.url, 'atlas-1')
  const delivered = t?.entries.filter(e => e.text === 'while away') ?? []
  expect(delivered.length).toBe(1)
  expect(readFileSync(delivered[0]?.files?.[0]?.path as string, 'utf8')).toBe('written while the master was away\n')
  // Nothing of it is left in the outbox, its copy of the file neither.
  expect(readdirSync(outboxOf(node))).toEqual([])
  // Its result posted twice: the master ran it once.
  // Its result went to the node twice, the first one lost: the same result, from one run.
  const results = node.proxy.received
    .filter(r => r.request === `POST /api/node/uplink/${id}`)
    .map(r => JSON.parse(r.body))
  expect(results).toEqual([
    { code: 0, out: ['ok · atlas-1 · next · 1 file'], err: [] },
    { code: 0, out: ['ok · atlas-1 · next · 1 file'], err: [] },
  ])
}, 90_000)

test('a read with the link cut fails at once and says why; it is not kept', async () => {
  const { pair, node } = await threadPair()
  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
  await until(() => true)
  const started = Date.now()
  const r = await cli(node.box, ['thread', 'list', '--session', S])
  expect(r).toEqual({ code: 1, stdout: '', stderr: "the board's computer is not reachable\n" })
  expect(Date.now() - started).toBeLessThan(READ_MS)
  const j = await cli(node.box, ['thread', 'show', '--session', S, 'atlas-1', '--json'])
  expect(j.code).toBe(1)
  expect(JSON.parse(j.stdout)).toEqual({
    ok: false,
    error: 'unreachable',
    message: "the board's computer is not reachable",
  })
  expect(outboxCount(node)).toBe(0)
}, 60_000)

test("the master refuses what is not a session's board thread, whatever the node sends", async () => {
  const { pair, node } = await threadPair()
  expect((await cli(node.box, ['thread', 'new', '--session', S, 'Fenced'])).code).toBe(0)
  for (const [body, line] of [
    [
      { cmd: 'time', argv: ['add', '1h'], session: S, lane: 'atlas' },
      'board time is not taken from a node: only board thread',
    ],
    [
      { cmd: 'cal', argv: ['list'], session: S, lane: 'atlas' },
      'board cal is not taken from a node: only board thread',
    ],
    [
      { cmd: 'thread', argv: ['post', 'atlas-1', 'as the owner'], session: '', lane: null },
      "only a session's board thread is taken from a node",
    ],
    [
      { cmd: 'thread', argv: ['share', 'atlas-1', 'team'], session: S, lane: 'atlas' },
      'board thread share is for the owner to confirm: not from a node',
    ],
    [
      { cmd: 'thread', argv: ['open', 'atlas-1'], session: S, lane: 'atlas' },
      'board thread open opens the board on its own computer: not from a node',
    ],
  ] as const) {
    // A write is kept for the master; the others go only while its stream is open, which it is.
    const r = await call(node, body)
    expect([body.cmd, body.argv[0], r]).toEqual([
      body.cmd,
      body.argv[0],
      { state: 'answered', code: 126, out: [], err: [line] },
    ])
  }
  // Nothing of it reached the master's threads: no entry as the owner, no share asked.
  const t = await thread(pair.master.url, 'atlas-1')
  expect(t?.entries.some(e => e.text === 'as the owner')).toBe(false)
  expect(t?.entries.some(e => e.type === 'share')).toBe(false)
}, 60_000)

test("a thread notice the master holds for the node's session is typed into the node's herdr", async () => {
  const { pair, node } = await threadPair()
  expect((await cli(node.box, ['thread', 'new', '--session', S, 'Heard'])).code).toBe(0)
  const watched = await cli(node.box, ['thread', 'watch', '--session', S, 'atlas-1', '--what', 'all'])
  expect(watched).toEqual({ code: 0, stdout: 'ok · atlas-1 · watched: all\n', stderr: '' })
  // The owner, on the master, closes it: its creator and watcher on the node hears.
  expect((await cli(pair.master.box, ['thread', 'done', 'atlas-1', 'shipped'])).code).toBe(0)
  await until(() => prompts(node.box).some(c => (c[3] ?? '').includes('atlas-1 done')), 15_000)
  const line = prompts(node.box).find(c => (c[3] ?? '').includes('atlas-1 done'))
  expect(line?.slice(2, 3)).toEqual(['p1'])
  expect(line?.[3]).toContain('[board reminder from threads]')
  expect(prompts(pair.master.box)).toEqual([])
}, 60_000)

test('the door gives a file a call registered by its number, sends waiting calls first without paths; /api/node/call is not on it', async () => {
  const node = await nodeBoard('server-1', ENV)
  const file = join(node.box.dir, 'notes.md')
  writeFileSync(file, 'what the call carries\n')
  const bytes = readFileSync(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  mkdirSync(outboxOf(node), { recursive: true })
  const waiting = {
    id: '5d0c6a1e-7777',
    cmd: 'thread',
    argv: ['post', 'atlas-1', '--file', file, 'with a file'],
    session: S,
    lane: 'atlas',
    files: [{ n: 0, name: 'notes.md', size: bytes.length, sha256, path: file }],
    keep: true,
    at: Date.now(),
  }
  writeFileSync(join(outboxOf(node), `${waiting.id}.json`), JSON.stringify(waiting))
  const door = `http://127.0.0.1:${node.proxy.port}`
  const auth = { authorization: `Bearer ${node.token}` }

  const ok = await fetch(`${door}/api/node/uplink/${waiting.id}/file/0`, { headers: auth })
  expect(ok.status).toBe(200)
  expect(Buffer.from(await ok.arrayBuffer()).equals(bytes)).toBe(true)
  for (const path of [
    `/api/node/uplink/${waiting.id}/file/1`,
    `/api/node/uplink/${waiting.id}/file/9`,
    '/api/node/uplink/no-such-call/file/0',
  ]) {
    const r = await fetch(`${door}${path}`, { headers: auth })
    expect([path, r.status]).toEqual([path, 404])
  }
  // A path is never a file number: not on the door's list.
  const byPath = await fetch(`${door}/api/node/uplink/${waiting.id}/file/${encodeURIComponent(file)}`, {
    headers: auth,
  })
  expect(byPath.status).toBe(404)
  // Without the master's token, nothing.
  expect((await fetch(`${door}/api/node/uplink/${waiting.id}/file/0`)).status).toBe(401)
  // The local route is not the door's.
  const local = await fetch(`${door}/api/node/call`, {
    method: 'POST',
    headers: { ...auth, 'x-board': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'thread', argv: ['list'], session: S }),
  })
  expect(local.status).toBe(404)

  // The stream: the waiting call first, as the link carries it, without where its file is.
  const ac = new AbortController()
  const res = await fetch(`${door}/api/node/uplink`, { headers: auth, signal: ac.signal })
  expect(res.status).toBe(200)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  let text = ''
  while (!text.includes('event: call')) text += new TextDecoder().decode((await reader.read()).value)
  while (!text.slice(text.indexOf('event: call')).includes('\n\n'))
    text += new TextDecoder().decode((await reader.read()).value)
  ac.abort()
  const data =
    text
      .slice(text.indexOf('event: call'))
      .split('\n')[1]
      ?.replace(/^data: /, '') ?? ''
  const { path: _path, ...sent } = waiting.files[0] as (typeof waiting.files)[number]
  expect(JSON.parse(data)).toEqual({
    id: waiting.id,
    cmd: 'thread',
    argv: waiting.argv,
    session: S,
    lane: 'atlas',
    files: [sent],
  })
  expect(data).not.toContain('"path"')
}, 60_000)

test("without node: no /api/node/call, and board thread writes this board's own database", async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en', threads: true }, PAIR_ENV)
  writeConfig(box, { language: 'en', port: portOf(url), threads: true })
  // The route is not there: answered as a path the board never had.
  const ask = (path: string) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ cmd: 'thread', argv: ['list'], session: S }),
    })
  const [r, never] = await Promise.all([ask('/api/node/call'), ask('/api/node/never-a-route')])
  expect([r.status, await r.text()]).toEqual([never.status, await never.text()])
  const made = await cli(box, ['thread', 'new', '--lane', 'atlas', 'Here'])
  expect(made).toEqual({ code: 0, stdout: 'ok · atlas-1 · next\n', stderr: '' })
  expect((await thread(url, 'atlas-1'))?.head.createdBy).toEqual({ kind: 'owner' })
  expect(existsSync(join(stateFolder(box), 'node'))).toBe(false)
}, 60_000)
