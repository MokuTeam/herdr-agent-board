// Service-level tests for Telegram routing across master and nodes (#701):
// createTelegram with/without remote, createNodesTelegram with fake links/aggregate,
// and createNodeTelegram with fake wake-herdr (live, sleeping, freed, liveOnly, fallback).
import { describe, expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { findProfileDirs } from '../../src/adapters/profiles.ts'
import { mergeProfiles, profileSet } from '../../src/core/profiles.ts'
import { cleanTelegramItems, promptOf } from '../../src/core/schedule-rules.ts'
import type { Config, Item } from '../../src/core/types.ts'
import { wakeConfig } from '../../src/core/wake/config.ts'
import type { RouteItem } from '../../src/core/wake/route.ts'
import type { WakeSessions } from '../../src/core/wake/sessions.ts'
import { createNodeTelegram } from '../../src/services/node/telegram.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createNodesTelegram } from '../../src/services/nodes/telegram.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import { createTelegram } from '../../src/services/wake/telegram.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'
import { runningSession, SID, SID2 } from '../support/wake-fixtures.ts'

const outside = () => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  homedir: homedir(),
})
const found = outside()
const OUTSIDE = { ...found, homedir: (process.platform === 'win32' ? found.USERPROFILE : found.HOME) || found.homedir }

