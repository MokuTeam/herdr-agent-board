// The board's HTTP MCP on a node (#813): a call is the board command on the node, so what the command
// sends to the master goes up the same uplink and relay. A thread made by the node's session through
// /mcp is the master's. With the master away each call answers as the command does there: a thread
// write is kept and reaches the master once it is back (#774's hold), a message is refused at once.
import { expect, test } from 'bun:test'
import { boardConfig, tool } from '../support/mcp-client.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'

type Threads = { threads: { key: string; title: string }[] }

test("a node's session through /mcp: the master's threads, and with the master away the command's own answers", async () => {
  const pair = await nodePair({ masterCfg: { threads: true }, masterPanes: () => [] })
  const node = pair.nodes[0] as PairNode
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  boardConfig(node.box, node.url, { node: { id: node.id, port: node.doorPort, workRoot: node.box.dir } })
  const me = { 'x-board-pane': 'p1' }
  const masterThreads = async (): Promise<Threads['threads']> =>
    ((await (await fetch(`${pair.master.url}/api/threads`)).json()) as Threads).threads

  const made = await tool(node.url, 'thread', { op: 'new', title: 'From the node MCP' }, me)
  expect(made, made.text).toMatchObject({ error: false })
  const key = /([a-z0-9-]+-\d+)/.exec(made.text)?.[1] ?? ''
  expect(key).not.toBe('')
  expect((await masterThreads()).find(t => t.key === key)?.title).toBe('From the node MCP')
  expect((await tool(node.url, 'threads', { op: 'list' }, me)).text).toContain(key)

  await node.proxy.cut('drop')
  await pair.waitDevice(node.id, d => d.link?.state !== 'online', 10_000)
  const kept = await tool(node.url, 'thread', { op: 'new', title: 'While away' }, me)
  expect(kept).toEqual({ error: false, text: "kept, goes to the board's computer when it is reachable" })
  const send = await tool(node.url, 'agents', { op: 'send', to: 'anna', message: 'hello' }, me)
  expect(send.error, send.text).toBe(true)

  node.proxy.restore()
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const deadline = Date.now() + 20_000
  while (!(await masterThreads()).some(t => t.title === 'While away') && Date.now() < deadline) await Bun.sleep(100)
  expect((await masterThreads()).filter(t => t.title === 'While away')).toHaveLength(1)
}, 90_000)
