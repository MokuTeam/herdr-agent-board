// Wake's Telegram router (src/services/wake/telegram.ts) against a stub tg-mcp on a port the system
// gives, the in-memory fake herdr and the real wake engine, in a temp home with a Default (.claude)
// and a Work (.claude-work) profile: off until turned on (tg-mcp in ~/.claude.json is not enough), a
// message for a sleeping session wakes it in its own profile before it is typed in, herdr-wake's
// notes go to Telegram word for word, and the token is never logged.
import { expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { findProfileDirs } from '../../src/adapters/profiles.ts'
import { mergeProfiles, profileSet } from '../../src/core/profiles.ts'
import { type TelegramTarget, telegramTarget, wakeConfig } from '../../src/core/wake/config.ts'
import type { RouteItem } from '../../src/core/wake/route.ts'
import type { WakeSessions } from '../../src/core/wake/sessions.ts'
import type { TelegramStatus } from '../../src/core/wake/status.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import { createTelegram } from '../../src/services/wake/telegram.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'
import { until } from '../support/sandbox.ts'
import { runningSession, SID } from '../support/wake-fixtures.ts'

/** The home and folders the tests run with, as this file loads: every test gives them back. */
const outside = () => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  homedir: homedir(),
})
const OUTSIDE = outside()

/** A project folder with spaces, Cyrillic and %: tg-mcp's key for it, as claude-tg sends it outside herdr. */
const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
const HOUR = 3_600_000
const TOKEN = 'tg-secret-7f3a'
/** How long the stub holds a /router/wait with nothing to hand out. */
const HOLD_MS = 200

// herdr-wake's notes to Telegram (router.mjs), word for word.
const NOTES = {
  blocked: '⏳ Сессия ждёт решения в терминале. Доставлю, когда освободится.',
  trust: '🔐 Сессия спрашивает, доверять ли папке проекта. Ответь в терминале, и я доставлю.',
  busy: '⏳ Панель сессии занята другой программой. Доставлю, когда она освободится.',
  timeout: '⏳ Сессия не успела запуститься, попробую ещё раз.',
  dialog: '⏳ В сессии открыт диалог. Доставлю, когда закроется.',
  draft: '✍️ В поле ввода сессии недописанный текст. Доставлю, когда оно освободится.',
  missing: (topic: string) =>
    `🤷 Не нашёл в herdr сессию для «${topic}». Сообщение ждёт в очереди: агент получит его, когда подключится.`,
  woke: (title: string) => `⏰ Разбудил сессию «${title}».`,
}

