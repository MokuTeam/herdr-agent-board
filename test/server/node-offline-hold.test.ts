// Offline node hold (#695): master schedule entries for a session on an offline node wait
// without counting against scheduleWaitMin, deliver in order with lateness or cron collapse when
// the node comes back, and end immediately as missed on revoke, forget, or gone session. A board
// without `nodes` and local sessions behave as before.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createNodeProxy } from '../../src/server/routes/node-proxy.ts'
import { defaultDeps } from '../../src/services/deps.ts'
import { startScheduler } from '../../src/services/scheduler.ts'
import { serveBoard } from '../support/board-server.ts'
import { DEAD_MS, nodePair, PAIR_ENV, type Pair, showPanes } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

setDefaultTimeout(30_000)

const S1 = '@server-1:s-server-1'

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

function writeDiskConfig(box: Sandbox, value: Record<string, unknown>): void {
  const path = configPath(box)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ language: 'en', wakeUrl: '', port: 9, ...value }, null, 2))
}

function nodeHerdr(box: Sandbox, status: 'idle' | 'working' = 'idle'): void {
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'p1',
              agent: 'claude',
              agent_session: { value: 's-server-1' },
              agent_status: status,
              cwd: box.dir,
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent get': {
      result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: 's-server-1' } } },
    },
    'agent read': { text: `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ? for shortcuts` },
    'agent prompt': { result: {} },
  })
}

function putEntry(box: Sandbox, entry: Record<string, unknown>): string {
  const dir = join(stateFolder(box), 'schedule')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${entry.id}.json`)
  writeFileSync(file, JSON.stringify({ key: S1, name: 's-server-1', created: Date.now(), ...entry }))
  return file
}

const readEntry = (box: Sandbox, id: string): Record<string, unknown> | null => {
  const file = join(stateFolder(box), 'schedule', `${id}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null
}

