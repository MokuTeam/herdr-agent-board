// Epic #763 acceptance fixes A (#797) on running boards: a master with threads on and one node
// (test/support/node-pair.ts). On main the node's page had no threads (its payload had no
// `threads`), a plain terminal there was told to run `board thread list` from a session, the
// master's flags said nothing of verified done or sharing, and the node's page had to wait for its
// payload (a tab in the background never asked) to learn where the master is. Now:
// - the node's payload carries the master's threads revision and count, and the flags say verify
//   and share;
// - a terminal with no session reads threads on the master as the owner (POST /api/node-cli), and
//   a write is still refused there;
// - the node's page carries its master in a meta tag.
// And a board without node serves the same page and payload as before.
import { expect, test } from 'bun:test'
import { callBoardAsOwner } from '../../src/entrypoints/node-call.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'

async function until<T>(what: string, f: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await Bun.sleep(50)
  }
}

const board = async (url: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>

test("a node shows the master's threads, reads them from a plain terminal, and its page knows the master", async () => {
  const pair = await nodePair({ count: 1, masterCfg: { threads: true }, masterPanes: () => [] })
  const node = pair.nodes[0] as PairNode
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)

  // The page's threads: the master's revision and count, through its slices.
  const payload = await until('the node payload has threads', async () => {
    const b = await board(node.url)
    return b.threads && b.masterFlags ? b : null
  })
  const masterThreads = (await board(pair.master.url)).threads as { rev: number; needsOwner: number }
  expect(payload.threads).toMatchObject({ rev: masterThreads.rev, needsOwner: masterThreads.needsOwner })
  // The flags say verified done and sharing, so the node's Settings shows both as the master has them.
  expect((payload.masterFlags as { threads?: unknown }).threads).toMatchObject({ verify: false, share: true })
  // The list itself through the relay, as the page reads it.
  const list = await fetch(`${node.url}/api/threads?closed=1`)
  expect(list.status).toBe(200)

  // A plain terminal on the node: the reads as the owner, on the master; a write still needs a session.
  const owner = callBoardAsOwner(Number(new URL(node.url).port))
  const listed = await owner({ cmd: 'thread', argv: ['list', '--json'] })
  expect(listed).toMatchObject({ state: 'answered', code: 0 })
  expect(listed?.state === 'answered' && JSON.parse(listed.out.join('\n')).ok).toBe(true)
  const posted = await owner({ cmd: 'thread', argv: ['post', 'atlas-1', 'x'] })
  expect(posted?.state === 'answered' && posted.code).not.toBe(0)

  // The node's page carries its master, so a tab in the background goes there without its payload.
  expect(payload.nodeMaster).toBeTruthy()
  const page = await (await fetch(`${node.url}/`)).text()
  const tag = /<meta name="board-node-master" content="([^"]*)">/.exec(page)
  expect(tag).not.toBeNull()
  expect(JSON.parse((tag?.[1] ?? '').replaceAll('&quot;', '"').replaceAll('&amp;', '&'))).toMatchObject({
    nodeId: (payload.nodeMaster as { nodeId: string }).nodeId,
  })
  // The master's own page has no such tag.
  expect(await (await fetch(`${pair.master.url}/`)).text()).not.toContain('board-node-master')
}, 90_000)

test('a board without node: no tag in its page, no threads it does not have, thread reads refused as before', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  expect(await (await fetch(`${url}/`)).text()).not.toContain('board-node-master')
  const b = await board(url)
  for (const key of ['threads', 'masterFlags', 'nodeMaster']) expect(key in b).toBe(false)
  const cli = await fetch(`${url}/api/node-cli`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ cmd: 'thread', argv: ['list'] }),
  })
  const unknown = await fetch(`${url}/api/no-such-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: '{}',
  })
  expect(cli.status).toBe(unknown.status)
}, 30_000)
