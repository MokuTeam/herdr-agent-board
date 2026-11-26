// A node's page draws its master's lanes (#923): since #905 it shows the other machines' cards, and
// their lanes are the master's (POST /api/categories goes to the master, #780). On main the node drew
// only its own config's lanes and its own cards', so the master's cards had none there. The master's
// come first, in its order with its titles; a lane only the node has stays after them.
// The device switch on one machine draws that machine's own lanes, as it has them (#923, the owner:
// "when I see the device Mac, I see what lanes it has"): each node gives its own lanes in its
// payload (`ownLanes` beside the master's, else `categories`), the master puts them on the node's row
// in `devices` and its own on its row, and the page draws the picked row's.
import { expect, test } from 'bun:test'
import { boardSlicesOf, lanesWithMaster, nodeSlicesView, withNodeLanes } from '../../src/core/board-slices.ts'
import { nodePart } from '../../src/core/node-items.ts'
import type { BoardCategory, BoardDevice } from '../../src/core/payload.ts'
import type { Item } from '../../src/core/types.ts'
import { deviceLanes } from '../../web/src/models/board-view.ts'
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

  // Its own lanes go up beside them, as its config has them; the master puts them on its row.
  const nodeBoard = (await (await fetch(`${n.url}/api/board`)).json()) as {
    ownLanes?: Lane[]
    devices?: (Pick<BoardDevice, 'id'> & { lanes?: Lane[] })[]
    relayedDevices?: { master: string }
  }
  const ids = (l?: Lane[]) => (l ?? []).map(x => x.id)
  expect(nodeBoard.ownLanes?.find(l => l.id === 'board')?.title).toBe('Local board')
  expect(ids(nodeBoard.ownLanes)).not.toContain('tripio')
  const rows = await until("the master's rows carry each machine's lanes", async () => {
    const got = ((await (await fetch(`${pair.master.url}/api/board`)).json()) as typeof nodeBoard).devices ?? []
    return got.find(d => d.id === n.id)?.lanes?.some(l => l.id === 'mine') ? got : null
  })
  const nodeRow = rows.find(d => d.id === n.id)?.lanes ?? []
  expect(nodeRow.find(l => l.id === 'board')?.title).toBe('Local board')
  expect(ids(nodeRow)).not.toContain('tripio')
  const masterRow = rows.find(d => d.id === 'local')?.lanes ?? []
  expect(ids(masterRow).slice(0, 3)).toEqual(['tripio', 'board', 'client a'])
  expect(ids(masterRow)).not.toContain('mine')

  // On the node's page the master's row is named by its id and has the master's lanes, its own row its own.
  const onNode = await until("the node's page has the rows with lanes", async () => {
    const got = (await (await fetch(`${n.url}/api/board`)).json()) as typeof nodeBoard
    return got.relayedDevices && got.devices?.find(d => d.id === 'local')?.lanes ? got : null
  })
  const masterId = onNode.relayedDevices?.master ?? ''
  expect(onNode.devices?.find(d => d.id === masterId)?.lanes?.find(l => l.id === 'tripio')?.title).toBe('Трипио 100%')
  expect(onNode.devices?.find(d => d.id === 'local')?.lanes?.find(l => l.id === 'board')?.title).toBe('Local board')
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

test("a node's own lanes as its master reads them, and the lanes the device switch draws", () => {
  // A node since #923 gives `ownLanes`; an older one only `categories`; the offline copy keeps `lanes`.
  const cat = (id: string, title: string) => ({ id, title, color: '#123456', paths: ['C:\\Users\\Анна 100%'] })
  const part = nodePart({ items: [], ownLanes: [cat('mine', 'Mine')], categories: [cat('tripio', 'T')] }, 'mac')
  expect(part?.lanes).toEqual([{ id: 'mine', title: 'Mine', color: '#123456' }])
  expect(nodePart({ items: [], categories: [cat('work', 'Работа')] }, 'mac')?.lanes?.map(l => l.id)).toEqual(['work'])
  expect(nodePart({ items: [], lanes: part?.lanes }, 'mac')?.lanes).toEqual(part?.lanes)
  // No lanes, or none that check out: none, as before.
  expect(nodePart({ items: [] }, 'mac')).toEqual({ items: [], launches: [], schedules: [] })
  expect(nodePart({ items: [], categories: [{ id: '' }, 'x'] }, 'mac')?.lanes).toBeUndefined()

  const lane = (id: string, title = id, extra = {}): BoardCategory =>
    ({
      id,
      title,
      color: '#000',
      colorName: 'gray',
      paths: [],
      configured: true,
      fallback: false,
      ...extra,
    }) as BoardCategory
  const payload = [lane('tripio', 'Трипио'), lane('board', 'Борда', { profile: 'work' }), lane('mine', 'mine')]
  const devices = [
    { id: 'local', lanes: [{ id: 'tripio', title: 'Трипио', color: '#000' }] },
    {
      id: 'mac',
      lanes: [
        { id: 'board', title: 'Борда Mac', color: '#f00' },
        { id: 'cv', title: 'CV', color: '#0f0' },
      ],
    },
    { id: 'win-laptop' },
  ]
  const card = (category: string) => ({ key: category, category }) as unknown as Item
  const of = (i: Item) => i.category
  // All devices, a device without lanes (an older node), or none known: the payload's, as before.
  expect(deviceLanes(payload, devices, 'all', [], of)).toBe(payload)
  expect(deviceLanes(payload, devices, 'win-laptop', [], of)).toBe(payload)
  expect(deviceLanes(payload, undefined, 'mac', [], of)).toBe(payload)
  // The Mac picked: its lanes in its order with its titles, the payload's profile kept; a card's lane it lacks after them.
  const mac = deviceLanes(payload, devices, 'mac', [card('mine')], of)
  expect(mac.map(c => [c.id, c.title])).toEqual([
    ['board', 'Борда Mac'],
    ['cv', 'CV'],
    ['mine', 'mine'],
  ])
  expect(mac[0]?.profile).toBe('work')
  expect(mac[1]).toMatchObject({ configured: false, paths: [] })
})
