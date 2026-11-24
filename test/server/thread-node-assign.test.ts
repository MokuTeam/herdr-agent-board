// Node assignment, owner-post wake/delivery, and delivery failure notices (#693):
// - On a master with `nodes`, `board thread new --to` and `set --assignee` resolve node sessions
//   by name, "Name [ref]", key or session id with `board send`'s matching and ambiguity rules, and
//   store the node-qualified key; a node session setting an assignee via uplink keeps working.
// - Owner posts wake and reach a local or node assignee (or creator when unassigned); agent posts
//   route as before.
// - Delivery failures past the wait (node offline, session gone) add a private system notice on
//   the thread for the owner.
// - Without `nodes`, `board thread` runs the exact local resolution code with zero board fetches.
import { expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type FakePane, nodePair, PAIR_ENV, type PairNode } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { SCREEN } from '../support/sleeper-fixtures.ts'

const ENV = { ...PAIR_ENV }
const BEN = '11111111-1111-4111-8111-111111111111'
const ANNA = '22222222-2222-4222-8222-222222222222'
const ANNA_LOCAL = '33333333-3333-4333-8333-333333333333'
const CLEO = '44444444-4444-4444-8444-444444444444'
const DAN = '55555555-5555-4555-8555-555555555555'
const PANELESS = '66666666-6666-4666-8666-666666666666'

function writeConfig(box: Sandbox, cfg: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
}

const portOf = (url: string): number => Number(new URL(url).port)

async function cli(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return box.run('cli', { args, env }).exited
}

function herdrOf(box: Sandbox, panes: FakePane[]): void {
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    ...Object.fromEntries(
      panes.map(p => [
        `agent get ${String(p.pane_id)}`,
        {
          result: {
            agent: p.agent
              ? {
                  pane_id: p.pane_id,
                  agent: p.agent,
                  ...(p.agent_session ? { agent_session: p.agent_session } : {}),
                  agent_status: p.agent_status ?? 'idle',
                }
              : null,
          },
        },
      ]),
    ),
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
  })
}

const prompts = (box: Sandbox, pane?: string): string[][] =>
  box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt' && (!pane || c[2] === pane))

interface ThreadApiView {
  head: {
    key: string
    lane: string
    status: string
    assignee: { kind: string; key?: string; name?: string } | null
    createdBy: { kind: string; key?: string; name?: string }
  }
  entries: { id: string; type: string; text: string; private?: boolean; author: { kind: string } }[]
}