const readRuns = (box: Sandbox): Record<string, unknown>[] => {
  const file = join(stateFolder(box), 'schedule', 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(c => c[0] === 'agent' && c[1] === 'prompt')
    .map(c => c[3] as string)

async function boardJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/api/board`)
  if (!res.ok) throw new Error(`GET /api/board: ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function waitOnline(pair: Pair): Promise<void> {
  await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.payloadAt !== null, 15_000)
  await until(async () => {
    const b = await boardJson(pair.master.url)
    return ((b.items as { key: string }[]) ?? []).some(i => i.key === S1)
  }, 15_000)
}

describe('offline node hold (#695)', () => {
  test('entries held past scheduleWaitMin deliver in order with lateness and show per device', async () => {
    const pair = await nodePair({
      masterPanes: () => [],
      masterCfg: { scheduleTickSec: 0.2, scheduleWaitMin: 0.01 },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await waitOnline(pair)
    nodeHerdr(node.box, 'idle')

    const port = Number(new URL(pair.master.url).port)
    writeDiskConfig(pair.master.box, {
      port,
      nodes: {
        id: 'laptop',
        devices: { 'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` } } },
      },
    })

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)

    const now = Date.now()
    putEntry(pair.master.box, { id: 'a00001', text: 'first offline', at: now - 5 * 60_000, next: now - 5 * 60_000 })
    putEntry(pair.master.box, { id: 'a00002', text: 'second offline', at: now - 3 * 60_000, next: now - 3 * 60_000 })
    putEntry(pair.master.box, {
      id: 'a00003',
      idle: true,
      text: 'third notice',
      at: now - 60_000,
      next: now - 60_000,
      from: { key: 'pane-m', name: 'atlas' },
      replyBy: 'board',
      replyTo: 'atlas [12345678]',
    })

    await until(() => readEntry(pair.master.box, 'a00003')?.why === 'node-offline', 10_000)
    // Longer than scheduleWaitMin (0.01 min = 600 ms): must stay held, never expire.
    await Bun.sleep(1500)
    for (const id of ['a00001', 'a00002', 'a00003']) {
      const e = readEntry(pair.master.box, id)
      expect(e?.why).toBe('node-offline')
      expect(e?.waited).toBeUndefined()
    }
    expect(readRuns(pair.master.box)).toEqual([])
    expect(prompts(node.box)).toEqual([])

    const bHeld = await boardJson(pair.master.url)
    const devBoard = (bHeld.devices as { id: string; held?: number }[]).find(d => d.id === 'server-1')
    const localBoard = (bHeld.devices as { id: string; held?: number }[]).find(d => d.id === 'local')
    expect(devBoard?.held).toBe(3)
    expect(localBoard?.held).toBeUndefined()

    const devRoute = (await pair.devices()).find(d => d.id === 'server-1')
    expect(devRoute?.held).toBe(3)

    const cli = await pair.master.box.run('cli', { args: ['nodes'], env: {} }).exited
    expect(cli.code).toBe(0)
    expect(cli.stdout).toContain('· 3 held')

    node.proxy.restore()
    await until(() => prompts(node.box).length === 3 && readRuns(pair.master.box).length === 3, 15_000)
    const sent = prompts(node.box)
    expect(sent[0]).toMatch(/^\[board reminder; 5 min late, due .+\] first offline$/)
    expect(sent[1]).toMatch(/^\[board reminder; 3 min late, due .+\] second offline$/)
    expect(sent[2]).toMatch(
      /^\[board reminder from atlas; answer with board send "atlas \[12345678\]" "<your answer>"\] third notice$/,
    )
    for (const id of ['a00001', 'a00002', 'a00003']) expect(readEntry(pair.master.box, id)).toBeNull()
    expect(readRuns(pair.master.box).every(r => r.result === 'sent')).toBe(true)

    await until(async () => {
      const bAfter = await boardJson(pair.master.url)
      return (bAfter.devices as { id: string; held?: number }[]).find(d => d.id === 'server-1')?.held === undefined
    }, 10_000)
    expect((await pair.devices()).find(d => d.id === 'server-1')?.held).toBeUndefined()
  }, 60_000)

  test('cron entry held past scheduleWaitMin collapses missed runs into one on return', async () => {
    const pair = await nodePair({
      masterPanes: () => [],
      masterCfg: { scheduleTickSec: 0.2, scheduleWaitMin: 0.01 },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await waitOnline(pair)
    nodeHerdr(node.box, 'idle')

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)

    const top = new Date()
    top.setSeconds(0, 0)
    const dueAt = top.getTime() - 4 * 60_000
    putEntry(pair.master.box, { id: 'c00001', text: 'hourly ping', cron: '* * * * *', next: dueAt })

    await until(() => readEntry(pair.master.box, 'c00001')?.why === 'node-offline', 10_000)
    await Bun.sleep(1500)
    expect(readEntry(pair.master.box, 'c00001')?.why).toBe('node-offline')
    expect(readRuns(pair.master.box)).toEqual([])

    node.proxy.restore()
    await until(() => prompts(node.box).length === 1 && readRuns(pair.master.box).length === 1, 15_000)
    expect(prompts(node.box)[0]).toMatch(
      /^\[board schedule c00001: \* \* \* \* \*; \d+ runs since .+, sent once\] hourly ping$/,
    )
    const after = readEntry(pair.master.box, 'c00001')
    expect(after).not.toBeNull()
    expect(Number(after?.next)).toBeGreaterThan(Date.now())
    expect(after?.runs).toBe(1)
    expect(after?.why).toBeUndefined()
  }, 60_000)

  test('held idle entry waits for working session after return without counting offline time', async () => {
    const pair = await nodePair({
      masterPanes: () => [],
      masterCfg: { scheduleTickSec: 0.2, scheduleWaitMin: 0.03 },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await waitOnline(pair)

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)

    const now = Date.now()
    putEntry(pair.master.box, { id: 'b00002', idle: true, text: 'wait until free', at: now - 1000, next: now - 1000 })
    await until(() => readEntry(pair.master.box, 'b00002')?.why === 'node-offline', 10_000)
    await Bun.sleep(2200)
    expect(readEntry(pair.master.box, 'b00002')?.why).toBe('node-offline')

    nodeHerdr(node.box, 'working')
    node.proc.send('refresh')
    await until(async () => {
      const b = await boardJson(node.url)
      return ((b.items as { key: string; status?: string }[]) ?? []).some(
        i => i.key === 's-server-1' && i.status === 'working',
      )
    }, 10_000)

    node.proxy.restore()
    await until(() => readEntry(pair.master.box, 'b00002')?.why === 'busy', 15_000)
    expect(prompts(node.box)).toEqual([])

    nodeHerdr(node.box, 'idle')
    node.proc.send('refresh')
    await until(() => prompts(node.box).length === 1 && readRuns(pair.master.box).length === 1, 15_000)
    expect(prompts(node.box)[0]).toContain('wait until free')
    expect(readRuns(pair.master.box)[0]?.result).toBe('sent')
  }, 60_000)

  test('revoking a device ends held entries immediately as missed with node-revoked', async () => {
    const pair = await nodePair({
      masterPanes: () => [],
      masterCfg: { scheduleTickSec: 0.2, scheduleWaitMin: 60 },
      masterSetup: box =>
        writeDiskConfig(box, {
          nodes: { id: 'laptop', devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:1' } } } },
        }),
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await waitOnline(pair)

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)

    const now = Date.now()
    putEntry(pair.master.box, { id: 'd00001', text: 'one-off', at: now - 1000, next: now - 1000 })
    putEntry(pair.master.box, { id: 'd00002', text: 'cron', cron: '* * * * *', next: now - 1000 })
    await until(
      () =>
        readEntry(pair.master.box, 'd00001')?.why === 'node-offline' &&
        readEntry(pair.master.box, 'd00002')?.why === 'node-offline',
      10_000,
    )

    const res = await fetch(`${pair.master.url}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'revoke', id: 'server-1' }),
    })
    expect(res.status).toBe(200)

    await until(() => readRuns(pair.master.box).length === 2, 10_000)
    expect(readEntry(pair.master.box, 'd00001')).toBeNull()
    expect(readEntry(pair.master.box, 'd00002')).toBeNull()
    expect(
      readRuns(pair.master.box)
        .map(r => [r.id, r.result, r.why])
        .sort(),
    ).toEqual([
      ['d00001', 'missed', 'node-revoked'],
      ['d00002', 'missed', 'node-revoked'],
    ])
  }, 60_000)

  test('session gone after node returns ends held entry as missed with gone', async () => {
    const pair = await nodePair({
      masterPanes: () => [],
      masterCfg: { scheduleTickSec: 0.2, scheduleWaitMin: 60 },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await waitOnline(pair)

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)

    const now = Date.now()
    putEntry(pair.master.box, { id: 'e00001', text: 'gone session', at: now - 1000, next: now - 1000 })
    await until(() => readEntry(pair.master.box, 'e00001')?.why === 'node-offline', 10_000)

    showPanes(node.box, [])
    node.proc.send('refresh')
    await until(async () => {
      const b = await boardJson(node.url)
      return ((b.items as unknown[]) ?? []).length === 0
    }, 10_000)

    node.proxy.restore()
    await until(() => readRuns(pair.master.box).length === 1, 15_000)
    expect(readEntry(pair.master.box, 'e00001')).toBeNull()
    expect(readRuns(pair.master.box)[0]).toMatchObject({ id: 'e00001', result: 'missed', why: 'gone' })
  }, 60_000)

  test('forgotten device ends held entries immediately as missed with node-forgotten', async () => {
    const box = await sandbox()
    showPanes(box, [])
    const savedEnv = { ...process.env }
    Object.assign(process.env, box.env)
    const cfg = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      scheduleTickSec: 0.2,
      scheduleWaitMin: 60,
      nodes: { id: 'laptop', devices: {} },
    }
    const proxy = createNodeProxy({
      cfg: cfg as never,
      links: { link: () => null, onChange: () => () => {} },
      find: () => undefined,
      own: () => [],
      remote: () => [],
      local: [],
    })
    const now = Date.now()
    putEntry(box, { id: 'f00001', text: 'forgotten', next: now - 1000, why: 'node-offline' })
    putEntry(box, { id: 'f00002', text: 'forgotten cron', cron: '* * * * *', next: now - 1000, why: 'node-offline' })
    const sched = startScheduler({
      deps: defaultDeps(cfg as never),
      remote: () => proxy,
    })
    try {
      await until(() => readRuns(box).length === 2, 10_000)
      expect(readEntry(box, 'f00001')).toBeNull()
      expect(readEntry(box, 'f00002')).toBeNull()
      expect(
        readRuns(box)
          .map(r => [r.id, r.result, r.why])
          .sort(),
      ).toEqual([
        ['f00001', 'missed', 'node-forgotten'],
        ['f00002', 'missed', 'node-forgotten'],
      ])
    } finally {
      sched.stop()
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
      Object.assign(process.env, savedEnv)
    }
  })

  test('local sessions and a board without nodes keep expiring as before', async () => {
    const plain = await sandbox()
    plain.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              {
                pane_id: 'p1',
                agent: 'claude',
                agent_session: { value: 's-local' },
                agent_status: 'blocked',
                cwd: plain.dir,
              },
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
      'agent get': {
        result: { agent: { agent: 'claude', agent_status: 'blocked', agent_session: { value: 's-local' } } },
      },
    })
    const { url } = await serveBoard(plain, { language: 'en', scheduleTickSec: 0.2, scheduleWaitMin: 0.01 }, PAIR_ENV)
    putEntry(plain, {
      id: 'b00001',
      key: 's-local',
      name: 'local',
      text: 'local blocked',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
    })
    await until(() => readRuns(plain).length === 1, 10_000)
    expect(readEntry(plain, 'b00001')).toBeNull()
    expect(readRuns(plain)[0]).toMatchObject({ id: 'b00001', result: 'missed', why: 'dialog' })
    const b = await boardJson(url)
    expect('devices' in b).toBe(false)
  }, 30_000)
})
