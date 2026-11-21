// Revoke and leave (#510, docs/design/nodes 11.4, 6.2): a master and its nodes as sandbox boards
// with fake herdrs and fake wakes (test/support/node-pair.ts). The master's `POST /api/nodes`
// `{ op: 'revoke' }` marks the device in config.json, tells the node on `POST /api/node/leave` (its
// sessions put to sleep through its own wake), then deletes the device's token and link key and
// closes the link; a node cut off keeps its credentials on the master until it is back and told,
// and `forget` drops them at once. `board node leave` on the node forgets the master alone.
// Without `nodes` and `node` none of it exists.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDeviceStore, createNodeStore } from '../../src/adapters/node-store.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { nodePair, PAIR_ENV, type Pair, type PairNode } from '../support/node-pair.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(`${url}/api/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

const devicesDir = (pair: Pair): string => join(stateFolder(pair.master.box), 'nodes')
const deviceStore = (pair: Pair) => createDeviceStore({ dir: devicesDir(pair) })
const mastersOn = (node: PairNode) => createNodeStore({ dir: join(stateFolder(node.box), 'node') }).list()
const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const savedConfig = (box: Sandbox): Record<string, unknown> => JSON.parse(readFileSync(configPath(box), 'utf8'))

/**
 * config.json on the master's disk with its devices, which the revoke writes into: the board itself
 * runs on the config the test hands it, which has the links' real addresses.
 */
function masterOnDisk(box: Sandbox, count = 1): void {
  const devices = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `server-${i + 1}`,
      { link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
    ]),
  )
  mkdirSync(dirname(configPath(box)), { recursive: true })
  writeFileSync(configPath(box), JSON.stringify({ language: 'en', nodes: { id: 'laptop', devices } }))
}

/** The node's one session awake and idle, with nothing typed: its board may put it to sleep. */
function sleepable(node: PairNode): void {
  const session = `s-${node.id}`
  node.box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'p1',
              agent: 'claude',
              agent_session: { value: session },
              agent_status: 'idle',
              cwd: node.box.dir,
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent get': { result: { agent: { agent: 'claude', agent_session: { value: session }, agent_status: 'idle' } } },
    'agent read': { text: `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ? for shortcuts` },
  })
  node.proc.send('refresh')
}