async function thread(url: string, key: string): Promise<ThreadApiView | null> {
  const res = await fetch(`${url}/api/threads/${encodeURIComponent(key)}?full=1`)
  if (!res.ok) return null
  return (await res.json()) as ThreadApiView
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

async function boardHas(url: string, ok: (items: Record<string, unknown>[]) => boolean): Promise<void> {
  await waitFor('board item', async () => {
    const payload = (await (await fetch(`${url}/api/board`)).json()) as { items: Record<string, unknown>[] }
    return ok(payload.items)
  })
}

function seedCard(box: Sandbox, key: string, name: string, category = 'atlas'): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${key}.json`), JSON.stringify({ key, name, category }))
}

test('assign a node session by name, ref and key on a master with a node; ambiguous name refused; uplink unchanged', async () => {
  const masterPane = (key: string, name: string, paneId = 'm1'): FakePane => ({
    pane_id: paneId,
    agent: 'claude',
    agent_session: { value: key },
    agent_status: 'idle',
    terminal_title_stripped: name,
  })
  const nodePane = (box: Sandbox): FakePane[] => [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: ANNA },
      agent_status: 'idle',
      terminal_title_stripped: 'anna',
      cwd: box.dir,
    },
  ]
  const pair = await nodePair({
    env: ENV,
    masterCfg: { threads: true },
    panes: (_id, box) => nodePane(box),
    masterPanes: () => [masterPane(BEN, 'ben', 'm1')],
    masterSetup: box => seedCard(box, BEN, 'ben'),
    nodeSetup: (_id, box) => seedCard(box, ANNA, 'anna'),
  })
  const node = pair.nodes[0] as PairNode
  herdrOf(pair.master.box, [masterPane(BEN, 'ben', 'm1')])
  herdrOf(node.box, nodePane(node.box))
  writeConfig(pair.master.box, { ...pair.masterConfig, port: portOf(pair.master.url) })
  writeConfig(node.box, {
    language: 'en',
    port: portOf(node.url),
    node: { id: node.id, port: node.doorPort, workRoot: node.box.dir },
  })
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const remoteKey = `@${node.id}:${ANNA}`
  await boardHas(pair.master.url, items => items.some(i => i.key === remoteKey) && items.some(i => i.key === BEN))

  // Assign node session by name.
  const byName = await cli(pair.master.box, ['thread', 'new', '--lane', 'atlas', '--to', 'anna', 'Node task'])
  expect(byName).toEqual({ code: 0, stdout: 'ok · atlas-1 · doing · anna\n', stderr: '' })
  expect((await thread(pair.master.url, 'atlas-1'))?.head.assignee).toEqual({
    kind: 'session',
    key: remoteKey,
    name: 'anna',
  })

  // Local session unchanged.
  const local = await cli(pair.master.box, ['thread', 'new', '--lane', 'atlas', '--to', 'ben', 'Local task'])
  expect(local).toEqual({ code: 0, stdout: 'ok · atlas-2 · doing · ben\n', stderr: '' })
  expect((await thread(pair.master.url, 'atlas-2'))?.head.assignee).toEqual({
    kind: 'session',
    key: BEN,
    name: 'ben',
  })

  // Assign node session by @device:id and by bare session id.
  expect((await cli(pair.master.box, ['thread', 'set', 'atlas-1', '--assignee', remoteKey])).stdout.trim()).toBe(
    'ok · atlas-1 · doing · anna',
  )
  expect((await cli(pair.master.box, ['thread', 'set', 'atlas-1', '--assignee', ANNA])).stdout.trim()).toBe(
    'ok · atlas-1 · doing · anna',
  )
  expect((await thread(pair.master.url, 'atlas-1'))?.head.assignee?.key).toBe(remoteKey)

  // Node session running `board thread set --assignee` through the uplink keeps working.
  const viaUplink = await cli(node.box, ['thread', 'set', '--session', ANNA, 'atlas-2', '--assignee', 'ben'])
  expect(viaUplink).toEqual({ code: 0, stdout: 'ok · atlas-2 · doing · ben\n', stderr: '' })

  // Ambiguous name (local anna + node anna) is refused as `board send` refuses it, and "anna [ref]" disambiguates.
  seedCard(pair.master.box, ANNA_LOCAL, 'anna')
  herdrOf(pair.master.box, [masterPane(BEN, 'ben', 'm1'), masterPane(ANNA_LOCAL, 'anna', 'm2')])
  await boardHas(pair.master.url, items => items.some(i => i.key === ANNA_LOCAL))

  const clash = await cli(pair.master.box, ['thread', 'new', '--lane', 'atlas', '--to', 'anna', 'Ambiguous'])
  expect(clash.code).toBe(1)
  expect(clash.stderr).toContain('fits more than one session')
  expect(clash.stderr).toContain(ANNA.slice(0, 8))
  expect(clash.stderr).toContain(ANNA_LOCAL.slice(0, 8))

  const disambiguated = await cli(pair.master.box, [
    'thread',
    'new',
    '--lane',
    'atlas',
    '--to',
    `anna [${ANNA.slice(0, 8)}]`,
    'Picked node anna',
  ])
  expect(disambiguated).toEqual({ code: 0, stdout: 'ok · atlas-3 · doing · anna\n', stderr: '' })
  expect((await thread(pair.master.url, 'atlas-3'))?.head.assignee?.key).toBe(remoteKey)

  // Local paneless non-sleeping session whose pane closed still resolves by --to <name> on a master with nodes.
  const panelessProbe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return Response.json({
        ok: true,
        items: [
          {
            key: PANELESS,
            session: PANELESS,
            name: 'paneless-worker',
            pane: '',
            sleeping: false,
            status: 'idle',
            device: null,
          },
          { key: remoteKey, session: ANNA, name: 'anna', pane: 'p1', sleeping: false, status: 'idle', device: node.id },
        ],
      })
    },
  })
  onTestFinished(() => void panelessProbe.stop(true))
  const panelessBox = await sandbox()
  writeConfig(panelessBox, { ...pair.masterConfig, port: panelessProbe.port })
  const panelessAssign = await cli(panelessBox, [
    'thread',
    'new',
    '--lane',
    'atlas',
    '--to',
    'paneless-worker',
    '--json',
    'Paneless work',
  ])
  expect(panelessAssign.code).toBe(0)
  expect(JSON.parse(panelessAssign.stdout).thread.assignee).toEqual({
    kind: 'session',
    key: PANELESS,
    name: 'paneless-worker',
  })
}, 60_000)

test('owner post wakes and reaches a local sleeping assignee (or creator when unassigned); agent post routes as before', async () => {
  const box = await sandbox()
  const cwd = box.dir
  const sleepingPanes: Record<string, FakePane> = {
    p1: { pane_id: 'p1', cwd },
    p2: { pane_id: 'p2', cwd },
    p3: { pane_id: 'p3', agent: 'claude', agent_session: { value: CLEO }, agent_status: 'idle', cwd },
    p4: { pane_id: 'p4', cwd },
  }
  const awakePane = (paneId: string, session: string, name: string): FakePane => ({
    pane_id: paneId,
    cwd,
    agent: 'claude',
    agent_session: { value: session },
    agent_status: 'idle',
    terminal_title_stripped: name,
  })
  const currentPanes: Record<string, FakePane> = { ...sleepingPanes }
  const syncHerdr = () => herdrOf(box, Object.values(currentPanes))
  syncHerdr()
  seedCard(box, ANNA, 'anna')
  seedCard(box, BEN, 'ben')
  seedCard(box, CLEO, 'cleo')
  seedCard(box, DAN, 'dan')

  const wake = await fakeWake({
    sleeping: [
      { pane: 'p1', session: ANNA, name: 'anna', cwd },
      { pane: 'p2', session: BEN, name: 'ben', cwd },
      { pane: 'p4', session: DAN, name: 'dan', cwd },
    ],
    wake: target => {
      const t = typeof target === 'string' ? target : ''
      if (t === ANNA || t === 'p1') {
        currentPanes.p1 = awakePane('p1', ANNA, 'anna')
        wake.sleeping = wake.sleeping.filter(s => (s as { session?: string }).session !== ANNA)
        syncHerdr()
      } else if (t === BEN || t === 'p2') {
        currentPanes.p2 = awakePane('p2', BEN, 'ben')
        wake.sleeping = wake.sleeping.filter(s => (s as { session?: string }).session !== BEN)
        syncHerdr()
      } else if (t === DAN || t === 'p4') {
        currentPanes.p4 = awakePane('p4', DAN, 'dan')
        wake.sleeping = wake.sleeping.filter(s => (s as { session?: string }).session !== DAN)
        syncHerdr()
      }
      return { ok: true }
    },
  })
  const { url } = await serveBoard(box, { language: 'en', threads: true, wakeUrl: wake.url, scheduleTickSec: 0.2 }, ENV)
  writeConfig(box, { language: 'en', port: portOf(url), threads: true, wakeUrl: wake.url })
  await boardHas(
    url,
    items => items.some(i => i.key === ANNA) && items.some(i => i.key === BEN) && items.some(i => i.key === DAN),
  )

  const postApi = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    return res.json()
  }

  // Thread 1: created by ben, assigned to anna (sleeping), and anna also explicitly watches it (--what all).
  await postApi('/api/threads', { op: 'new', lane: 'atlas', title: 'Assigned work', to: { key: ANNA, name: 'anna' } })
  expect((await cli(box, ['thread', 'watch', '--session', ANNA, 'atlas-1', '--what', 'all'])).code).toBe(0)
  // Thread 2: created by ben (sleeping), no assignee.
  expect((await cli(box, ['thread', 'new', '--session', BEN, 'Creator work'])).code).toBe(0)
  // Thread 3: created by ben (sleeping), assigned to cleo (awake).
  await postApi('/api/threads', { op: 'new', lane: 'atlas', title: 'Agent work', to: { key: CLEO, name: 'cleo' } })
  // Thread 4: assigned to dan (sleeping) to verify status-only owner posts do not wake sleepers.
  await postApi('/api/threads', { op: 'new', lane: 'atlas', title: 'Status work', to: { key: DAN, name: 'dan' } })

  // Agent post by cleo on a thread created by ben (status watch only, noWake): must NOT wake ben or anna.
  expect((await cli(box, ['thread', 'post', '--session', CLEO, 'atlas-2', 'note from cleo'])).code).toBe(0)
  await Bun.sleep(400)
  expect(wake.requests().filter(r => r.path === '/wake')).toEqual([])
  expect(prompts(box)).toEqual([])

  // Status-only owner post on atlas-4 must NOT wake sleeping dan.
  await postApi('/api/threads/atlas-4', { op: 'post', status: 'dropped' })
  await Bun.sleep(400)
  expect(wake.requests().some(r => r.path === '/wake' && (r.body as { target?: string })?.target === 'p4')).toBe(false)
  expect(prompts(box, 'p4')).toEqual([])

  // Owner post (> 300 chars) on atlas-1 (assigned to sleeping anna who also watches): wakes anna once,
  // sends the full text without cutting at 160 chars, and delivers exactly one message.
  const longNote = `check row 5: ${'y'.repeat(320)} FULL_TAIL`
  await postApi('/api/threads/atlas-1', { op: 'post', text: longNote })
  await until(() => prompts(box, 'p1').some(c => (c[3] ?? '').includes('FULL_TAIL')), 15_000)
  await Bun.sleep(400)
  expect(prompts(box, 'p1')).toHaveLength(1)
  expect(wake.requests().some(r => r.path === '/wake' && (r.body as { target?: string })?.target === 'p1')).toBe(true)

  // Owner post on atlas-2 (no assignee, created by sleeping ben): wakes ben and delivers the post.
  await postApi('/api/threads/atlas-2', { op: 'post', text: 'please take a look' })
  await until(() => prompts(box, 'p2').some(c => (c[3] ?? '').includes('please take a look')), 15_000)
  expect(wake.requests().some(r => r.path === '/wake' && (r.body as { target?: string })?.target === 'p2')).toBe(true)
  expect(prompts(box, 'p3')).toEqual([])
}, 60_000)

test('owner post wakes and reaches a sleeping node assignee through the node link', async () => {
  let nodeBox!: Sandbox
  const nodeWake = await fakeWake({
    sleeping: [{ pane: 'p1', session: ANNA, name: 'anna', cwd: '' }],
    wake: () => {
      herdrOf(nodeBox, [
        {
          pane_id: 'p1',
          cwd: nodeBox.dir,
          agent: 'claude',
          agent_session: { value: ANNA },
          agent_status: 'idle',
          terminal_title_stripped: 'anna',
        },
      ])
      nodeWake.sleeping = []
      return { ok: true }
    },
  })
  const pair = await nodePair({
    env: ENV,
    masterCfg: { threads: true, scheduleTickSec: 0.2 },
    nodeCfg: () => ({ wakeUrl: nodeWake.url }),
    panes: (_id, box) => [{ pane_id: 'p1', cwd: box.dir }],
    masterPanes: () => [],
    nodeSetup: (_id, box) => {
      nodeBox = box
      nodeWake.sleeping = [{ pane: 'p1', session: ANNA, name: 'anna', cwd: box.dir }]
      seedCard(box, ANNA, 'anna')
    },
  })
  const node = pair.nodes[0] as PairNode
  herdrOf(node.box, [{ pane_id: 'p1', cwd: node.box.dir }])
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const remoteKey = `@${node.id}:${ANNA}`
  await boardHas(pair.master.url, items => items.some(i => i.key === remoteKey && i.sleeping === true))

  const created = await fetch(`${pair.master.url}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'new', lane: 'atlas', title: 'Remote sleeper', to: { key: remoteKey, name: 'anna' } }),
  })
  expect(created.status).toBe(200)

  const posted = await fetch(`${pair.master.url}/api/threads/atlas-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'post', text: 'wake node worker' }),
  })
  expect(posted.status).toBe(200)

  await until(() => prompts(node.box, 'p1').some(c => (c[3] ?? '').includes('wake node worker')), 15_000)
  expect(nodeWake.requests().some(r => r.path === '/wake')).toBe(true)
  expect(prompts(pair.master.box)).toEqual([])

  // When the node session asks a question, the owner's answer reaches it through the node link too.
  writeConfig(node.box, {
    language: 'en',
    port: portOf(node.url),
    node: { id: node.id, port: node.doorPort, workRoot: node.box.dir },
  })
  expect((await cli(node.box, ['thread', 'ask', '--session', ANNA, 'atlas-1', 'Which row?'])).code).toBe(0)
  const answered = await fetch(`${pair.master.url}/api/threads/atlas-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'answer', text: 'Row 5 wins' }),
  })
  expect(answered.status).toBe(200)
  expect((await answered.json()) as { told: boolean }).toMatchObject({ told: true })
  await until(
    () => prompts(node.box, 'p1').some(c => (c[3] ?? '').includes('[board thread atlas-1] Row 5 wins')),
    10_000,
  )
}, 60_000)

