// A node's page and its master's decisions, end to end (#784): a master with decisions on and one
// node, each a real board with a fake herdr. A node session asks a question with options up the
// uplink (as `board ask --option` does there) and its card carries what the master holds:
// - the node's page shows it as the master has it, its default the master's; Hold on the master
//   shows there as held, with no default left to count down;
// - the owner's answer typed in the node session's terminal (the hook's note on the card) is in the
//   master's record as the owner's, not withdrawn, and the question leaves the node's page.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { masterHeld } from '../../src/core/decisions.ts'
import { callBoard } from '../../src/entrypoints/node-call.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'

const S = '7a1f3c2e-5b6d-4e8f-9a0b-1c2d3e4f5a6c'
const QUESTION = 'Merge now or after the review?'
const HEADERS = { 'content-type': 'application/json', 'x-board': '1' }

async function until<T>(what: string, f: () => Promise<T | null | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`never came: ${what}`)
    await Bun.sleep(50)
  }
}

interface Row {
  key: string
  id: string | null
  defaultAt: number | null
  held: boolean
}
interface Board {
  items: { key: string; decision?: { id: string; defaultAt?: number; held?: number } }[]
  decisions?: { items: Row[]; defaulted: unknown[] }
}

const board = async (url: string): Promise<Board> => (await (await fetch(`${url}/api/board`)).json()) as Board

test("a node's page shows the question its master holds as the master has it; the owner's typed answer is the master's record", async () => {
  const pair = await nodePair({
    count: 1,
    masterCfg: { decisions: true },
    masterPanes: () => [],
    panes: (_id, box) => [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
    ],
  })
  const node = pair.nodes[0] as PairNode
  const master = pair.master.url
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const remote = `@${node.id}:${S}`
  await until('the master sees the node session', async () =>
    (await board(master)).items.some(i => i.key === remote) ? true : null,
  )
  await until('the node has decisions on, by its master', async () => ((await board(node.url)).decisions ? true : null))

  // The node session asks, as `board ask --option` there does, and its card carries what the master holds.
  const port = Number(new URL(node.url).port)
  const asked = await until('the master takes the question', async () => {
    const a = await callBoard(port)({
      cmd: 'ask',
      argv: [
        '--option',
        'Merge now',
        '--option',
        'After review',
        '--recommend',
        '1',
        '--default-after',
        '2h',
        '--',
        QUESTION,
      ],
      session: S,
      lane: null,
      files: [],
    })
    return a?.state === 'answered' && a.code === 0 && a.decision ? a.decision : null
  })
  writeFileSync(
    join(node.box.cards, `${S}.json`),
    JSON.stringify({ key: S, ask: QUESTION, askSince: Date.now(), by: 'agent', decision: masterHeld(asked) }),
  )

  // The node's page: the master's question with its default, on the card and in the queue.
  const open = await until('the node page shows the master question', async () => {
    const b = await board(node.url)
    const row = b.decisions?.items.find(r => r.key === S && r.id === asked.id)
    return row ? { row, item: b.items.find(i => i.key === S) } : null
  })
  expect(open.row.defaultAt).toBe(asked.defaultAt ?? null)
  expect(open.item?.decision?.defaultAt).toBe(asked.defaultAt)

  // Hold on the master: the node's page says held, and no default counts down there.
  const hold = await fetch(`${master}/api/decisions`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ op: 'hold', key: remote, id: asked.id }),
  })
  expect(hold.status).toBe(200)
  const held = await until('the node page shows it held', async () => {
    const b = await board(node.url)
    const row = b.decisions?.items.find(r => r.key === S && r.id === asked.id)
    return row?.held ? { row, item: b.items.find(i => i.key === S) } : null
  })
  expect(held.row.defaultAt).toBeNull()
  expect(held.item?.decision?.held).toBeDefined()
  expect(held.item?.decision?.defaultAt).toBeUndefined()

  // The owner types the answer in the node session's terminal: the hook clears the card and notes it.
  writeFileSync(
    join(node.box.cards, `${S}.json`),
    JSON.stringify({ key: S, by: 'agent', decisionAnswer: { id: asked.id, answer: 'After review', at: Date.now() } }),
  )
  // The master waits a minute after the question for the node's card to show it (NODE_SETTLE_MS):
  // its copy is made older here instead of waiting.
  const copy = readdirSync(pair.master.box.cards).find(f => f.includes(S)) as string
  const path = join(pair.master.box.cards, copy)
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), askSince: Date.now() - 120_000 }))
  const record = await until('the master records the owner answer', async () => {
    const r = (await (await fetch(`${master}/api/decisions`, { headers: HEADERS })).json()) as {
      done?: { id: string; answer: string | null; answeredBy: string | null; via: string | null }[]
    }
    return r.done?.find(d => d.id === asked.id && d.answeredBy !== null)
  })
  expect(record).toMatchObject({ answer: 'After review', answeredBy: 'owner', via: 'prompt' })
  await until('the question leaves the node page', async () =>
    (await board(node.url)).decisions?.items.some(r => r.key === S) === false ? true : null,
  )
}, 90_000)
