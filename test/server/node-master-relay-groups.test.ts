// The master relay's T4a groups on running boards (#780, epic #763): a master with time, calendar,
// journal and presence on, and one node (test/support/node-pair.ts). On main the node answered all of
// these from its own config.json, which the handover leaves without them (409 "off", or its own
// empty values); now:
// - each group is the master's from the node's page: presence, calendar, journal and time read and
//   written up the relay; the features' settings and the categories land in the master's config.json;
// - the node's payload carries the master's time, calendar, journal and presence (GET
//   /api/board-slices over the relay), so its page shows those panels;
// - a terminal with no session on the node runs board presence / cats / time as the owner
//   (POST /api/node-cli over the relay); a file-carrying command is left to a session;
// - the two relay-only paths are no routes on the master itself;
// - the link down: 503 node-master-offline, the CLI says the board's computer is not reachable,
//   and the page keeps the parts it last had.
// And a board without node answers as before.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callBoardAsOwner } from '../../src/entrypoints/node-call.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
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

const getJson = async (url: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const MASTER_CFG = {
  time: { on: true, zone: 'UTC' },
  calendar: true,
  journal: true,
  presence: { mode: 'off' },
}

const S = '7a1f3c2e-5b6d-4e8f-9a0b-1c2d3e4f5a6b'

test("a node's page and its sessionless terminal reach the master's time, calendar, journal, presence and settings", async () => {
  const pair = await nodePair({
    count: 1,
    masterCfg: MASTER_CFG,
    masterPanes: () => [],
    panes: (_id, box) => [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
    ],
  })
  const node = pair.nodes[0] as PairNode
  const master = pair.master.url
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)

  // Presence: read as the master has it, switched from the node.
  const seen = await until('the node reads the master presence', async () => {
    const r = await getJson(`${node.url}/api/presence`)
    return r.status === 200 && r.body.presence ? r.body : null
  })
  expect(seen).toEqual((await getJson(`${master}/api/presence`)).body)
  expect((await post(`${node.url}/api/presence`, { state: 'away' })).status).toBe(200)
  expect(((await getJson(`${master}/api/presence`)).body.presence as { state: string }).state).toBe('away')

  // Calendar: an event made from the node is the master's, and the node reads it back.
  const start = new Date(Date.now() + 3_600_000).toISOString()
  const end = new Date(Date.now() + 5_400_000).toISOString()
  const made = await post(`${node.url}/api/calendar`, { op: 'add', title: 'Relay check ☃ 100%', start, end })
  expect(made.status).toBe(200)
  const window = `from=${Date.now()}&to=${Date.now() + 86_400_000}`
  const titles = async (base: string): Promise<string[]> =>
    (((await getJson(`${base}/api/calendar?${window}`)).body.events ?? []) as { title: string }[]).map(e => e.title)
  expect(await titles(master)).toContain('Relay check ☃ 100%')
  expect(await titles(node.url)).toContain('Relay check ☃ 100%')

  // Journal: the master's list, and its strip dismissed from the node.
  const journal = await getJson(`${node.url}/api/journal?since=0`)
  expect(journal.status).toBe(200)
  expect(journal.body.ok).toBe(true)
  expect((await post(`${node.url}/api/journal`, { op: 'dismiss' })).status).toBe(200)

  // Time: the master's settings and today.
  const settings = await getJson(`${node.url}/api/time-settings`)
  expect(settings).toEqual(await getJson(`${master}/api/time-settings`))
  expect((await getJson(`${node.url}/api/time`)).status).toBe((await getJson(`${master}/api/time`)).status)

  // Settings and categories land in the master's config.json (the node's own stays without them).
  expect((await post(`${node.url}/api/feature-settings`, { watches: true })).status).toBe(200)
  expect((await post(`${node.url}/api/categories`, { op: 'create', id: 'atlas', title: 'Atlas' })).status).toBe(200)
  const masterFile = JSON.parse(
    readFileSync(join(pair.master.box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'), 'utf8'),
  )
  expect(masterFile.watches).toBeTruthy()
  expect((masterFile.categories as { id: string }[]).map(c => c.id)).toContain('atlas')
  const updates = await post(`${node.url}/api/self-update`, { op: 'settings', on: false, every: 'day', at: '06:40' })
  expect(updates.status).toBe(200)
  const masterUpdates = await getJson(`${master}/api/self-update`)
  const nodeUpdates = await getJson(`${node.url}/api/self-update`)
  expect(nodeUpdates).toEqual(masterUpdates)
  expect(masterUpdates.body).toMatchObject({
    masterId: expect.any(String),
    node: false,
    config: { on: false, every: 'day', at: '06:40' },
  })
  const nodeFile = Bun.file(join(node.box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'))
  expect((await nodeFile.exists()) ? (await nodeFile.json()).autoUpdate : undefined).toBeUndefined()
  // The settings write is in the master's admin log, as the node's owner's.
  const log = (await getJson(`${master}/api/links/log`)).body as { edges?: Record<string, unknown>[] }
  expect(log.edges?.find(e => e.kind === 'admin' && e.path === '/api/feature-settings')).toMatchObject({
    via: 'relay',
    from: node.id,
    status: 200,
  })
  expect(log.edges?.find(e => e.kind === 'admin' && e.path === '/api/self-update')).toMatchObject({
    via: 'relay',
    from: node.id,
    status: 200,
  })

  // A session of the node reads the master's panels, but never the settings kept for the master's
  // own computer, and writes nothing (the owner's paths only).
  const asSession = { 'x-board-session': S }
  await until('the master knows the node session', async () => {
    const r = await fetch(`${node.url}/api/presence`, { headers: asSession })
    return r.status === 200 ? r : null
  })
  const settingsBySession = await fetch(`${node.url}/api/time-settings`, { headers: asSession })
  expect(settingsBySession.status).toBe(403)
  const updatesBySession = await fetch(`${node.url}/api/self-update`, { headers: asSession })
  expect(updatesBySession.status).toBe(403)
  const cliBySession = await fetch(`${node.url}/api/node-cli`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', ...asSession },
    body: JSON.stringify({ cmd: 'presence', argv: ['away'] }),
  })
  expect(cliBySession.status).toBe(403)
  const slicesBySession = await fetch(`${node.url}/api/board-slices`, { headers: asSession })
  expect(slicesBySession.status).toBe(403)

  // The node's payload carries the master's parts.
  const payload = await until('the node payload has the master parts', async () => {
    const b = (await getJson(`${node.url}/api/board`)).body
    return b.time && b.calendar && b.journal && (b.presence as { state?: string } | undefined)?.state === 'away'
      ? b
      : null
  })
  expect((payload.time as { date: string }).date).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  // A terminal with no session on the node: the owner's, run on the master.
  const port = Number(new URL(node.url).port)
  const owner = callBoardAsOwner(port)
  const here = await owner({ cmd: 'presence', argv: ['here'] })
  expect(here).toEqual({ state: 'answered', code: 0, out: ['ok · here'], err: [] })
  expect(((await getJson(`${master}/api/presence`)).body.presence as { state: string }).state).toBe('here')
  const cats = await owner({ cmd: 'cats', argv: [] })
  expect(cats).toMatchObject({ state: 'answered', code: 0 })
  expect(cats?.state === 'answered' && cats.out.join(' ')).toContain('A new id makes a new lane.')
  const imported = await owner({ cmd: 'time', argv: ['import', 'entries.csv'] })
  expect(imported?.state === 'answered' && imported.code).toBe(126)
  // A command the master takes from no terminal is refused by the node's relay before it goes up.
  const odd = await post(`${node.url}/api/node-cli`, { cmd: 'restart', argv: [] })
  expect(odd.status).toBe(400)

  // The relay-only paths are no routes on the master itself.
  const unknown = (await post(`${master}/api/no-such-path`, {})).status
  expect((await fetch(`${master}/api/board-slices`)).status).toBe(404)
  expect((await post(`${master}/api/node-cli`, { cmd: 'presence', argv: [] })).status).toBe(unknown)

  // The link down: 503, never the node's own "off"; the CLI says so; the page keeps the last parts.
  await node.proxy.cut('drop')
  const away = await until('the node says the master is away', async () => {
    const r = await getJson(`${node.url}/api/journal?since=0`)
    return r.status === 503 ? r : null
  })
  expect(away.body.error).toBe('node-master-offline')
  expect(await owner({ cmd: 'presence', argv: [] })).toEqual({ state: 'unreachable' })
  const kept = (await getJson(`${node.url}/api/board`)).body
  expect(kept.calendar).toBeTruthy()
}, 90_000)

test('a board without node answers its own presence and has no relay-only paths', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  // Presence off, as before: GET null, a switch refused (409).
  expect((await getJson(`${url}/api/presence`)).body).toEqual({ presence: null })
  expect((await post(`${url}/api/presence`, { state: 'away' })).status).toBe(409)
  const unknown = (await post(`${url}/api/no-such-path`, {})).status
  expect((await fetch(`${url}/api/board-slices`)).status).toBe(404)
  expect((await post(`${url}/api/node-cli`, { cmd: 'presence', argv: [] })).status).toBe(unknown)
  const b = (await getJson(`${url}/api/board`)).body
  for (const key of ['time', 'calendar', 'journal', 'presence']) expect(key in b).toBe(false)
}, 30_000)
