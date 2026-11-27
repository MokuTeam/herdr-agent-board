// Multi-node New session modal server chain (#948):
// - GET /api/launch/options?device=<id> and POST /api/fs/dirs { device } proxy to the chosen node
// - 'local' / absent device stays on master (and single-machine setups stay completely untouched)
// - offline/unknown devices return 503 node-offline / 404
// - BoardDevice includes `platform`
// - POST /api/launch with pin: { device } forwards workspace/folder/agent to the target node
// - Node's own page relays master/other-node options, dirs, and launches while keeping ?device=local on the node
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { sandbox, until } from '../support/sandbox.ts'

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
    body: JSON.stringify(body),
  })

async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function waitBoard(url: string, ok: (p: BoardPayload) => boolean, ms = 10_000): Promise<BoardPayload> {
  const deadline = Date.now() + ms
  for (;;) {
    const p = (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
    if (ok(p)) return p
    if (Date.now() > deadline) throw new Error('timed out waiting for board payload')
    await Bun.sleep(50)
  }
}

describe('multi-node launch options, dirs, and pinned launch proxy (#948)', () => {
  test('proxies GET /api/launch/options?device= and POST /api/fs/dirs device, keeps local/absent on master, exposes device platform', async () => {
    const pair = await nodePair({
      count: 1,
      panes: () => [],
      masterPanes: () => [],
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const master = pair.master

    const masterSub = join(master.box.dir, 'master-only-dir')
    const nodeSub = join(node.box.dir, 'node-only-dir')
    mkdirSync(masterSub, { recursive: true })
    mkdirSync(nodeSub, { recursive: true })

    master.box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'wm1', label: 'MasterWS', focused: true }] } },
    })
    node.box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'wn1', label: 'NodeWS', focused: true }] } },
    })

    await pair.waitDevice(node.id, d => d.link?.state === 'online' && !!d.status, 10_000)

    // Payload devices carry `platform` for both local and remote nodes.
    const payload = (await (await fetch(`${master.url}/api/board`)).json()) as BoardPayload
    expect(payload.devices?.find(d => d.id === 'local')?.platform).toBe(process.platform)
    expect(payload.devices?.find(d => d.id === node.id)?.platform).toBe(process.platform)

    // GET /api/launch/options: absent and ?device=local stay on master; ?device=server-1 proxies to node.
    const masterOpts = await jsonOf(await fetch(`${master.url}/api/launch/options`))
    expect(masterOpts.status).toBe(200)
    expect(masterOpts.body.workspaces).toEqual([{ id: 'wm1', label: 'MasterWS' }])

    const localOpts = await jsonOf(await fetch(`${master.url}/api/launch/options?device=local`))
    expect(localOpts.status).toBe(200)
    expect(localOpts.body.workspaces).toEqual([{ id: 'wm1', label: 'MasterWS' }])

    const nodeOpts = await jsonOf(await fetch(`${master.url}/api/launch/options?device=${node.id}`))
    expect(nodeOpts.status).toBe(200)
    expect(nodeOpts.body.workspaces).toEqual([{ id: 'wn1', label: 'NodeWS' }])
    expect(node.proxy.requests).toContain('GET /api/launch/options')

    // POST /api/fs/dirs: without device or with device:'local' checks master FS; with device:'server-1' proxies to node and strips `device`.
    const masterDirs = await jsonOf(await post(`${master.url}/api/fs/dirs`, { path: master.box.dir, git: false }))
    expect(masterDirs.status).toBe(200)
    expect(masterDirs.body.entries).toContain('master-only-dir')

    const localDirs = await jsonOf(
      await post(`${master.url}/api/fs/dirs`, { path: master.box.dir, git: false, device: 'local' }),
    )
    expect(localDirs.status).toBe(200)
    expect(localDirs.body.entries).toContain('master-only-dir')

    const nodeDirs = await jsonOf(
      await post(`${master.url}/api/fs/dirs`, { path: node.box.dir, git: false, device: node.id }),
    )
    expect(nodeDirs.status).toBe(200)
    expect(nodeDirs.body.entries).toContain('node-only-dir')
    const forwardedDirs = node.proxy.received.filter(r => r.request === 'POST /api/fs/dirs').at(-1)
    expect(forwardedDirs).toBeDefined()
    expect(JSON.parse(forwardedDirs?.body ?? '{}')).toEqual({ path: node.box.dir, git: false })

    // Unknown device -> 404.
    const unknownOpts = await jsonOf(await fetch(`${master.url}/api/launch/options?device=no-such-box`))
    expect(unknownOpts.status).toBe(404)
    const unknownDirs = await jsonOf(
      await post(`${master.url}/api/fs/dirs`, { path: node.box.dir, git: false, device: 'no-such-box' }),
    )
    expect(unknownDirs.status).toBe(404)

    // Offline node -> 503 node-offline.
    await node.proxy.cut('drop')
    await pair.waitDevice(node.id, d => d.link?.state !== 'online', 10_000)
    const offOpts = await jsonOf(await fetch(`${master.url}/api/launch/options?device=${node.id}`))
    expect([offOpts.status, offOpts.body]).toEqual([503, { error: 'node-offline', device: node.id }])
    const offDirs = await jsonOf(
      await post(`${master.url}/api/fs/dirs`, { path: node.box.dir, git: false, device: node.id }),
    )
    expect([offDirs.status, offDirs.body]).toEqual([503, { error: 'node-offline', device: node.id }])
  }, 60_000)

  test('node own page relays master/other-node options & dirs while keeping ?device=local on the node, and remaps pin.device on launch', async () => {
    const pair = await nodePair({
      count: 2,
      panes: () => [],
      masterPanes: () => [],
    })
    const [a, b] = pair.nodes
    if (!a || !b) throw new Error('need 2 nodes')
    const master = pair.master

    const masterDir = join(master.box.dir, 'master-dir')
    const bDir = join(b.box.dir, 'b-dir')
    mkdirSync(masterDir, { recursive: true })
    mkdirSync(bDir, { recursive: true })

    master.box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'wm1', label: 'MasterWS', focused: true }] } },
    })
    a.box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'wa1', label: 'NodeAWS', focused: true }] } },
    })
    b.box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'wb1', label: 'NodeBWS', focused: true }] } },
    })

    await pair.waitDevice(a.id, d => d.link?.state === 'online' && !!d.status, 10_000)
    await pair.waitDevice(b.id, d => d.link?.state === 'online' && !!d.status, 10_000)

    const nodeBoard = await waitBoard(a.url, p => !!p.relayedDevices)
    const masterId = nodeBoard.relayedDevices?.master ?? ''
    expect(masterId).toBe('laptop')

    // On node A's page: ?device=local answers with node A's own options!
    const selfOpts = await jsonOf(await fetch(`${a.url}/api/launch/options?device=local`))
    expect(selfOpts.status).toBe(200)
    expect(selfOpts.body.workspaces).toEqual([{ id: 'wa1', label: 'NodeAWS' }])

    // On node A's page: ?device=<masterId> relays to master and returns master's options.
    const masterOpts = await jsonOf(await fetch(`${a.url}/api/launch/options?device=${masterId}`))
    expect(masterOpts.status).toBe(200)
    expect(masterOpts.body.workspaces).toEqual([{ id: 'wm1', label: 'MasterWS' }])

    // On node A's page: ?device=server-2 relays through master to node B.
    const bOpts = await jsonOf(await fetch(`${a.url}/api/launch/options?device=${b.id}`))
    expect(bOpts.status).toBe(200)
    expect(bOpts.body.workspaces).toEqual([{ id: 'wb1', label: 'NodeBWS' }])

    // On node A's page: POST /api/fs/dirs with device: masterId browses master's FS.
    const masterDirs = await jsonOf(
      await post(`${a.url}/api/fs/dirs`, { path: master.box.dir, git: false, device: masterId }),
    )
    expect(masterDirs.status).toBe(200)
    expect(masterDirs.body.entries).toContain('master-dir')

    // On node A's page: POST /api/fs/dirs with device: b.id browses node B's FS.
    const bDirs = await jsonOf(await post(`${a.url}/api/fs/dirs`, { path: b.box.dir, git: false, device: b.id }))
    expect(bDirs.status).toBe(200)
    expect(bDirs.body.entries).toContain('b-dir')
  }, 60_000)

  test('POST /api/launch with pin.device and node-only folder places onto the target node with workspace', async () => {
    const pair = await nodePair({
      count: 1,
      panes: () => [],
      masterPanes: () => [],
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const master = pair.master

    const masterHome = master.box.env.HOME ?? ''
    const nodeHome = node.box.env.HOME ?? ''
    mkdirSync(join(masterHome, '.claude'), { recursive: true })
    writeFileSync(join(masterHome, '.claude', '.credentials.json'), '{}')
    mkdirSync(join(nodeHome, '.claude'), { recursive: true })
    writeFileSync(join(nodeHome, '.claude', '.credentials.json'), '{}')

    const targetDir = join(node.box.dir, 'node-project')
    mkdirSync(targetDir, { recursive: true })
    node.box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'wn9', label: 'NodeProj', focused: true }] } },
      'tab create': { result: { tab: { tab_id: 'wn9:t1' }, root_pane: { pane_id: 'wn9:p1' } } },
      'pane get': { result: { pane: { pane_id: 'wn9:p1', tab_id: 'wn9:t1', agent: 'claude', agent_status: 'idle' } } },
      'pane run': { result: null },
      'agent list': { result: { agents: [] } },
      'agent prompt': { result: null },
    })
    await pair.waitDevice(node.id, d => d.link?.state === 'online' && !!d.status, 10_000)
    await waitBoard(master.url, p => !p.stale)

    const launched = await jsonOf(
      await post(`${master.url}/api/launch`, {
        name: 'proj',
        cwd: targetDir,
        category: 'other',
        workspace: { id: 'wn9', label: 'NodeProj' },
        message: '',
        pin: { device: node.id },
      }),
    )
    expect(launched.status, JSON.stringify(launched.body)).toBe(200)
    await until(() => node.proxy.received.some(r => r.request === 'POST /api/node/launch'), 10_000)
    const sent = node.proxy.received.find(r => r.request === 'POST /api/node/launch')
    const sentBody = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>
    expect(sentBody.workspace).toBe('NodeProj')
    expect(sentBody.workspaceId).toBe('wn9')
    expect(sentBody.source).toEqual({ kind: 'path', cwd: targetDir, worktree: null })
  }, 60_000)

  test('single-machine board without nodes leaves /api/launch/options and /api/fs/dirs completely unchanged', async () => {
    const box = await sandbox()
    const sub = join(box.dir, 'single-dir')
    mkdirSync(sub, { recursive: true })
    box.state({
      'workspace list': { result: { workspaces: [{ workspace_id: 'ws1', label: 'SoloWS', focused: true }] } },
    })
    const { url } = await serveBoard(box, { language: 'en' }, PAIR_ENV)
    const opts = await jsonOf(await fetch(`${url}/api/launch/options`))
    expect(opts.status).toBe(200)
    expect(opts.body.workspaces).toEqual([{ id: 'ws1', label: 'SoloWS' }])
    const dirs = await jsonOf(await post(`${url}/api/fs/dirs`, { path: box.dir, git: false }))
    expect(dirs.status).toBe(200)
    expect(dirs.body.entries).toContain('single-dir')
  }, 30_000)
})
