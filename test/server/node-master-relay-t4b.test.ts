// The master relay's T4b groups on running boards (#786, epic #763): a master and two nodes
// (test/support/node-pair.ts). On main a node answered these from its own config.json: Devices and
// Team "off" or empty, Add a server refused (409, #777), a start or a move to a device left to a
// board that is no master, another machine's session unknown; now:
// - Devices (GET/POST /api/nodes) and Add a server's form are the master's from the node's page,
//   each change in the master's admin log, never a node session's;
// - the node's payload carries the master's devices, this computer the row with no link;
// - Team is the master's from the node's page (the passkey's own window stays on the master);
// - the start window's options are the master's; a sleep naming another node's session goes to the
//   master, which hands it to that node;
// - a node's own paths stay its own: a sleep of its own session, a move to itself.
// And a board without node answers as before.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
    body: JSON.stringify(body),
  })

async function until<T>(what: string, f: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await Bun.sleep(50)
  }
}

const getJson = async (
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(url, { headers })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const S1 = '7a1f3c2e-5b6d-4e8f-9a0b-1c2d3e4f5a6b'
const S2 = '8b2e4d3f-6c7e-4f90-8b1c-2d3e4f5a6b7c'

type Device = { id: string; kind: unknown; link: unknown; selfId?: string }

/** The node's config.json as its terminal reads it (the board itself runs on the config it was given). */
function nodeCliConfig(node: PairNode): void {
  const dir = join(node.box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      language: 'en',
      port: Number(new URL(node.url).port),
      node: { id: node.id, port: node.doorPort, workRoot: node.box.dir },
    }),
  )
}

