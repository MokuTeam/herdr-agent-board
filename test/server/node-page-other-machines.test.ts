// A node's page shows the other machines' sessions beside its own (#904): the master gives them with
// its slices over the relay (GET /api/board-slices), its own keyed by its id, the other nodes' as it
// names them, never the asking node's. On main the node's payload had its own sessions only, so the
// owner at a node saw nothing of the master's or of the other nodes'. A card of the master's own,
// named by the master's id, is acted on from the node's page as any other machine's.
import { expect, test } from 'bun:test'
import { boardSlicesOf, itemsForNode, nodeSlicesView } from '../../src/core/board-slices.ts'
import type { Item } from '../../src/core/types.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'

const MASTER = '9b2e4c1d-3a5f-4b6c-8d7e-0f1a2b3c4d5e'

type Row = { key: string; device?: string; name?: string; doing?: string }

const itemsOf = async (url: string): Promise<Row[]> =>
  (((await (await fetch(`${url}/api/board`)).json()) as { items?: Row[] }).items ?? []) as Row[]

async function until<T>(what: string, f: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await Bun.sleep(50)
  }
}

test("each node's page shows the master's and the other node's sessions, never its own twice; the master's are acted on", async () => {
  const pair = await nodePair({
    count: 2,
    env: { BOARD_NODE_SLICES_MS: '200' },
    masterPanes: box => [
      { pane_id: 'm1', agent: 'claude', agent_session: { value: MASTER }, agent_status: 'idle', cwd: box.dir },
    ],
  })
  const [a, b] = pair.nodes as [PairNode, PairNode]
  await pair.waitDevice(a.id, d => d.link?.state === 'online', 10_000)
  await pair.waitDevice(b.id, d => d.link?.state === 'online', 10_000)

  const masterKeys = (await until('the master shows both nodes', async () => {
    const keys = (await itemsOf(pair.master.url)).map(i => i.key)
    return keys.some(k => k.startsWith(`@${a.id}:`)) && keys.some(k => k.startsWith(`@${b.id}:`)) ? keys : null
  })) as string[]
  const ownOf = async (n: PairNode): Promise<string[]> =>
    (await itemsOf(n.url)).filter(i => !i.key.startsWith('@')).map(i => i.key)

  for (const [n, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const own = await ownOf(n)
    expect(own.length).toBeGreaterThan(0)
    const rows = await until(`${n.id}'s page shows the master's and ${other.id}'s sessions`, async () => {
      const got = await itemsOf(n.url)
      return got.some(i => i.key === `@laptop:${MASTER}`) && got.some(i => i.key.startsWith(`@${other.id}:`))
        ? got
        : null
    })
    // The master's own under its id, the other node's as the master names it, each with its machine.
    expect(rows.find(i => i.key === `@laptop:${MASTER}`)?.device).toBe('laptop')
    for (const r of rows.filter(i => i.key.startsWith(`@${other.id}:`))) {
      expect(r.device).toBe(other.id)
      expect(masterKeys).toContain(r.key)
    }
    // Its own sessions once, by their own keys: none of them comes back from the master prefixed.
    expect(rows.some(i => i.key.startsWith(`@${n.id}:`))).toBe(false)
    expect(rows.filter(i => !i.key.startsWith('@')).map(i => i.key)).toEqual(own)
  }

  // A card of the master's own session, from a node's page: the master's card changes.
  const key = encodeURIComponent(`@laptop:${MASTER}`)
  const detail = await fetch(`${a.url}/api/session/${key}`)
  expect(detail.status).toBe(200)
  const card = await fetch(`${a.url}/api/session/${key}/card`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ doing: 'from the node ☃ 100%' }),
  })
  expect(card.status).toBe(200)
  await until('the master shows the card', async () => {
    const it = (await itemsOf(pair.master.url)).find(i => i.key === MASTER)
    return it?.doing === 'from the node ☃ 100%' ? it : null
  })
}, 60_000)

test("the sessions for a node's page: the master's under its id, the others' as they are, the node's own left out", () => {
  const it = (key: string, device?: string): Item => ({ key, name: key, ...(device && { device }) }) as unknown as Item
  const items = [
    it('5d0c6a1e-1111-4222-8333-000000000001'),
    it('pane-w1:p2'),
    it('@mac:pane-w6:p7', 'mac'),
    it('@win-laptop:C:\\Users\\Анна Мария 100%', 'win-laptop'),
  ]
  expect(itemsForNode(items, 'mac', 'hermes').map(i => [i.key, i.device])).toEqual([
    ['@hermes:5d0c6a1e-1111-4222-8333-000000000001', 'hermes'],
    ['@hermes:pane-w1:p2', 'hermes'],
    ['@win-laptop:C:\\Users\\Анна Мария 100%', 'win-laptop'],
  ])
  expect(itemsForNode(items, 'win-laptop', 'hermes').map(i => i.key)).toEqual([
    '@hermes:5d0c6a1e-1111-4222-8333-000000000001',
    '@hermes:pane-w1:p2',
    '@mac:pane-w6:p7',
  ])
  // A master that knows no id of its own gives the other nodes' only.
  expect(itemsForNode(items, 'mac', '').map(i => i.key)).toEqual(['@win-laptop:C:\\Users\\Анна Мария 100%'])

  // The node reads them only as a whole list of machine-keyed rows; an older master's answer has none.
  const ok = { ok: true, slices: { items: [it('@hermes:a', 'hermes')] } }
  expect(boardSlicesOf(ok)?.items?.map(i => i.key)).toEqual(['@hermes:a'])
  expect(boardSlicesOf({ ok: true, slices: {} })).toEqual({})
  for (const bad of [[it('plain')], [it('@hermes:a', 'mac')], [it('@hermes:a')], 'x'])
    expect(boardSlicesOf({ ok: true, slices: { items: bad } })?.items).toBeUndefined()
  // Beside the node's own only on a node that is no master itself.
  const slices = { items: [it('@hermes:a', 'hermes')] }
  expect(nodeSlicesView(slices, { self: 'mac', ownTeam: false, ownDevices: false, online: true }).items).toEqual(
    slices.items,
  )
  expect(nodeSlicesView(slices, { self: 'mac', ownTeam: false, ownDevices: true, online: true }).items).toBeUndefined()
})

test("the master's own page keeps its nodes' sessions by their prefixed keys, as before", async () => {
  const pair = await nodePair({ count: 1, masterPanes: () => [] })
  const [n] = pair.nodes as [PairNode]
  await pair.waitDevice(n.id, d => d.link?.state === 'online', 10_000)
  // The master (no node of anyone's) lists its nodes' sessions by their prefixed keys as before.
  const keys = await until('the master shows the node', async () => {
    const got = (await itemsOf(pair.master.url)).map(i => i.key)
    return got.some(k => k.startsWith(`@${n.id}:`)) ? got : null
  })
  expect(keys.every(k => k.startsWith(`@${n.id}:`))).toBe(true)
}, 30_000)
