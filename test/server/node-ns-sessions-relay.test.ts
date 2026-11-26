// The NetSuite session store through the master relay (#860) on running boards: a master and one
// node (test/support/node-pair.ts), each with a MokuTab bridge data dir in its home. The node's
// bridge reaches the master's store through its own board; the node checks its own token, which
// never travels; the master's bridge takes what the node published. No cookie value in either
// board's log, payload, journal or list. The link down: 503, "no store". A board without node
// keeps a store of its own and writes no token where there is no bridge.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nsFingerprint } from '../../src/core/ns-sessions.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'
import type { Sandbox } from '../support/sandbox.ts'
import { sandbox } from '../support/sandbox.ts'

const SECRET = 'fake-relay-jsessionid-41c9'
const NEWER = 'fake-relay-jsessionid-8d07'
const ROUTING = 'fake-relay-routing-value'
const ACCOUNT = '1234567_SB1'
const USER = 'agent@example.com'

const bridgeDir = (box: Sandbox, profile: string): string =>
  join(box.env.HOME as string, 'browser', 'state', profile, 'state', 'mcp-chrome-bridge')
const makeBridge = (box: Sandbox, profile: string): void => void mkdirSync(bridgeDir(box, profile), { recursive: true })
const tokenOf = (box: Sandbox, profile: string): string =>
  readFileSync(join(bridgeDir(box, profile), 'ns-store-token'), 'utf8').trim()

