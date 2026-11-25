// The placer on a master with two nodes (#504, docs/design/nodes 8, 14 T8): sandbox boards with fake
// herdrs, linked by `direct` through each node's proxy (test/support/node-pair.ts). A start from the
// master's New session is placed by device order and room, sent to a node's door, queued when nothing
// has room, and kept across a restart of the master. The repository the nodes clone is a local bare
// one: the nodes' git is pointed at it from the https address (url.<base>.insteadOf), the master's
// checkout names the https address as its remote, so the board's own address rule is what runs.
import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, PAIR_ENV, type Pair } from '../support/node-pair.ts'
import { root, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const GIT = Bun.which('git') ?? 'git'
const PATH = [dirname(process.execPath), dirname(GIT)].join(delimiter)
const ADDRESS = 'https://example.test/acme/atlas.git'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(GIT, ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

/**
 * The remote (a bare repository) and the master's checkout of it, every commit pushed, its remote
 * named by the https address; and the env that points a node's git from that address at the bare one.
 */
function repos(branch = ''): { checkout: string; bare: string; nodeEnv: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'placer-'))
  scratch.push(root)
  const seed = join(root, 'seed')
  mkdirSync(seed)
  git(seed, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(seed, 'README.md'), 'atlas\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'one')
  const bare = join(root, 'atlas.git')
  if (branch) git(seed, 'branch', branch)
  git(root, 'clone', '--quiet', '--bare', seed, bare)
  const checkout = join(root, 'atlas')
  git(root, 'clone', '--quiet', ...(branch ? ['-b', branch] : []), bare, checkout)
  git(checkout, 'remote', 'set-url', 'origin', ADDRESS)
  return {
    checkout,
    bare,
    nodeEnv: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${bare.replace(/\\/g, '/')}.insteadOf`,
      GIT_CONFIG_VALUE_0: ADDRESS,
    },
  }
}

const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
/** What a board's fake herdr answers a start with: a workspace named atlas, a tab, Claude ready at once. */
const startable = (panes: unknown[] = []) => ({
  'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wA', label: 'atlas' }] } } },
  'workspace list': { result: { workspaces: [{ workspace_id: 'wA', label: 'atlas', focused: true }] } },
  'workspace create': {
    result: { workspace: { workspace_id: 'wA' }, tab: { tab_id: 'wA:t1' }, root_pane: { pane_id: 'wA:p1' } },
  },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'tab rename': { result: null },
  'pane get': READY,
  'pane run': { result: null },
  'agent list': { result: { agents: [] } },
  'agent prompt': { result: null },
  'agent rename': { result: null },
  'pane read': { text: 'Session renamed to: atlas' },
})
/** A session awake in a board's herdr. */
const awake = (id: string, cwd: string) => ({
  pane_id: 'p1',
  agent: 'claude',
  agent_session: { value: id },
  agent_status: 'idle',
  cwd,
  workspace_id: 'wA',
})

/** The default profile logged in, as Claude Code leaves it. */
function login(box: Sandbox): void {
  const dir = join(box.env.HOME ?? '', '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), '{}')
}

/** The sessions a board's herdr was asked to start: the session id of each `pane run`, in order. */
const started = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(a => a[0] === 'pane' && a[1] === 'run')
    .map(a => /--session-id ([0-9a-f-]{36})/.exec(a[3] ?? '')?.[1] ?? '?')

type Launch = {
  id: string
  state: string
  step: string
  error: string
  place?: Record<string, unknown>
  device?: string
}
const launchesOf = async (url: string): Promise<Launch[]> =>
  ((await (await fetch(`${url}/api/board`)).json()) as { launches: Launch[] }).launches
const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
const startAt = async (url: string, cwd: string, name: string, more: Record<string, unknown> = {}): Promise<string> => {
  const res = await post(url, '/api/launch', {
    name,
    cwd,
    category: 'atlas',
    workspace: { id: 'wA', label: 'atlas' },
    ...more,
  })
  const body = (await res.json()) as { ok: boolean; id: string }
  assert.ok(body.ok, JSON.stringify(body))
  return body.id
}
async function launchWhere(
  url: string,
  id: string,
  ok: (l: Launch | undefined) => boolean,
  ms = 15_000,
): Promise<Launch | undefined> {
  const end = Date.now() + ms
  let l: Launch | undefined
  while (Date.now() < end) {
    l = (await launchesOf(url)).find(x => x.id === id)
    if (ok(l)) return l
    await Bun.sleep(50)
  }
  throw new Error(`launch ${id} never got there: ${JSON.stringify(l)}`)
}

/** Waits for a board's herdr data to be fresh: a start is refused on stale data. */
async function fresh(url: string): Promise<void> {
  const end = Date.now() + 10_000
  while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
    if (Date.now() > end) throw new Error('never fresh')
    await Bun.sleep(25)
  }
}

/** Waits until no launch the master shows, its nodes' included, is still on its way: their children end with them. */
async function settled(url: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    const going = (await launchesOf(url)).filter(
      l => l.state === 'starting' || l.state === 'trust' || l.state === 'waiting',
    )
    if (!going.length) return
    if (Date.now() > end)
      throw new Error(`launches still going: ${JSON.stringify(going.map(l => [l.id, l.state, l.step]))}`)
    await Bun.sleep(50)
  }
}

const ROOM = { minFreeMemMb: 0, maxLoad: 100 }
const LANES = [
  { id: 'atlas', title: 'Atlas', color: 'blue', paths: [] },
  { id: 'other', title: 'Other', color: 'gray' },
]

/** A master and two nodes, both online with a status, that place starts of the lane atlas. */
async function placing(o: {
  nodes?: Record<string, unknown>
  device?: (id: string) => Record<string, unknown>
  nodePanes?: (id: string, box: Sandbox) => unknown[]
  masterPanes?: (box: Sandbox) => unknown[]
  count?: number
  /** The branch the master's checkout is on (pushed); main when not given. */
  branch?: string
  /** This computer's profile folder shows a login (.credentials.json); true when not given. */
  masterLogin?: boolean
  /** config.json on the master's disk names the devices, for what the board writes there (a revoke). */
  disk?: boolean
  /** More of the master board's environment. */
  masterEnv?: Record<string, string>
}): Promise<Pair & { checkout: string; bare: string }> {
  const { checkout, bare, nodeEnv } = repos(o.branch)
  const pair = await nodePair({
    count: o.count ?? 2,
    env: { ...PAIR_ENV, PATH, ...nodeEnv },
    masterEnv: { GIT_CONFIG_COUNT: '0', BOARD_NODE_QUEUE_MS: '400', ...o.masterEnv },
    panes: (id, box) => {
      login(box)
      return (o.nodePanes?.(id, box) ?? []) as Record<string, unknown>[]
    },
    masterSetup: box => {
      if (o.masterLogin !== false) login(box)
      if (o.disk) {
        const file = join(box.env.APPDATA ?? '', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
        const devices = Object.fromEntries(
          Array.from({ length: o.count ?? 2 }, (_, i) => [
            `server-${i + 1}`,
            { link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
          ]),
        )
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify({ language: 'en', nodes: { id: 'laptop', devices } }))
      }
    },
    masterCfg: { categories: LANES },
    nodesCfg: { lanes: ['atlas'], ...o.nodes },
    deviceCfg: id => ({ maxSessions: 3, ...ROOM, ...o.device?.(id) }),
  })
  for (const n of pair.nodes) n.box.state(startable((o.nodePanes?.(n.id, n.box) ?? []) as unknown[]))
  pair.master.box.state(startable((o.masterPanes?.(pair.master.box) ?? []) as unknown[]))
  for (const box of [pair.master, ...pair.nodes]) box.proc.send('refresh')
  await fresh(pair.master.url)
  for (const n of pair.nodes) await pair.waitDevice(n.id, d => d.link?.state === 'online' && !!d.status, 15_000)
  return Object.assign(pair, { checkout, bare })
}

test('seven starts in a pushed repository end 3, 3 and 1 on server-1, server-2 and this computer', async () => {
  const pair = await placing({
    nodes: {
      order: ['server-1', 'server-2', 'local'],
      whenFull: 'wait',
      devices: { local: { maxSessions: 1, ...ROOM } },
    },
  })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  const ids: string[] = []
  for (let i = 1; i <= 7; i++) ids.push(await startAt(pair.master.url, pair.checkout, `atlas ${i}`))
  await until(
    () => started(one.box).length === 3 && started(two.box).length === 3 && started(pair.master.box).length === 1,
    40_000,
  )
  // Each start once, under the session id the master picked: seven different ones.
  assert.equal(new Set([...started(one.box), ...started(two.box), ...started(pair.master.box)]).size, 7)
  // The nodes cloned the repository under their work folder, by its address.
  assert.ok(existsSync(join(one.box.dir, 'example.test', 'acme', 'atlas', 'README.md')))
  // One card a start: a start sent to a node shows as the node's own launch, the master's own card gone.
  const cards = await launchesOf(pair.master.url)
  assert.equal(cards.filter(l => ids.includes(l.id) && l.place?.device).length, 0)
  await settled(pair.master.url)
  assert.deepEqual([started(one.box).length, started(two.box).length, started(pair.master.box).length], [3, 3, 1])
}, 90_000)

test('a node that is behind gets the profile before the start, the card saying so; the next start sends no file (#584)', async () => {
  const pair = await placing({ count: 1, nodes: { order: ['server-1', 'local'] } })
  const node = pair.nodes[0] as Pair['nodes'][0]
  // A skill the owner just added on this computer.
  const skill = ['skills', 'atlas', 'SKILL.md']
  const mine = join(pair.master.box.env.HOME ?? '', '.claude', ...skill)
  mkdirSync(dirname(mine), { recursive: true })
  writeFileSync(mine, 'the atlas skill')
  // The node's answer to the bundle's first question is held: the start waits on the sync.
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  node.proxy.intercept = async (method, path, forward) => {
    if (method !== 'GET' || path !== '/api/node/bundle/default') return null
    node.proxy.intercept = null
    await held
    return forward()
  }
  const id = await startAt(pair.master.url, pair.checkout, 'atlas 1')
  const syncing = await launchWhere(pair.master.url, id, l => l?.step === 'syncing')
  assert.deepEqual([syncing?.state, syncing?.place?.device], ['starting', 'server-1'])
  assert.deepEqual(started(node.box), [])
  release()
  await until(() => started(node.box).length === 1, 20_000)
  assert.equal(readFileSync(join(node.box.env.HOME ?? '', '.claude', ...skill), 'utf8'), 'the atlas skill')
  const asked = node.proxy.requests
  const commit = asked.indexOf('POST /api/node/bundle/default/commit')
  assert.ok(commit >= 0 && commit < asked.indexOf('POST /api/node/launch'), JSON.stringify(asked))
  // Current now: the next start asks once and sends nothing.
  const before = asked.length
  await startAt(pair.master.url, pair.checkout, 'atlas 2')
  await until(() => started(node.box).length === 2, 20_000)
  assert.deepEqual(
    asked.slice(before).filter(r => r.includes('/api/node/bundle/')),
    ['GET /api/node/bundle/default'],
  )
  await settled(pair.master.url)
}, 60_000)

test('Without nodes a start runs here as before: no placing or syncing step, no nodes folder, no identity asked of git (#584, #611)', async () => {
  const { checkout } = repos()
  git(checkout, 'config', 'user.email', 'atlas@example.test')
  const trace = join(mkdtempSync(join(tmpdir(), 'placer-trace-')), 'git.trace')
  scratch.push(dirname(trace))
  const box = await sandbox()
  login(box)
  box.state(startable())
  const board = await serveBoard(box, { language: 'en', categories: LANES }, { ...PAIR_ENV, PATH, GIT_TRACE: trace })
  board.proc.send('refresh')
  await fresh(board.url)
  const id = await startAt(board.url, checkout, 'atlas 1')
  const steps = new Set<string>()
  let l: Launch | undefined
  for (const end = Date.now() + 15_000; Date.now() < end; await Bun.sleep(20)) {
    l = (await launchesOf(board.url)).find(x => x.id === id)
    if (l) steps.add(l.step)
    if (!l || l.state === 'done' || l.state === 'failed') break
  }
  assert.equal(started(box).length, 1)
  assert.equal(steps.has('syncing') || steps.has('placing'), false, [...steps].join(','))
  assert.equal(l?.place, undefined)
  assert.equal(existsSync(join(stateFolder(box), 'nodes')), false)
  // The test of #611 below shows the trace sees the board's git; here nothing asked it for an identity.
  assert.deepEqual(identityAsked(trace), [])
  board.proc.kill()
  await board.proc.exited
}, 60_000)

/** A start body as the master sends it to a node's door (6.4), with a folder of that node. */
const nodeStart = (id: string, cwd: string) => ({
  id,
  name: 'atlas 1',
  category: 'atlas',
  profile: 'default',
  agent: 'claude',
  model: '',
  message: '',
  workspace: 'atlas',
  source: { kind: 'path', cwd, worktree: null },
})

test('a device revoked takes no start from that instant: one asked while the node is still being told goes to the next (#510)', async () => {
  const pair = await placing({ nodes: { order: ['server-1', 'server-2', 'local'], whenFull: 'wait' }, disk: true })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  // The node's answer to leave is held: the start below is asked before the node was told.
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  one.proxy.intercept = async (method, path, forward) => {
    if (method !== 'POST' || path !== '/api/node/leave') return null
    await held
    return forward()
  }
  const revoking = post(pair.master.url, '/api/nodes', { op: 'revoke', id: 'server-1', sleep: false })
  await until(() => one.proxy.requests.includes('POST /api/node/leave'), 10_000)
  await startAt(pair.master.url, pair.checkout, 'atlas 1')
  await until(() => started(two.box).length === 1, 20_000)
  assert.deepEqual(started(one.box), [])
  assert.ok(!one.proxy.requests.includes('POST /api/node/launch'))
  release()
  const res = await revoking
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, told: true, kept: false, sessions: { slept: 0, kept: 0 } })
  await settled(pair.master.url)
  assert.deepEqual(started(one.box), [])
}, 60_000)

test('the same id posted twice to a node’s door is one session there', async () => {
  const pair = await placing({ count: 1 })
  const node = pair.nodes[0] as Pair['nodes'][0]
  const id = '5d0c6a1e-1111-4222-8333-444455556666'
  const send = () =>
    fetch(`http://127.0.0.1:${node.proxy.port}/api/node/launch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${node.token}`, 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify(nodeStart(id, node.box.dir)),
    })
  const [a, b] = await Promise.all([send(), send()])
  assert.deepEqual([a.status, b.status], [202, 202])
  assert.deepEqual(((await a.json()) as { launch: { id: string } }).launch.id, id)
  await b.text()
  assert.equal((await send()).status, 202)
  await until(() => started(node.box).length >= 1, 10_000)
  await settled(pair.master.url)
  assert.deepEqual(started(node.box), [id])
  // Without the master's token the door takes nothing.
  const anon = await fetch(`http://127.0.0.1:${node.proxy.port}/api/node/launch`, {
    method: 'POST',
    headers: { 'x-board': '1', 'content-type': 'application/json' },
    body: JSON.stringify(nodeStart('5d0c6a1e-1111-4222-8333-000000000001', node.box.dir)),
  })
  assert.equal(anon.status, 401)
}, 60_000)

