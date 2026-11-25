// The master relay on running boards (#764): a master with threads on and two nodes
// (test/support/node-pair.ts); server-1 as every node is by default, server-2 turned off by the
// master's owner (`nodes.devices.server-2.owner: false`).
// - server-1's own web board lists, reads and posts the master's threads, and its events stream
//   carries the master's revision: on main it answered 409 "threads off" from its own config.
// - server-2's is refused (403 master-relay-owner): the switch is the master owner's.
// - The link down: 503 node-master-offline, not the node's 409.
// - A board without `node` answers its own threads as before.
import { expect, test } from 'bun:test'
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

/** The first SSE event named `name` on `res`, within `ms`. */
async function firstEvent(res: Response, name: string, ms = 5000): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), ms)
  let text = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) throw new Error(`stream ended before ${name}: ${text}`)
      text += new TextDecoder().decode(next.value)
      const m = new RegExp(`event: ${name}\\ndata: ([^\\n]*)`).exec(text)
      if (m) return m[1] ?? ''
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
}

test("a node's web board serves the master's threads through the relay, unless the master's owner turned the device off", async () => {
  const pair = await nodePair({
    count: 2,
    masterCfg: { threads: true },
    masterPanes: () => [],
    deviceCfg: id => (id === 'server-2' ? { owner: false } : {}),
  })
  const [meshed, turnedOff] = pair.nodes as [PairNode, PairNode]
  await pair.waitDevice(meshed.id, d => d.link?.state === 'online', 10_000)
  await pair.waitDevice(turnedOff.id, d => d.link?.state === 'online', 10_000)

  const made = await post(`${pair.master.url}/api/threads`, { op: 'new', lane: 'atlas', title: 'Relay check ☃' })
  expect(made.status).toBe(200)
  const key = ((await made.json()) as { key: string }).key

  // The list, as the master has it (the relay's stream may take a moment after the link).
  const list = await until('the node lists the thread', async () => {
    const res = await fetch(`${meshed.url}/api/threads`)
    if (res.status !== 200) return null
    return (await res.json()) as { threads: { key: string; title: string }[] }
  })
  expect(list.threads.map(t => t.key)).toContain(key)

  // A post from the node's page lands in the master's thread, once.
  const posted = await fetch(`${meshed.url}/api/threads/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', 'idempotency-key': 'relay-post-1' },
    body: JSON.stringify({ op: 'post', text: 'from the node' }),
  })
  expect(posted.status).toBe(200)
  const again = await fetch(`${meshed.url}/api/threads/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', 'idempotency-key': 'relay-post-1' },
    body: JSON.stringify({ op: 'post', text: 'from the node' }),
  })
  expect(again.status).toBe(200)
  const one = (await (await fetch(`${pair.master.url}/api/threads/${key}`)).json()) as {
    entries: { text: string }[]
  }
  expect(one.entries.filter(e => e.text === 'from the node')).toHaveLength(1)
  const viaNode = (await (await fetch(`${meshed.url}/api/threads/${key}`)).json()) as { entries: { text: string }[] }
  expect(viaNode.entries.map(e => e.text)).toContain('from the node')

  // The revision stream is the master's.
  const events = await fetch(`${meshed.url}/api/threads/events`)
  expect(events.status).toBe(200)
  expect(JSON.parse(await firstEvent(events, 'rev')).rev).toBeGreaterThan(0)

  // The device the owner turned off.
  const refused = await until('the node turned off is refused by the master', async () => {
    const res = await fetch(`${turnedOff.url}/api/threads`)
    return res.status === 403 ? res : null
  })
  expect(((await refused.json()) as { error: string }).error).toBe('master-relay-owner')

  // The link down.
  await meshed.proxy.cut('drop')
  const away = await until('the node says the master is away', async () => {
    const res = await fetch(`${meshed.url}/api/threads`)
    return res.status === 503 ? res : null
  })
  expect(((await away.json()) as { error: string }).error).toBe('node-master-offline')
}, 60_000)

test('a board without node answers its own threads as before (off: 409)', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  const res = await fetch(`${url}/api/threads`)
  expect(res.status).toBe(409)
}, 30_000)
