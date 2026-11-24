// End-to-end Telegram routing across master and nodes (#701): real wake.ts + real master/node
// board servers linked through doorProxy, against a stub tg-mcp and fake herdr. Covers awake node
// delivery, sleeping node wake in non-default profile, local session parity, node-only never polling
// Telegram, offline-node hold + return delivery, standalone board parity, and listener security.
import { describe, expect, onTestFinished, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteItem } from '../../src/core/wake/route.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { DEAD_MS, nodePair, PAIR_ENV, type Pair, showPanes } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'
import { runningSession, SID, SID2 } from '../support/wake-fixtures.ts'
import { spawnWake, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
const TOKEN = 'tg-node-secret-91a2'
const RULE = `\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const EMPTY_BOX = ['● done', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')

interface StubTg {
  url: string
  waits: { authorization: string | null }[]
  acks: { authorization: string | null; body: { id?: unknown; outcome?: string; note?: string } }[]
  push(items: RouteItem[]): void
}

function stubTgMcp(): StubTg {
  const batches: RouteItem[][] = []
  let wakeWait: () => void = () => {}
  const stub: StubTg = {
    url: '',
    waits: [],
    acks: [],
    push(items) {
      batches.push(items)
      wakeWait()
    },
  }
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const authorization = req.headers.get('authorization')
      if (url.pathname === '/router/wait') {
        stub.waits.push({ authorization })
        if (batches.length === 0)
          await Promise.race([
            new Promise<void>(resolve => {
              wakeWait = resolve
            }),
            Bun.sleep(150),
          ])
        return Response.json({ items: batches.shift() ?? [] })
      }
      if (url.pathname === '/router/ack' && req.method === 'POST') {
        stub.acks.push({ authorization, body: (await req.json()) as StubTg['acks'][number]['body'] })
        return Response.json({ ok: true })
      }
      return new Response(null, { status: 404 })
    },
  })
  onTestFinished(() => srv.stop(true))
  stub.url = srv.url.origin
  return stub
}

function writeClaudeJson(box: Sandbox, tgUrl: string): void {
  const file = join(box.env.HOME as string, '.claude.json')
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { telegram: { url: `${tgUrl}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } },
    }),
  )
}

function startWake(
  box: Sandbox,
  config: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { url: string; wakePort: number } {
  const wakePort = Number((config.wake as { port: number }).port)
  writeBoardConfig(box, config)
  const child = spawnWake(box, [], { ...PAIR_ENV, BOARD_WAKE_ROUND_MS: '50', ...extraEnv })
  onTestFinished(async () => {
    if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill()
    await child.proc.exited
  })
  return { url: `http://127.0.0.1:${wakePort}`, wakePort }
}

async function waitWakeReady(url: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch {}
    if (Date.now() > deadline) throw new Error(`wake did not answer /status at ${url}`)
    await Bun.sleep(25)
  }
}

async function waitOnline(pair: Pair, deviceId = 'server-1', expectedKey = `@${deviceId}:${SID}`): Promise<void> {
  await pair.waitDevice(deviceId, d => d.link?.state === 'online' && d.payloadAt !== null, 15_000)
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const res = await fetch(`${pair.master.url}/api/board`)
      if (res.ok) {
        const b = (await res.json()) as { items?: { key: string }[] }
        if ((b.items ?? []).some(i => i.key === expectedKey)) return
      }
    } catch {}
    if (Date.now() > deadline) throw new Error(`item ${expectedKey} never appeared on master`)
    await Bun.sleep(25)
  }
}

const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(c => c[0] === 'agent' && c[1] === 'prompt')
    .map(c => c[3] as string)