// Claude Code's input box as `herdr agent read --ansi` captures it: empty, or with text typed in.
const RULE = `\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const box = (line: string): string => ['● done', '', RULE, line, RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const EMPTY_BOX = box(`❯ \x1b[2mTry "fix the tests"\x1b[0m`)
const DRAFT_BOX = box('❯ \x1b[0mпроверь счёт')
const TRUST_SCREEN = 'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit'

interface Folders {
  home: string
  claude: string
  work: string
}

/**
 * A temp home with a Default and a Work profile folder, a fake herdr with these panes (each with an
 * empty input box) in workspace Main, the session file, wake on, and a clock that moves on at once
 * by what the engine sleeps.
 */
function world(o: { panes?: FakePane[]; shells?: Record<string, string>; sessions?: (f: Folders) => WakeSessions }) {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const folders: Folders = { home, claude: join(home, '.claude'), work: join(home, '.claude-work') }
  for (const folder of [folders.claude, folders.work]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'settings.json'), '{}')
  }
  const file = join(dir, 'state', 'wake-sessions.json')
  const sessions = o.sessions?.(folders)
  if (sessions !== undefined) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(sessions))
  }
  const panes = o.panes ?? []
  const io = fakeWakeHerdr({
    panes,
    workspaces: [{ workspace_id: 'w1', label: 'Main' }],
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
    log: text => {
      log.push(text)
    },
    now: () => clock.at,
    sleep: ms => {
      clock.at += ms
      return Promise.resolve()
    },
  }
  return { ...folders, file, io, log, deps }
}
type World = ReturnType<typeof world>

const claudePane = (pane: string, session: string, status = 'idle'): FakePane => ({
  pane_id: pane,
  tab_id: 't1',
  workspace_id: 'w1',
  cwd: PROJECT,
  agent: 'claude',
  agent_status: status,
  agent_session: { value: session },
  terminal_title_stripped: 'Billing',
})
const shellPane = (pane: string): FakePane => ({ pane_id: pane, tab_id: 't1', workspace_id: 'w1', cwd: PROJECT })

const is =
  (...words: string[]) =>
  (argv: string[]) =>
    words.every((w, i) => argv[i] === w)

/** Claude comes up in the pane once the wake line runs there (idle unless `status`), registered in `dir`. */
function startsOnRun(io: FakeWakeHerdr, pane: FakePane, dir: string, status = 'idle'): void {
  io.on(is('pane', 'run', pane.pane_id), () => {
    pane.agent = 'claude'
    pane.agent_status = status
    pane.agent_session = { value: SID }
    io.busy.add(pane.pane_id)
    runningSession(dir, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  })
}

/** A Work session asleep in w1:p1 (a bash prompt), as wake recorded it. */
function workSleeper(): { w: World; pane: FakePane } {
  const pane = shellPane('w1:p1')
  const at = Date.now() - HOUR
  const w = world({
    panes: [pane],
    shells: { 'w1:p1': 'bash' },
    sessions: f => ({
      'w1:p1': {
        session: SID,
        name: 'Billing',
        title: 'Billing chat',
        cwd: PROJECT,
        seen_at: at,
        slept_at: at,
        profileDir: f.work,
        profile: 'work',
      },
    }),
  })
  return { w, pane }
}

const readSessions = (file: string): WakeSessions => JSON.parse(readFileSync(file, 'utf8'))
/** What was typed or pressed in a pane. */
const typed = (io: FakeWakeHerdr): string[][] =>
  io.calls.filter(c => (c[0] === 'pane' && ['run', 'send-keys', 'send-text'].includes(c[1] ?? '')) || c[1] === 'prompt')

interface Stub {
  url: string
  host: string
  /** Each /router/wait: its Authorization and timeout. */
  waits: { authorization: string | null; timeout: string | null }[]
  /** Each /router/ack: its Authorization and body. */
  acks: { authorization: string | null; body: unknown }[]
  /** What /router/wait answers with (404: tg-mcp without ROUTER=1). */
  answer: number
  /** Items for the next /router/wait. */
  push(items: RouteItem[]): void
}

/** A stub tg-mcp's router queue: /router/wait hands out what was pushed (else nothing, after HOLD_MS), /router/ack records. */
function tgMcp(): Stub {
  const batches: RouteItem[][] = []
  let more: () => void = () => {}
  const stub: Stub = {
    url: '',
    host: '',
    waits: [],
    acks: [],
    answer: 200,
    push(items) {
      batches.push(items)
      more()
    },
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const authorization = req.headers.get('authorization')
      if (url.pathname === '/router/wait') {
        stub.waits.push({ authorization, timeout: url.searchParams.get('timeout') })
        if (stub.answer !== 200) return new Response('no', { status: stub.answer })
        if (batches.length === 0)
          await Promise.race([
            new Promise<void>(resolve => {
              more = resolve
            }),
            Bun.sleep(HOLD_MS),
          ])
        return Response.json({ items: batches.shift() ?? [] })
      }
      if (url.pathname === '/router/ack' && req.method === 'POST') {
        stub.acks.push({ authorization, body: await req.json() })
        return Response.json({ ok: true })
      }
      return new Response(null, { status: 404 })
    },
  })
  onTestFinished(() => server.stop(true))
  stub.url = server.url.origin
  stub.host = server.url.host
  return stub
}

/** ~/.claude.json with tg-mcp as its `telegram` MCP server. */
const claudeJson = (stub: Stub) => ({
  mcpServers: { telegram: { url: `${stub.url}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } },
})
/** tg-mcp's url and token as wake finds them with `telegram` set to `mode`. */
const targetOf = (stub: Stub, mode: unknown): TelegramTarget | null =>
  telegramTarget(wakeConfig({ enabled: true, telegram: mode }), claudeJson(stub))