test("a node's page reaches the master's Devices, Add a server, Team and starts; another node's session through the master", async () => {
  const pair = await nodePair({
    count: 2,
    masterCfg: { team: { hub: 'ws://127.0.0.1:9', name: 'anna' } },
    masterPanes: () => [],
    panes: (id, box) => [
      {
        pane_id: 'p1',
        agent: 'claude',
        agent_session: { value: id === 'server-1' ? S1 : S2 },
        agent_status: 'idle',
        cwd: box.dir,
      },
    ],
  })
  const [a, b] = pair.nodes as [PairNode, PairNode]
  const master = pair.master.url
  await pair.waitDevice(a.id, d => d.link?.state === 'online', 10_000)
  await pair.waitDevice(b.id, d => d.link?.state === 'online', 10_000)

  // Devices: the master's view from the node's page, once the master's relay stream is up.
  const seen = await until('the node reads the master devices', async () => {
    const r = await getJson(`${a.url}/api/nodes`)
    return r.status === 200 && Array.isArray(r.body.devices) ? r.body : null
  })
  const masterView = (await getJson(`${master}/api/nodes`)).body
  const masterId = (masterView.devices as Device[]).find(d => d.id === 'local')?.selfId ?? ''
  expect(masterId).toBe('laptop')
  // In the node's terms: it is `local`, the master its id.
  const nodeTerms = (id: string) => (id === a.id ? 'local' : id === 'local' ? masterId : id)
  expect((seen.devices as Device[]).map(d => d.id)).toEqual((masterView.devices as Device[]).map(d => nodeTerms(d.id)))
  expect(seen.master).toBe(masterId)
  expect((seen.devices as Device[]).find(d => d.id === 'local')).toMatchObject({ kind: null, link: null, selfId: a.id })

  // Edits from the node's page land on the right machine's entry in the master's config.json.
  const masterFile = join(pair.master.box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  writeFileSync(masterFile, JSON.stringify(pair.masterConfig, null, 2))
  const onDisk = () =>
    JSON.parse(readFileSync(masterFile, 'utf8')).nodes as {
      order: string[]
      devices: Record<string, { title?: string; color?: string } | undefined>
    }
  // This computer renamed: the node's own entry, never the master's `local`.
  const renamed = await post(`${a.url}/api/nodes`, { op: 'set', id: 'local', title: 'Ben desk ☃ 100%' })
  expect(renamed.status).toBe(200)
  expect(onDisk().devices[a.id]?.title).toBe('Ben desk ☃ 100%')
  expect(onDisk().devices.local?.title).toBeUndefined()
  // The master's row recoloured: the master's own `local` entry.
  expect((await post(`${a.url}/api/nodes`, { op: 'set', id: masterId, color: '#30d158' })).status).toBe(200)
  expect(onDisk().devices.local?.color).toBe('#30d158')
  expect(onDisk().devices[a.id]?.color).toBeUndefined()
  // A new order in the node's terms is the master's order in its own.
  const order = [b.id, 'local', masterId]
  const reordered = await post(`${a.url}/api/nodes`, { op: 'order', ids: order })
  expect(reordered.status).toBe(200)
  expect(onDisk().order).toEqual([b.id, a.id, 'local'])
  // The answer is in the node's terms too.
  const after = (await reordered.json()) as { settings?: { next?: string | null } }
  expect(after.settings).toBeTruthy()

  // An action from the node is the master's (its link to node b tried again), in its admin log.
  const retried = await post(`${a.url}/api/nodes`, { op: 'retry', id: b.id })
  expect({ status: retried.status, body: await retried.json() }).toEqual({
    status: 200,
    body: { ok: true, master: masterId },
  })
  const log = (await getJson(`${master}/api/links/log`)).body as { edges?: Record<string, unknown>[] }
  expect(log.edges?.find(e => e.kind === 'admin' && e.path === '/api/nodes')).toMatchObject({
    via: 'relay',
    from: a.id,
    status: 200,
  })

  // Add a server's form: the master's (on main the node refused it, 409).
  const setup = await getJson(`${a.url}/api/nodes/setup`)
  expect(setup.status).toBe(200)
  expect(setup.body).toEqual((await getJson(`${master}/api/nodes/setup`)).body)

  // A session of the node reads neither Devices nor the setup forms.
  const asSession = { 'x-board-session': S1 }
  await until('the master knows the node session', async () => {
    const r = await fetch(`${a.url}/api/launch/options`, { headers: asSession })
    return r.status === 200 ? r : null
  })
  expect((await getJson(`${a.url}/api/nodes`, asSession)).status).toBe(403)
  expect((await getJson(`${a.url}/api/nodes/setup`, asSession)).status).toBe(403)

  // The node's payload: the master's devices, this computer the row with no link, the master named.
  const payload = await until('the node payload has the devices', async () => {
    const p = (await getJson(`${a.url}/api/board`)).body
    return Array.isArray(p.devices) ? p : null
  })
  expect(payload.relayedDevices).toEqual({ master: masterId })
  const rows = payload.devices as Device[]
  expect(rows.find(d => d.id === 'local')).toMatchObject({ kind: null, link: null, selfId: a.id })
  expect(rows.find(d => d.id === masterId)?.link).toMatchObject({ state: 'online' })
  expect(rows.map(d => d.id)).toContain(b.id)
  expect(rows.map(d => d.id)).not.toContain(a.id)
  // Team's revision comes with them: the node's page offers the Team panel.
  expect(typeof payload.teamRev).toBe('number')

  // Team: the master's view, and a change of what agents may do in its admin log.
  const team = await getJson(`${a.url}/api/team`)
  expect(team.status).toBe(200)
  expect(Object.keys(team.body).sort()).toEqual(Object.keys((await getJson(`${master}/api/team`)).body).sort())
  // The passkey's own window is the master's screen's.
  const window = await getJson(`${a.url}/api/team/confirm/abcdefabcdef`)
  expect(window.status).toBe(403)

  // The start window's options are the master's.
  const options = await getJson(`${a.url}/api/launch/options`)
  expect(options.status).toBe(200)
  expect(Object.keys(options.body).sort()).toEqual(
    Object.keys((await getJson(`${master}/api/launch/options`)).body).sort(),
  )

  // Another node's session: a sleep from node a goes to the master, which hands it to node b.
  const bKey = await until("the master has node b's card", async () => {
    const p = (await getJson(`${master}/api/board`)).body
    const item = ((p.items ?? []) as { key: string; device?: string }[]).find(i => i.device === b.id)
    return item ? item.key : null
  })
  const slept = await post(`${a.url}/api/sleep`, { targets: [bKey] })
  expect(slept.status).toBe(200)
  const sleptBody = (await slept.json()) as { results: { target: string; why?: string; detail?: string }[] }
  expect(sleptBody.results).toHaveLength(1)
  expect(sleptBody.results[0]?.target).toBe(bKey)
  // Node b answered it (its own sleep route), not node a's "no such session".
  expect(sleptBody.results[0]?.why).not.toBe('gone')

  // The node's own session stays its own: a sleep of it never goes up (the same answer with the link down).
  const own = await post(`${a.url}/api/sleep`, { targets: [S1] })
  const ownBody = await own.json()

  // A move of node b's session here (device local) and of node a's own to the master go to the
  // master's mover (on main: node a's own route, which moves to no device); it answers for each.
  const pulled = await post(`${a.url}/api/move`, { targets: [bKey], device: 'local', dryRun: true })
  expect(pulled.status).toBe(200)
  const pulledBody = (await pulled.json()) as { results: Record<string, unknown>[] }
  // The master's mover planned it from node b to node a (refused here only for the conversation the fakes lack).
  expect(pulledBody.results).toHaveLength(1)
  expect(pulledBody.results[0]).toMatchObject({ target: bKey, from: b.id, to: a.id })
  const pushed = await post(`${a.url}/api/move`, { targets: [S1], device: masterId, dryRun: true })
  expect(pushed.status).toBe(200)
  const pushedBody = (await pushed.json()) as { results: Record<string, unknown>[] }
  expect(pushedBody.results).toHaveLength(1)
  expect(pushedBody.results[0]).toMatchObject({ from: a.id })

  // A fork of node b's session from node a is node b's own answer, through the master.
  const bOwn = bKey.slice(bKey.indexOf(':') + 1)
  const forkVia = await post(`${a.url}/api/session/${encodeURIComponent(bKey)}/fork`, { name: 'atlas fork' })
  const forkThere = await post(`${b.url}/api/session/${encodeURIComponent(bOwn)}/fork`, { name: 'atlas fork' })
  expect({ status: forkVia.status, body: await forkVia.json() }).toEqual({
    status: forkThere.status,
    body: await forkThere.json(),
  })

  // The CLI on the node: board nodes reads the master's devices, board update asks the master to
  // ship its commit here, board sleep names node b's session.
  nodeCliConfig(a)
  const nodesOut = await a.box.run('cli', { args: ['nodes'], env: {} }).exited
  expect(nodesOut.stdout).toContain(`master ${masterId}`)
  expect(nodesOut.stdout).toContain(`${a.id} · `)
  expect(nodesOut.stdout).toContain('this computer')
  expect(nodesOut.stdout).toContain(b.id)
  const updated = await a.box.run('cli', { args: ['update'], env: {} }).exited
  // The master's answer for this node (on main: the node's own "a node is updated by its master").
  expect(`${updated.stdout}${updated.stderr}`).toContain(a.id)
  const sleptCli = await a.box.run('cli', { args: ['sleep', bKey], env: {} }).exited
  expect(sleptCli.stdout).toMatch(/^ok · /)
  expect(sleptCli.stdout).not.toContain('no such session')

  // Archive of node b's session from node a: node b takes it off its board, through the master.
  const archived = await post(`${a.url}/api/archive`, { op: 'archive', keys: [bKey] })
  const archivedBody = (await archived.json()) as {
    done: { key: string }[]
    failed: { key: string; error: string; why?: string }[]
  }
  expect([...archivedBody.done, ...archivedBody.failed].map(e => e.key)).toEqual([bKey])
  // Node b's herdr was asked to close its pane (its fake knows no `pane get`): the archive ran there.
  expect(archivedBody.failed[0]?.why ?? 'done').toMatch(/^(archive\.why\.herdr|done)$/)

  // The link down: Devices answer 503 node-master-offline, never the node's own "off".
  await a.proxy.cut('drop')
  const away = await until('the node says the master is away', async () => {
    const r = await getJson(`${a.url}/api/nodes`)
    return r.status === 503 ? r : null
  })
  expect(away.body.error).toBe('node-master-offline')
  // A start goes to the master's placer too: with the master away it says so (on main the node
  // started it on its own).
  const start = await post(`${a.url}/api/launch`, { cwd: a.box.dir })
  expect(((await start.json()) as { error?: string }).error).toBe('node-master-offline')
  const ownAgain = await post(`${a.url}/api/sleep`, { targets: [S1] })
  expect({ status: ownAgain.status, body: await ownAgain.json() }).toEqual({ status: own.status, body: ownBody })
  // A move to this computer itself is its own route's too.
  const toSelf = await post(`${a.url}/api/move`, { targets: [S1], device: 'local' })
  expect((await toSelf.json().catch(() => ({}))).error).not.toBe('node-master-offline')
}, 120_000)

test('a board without node answers Devices, Add a server and Team as before', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  const p = (await getJson(`${url}/api/board`)).body
  expect('devices' in p).toBe(false)
  expect('relayedDevices' in p).toBe(false)
  expect('teamRev' in p).toBe(false)
  // No team: /api/team is no route here.
  expect((await getJson(`${url}/api/team`)).status).toBe(404)
  // Add a server's form is this board's own (it adds its first server here).
  expect((await getJson(`${url}/api/nodes/setup`)).status).toBe(200)
}, 30_000)
