// A node's cards in the master's payload on running boards (#500): a master and its nodes as sandbox
// boards (test/support/node-pair.ts), each with a fake herdr of its own.
// - pane-1 on three devices stays three cards; a node's schedule entries ride along; `devices`.
// - The item list stays local: the master's scheduler, auto-compact and Workdesk watcher run with a
//   node's card in the payload, and the master's fake herdr sees no call for it, no thread names
//   it, and no topology does. A reminder for it goes to the node's door (#501), never to herdr here.
// - The offline copy: after a restart of the master with the node gone, its cards show with the
//   time they are from. The node's fsToken is in none of the payload, the log, snapshot.json.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { type FakePane, nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { type Child, type Sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

const REMOTE = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const LOCAL = '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e40'
/** The node's pane, an id no pane of the master's has. */
const NODE_PANE = 'w9:p77'

const shellPane = (box: Sandbox, name: string): FakePane => ({
  pane_id: '1',
  agent: 'claude',
  agent_status: 'idle',
  cwd: box.dir,
  terminal_title_stripped: name,
})
const claudePane = (box: Sandbox, sid: string, id: string): FakePane => ({
  pane_id: id,
  agent: 'claude',
  agent_session: { value: sid },
  agent_status: 'idle',
  cwd: box.dir,
})

async function board(url: string): Promise<BoardPayload> {
  const res = await fetch(`${url}/api/board`)
  if (!res.ok) throw new Error(`GET /api/board: ${res.status}`)
  return (await res.json()) as BoardPayload
}

/** The payload once `ok` says yes, waited for. */
async function boardWhen(url: string, ok: (p: BoardPayload) => boolean, ms = 15_000): Promise<BoardPayload> {
  const deadline = Date.now() + ms
  let last: BoardPayload | null = null
  for (;;) {
    last = await board(url)
    if (ok(last)) return last
    if (Date.now() > deadline)
      throw new Error(`the payload never came to that: ${JSON.stringify(last.items.map(i => i.key))}`)
    await Bun.sleep(50)
  }
}

const keys = (p: BoardPayload): string[] => p.items.map(i => i.key)
const logs = (proc: Child): string => proc.messages.map(m => (m as { log?: string }).log ?? '').join('\n')

