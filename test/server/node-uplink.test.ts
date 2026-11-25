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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryBlobs } from '../../hub/src/blobs.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { boxBytes, generateKey, sign } from '../../src/core/team.ts'
import { generateBoxKey } from '../../src/core/team-box.ts'
import { startHarness } from '../hub/harness.ts'
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
async function threadPair(threads: unknown = true) {
  const pair = await nodePair({
    env: ENV,
    masterCfg: { threads, scheduleTickSec: 0.2 },
    panes: (_id, box) => pane(box),
    masterPanes: () => [],
  })
  const node = pair.nodes[0] as PairNode
  herdrOf(node.box, pane(node.box))
  nodeConfigFile(node)
  writeConfig(pair.master.box, { language: 'en', port: portOf(pair.master.url), threads })
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

test("the master refuses what is not a session's allowed command, whatever the node sends", async () => {
  const { pair, node } = await threadPair()
  expect((await cli(node.box, ['thread', 'new', '--session', S, 'Fenced'])).code).toBe(0)
  for (const [body, line] of [
    [
      { cmd: 'backup', argv: ['status'], session: S, lane: 'atlas' },
      "board backup is not taken from a node: run it on the board's computer",
    ],
    [
      { cmd: 'thread', argv: ['post', 'atlas-1', 'as the owner'], session: '', lane: null },
      "only a session's command is taken from a node",
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

// Case files (#488) through the master's own wiring (server/app.ts caseLive): a node's session in a
// case reads from the nodes' cards, up on its device while the master hears it, and from the offline
// copy, "last seen" with the copy's time, once the node is cut off. Never gone.
test("a case's node session on the master's page: up on its device, then last seen from the offline copy", async () => {
  const { pair, node } = await threadPair({ cases: true })
  expect((await cli(node.box, ['thread', 'new', '--session', S, '--ref', 'ABC-12', 'Case on the node'])).code).toBe(0)
  expect((await cli(node.box, ['thread', 'post', '--session', S, 'atlas-1', '--state', 'Mapped.'])).code).toBe(0)
  type View = { case?: { sessions: { key: string; state: string; device?: string; seenAt?: number }[] } }
  const sessionOf = async () => {
    const res = await fetch(`${pair.master.url}/api/threads/atlas-1`)
    return ((await res.json()) as View).case?.sessions.find(s => s.key === K)
  }
  const up = await sessionOf()
  expect(up).toMatchObject({ key: K, state: 'up', device: node.id })
  expect(up?.seenAt).toBeUndefined()

  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
  const seen = await sessionOf()
  expect(seen).toMatchObject({ key: K, state: 'up', device: node.id })
  expect(typeof seen?.seenAt).toBe('number')
}, 60_000)

test('#644 board time from a node session logs, edits, posts, lists, exports, and imports on the master only', async () => {
  const syncFolder = mkdtempSync(join(tmpdir(), 'board-time-sync-'))
  try {
    const timeCfg = {
      zone: 'UTC',
      clients: {
        atlas: {
          projects: ['Support'],
          systems: [{ id: 'erp', title: 'ERP' }],
        },
      },
    }
    const pair = await nodePair({
      env: ENV,
      masterCfg: { time: timeCfg, backup: { folder: syncFolder } },
      panes: (_id, box) => pane(box),
      masterPanes: () => [],
    })
    const node = pair.nodes[0] as PairNode
    herdrOf(node.box, pane(node.box))
    nodeConfigFile(node)

    // Set up a verified backup key & status on the master so time writes are allowed there (none on the node).
    const masterState = stateFolder(pair.master.box)
    mkdirSync(join(masterState, 'backup'), { recursive: true })
    writeFileSync(
      join(masterState, 'backup', 'backup-key.json'),
      JSON.stringify(makeKey('test passphrase', 1, { logN: 10, r: 8, p: 1 })),
    )
    writeFileSync(
      join(masterState, 'backup', 'status.json'),
      JSON.stringify({ targets: { folder: { seq: 0, failures: 0, tested: Date.now(), where: syncFolder } } }),
    )
    await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
    expect((await cli(node.box, ['cat', 'atlas', '--session', S])).code).toBe(0)
    await cardLane(pair.master.url, 'atlas')

    const added = await cli(node.box, [
      'time',
      'add',
      '--session',
      S,
      '--project',
      'Support',
      '--minutes',
      '45',
      '--json',
      'Logged from server-1',
    ])
    expect(added.code, `${added.stdout}\n${added.stderr}`).toBe(0)

    // List from node: the entry lives on the master, authored by @server-1:s-server-1.
    const listed = await cli(node.box, ['time', 'list', '--session', S, '--json'])
    expect(listed.code, listed.stderr).toBe(0)
    const entries = JSON.parse(listed.stdout) as {
      id: string
      client: string
      project: string
      description: string
      by: { key: string; name: string }
    }[]
    expect(entries).toHaveLength(1)
    const entry = entries[0] as (typeof entries)[number]
    expect(entry).toMatchObject({
      client: 'atlas',
      project: 'Support',
      description: 'Logged from server-1',
      by: { key: K, name: 'p1' },
    })
    // No local DB was created on the node.
    expect(existsSync(join(stateFolder(node.box), 'board.sqlite'))).toBe(false)

    // Edit own entry from the node without --force, mark posted in erp, inspect via show/day/projects/export.
    const edited = await cli(node.box, [
      'time',
      'edit',
      entry.id,
      '--session',
      S,
      '--minutes',
      '60',
      '--description',
      'Updated from server-1',
      '--json',
    ])
    expect(edited.code, edited.stderr).toBe(0)
    expect(JSON.parse(edited.stdout)).toMatchObject({ id: entry.id, description: 'Updated from server-1', rev: 2 })

    const posted = await cli(node.box, [
      'time',
      'post',
      entry.id,
      '--session',
      S,
      '--system',
      'erp',
      '--record',
      'ERP-42',
      '--json',
    ])
    expect(posted.code, posted.stderr).toBe(0)
    expect(JSON.parse(posted.stdout)).toMatchObject({ system: 'erp', count: 1 })

    const shown = await cli(node.box, ['time', 'show', entry.id, '--session', S])
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('Updated from server-1')
    expect(shown.stdout).toContain('erp ERP-42')

    const projects = await cli(node.box, ['time', 'projects', '--session', S, '--json'])
    expect(projects.code).toBe(0)
    expect(JSON.parse(projects.stdout)).toEqual({ atlas: ['Support'] })

    const exported = await cli(node.box, ['time', 'export', '--session', S])
    expect(exported.code).toBe(0)
    expect(exported.stdout).toContain('Updated from server-1')

    // Import dry-run carries the node's CSV file to the master cleanly.
    const csvPath = join(node.box.dir, 'toggl export 100%.csv')
    writeFileSync(
      csvPath,
      [
        'User,Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags',
        'Me,Atlas,Support,From CSV,2026-11-23,09:00:00,2026-11-23,09:30:00,00:30:00,',
      ].join('\n'),
    )
    const imported = await cli(node.box, [
      'time',
      'import',
      csvPath,
      '--session',
      S,
      '--tz',
      'UTC',
      '--map',
      'Atlas=atlas',
      '--dry-run',
      '--json',
    ])
    expect(imported.code, imported.stderr).toBe(0)
    expect(JSON.parse(imported.stdout)).toMatchObject({ dryRun: true, new: 1, entries: 1 })
    expect(outboxCount(node)).toBe(0)

    // With the link cut, board time fails immediately and leaves nothing in the outbox.
    await node.proxy.cut('drop')
    await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
    const offline = await cli(node.box, ['time', 'list', '--session', S, '--json'])
    expect(offline.code).toBe(1)
    expect(JSON.parse(offline.stdout)).toEqual({
      ok: false,
      error: 'unreachable',
      message: "the board's computer is not reachable",
    })
    expect(outboxCount(node)).toBe(0)
  } finally {
    rmSync(syncFolder, { recursive: true, force: true })
  }
}, 60_000)

test('#698 shared-state commands from a node reach master state, enforce trust boundary, and keep local commands local', async () => {
  const S2 = 's-server-1-local'
  const MASTER_S = 'aaaaaaaa-1111-4111-8111-111111111111'
  const HIDDEN_S = 'bbbbbbbb-2222-4222-8222-222222222222'
  const pair = await nodePair({
    count: 2,
    env: ENV,
    masterCfg: {
      calendar: { sources: [{ id: 'work', kind: 'push', label: 'Work' }] },
      decisions: true,
      journal: true,
      presence: { mode: 'off' },
      categories: [
        { id: 'atlas', title: 'Atlas', color: 'cyan', paths: [] },
        { id: 'personal', title: 'Personal', color: 'green', paths: [] },
      ],
      scheduleTickSec: 0.2,
    },
    panes: (id, box) =>
      id === 'server-1'
        ? [
            { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
            { pane_id: 'p2', agent: 'claude', agent_session: { value: S2 }, agent_status: 'idle', cwd: box.dir },
          ]
        : [{ pane_id: 'p1', agent: 'claude', agent_session: { value: HIDDEN_S }, agent_status: 'idle', cwd: box.dir }],
    masterPanes: box => [
      { pane_id: 'w2:p1', agent: 'claude', agent_session: { value: MASTER_S }, agent_status: 'idle', cwd: box.dir },
    ],
  })
  const node = pair.nodes[0] as PairNode
  const node2 = pair.nodes[1] as PairNode
  herdrOf(node.box, [
    { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: node.box.dir },
    { pane_id: 'p2', agent: 'claude', agent_session: { value: S2 }, agent_status: 'idle', cwd: node.box.dir },
  ])
  herdrOf(node2.box, [
    { pane_id: 'p1', agent: 'claude', agent_session: { value: HIDDEN_S }, agent_status: 'idle', cwd: node2.box.dir },
  ])
  nodeConfigFile(node)
  nodeConfigFile(node2)
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  await pair.waitDevice(node2.id, d => d.link?.state === 'online', 10_000)

  // Local card commands stay local on the node; label sessions to verify board list visibility & note privacy.
  expect((await cli(node.box, ['cat', 'atlas', '--session', S])).code).toBe(0)
  expect((await cli(node.box, ['doing', 'local work', '--session', S])).code).toBe(0)
  expect((await cli(node2.box, ['doing', 'secret node2', '--session', HIDDEN_S])).code).toBe(0)
  expect((await cli(pair.master.box, ['cat', 'personal', '--session', MASTER_S])).code).toBe(0)
  expect((await cli(pair.master.box, ['doing', 'secret master doing', '--session', MASTER_S])).code).toBe(0)
  await cardLane(pair.master.url, 'atlas')

  const nodeCli = (args: string[]) => node.box.run('cli', { args, env: { CLAUDE_CODE_SESSION_ID: S } }).exited

  // board cal: add, list, edit, push --file, rm all run on master; no calendar DB on node.
  const calAdd = await nodeCli([
    'cal',
    'add',
    '--title',
    'Sync',
    '--start',
    '2026-11-24 10:00',
    '--minutes',
    '30',
    '--json',
  ])
  expect(calAdd.code, calAdd.stderr).toBe(0)
  const eventId = (JSON.parse(calAdd.stdout) as { event: { id: string } }).event.id
  const calList = await nodeCli(['cal', 'list', '--day', '2026-11-24', '--json'])
  expect(calList.code, calList.stderr).toBe(0)
  expect(
    (JSON.parse(calList.stdout) as { events: { id: string; title: string }[] }).events.some(e => e.id === eventId),
  ).toBe(true)

  const calEdit = await nodeCli(['cal', 'edit', eventId, '--title', 'Updated Sync', '--json'])
  expect(calEdit.code, calEdit.stderr).toBe(0)
  expect((JSON.parse(calEdit.stdout) as { event: { title: string } }).event.title).toBe('Updated Sync')

  const pushFile = join(node.box.dir, 'events 100% атлас.json')
  writeFileSync(
    pushFile,
    JSON.stringify([{ id: 'p-1', title: 'Pushed Event', start: '2026-11-24T12:00:00Z', end: '2026-11-24T12:30:00Z' }]),
  )
  const calPush = await nodeCli(['cal', 'push', '--source', 'work', '--file', pushFile, '--json'])
  expect(calPush.code, calPush.stderr).toBe(0)
  expect(JSON.parse(calPush.stdout)).toMatchObject({ ok: true, given: 1 })

  const calRm = await nodeCli(['cal', 'rm', eventId, '--json'])
  expect(calRm.code, calRm.stderr).toBe(0)
  expect(existsSync(join(stateFolder(node.box), 'board.sqlite'))).toBe(false)

  // board presence & board away: writes and reads master's presence.
  expect((await nodeCli(['presence', 'away'])).stdout.trim()).toBe('ok · away')
  expect((await nodeCli(['presence'])).stdout).toContain('away')
  expect((await nodeCli(['away', 'off'])).stdout.trim()).toBe('ok · here')
  expect((await nodeCli(['presence'])).stdout).toContain('here')

  // board list, cats, journal, spend: list omits free-text notes, server-2's too (#772); spend runs locally on node.
  const jr = await nodeCli(['journal', '--since', '1h', '--json'])
  expect(jr.code, jr.stderr).toBe(0)
  expect(JSON.parse(jr.stdout)).toMatchObject({ ok: true })

  const sp = await nodeCli(['spend', '--day', '2026-11-24', '--json'])
  expect(sp.code, sp.stderr).toBe(0)
  expect(JSON.parse(sp.stdout)).toMatchObject({ from: '2026-11-24', to: '2026-11-24' })

  const cats = await nodeCli(['cats'])
  expect(cats.code, cats.stderr).toBe(0)
  expect(cats.stdout).toContain('atlas (Atlas)')
  expect(cats.stdout).not.toContain(stateFolder(pair.master.box))

  const listed = await nodeCli(['list'])
  expect(listed.code, listed.stderr).toBe(0)
  expect(listed.stdout).toContain('w2:p1')
  expect(listed.stdout).toContain('p1')
  expect(listed.stdout).not.toContain('secret node2')
  expect(listed.stdout).not.toContain('secret master doing')
  expect(listed.stdout).not.toContain('local work')

  // board decisions merges master's pending decisions with this node's own local pending asks.
  expect((await cli(pair.master.box, ['ask', '--session', MASTER_S, 'master question?'])).code).toBe(0)
  expect((await nodeCli(['ask', 'node question?'])).code).toBe(0)
  const dec = await nodeCli(['decisions', '--json'])
  expect(dec.code, dec.stderr).toBe(0)
  const decItems = (JSON.parse(dec.stdout) as { ok: boolean; items: { question: string }[] }).items
  expect(decItems.map(i => i.question)).toEqual(['master question?', 'node question?'])
  const decHuman = await nodeCli(['decisions'])
  expect(decHuman.code).toBe(0)
  expect(decHuman.stdout).toContain('master question?')
  expect(decHuman.stdout).toContain('node question?')

  // board remind/every aimed at master session lands on master; own remind stays local; server-2's session too (#772).
  const rem = await nodeCli(['remind', '--session', MASTER_S, '--idle', 'in', '20m', 'check master'])
  expect(rem.code, rem.stderr).toBe(0)
  const remMatch = /reminder ([0-9a-f]{6})/.exec(rem.stdout)
  expect(remMatch).not.toBeNull()
  const remId = remMatch?.[1] as string
  const masterSchedDir = join(stateFolder(pair.master.box), 'schedule')
  const nodeSchedDir = join(stateFolder(node.box), 'schedule')
  expect(existsSync(join(masterSchedDir, `${remId}.json`))).toBe(true)
  expect(existsSync(join(nodeSchedDir, `${remId}.json`))).toBe(false)

  const ev = await nodeCli(['every', '--session', MASTER_S, '0 9 * * 1-5', 'daily master'])
  expect(ev.code, ev.stderr).toBe(0)
  const evId = /every ([0-9a-f]{6})/.exec(ev.stdout)?.[1] as string
  expect(existsSync(join(masterSchedDir, `${evId}.json`))).toBe(true)

  // Another node's session (#772): held on the master for its prefixed key, sent through its node.
  const remPeer = await nodeCli(['remind', '--session', HIDDEN_S, 'in', '20m', 'to the other node'])
  expect(remPeer.code, remPeer.stderr).toBe(0)
  const remPeerId = /reminder ([0-9a-f]{6})/.exec(remPeer.stdout)?.[1] as string
  expect(existsSync(join(nodeSchedDir, `${remPeerId}.json`))).toBe(false)
  const peerEntry = JSON.parse(readFileSync(join(masterSchedDir, `${remPeerId}.json`), 'utf8'))
  expect(peerEntry).toMatchObject({ key: `@${node2.id}:${HIDDEN_S}`, text: 'to the other node' })
  expect(peerEntry).not.toHaveProperty('pane')

  // Own reminder without --session stays local on the node.
  const localRem = await nodeCli(['remind', 'in', '20m', 'local note'])
  expect(localRem.code, localRem.stderr).toBe(0)
  const localRemId = /reminder ([0-9a-f]{6})/.exec(localRem.stdout)?.[1] as string
  expect(existsSync(join(nodeSchedDir, `${localRemId}.json`))).toBe(true)
  expect(existsSync(join(masterSchedDir, `${localRemId}.json`))).toBe(false)

  // board unschedule removes the master entry created by this session.
  const unsched = await nodeCli(['unschedule', remId])
  expect(unsched.code, unsched.stderr).toBe(0)
  expect(unsched.stdout).toContain(`ok · removed ${remId}`)
  expect(existsSync(join(masterSchedDir, `${remId}.json`))).toBe(false)

  // When master is offline: cal fails as unreachable; same-node remind, list, cats, spend, decisions work locally.
  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
  const offCal = await nodeCli(['cal', 'list'])
  expect(offCal.code).toBe(1)
  expect(offCal.stderr).toContain("the board's computer is not reachable")

  const sameNodeRem = await nodeCli(['remind', '--session', S2, 'in', '20m', 'same-node offline'])
  expect(sameNodeRem.code, sameNodeRem.stderr).toBe(0)
  const sameNodeRemId = /reminder ([0-9a-f]{6})/.exec(sameNodeRem.stdout)?.[1] as string
  expect(existsSync(join(nodeSchedDir, `${sameNodeRemId}.json`))).toBe(true)
  expect(existsSync(join(masterSchedDir, `${sameNodeRemId}.json`))).toBe(false)

  const offList = await nodeCli(['list'])
  expect(offList.code, offList.stderr).toBe(0)
  expect(offList.stdout).toContain('p1')
  expect(offList.stderr).toContain("showing this node's sessions only")

  const offCats = await nodeCli(['cats'])
  expect(offCats.code, offCats.stderr).toBe(0)
  expect(offCats.stderr).toContain("showing this node's categories only")

  const offDec = await nodeCli(['decisions', '--json'])
  expect(offDec.code, offDec.stderr).toBe(0)
  expect((JSON.parse(offDec.stdout) as { items: { question: string }[] }).items.map(i => i.question)).toEqual([
    'node question?',
  ])
  expect(offDec.stderr).toContain("showing this node's decisions only")

  const offSpend = await nodeCli(['spend', '--day', '2026-11-24', '--json'])
  expect(offSpend.code, offSpend.stderr).toBe(0)
}, 90_000)

test('#698 board team from a node reaches master team, keeps draft offline, pulls --file, and refuses owner ops', async () => {
  const hub = await startHarness({ blobs: memoryBlobs(), maxFileBytes: 1024 * 1024, quotaBytes: 2 * 1024 * 1024 })
  try {
    const masterKey = await generateKey()
    const annaKey = await generateKey()
    const annaBox = await generateBoxKey()
    const annaSig = await sign(annaKey.pkcs8, boxBytes({ box: annaBox.pub, peer: annaKey.pub }))
    ;(await hub.join(masterKey, 'master')).close()
    await hub.join(annaKey, 'Anna', undefined, ['threads', 'channels', 'files'], {
      box: { key: annaBox.pub, sig: annaSig },
    })
    const teamCfg = { hub: hub.url, name: 'master' }
    const S_UNSHARED = 's-server-1-unshared'
    const pair = await nodePair({
      env: ENV,
      masterCfg: { team: teamCfg },
      masterSetup: box => {
        const st = stateFolder(box)
        mkdirSync(st, { recursive: true })
        writeFileSync(join(st, 'team-key.json'), JSON.stringify({ v: 1, ...masterKey }), { mode: 0o600 })
        writeFileSync(
          join(st, 'team-agents.json'),
          JSON.stringify({
            v: 1,
            off: false,
            listener: null,
            peers: { [annaKey.pub]: { on: true, lanes: ['atlas'] } },
            paused: {},
          }),
        )
      },
      panes: (_id, box) => [
        { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
        { pane_id: 'p2', agent: 'claude', agent_session: { value: S_UNSHARED }, agent_status: 'idle', cwd: box.dir },
      ],
      masterPanes: () => [],
    })
    const node = pair.nodes[0] as PairNode
    herdrOf(node.box, [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: node.box.dir },
      { pane_id: 'p2', agent: 'claude', agent_session: { value: S_UNSHARED }, agent_status: 'idle', cwd: node.box.dir },
    ])
    nodeConfigFile(node)
    await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
    expect((await cli(node.box, ['cat', 'atlas', '--session', S])).code).toBe(0)
    expect((await cli(node.box, ['cat', 'personal', '--session', S_UNSHARED])).code).toBe(0)
    await cardLane(pair.master.url, 'atlas')
    await waitFor('unshared node session in lane personal', async () => {
      const payload = (await (await fetch(`${pair.master.url}/api/board`)).json()) as {
        items: { key: string; category: string }[]
      }
      return payload.items.some(i => i.key === `@server-1:${S_UNSHARED}` && i.category === 'personal')
    })

    const nodeCli = (args: string[]) => node.box.run('cli', { args, env: { CLAUDE_CODE_SESSION_ID: S } }).exited

    // Wait until master's team roster sees Anna.
    await waitFor('master team roster sees Anna', async () => {
      const r = await nodeCli(['team', 'roster'])
      return r.code === 0 && r.stdout.includes('Anna') ? r : null
    })

    // Refused owner-setup / streaming ops return exit 126 (UPLINK_REFUSED) with clear message.
    for (const bad of [
      ['team', 'join', 'inv', '--hub', hub.url, '--name', 'bad'],
      ['team', 'watch'],
      ['team', 'listen'],
      ['team', 'loop', 'Anna', '5'],
    ]) {
      const r = await nodeCli(bad)
      expect(r.code).toBe(126)
    }

    // board team post with --file pulls the file across the uplink and posts to Anna.
    const attach = join(node.box.dir, 'team attach.txt')
    writeFileSync(attach, 'report from node')
    const posted = await nodeCli(['team', 'post', 'Anna', '--file', attach, 'hi anna'])
    expect(posted.code, posted.stderr).toBe(0)
    expect(posted.stdout).toContain('ok · sent to Anna')

    // board team inbox and board team thread read master's threads (without leaking master filesystem paths).
    const inbox = await nodeCli(['team', 'inbox', '--json'])
    expect(inbox.code, inbox.stderr).toBe(0)
    expect(JSON.parse(inbox.stdout).threads.length).toBeGreaterThanOrEqual(1)
    const threadView = await nodeCli(['team', 'thread', 'Anna'])
    expect(threadView.code, threadView.stderr).toBe(0)
    expect(threadView.stdout).toContain('hi anna')
    expect(threadView.stdout).not.toContain(stateFolder(pair.master.box))
    const threadJson = await nodeCli(['team', 'thread', 'Anna', '--json'])
    expect(threadJson.code, threadJson.stderr).toBe(0)
    expect(threadJson.stdout).not.toContain(stateFolder(pair.master.box))

    // Node session in an unshared lane (`personal`) posting to Anna is held as a draft on master and sends nothing.
    const heldPost = await cli(node.box, ['team', 'post', '--session', S_UNSHARED, 'Anna', 'from unshared lane'])
    expect(heldPost.code, heldPost.stderr).toBe(0)
    expect(heldPost.stdout).toContain('held ·')

    // Online board team draft prints the hub header line before the draft confirmation.
    const onlineDraft = await nodeCli(['team', 'draft', 'Anna', 'online draft'])
    expect(onlineDraft.code, onlineDraft.stderr).toBe(0)
    expect(onlineDraft.stdout.split('\n')[0]).toContain(' · online · you: master ')
    expect(onlineDraft.stdout).toContain('ok · draft for Anna')

    // board team draft is kept offline in node outbox and delivered once on reconnect.
    await node.proxy.cut('drop')
    await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
    const keptDraft = await nodeCli(['team', 'draft', 'Anna', 'offline draft'])
    expect(keptDraft).toEqual({
      code: 0,
      stdout: "kept, goes to the board's computer when it is reachable\n",
      stderr: '',
    })
    expect(outboxCount(node)).toBe(1)

    node.proxy.restore()
    await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
    await until(() => outboxCount(node) === 0, 10_000)
    const drafts = await nodeCli(['team', 'drafts'])
    expect(drafts.code, drafts.stderr).toBe(0)
    expect(drafts.stdout).toContain('offline draft')
    expect(drafts.stdout).toContain('from unshared lane')
  } finally {
    hub.stop()
  }
}, 90_000)
