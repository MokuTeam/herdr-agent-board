// A node's page draws its master's lanes (#923): since #905 it shows the other machines' cards, and
// their lanes are the master's (POST /api/categories goes to the master, #780). On main the node drew
// only its own config's lanes and its own cards', so the master's cards had none there. The master's
// come first, in its order with its titles; a lane only the node has stays after them.
import { expect, test } from 'bun:test'
import { boardSlicesOf, lanesWithMaster, nodeSlicesView, withNodeLanes } from '../../src/core/board-slices.ts'
import type { BoardCategory } from '../../src/core/payload.ts'
import { nodePair } from '../support/node-pair.ts'

type Lane = { id: string; title: string }

const lanesOf = async (url: string): Promise<Lane[]> =>
  (((await (await fetch(`${url}/api/board`)).json()) as { categories?: Lane[] }).categories ?? []).map(c => ({
    id: c.id,
    title: c.title,
  }))

async function until<T>(what: string, f: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await Bun.sleep(50)
  }
}

test("a node's page draws the master's lanes with their titles, then a lane only the node has", async () => {
  const pair = await nodePair({
    env: { BOARD_NODE_SLICES_MS: '200' },
    masterCfg: {
      categories: [
        { id: 'tripio', title: 'Трипио 100%' },
        { id: 'board', title: 'Борда' },
        { id: 'client a', title: 'Client A' },
      ],
    },
    nodeCfg: () => ({
      categories: [
        { id: 'board', title: 'Local board' },
        { id: 'mine', title: 'Mine' },
      ],
    }),
  })
  const [n] = pair.nodes
  if (!n) throw new Error('no node')
  await pair.waitDevice(n.id, d => d.link?.state === 'online', 10_000)
  const master = await lanesOf(pair.master.url)
  expect(master.map(l => l.id)).toEqual(expect.arrayContaining(['tripio', 'board', 'client a']))

  const lanes = await until("the node's page has the master's lanes", async () => {
    const got = await lanesOf(n.url)
    return got.some(l => l.id === 'tripio') ? got : null
  })
  // The master's, as it has them, first; the node's own lane the master lacks after them.
  expect(lanes.slice(0, master.length)).toEqual(master)
  expect(lanes.find(l => l.id === 'board')?.title).toBe('Борда')
  expect(lanes.find(l => l.id === 'mine')?.title).toBe('Mine')
  expect(lanes.filter(l => l.id === 'board')).toHaveLength(1)
}, 60_000)

test('the lanes in the answer to a node, how the node reads them, and how its page draws them', () => {
  const lane = (id: string, title = id): BoardCategory => ({ id, title }) as unknown as BoardCategory
  const master = [lane('tripio', 'Трипио'), lane('board', 'Борда'), lane('other', 'Other')]
  const own = [lane('board', 'Local'), lane('mine', 'Mine'), lane('other', 'Прочее')]
  expect(lanesWithMaster(master, own).map(c => [c.id, c.title])).toEqual([
    ['tripio', 'Трипио'],
    ['board', 'Борда'],
    ['other', 'Other'],
    ['mine', 'Mine'],
  ])
  expect(withNodeLanes({}, master).categories).toEqual(master)
  expect(withNodeLanes({}, [])).toEqual({})

  // An older master's answer has none; a malformed list is not taken.
  expect(boardSlicesOf({ ok: true, slices: { categories: master } })?.categories).toEqual(master)
  expect(boardSlicesOf({ ok: true, slices: {} })).toEqual({})
  for (const bad of [[], [{ id: 'x' }], [{ id: '', title: 'x' }], [{ id: 1, title: 'x' }], 'x'])
    expect(boardSlicesOf({ ok: true, slices: { categories: bad } })?.categories).toBeUndefined()

  // Into a node's payload only on a node that is no master itself.
  const view = (ownDevices: boolean) =>
    nodeSlicesView({ categories: master }, { self: 'mac', ownTeam: false, ownDevices, online: true }).categories
  expect(view(false)).toEqual(master)
  expect(view(true)).toBeUndefined()
})