const entry = (value: string, machine: string) => ({
  account: ACCOUNT,
  user: USER,
  host: '1234567-sb1.app.netsuite.com',
  cookies: [
    {
      name: 'JSESSIONID',
      value,
      domain: '1234567-sb1.app.netsuite.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    { name: 'NS_ROUTING_VERSION', value: ROUTING, domain: '.1234567-sb1.app.netsuite.com', path: '/' },
  ],
  origin: { machine, profile: 'work' },
})

const call = async (
  url: string,
  method: 'GET' | 'POST',
  path: string,
  o: { body?: unknown; token?: string } = {},
): Promise<{ status: number; text: string; json: Record<string, unknown> | unknown[] | null }> => {
  const res = await fetch(`${url}/api/ns-sessions/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-board': '1',
      ...(o.token && { 'x-ns-store-token': o.token }),
    },
    ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

async function until<T>(what: string, f: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await Bun.sleep(50)
  }
}

test("a node's bridge reaches the master's store through its own board; values stay out of logs, payload and journal", async () => {
  const pair = await nodePair({
    count: 1,
    masterCfg: { journal: true },
    masterPanes: () => [],
    masterSetup: box => makeBridge(box, 'main'),
    nodeSetup: (_id, box) => makeBridge(box, 'work'),
  })
  const node = pair.nodes[0] as PairNode
  const master = pair.master.url
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  // Each board wrote its own bridge's token at its start.
  const nodeToken = tokenOf(node.box, 'work')
  const masterToken = tokenOf(pair.master.box, 'main')
  expect(nodeToken).not.toBe(masterToken)

  // The node checks its token itself: nothing goes up without it.
  expect((await call(node.url, 'POST', 'entry', { body: entry(SECRET, 'laptop') })).status).toBe(401)
  expect((await call(node.url, 'POST', 'entry', { body: entry(SECRET, 'laptop'), token: masterToken })).status).toBe(
    401,
  )
  const published = await until('the node publishes through the relay', async () => {
    const r = await call(node.url, 'POST', 'entry', { body: entry(SECRET, 'laptop'), token: nodeToken })
    return r.status === 200 ? r : null
  })
  expect(published.json).toEqual({ ok: true, fp: nsFingerprint(SECRET), generation: 1, state: 'live' })

  // The master holds it: its own bridge takes it with its own token; the node's token is no use there.
  expect((await call(master, 'GET', `entry?account=${ACCOUNT}&user=${USER}`, { token: nodeToken })).status).toBe(401)
  const taken = await call(master, 'GET', `entry?account=${ACCOUNT}&user=${USER}`, { token: masterToken })
  expect(taken.status).toBe(200)
  expect((taken.json as { cookies: { value: string }[] }).cookies.map(c => c.value)).toContain(SECRET)

  // A hand login on the master's side is newer; the node takes that one, and its old one is stale.
  expect(
    (await call(master, 'POST', 'entry', { body: entry(NEWER, 'server-2'), token: masterToken })).json,
  ).toMatchObject({
    generation: 2,
  })
  const back = await call(node.url, 'GET', `entry?account=${ACCOUNT}`, { token: nodeToken })
  expect(back.status).toBe(200)
  expect(back.json).toMatchObject({ fp: nsFingerprint(NEWER), generation: 2 })
  const stale = await call(node.url, 'POST', 'entry', { body: entry(SECRET, 'laptop'), token: nodeToken })
  expect(stale.status).toBe(409)
  expect(stale.json).toMatchObject({ error: 'stale' })

  // Metadata calls need no token; the lock is one for both machines.
  expect(
    (
      await call(node.url, 'POST', 'touch', {
        body: { account: ACCOUNT, user: USER, fp: nsFingerprint(NEWER), where: 'laptop/work' },
      })
    ).status,
  ).toBe(204)
  const held = await call(node.url, 'POST', 'lock', {
    body: { account: ACCOUNT, user: USER, holder: 'laptop/work', ttl_s: 60 },
  })
  expect(held.status).toBe(200)
  const refused = await call(master, 'POST', 'lock', {
    body: { account: ACCOUNT, user: USER, holder: 'server-2/main' },
  })
  expect(refused.status).toBe(423)
  expect(refused.json).toMatchObject({ holder: 'laptop/work' })
  expect(
    (await call(node.url, 'POST', 'unlock', { body: { account: ACCOUNT, user: USER, holder: 'laptop/work' } })).status,
  ).toBe(204)
  expect(
    (await call(master, 'POST', 'lock', { body: { account: ACCOUNT, user: USER, holder: 'server-2/main' } })).status,
  ).toBe(200)

  // The list, read on either board: the master's one entry, metadata only.
  const lists = [await call(node.url, 'GET', 'list'), await call(master, 'GET', 'list')]
  for (const l of lists) {
    expect(l.status).toBe(200)
    expect(l.json).toMatchObject([
      { account: ACCOUNT, user: USER, state: 'live', fp: nsFingerprint(NEWER), holders: ['laptop', 'server-2'] },
    ])
  }

  // No value anywhere it could leak: either board's log, payload or journal, the master's admin log.
  const seen = [
    ...lists.map(l => l.text),
    await (await fetch(`${master}/api/board`)).text(),
    await (await fetch(`${node.url}/api/board`)).text(),
    await (await fetch(`${master}/api/journal?since=0`)).text(),
    await (await fetch(`${master}/api/links/log`)).text(),
    JSON.stringify(pair.master.proc.messages),
    JSON.stringify(node.proc.messages),
  ]
  for (const text of seen) {
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(NEWER)
    expect(text).not.toContain(ROUTING)
    expect(text).not.toContain(nodeToken)
    expect(text).not.toContain(masterToken)
  }
  // The master's log says what happened, by fingerprint and machine.
  expect(JSON.stringify(pair.master.proc.messages)).toContain(
    `${ACCOUNT} published fp ${nsFingerprint(SECRET)} gen 1 by laptop/work (via ${node.id})`,
  )

  // The link down: 503 from the node, which the bridge reads as no store.
  await node.proxy.cut('drop')
  const away = await until('the node says the master is away', async () => {
    const r = await call(node.url, 'GET', 'list')
    return r.status === 503 ? r : null
  })
  expect((away.json as { error: string }).error).toBe('node-master-offline')
}, 90_000)

test('a board without node keeps its own store, and writes no token where there is no bridge', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  expect(existsSync(join(box.env.HOME as string, 'browser'))).toBe(false)
  expect((await call(url, 'POST', 'entry', { body: entry(SECRET, 'laptop') })).status).toBe(401)
  const list = await call(url, 'GET', 'list')
  expect(list).toMatchObject({ status: 200, json: [] })
}, 30_000)