function setupAwakeNodeHerdr(
  box: Sandbox,
  session: string,
  opts: { pane?: string; cwd?: string; tabLabel?: string } = {},
): void {
  const paneId = opts.pane ?? 'p1'
  const cwd = opts.cwd ?? PROJECT
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'Billing' }],
          tabs: [
            { tab_id: 't1', workspace_id: 'w1', number: 1 },
            ...(opts.tabLabel ? [{ tab_id: 't2', workspace_id: 'w1', label: opts.tabLabel, number: 2 }] : []),
          ],
          panes: [
            {
              pane_id: paneId,
              tab_id: opts.tabLabel ? 't2' : 't1',
              workspace_id: 'w1',
              agent: 'claude',
              agent_session: { value: session },
              agent_status: 'idle',
              cwd,
              terminal_title_stripped: 'Billing',
            },
          ],
          agents: [{ pane_id: paneId, state_change_seq: 10 }],
        },
      },
    },
    'pane get': {
      result: {
        pane: {
          pane_id: paneId,
          tab_id: opts.tabLabel ? 't2' : 't1',
          workspace_id: 'w1',
          agent: 'claude',
          agent_session: { value: session },
          agent_status: 'idle',
          cwd,
        },
      },
    },
    'agent get': {
      result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: session } } },
    },
    'agent read': { text: EMPTY_BOX },
    'agent prompt': { result: {} },
  })
}