/** The router over the engine of `w`, stopped when the test ends; the states it reported, in order. */
function router(
  w: World,
  o: {
    target: () => TelegramTarget | null
    fetch?: (url: string, init: RequestInit) => Promise<Response>
    sleep?: (ms: number) => Promise<void>
  },
) {
  const engine = createWakeEngine(w.deps)
  const states: TelegramStatus[] = []
  const telegram = createTelegram({
    engine,
    herdr: w.io,
    target: o.target,
    machine: 'TESTBOX',
    pollTimeoutSec: () => 25,
    log: text => {
      w.log.push(text)
    },
    onState: s => {
      states.push(s)
    },
    ...(o.fetch && { fetch: o.fetch }),
    ...(o.sleep && { sleep: o.sleep }),
  })
  onTestFinished(() => telegram.stop())
  return { engine, telegram, states }
}

const item = (id: number, o: Partial<RouteItem> = {}): RouteItem => ({
  id,
  key: PROJECT,
  topic: 'Billing',
  text: 'проверь счёт',
  meta: { message_id: String(40 + id) },
  queued_at: new Date().toISOString(),
  ...o,
})

test('off by default even with tg-mcp in ~/.claude.json: no poll', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)] })
  const tg = tgMcp()
  const fetched: string[] = []
  const { engine, telegram, states } = router(w, {
    target: () => telegramTarget(wakeConfig({ enabled: true }), claudeJson(tg)),
    fetch: (url, init) => {
      fetched.push(url)
      return fetch(url, init)
    },
  })

  telegram.start()
  await Bun.sleep(HOLD_MS * 2)
  expect(fetched).toEqual([])
  expect(tg.waits).toEqual([])
  expect(states).toEqual([])
  expect(w.io.calls).toEqual([])
  expect((await engine.status()).telegram).toEqual({ state: 'off' })
})

test('auto: a message for a sleeping Work session wakes it with --profile work, then is typed, then acked delivered with the wake note', async () => {
  const { w, pane } = workSleeper()
  startsOnRun(w.io, pane, w.work)
  const tg = tgMcp()
  const { engine, telegram, states } = router(w, { target: () => targetOf(tg, 'auto') })

  tg.push([item(11)])
  telegram.start()
  await until(() => tg.acks.length === 1)

  expect(typed(w.io)).toEqual([
    ['pane', 'send-keys', 'w1:p1', 'ctrl+u'],
    ['pane', 'run', 'w1:p1', `board resume ${SID} --profile work`],
    ['agent', 'prompt', 'w1:p1', '[telegram message_id=51]\nпроверь счёт'],
  ])
  expect(tg.acks).toEqual([
    { authorization: `Bearer ${TOKEN}`, body: { id: 11, outcome: 'delivered', note: NOTES.woke('Billing chat') } },
  ])
  expect(tg.waits[0]).toEqual({ authorization: `Bearer ${TOKEN}`, timeout: '25' })
  expect(readSessions(w.file)['w1:p1']).not.toHaveProperty('slept_at')
  expect(w.log).toContain(`delivered 1 message(s) for ${PROJECT} to w1:p1 after waking it`)
  expect(engine.telegram.lastPoll).toBeString()
  expect((await engine.status()).telegram).toEqual({ state: 'polling', host: tg.host })
  expect(states).toEqual([{ state: 'polling', host: tg.host }])
  expect(w.log.join('\n')).not.toContain(TOKEN)
})

test('a draft in the input box: retried, its note said once', async () => {
  const pane = claudePane('w1:p1', SID)
  const w = world({ panes: [pane] })
  w.io.inputBoxes['w1:p1'] = DRAFT_BOX
  const tg = tgMcp()
  const { telegram } = router(w, { target: () => targetOf(tg, 'auto') })

  tg.push([item(5)])
  telegram.start()
  await until(() => tg.acks.length === 1)
  tg.push([item(5)])
  await until(() => tg.acks.length === 2)
  expect(tg.acks.map(a => a.body)).toEqual([
    { id: 5, outcome: 'retry', note: NOTES.draft, retry_sec: 30 },
    { id: 5, outcome: 'retry', retry_sec: 30 },
  ])
  expect(typed(w.io)).toEqual([])
  expect(w.log).toContain(`retry 1 message(s) for ${PROJECT}: ${NOTES.draft}`)

  // The box empty again: typed in, acked delivered, without a note (nobody was woken).
  w.io.inputBoxes['w1:p1'] = EMPTY_BOX
  tg.push([item(5)])
  await until(() => tg.acks.length === 3)
  expect(tg.acks[2]?.body).toEqual({ id: 5, outcome: 'delivered' })
  expect(typed(w.io)).toEqual([['agent', 'prompt', 'w1:p1', '[telegram message_id=45]\nпроверь счёт']])
})

