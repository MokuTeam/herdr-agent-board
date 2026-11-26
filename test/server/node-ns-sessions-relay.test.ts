// The NetSuite session store through the master relay (#860, contract ns-contract-final.md) on
// running boards: a master and one node (test/support/node-pair.ts), each with a MokuTab data dir
// (~/.mokutab) in its home. Each board writes its bridge's ns-store.json; the node's bridge reaches
// the master's store through its own board (PUT and DELETE too); the node checks its own token,
// which never travels; the master's bridge takes what the node published. No cookie value or token
// in either board's log, payload, journal or list. The link down: 503 store_unavailable. A board
// without node keeps a store of its own and writes nothing where there is no MokuTab.
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
const A = '1234567_SB1'
const U = 'agent@example.com'

const dataDir = (box: Sandbox): string => join(box.env.HOME as string, '.mokutab')
const storeFile = (box: Sandbox): { url: string; token: string; node: string } =>
  JSON.parse(readFileSync(join(dataDir(box), 'ns-store.json'), 'utf8'))

const entry = (value: string, machine: string) => ({
  account: A,
  user: U,
  host: '1234567-sb1.app.netsuite.com',
  role: 'Administrator',
  role_id: 3,
  fp: nsFingerprint(value),
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
  login_at: null,
  seen_at: Date.now(),
})