const readScheduleFiles = (box: Sandbox): Record<string, unknown>[] => {
  const dir = join(stateFolder(box), 'schedule')
  if (!existsSync(dir)) return []
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  return readdirSync(dir)
    .filter(f => /^[0-9a-f]{6}\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
}

describe('Telegram routing for sessions on nodes (#701)', () => {
  test('master routes topic, path with Cyrillic/spaces/%, and remote pane hint to node without touching local when node owns it; local sessions stay local', async () => {
    const pair = await nodePair({
      masterPanes: box => [
        {
          pane_id: 'm1',
          tab_id: 'tm1',
          workspace_id: 'wm1',
          agent: 'claude',
          agent_session: { value: SID2 },
          agent_status: 'idle',
          cwd: box.dir,
          terminal_title_stripped: 'Local',
        },
      ],
      masterSetup: box => {
        box.state({
          'api snapshot': {
            result: {
              snapshot: {
                workspaces: [{ workspace_id: 'wm1', label: 'LocalWS' }],
                tabs: [{ tab_id: 'tm1', workspace_id: 'wm1', number: 1 }],
                panes: [
                  {
                    pane_id: 'm1',
                    tab_id: 'tm1',
                    workspace_id: 'wm1',
                    agent: 'claude',
                    agent_session: { value: SID2 },
                    agent_status: 'idle',
                    cwd: box.dir,
                    terminal_title_stripped: 'Local',
                  },
                ],
                agents: [{ pane_id: 'm1', state_change_seq: 5 }],
              },
            },
          },
          'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID2 } } } },
          'agent read': { text: EMPTY_BOX },
          'agent prompt': { result: {} },
        })
      },
      panes: () => [
        {
          pane_id: 'w1:p2',
          tab_id: 't2',
          workspace_id: 'w1',
          agent: 'claude',
          agent_session: { value: SID },
          agent_status: 'idle',
          cwd: PROJECT,
          terminal_title_stripped: 'Billing',
        },
      ],
      nodeEnv: () => ({ COMPUTERNAME: 'NODE-BOX' }),
    })

    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    setupAwakeNodeHerdr(node.box, SID, { pane: 'w1:p2', tabLabel: 'hotfix' })
    node.proc.send('refresh')
    await waitOnline(pair, 'server-1', `@server-1:${SID}`)

    const tg = stubTgMcp()
    writeClaudeJson(pair.master.box, tg.url)
    const wakePort = await unusedPort()
    const masterPort = Number(new URL(pair.master.url).port)
    const wake = startWake(
      pair.master.box,
      {
        ...pair.masterConfig,
        port: masterPort,
        wake: { enabled: true, telegram: 'auto', port: wakePort, pollTimeoutSec: 1, wakeTimeoutSec: 5 },
      },
      { COMPUTERNAME: 'MASTER-BOX' },
    )
    await waitWakeReady(wake.url)

    // 1. Node session by topic key
    tg.push([
      {
        id: 1,
        key: 'topic:Billing / hotfix',
        topic: 'Billing',
        text: 'via topic',
        meta: { message_id: '11' },
        queued_at: new Date().toISOString(),
      },
    ])
    await until(() => tg.acks.length === 1, 10_000)
    expect(tg.acks[0]?.body).toEqual({ id: 1, outcome: 'delivered' })
    expect(prompts(node.box)).toEqual(['[telegram message_id=11]\nvia topic'])
    expect(node.proxy.requests).toContain('POST /api/node/telegram')

    // 2. Node session by path with spaces, Cyrillic, and %
    tg.push([
      {
        id: 2,
        key: PROJECT,
        topic: 'Path',
        text: 'via path',
        meta: { message_id: '12' },
        queued_at: new Date().toISOString(),
      },
    ])
    await until(() => tg.acks.length === 2, 10_000)
    expect(tg.acks[1]?.body).toEqual({ id: 2, outcome: 'delivered' })
    expect(prompts(node.box)[1]).toBe('[telegram message_id=12]\nvia path')

    // 3. Explicit remote pane hint (<machine>:<pane>)
    tg.push([
      {
        id: 3,
        key: 'topic:Unmatched',
        pane: 'NODE-BOX:w1:p2',
        topic: 'Hint',
        text: 'via hint',
        meta: { message_id: '13' },
        queued_at: new Date().toISOString(),
      },
    ])
    await until(() => tg.acks.length === 3, 10_000)
    expect(tg.acks[2]?.body).toEqual({ id: 3, outcome: 'delivered' })
    expect(prompts(node.box)[2]).toBe('[telegram message_id=13]\nvia hint')

    // 4. Local session on master delivers locally without hitting /api/node/telegram
    const beforeProxyReqs = node.proxy.requests.filter(r => r === 'POST /api/node/telegram').length
    tg.push([
      {
        id: 4,
        key: 'topic:LocalWS',
        topic: 'LocalWS',
        text: 'local msg',
        meta: { message_id: '14' },
        queued_at: new Date().toISOString(),
      },
    ])
    await until(() => tg.acks.length === 4, 10_000)
    expect(tg.acks[3]?.body).toEqual({ id: 4, outcome: 'delivered' })
    expect(prompts(pair.master.box)).toEqual(['[telegram message_id=14]\nlocal msg'])
    expect(node.proxy.requests.filter(r => r === 'POST /api/node/telegram').length).toBe(beforeProxyReqs)

    // Security: /api/nodes/telegram refuses missing X-Board or foreign Origin; /api/node/telegram is refused on node's web port.
    expect((await fetch(`${pair.master.url}/api/nodes/telegram`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect(
      (
        await fetch(`${pair.master.url}/api/nodes/telegram`, {
          method: 'POST',
          headers: { 'x-board': '1', origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${node.url}/api/node/telegram`, {
          method: 'POST',
          headers: { 'x-board': '1' },
          body: '{}',
        })
      ).status,
    ).toBe(405)
  }, 60_000)

  test('sleeping node session wakes in its Work profile and delivers Telegram message with wake note', async () => {
    let workDir = ''
    const pair = await nodePair({
      masterPanes: () => [],
      panes: () => [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: PROJECT }],
      nodeSetup: (_id, box) => {
        const home = box.env.HOME as string
        const claude = join(home, '.claude')
        workDir = join(home, '.claude-work')
        mkdirSync(claude, { recursive: true })
        mkdirSync(workDir, { recursive: true })
        writeFileSync(join(claude, 'settings.json'), '{}')
        writeFileSync(join(workDir, 'settings.json'), '{}')
        const stateDir = stateFolder(box)
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(
          join(stateDir, 'wake-sessions.json'),
          JSON.stringify({
            p1: {
              session: SID,
              name: 'Billing',
              title: 'Billing chat',
              cwd: PROJECT,
              seen_at: Date.now() - 10_000,
              slept_at: Date.now() - 5000,
              profileDir: workDir,
              profile: 'work',
            },
          }),
        )
      },
      nodeCfg: () => ({
        profiles: [
          { id: 'default', title: 'Default', dir: '~/.claude' },
          { id: 'work', title: 'Work', dir: '~/.claude-work' },
        ],
      }),
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    node.box.state({
      'api snapshot': {
        until: ['pane run'],
        result: {
          snapshot: {
            workspaces: [{ workspace_id: 'w1', label: 'Main' }],
            tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1 }],
            panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: PROJECT }],
          },
        },
        // biome-ignore lint/suspicious/noThenProperty: fake-herdr reply transition
        then: {
          result: {
            snapshot: {
              workspaces: [{ workspace_id: 'w1', label: 'Main' }],
              tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1 }],
              panes: [
                {
                  pane_id: 'p1',
                  tab_id: 't1',
                  workspace_id: 'w1',
                  cwd: PROJECT,
                  agent: 'claude',
                  agent_status: 'idle',
                  agent_session: { value: SID },
                },
              ],
            },
          },
        },
      },
      'pane get': {
        until: ['pane run'],
        result: { pane: { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: PROJECT } },
        // biome-ignore lint/suspicious/noThenProperty: fake-herdr reply transition
        then: {
          result: {
            pane: {
              pane_id: 'p1',
              tab_id: 't1',
              workspace_id: 'w1',
              cwd: PROJECT,
              agent: 'claude',
              agent_status: 'idle',
              agent_session: { value: SID },
            },
          },
        },
      },
      'pane process-info': {
        result: { process_info: { shell_pid: 4000, foreground_processes: [{ pid: 4000, name: 'bash' }] } },
      },
      'pane send-keys': { result: {} },
      'pane run': { result: {} },
      'pane rename': { result: {} },
      'agent get': {
        until: ['pane run'],
        result: {},
        // biome-ignore lint/suspicious/noThenProperty: fake-herdr reply transition
        then: { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
      },
      'agent read': { text: EMPTY_BOX },
      'agent prompt': { result: {} },
    })
    node.proc.send('refresh')
    await waitOnline(pair, 'server-1', `@server-1:${SID}`)

    const tg = stubTgMcp()
    writeClaudeJson(pair.master.box, tg.url)
    const wakePort = await unusedPort()
    const masterPort = Number(new URL(pair.master.url).port)
    const wake = startWake(pair.master.box, {
      ...pair.masterConfig,
      port: masterPort,
      wake: { enabled: true, telegram: 'auto', port: wakePort, pollTimeoutSec: 1, wakeTimeoutSec: 5 },
    })
    await waitWakeReady(wake.url)

    tg.push([
      {
        id: 21,
        key: PROJECT,
        topic: 'Billing',
        text: 'wake and work',
        meta: { message_id: '21' },
        queued_at: new Date().toISOString(),
      },
    ])
    await until(() => tg.acks.length === 1, 15_000)
    expect(tg.acks[0]?.body).toEqual({ id: 21, outcome: 'delivered', note: '⏰ Разбудил сессию «Billing chat».' })
    expect(
      node.box
        .calls()
        .some(c => c[0] === 'pane' && c[1] === 'run' && c[2] === 'p1' && c[3] === `board resume ${SID} --profile work`),
    ).toBe(true)
    expect(prompts(node.box)).toEqual(['[telegram message_id=21]\nwake and work'])
  }, 60_000)

  test('offline node holds Telegram message past scheduleWaitMin and delivers on return', async () => {
    const pair = await nodePair({
      masterPanes: () => [],
      masterCfg: { scheduleTickSec: 0.2, scheduleWaitMin: 0.01 },
      panes: () => [
        {
          pane_id: 'p1',
          tab_id: 't1',
          workspace_id: 'w1',
          agent: 'claude',
          agent_session: { value: SID },
          agent_status: 'idle',
          cwd: PROJECT,
        },
      ],
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    setupAwakeNodeHerdr(node.box, SID, { pane: 'p1', cwd: PROJECT })
    node.proc.send('refresh')
    await waitOnline(pair, 'server-1', `@server-1:${SID}`)

    const tg = stubTgMcp()
    writeClaudeJson(pair.master.box, tg.url)
    const wakePort = await unusedPort()
    const masterPort = Number(new URL(pair.master.url).port)
    const wake = startWake(pair.master.box, {
      ...pair.masterConfig,
      port: masterPort,
      wake: { enabled: true, telegram: 'auto', port: wakePort, pollTimeoutSec: 1, wakeTimeoutSec: 5 },
    })
    await waitWakeReady(wake.url)

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)

    const oldIso = new Date(Date.now() - 5 * 60_000).toISOString()
    tg.push([
      {
        id: 31,
        key: 'topic:Billing',
        topic: 'Billing',
        text: 'held while offline',
        meta: { message_id: '31' },
        queued_at: oldIso,
      },
    ])
    await until(() => tg.acks.length === 1, 10_000)
    expect(tg.acks[0]?.body).toEqual({
      id: 31,
      outcome: 'delivered',
      note: '💤 Устройство «server-1» не в сети. Сообщение сохранено и будет доставлено, когда оно подключится.',
    })

    // Persisted in schedule past scheduleWaitMin (0.01 min = 600 ms).
    await Bun.sleep(1500)
    const entries = readScheduleFiles(pair.master.box)
    expect(entries.length).toBe(1)
    expect(entries[0]).toMatchObject({ key: `@server-1:${SID}`, kind: 'telegram', why: 'node-offline' })
    expect(prompts(node.box)).toEqual([])

    node.proxy.restore()
    await until(() => prompts(node.box).length === 1 && readScheduleFiles(pair.master.box).length === 0, 15_000)
    expect(prompts(node.box)[0]).toContain('[telegram message_id=31 ')
    expect(prompts(node.box)[0]).toContain(`queued_at=${oldIso}`)
    expect(prompts(node.box)[0]).toContain('\nheld while offline')
  }, 60_000)

  test('node-only board never polls Telegram even when wake.telegram is auto', async () => {
    const box = await sandbox()
    showPanes(box, [])
    const tg = stubTgMcp()
    writeClaudeJson(box, tg.url)
    const wakePort = await unusedPort()
    const wake = startWake(box, {
      language: 'en',
      port: 9,
      node: { id: 'server-1', port: await unusedPort(), workRoot: box.dir },
      wake: { enabled: true, telegram: 'auto', port: wakePort, pollTimeoutSec: 1 },
    })
    await waitWakeReady(wake.url)
    await Bun.sleep(400)
    expect(tg.waits).toEqual([])
    const st = (await (await fetch(`${wake.url}/status`)).json()) as { telegram: unknown }
    expect(st.telegram).toEqual({ state: 'off' })
  })

  test('standalone board without nodes/node has no machine/tgKey and refuses /api/nodes/telegram', async () => {
    const plain = await sandbox()
    plain.state({
      'api snapshot': {
        result: {
          snapshot: {
            workspaces: [{ workspace_id: 'w1', label: 'Main' }],
            tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1 }],
            panes: [
              {
                pane_id: 'p1',
                tab_id: 't1',
                workspace_id: 'w1',
                agent: 'claude',
                agent_session: { value: SID },
                agent_status: 'idle',
                cwd: plain.dir,
              },
            ],
          },
        },
      },
      'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
      'agent read': { text: EMPTY_BOX },
      'agent prompt': { result: {} },
    })
    runningSession(join(plain.env.HOME as string, '.claude'), { id: SID, name: 'Plain', cwd: plain.dir, n: 1 })
    const { url } = await serveBoard(plain, { language: 'en' }, PAIR_ENV)
    const b = (await (await fetch(`${url}/api/board`)).json()) as {
      machine?: unknown
      items: Record<string, unknown>[]
    }
    expect('machine' in b).toBe(false)
    expect('tgKey' in (b.items[0] ?? {})).toBe(false)
    expect(
      (await fetch(`${url}/api/nodes/telegram`, { method: 'POST', headers: { 'x-board': '1' }, body: '{}' })).status,
    ).toBe(405)
  })
})