test('no pane for the key: skipped with the note', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)] })
  const tg = tgMcp()
  const { telegram } = router(w, { target: () => targetOf(tg, 'auto') })

  tg.push([item(9, { key: 'topic:Nowhere', topic: 'Nowhere' })])
  telegram.start()
  await until(() => tg.acks.length === 1)
  expect(tg.acks.map(a => a.body)).toEqual([{ id: 9, outcome: 'skipped', note: NOTES.missing('Nowhere') }])
  expect(typed(w.io)).toEqual([])
  expect(w.log).toContain(`skipped 1 message(s) for topic:Nowhere: ${NOTES.missing('Nowhere')}`)
})

test('switched off live: the poll stops', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)] })
  const tg = tgMcp()
  let on = true
  const { engine, telegram, states } = router(w, { target: () => (on ? targetOf(tg, 'auto') : null) })

  telegram.start()
  await until(() => tg.waits.length >= 1)
  // tg-mcp's url and token gone (Telegram turned off): the poll ends at its next round.
  on = false
  await until(() => engine.telegram.status.state === 'off')
  const seen = tg.waits.length
  await Bun.sleep(HOLD_MS * 3)
  expect(tg.waits.length).toBe(seen)

  // stop() ends the poll under way at once.
  on = true
  telegram.start()
  await until(() => tg.waits.length > seen)
  telegram.stop()
  expect(engine.telegram.status).toEqual({ state: 'off' })
  const then = tg.waits.length
  await Bun.sleep(HOLD_MS * 3)
  expect(tg.waits.length).toBe(then)
  expect(states).toEqual([
    { state: 'polling', host: tg.host },
    { state: 'off' },
    { state: 'polling', host: tg.host },
    { state: 'off' },
  ])
  expect(w.log).toEqual([
    `Telegram on: polling tg-mcp at ${tg.host}`,
    'Telegram off',
    `Telegram on: polling tg-mcp at ${tg.host}`,
    'Telegram off',
  ])
})