/** A schedule entry written as the store writes one; the board's folder watch sees it. */
function entry(box: Sandbox, e: Record<string, unknown>): string {
  const dir = join(stateFolder(box), 'schedule')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${e.id}.json`)
  writeFileSync(file, JSON.stringify({ created: Date.now(), ...e }))
  return file
}

describe('a node in the master payload', () => {
  test('pane-1 on three devices stays three cards; the node schedule entries ride along; devices', async () => {
    const pair = await nodePair({
      count: 2,
      panes: (id, box) => [shellPane(box, `shell ${id}`)],
      masterPanes: box => [shellPane(box, 'shell laptop')],
    })
    const [one] = pair.nodes
    if (!one) throw new Error('no node')
    entry(one.box, { id: 'a1b2c3', key: 'pane-1', text: 'look again', next: Date.now() + 3_600_000 })
    const p = await boardWhen(
      pair.master.url,
      b => keys(b).length === 3 && b.schedules.some(e => e.id === '@server-1:a1b2c3'),
    )
    expect(p.items.map(i => [i.key, i.device ?? null, i.name])).toEqual([
      ['pane-1', null, 'shell laptop'],
      ['@server-1:pane-1', 'server-1', 'shell server-1'],
      ['@server-2:pane-1', 'server-2', 'shell server-2'],
    ])
    expect(p.schedules.map(e => [e.id, e.key, e.device])).toEqual([
      ['@server-1:a1b2c3', '@server-1:pane-1', 'server-1'],
    ])
    expect(p.devices?.map(d => [d.id, d.link?.state ?? null])).toEqual([
      ['server-1', 'online'],
      ['server-2', 'online'],
      ['local', null],
    ])
  }, 60_000)

  test('the scheduler, auto-compact and Workdesk on the master never act on a node card', async () => {
    const fake = mcp(mkdtempSync(join(tmpdir(), 'node-workdesk-')))
    // A task for the project whose master is named as the node's session is: were the node's card
    // in the board's own list, the watcher would hand the task to it.
    fake.write({ tasks: [{ ...task(31), executor_model: 'claude-opus' }], topology: true })
    const pair = await nodePair({
      panes: (_id, box) => {
        // The node's session is far past the master's auto-compact limit: were its card in the
        // master's own list, the master would type /compact into it.
        const dir = join(stateFolder(box), 'context')
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, `${REMOTE}.json`),
          JSON.stringify({ at: Date.now() + 60_000, tokens: 150_000, size: 200_000 }),
        )
        return [{ ...claudePane(box, REMOTE, NODE_PANE), terminal_title_stripped: 'Remote-master' }]
      },
      masterPanes: box => [claudePane(box, LOCAL, '2')],
      masterCfg: {
        compact: { at: '1k' },
        compactTickSec: 0.2,
        scheduleTickSec: 0.2,
        threads: true,
        workdesk: {
          ...fake.config,
          masters: { Board: 'Remote-master' },
          intervalSec: 1,
          topology: { deviceId: 'mac' },
        },
      },
    })
    const remoteKey = `@server-1:${REMOTE}`
    const shown = await boardWhen(pair.master.url, b => keys(b).includes(remoteKey))
    expect(shown.items.find(i => i.key === remoteKey)?.context).toBe(150_000)
    // Due now, for the node's card: the master's scheduler must not take it for one of its own. It
    // goes to the node as the page's message does (#501), and the node's board types it there.
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    entry(pair.master.box, { id: 'b1b2b3', key: remoteKey, text: 'ping', next: Date.now() - 1000 })
    await until(() => node.proxy.requests.includes(`POST /api/session/${REMOTE}/message`), 10_000)
    const heartbeats = () => fake.calls('board_heartbeat').length
    const seen = heartbeats()
    await until(() => heartbeats() >= seen + 2, 10_000)

    const calls = pair.master.box.calls().flat().join('\n')
    for (const word of [REMOTE, '@server-1', NODE_PANE, 'ping', '/compact'])
      expect([word, calls.includes(word)]).toEqual([word, false])
    const topology = JSON.stringify(fake.calls('board_heartbeat').map(c => c.params.arguments))
    expect(topology).not.toContain(REMOTE)
    expect(topology).not.toContain('@server-1')
    const threads = JSON.stringify(rows(join(stateFolder(pair.master.box), 'board.db')))
    expect(threads).not.toContain(REMOTE)
    // The node's card is still on the master's board, as a card of the node.
    expect((await board(pair.master.url)).items.find(i => i.key === remoteKey)?.device).toBe('server-1')
  }, 60_000)

  test('opt-in Workdesk routing keeps the thread on the master and delivers it to the online node', async () => {
    const fake = mcp(mkdtempSync(join(tmpdir(), 'node-workdesk-routing-')))
    fake.write({ tasks: [task(31)], topology: true })
    const pair = await nodePair({
      panes: (_id, box) => [{ ...claudePane(box, REMOTE, NODE_PANE), terminal_title_stripped: 'Remote-master' }],
      masterPanes: box => [claudePane(box, LOCAL, '2')],
      masterCfg: {
        threads: true,
        workdesk: {
          ...fake.config,
          masters: { Board: 'Remote-master' },
          intervalSec: 1,
          topology: { deviceId: 'test-master' },
          routeNodeMasters: true,
        },
      },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const masterDb = join(stateFolder(pair.master.box), 'board.db')
    await until(() => rows(masterDb).length === 1, 10_000)
    const [thread] = rows(masterDb)
    if (!thread) throw new Error('no Workdesk thread')
    expect(JSON.parse(thread.assignee).key).toBe(`@server-1:${REMOTE}`)
    const view = await fetch(`${pair.master.url}/api/threads/${thread.key}`)
    expect(view.status).toBe(200)
    await until(() => node.proxy.requests.includes(`POST /api/session/${REMOTE}/message`), 10_000)
    expect(fake.calls('claim_task').map(call => call.params.arguments)).toEqual([
      { task_id: 31, executor: 'Remote-master' },
    ])
    expect(rows(join(stateFolder(node.box), 'board.db'))).toHaveLength(0)
    expect(JSON.stringify(fake.calls('board_heartbeat'))).not.toContain(REMOTE)
    expect(pair.master.box.calls().flat().join('\n')).not.toContain(NODE_PANE)
  }, 60_000)

  test('the offline copy shows the node cards after a restart; its fsToken is nowhere', async () => {
    const pair = await nodePair()
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const remoteKey = '@server-1:s-server-1'
    const before = await boardWhen(pair.master.url, b => keys(b).includes(remoteKey))
    const canary = (await board(node.url)).fsToken
    expect(canary.length).toBeGreaterThan(8)
    const snapshot = join(stateFolder(pair.master.box), 'nodes', 'server-1', 'snapshot.json')
    await until(() => existsSync(snapshot), 5000)
    const heardAt = before.devices?.find(d => d.id === 'server-1')?.payloadAt ?? 0
    expect(heardAt).toBeGreaterThan(0)
    for (const text of [JSON.stringify(before), readFileSync(snapshot, 'utf8'), logs(pair.master.proc)])
      expect(text).not.toContain(canary)

    // The master stops; the node goes; the master starts again on the same folders.
    pair.master.proc.kill()
    await pair.master.proc.exited
    await node.proxy.cut('drop')
    const again = await serveBoard(
      pair.master.box,
      {
        language: 'en',
        nodes: {
          id: 'laptop',
          devices: { 'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` } } },
        },
      },
      PAIR_ENV,
    )
    const after = await boardWhen(again.url, b => keys(b).includes(remoteKey), 5000)
    const device = after.devices?.find(d => d.id === 'server-1')
    expect(device?.link?.state).not.toBe('online')
    expect(device?.payloadAt).toBe(readJsonAt(snapshot))
    expect(after.items.find(i => i.key === remoteKey)?.device).toBe('server-1')
    expect(JSON.stringify(after)).not.toContain(canary)
    expect(logs(again.proc)).not.toContain(canary)
  }, 60_000)
})

const readJsonAt = (file: string): number => (JSON.parse(readFileSync(file, 'utf8')) as { at: number }).at
