// Settings → The whole board on a node's page (#887): a master and two nodes (test/support/node-pair.ts),
// one the master takes as the owner's, one its owner turned off (`owner: false`). On main a node had no
// way to the master's own settings, Owner services or passkey: `/api/master/...` was no path anywhere.
// Now:
// - the owner on an owner node reads the master's payload and writes its Board settings through
//   `/api/master/`, which land in the master's config.json (the node's own stays without them), each
//   write in the master's admin log as the owner's on that node;
// - Owner services and the passkey: the master holds the action for that node, whose page signs it in
//   a window on its own localhost (RP ID `localhost`, the node's port), and the master checks it;
//   a confirmation pended for the node is gone to the master's own page and the other way round, and
//   one signed for another origin is refused;
// - never a node session, never a device turned off, never a path off the list;
// - a board without nodes answers `/api/master/...` as before (no such path).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'
import { softAuthenticator } from '../support/soft-authenticator.ts'

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

const configOf = (box: { env: Record<string, string | undefined> }): Record<string, unknown> => {
  try {
    return JSON.parse(
      readFileSync(join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'), 'utf8'),
    )
  } catch {
    return {}
  }
}

const S = '0b5e2c1d-3f4a-4b6c-8d7e-9f0a1b2c3d4e'

test("a node's page manages the master's own settings, owner services and passkey; nobody else does", async () => {
  const pair = await nodePair({
    count: 2,
    masterCfg: { language: 'en' },
    masterPanes: () => [],
    panes: (_id, box) => [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
    ],
    deviceCfg: id => (id === 'server-2' ? { owner: false } : {}),
  })
  const [node, turnedOff] = pair.nodes as [PairNode, PairNode]
  const master = pair.master.url
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  await pair.waitDevice(turnedOff.id, d => d.link?.state === 'online', 10_000)
  const nodeOrigin = `http://localhost:${new URL(node.url).port}`
  const masterOrigin = `http://localhost:${new URL(master).port}`

  // The master's payload, as the master has it.
  const board = await until('the node reads the master board', async () => {
    const res = await fetch(`${node.url}/api/master/board`)
    return res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null
  })
  const own = (await (await fetch(`${master}/api/board`)).json()) as Record<string, unknown>
  expect(board.lang).toBe(own.lang)
  expect(board.version).toBe(own.version)
  expect(board.nodeMaster).toBeUndefined()

  // A Board setting lands in the master's config.json, not the node's; the admin log says whose.
  expect((await post(`${node.url}/api/master/settings`, { compactAt: '300k' })).status).toBe(200)
  expect(configOf(pair.master.box).compact).toMatchObject({ at: '300k' })
  expect(configOf(node.box).compact).toBeUndefined()
  // Start limits stay on the master's own computer (#815).
  expect((await post(`${node.url}/api/master/settings`, { spawnLimits: { perHour: 1 } })).status).toBe(403)
  const log = (await (await fetch(`${master}/api/links/log`)).json()) as { edges?: Record<string, unknown>[] }
  expect(log.edges?.find(e => e.kind === 'admin' && e.path === '/api/settings' && e.status === 200)).toMatchObject({
    via: 'relay',
    from: node.id,
    who: `owner on ${node.id}`,
  })

  // Owner services and the passkey, signed on the node's page.
  const key = await softAuthenticator(-7)
  const services = () => fetch(`${node.url}/api/master/owner-services`).then(r => r.json())
  expect(await services()).toEqual({ services: [], hasPasskey: false })
  const sign = async (id: string, origin = nodeOrigin): Promise<Response> => {
    const read = await fetch(`${node.url}/api/master/team/confirm/${id}`)
    expect(read.status).toBe(200)
    const v = (await read.json()) as { step: string; options: { challenge: string } }
    const at = { challenge: v.options.challenge, origin, rpId: 'localhost' }
    const credential = v.step === 'create' ? key.register(at) : key.assert(at)
    return post(
      `${node.url}/api/master/team/confirm/${id}`,
      { ...credential, type: 'public-key' },
      { origin: nodeOrigin },
    )
  }
  const asked = await post(`${node.url}/api/master/owner-services`, { op: 'passkey' })
  expect(asked.status).toBe(428)
  const first = (await asked.json()) as { id: string; scope: string; confirm?: string }
  expect(first.scope).toBe('master')
  expect(first.confirm).toBeUndefined()
  // Pended for the node: the master's own page does not see it.
  expect((await fetch(`${master}/api/team/confirm/${first.id}`)).status).toBe(404)
  expect((await sign(first.id)).status).toBe(200)
  expect(await services()).toEqual({ services: [], hasPasskey: true })
  // The passkey is the master's: its own page lists it.
  expect(await (await fetch(`${master}/api/owner-services`)).json()).toEqual({ services: [], hasPasskey: true })

  // A service: signed for another origin, refused; for the node's page, done.
  const name = 'Atlas 100% · Сервис'
  const add = async (): Promise<string> => {
    const res = await post(`${node.url}/api/master/owner-services`, { op: 'add', name })
    expect(res.status).toBe(428)
    return ((await res.json()) as { id: string }).id
  }
  const wrong = await sign(await add(), 'https://example.com')
  expect(wrong.status).toBe(403)
  expect(((await wrong.json()) as { error: string }).error).toBe('origin')
  const done = await sign(await add())
  expect(done.status).toBe(200)
  const made = (await done.json()) as { token: string; service: { key: string; name: string } }
  expect(made.token).toMatch(/^bos_[A-Za-z0-9_-]{43}$/)
  expect(made.service.name).toBe(name)
  expect(await (await fetch(`${master}/api/owner-services`)).json()).toEqual({
    services: [made.service],
    hasPasskey: true,
  })

  // One pended on the master's own page is gone to the node's.
  const local = await post(`${master}/api/owner-services`, { op: 'add', name: 'Local' }, { origin: masterOrigin })
  expect(local.status).toBe(428)
  const localId = ((await local.json()) as { id: string }).id
  expect((await fetch(`${node.url}/api/master/team/confirm/${localId}`)).status).toBe(404)

  // Revoke from the node.
  expect((await post(`${node.url}/api/master/owner-services`, { op: 'revoke', key: made.service.key })).status).toBe(
    200,
  )
  expect(await (await fetch(`${master}/api/owner-services`)).json()).toEqual({ services: [], hasPasskey: true })

  // A session of the node: never.
  const asSession = { 'x-board-session': S }
  await until('the master knows the node session', async () => {
    const r = await fetch(`${node.url}/api/threads`, { headers: asSession })
    return r.status !== 403 ? r : null
  }).catch(() => null)
  expect((await fetch(`${node.url}/api/master/board`, { headers: asSession })).status).toBe(403)
  expect((await fetch(`${node.url}/api/master/owner-services`, { headers: asSession })).status).toBe(403)
  expect((await post(`${node.url}/api/master/settings`, { compactAt: '400k' }, asSession)).status).toBe(403)

  // A device its owner turned off: never.
  const off = await fetch(`${turnedOff.url}/api/master/board`)
  expect(off.status).toBe(403)
  expect(((await off.json()) as { error: string }).error).toBe('master-relay-owner')
  expect((await post(`${turnedOff.url}/api/master/settings`, { compactAt: '400k' })).status).toBe(403)
  expect(configOf(pair.master.box).compact).toMatchObject({ at: '300k' })

  // A path off the list does not go up: the node's own table has no such path.
  for (const path of ['/api/master/backup', '/api/master/access', '/api/master/team/passkeys', '/api/master/remote']) {
    const res = await fetch(`${node.url}${path}`)
    expect([404, 405]).toContain(res.status)
  }
  // The master itself has no `/api/master/` route of its own.
  expect([404, 405]).toContain((await fetch(`${master}/api/master/board`)).status)
}, 60_000)

test('a board without nodes has no /api/master/ path, as before', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  for (const path of ['/api/master/board', '/api/master/owner-services']) {
    expect([404, 405]).toContain((await fetch(`${url}${path}`)).status)
    expect([404, 405]).toContain((await post(`${url}${path}`, {})).status)
  }
  expect(configOf(box).compact).toBeUndefined()
})