test('a node that answers full sends the start to the next device; its card says who turned it away', async () => {
  const pair = await placing({ nodes: { order: ['server-1', 'server-2', 'local'], whenFull: 'wait' } })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  one.proxy.intercept = async (method, path) =>
    method === 'POST' && path === '/api/node/launch'
      ? new Response(JSON.stringify({ error: 'full' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      : null
  const id = await startAt(pair.master.url, pair.checkout, 'atlas 1')
  await until(() => started(two.box).length === 1, 20_000)
  assert.deepEqual(started(one.box), [])
  assert.ok(one.proxy.requests.includes('POST /api/node/launch'))
  await settled(pair.master.url)
  assert.equal(started(pair.master.box).length, 0)
  void id
}, 60_000)

test('a node that drops before it answers puts the start back in the queue; it goes there once the node is back', async () => {
  const pair = await placing({
    count: 1,
    nodes: { order: ['server-1', 'local'], whenFull: 'wait', devices: { local: { maxSessions: 1, ...ROOM } } },
    masterPanes: box => [awake('s-here', box.dir)],
  })
  const node = pair.nodes[0] as Pair['nodes'][0]
  node.proxy.intercept = async (method, path) => {
    if (method !== 'POST' || path !== '/api/node/launch') return null
    node.proxy.intercept = null
    await node.proxy.cut('drop')
    return new Response('', { status: 502 })
  }
  const id = await startAt(pair.master.url, pair.checkout, 'atlas 1')
  const queued = await launchWhere(pair.master.url, id, l => l?.state === 'queued')
  assert.deepEqual(queued?.place?.wait, { device: 'server-1', kind: 'offline' })
  assert.deepEqual(started(node.box), [])
  // Nothing else takes it meanwhile: this computer is full and the owner chose to wait.
  assert.equal(started(pair.master.box).length, 0)
  node.proxy.restore()
  await until(() => started(node.box).length === 1, 20_000)
  await settled(pair.master.url)
  assert.equal(started(pair.master.box).length, 0)
}, 60_000)

test('a start a node acknowledged is the node’s: a lost answer is sent again with the same id, never started twice or elsewhere', async () => {
  const pair = await placing({ nodes: { order: ['server-1', 'server-2', 'local'], whenFull: 'wait' } })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  let lost = 0
  one.proxy.intercept = async (method, path, forward) => {
    if (method !== 'POST' || path !== '/api/node/launch' || lost) return null
    lost++
    // The node takes it; its answer is lost on the way back.
    await (await forward()).text()
    return new Response('', { status: 502 })
  }
  await startAt(pair.master.url, pair.checkout, 'atlas 1')
  await until(() => one.proxy.requests.filter(r => r === 'POST /api/node/launch').length >= 2, 20_000)
  await settled(pair.master.url)
  assert.equal(started(one.box).length, 1)
  assert.deepEqual(started(two.box), [])
  // Then the node goes away: the start stays its, nothing starts it anywhere else.
  await one.proxy.cut('drop')
  await Bun.sleep(1500)
  assert.deepEqual(started(two.box), [])
  assert.equal(started(pair.master.box).length, 0)
}, 60_000)

/** A node session asleep: its pane gone from herdr, wake's file holding it, as herdr-wake leaves it. */
function sleepOn(node: Pair['nodes'][0], id: string): void {
  node.box.state(startable([]))
  const state = join(stateFolder(node.box))
  mkdirSync(state, { recursive: true })
  const at = Date.now()
  writeFileSync(
    join(state, 'wake-sessions.json'),
    JSON.stringify({ p1: { session: id, name: 'Asleep', cwd: node.box.dir, seen_at: at, slept_at: at } }),
  )
  node.proc.send('refresh')
}

test('a start waits when every device is full, and goes once a node’s session goes to sleep', async () => {
  const pair = await placing({
    count: 1,
    nodes: { order: ['server-1', 'local'], whenFull: 'wait', devices: { local: { maxSessions: 1, ...ROOM } } },
    device: () => ({ maxSessions: 1 }),
    nodePanes: (_id, box) => [awake('s-node', box.dir)],
    masterPanes: box => [awake('s-here', box.dir)],
  })
  const node = pair.nodes[0] as Pair['nodes'][0]
  const id = await startAt(pair.master.url, pair.checkout, 'atlas 1')
  const queued = await launchWhere(pair.master.url, id, l => l?.state === 'queued')
  assert.deepEqual(queued?.place?.wait, { device: 'server-1', kind: 'sessions', busy: 1, max: 1 })
  await Bun.sleep(1000)
  assert.deepEqual(started(node.box), [])
  sleepOn(node, 's-node')
  await until(() => started(node.box).length === 1, 20_000)
  await settled(pair.master.url)
}, 60_000)

test('the queue is there after the master starts again, and Cancel takes a start out of it', async () => {
  const pair = await placing({
    count: 1,
    nodes: { order: ['server-1', 'local'], whenFull: 'wait', devices: { local: { maxSessions: 1, ...ROOM } } },
    device: () => ({ maxSessions: 1 }),
    nodePanes: (_id, box) => [awake('s-node', box.dir)],
    masterPanes: box => [awake('s-here', box.dir)],
  })
  const node = pair.nodes[0] as Pair['nodes'][0]
  const a = await startAt(pair.master.url, pair.checkout, 'atlas 1')
  const b = await startAt(pair.master.url, pair.checkout, 'atlas 2')
  await launchWhere(pair.master.url, b, l => l?.state === 'queued')
  await launchWhere(pair.master.url, a, l => l?.state === 'queued')
  const file = join(stateFolder(pair.master.box), 'nodes', 'queue.json')
  const entries = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { entries: { id: string; master: string }[] }).entries
  assert.deepEqual(
    entries().map(e => [e.id, e.master]),
    [
      [a, 'laptop'],
      [b, 'laptop'],
    ],
  )
  // The master stops and starts again: both starts are its cards again, still waiting.
  pair.master.proc.kill()
  await pair.master.proc.exited
  const again = await serveBoard(pair.master.box, pair.masterConfig, pair.env)
  again.proc.send('refresh')
  await fresh(again.url)
  const back = await launchWhere(again.url, a, l => l?.state === 'queued', 20_000)
  assert.equal(back?.place?.wait !== undefined, true)
  await launchWhere(again.url, b, l => l?.state === 'queued')
  // Cancel: out of the board and out of the file.
  assert.equal((await post(again.url, `/api/launch/${a}/dismiss`, {})).status, 200)
  assert.equal(
    (await launchesOf(again.url)).some(l => l.id === a),
    false,
  )
  assert.deepEqual(
    entries().map(e => e.id),
    [b],
  )
  // Room on the node: the one left goes there, the cancelled one never does.
  sleepOn(node, 's-node')
  await until(() => started(node.box).length === 1, 20_000)
  await settled(again.url)
  assert.deepEqual(entries(), [])
  again.proc.kill()
  await again.proc.exited
}, 90_000)

test('the thresholds config.json does not set are written once from each device’s first status; a file that does not parse is left alone', async () => {
  const onDisk = (box: Sandbox) =>
    join(box.env.APPDATA ?? '', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  let written = ''
  const pair = await nodePair({
    count: 1,
    env: { ...PAIR_ENV },
    panes: (_id, box) => {
      login(box)
      return []
    },
    masterSetup: box => {
      login(box)
      mkdirSync(dirname(onDisk(box)), { recursive: true })
      written = JSON.stringify({
        language: 'en',
        nodes: {
          id: 'laptop',
          devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:1' }, maxLoad: null } },
        },
      })
      writeFileSync(onDisk(box), written)
    },
  })
  await pair.waitDevice('server-1', d => d.link?.state === 'online' && !!d.status, 15_000)
  const read = () =>
    JSON.parse(readFileSync(onDisk(pair.master.box), 'utf8')) as {
      nodes: { devices: Record<string, Record<string, unknown>> }
    }
  await until(
    () => read().nodes.devices['server-1']?.maxSessions !== undefined && read().nodes.devices.local !== undefined,
    10_000,
  )
  const { nodes } = read()
  const node = nodes.devices['server-1'] ?? {}
  expect(Number.isInteger(node.maxSessions) && (node.maxSessions as number) >= 1).toBe(true)
  expect(Number.isInteger(node.minFreeMemMb) && (node.minFreeMemMb as number) >= 1024).toBe(true)
  // What the owner wrote stays: null is no limit, not a gap to fill.
  expect(node.maxLoad).toBeNull()
  expect(Object.keys(nodes.devices.local ?? {}).sort()).toEqual(['maxLoad', 'maxSessions', 'minFreeMemMb'])
  expect(node.link).toEqual({ kind: 'direct', url: 'http://127.0.0.1:1' })

  // A config.json that does not parse is never replaced (#167).
  const bad = await nodePair({
    count: 1,
    env: { ...PAIR_ENV },
    panes: (_id, box) => {
      login(box)
      return []
    },
    masterSetup: box => {
      login(box)
      mkdirSync(dirname(onDisk(box)), { recursive: true })
      writeFileSync(onDisk(box), '{ "nodes": { ,')
    },
  })
  await bad.waitDevice('server-1', d => d.link?.state === 'online' && !!d.status, 15_000)
  await Bun.sleep(1000)
  expect(readFileSync(onDisk(bad.master.box), 'utf8')).toBe('{ "nodes": { ,')
}, 60_000)

test('a start stays here when its lane may not leave or its branch has a name a node does not take, logged in by a folder or not', async () => {
  for (const [what, branch, category] of [
    ['lane', '', 'other'],
    ['name', 'fix+one', 'atlas'],
  ] as const) {
    const pair = await placing({
      count: 1,
      branch,
      masterLogin: false,
      nodes: { order: ['server-1', 'local'], whenFull: 'wait', devices: { local: { maxSessions: 3, ...ROOM } } },
    })
    const node = pair.nodes[0] as Pair['nodes'][0]
    const id = await startAt(pair.master.url, pair.checkout, `atlas ${what}`, { category })
    const l = await launchWhere(pair.master.url, id, x => x?.state === 'done' || x?.state === 'failed')
    assert.equal(l?.state, 'done', JSON.stringify(l))
    assert.deepEqual(l?.place?.home, what === 'lane' ? { kind: 'lane' } : { kind: 'name', name: 'fix+one' })
    assert.equal(started(pair.master.box).length, 1, what)
    assert.deepEqual(started(node.box), [], what)
    assert.equal(node.proxy.requests.includes('POST /api/node/launch'), false, what)
    await settled(pair.master.url)
  }
}, 90_000)

/** The identity git was asked for, by a board's GIT_TRACE file: `git config --get user.name` and `user.email`. */
const identityAsked = (trace: string): string[] =>
  (existsSync(trace) ? readFileSync(trace, 'utf8') : '').match(/config --get user\.(name|email)/g) ?? []

test('a start placed on a node commits there as in the master’s checkout: the clone answers the same user.email (#611)', async () => {
  const trace = join(mkdtempSync(join(tmpdir(), 'placer-trace-')), 'git.trace')
  scratch.push(dirname(trace))
  const pair = await placing({ count: 1, nodes: { order: ['server-1', 'local'] }, masterEnv: { GIT_TRACE: trace } })
  const node = pair.nodes[0] as Pair['nodes'][0]
  // The checkout's own author, as an owner with one identity per repository keeps it.
  git(pair.checkout, 'config', 'user.name', 'Атлас Author %s')
  git(pair.checkout, 'config', 'user.email', 'atlas@example.test')
  await startAt(pair.master.url, pair.checkout, 'atlas 1')
  await until(() => started(node.box).length === 1, 20_000)
  // git in the node's clone as a session there runs it: the node's home, its global config.
  const home = node.box.env.HOME ?? ''
  const there = (...args: string[]): string =>
    execFileSync(GIT, ['-C', join(node.box.dir, 'example.test', 'acme', 'atlas'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim()
  assert.equal(there('config', 'user.email'), 'atlas@example.test')
  assert.equal(there('config', 'user.name'), 'Атлас Author %s')
  // Never the node's global config.
  assert.equal(existsSync(join(home, '.gitconfig')), false)
  // The master asked its checkout once for each.
  assert.deepEqual(identityAsked(trace).sort(), ['config --get user.email', 'config --get user.name'])
  await settled(pair.master.url)
}, 60_000)

// ---------------------------------------------------------------- spawn-agent through the placer (#505, T9)

const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')

/**
 * spawn-agent as an agent runs it beside the master: the master's herdr and home, a config.json of
 * its own with the master's port and `nodes` (the master's on-disk one names no port), no caller.
 */
async function agentSpawn(pair: Pair, args: string[]) {
  const appData = mkdtempSync(join(tmpdir(), 'placer-agent-'))
  scratch.push(appData)
  const dir = join(appData, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  const port = Number(new URL(pair.master.url).port)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port, nodes: { lanes: 'all' } }))
  const proc = Bun.spawn([process.execPath, SPAWN, ...args], {
    cwd: root,
    env: {
      ...pair.master.box.env,
      APPDATA: appData,
      BOARD_TEST_PACE: '0.02',
      HERDR_WORKSPACE_ID: 'wA',
      CLAUDE_CODE_SESSION_ID: '',
      HERDR_PANE_ID: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout: stdout.trim(), stderr }
}

test('spawn-agent with nodes and the board up: the start is the board’s, it runs on the node, and the line names the device', async () => {
  const pair = await placing({ count: 1, nodes: { order: ['server-1', 'local'], lanes: 'all' } })
  const node = pair.nodes[0] as Pair['nodes'][0]
  const run = agentSpawn(pair, ['--name', 'atlas 1', '--cwd', pair.checkout, '--brief', 'Go.', '--timeout-sec', '30'])
  // The node's herdr starts it; once it shows the session the master's payload carries it.
  await until(() => started(node.box).length === 1, 20_000)
  const sid = started(node.box)[0] ?? ''
  node.box.state(
    startable([
      {
        pane_id: 'wA:p9',
        agent: 'claude',
        agent_session: { value: sid },
        agent_status: 'idle',
        cwd: node.box.dir,
        workspace_id: 'wA',
      },
    ]),
  )
  node.proc.send('refresh')
  const r = await run
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, `pane=@server-1:wA:p9 name=atlas 1 agent=@server-1:${sid} device=server-1 session=${sid}`)
  // This computer's herdr started nothing.
  assert.deepEqual(started(pair.master.box), [])
  await settled(pair.master.url)
}, 60_000)

test('an agent’s start waits when every device is full, where a person’s comes here (whenFull local)', async () => {
  const pair = await placing({
    count: 1,
    nodes: {
      order: ['server-1', 'local'],
      lanes: 'all',
      whenFull: 'local',
      devices: { local: { maxSessions: 1, ...ROOM } },
    },
    device: () => ({ maxSessions: 1 }),
    nodePanes: (_id, box) => [awake('s-node', box.dir)],
    masterPanes: box => [awake('s-here', box.dir)],
  })
  const node = pair.nodes[0] as Pair['nodes'][0]
  const agent = await agentSpawn(pair, ['--name', 'atlas 1', '--cwd', pair.checkout, '--timeout-sec', '20'])
  assert.equal(agent.code, 0, agent.stderr)
  assert.match(agent.stdout, /^queued=[\w-]+ name=atlas 1 waiting=server-1:sessions$/)
  const id = agent.stdout.slice('queued='.length).split(' ')[0] ?? ''
  const queued = await launchWhere(pair.master.url, id, l => l?.state === 'queued')
  assert.deepEqual(queued?.place?.wait, { device: 'server-1', kind: 'sessions', busy: 1, max: 1 })
  assert.deepEqual(started(pair.master.box), [])
  // A person's start from the New session window, same folder, same board: here, full or not.
  const person = await startAt(pair.master.url, pair.checkout, 'atlas 2', { category: 'other' })
  await launchWhere(pair.master.url, person, l => l?.state === 'done' || l === undefined, 20_000)
  assert.equal(started(pair.master.box).length, 1)
  assert.deepEqual(started(node.box), [])
  // A body's byHand other than false is a person's start too.
  const truthy = await startAt(pair.master.url, pair.checkout, 'atlas 3', { category: 'other', byHand: 'no' })
  await launchWhere(pair.master.url, truthy, l => l?.state === 'done' || l === undefined, 20_000)
  assert.equal(started(pair.master.box).length, 2)
  assert.equal((await post(pair.master.url, `/api/launch/${id}/dismiss`, {})).status, 200)
  await settled(pair.master.url)
}, 60_000)

test('a refused start with this computer draining explains why the task could not leave first, then succeeds once fixed (#600)', async () => {
  const pair = await placing({
    count: 1,
    nodes: {
      order: ['server-1', 'local'],
      lanes: 'all',
      devices: { local: { drain: true, maxSessions: 3, ...ROOM } },
    },
  })
  const node = pair.nodes[0] as Pair['nodes'][0]
  const briefDir = mkdtempSync(join(tmpdir(), 'placer-brief-'))
  scratch.push(briefDir)
  const localFile = join(briefDir, 'notes.md')
  writeFileSync(localFile, 'local notes\n')

  // Unpushed commit and a local file in the brief: refused naming unpushed first, then draining.
  writeFileSync(join(pair.checkout, 'README.md'), 'atlas v2\n')
  git(pair.checkout, 'add', 'README.md')
  git(pair.checkout, 'commit', '--quiet', '-m', 'two')

  const first = await agentSpawn(pair, [
    '--name',
    'atlas 1',
    '--cwd',
    pair.checkout,
    '--brief',
    `Read ${localFile} first.`,
    '--timeout-sec',
    '20',
  ])
  assert.equal(first.code, 1)
  assert.equal(
    first.stderr.trim(),
    'spawn-agent: Cannot leave laptop (the branch is not at its remote branch), and laptop is draining. Push the branch.',
  )
  const cards = await launchesOf(pair.master.url)
  const failedCard = cards.find(l => l.state === 'failed')
  assert.deepEqual(failedCard?.place, {
    refuse: { kind: 'unfit', devices: [{ device: 'local', kind: 'draining' }], home: { kind: 'unpushed' } },
  })
  assert.deepEqual(started(node.box), [])
  assert.deepEqual(started(pair.master.box), [])

  // Push the branch, keep the local path in the brief: refused naming the local path.
  git(
    pair.checkout,
    '-c',
    `url.${pair.bare.replace(/\\/g, '/')}.insteadOf=${ADDRESS}`,
    'push',
    '--quiet',
    'origin',
    'HEAD',
  )
  const second = await agentSpawn(pair, [
    '--name',
    'atlas 2',
    '--cwd',
    pair.checkout,
    '--brief',
    `Read ${localFile} first.`,
    '--timeout-sec',
    '20',
  ])
  assert.equal(second.code, 1)
  assert.equal(
    second.stderr.trim(),
    `spawn-agent: Cannot leave laptop (the first message names ${localFile}, which is on this computer), and laptop is draining. Drop the path from the first message.`,
  )

  // Drop the local path from the brief: the start goes to server-1 at once.
  const thirdRun = agentSpawn(pair, [
    '--name',
    'atlas 3',
    '--cwd',
    pair.checkout,
    '--brief',
    'Go.',
    '--timeout-sec',
    '30',
  ])
  await until(() => started(node.box).length === 1, 20_000)
  const sid = started(node.box)[0] ?? ''
  node.box.state(
    startable([
      {
        pane_id: 'wA:p9',
        agent: 'claude',
        agent_session: { value: sid },
        agent_status: 'idle',
        cwd: node.box.dir,
        workspace_id: 'wA',
      },
    ]),
  )
  node.proc.send('refresh')
  const third = await thirdRun
  assert.equal(third.code, 0, third.stderr)
  assert.equal(third.stdout, `pane=@server-1:wA:p9 name=atlas 3 agent=@server-1:${sid} device=server-1 session=${sid}`)
  assert.deepEqual(started(pair.master.box), [])
  await settled(pair.master.url)
}, 60_000)

test('a start syncing its profile survives a master restart and keeps its session id (#588)', async () => {
  const pair = await placing({
    count: 2,
    nodes: { order: ['server-1', 'server-2', 'local'], whenFull: 'local' },
  })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  const skill = ['skills', 'atlas', 'SKILL.md']
  const mine = join(pair.master.box.env.HOME ?? '', '.claude', ...skill)
  mkdirSync(dirname(mine), { recursive: true })
  writeFileSync(mine, 'the atlas skill')
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  one.proxy.intercept = async (method, path, forward) => {
    if (method !== 'GET' || path !== '/api/node/bundle/default') return null
    one.proxy.intercept = null
    await held
    return forward()
  }
  const id = await startAt(pair.master.url, pair.checkout, 'atlas %s тест')
  await launchWhere(pair.master.url, id, l => l?.step === 'syncing')
  const file = join(stateFolder(pair.master.box), 'nodes', 'queue.json')
  const entries = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { entries: { id: string; session: string; syncing?: string }[] }).entries
  assert.equal(entries().length, 1)
  const saved = entries()[0]
  assert.equal(saved?.id, id)
  assert.equal(saved?.syncing, 'server-1')

  // Master stops mid-sync and comes back: the start finishes on server-1 with the same session id.
  pair.master.proc.kill()
  await pair.master.proc.exited
  release()
  const again = await serveBoard(pair.master.box, pair.masterConfig, pair.env)
  again.proc.send('refresh')
  await fresh(again.url)
  await until(() => started(one.box).length === 1, 20_000)
  assert.deepEqual(started(one.box), [saved?.session ?? ''])
  assert.deepEqual(started(two.box), [])
  assert.deepEqual(started(pair.master.box), [])
  await until(() => entries().length === 0, 10_000)
  await settled(again.url)
  again.proc.kill()
  await again.proc.exited
}, 90_000)

test('a start sent to a node before its 202 arrives survives a master restart and never starts twice or elsewhere (#588)', async () => {
  const pair = await placing({
    count: 2,
    nodes: { order: ['server-1', 'server-2', 'local'], whenFull: 'local' },
  })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let forwarded = false
  one.proxy.intercept = async (method, path, forward) => {
    if (method !== 'POST' || path !== '/api/node/launch') return null
    one.proxy.intercept = null
    const res = await forward()
    await res.text()
    forwarded = true
    await held
    return new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  }
  const id = await startAt(pair.master.url, pair.checkout, 'atlas 1')
  await until(() => forwarded, 20_000)
  const file = join(stateFolder(pair.master.box), 'nodes', 'queue.json')
  const entries = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { entries: { id: string; session: string; sent?: string }[] }).entries
  assert.equal(entries().length, 1)
  const saved = entries()[0]
  assert.equal(saved?.id, id)
  assert.equal(saved?.sent, 'server-1')

  // Master restarts before seeing 202: server-2 and local are free, yet only server-1 takes it once.
  pair.master.proc.kill()
  await pair.master.proc.exited
  release()
  const again = await serveBoard(pair.master.box, pair.masterConfig, pair.env)
  again.proc.send('refresh')
  await fresh(again.url)
  await until(() => entries().length === 0, 20_000)
  await settled(again.url)
  assert.deepEqual(started(one.box), [saved?.session ?? ''])
  assert.deepEqual(started(two.box), [])
  assert.deepEqual(started(pair.master.box), [])
  again.proc.kill()
  await again.proc.exited
}, 90_000)

test('a start held on its way to a node retries there on master restart and starts once (#588)', async () => {
  const pair = await placing({
    count: 2,
    nodes: { order: ['server-1', 'server-2', 'local'], whenFull: 'local' },
  })
  const [one, two] = pair.nodes as [Pair['nodes'][0], Pair['nodes'][0]]
  let release = (): void => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let sawPost = false
  one.proxy.intercept = async (method, path, forward) => {
    if (method !== 'POST' || path !== '/api/node/launch') return null
    one.proxy.intercept = null
    sawPost = true
    await held
    return forward()
  }
  const id = await startAt(pair.master.url, pair.checkout, 'atlas 2')
  await until(() => sawPost, 20_000)
  const file = join(stateFolder(pair.master.box), 'nodes', 'queue.json')
  const entries = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { entries: { id: string; session: string; sent?: string }[] }).entries
  const saved = entries()[0]
  assert.equal(saved?.id, id)
  assert.equal(saved?.sent, 'server-1')

  // Master restarts before the node ever got the POST: the new master sends it to server-1 with the same id.
  pair.master.proc.kill()
  await pair.master.proc.exited
  release()
  const again = await serveBoard(pair.master.box, pair.masterConfig, pair.env)
  again.proc.send('refresh')
  await fresh(again.url)
  await until(() => started(one.box).length === 1 && entries().length === 0, 20_000)
  await settled(again.url)
  assert.deepEqual(started(one.box), [saved?.session ?? ''])
  assert.deepEqual(started(two.box), [])
  assert.deepEqual(started(pair.master.box), [])
  again.proc.kill()
  await again.proc.exited
}, 90_000)
