// Statuses reach the master's payload on running boards (#500): a master and its node as sandbox
// boards (test/support/node-pair.ts). The node's status, asked every paced status interval, puts
// its figures in `devices` without the node's payload or the link's state moving, and this
// computer's own row has a status of its own.
import { expect, test } from 'bun:test'
import type { BoardPayload } from '../../src/core/payload.ts'
import { nodePair, STATUS_MS } from '../support/node-pair.ts'

async function devices(url: string): Promise<NonNullable<BoardPayload['devices']>> {
  const res = await fetch(`${url}/api/board`)
  return ((await res.json()) as BoardPayload).devices ?? []
}

test("the node's status and this computer's own reach the payload with nothing else moving", async () => {
  const pair = await nodePair()
  // Online, its payload in: from here on neither the node's payload nor the link's state moves.
  const online = await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.payloadAt !== null, 15_000)
  const deadline = Date.now() + STATUS_MS * 10
  let row = (await devices(pair.master.url)).find(d => d.id === 'server-1')
  while (!row?.status && Date.now() < deadline) {
    await Bun.sleep(25)
    row = (await devices(pair.master.url)).find(d => d.id === 'server-1')
  }
  expect(row?.status?.id).toBe('server-1')
  expect(row?.status?.sessions).toEqual({ awake: 1, working: 0, asleep: 0 })
  expect((await pair.devices()).find(d => d.id === 'server-1')?.payloadAt).toBe(online.payloadAt)
  const local = (await devices(pair.master.url)).find(d => d.id === 'local')
  expect(local?.status?.id).toBe('laptop')
  expect(local?.status?.sessions).toEqual({ awake: 0, working: 0, asleep: 0 })
}, 60_000)