const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
const RULE = `\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const EMPTY_BOX = ['● done', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')

function world(o: {
  panes?: FakePane[]
  shells?: Record<string, string>
  sessions?: (f: { home: string; claude: string; work: string }) => WakeSessions
}) {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const folders = { home, claude: join(home, '.claude'), work: join(home, '.claude-work') }
  for (const folder of [folders.claude, folders.work]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'settings.json'), '{}')
  }
  const file = join(dir, 'state', 'wake-sessions.json')
  const sessions = o.sessions?.(folders) ?? {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(sessions))
  const panes = o.panes ?? []
  const io = fakeWakeHerdr({
    panes,
    workspaces: [{ workspace_id: 'w1', label: 'Main' }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1 }],
    shells: o.shells ?? {},
    inputBoxes: Object.fromEntries(panes.map(p => [p.pane_id, EMPTY_BOX])),
  })
  const set = profileSet(mergeProfiles(undefined, findProfileDirs(home), home, folders.claude).list, folders.claude)
  const clock = { at: Date.now() }
  const log: string[] = []
  const deps: WakeEngineDeps = {
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => set,
    settings: () => wakeConfig({ enabled: true }),
    sessionsFile: file,
    boardOnPath: () => true,
    scheduled: async () => false,
    log: text => log.push(text),
    now: () => clock.at,
    sleep: ms => {
      clock.at += ms
      return Promise.resolve()
    },
  }
  return { ...folders, file, io, log, deps, set }
}

const shellPane = (pane: string): FakePane => ({ pane_id: pane, tab_id: 't1', workspace_id: 'w1', cwd: PROJECT })

const routeItem = (over: Partial<RouteItem> = {}): RouteItem => ({
  id: 1,
  key: 'topic:Main',
  topic: 'Main',
  text: 'hello node',
  meta: { message_id: '101' },
  queued_at: new Date().toISOString(),
  ...over,
})

const nodeItem = (over: Partial<Item> = {}): Item => ({
  key: `@server-1:${SID}`,
  session: SID,
  pane: 'w1:p1',
  workspace: 'Main',
  cwd: PROJECT,
  status: 'idle',
  name: 'Billing',
  autoName: 'Billing',
  category: 'other',
  categorySet: false,
  column: 'idle',
  attention: '',
  agent: 'claude',
  device: 'server-1',
  tgKey: 'topic:Main',
  ...over,
})

function startsOnRun(io: FakeWakeHerdr, pane: FakePane, dir: string, sid = SID): void {
  io.on(
    argv => argv[0] === 'pane' && argv[1] === 'run' && argv[2] === pane.pane_id,
    () => {
      pane.agent = 'claude'
      pane.agent_status = 'idle'
      pane.agent_session = { value: sid }
      io.busy.add(pane.pane_id)
      runningSession(dir, { id: sid, name: 'Billing', cwd: PROJECT, n: 1 })
    },
  )
}

describe('createTelegram remote delegation', () => {
  test('standalone setup with hasRemote=false never calls remote()', async () => {
    const w = world({ panes: [] })
    const engine = createWakeEngine(w.deps)
    let remoteCalls = 0
    const tg = createTelegram({
      engine,
      herdr: w.io,
      target: () => null,
      machine: 'LAPTOP',
      pollTimeoutSec: () => 25,
      log: text => w.log.push(text),
      hasRemote: () => false,
      remote: async () => {
        remoteCalls++
        return { ok: true }
      },
    })
    onTestFinished(() => tg.stop())
    const res = await tg.route([routeItem()])
    expect('skip' in res).toBe(true)
    expect(remoteCalls).toBe(0)
  })

  test('explicit remote pane hint tries remote before local; live_panes remote checks liveOnly before waking local', async () => {
    const localPane = shellPane('w1:p1')
    const w = world({
      panes: [localPane],
      shells: { 'w1:p1': 'bash' },
      sessions: f => ({
        'w1:p1': {
          session: SID,
          name: 'Local',
          title: 'Local chat',
          cwd: PROJECT,
          seen_at: Date.now() - 1000,
          slept_at: Date.now() - 1000,
          profileDir: f.claude,
        },
      }),
    })
    const engine = createWakeEngine(w.deps)
    const calls: { liveOnly: boolean | undefined }[] = []
    let nextRemote: { ok: true } | null = { ok: true }
    const tg = createTelegram({
      engine,
      herdr: w.io,
      target: () => null,
      machine: 'LAPTOP',
      pollTimeoutSec: () => 25,
      log: text => w.log.push(text),
      hasRemote: () => true,
      remote: async (_items, opts) => {
        calls.push({ liveOnly: opts?.liveOnly })
        return nextRemote
      },
    })
    onTestFinished(() => tg.stop())

    // Explicit remote pane hint asks remote without waking local.
    expect(await tg.route([routeItem({ key: PROJECT, pane: 'SERVER1:w1:p2' })])).toEqual({ ok: true })
    expect(calls).toEqual([{ liveOnly: undefined }])
    expect(w.io.calls.filter(c => c[0] === 'pane' && c[1] === 'run')).toEqual([])

    // Local sleeper matched + live_panes names remote machine -> remote({ liveOnly: true }) wins before waking local.
    calls.length = 0
    expect(await tg.route([routeItem({ key: PROJECT, live_panes: ['SERVER1:w1:p9'] })])).toEqual({ ok: true })
    expect(calls).toEqual([{ liveOnly: true }])
    expect(w.io.calls.filter(c => c[0] === 'pane' && c[1] === 'run')).toEqual([])

    // If remote({ liveOnly: true }) returns null, local sleeper wakes and receives the message.
    calls.length = 0
    nextRemote = null
    startsOnRun(w.io, localPane, w.claude, SID)
    const woken = await tg.route([routeItem({ key: PROJECT, live_panes: ['SERVER1:w1:p9'] })])
    expect(woken).toEqual({ ok: true, note: '⏰ Разбудил сессию «Local chat».' })
    expect(calls).toEqual([{ liveOnly: true }])
  })
})

describe('createNodesTelegram', () => {
  test('prefers live session across multiple nodes, skips revoked, and holds offline node messages', async () => {
    const cfg = {
      nodes: {
        id: 'laptop',
        order: ['server-1', 'server-2', 'server-revoked'],
        devices: {
          'server-1': { title: 'Atlas 1', link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
          'server-2': { title: 'Atlas 2', link: { kind: 'direct', url: 'http://127.0.0.1:2' } },
          'server-revoked': { title: 'Revoked', link: { kind: 'direct', url: 'http://127.0.0.1:3' }, revoked: true },
        },
      },
    } as unknown as Config

    const requests: { device: string; liveOnly: boolean | undefined }[] = []
    const makeLink = (id: string, handler: (liveOnly: boolean) => unknown): Pick<Link, 'fetch'> => ({
      async fetch(_path, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { liveOnly?: boolean }
        requests.push({ device: id, liveOnly: body.liveOnly })
        return new Response(JSON.stringify(handler(!!body.liveOnly)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const link1 = makeLink('server-1', liveOnly =>
      liveOnly ? { matched: false } : { matched: true, result: { ok: true, note: 'woke 1' } },
    )
    const link2 = makeLink('server-2', () => ({ matched: true, result: { ok: true } }))

    const held: unknown[] = []
    let heldCount = 0
    let state1: 'online' | 'offline' = 'online'
    const svc = createNodesTelegram({
      cfg,
      links: { link: id => (id === 'server-1' ? link1 : id === 'server-2' ? link2 : null) as Link | null },
      aggregate: {
        devicePart: id =>
          id === 'server-1'
            ? { items: [nodeItem({ sleeping: true })], launches: [], schedules: [], machine: 'SRV1' }
            : id === 'server-2'
              ? {
                  items: [nodeItem({ key: `@server-2:${SID2}`, sleeping: false })],
                  launches: [],
                  schedules: [],
                  machine: 'SRV2',
                }
              : null,
      },
      deviceState: id => (id === 'server-revoked' ? 'revoked' : id === 'server-1' ? state1 : 'online'),
      holdEntry: entry => {
        held.push(entry)
        return { id: 'aa1122', ...entry } as never
      },
      onHeld: () => {
        heldCount++
      },
      log: () => {},
      now: () => 1700000000000,
    })

    // Multi-node: live session on server-2 wins in pass 1 (liveOnly=true) over sleeping server-1.
    const r1 = await svc.route({ items: [routeItem()] })
    expect(r1).toEqual({ status: 200, body: { matched: true, result: { ok: true } } })
    expect(requests).toEqual([{ device: 'server-2', liveOnly: true }])

    // Offline node with cached item: held in schedule with clear note, never delivered to revoked.
    requests.length = 0
    state1 = 'offline'
    const offlineOnly = createNodesTelegram({
      cfg: {
        nodes: {
          id: 'laptop',
          order: ['server-1', 'server-revoked'],
          devices: {
            'server-1': { title: 'Atlas 1', link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
            'server-revoked': { title: 'Revoked', link: { kind: 'direct', url: 'http://127.0.0.1:3' }, revoked: true },
          },
        },
      } as unknown as Config,
      links: { link: () => null },
      aggregate: {
        devicePart: id =>
          id === 'server-1'
            ? { items: [nodeItem({ sleeping: false })], launches: [], schedules: [], machine: 'SRV1' }
            : null,
      },
      deviceState: id => (id === 'server-revoked' ? 'revoked' : 'offline'),
      holdEntry: entry => {
        held.push(entry)
        return { id: 'bb2233', ...entry } as never
      },
      onHeld: () => {
        heldCount++
      },
      log: () => {},
      now: () => 1700000000000,
    })

    const r2 = await offlineOnly.route({ items: [routeItem({ text: 'offline msg' })] })
    expect(r2).toEqual({
      status: 200,
      body: {
        matched: true,
        result: {
          ok: true,
          note: '💤 Устройство «Atlas 1» не в сети. Сообщение сохранено и будет доставлено, когда оно подключится.',
        },
      },
    })
    expect(heldCount).toBe(1)
    expect(held[0]).toMatchObject({
      key: `@server-1:${SID}`,
      kind: 'telegram',
      why: 'node-offline',
      by: 'telegram',
    })

    // Offline node matched only by pane machine hint (no cached item): returns clear retry note.
    const r3 = await offlineOnly.route({ items: [routeItem({ key: 'topic:Unknown', pane: 'SRV1:w9:p9' })] })
    expect(r3).toEqual({
      status: 200,
      body: {
        matched: true,
        result: {
          retry: 60,
          note: '💤 Устройство «Atlas 1» не в сети. Доставлю, когда оно подключится.',
        },
      },
    })
  })

  test('pinned offline node is not stolen by an unpinned online node, and oversized (>128 KB) offline batch returns retry', async () => {
    const called: string[] = []
    const held: Record<string, unknown>[] = []
    const svc = createNodesTelegram({
      cfg: {
        language: 'en',
        nodes: {
          id: 'laptop',
          order: ['server-1', 'server-2'],
          devices: {
            'server-1': { title: 'Atlas 1', link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
            'server-2': { title: 'Atlas 2', link: { kind: 'direct', url: 'http://127.0.0.1:2' } },
          },
        },
      } as unknown as Config,
      links: {
        link: id =>
          ({
            fetch: async () => {
              called.push(id)
              return Response.json({ matched: true, result: { ok: true } })
            },
          }) as unknown as Link,
      },
      aggregate: {
        devicePart: id =>
          id === 'server-1'
            ? { items: [nodeItem({ sleeping: true })], launches: [], schedules: [], machine: 'SRV1' }
            : {
                items: [nodeItem({ key: `@server-2:${SID2}`, sleeping: true })],
                launches: [],
                schedules: [],
                machine: 'SRV2',
              },
      },
      deviceState: id => (id === 'server-1' ? 'offline' : 'online'),
      holdEntry: entry => {
        held.push(entry)
        return { id: 'cc3344', ...entry } as never
      },
      log: () => {},
      now: () => 1700000000000,
    })

    // Pinned to offline SRV1: online SRV2 must never be called or allowed to steal it.
    const r = await svc.route({ items: [routeItem({ pane: 'SRV1:w1:p2' })] })
    expect(r).toEqual({
      status: 200,
      body: {
        matched: true,
        result: {
          ok: true,
          note: '💤 Устройство «Atlas 1» не в сети. Сообщение сохранено и будет доставлено, когда оно подключится.',
        },
      },
    })
    expect(called).toEqual([])
    expect(held).toHaveLength(1)

    // Oversized >128 KB offline batch returns retry rather than overflowing readBody on redelivery.
    const big = await svc.route({
      items: Array.from({ length: 10 }, (_, idx) =>
        routeItem({ id: 200 + idx, pane: 'SRV1:w1:p2', text: 'x'.repeat(15_000) }),
      ),
    })
    expect(big).toEqual({
      status: 200,
      body: {
        matched: true,
        result: {
          retry: 60,
          note: '💤 Устройство «Atlas 1» не в сети. Доставлю, когда оно подключится.',
        },
      },
    })
    expect(held).toHaveLength(1)

    // Control characters are stripped when cleaning telegramItems for schedule storage.
    const cleaned = cleanTelegramItems([routeItem({ text: 'hi\x1b[31m there\x07', meta: { message_id: '55\x1b' } })])
    expect(
      promptOf({ id: 'aa1122', key: '@server-1:s1', text: '', kind: 'telegram', telegramItems: cleaned, next: 0 }, 0),
    ).toBe('[telegram message_id=55]\nhi[31m there')
  })
})

describe('createNodeTelegram', () => {
  test('delivers live, wakes sleeping in Work profile, and skips sleepers when liveOnly is set', async () => {
    const pane = shellPane('w1:p1')
    const w = world({
      panes: [pane],
      shells: { 'w1:p1': 'bash' },
    })
    startsOnRun(w.io, pane, w.work, SID)
    const sessions: WakeSessions = {
      'w1:p1': {
        session: SID,
        name: 'Billing',
        title: 'Billing chat',
        cwd: PROJECT,
        seen_at: Date.now() - 1000,
        slept_at: Date.now() - 1000,
        profileDir: w.work,
        profile: 'work',
      },
    }
    let refreshed = 0
    const svc = createNodeTelegram({
      cfg: { language: 'en', wake: { enabled: false } } as unknown as Config,
      profiles: () => w.set,
      herdr: w.io,
      readSessions: () => sessions,
      machine: 'SRV1',
      askWake: false,
      log: text => w.log.push(text),
      refresh: () => {
        refreshed++
      },
      sleep: async () => {},
    })

    // liveOnly skips sleeping session.
    expect(await svc.route({ items: [routeItem({ key: PROJECT })], liveOnly: true })).toEqual({
      status: 200,
      body: { matched: false },
    })

    // Without liveOnly, wakes sleeping session in --profile work and delivers.
    const r = await svc.route({ items: [routeItem({ key: PROJECT })] })
    expect(r).toEqual({
      status: 200,
      body: { matched: true, result: { ok: true, note: '⏰ Разбудил сессию «Billing chat».' } },
    })
    expect(refreshed).toBe(1)
    expect(w.io.calls.filter(c => (c[0] === 'pane' && c[1] === 'run') || c[1] === 'prompt')).toEqual([
      ['pane', 'run', 'w1:p1', `board resume ${SID} --profile work`],
      ['agent', 'prompt', 'w1:p1', '[telegram message_id=101]\nhello node'],
    ])

    // Subsequent live message delivers directly without waking.
    const rLive = await svc.route({ items: [routeItem({ key: 'topic:Main', text: 'second' })] })
    expect(rLive).toEqual({ status: 200, body: { matched: true, result: { ok: true } } })
    expect(w.io.calls.at(-1)).toEqual(['agent', 'prompt', 'w1:p1', '[telegram message_id=101]\nsecond'])
  })

  test('wakes #204 freed sleeper in a new tab without duplicating if already woken, and delegates to POST /route when wake runs', async () => {
    const w = world({ panes: [], shells: {} })
    const newPane: FakePane = { pane_id: 'w1:p2', tab_id: 't2', workspace_id: 'w1', cwd: PROJECT }
    let tabCreated = 0
    const sessions: WakeSessions = {
      [SID]: {
        session: SID,
        name: 'Billing',
        title: 'Billing freed',
        cwd: PROJECT,
        seen_at: Date.now() - 2000,
        slept_at: Date.now() - 2000,
        profileDir: w.work,
        profile: 'work',
        freed: { at: Date.now() - 2000, workspace: 'w1', pane: 'w1:p1', tabLabel: 'Billing', topic: 'topic:Billing' },
      },
    }
    const tabs = {
      newTab: async () => {
        tabCreated++
        w.io.panes.push(newPane)
        w.io.shells['w1:p2'] = 'bash'
        w.io.screens['w1:p2'] = EMPTY_BOX
        w.io.inputBoxes['w1:p2'] = EMPTY_BOX
        startsOnRun(w.io, newPane, w.work, SID)
        return 'w1:p2'
      },
      newWorkspace: async () => {
        tabCreated++
        w.io.panes.push(newPane)
        w.io.shells['w1:p2'] = 'bash'
        w.io.screens['w1:p2'] = EMPTY_BOX
        w.io.inputBoxes['w1:p2'] = EMPTY_BOX
        startsOnRun(w.io, newPane, w.work, SID)
        return 'w1:p2'
      },
      exists: () => true,
      home: w.home,
    }

    const svc = createNodeTelegram({
      cfg: { language: 'en', wake: { enabled: false } } as unknown as Config,
      profiles: () => w.set,
      herdr: w.io,
      readSessions: () => sessions,
      tabs,
      machine: 'SRV1',
      askWake: false,
      log: () => {},
      sleep: async () => {},
    })

    const rFreed = await svc.route({ items: [routeItem({ key: 'topic:Billing', topic: 'Billing' })] })
    expect(rFreed).toEqual({
      status: 200,
      body: { matched: true, result: { ok: true, note: '⏰ Разбудил сессию «Billing freed».' } },
    })
    expect(tabCreated).toBe(1)

    // Even if wake-sessions.json still holds the freed record, an explicit freed-id target finds the live pane and never opens a second tab.
    newPane.terminal_title_stripped = ''
    const rReuse = await svc.route({ items: [routeItem({ key: 'topic:Billing', topic: 'Billing' })] })
    expect(rReuse).toEqual({
      status: 200,
      body: { matched: true, result: { ok: true } },
    })
    expect(tabCreated).toBe(1)

    // Wake enabled: POST /route delegates cleanly (pass-through, 503 -> retry 15, unreachable -> herdr fallback).
    const svcWakeOk = createNodeTelegram({
      cfg: { language: 'en', wake: { enabled: true, port: 44123 } } as unknown as Config,
      profiles: () => w.set,
      herdr: w.io,
      readSessions: () => sessions,
      fetch: async () => Response.json({ matched: true, result: { ok: true, note: 'from wake' } }),
      log: () => {},
    })
    expect(await svcWakeOk.route({ items: [routeItem()] })).toEqual({
      status: 200,
      body: { matched: true, result: { ok: true, note: 'from wake' } },
    })

    const svcWake503 = createNodeTelegram({
      cfg: { language: 'en', wake: { enabled: true, port: 44123 } } as unknown as Config,
      profiles: () => w.set,
      herdr: w.io,
      readSessions: () => sessions,
      fetch: async () => new Response('draining', { status: 503 }),
      log: () => {},
    })
    expect(await svcWake503.route({ items: [routeItem()] })).toEqual({
      status: 200,
      body: { matched: true, result: { retry: 15 } },
    })

    const svcWakeDown = createNodeTelegram({
      cfg: { language: 'en', wake: { enabled: true, port: 44123 } } as unknown as Config,
      profiles: () => w.set,
      herdr: w.io,
      readSessions: () => sessions,
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
      log: () => {},
    })
    expect(await svcWakeDown.route({ items: [routeItem({ key: PROJECT, text: 'after wake down' })] })).toEqual({
      status: 200,
      body: { matched: true, result: { ok: true } },
    })
  })

  test('restores original home/env after tests', () => {
    expect(outside()).toEqual(OUTSIDE)
  })
})