test('offline node holds owner post once with notice then reports endRemote/gone failure; gone local session also notifies owner', async () => {
  const pair = await nodePair({
    env: ENV,
    masterCfg: { threads: true, scheduleTickSec: 0.1, scheduleWaitMin: 0.005 },
    panes: (_id, box) => [
      {
        pane_id: 'p1',
        cwd: box.dir,
        agent: 'claude',
        agent_session: { value: ANNA },
        agent_status: 'idle',
        terminal_title_stripped: 'anna',
      },
    ],
    masterPanes: () => [],
    nodeSetup: (_id, box) => seedCard(box, ANNA, 'anna'),
  })
  const node = pair.nodes[0] as PairNode
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const remoteKey = `@${node.id}:${ANNA}`
  await boardHas(pair.master.url, items => items.some(i => i.key === remoteKey))

  await fetch(`${pair.master.url}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'new', lane: 'atlas', title: 'Offline node', to: { key: remoteKey, name: 'anna' } }),
  })

  // Cut the node link and post as the owner: #695 holds the entry instead of expiring it, and
  // records a single held notice on the thread while publishing a board refresh.
  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state !== 'online', 10_000)
  const beforeRev = ((await (await fetch(`${pair.master.url}/api/board`)).json()) as { threads?: { rev: number } })
    .threads?.rev
  await fetch(`${pair.master.url}/api/threads/atlas-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'post', text: 'are you there?' }),
  })

  const heldNotice = await waitFor('held delivery notice on thread', async () => {
    const view = await thread(pair.master.url, 'atlas-1')
    return view?.entries.find(
      e =>
        e.type === 'system' &&
        e.private === true &&
        e.text.includes('Delivery to anna (on server-1) held until server-1 is back'),
    )
  })
  expect(heldNotice.author).toEqual({ kind: 'owner' })
  await Bun.sleep(400)
  const heldCount =
    (await thread(pair.master.url, 'atlas-1'))?.entries.filter(
      e => e.type === 'system' && e.text.includes('held until server-1 is back'),
    ).length ?? 0
  expect(heldCount).toBe(1)
  const afterHeldRev = ((await (await fetch(`${pair.master.url}/api/board`)).json()) as { threads?: { rev: number } })
    .threads?.rev
  expect(afterHeldRev).toBeGreaterThan(beforeRev ?? 0)

  // Node comes back with the session gone: endRemote records the failure notice on the thread.
  herdrOf(node.box, [])
  node.proxy.restore()
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const remoteGoneNotice = await waitFor('remote gone failure notice on thread', async () => {
    const view = await thread(pair.master.url, 'atlas-1')
    return view?.entries.find(
      e =>
        e.type === 'system' &&
        e.private === true &&
        e.text.includes('Not delivered to anna (on server-1): session is gone'),
    )
  })
  expect(remoteGoneNotice.author).toEqual({ kind: 'owner' })

  // A gone local session also leaves a private system notice on the thread.
  await fetch(`${pair.master.url}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'new', lane: 'atlas', title: 'Gone local', to: { key: CLEO, name: 'cleo' } }),
  })
  await fetch(`${pair.master.url}/api/threads/atlas-2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'post', text: 'ping cleo' }),
  })
  const goneNotice = await waitFor('gone session delivery failure notice on thread', async () => {
    const view = await thread(pair.master.url, 'atlas-2')
    return view?.entries.find(
      e => e.type === 'system' && e.private === true && e.text.includes('Not delivered to cleo: session is gone'),
    )
  })
  expect(goneNotice.author).toEqual({ kind: 'owner' })
}, 60_000)