test('tg-mcp without router endpoints: the error said once, the retries 1 s doubling to 60 s, then connected again', async () => {
  const w = world({ panes: [] })
  const tg = tgMcp()
  tg.answer = 404
  const pauses: number[] = []
  const { engine, telegram, states } = router(w, {
    target: () => targetOf(tg, 'auto'),
    sleep: async ms => {
      pauses.push(ms)
      await Bun.sleep(2)
    },
  })
  const error = 'the server has no router endpoints (ROUTER=1 not set?)'

  telegram.start()
  await until(() => pauses.length >= 8)
  expect(pauses.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
  expect(engine.telegram.lastError).toBe(error)
  expect((await engine.status()).telegram).toEqual({ state: 'error', host: tg.host, error })
  expect(w.log.filter(l => l.startsWith('poll failed'))).toEqual([`poll failed: ${error}`])

  tg.answer = 200
  await until(() => engine.telegram.status.state === 'polling')
  expect(engine.telegram.lastError).toBeNull()
  expect(w.log).toContain('connected to tg-mcp again')
  expect(states).toEqual([
    { state: 'polling', host: tg.host },
    { state: 'error', host: tg.host, error },
    { state: 'polling', host: tg.host },
  ])
  expect(w.log.join('\n')).not.toContain(TOKEN)
})

test('a delivery counts as under way until its acks are sent', async () => {
  const { w, pane } = workSleeper()
  startsOnRun(w.io, pane, w.work)
  const tg = tgMcp()
  let typing = () => {}
  const reached = new Promise<void>(resolve => {
    typing = resolve
  })
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  const io = w.io
  w.deps.herdr = {
    ...io,
    prompt: async (p, text) => {
      typing()
      await opened
      await io.prompt(p, text)
    },
  }
  const engine = createWakeEngine(w.deps)
  const telegram = createTelegram({
    engine,
    herdr: w.deps.herdr,
    target: () => targetOf(tg, 'auto'),
    machine: 'TESTBOX',
    pollTimeoutSec: () => 25,
    log: text => {
      w.log.push(text)
    },
  })
  onTestFinished(() => telegram.stop())

  tg.push([item(3)])
  telegram.start()
  await reached
  expect(engine.busy()).toBeGreaterThanOrEqual(1)
  open()
  await until(() => tg.acks.length === 1)
  await until(() => engine.busy() === 0)
})

/** What a message for w1:p1 comes back with when the pane, after or without a wake, is like this. */
test.each([
  [
    'its pane runs another program: retried in 2 min',
    (w: World, pane: FakePane) => {
      w.io.busy.add(pane.pane_id)
    },
    { retry: 120, note: NOTES.busy },
  ],
  ['it does not start in time: retried in a minute', () => {}, { retry: 60, note: NOTES.timeout }],
  [
    'it asks whether to trust the folder: retried in a minute',
    (w: World, pane: FakePane) => {
      startsOnRun(w.io, pane, w.work, 'blocked')
      w.io.screens['w1:p1'] = TRUST_SCREEN
    },
    { retry: 60, note: NOTES.trust },
  ],
  [
    'it waits for an answer in its terminal: retried in a minute',
    (w: World, pane: FakePane) => {
      startsOnRun(w.io, pane, w.work, 'blocked')
      w.io.screens['w1:p1'] = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
    },
    { retry: 60, note: NOTES.blocked },
  ],
  [
    'a dialog is open in it once awake: retried in 30 s',
    (w: World, pane: FakePane) => {
      startsOnRun(w.io, pane, w.work)
      w.io.inputBoxes['w1:p1'] = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
    },
    { retry: 30, note: NOTES.dialog },
  ],
])('a sleeping session whose %s, with herdr-wake’s note', async (_, arrange, expected) => {
  const { w, pane } = workSleeper()
  arrange(w, pane)
  const { telegram } = router(w, { target: () => null })
  expect(await telegram.route([item(1)])).toEqual(expected)
  expect(typed(w.io).filter(c => c[1] === 'prompt')).toEqual([])
})

test('a running session that waits for an answer, or asks about trust: herdr-wake’s notes, nothing typed', async () => {
  const pane = claudePane('w1:p1', SID, 'blocked')
  const w = world({ panes: [pane] })
  const { telegram } = router(w, { target: () => null, sleep: () => Bun.sleep(1) })
  w.io.screens['w1:p1'] = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'
  expect(await telegram.route([item(1)])).toEqual({ retry: 60, note: NOTES.blocked })
  w.io.screens['w1:p1'] = TRUST_SCREEN
  expect(await telegram.route([item(1)])).toEqual({ retry: 60, note: NOTES.trust })
  expect(typed(w.io)).toEqual([])
})

test('route is the --deliver path: no tg-mcp asked, a running session typed into at once', async () => {
  const w = world({ panes: [claudePane('w1:p1', SID)] })
  const fetched: string[] = []
  const { telegram } = router(w, {
    target: () => null,
    fetch: (url, init) => {
      fetched.push(url)
      return fetch(url, init)
    },
  })
  expect(await telegram.route([item(0, { meta: { message_id: 'test' } })])).toEqual({ ok: true })
  expect(typed(w.io)).toEqual([['agent', 'prompt', 'w1:p1', '[telegram message_id=test]\nпроверь счёт']])
  expect(fetched).toEqual([])
})

test('a topic key (claude-tg in herdr) reaches the Claude in the tab it names, not the one of the same folder elsewhere', async () => {
  const other = { ...claudePane('w1:p1', SID), tab_id: 't1' }
  const named = { ...claudePane('w1:p2', SID), tab_id: 't2', terminal_title_stripped: 'Ledger' }
  const w = world({ panes: [other, named] })
  w.io.tabs = [
    { tab_id: 't1', workspace_id: 'w1', number: 1 },
    { tab_id: 't2', workspace_id: 'w1', label: 'Отчёты', number: 2 },
    { tab_id: 't3', workspace_id: 'w1', label: 'Ledger', number: 3 },
  ]
  const { telegram } = router(w, { target: () => null })
  expect(await telegram.route([item(1, { key: 'topic:Main / Ledger' })])).toEqual({
    skip: true,
    note: NOTES.missing('Billing'),
  })
  expect(await telegram.route([item(2, { key: 'topic:Main' })])).toEqual({ ok: true })
  expect(await telegram.route([item(3, { key: 'topic:Main /' })])).toEqual({ ok: true })
  expect(typed(w.io).map(c => c[2])).toEqual(['w1:p1', 'w1:p2'])
})

// Last in the file: the files bun runs after this one in the same process find the home and the
// folders as they were, not a temp folder a test has deleted.
test('every test gives back the home and folders it found', () => {
  expect(outside()).toEqual(OUTSIDE)
})