/** A call as the bridge makes it: its ns-store.json's URL and token, no X-Board. */
const call = async (
  base: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  o: { body?: unknown; token?: string; board?: boolean } = {},
): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-ns-store-client': 'mokutab/test',
      ...(o.token && { 'x-ns-store-token': o.token }),
      ...(o.board && { 'x-board': '1' }),
    },
    ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
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
    masterSetup: box => void mkdirSync(dataDir(box), { recursive: true }),
    nodeSetup: (_id, box) => void mkdirSync(dataDir(box), { recursive: true }),
  })
  const node = pair.nodes[0] as PairNode
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  // Each board wrote its own bridge's file: its own URL, token and name.
  const onNode = storeFile(node.box)
  const onMaster = storeFile(pair.master.box)
  expect(onNode).toEqual({ url: `${node.url}/api/ns-sessions`, token: expect.any(String), node: node.id })
  expect(onMaster).toEqual({ url: `${pair.master.url}/api/ns-sessions`, token: expect.any(String), node: 'laptop' })
  const nodeToken = storeFile(node.box).token
  const masterToken = storeFile(pair.master.box).token
  expect(nodeToken).not.toBe(masterToken)
  const nodeBase = onNode.url
  const masterBase = onMaster.url

  // The node checks its token itself: nothing goes up without it.
  expect((await call(nodeBase, 'PUT', 'entry', { body: entry(SECRET, 'laptop') })).json).toMatchObject({
    code: 'unauthorized',
  })
  expect((await call(nodeBase, 'PUT', 'entry', { body: entry(SECRET, 'laptop'), token: masterToken })).status).toBe(401)
  const published = await until('the node publishes through the relay', async () => {
    const r = await call(nodeBase, 'PUT', 'entry', { body: entry(SECRET, 'laptop'), token: nodeToken })
    return r.status === 200 ? r : null
  })
  expect(published.json).toEqual({ ok: true, stored: true, generation: 1, state: 'live' })

  // The master holds it: its own bridge takes it with its own token; the node's token is no use there.
  expect((await call(masterBase, 'GET', `entry?account=${A}&user=${U}`, { token: nodeToken })).status).toBe(401)
  const taken = await call(masterBase, 'GET', `entry?account=${A}&user=${U}`, { token: masterToken })
  expect(taken.status).toBe(200)
  expect((taken.json.cookies as { value: string }[]).map(c => c.value)).toContain(SECRET)

  // A hand login on the master's side is newer; the node takes that one.
  expect(
    (await call(masterBase, 'POST', 'entry', { body: entry(NEWER, 'server-2'), token: masterToken })).json,
  ).toMatchObject({ stored: true, generation: 2 })
  const back = await call(nodeBase, 'GET', `entry?account=${A}`, { token: nodeToken })
  expect(back.status).toBe(200)
  expect(back.json).toMatchObject({ fp: nsFingerprint(NEWER), generation: 2 })

  // Touch and dead by fp; a dead session is never published again.
  const touched = await call(nodeBase, 'POST', 'touch', {
    body: { account: A, fp: nsFingerprint(NEWER), where: { machine: 'laptop', profile: 'work' }, at: Date.now() },
    token: nodeToken,
  })
  expect(touched.json).toEqual({ ok: true, matched: true, state: 'live' })

  // The lock is one for both machines; DELETE by lock_id goes up the relay too.
  const held = await call(nodeBase, 'POST', 'lock', {
    body: { account: A, user: U, holder: { machine: 'laptop', profile: 'work', run_id: 'r1' }, ttl_s: 60 },
    token: nodeToken,
  })
  expect(held.status).toBe(200)
  const lockId = held.json.lock_id as string
  const refused = await call(masterBase, 'POST', 'lock', {
    body: { account: A, user: U, holder: { machine: 'server-2', profile: 'main', run_id: 'r2' } },
    token: masterToken,
  })
  expect(refused.status).toBe(409)
  expect(refused.json).toMatchObject({ code: 'locked', holder: { machine: 'laptop' } })
  expect(
    (await call(nodeBase, 'DELETE', 'lock', { body: { account: A, user: U, lock_id: lockId }, token: nodeToken })).json,
  ).toEqual({ ok: true })
  const second = await call(masterBase, 'POST', 'lock', {
    body: { account: A, user: U, holder: { machine: 'server-2', profile: 'main', run_id: 'r2' } },
    token: masterToken,
  })
  expect(second.status).toBe(200)
  // POST /unlock goes up the relay too, as DELETE /lock does.
  expect(
    (
      await call(nodeBase, 'POST', 'unlock', {
        body: { account: A, user: U, lock_id: second.json.lock_id },
        token: nodeToken,
      })
    ).json,
  ).toEqual({ ok: true })

  // The list, read on either board, by a bridge or as the board's own call: metadata only.
  const lists = [
    await call(nodeBase, 'GET', 'list', { token: nodeToken }),
    await call(nodeBase, 'GET', 'list', { board: true }),
    await call(masterBase, 'GET', 'list', { board: true }),
  ]
  for (const l of lists) {
    expect(l.status).toBe(200)
    expect(l.json).toMatchObject({
      ok: true,
      entries: [{ account: A, user: U, state: 'live', fp: nsFingerprint(NEWER), holders: ['laptop', 'server-2'] }],
    })
  }

  const dead = await call(nodeBase, 'POST', 'dead', {
    body: {
      account: A,
      fp: nsFingerprint(NEWER),
      reason: 'login_redirect',
      where: { machine: 'laptop', profile: 'work' },
    },
    token: nodeToken,
  })
  expect(dead.json).toEqual({ ok: true, matched: true })
  const again = await call(nodeBase, 'PUT', 'entry', { body: entry(NEWER, 'laptop'), token: nodeToken })
  expect(again.status).toBe(409)
  expect(again.json).toMatchObject({ ok: false, code: 'dead_fp' })

  // No value or token anywhere it could leak: either board's log, payload or journal, the admin log.
  const seen = [
    ...lists.map(l => l.text),
    await (await fetch(`${pair.master.url}/api/board`)).text(),
    await (await fetch(`${node.url}/api/board`)).text(),
    await (await fetch(`${pair.master.url}/api/journal?since=0`)).text(),
    await (await fetch(`${pair.master.url}/api/links/log`)).text(),
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
  // The master's log says what happened, by fingerprint, machine and client.
  expect(JSON.stringify(pair.master.proc.messages)).toContain(
    `${A} published fp ${nsFingerprint(SECRET)} gen 1 by laptop/work [mokutab/test] via ${node.id}`,
  )

  // The link down: 503 store_unavailable from the node, which the bridge reads as no store.
  await node.proxy.cut('drop')
  const away = await until('the node says the store is away', async () => {
    const r = await call(nodeBase, 'GET', 'list', { token: nodeToken })
    return r.status === 503 ? r : null
  })
  expect(away.json).toMatchObject({ ok: false, code: 'store_unavailable' })
}, 90_000)

test('a board without node keeps its own store, and writes nothing where there is no MokuTab', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  expect(existsSync(dataDir(box))).toBe(false)
  expect((await call(`${url}/api/ns-sessions`, 'PUT', 'entry', { body: entry(SECRET, 'laptop') })).status).toBe(401)
  expect((await call(`${url}/api/ns-sessions`, 'GET', 'list', { board: true })).json).toEqual({ ok: true, entries: [] })
}, 30_000)