test('without nodes: board thread goes down the exact local code with zero board fetches', async () => {
  const box = await sandbox()
  const fetched: string[] = []
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      fetched.push(new URL(req.url).pathname)
      return Response.json({ ok: true, items: [] })
    },
  })
  onTestFinished(() => void probe.stop(true))
  herdrOf(box, [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: ANNA },
      agent_status: 'idle',
      terminal_title_stripped: 'dup name',
    },
    {
      pane_id: 'p2',
      agent: 'claude',
      agent_session: { value: BEN },
      agent_status: 'idle',
      terminal_title_stripped: 'dup name',
    },
    {
      pane_id: 'p3',
      agent: 'claude',
      agent_session: { value: CLEO },
      agent_status: 'idle',
      terminal_title_stripped: 'anna 100% тест',
    },
    { pane_id: 'p4', agent: 'codex', agent_status: 'idle', terminal_title_stripped: 'codex worker' },
  ])
  writeConfig(box, { language: 'en', port: probe.port, threads: true })

  // Names with spaces, Cyrillic and %, and pane-id sessions keep working without asking the web board.
  const special = await cli(box, ['thread', 'new', '--lane', 'atlas', '--to', 'anna 100% тест', 'Special'])
  expect(special).toEqual({ code: 0, stdout: 'ok · atlas-1 · doing · anna 100% тест\n', stderr: '' })
  const byPane = await cli(box, ['thread', 'new', '--lane', 'atlas', '--to', 'pane-p4', 'By pane'])
  expect(byPane).toEqual({ code: 0, stdout: 'ok · atlas-2 · doing · codex worker\n', stderr: '' })

  // Ambiguous local name produces the exact old error ("names N sessions (...): give its pane").
  const dup = await cli(box, ['thread', 'new', '--lane', 'atlas', '--to', 'dup name', 'Ambiguous'])
  expect(dup.code).toBe(1)
  expect(dup.stderr).toContain('"dup name" names 2 sessions')
  expect(dup.stderr).toContain('give its pane')
  expect(fetched).toEqual([])
})