/** A request to the node's door through its proxy with the master's token. */
const door = (node: PairNode, path: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${node.proxy.port}${path}`, { headers: { authorization: `Bearer ${node.token}` } })

async function waitFor(ok: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`never: ${what}`)
    await Bun.sleep(25)
  }
}

describe('revoke from the master', () => {
  test('an online node puts its sessions to sleep, forgets the master, and the master drops its token and key', async () => {
    const wake = await fakeWake()
    const pair = await nodePair({ nodeCfg: () => ({ wakeUrl: wake.url }), masterSetup: box => masterOnDisk(box) })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 15_000)
    sleepable(node)
    // A link key beside the token, as `board nodes key` leaves it.
    const store = deviceStore(pair)
    writeFileSync(store.keyPath('server-1'), 'key')
    writeFileSync(`${store.keyPath('server-1')}.pub`, 'pub')
    await waitFor(() => node.proxy.streams() >= 1, 5000, 'the payload stream is open')

    const res = await post(pair.master.url, { op: 'revoke', id: 'server-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, told: true, kept: false, sessions: { slept: 1, kept: 0 } })

    // Asked to sleep: the node's own wake put its session to sleep.
    const leave = node.proxy.received.filter(r => r.request === 'POST /api/node/leave')
    expect(leave.map(r => JSON.parse(r.body))).toEqual([{ sleep: true }])
    expect(wake.requests().filter(r => r.method === 'POST' && r.path === '/sleep').length).toBe(1)
    // The node forgot the master: its token is dead, and the stream on it ends within the paced 5 s.
    expect(mastersOn(node)).toEqual([])
    expect((await door(node, '/api/node/status')).status).toBe(401)
    await waitFor(() => node.proxy.streams() === 0, 5000, 'the stream ends')
    // The master: the device marked in config.json, its token and key gone, where it stands kept.
    const nodes = savedConfig(pair.master.box).nodes as { devices: Record<string, Record<string, unknown>> }
    expect(nodes.devices['server-1']?.revoked).toBe(true)
    expect(store.token('server-1')).toBeNull()
    expect(existsSync(store.keyPath('server-1'))).toBe(false)
    expect(existsSync(`${store.keyPath('server-1')}.pub`)).toBe(false)
    expect(store.revocation('server-1')).toMatchObject({ sleep: true, told: true })
    // Still in the devices, with its state, and no link any more.
    const view = await pair.waitDevice('server-1', d => d.link === null)
    expect(view.revoked).toEqual({ told: true, kept: false })
    // Asked again: nothing more to tell.
    const again = await post(pair.master.url, { op: 'revoke', id: 'server-1' })
    expect(await again.json()).toEqual({ ok: true, told: true, kept: false })
    expect(node.proxy.received.filter(r => r.request === 'POST /api/node/leave').length).toBe(1)
  }, 60_000)

  test('keep running, by the CLI: the node is told without a sleep; board nodes says so; a device that is not one is refused', async () => {
    const wake = await fakeWake()
    const pair = await nodePair({ nodeCfg: () => ({ wakeUrl: wake.url }), masterSetup: box => masterOnDisk(box) })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 15_000)
    expect((await post(pair.master.url, { op: 'revoke', id: 'server-9' })).status).toBe(404)
    expect((await post(pair.master.url, { op: 'revoke', id: 'local' })).status).toBe(404)
    expect((await post(pair.master.url, { op: 'revoke', id: 'server-1', sleep: 'no' })).status).toBe(400)
    // The CLI finds the running board by the port in config.json on disk.
    const onDisk = savedConfig(pair.master.box)
    writeFileSync(
      configPath(pair.master.box),
      JSON.stringify({ ...onDisk, port: Number(new URL(pair.master.url).port) }),
    )
    const cli = (args: string[]) => pair.master.box.run('cli', { args, env: { CLAUDE_CODE_SESSION_ID: '' } }).exited
    const bad = await cli(['nodes', 'revoke', 'server-1', '--now'])
    expect(bad.code).toBe(1)
    const r = await cli(['nodes', 'revoke', 'server-1', '--keep-running'])
    expect(r.stderr).toBe('')
    expect([r.code, r.stdout]).toEqual([0, 'ok · server-1 revoked: the node was told and forgot this board\n'])
    const leave = node.proxy.received.filter(x => x.request === 'POST /api/node/leave')
    expect(leave.map(x => JSON.parse(x.body))).toEqual([{ sleep: false }])
    expect(wake.requests().filter(x => x.path === '/sleep')).toEqual([])
    expect(mastersOn(node)).toEqual([])
    await pair.waitDevice('server-1', d => d.link === null)
    const listed = await cli(['nodes'])
    expect(listed.stdout).toContain('server-1 · revoked · the node was told\n')
  }, 60_000)

  test('a node that does not take leave keeps its credentials and is not called again while its link stays up', async () => {
    const pair = await nodePair({ masterSetup: box => masterOnDisk(box) })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 15_000)
    node.proxy.intercept = async (method, path) =>
      method === 'POST' && path === '/api/node/leave'
        ? new Response(JSON.stringify({ error: 'busy' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : null
    const res = await post(pair.master.url, { op: 'revoke', id: 'server-1' })
    expect(await res.json()).toEqual({ ok: true, told: false, kept: true })
    // Payloads keep coming on the open link: none of them is a new try.
    await Bun.sleep(1500)
    expect(node.proxy.requests.filter(r => r === 'POST /api/node/leave').length).toBe(1)
    expect(deviceStore(pair).token('server-1')).toBe(node.token)
    expect(mastersOn(node).length).toBe(1)
  }, 60_000)

  test('a node cut off keeps its credentials until it is back and told; forget drops them at once', async () => {
    const pair = await nodePair({ count: 2, masterSetup: box => masterOnDisk(box, 2) })
    const [one, two] = pair.nodes as [PairNode, PairNode]
    for (const n of pair.nodes) await pair.waitDevice(n.id, d => d.link?.state === 'online', 15_000)
    const store = deviceStore(pair)

    await one.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state !== 'online', 10_000)
    const res = await post(pair.master.url, { op: 'revoke', id: 'server-1' })
    expect(await res.json()).toEqual({ ok: true, told: false, kept: true })
    expect(store.token('server-1')).toBe(one.token)
    expect(store.revocation('server-1')).toMatchObject({ sleep: true, told: null })
    expect((await pair.waitDevice('server-1', d => !!d.revoked)).revoked).toEqual({ told: false, kept: true })
    expect(mastersOn(one).length).toBe(1)
    // Back: told and forgotten, the credentials gone.
    one.proxy.restore()
    await waitFor(() => store.revocation('server-1')?.told === true, 15_000, 'the node is told once it is back')
    expect(store.token('server-1')).toBeNull()
    expect(mastersOn(one)).toEqual([])
    expect(store.revocation('server-1')).toMatchObject({ told: true })
    expect((await pair.waitDevice('server-1', d => d.link === null)).revoked).toEqual({ told: true, kept: false })

    // Forget: dropped now, the node never told, and not later either.
    await two.proxy.cut('drop')
    await pair.waitDevice('server-2', d => d.link?.state !== 'online', 10_000)
    const forgot = await post(pair.master.url, { op: 'revoke', id: 'server-2', forget: true })
    expect(await forgot.json()).toEqual({ ok: true, told: false, kept: false })
    expect(store.token('server-2')).toBeNull()
    expect(store.revocation('server-2')).toMatchObject({ told: false })
    two.proxy.restore()
    await Bun.sleep(1000)
    expect(two.proxy.requests.filter(r => r === 'POST /api/node/leave')).toEqual([])
    expect(mastersOn(two).length).toBe(1)
    expect((await pair.waitDevice('server-2', d => !!d.revoked)).revoked).toEqual({ told: false, kept: false })
  }, 90_000)
})

describe('leave on the node', () => {
  test('board node leave forgets the only master: the master’s link is refused with token, and a revoke after it drops the credentials', async () => {
    // The node's config.json on its disk, which the command reads: the board runs on the test's.
    const pair = await nodePair({
      masterSetup: box => masterOnDisk(box),
      nodeSetup: (id, box) => {
        mkdirSync(dirname(configPath(box)), { recursive: true })
        writeFileSync(configPath(box), JSON.stringify({ language: 'en', wakeUrl: '', port: 9, node: { id, port: 1 } }))
      },
    })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 15_000)
    const r = await node.box.run('cli', { args: ['node', 'leave'], env: {} }).exited
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(
      /^ok · left master [0-9a-f]{12}: its token no longer opens the door and its streams end\n$/,
    )
    expect(mastersOn(node)).toEqual([])
    await pair.waitDevice('server-1', d => d.link?.state === 'refused' && d.link.reason === 'token', 10_000)
    // The node left already: nothing to tell, the token and key go at once.
    const revoked = await post(pair.master.url, { op: 'revoke', id: 'server-1' })
    expect(await revoked.json()).toEqual({ ok: true, told: true, kept: false })
    expect(deviceStore(pair).token('server-1')).toBeNull()
    expect(node.proxy.requests.filter(x => x === 'POST /api/node/leave')).toEqual([])
    // None left to leave, and a name that is none.
    const none = await node.box.run('cli', { args: ['node', 'leave'], env: {} }).exited
    expect([none.code, none.stderr]).toEqual([1, 'board: no master to leave\n'])
    const wrong = await node.box.run('cli', { args: ['node', 'leave', 'abc'], env: {} }).exited
    expect([wrong.code, wrong.stderr]).toEqual([1, 'board: no master abc: `board node` lists them\n'])
  }, 60_000)

  test('with two masters a name is needed', async () => {
    const box = await sandbox()
    mkdirSync(dirname(configPath(box)), { recursive: true })
    writeFileSync(
      configPath(box),
      JSON.stringify({ language: 'en', wakeUrl: '', port: 9, node: { id: 'server-1', port: await unusedPort() } }),
    )
    const store = createNodeStore({ dir: join(stateFolder(box), 'node') })
    const a = store.add('a', 'hand').master
    store.add('b', 'hand')
    const r = await box.run('cli', { args: ['node', 'leave'], env: {} }).exited
    expect([r.code, r.stderr]).toEqual([1, 'board: several masters: name the one to leave (`board node` lists them)\n'])
    const named = await box.run('cli', { args: ['node', 'leave', a.id], env: {} }).exited
    expect(named.code).toBe(0)
    expect(store.list().map(m => m.name)).toEqual(['b'])
  }, 30_000)
})

describe('without nodes and node', () => {
  test('no leave, no revoke, nothing written', async () => {
    const box = await sandbox()
    mkdirSync(dirname(configPath(box)), { recursive: true })
    writeFileSync(configPath(box), JSON.stringify({ language: 'en', wakeUrl: '', port: 9 }))
    const { url, proc } = await serveBoard(box, { language: 'en' }, PAIR_ENV)
    const before = readFileSync(configPath(box), 'utf8')
    const leave = await fetch(`${url}/api/node/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: '{"sleep":true}',
    })
    // The board's answer to a path it lacks, as before: nothing of the door is on the web board.
    const lacking = await fetch(`${url}/api/node/nothing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: '{}',
    })
    expect(leave.status).toBe(lacking.status)
    expect(leave.status).not.toBe(200)
    // No /api/nodes at all without `nodes`, as before.
    const revoke = await post(url, { op: 'revoke', id: 'server-1' })
    expect(revoke.status).toBe(lacking.status)
    expect(readFileSync(configPath(box), 'utf8')).toBe(before)
    expect(existsSync(join(stateFolder(box), 'nodes'))).toBe(false)
    expect(existsSync(join(stateFolder(box), 'node'))).toBe(false)
    const cli = await box.run('cli', { args: ['nodes', 'revoke', 'server-1'], env: {} }).exited
    expect(cli.stdout).toBe('this board is not a master: config.json has no `nodes`\n')
    const left = await box.run('cli', { args: ['node', 'leave'], env: {} }).exited
    expect(left.stdout).toBe('this board is not a node: config.json has no `node`\n')
    proc.kill()
  }, 30_000)
})
