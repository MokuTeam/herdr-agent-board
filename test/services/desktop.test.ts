// The desktops in the board's process (services/desktop.ts), with a server of the test's own (its
// programs fake): started on demand, a slot each, stopped when the session sleeps or ends, a named
// profile's copy for a second session, control and asks, taken over by the next board, and the
// owner's last view closing hands the browser back.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { CardPatch } from '../../src/adapters/cards.ts'
import { handedBackText } from '../../src/core/desktop.ts'
import type { Card, Item } from '../../src/core/types.ts'
import {
  createDesktops,
  type DesktopSystem,
  type DesktopsOptions,
  displayHeldAt,
  type VncData,
} from '../../src/services/desktop.ts'
import { type DesktopVideo, VIDEO_NONE, type VideoSource, type VideoViewer } from '../../src/services/desktop-video.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Proc {
  argv: string[]
  env: Record<string, string>
  cmdline: string
  alive: boolean
  end: () => void
}

/**
 * A server whose Xvnc makes its socket and whose Chrome (under its holder) makes its DevTools
 * socket at once (or once `ready` resolves); what ran, and what it was told.
 */
function fakeServer(
  o: {
    held?: number[]
    noChrome?: boolean
    chromeFails?: boolean
    ready?: () => Promise<void>
    arch?: string
    /** xkbcomp on PATH, done at once. */
    xkbcomp?: boolean
    /** Chrome asked to quit (Browser.close) ends once this resolves. */
    quitting?: () => Promise<void>
    /** Chrome asked to quit answers, and runs on. */
    quitIgnored?: boolean
    /** Chrome run to hand an address on does not end in time (or fails). */
    relayFails?: boolean
    /** A server with no way to hand an address on (a test system of before). */
    noRelay?: boolean
  } = {},
) {
  const procs = new Map<number, Proc>()
  /** The DevTools sockets Chrome was asked to quit on, and the pids a signal ended. */
  const quits: string[] = []
  const killed: number[] = []
  /** Each Chrome run to hand an address to a running one: its arguments, environment and wait. */
  const relays: { argv: string[]; env: Record<string, string>; ms: number }[] = []
  let next = 1000
  function start(argv: string[], env: Record<string, string>, mark = '') {
    const pid = next++
    let end = (): void => {}
    const exited = new Promise<unknown>(resolve => {
      end = () => resolve(0)
    })
    const p: Proc = {
      argv,
      env,
      cmdline: [...argv, mark].join(' '),
      alive: true,
      end: () => {
        p.alive = false
        end()
      },
    }
    procs.set(pid, p)
    return { pid, exited, p }
  }
  const sys: DesktopSystem = {
    spawn(argv, env) {
      const { pid, exited, p } = start(argv, env)
      if (argv[0] === '/usr/bin/Xvnc') writeFileSync(argv[argv.indexOf('-rfbunixpath') + 1] as string, '')
      if (argv[0] === '/usr/bin/xkbcomp') p.end()
      return { pid, exited }
    },
    spawnChrome(argv, cdp, env) {
      const { pid, exited, p } = start(argv, env, cdp)
      if (o.chromeFails) p.end()
      else
        void (async () => {
          await o.ready?.()
          if (p.alive) writeFileSync(cdp, '')
        })()
      return { pid, exited }
    },
    kill(pid) {
      const p = procs.get(pid)
      if (!p?.alive) return
      killed.push(pid)
      p.end()
    },
    async quit(cdp) {
      quits.push(cdp)
      await o.quitting?.()
      if (o.quitIgnored) return
      for (const p of procs.values()) if (p.alive && p.argv[0] === '/usr/bin/chrome' && p.cmdline.endsWith(cdp)) p.end()
    },
    ...(!o.noRelay && {
      async relay(argv: string[], env: Record<string, string>, ms: number) {
        relays.push({ argv, env, ms })
        return !o.relayFails
      },
    }),
    alive: pid => !!procs.get(pid)?.alive,
    cmdline: pid => procs.get(pid)?.cmdline ?? '',
    displayHeld: d => (o.held ?? []).includes(d) || [...procs.values()].some(p => p.alive && p.argv[1] === `:${d}`),
    cdpReady: async cdp => {
      await o.ready?.()
      await Bun.sleep(0)
      return existsSync(cdp)
    },
    which: name =>
      name === 'Xvnc'
        ? '/usr/bin/Xvnc'
        : name === 'google-chrome-stable' && !o.noChrome
          ? '/usr/bin/chrome'
          : name === 'xkbcomp' && o.xkbcomp
            ? '/usr/bin/xkbcomp'
            : null,
    sleep: async () => {},
  }
  return { sys, procs, start, quits, killed, relays }
}

/** The card as the patches written made it ('' clears a field, as adapters/cards.ts has it). */
function cardOf(cards: [string, CardPatch][], key: string): Card | null {
  const mine = cards.filter(([k]) => k === key)
  if (!mine.length) return null
  const card: Record<string, unknown> = {}
  for (const [, patch] of mine)
    for (const [field, value] of Object.entries(patch)) {
      if (value === '') delete card[field]
      else card[field] = value
    }
  return card as Card
}

const item = (key: string, pane: string | null, more: Partial<Item> = {}): Item =>
  ({ key, pane, session: key, name: key, sleeping: false, ...more }) as Item

function setup(
  o: Parameters<typeof fakeServer>[0] = {},
  items: Item[] = [item('s1', 'w0:p1'), item('s2', 'w0:p2')],
  more: Partial<DesktopsOptions> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'desktops-'))
  dirs.push(root)
  const server = fakeServer(o)
  const cards: [string, CardPatch][] = []
  const reminders: [string, string][] = []
  let clock = 1_000_000
  const state = { items, changes: 0 }
  const make = () =>
    createDesktops({
      root,
      items: () => state.items,
      writeCard: (key, patch) => cards.push([key, patch]),
      readCard: key => cardOf(cards, key),
      remind: (it, text) => reminders.push([it.key, text]),
      onChange: () => state.changes++,
      log: () => {},
      system: server.sys,
      ...(o.arch && { arch: o.arch }),
      now: () => clock,
      ...more,
    })
  return { root, server, cards, reminders, state, make, d: make(), tick: (ms: number) => (clock += ms) }
}

/** The Chromes running, in the order they started. */
const chromeOf = (procs: Map<number, Proc>) =>
  [...procs.values()].filter(p => p.alive && p.argv[0] === '/usr/bin/chrome')

test('on demand: nothing runs before the first call; then a display and Chrome of its own, a slot each', async () => {
  const { d, server, state } = setup()
  expect(server.procs.size).toBe(0)
  expect(d.view(state.items[0] as Item)).toBeUndefined()
  const a = await d.ensure('w0:p1')
  const b = await d.ensure('w0:p2')
  expect([a, b]).toEqual([{ ok: true }, { ok: true }])
  // the same session again: what runs, nothing new
  expect(await d.ensure('w0:p1')).toEqual({ ok: true })
  const xvncs = [...server.procs.values()].filter(p => p.argv[0] === '/usr/bin/Xvnc')
  expect(xvncs.map(p => p.argv[1])).toEqual([':100', ':101'])
  const chromes = chromeOf(server.procs)
  expect(chromes.map(p => p.env.DISPLAY)).toEqual([':100', ':101'])
  expect(chromes[0]?.env.XAUTHORITY).toMatch(/sessions[\\/]100[\\/]Xauthority$/)
  expect(d.view(state.items[0] as Item)).toEqual({ running: true, profile: null, control: 'agent', asks: false })
})

test('two sessions starting at once never share a slot', async () => {
  const { d, server } = setup()
  const [a, b] = await Promise.all([d.ensure('w0:p1'), d.ensure('w0:p2')])
  expect([a, b]).toEqual([{ ok: true }, { ok: true }])
  expect([...server.procs.values()].filter(p => p.argv[0] === '/usr/bin/Xvnc').map(p => p.argv[1])).toEqual([
    ':100',
    ':101',
  ])
})

test('a display someone else holds is skipped', async () => {
  const { d, server } = setup({ held: [100] })
  expect(await d.ensure('w0:p1')).toEqual({ ok: true })
  expect([...server.procs.values()][0]?.argv[1]).toBe(':101')
})

test('Ubuntu’s arm64: the board’s own Chromium (Playwright’s) where the install put it, before any other; elsewhere not looked for', async () => {
  const own = (root: string, complete = true): string => {
    const dir = join(root, 'chromium', 'chromium-1248')
    mkdirSync(join(dir, 'chrome-linux-arm64'), { recursive: true })
    writeFileSync(join(dir, 'chrome-linux-arm64', 'chrome'), '')
    if (complete) writeFileSync(join(dir, 'INSTALLATION_COMPLETE'), '')
    return join(dir, 'chrome-linux-arm64', 'chrome')
  }
  const chromeBin = (s: ReturnType<typeof setup>) =>
    [...s.server.procs.values()].find(p => p.alive && p.argv[0] !== '/usr/bin/Xvnc')?.argv[0]
  // arm64 with the board's Chromium: it, though a Chrome (Ubuntu's snap wrapper) is on the PATH
  const arm = setup({ arch: 'arm64' })
  const bin = own(arm.root)
  expect(await arm.d.ensure('w0:p1')).toEqual({ ok: true })
  expect(chromeBin(arm)).toBe(bin)
  // and with no other browser at all
  const only = setup({ arch: 'arm64', noChrome: true })
  own(only.root)
  expect(await only.d.ensure('w0:p1')).toEqual({ ok: true })
  // half downloaded (no INSTALLATION_COMPLETE): not taken
  const half = setup({ arch: 'arm64' })
  own(half.root, false)
  await half.d.ensure('w0:p1')
  expect(chromeBin(half)).toBe('/usr/bin/chrome')
  // x86_64 (and so every other setup): the PATH's, as before, whatever the folder holds
  const x64 = setup({ arch: 'x64' })
  own(x64.root)
  await x64.d.ensure('w0:p1')
  expect(chromeBin(x64)).toBe('/usr/bin/chrome')
})

test('no browser on the server, or one that does not start: said, and nothing left running', async () => {
  const none = setup({ noChrome: true })
  const r = await none.d.ensure('w0:p1')
  expect(r.ok).toBe(false)
  expect([...none.server.procs.values()].some(p => p.alive)).toBe(false)
  const fails = setup({ chromeFails: true })
  expect((await fails.d.ensure('w0:p1')).ok).toBe(false)
  expect([...fails.server.procs.values()].some(p => p.alive)).toBe(false)
  expect(existsSync(join(fails.root, 'sessions', '100'))).toBe(false)
})

test('stopped when the session has slept or been gone for 2 minutes on end; a short sleep keeps it; others go on', async () => {
  const { d, server, state, tick, root } = setup()
  await d.ensure('w0:p1')
  await d.ensure('w0:p2')
  // asleep a while (a restart: sleep, then wake), then back: kept, and the clock starts again
  state.items = [item('s1', 'w0:p1', { sleeping: true }), item('s2', 'w0:p2')]
  d.observe(state.items)
  tick(90_000)
  d.observe(state.items)
  d.observe([item('s1', 'w0:p1'), item('s2', 'w0:p2')])
  tick(60_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect(chromeOf(server.procs)).toHaveLength(2)
  // a snapshot that misses the pane once, then has it: kept
  d.observe([item('s2', 'w0:p2')])
  tick(61_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect(chromeOf(server.procs)).toHaveLength(2)
  tick(60_000)
  d.observe(state.items)
  await d.ensure('w0:p2') // waits behind nothing; lets the stop run
  await Bun.sleep(10)
  expect(chromeOf(server.procs).map(p => p.env.DISPLAY)).toEqual([':101'])
  expect(existsSync(join(root, 'sessions', '100'))).toBe(false)
  expect(d.view(state.items[0] as Item)).toBeUndefined()
  // ended: no session in its pane any more
  state.items = []
  d.observe(state.items)
  tick(120_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect([...server.procs.values()].some(p => p.alive)).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'desktops.json'), 'utf8'))).toEqual([])
})

test('a named profile: kept for later; a second session asking for it gets a throwaway copy', async () => {
  const { d, server, root } = setup()
  expect(await d.profile('w0:p1', 'github')).toEqual({ ok: true, copy: false })
  const own = join(root, 'profiles', 'github')
  expect(chromeOf(server.procs)[0]?.argv).toContain(`--user-data-dir=${own}`)
  writeFileSync(join(own, 'Cookies'), 'signed in')
  writeFileSync(join(own, 'SingletonLock'), 'held')
  mkdirSync(join(own, 'Cache'))
  const r = await d.profile('w0:p2', 'github')
  expect(r).toEqual({ ok: true, copy: true })
  const copy = join(root, 'sessions', '101', 'copy-github')
  expect(chromeOf(server.procs)[1]?.argv).toContain(`--user-data-dir=${copy}`)
  expect(readFileSync(join(copy, 'Cookies'), 'utf8')).toBe('signed in')
  expect(existsSync(join(copy, 'SingletonLock'))).toBe(false)
  expect(existsSync(join(copy, 'Cache'))).toBe(false)
  // the copy's changes are never merged back; it goes with its session, the profile stays
  writeFileSync(join(copy, 'Cookies'), 'changed')
  await d.stop('w0:p2', 'test')
  expect(existsSync(copy)).toBe(false)
  expect(readFileSync(join(own, 'Cookies'), 'utf8')).toBe('signed in')
  await d.stop('w0:p1', 'test')
  expect(existsSync(own)).toBe(true)
})

test('switching profiles restarts Chrome on the same display; none is the session’s own folder', async () => {
  const { d, server, root } = setup()
  await d.ensure('w0:p1')
  expect(chromeOf(server.procs)[0]?.argv).toContain(`--user-data-dir=${join(root, 'sessions', '100', 'profile')}`)
  await d.profile('w0:p1', 'client-x')
  const alive = chromeOf(server.procs)
  expect(alive).toHaveLength(1)
  expect(alive[0]?.argv).toContain(`--user-data-dir=${join(root, 'profiles', 'client-x')}`)
  expect([...server.procs.values()].filter(p => p.argv[0] === '/usr/bin/Xvnc' && p.alive)).toHaveLength(1)
})

test('ask: the card under "needs you", the desktop up, asks while the card asks; handed back clears both', async () => {
  const { d, state, cards, root } = setup()
  expect(await d.ask('w0:p9', 'Sign in')).toEqual({ ok: false, error: 'this session is not on the board' })
  expect((await d.ask('w0:p1', 'Sign in to GitHub')).ok).toBe(true)
  expect(cards).toEqual([
    ['s1', { ask: 'Sign in to GitHub', askSince: expect.any(Number), askBrowser: expect.any(Number), by: 'agent' }],
  ])
  const asking = item('s1', 'w0:p1', { question: 'Sign in to GitHub', askSince: cards[0]?.[1].askSince as number })
  expect(d.view(asking)).toEqual({
    running: true,
    profile: null,
    control: 'agent',
    asks: true,
    ask: 'Sign in to GitHub',
  })
  const vnc = await vncServer(root)
  const ws = await vnc.open(d, 'w0:p1')
  expect(d.setControl(asking, 'owner')).toEqual({ ok: true, control: 'owner' })
  expect(d.control('w0:p1')).toBe('owner')
  expect(d.view(asking)?.asks).toBe(true)
  expect(d.setControl(asking, 'agent')).toEqual({ ok: true, control: 'agent' })
  expect(d.view(asking)?.asks).toBe(false)
  expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '', askBrowser: '' }])
  d.websocket.close?.(ws, 1000, '')
  vnc.close()
  // the agent went on (`board doing`: the card asks no more): asks goes too, and stays gone
  await d.ask('w0:p1', 'Solve the captcha')
  cards.push(['s1', { doing: 'Reading the page', ask: '', askSince: '', by: 'agent' }])
  state.items = [item('s1', 'w0:p1'), item('s2', 'w0:p2')]
  d.observe(state.items)
  expect(d.view(asking)?.asks).toBe(false)
  // no desktop, or asleep: no control to take
  const none = { ok: false, status: 404, error: 'no desktop' } as const
  expect(d.setControl(item('s2', 'w0:p2'), 'owner')).toEqual(none)
  expect(d.setControl(item('s1', 'w0:p1', { sleeping: true }), 'owner')).toEqual(none)
  expect(d.control('w0:p2')).toBe('agent')
})

test('the agent working on keeps its browser ask and its words; over once its card asks no more, or handed back (its card’s ask too)', async () => {
  const { d, cards, root, state, make } = setup()
  await d.ask('w0:p1', 'Sign in to GitHub as acme-bot')
  // the agent works on (its browser tools wait): its item shows no ask while the turn is on
  const working = item('s1', 'w0:p1', { status: 'working', attention: '', question: '', askSince: null })
  state.items = [working, item('s2', 'w0:p2')]
  d.observe(state.items)
  // (and its card says it, under "needs you": below)
  expect(d.view(working)).toEqual({
    running: true,
    profile: null,
    control: 'agent',
    asks: true,
    ask: 'Sign in to GitHub as acme-bot',
  })
  // "No reply needed" (its card's ask cleared): over
  cards.push(['s1', { ask: '', askSince: '' }])
  d.observe(state.items)
  expect(d.view(working)?.ask).toBeUndefined()
  // asked again, taken and handed back while the agent works: the card's ask goes with it
  await d.ask('w0:p1', 'Solve the captcha')
  const vnc = await vncServer(root)
  try {
    await vnc.open(d, 'w0:p1')
    d.observe(state.items)
    expect(d.setControl(working, 'owner').ok).toBe(true)
    expect(d.view(working)?.ask).toBe('Solve the captcha')
    d.setControl(working, 'agent')
    expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '', askBrowser: '' }])
    expect(d.view(working)?.ask).toBeUndefined()
  } finally {
    vnc.close()
  }
  // the next board knows what is asked
  await d.ask('w0:p1', 'Pick the account')
  expect(make().view(working)?.ask).toBe('Pick the account')
})

test('while the agent works on, its card is under "needs you" with the browser ask as its question, as a board ask; once the ask ends, as its state says', async () => {
  const { d, cards, root, state, tick } = setup()
  const working = item('s1', 'w0:p1', {
    status: 'working',
    column: 'work',
    attention: '',
    question: '',
    askSince: null,
  })
  state.items = [working, item('s2', 'w0:p2')]
  // no browser, or one that asks nothing: the card as it is
  expect(d.card(working)).toEqual({})
  await d.ensure('w0:p1')
  d.observe(state.items)
  expect(d.card(working)).toEqual({})
  tick(5)
  await d.ask('w0:p1', 'Sign in to GitHub as acme-bot')
  const since = cards.at(-1)?.[1].askSince as number
  d.observe(state.items)
  expect(d.card(working)).toEqual({
    column: 'me',
    attention: 'ask',
    question: 'Sign in to GitHub as acme-bot',
    askSince: since,
  })
  // "Open its browser" under it
  expect(d.view(working)?.asks).toBe(true)
  // out of the turn the card's own ask is the item's already; a permission dialog stays the decision it is; asleep, nothing
  const done = item('s1', 'w0:p1', { status: 'done', column: 'me', attention: 'ask', question: 'x', askSince: since })
  expect(d.card(done)).toEqual({})
  expect(d.view(done)?.asks).toBe(true)
  expect(d.card(item('s1', 'w0:p1', { status: 'blocked', column: 'me', attention: 'decision' }))).toEqual({})
  expect(d.card(item('s1', 'w0:p1', { status: 'working', sleeping: true }))).toEqual({})
  // `board doing` (the card asks no more): back to what its state says
  cards.push(['s1', { doing: 'Reading the page', ask: '', askSince: '', by: 'agent' }])
  d.observe(state.items)
  expect(d.card(working)).toEqual({})
  expect(d.view(working)?.asks).toBe(false)
  // another ask over it (`board ask`): the browser's is over
  await d.ask('w0:p1', 'Solve the captcha')
  expect(d.card(working).question).toBe('Solve the captcha')
  tick(5)
  cards.push(['s1', { ask: 'Which branch?', askSince: since + 10, by: 'agent' }])
  d.observe(state.items)
  expect(d.card(working)).toEqual({})
  // handed back: over
  await d.ask('w0:p1', 'Pick the account')
  const vnc = await vncServer(root)
  try {
    await vnc.open(d, 'w0:p1')
    d.setControl(working, 'owner')
    expect(d.card(working).column).toBe('me')
    d.setControl(working, 'agent')
    expect(d.card(working)).toEqual({})
  } finally {
    vnc.close()
  }
})

test('the next board takes over what still runs; what does not is cleared away', async () => {
  const s = setup()
  await s.d.ensure('w0:p1')
  await s.d.ensure('w0:p2')
  const dead = chromeOf(s.server.procs)[1] as Proc
  // the second desktop's display is gone meanwhile (its Chrome left behind)
  const xvnc2 = [...s.server.procs.entries()].find(([, p]) => p.argv[1] === ':101')?.[0] as number
  s.server.sys.kill(xvnc2, 'SIGTERM')
  const next = s.make()
  expect(next.view(s.state.items[0] as Item)).toEqual({ running: true, profile: null, control: 'agent', asks: false })
  expect(next.view(s.state.items[1] as Item)).toBeUndefined()
  expect(dead.alive).toBe(false)
  expect(existsSync(join(s.root, 'sessions', '101'))).toBe(false)
  // the one taken over: the same Chrome, nothing started again
  const before = s.server.procs.size
  expect(await next.ensure('w0:p1')).toEqual({ ok: true })
  expect(s.server.procs.size).toBe(before)
})

test('the owner’s last view closing hands the browser back to the agent; one of two does not', async () => {
  const { d, state, root } = setup()
  await d.ensure('w0:p1')
  const asking = state.items[0] as Item
  expect(d.vncOf(asking)?.pane).toBe('w0:p1')
  const vnc = await vncServer(root)
  const a = await vnc.open(d, 'w0:p1')
  const b = await vnc.open(d, 'w0:p1')
  d.setControl(asking, 'owner')
  d.websocket.close?.(a, 1000, '')
  expect(d.control('w0:p1')).toBe('owner')
  d.websocket.close?.(b, 1000, '')
  expect(d.control('w0:p1')).toBe('agent')
  vnc.close()
})

/** A viewer's WebSocket as Bun hands it to the handler, on `socket`; the code it was closed with. */
function viewer(pane: string, socket = join(tmpdir(), 'no-such-vnc.sock')) {
  const ws = {
    data: { pane, socket },
    closed: 0,
    send: () => 0,
    close(code: number) {
      ws.closed = code
    },
    getBufferedAmount: () => 0,
  }
  return ws as typeof ws & ServerWebSocket<VncData>
}

/** A VNC server of the test's own (a named pipe on Windows): the bytes it got, its connections. */
async function vncServer(root: string) {
  const { createServer } = await import('node:net')
  const path =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\desk-` + Math.random().toString(36).slice(2)
      : join(root, 'v.sock')
  const got: number[] = []
  const conns: import('node:net').Socket[] = []
  const server = createServer(c => {
    conns.push(c)
    c.on('data', (b: Buffer) => got.push(...b))
  })
  await new Promise<void>(done => server.listen(path, done))
  /** A viewer on it, opened and connected. */
  const open = async (d: ReturnType<typeof createDesktops>, pane: string) => {
    const ws = viewer(pane, path)
    const before = conns.length
    d.websocket.open?.(ws)
    for (let i = 0; i < 200 && conns.length === before; i++) await Bun.sleep(5)
    await Bun.sleep(20)
    return ws
  }
  return { path, got, conns, open, close: () => server.close() }
}

test('the first view of a desktop gives its keyboard the Cyrillic letters (xkbcomp on its display, with its cookie); later views nothing more; without xkbcomp, as before', async () => {
  const { d, server, root } = setup({ xkbcomp: true })
  await d.ensure('w0:p1')
  const xkb = () => [...server.procs.values()].filter(p => p.argv[0] === '/usr/bin/xkbcomp')
  expect(xkb()).toEqual([])
  const vnc = await vncServer(root)
  try {
    await vnc.open(d, 'w0:p1')
    await vnc.open(d, 'w0:p1')
    expect(xkb().map(p => [p.argv[1], p.argv[2], p.argv[4]])).toEqual([['-w', '0', ':100']])
    expect(xkb()[0]?.argv[3]).toMatch(/sessions[\\/]100[\\/]keymap\.xkb$/)
    expect(xkb()[0]?.env.XAUTHORITY).toMatch(/sessions[\\/]100[\\/]Xauthority$/)
    const map = readFileSync(xkb()[0]?.argv[3] as string, 'utf8')
    expect(map).toContain('include "pc+us+inet(evdev)"')
    expect(map).toContain('key <FK13> { type = "ALPHABETIC", [ U0430, U0410 ] };')
  } finally {
    vnc.close()
  }
  // no xkbcomp there: a view opens as before, nothing more runs
  const plain = setup()
  await plain.d.ensure('w0:p1')
  const before = plain.server.procs.size
  const vnc2 = await vncServer(plain.root)
  try {
    await vnc2.open(plain.d, 'w0:p1')
    expect(plain.server.procs.size).toBe(before)
  } finally {
    vnc2.close()
  }
})

test('a viewer’s keys, mouse and clipboard reach the display only while the owner has the browser', async () => {
  const { d, state, root } = setup()
  await d.ensure('w0:p1')
  const vnc = await vncServer(root)
  try {
    const ws = await vnc.open(d, 'w0:p1')
    const hello = [...new TextEncoder().encode('RFB 003.008\n'), 1, 1]
    const request = [3, 1, 0, 0, 0, 0, 0, 4, 0, 2]
    const key = [4, 1, 0, 0, 0, 0, 0, 0x61]
    const pointer = [5, 1, 0, 1, 0, 1]
    d.websocket.message?.(ws, Buffer.from([...hello, ...key, ...request, ...pointer]))
    expect(d.setControl(state.items[0] as Item, 'owner')).toEqual({ ok: true, control: 'owner' })
    d.websocket.message?.(ws, Buffer.from([...key, ...pointer]))
    d.setControl(state.items[0] as Item, 'agent')
    d.websocket.message?.(ws, Buffer.from([...key, ...request]))
    const want = [...hello, ...request, ...key, ...pointer, ...request]
    for (let i = 0; i < 100 && vnc.got.length < want.length; i++) await Bun.sleep(10)
    await Bun.sleep(30)
    expect(vnc.got).toEqual(want)
    // bytes it cannot read on from: the viewer is closed
    d.websocket.message?.(ws, Buffer.from([99]))
    expect(ws.closed).toBe(1008)
    d.websocket.close?.(ws, 1000, '')
  } finally {
    vnc.close()
  }
})

test('control: the owner takes it only with a view connected; the next board gives it back', async () => {
  const s = setup()
  const one = s.state.items[0] as Item
  await s.d.ensure('w0:p1')
  expect(s.d.setControl(one, 'owner')).toEqual({ ok: false, status: 409, error: expect.stringContaining('view') })
  // a view whose display does not answer is none
  s.d.websocket.open?.(viewer('w0:p1'))
  await Bun.sleep(30)
  expect(s.d.setControl(one, 'owner').ok).toBe(false)
  expect(s.d.control('w0:p1')).toBe('agent')
  const vnc = await vncServer(s.root)
  try {
    const ws = await vnc.open(s.d, 'w0:p1')
    expect(s.d.setControl(one, 'owner')).toEqual({ ok: true, control: 'owner' })
    // the next board: no view of its own yet, so the agent has it again
    expect(s.make().control('w0:p1')).toBe('agent')
    s.d.websocket.close?.(ws, 1000, '')
  } finally {
    vnc.close()
  }
})

test('the owner has it and no view is connected any more: the next refreshes give it back after 30 s', async () => {
  const s = setup()
  const one = s.state.items[0] as Item
  await s.d.ensure('w0:p1')
  const vnc = await vncServer(s.root)
  try {
    await vnc.open(s.d, 'w0:p1')
    s.d.setControl(one, 'owner')
    // its display connection ends, and no close of the view comes
    for (const c of vnc.conns) c.destroy()
    await Bun.sleep(50)
    s.d.observe(s.state.items)
    s.tick(20_000)
    s.d.observe(s.state.items)
    expect(s.d.control('w0:p1')).toBe('owner')
    s.tick(11_000)
    s.d.observe(s.state.items)
    expect(s.d.control('w0:p1')).toBe('agent')
  } finally {
    vnc.close()
  }
})

test('handed back while its ask stands, by Give back, its view closing or no view a while: the agent is woken by a board reminder, once, and the card asks no more', async () => {
  const { d, cards, reminders, root, state, tick } = setup()
  const one = state.items[0] as Item
  const vnc = await vncServer(root)
  try {
    await d.ask('w0:p1', 'Sign in to GitHub as acme-bot')
    const since = cards.at(-1)?.[1].askSince as number
    expect(d.asks('w0:p1')).toBe(true)
    const ws = await vnc.open(d, 'w0:p1')
    // the card has it as the browser's ask, which keeps what the user writes from answering it
    expect(cards.at(-1)).toEqual([
      's1',
      { ask: 'Sign in to GitHub as acme-bot', askSince: since, askBrowser: since, by: 'agent' },
    ])
    d.setControl(one, 'owner')
    expect(reminders).toEqual([])
    // Give back
    d.setControl(one, 'agent')
    expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '', askBrowser: '' }])
    expect(reminders).toEqual([
      [
        's1',
        'The owner handed your browser back (the ask was: "Sign in to GitHub as acme-bot"). Check the page and go on.',
      ],
    ])
    expect(d.asks('w0:p1')).toBe(false)
    expect(d.view(one)?.ask).toBeUndefined()
    // taken and given back again, with no ask: nothing more
    d.setControl(one, 'owner')
    d.setControl(one, 'agent')
    expect(reminders).toHaveLength(1)
    // its view closing (the panel closed, the tab gone)
    tick(5)
    await d.ask('w0:p1', 'Solve the captcha')
    d.setControl(one, 'owner')
    d.websocket.close?.(ws, 1000, '')
    expect(d.control('w0:p1')).toBe('agent')
    expect(reminders.at(-1)).toEqual(['s1', handedBackText('Solve the captcha')])
    expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '', askBrowser: '' }])
    // no view of it a while (its close never came)
    tick(5)
    await d.ask('w0:p1', 'Pick the account')
    await vnc.open(d, 'w0:p1')
    d.setControl(one, 'owner')
    for (const c of vnc.conns) c.destroy()
    await Bun.sleep(50)
    d.observe(state.items)
    tick(31_000)
    d.observe(state.items)
    expect(d.control('w0:p1')).toBe('agent')
    expect(reminders.map(([, text]) => text)).toEqual([
      handedBackText('Sign in to GitHub as acme-bot'),
      handedBackText('Solve the captcha'),
      handedBackText('Pick the account'),
    ])
  } finally {
    vnc.close()
  }
})

test('handed back with no ask, or once its ask ended another way ("No reply needed", board doing, another ask): nobody is woken', async () => {
  const { d, cards, reminders, root, state, tick } = setup()
  const one = state.items[0] as Item
  const vnc = await vncServer(root)
  try {
    await d.ensure('w0:p1')
    await vnc.open(d, 'w0:p1')
    d.setControl(one, 'owner')
    d.setControl(one, 'agent')
    // its card's ask cleared ("No reply needed", board doing)
    await d.ask('w0:p1', 'Sign in to GitHub')
    cards.push(['s1', { ask: '', askSince: '' }])
    d.observe(state.items)
    d.setControl(one, 'owner')
    d.setControl(one, 'agent')
    // another ask over it (board ask), seen or not yet: that one stays on the card
    tick(5)
    await d.ask('w0:p1', 'Solve the captcha')
    const since = cards.at(-1)?.[1].askSince as number
    d.setControl(one, 'owner')
    const other: CardPatch = { ask: 'Which branch?', askSince: since + 10, by: 'agent' }
    cards.push(['s1', other])
    d.setControl(one, 'agent')
    expect(cards.at(-1)).toEqual(['s1', other])
    expect(reminders).toEqual([])
  } finally {
    vnc.close()
  }
})

test('given back: only the ask the browser ask put on the card is cleared', async () => {
  const { d, cards, root } = setup()
  const vnc = await vncServer(root)
  try {
    await d.ask('w0:p1', 'Sign in to GitHub')
    await vnc.open(d, 'w0:p1')
    // the agent asked something else since (board ask): that one stays
    cards.push(['s1', { ask: 'Which branch?', askSince: 5, by: 'agent' }])
    const other = item('s1', 'w0:p1', { question: 'Which branch?', askSince: 5 })
    expect(d.setControl(other, 'owner').ok).toBe(true)
    const before = cards.length
    d.setControl(other, 'agent')
    expect(cards.length).toBe(before)
    expect(d.view(other)?.asks).toBe(false)
    // the browser's own ask: cleared
    await d.ask('w0:p1', 'Solve the captcha')
    const since = cards.at(-1)?.[1].askSince as number
    const mine = item('s1', 'w0:p1', { question: 'Solve the captcha', askSince: since })
    expect(d.view(mine)?.asks).toBe(true)
    d.setControl(mine, 'owner')
    d.setControl(mine, 'agent')
    expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '', askBrowser: '' }])
  } finally {
    vnc.close()
  }
})

test('a board restarted while a desktop starts knows it: the next one takes it over or stops it', async () => {
  let release = (): void => {}
  const gate = new Promise<void>(done => {
    release = done
  })
  const s = setup({ ready: () => gate })
  const starting = s.d.ensure('w0:p1')
  for (let i = 0; i < 50 && chromeOf(s.server.procs).length === 0; i++) await Bun.sleep(1)
  expect(chromeOf(s.server.procs)).toHaveLength(1)
  // the board ends here (its start never finishes); the next one reads what is on file
  const next = s.make()
  await next.stopAll()
  expect([...s.server.procs.values()].filter(p => p.alive)).toEqual([])
  release()
  await starting
})

test('a new session in the same pane (/clear) does not get the one before’s browser', async () => {
  const { d, server, state } = setup({}, [item('s1', 'w0:p1', { session: 'a' })])
  await d.ensure('w0:p1')
  const first = chromeOf(server.procs)[0]
  // the next refresh has another session there: the desktop stops
  state.items = [item('s1', 'w0:p1', { session: 'b' })]
  d.observe(state.items)
  await Bun.sleep(10)
  expect(first?.alive).toBe(false)
  // the new session's first call before any refresh: a desktop of its own
  await d.ensure('w0:p1')
  const second = chromeOf(server.procs)[0]
  state.items = [item('s1', 'w0:p1', { session: 'c' })]
  await d.ensure('w0:p1')
  expect(second?.alive).toBe(false)
  expect(chromeOf(server.procs)).toHaveLength(1)
})

test('the stop Xvnc’s end queued leaves a desktop started in between alone', async () => {
  const { d, server, state } = setup()
  await d.ensure('w0:p1')
  const xvnc = [...server.procs.values()].find(p => p.argv[0] === '/usr/bin/Xvnc') as Proc
  // the display ends while the agent's next call is on its way: that call starts a new one
  xvnc.end()
  const again = d.ensure('w0:p1')
  expect((await again).ok).toBe(true)
  const started = chromeOf(server.procs)
  expect(started).toHaveLength(1)
  await Bun.sleep(20)
  expect(started[0]?.alive).toBe(true)
  expect(d.view(state.items[0] as Item)?.running).toBe(true)
})

test('a named profile’s copy: made without holding up the board, caches, service workers and locks left out', async () => {
  const { d, server, root } = setup()
  await d.profile('w0:p1', 'github')
  const own = join(root, 'profiles', 'github')
  for (let i = 0; i < 40; i++) writeFileSync(join(own, `f${i}`), 'x'.repeat(1000))
  mkdirSync(join(own, 'Default', 'Service Worker', 'CacheStorage'), { recursive: true })
  writeFileSync(join(own, 'Default', 'Service Worker', 'CacheStorage', 'big'), 'cache')
  mkdirSync(join(own, 'Default', 'IndexedDB'), { recursive: true })
  writeFileSync(join(own, 'Default', 'IndexedDB', 'LOCK'), '')
  writeFileSync(join(own, 'Default', 'IndexedDB', 'db'), 'kept')
  // the board's other work goes on while the copy is made: a turn of the event loop comes before Chrome starts
  let turned = false
  setImmediate(() => {
    turned = true
  })
  const spawnChrome = server.sys.spawnChrome
  let turnedAtChrome: boolean | null = null
  server.sys.spawnChrome = (argv, cdp, env, log) => {
    turnedAtChrome = turned
    return spawnChrome(argv, cdp, env, log)
  }
  expect((await d.profile('w0:p2', 'github')).ok).toBe(true)
  expect(turnedAtChrome as boolean | null).toBe(true)
  const copy = join(root, 'sessions', '101', 'copy-github')
  expect(readFileSync(join(copy, 'f39'), 'utf8')).toHaveLength(1000)
  expect(readFileSync(join(copy, 'Default', 'IndexedDB', 'db'), 'utf8')).toBe('kept')
  expect(existsSync(join(copy, 'Default', 'IndexedDB', 'LOCK'))).toBe(false)
  expect(existsSync(join(copy, 'Default', 'Service Worker'))).toBe(false)
})

test('a display whose X server was killed (its lock and socket left) is free again; a live one or another’s is not', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xtmp-'))
  dirs.push(tmp)
  mkdirSync(join(tmp, '.X11-unix'))
  const leave = (display: number, pid: number) => {
    writeFileSync(join(tmp, `.X${display}-lock`), `${String(pid).padStart(10)}\n`)
    writeFileSync(join(tmp, '.X11-unix', `X${display}`), '')
  }
  leave(100, 4242)
  leave(101, process.pid)
  writeFileSync(join(tmp, '.X11-unix', 'X102'), '')
  const alive = (pid: number) => pid === process.pid
  expect(displayHeldAt(100, tmp, alive)).toBe(false)
  expect(existsSync(join(tmp, '.X100-lock'))).toBe(false)
  expect(existsSync(join(tmp, '.X11-unix', 'X100'))).toBe(false)
  expect(displayHeldAt(101, tmp, alive)).toBe(true)
  expect(existsSync(join(tmp, '.X101-lock'))).toBe(true)
  // a socket with no lock: not known whose, so held
  expect(displayHeldAt(102, tmp, alive)).toBe(true)
  expect(displayHeldAt(103, tmp, alive)).toBe(false)
})

test('a profile switch while the owner has the browser: refused, Chrome left as it is', async () => {
  const { d, state, server, root } = setup()
  await d.ensure('w0:p1')
  const vnc = await vncServer(root)
  try {
    await vnc.open(d, 'w0:p1')
    d.setControl(state.items[0] as Item, 'owner')
    const before = chromeOf(server.procs)
    const r = await d.profile('w0:p1', 'github')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('owner') })
    expect(chromeOf(server.procs)).toEqual(before)
    expect(before[0]?.alive).toBe(true)
  } finally {
    vnc.close()
  }
})

test('Chrome’s DevTools on its pipe, under its holder: a socket in the desktop’s folder, no port', async () => {
  const { d, server, root } = setup()
  expect(d.cdpOf('w0:p1')).toBeNull()
  await d.ensure('w0:p1')
  const chrome = chromeOf(server.procs)[0] as Proc
  expect(chrome.argv).toContain('--remote-debugging-pipe')
  expect(chrome.argv.some(a => a.startsWith('--remote-debugging-port'))).toBe(false)
  const cdp = join(root, 'sessions', '100', 'cdp.sock')
  expect(chrome.cmdline).toContain(cdp)
  expect(d.cdpOf('w0:p1')).toBe(cdp)
  expect(d.cdpOf('w0:p2')).toBeNull()
})

test('taken over: one being started is ended (the next call starts it); a board before the pipe’s Chrome on a port is ended', async () => {
  const s = setup()
  await s.d.ensure('w0:p1')
  const chrome = chromeOf(s.server.procs)[0] as Proc
  // its DevTools socket not there yet, as when the board ended during the start
  rmSync(join(s.root, 'sessions', '100', 'cdp.sock'))
  const next = s.make()
  expect(chrome.alive).toBe(false)
  expect(next.view(s.state.items[0] as Item)?.running).toBe(false)
  expect((await next.ensure('w0:p1')).ok).toBe(true)
  expect(chromeOf(s.server.procs)).toHaveLength(1)
  // a record of the board before the pipe: Chrome with a DevTools port
  const old = s.server.start(['/usr/bin/chrome', '--remote-debugging-port=9301'], {})
  const xvnc = s.server.start(['/usr/bin/Xvnc', ':101'], {}, '/old/vnc.sock')
  const dir = join(s.root, 'sessions', '101')
  mkdirSync(dir, { recursive: true })
  const record = JSON.parse(readFileSync(join(s.root, 'desktops.json'), 'utf8'))
  record.push({ pane: 'w0:p2', dir, vnc: '/old/vnc.sock', port: 9301, xvnc: xvnc.pid, chrome: old.pid })
  writeFileSync(join(s.root, 'desktops.json'), JSON.stringify(record))
  const after = s.make()
  expect([old.p.alive, xvnc.p.alive]).toEqual([false, false])
  expect(existsSync(dir)).toBe(false)
  expect(after.view(s.state.items[1] as Item)).toBeUndefined()
})

test('the agent’s DevTools through the board: each message a text frame one way, NUL-ended the other', async () => {
  const { d, root } = setup()
  const { createServer } = await import('node:net')
  const path =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\cdp-` + Math.random().toString(36).slice(2)
      : join(root, 'c.sock')
  const got: string[] = []
  const holder = createServer(c => {
    c.on('data', (b: Buffer) => got.push(b.toString('utf8')))
    c.write('{"id":1,"result":{}}\0{"method":"Target.targetCreated",')
    c.write('"params":{}}\0')
  })
  await new Promise<void>(done => holder.listen(path, done))
  try {
    const sent: string[] = []
    const ws = {
      data: { pane: 'w0:p1', socket: path, cdp: true },
      send: (m: string) => sent.push(m),
      close: () => {},
      getBufferedAmount: () => 0,
    } as unknown as ServerWebSocket<VncData>
    d.websocket.open?.(ws)
    for (let i = 0; i < 100 && sent.length < 2; i++) await Bun.sleep(5)
    expect(sent).toEqual(['{"id":1,"result":{}}', '{"method":"Target.targetCreated","params":{}}'])
    d.websocket.message?.(ws, '{"id":2,"method":"Browser.getVersion"}')
    for (let i = 0; i < 100 && !got.length; i++) await Bun.sleep(5)
    expect(got.join('')).toBe('{"id":2,"method":"Browser.getVersion"}\0')
    d.websocket.close?.(ws, 1000, '')
    // the page's end of it slow (a big screenshot on its way): messages wait in order, none dropped
    let buffered = 5 << 20
    const slow: string[] = []
    const late = {
      data: { pane: 'w0:p1', socket: path, cdp: true },
      send: (m: string) => slow.push(m),
      close: () => {},
      getBufferedAmount: () => buffered,
    } as unknown as ServerWebSocket<VncData>
    d.websocket.open?.(late)
    await Bun.sleep(50)
    expect(slow).toEqual([])
    buffered = 0
    d.websocket.drain?.(late)
    for (let i = 0; i < 100 && slow.length < 2; i++) await Bun.sleep(5)
    expect(slow).toEqual(['{"id":1,"result":{}}', '{"method":"Target.targetCreated","params":{}}'])
    d.websocket.close?.(late, 1000, '')
  } finally {
    holder.close()
  }
})

/** The desktops' video of the test's own: who joined (and what to grab), left, said what; what stopped. */
function fakeVideo(available = true) {
  const v = {
    available,
    joins: [] as { src: VideoSource; viewer: VideoViewer }[],
    leaves: [] as string[],
    said: [] as [string, string][],
    stops: [] as string[],
  }
  const video: DesktopVideo = {
    available: () => v.available,
    join: (src, viewer) => v.joins.push({ src, viewer }),
    leave: pane => v.leaves.push(pane),
    message: (pane, _viewer, text) => v.said.push([pane, text]),
    stop: pane => v.stops.push(pane),
    stopAll: () => {},
    running: () => 0,
  }
  return { v, video }
}

test('the view’s video: its own WebSocket joined to the desktop’s display (its number, its X cookie, its log), its answers passed on, left as it closes or the login ends; the desktop stopped stops it', async () => {
  const { v, video } = fakeVideo()
  const { d, state, root } = setup({}, undefined, { video })
  const s1 = state.items[0] as Item
  expect(d.videoOf(s1)).toBeNull()
  await d.ensure('w0:p1')
  expect(d.videoOf(s1)).toEqual({ pane: 'w0:p1' })
  expect(d.videoOf({ ...s1, sleeping: true })).toBeNull()
  let gone = () => {}
  let unwatched = 0
  const sent: Uint8Array[] = []
  const ws = Object.assign(viewer('w0:p1'), {
    send: (b: Uint8Array) => sent.push(b),
  })
  ws.data = {
    pane: 'w0:p1',
    socket: '',
    video: true,
    watch: g => {
      gone = g
      return () => unwatched++
    },
  }
  d.websocket.open?.(ws)
  expect(v.joins).toHaveLength(1)
  const dir = join(root, 'sessions', '100')
  expect(v.joins[0]?.src).toEqual({
    pane: 'w0:p1',
    display: 100,
    auth: join(dir, 'Xauthority'),
    log: join(dir, 'video.log'),
  })
  // the video's frames go to its socket
  v.joins[0]?.viewer.send(Uint8Array.of(1, 0, 0, 0, 1, 9))
  expect(sent.map(b => [...b])).toEqual([[1, 0, 0, 0, 1, 9]])
  // its texts to the video; bytes are nothing
  d.websocket.message?.(ws, 'a1')
  d.websocket.message?.(ws, Buffer.from([1, 2, 3]))
  expect(v.said).toEqual([['w0:p1', 'a1']])
  // control goes with a view's VNC, not its video
  expect(d.setControl(s1, 'owner')).toMatchObject({ ok: false, status: 409 })
  // the login ended: closed; then its close leaves the video
  gone()
  expect(ws.closed).toBe(4001)
  d.websocket.close?.(ws, 4001, 'login')
  expect(v.leaves).toEqual(['w0:p1'])
  expect(unwatched).toBe(1)
  // closed twice (Bun says it once, but): left once
  d.websocket.close?.(ws, 1000, '')
  expect(v.leaves).toEqual(['w0:p1'])
  await d.stop('w0:p1', 'test')
  expect(v.stops).toEqual(['w0:p1'])
})

test('no ffmpeg on the server: the route is told (`none`) and a video socket that opens anyway is closed; the VNC view as it was', async () => {
  const { v, video } = fakeVideo(false)
  const { d, state, root } = setup({}, undefined, { video })
  await d.ensure('w0:p1')
  expect(d.videoOf(state.items[0] as Item)).toBe('none')
  const ws = viewer('w0:p1')
  ws.data = { pane: 'w0:p1', socket: '', video: true }
  d.websocket.open?.(ws)
  expect(ws.closed).toBe(VIDEO_NONE)
  expect(v.joins).toEqual([])
  // the VNC view: connected, control with it, as before
  const vnc = await vncServer(root)
  try {
    await vnc.open(d, 'w0:p1')
    expect(d.setControl(state.items[0] as Item, 'owner')).toEqual({ ok: true, control: 'owner' })
  } finally {
    vnc.close()
  }
})

// ------------------------------------------------ run only while needed: browser_close, idle, kept profile

const MIN = 60_000
/** A Chrome's profile folder (its --user-data-dir). */
const userDataDir = (p: Proc | undefined): string =>
  (p?.argv.find(a => a.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length)
/** The displays whose Xvnc runs. */
const displaysOf = (procs: Map<number, Proc>) =>
  [...procs.values()].filter(p => p.alive && p.argv[0] === '/usr/bin/Xvnc').map(p => p.argv[1])

test('browser_close: Chrome asked to quit first (its tabs and cookies saved), then it and its display end as one; the card has no browser; the session’s own profile kept, and the next call starts it again by itself with its last tabs', async () => {
  const logs: string[] = []
  const { d, server, state, root } = setup({}, undefined, { log: line => logs.push(line) })
  const one = state.items[0] as Item
  await d.ensure('w0:p1')
  await d.ensure('w0:p2')
  const own = join(root, 'sessions', '100', 'profile')
  mkdirSync(join(own, 'Default'), { recursive: true })
  writeFileSync(join(own, 'Default', 'Cookies'), 'signed in')
  const chrome = chromeOf(server.procs)[0] as Proc
  const pid = [...server.procs.entries()].find(([, p]) => p === chrome)?.[0] as number
  expect(await d.close('w0:p1')).toEqual({ ok: true, closed: true })
  expect(server.quits).toEqual([join(root, 'sessions', '100', 'cdp.sock')])
  // ended by its own quit, not a signal; its display with it; the other session's browser runs on
  expect(chrome.alive).toBe(false)
  expect(server.killed).not.toContain(pid)
  expect(displaysOf(server.procs)).toEqual([':101'])
  expect(chromeOf(server.procs).map(p => p.env.DISPLAY)).toEqual([':101'])
  // shown as a session with no browser: nothing to view, no control, no DevTools
  expect(d.view(one)).toBeUndefined()
  expect(d.card(one)).toEqual({})
  expect(d.vncOf(one)).toBeNull()
  expect(d.videoOf(one)).toBeNull()
  expect(d.cdpOf('w0:p1')).toBeNull()
  expect(d.setControl(one, 'owner')).toEqual({ ok: false, status: 404, error: 'no desktop' })
  expect(existsSync(join(root, 'sessions', '100'))).toBe(false)
  expect(logs.filter(l => l.includes('stopped'))).toEqual([
    expect.stringMatching(/^desktop :100 for s1 stopped: .*closed/),
  ])
  // the next call: up again by itself, the same profile, its last tabs (no blank one beside them)
  expect(await d.ensure('w0:p1')).toEqual({ ok: true })
  const again = chromeOf(server.procs).find(p => p.env.DISPLAY !== ':101')
  expect(again?.argv).toContain('--restore-last-session')
  expect(again?.argv).not.toContain('about:blank')
  expect(readFileSync(join(userDataDir(again), 'Default', 'Cookies'), 'utf8')).toBe('signed in')
  expect(d.view(one)).toEqual({ running: true, profile: null, control: 'agent', asks: false })
  // a first start as before: a blank tab, nothing restored
  const other = chromeOf(server.procs).find(p => p.env.DISPLAY === ':101')
  expect(other?.argv.at(-1)).toBe('about:blank')
  expect(other?.argv).not.toContain('--restore-last-session')
  // Chrome ending on its own later is started again as before: nothing restored then
  again?.end()
  await Bun.sleep(10)
  await d.ensure('w0:p1')
  const third = chromeOf(server.procs).find(p => p.env.DISPLAY !== ':101')
  expect(third?.argv.at(-1)).toBe('about:blank')
})

test('browser_close: not while the owner has the browser or the agent’s ask to them stands; nothing running, nothing to do', async () => {
  const { d, state, root, server } = setup()
  const one = state.items[0] as Item
  expect(await d.close('w0:p1')).toEqual({ ok: true, closed: false })
  expect(server.procs.size).toBe(0)
  await d.ensure('w0:p1')
  const vnc = await vncServer(root)
  try {
    const ws = await vnc.open(d, 'w0:p1')
    d.setControl(one, 'owner')
    expect(await d.close('w0:p1')).toEqual({ ok: false, error: expect.stringContaining('owner has') })
    expect(d.view(one)?.running).toBe(true)
    d.setControl(one, 'agent')
    await d.ask('w0:p1', 'Sign in to GitHub')
    expect(await d.close('w0:p1')).toEqual({ ok: false, error: expect.stringContaining('ask') })
    expect(d.view(one)?.running).toBe(true)
    expect(server.quits).toEqual([])
    d.websocket.close?.(ws, 1000, '')
  } finally {
    vnc.close()
  }
})

test('idle for 15 minutes (no call of the agent’s, no view of it, VNC or video, the owner not holding it, no ask standing): stopped as browser_close stops it, said in the log; each of those keeps it', async () => {
  const logs: string[] = []
  const { v, video } = fakeVideo()
  const s = setup({}, undefined, { log: line => logs.push(line), video })
  const one = s.state.items[0] as Item
  const running = async () => {
    s.d.observe(s.state.items)
    await Bun.sleep(10)
    return s.d.view(one)?.running === true
  }
  await s.d.ensure('w0:p1')
  s.tick(14 * MIN)
  expect(await running()).toBe(true)
  // a call (the wrapper asks who has the browser before each): the clock starts again
  s.d.control('w0:p1')
  s.tick(14 * MIN)
  expect(await running()).toBe(true)
  // a view open: kept however long, and the owner holding it too
  const vnc = await vncServer(s.root)
  try {
    const ws = await vnc.open(s.d, 'w0:p1')
    s.tick(30 * MIN)
    expect(await running()).toBe(true)
    s.d.setControl(one, 'owner')
    s.tick(30 * MIN)
    expect(await running()).toBe(true)
    s.d.setControl(one, 'agent')
    s.d.websocket.close?.(ws, 1000, '')
  } finally {
    vnc.close()
  }
  // the view gone: the clock from then
  s.tick(14 * MIN)
  expect(await running()).toBe(true)
  // its video watched: kept
  const vws = viewer('w0:p1')
  vws.data = { pane: 'w0:p1', socket: '', video: true }
  s.d.websocket.open?.(vws)
  expect(v.joins).toHaveLength(1)
  s.tick(30 * MIN)
  expect(await running()).toBe(true)
  s.d.websocket.close?.(vws, 1000, '')
  // its ask to the owner standing: kept; the ask over (its card asks no more), the clock from then
  await s.d.ask('w0:p1', 'Sign in to GitHub')
  s.tick(30 * MIN)
  expect(await running()).toBe(true)
  s.cards.push(['s1', { ask: '', askSince: '' }])
  expect(await running()).toBe(true)
  s.tick(14 * MIN)
  expect(await running()).toBe(true)
  expect(s.server.quits).toEqual([])
  s.tick(MIN)
  expect(await running()).toBe(false)
  expect(s.server.quits).toHaveLength(1)
  expect(displaysOf(s.server.procs)).toEqual([])
  expect(logs.filter(l => l.includes('stopped'))).toEqual([
    expect.stringMatching(/^desktop :100 for s1 stopped: no browser call for 15 min/),
  ])
  // and the next call has it again, with its tabs
  expect(await s.d.ensure('w0:p1')).toEqual({ ok: true })
  expect(chromeOf(s.server.procs)[0]?.argv).toContain('--restore-last-session')
})

test('idle: a call that comes while the stop waits its turn keeps the browser', async () => {
  let release = (): void => {}
  const gate = new Promise<void>(done => {
    release = done
  })
  const s = setup({ ready: () => gate })
  // a start under way past 15 minutes: the stop waits behind it, then finds the call was just now
  const starting = s.d.ensure('w0:p1')
  for (let i = 0; i < 50 && chromeOf(s.server.procs).length === 0; i++) await Bun.sleep(1)
  s.tick(16 * MIN)
  s.d.observe(s.state.items)
  release()
  expect((await starting).ok).toBe(true)
  await Bun.sleep(10)
  expect(s.d.view(s.state.items[0] as Item)?.running).toBe(true)
  expect(s.server.quits).toEqual([])
})

test('a named profile, or its copy, through a stop: the named one where it is, and its tabs; the copy reopened as it was, not copied again', async () => {
  const { d, server, root } = setup()
  const named = join(root, 'profiles', 'github')
  await d.profile('w0:p1', 'github')
  expect(await d.profile('w0:p2', 'github')).toEqual({ ok: true, copy: true })
  const copy = join(root, 'sessions', '101', 'copy-github')
  writeFileSync(join(copy, 'Cookies'), 'signed in to the copy')
  expect(await d.close('w0:p2')).toEqual({ ok: true, closed: true })
  expect(existsSync(join(root, 'sessions', '101'))).toBe(false)
  // started again while the first session still has the profile: its own copy, as it was
  await d.ensure('w0:p2')
  const c2 = chromeOf(server.procs).find(p => p.env.DISPLAY === ':101')
  expect(userDataDir(c2)).toMatch(/copy-github$/)
  expect(readFileSync(join(userDataDir(c2), 'Cookies'), 'utf8')).toBe('signed in to the copy')
  expect(c2?.argv).toContain('--restore-last-session')
  expect(d.view(item('s2', 'w0:p2'))?.profile).toBe('github')
  // the named one: kept where it is (it always is), and started again with its tabs
  writeFileSync(join(named, 'Cookies'), 'signed in')
  await d.close('w0:p1')
  expect(readFileSync(join(named, 'Cookies'), 'utf8')).toBe('signed in')
  await d.ensure('w0:p1')
  const c1 = chromeOf(server.procs).find(p => p.env.DISPLAY === ':100')
  expect(userDataDir(c1)).toBe(named)
  expect(c1?.argv).toContain('--restore-last-session')
  expect(d.view(item('s1', 'w0:p1'))?.profile).toBe('github')
})

test('a stopped browser whose named profile another session opened meanwhile: a fresh copy, nothing of the other’s restored', async () => {
  const { d, server, root } = setup({}, [item('s1', 'w0:p1'), item('s2', 'w0:p2'), item('s3', 'w0:p3')])
  await d.profile('w0:p1', 'github')
  await d.close('w0:p1')
  // the profile is free: another session has it now
  expect(await d.profile('w0:p2', 'github')).toEqual({ ok: true, copy: false })
  await d.ensure('w0:p1')
  // the latest Chrome: the first session's, started again (on the display the other did not take)
  const c1 = chromeOf(server.procs).at(-1)
  expect(userDataDir(c1)).toBe(join(root, 'sessions', '101', 'copy-github'))
  expect(c1?.argv).not.toContain('--restore-last-session')
  expect(c1?.argv.at(-1)).toBe('about:blank')
})

test('a profile switch while stopped: the new profile, its pages not restored; the session’s own kept still', async () => {
  const { d, server, root } = setup()
  await d.ensure('w0:p1')
  mkdirSync(join(root, 'sessions', '100', 'profile'), { recursive: true })
  writeFileSync(join(root, 'sessions', '100', 'profile', 'Cookies'), 'own')
  await d.close('w0:p1')
  expect(await d.profile('w0:p1', 'client-x')).toEqual({ ok: true, copy: false })
  const c = chromeOf(server.procs)[0]
  expect(userDataDir(c)).toBe(join(root, 'profiles', 'client-x'))
  expect(c?.argv).not.toContain('--restore-last-session')
  // back to its own: what it had
  await d.profile('w0:p1', null)
  expect(readFileSync(join(userDataDir(chromeOf(server.procs)[0]), 'Cookies'), 'utf8')).toBe('own')
})

test('the kept profile goes when the session does, as a running browser’s does: asleep or gone 2 minutes on end, or another session in its pane; a named one stays', async () => {
  const logs: string[] = []
  const { d, state, root, tick, server } = setup({}, undefined, { log: line => logs.push(line) })
  await d.ensure('w0:p1')
  await d.profile('w0:p2', 'github')
  await d.close('w0:p1')
  await d.close('w0:p2')
  const kept = () => readdirSync(join(root, 'kept'))
  expect(kept()).toHaveLength(2)
  // asleep a while (a restart), then back: kept
  state.items = [item('s1', 'w0:p1', { sleeping: true }), item('s2', 'w0:p2')]
  d.observe(state.items)
  tick(90_000)
  d.observe(state.items)
  d.observe([item('s1', 'w0:p1'), item('s2', 'w0:p2')])
  tick(60_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect(kept()).toHaveLength(2)
  // asleep 2 minutes on end: gone, as a running one's own profile goes
  tick(120_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect(kept()).toHaveLength(1)
  expect(logs.at(-1)).toMatch(/s1.*the session sleeps/)
  // another session in the second one's pane (/clear): gone at once; the named profile stays
  state.items = [item('s2', 'w0:p2', { session: 'other' })]
  d.observe(state.items)
  await Bun.sleep(10)
  expect(kept()).toEqual([])
  expect(existsSync(join(root, 'profiles', 'github'))).toBe(true)
  // the new session's first call: a browser of its own, fresh
  await d.ensure('w0:p2')
  const c = chromeOf(server.procs)[0]
  expect(userDataDir(c)).toMatch(/sessions[\\/]10\d[\\/]profile$/)
  expect(c?.argv.at(-1)).toBe('about:blank')
})

test('a new session’s first call in the pane, before a refresh saw it: the one before’s kept profile is not its own', async () => {
  const { d, server, state, root } = setup({}, [item('s1', 'w0:p1', { session: 'a' })])
  await d.ensure('w0:p1')
  mkdirSync(join(root, 'sessions', '100', 'profile'), { recursive: true })
  writeFileSync(join(root, 'sessions', '100', 'profile', 'Cookies'), 'a’s')
  await d.close('w0:p1')
  state.items = [item('s1', 'w0:p1', { session: 'b' })]
  await d.ensure('w0:p1')
  const c = chromeOf(server.procs)[0]
  expect(c?.argv).not.toContain('--restore-last-session')
  expect(existsSync(join(userDataDir(c), 'Cookies'))).toBe(false)
  expect(readdirSync(join(root, 'kept'))).toEqual([])
})

test('the next board knows a stopped browser’s kept profile: started again with it, or removed once the session ends; a kept folder no record has is cleared', async () => {
  const s = setup()
  await s.d.ensure('w0:p1')
  mkdirSync(join(s.root, 'sessions', '100', 'profile'), { recursive: true })
  writeFileSync(join(s.root, 'sessions', '100', 'profile', 'Cookies'), 'signed in')
  await s.d.close('w0:p1')
  // left by a board that ended between its move and its record
  mkdirSync(join(s.root, 'kept', 'stray'), { recursive: true })
  const next = s.make()
  expect(existsSync(join(s.root, 'kept', 'stray'))).toBe(false)
  expect(next.view(s.state.items[0] as Item)).toBeUndefined()
  await next.ensure('w0:p1')
  const c = chromeOf(s.server.procs)[0]
  expect(c?.argv).toContain('--restore-last-session')
  expect(readFileSync(join(userDataDir(c), 'Cookies'), 'utf8')).toBe('signed in')
  // stopped again, and its session ends while a third board runs
  await next.close('w0:p1')
  const third = s.make()
  third.observe([])
  s.tick(120_000)
  third.observe([])
  await Bun.sleep(10)
  expect(readdirSync(join(s.root, 'kept'))).toEqual([])
})

test('a start again that fails keeps the profile for the next try', async () => {
  const o: Parameters<typeof fakeServer>[0] = {}
  const { d, server, root } = setup(o)
  await d.ensure('w0:p1')
  mkdirSync(join(root, 'sessions', '100', 'profile'), { recursive: true })
  writeFileSync(join(root, 'sessions', '100', 'profile', 'Cookies'), 'signed in')
  await d.close('w0:p1')
  o.chromeFails = true
  expect((await d.ensure('w0:p1')).ok).toBe(false)
  o.chromeFails = false
  expect(await d.ensure('w0:p1')).toEqual({ ok: true })
  const c = chromeOf(server.procs)[0]
  expect(c?.argv).toContain('--restore-last-session')
  expect(readFileSync(join(userDataDir(c), 'Cookies'), 'utf8')).toBe('signed in')
})

test('while it stops, the card has no browser already and its views close; a call meanwhile waits and starts it again', async () => {
  let release = (): void => {}
  const gate = new Promise<void>(done => {
    release = done
  })
  const s = setup({ quitting: () => gate })
  const one = s.state.items[0] as Item
  await s.d.ensure('w0:p1')
  const vnc = await vncServer(s.root)
  try {
    const ws = await vnc.open(s.d, 'w0:p1')
    const changes = s.state.changes
    const closing = s.d.close('w0:p1')
    for (let i = 0; i < 50 && !s.server.quits.length; i++) await Bun.sleep(1)
    // Chrome still quitting: the card says no browser, and the board was told
    expect(s.d.view(one)).toBeUndefined()
    expect(s.d.vncOf(one)).toBeNull()
    expect(s.state.changes).toBeGreaterThan(changes)
    const call = s.d.ensure('w0:p1')
    release()
    expect(await closing).toEqual({ ok: true, closed: true })
    expect(ws.closed).toBe(1001)
    expect(await call).toEqual({ ok: true })
    expect(s.d.view(one)?.running).toBe(true)
  } finally {
    vnc.close()
  }
})

test('as before for a browser that is not stopped: a session that ends takes its own profile with it, and nothing is kept', async () => {
  const { d, root, state, tick } = setup()
  await d.ensure('w0:p1')
  state.items = []
  d.observe(state.items)
  tick(120_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect(existsSync(join(root, 'sessions', '100'))).toBe(false)
  expect(existsSync(join(root, 'kept'))).toBe(false)
})

test('every stop quits Chrome as a person quits it first (its last tabs and cookies saved), a signal only for what is left: the session ending, a profile switch, the board stopping them', async () => {
  const { d, root, state, tick, server } = setup({}, [item('s1', 'w0:p1'), item('s2', 'w0:p2'), item('s3', 'w0:p3')])
  const cdp = (display: number) => join(root, 'sessions', String(display), 'cdp.sock')
  const pidOf = (p: Proc | undefined) => [...server.procs.entries()].find(([, x]) => x === p)?.[0]
  await d.ensure('w0:p1')
  await d.ensure('w0:p2')
  await d.ensure('w0:p3')
  const [c1, c2, c3] = chromeOf(server.procs)
  // a profile switch: the Chrome before quits, the new one starts on the same display
  await d.profile('w0:p2', 'github')
  expect(server.quits).toEqual([cdp(101)])
  expect(c2?.alive).toBe(false)
  // the session ends
  state.items = [item('s2', 'w0:p2'), item('s3', 'w0:p3')]
  d.observe(state.items)
  tick(120_000)
  d.observe(state.items)
  await Bun.sleep(10)
  expect(server.quits).toEqual([cdp(101), cdp(100)])
  expect(c1?.alive).toBe(false)
  // the board stops them
  await d.stopAll()
  expect(server.quits.slice(2).sort()).toEqual([cdp(101), cdp(102)])
  expect(c3?.alive).toBe(false)
  // each Chrome ended by its own quit, not a signal
  for (const c of [c1, c2, c3]) expect(server.killed).not.toContain(pidOf(c))
  expect([...server.procs.values()].some(p => p.alive)).toBe(false)
})

test('a Chrome that does not quit when asked is ended by a signal, as before', async () => {
  const { d, server } = setup({ quitIgnored: true })
  await d.ensure('w0:p1')
  const chrome = chromeOf(server.procs)[0]
  const pid = [...server.procs.entries()].find(([, x]) => x === chrome)?.[0] as number
  await d.stop('w0:p1', 'test')
  expect(chrome?.alive).toBe(false)
  expect(server.killed).toContain(pid)
})

test('the owner’s languages, when the board has them: each Chrome started with them, as the board’s setting is at its start; none, as before', async () => {
  let languages: string[] | null = ['ru', 'en']
  const { d, server } = setup({}, undefined, { languages: () => languages })
  await d.ensure('w0:p1')
  expect(chromeOf(server.procs)[0]?.argv).toContain('--accept-lang=ru,en')
  languages = null
  await d.ensure('w0:p2')
  expect(chromeOf(server.procs)[1]?.argv.some(a => a.startsWith('--accept-lang'))).toBe(false)
  // without the option at all: none
  const plain = setup()
  await plain.d.ensure('w0:p1')
  expect(chromeOf(plain.server.procs)[0]?.argv.some(a => a.startsWith('--accept-lang'))).toBe(false)
})

test('the board stopping them all (server mode off): a stopped browser’s kept profile goes too, as a running one’s own does; named profiles stay', async () => {
  const { d, root } = setup()
  await d.ensure('w0:p1')
  await d.profile('w0:p2', 'github')
  await d.close('w0:p1')
  expect(readdirSync(join(root, 'kept'))).toHaveLength(1)
  await d.stopAll()
  expect(readdirSync(join(root, 'kept'))).toEqual([])
  expect(existsSync(join(root, 'sessions', '101'))).toBe(false)
  expect(existsSync(join(root, 'profiles', 'github'))).toBe(true)
  expect(JSON.parse(readFileSync(join(root, 'kept.json'), 'utf8'))).toEqual([])
})

test('board browser open: the address handed to the running Chrome on its own profile (a Chrome run with that profile and the address, on its display), the browser started first when it is not up', async () => {
  const { d, server, root } = setup()
  const url = 'https://system.netsuite.com/app/login/oauth2/authorize.nl?scope=restlets&state=s'
  expect(await d.open('w0:p1', url)).toEqual({ ok: true })
  // started for it: one display, one Chrome, nothing else left running
  expect(chromeOf(server.procs)).toHaveLength(1)
  expect(server.relays).toEqual([
    {
      argv: ['/usr/bin/chrome', `--user-data-dir=${join(root, 'sessions', '100', 'profile')}`, url],
      env: expect.objectContaining({ DISPLAY: ':100', XAUTHORITY: join(root, 'sessions', '100', 'Xauthority') }),
      ms: 10_000,
    },
  ])
  // up already: handed on, nothing started
  expect(await d.open('w0:p1', 'https://example.com/')).toEqual({ ok: true })
  expect(chromeOf(server.procs)).toHaveLength(1)
  expect(server.relays.map(r => r.argv[2])).toEqual([url, 'https://example.com/'])
})

test('board browser open: on the profile the browser has: a named one where it is, its copy for a second session', async () => {
  const { d, server, root } = setup()
  await d.profile('w0:p1', 'netsuite')
  await d.profile('w0:p2', 'netsuite')
  await d.open('w0:p1', 'https://a.example/')
  await d.open('w0:p2', 'https://b.example/')
  expect(server.relays.map(r => [r.argv[1], r.env.DISPLAY])).toEqual([
    [`--user-data-dir=${join(root, 'profiles', 'netsuite')}`, ':100'],
    [`--user-data-dir=${join(root, 'sessions', '101', 'copy-netsuite')}`, ':101'],
  ])
})

test('board browser open: not for a session not on the board, nor while the owner has the browser (nothing started or opened); a Chrome that does not take it, or a server with no way to, said', async () => {
  const { d, server, state, root } = setup()
  expect(await d.open('w0:p9', 'https://example.com/')).toEqual({
    ok: false,
    error: 'this session is not on the board',
  })
  expect(server.procs.size).toBe(0)
  await d.ensure('w0:p1')
  const vnc = await vncServer(root)
  try {
    await vnc.open(d, 'w0:p1')
    d.setControl(state.items[0] as Item, 'owner')
    expect(await d.open('w0:p1', 'https://example.com/')).toEqual({
      ok: false,
      error: expect.stringContaining('the owner has your browser'),
    })
    expect(server.relays).toEqual([])
  } finally {
    vnc.close()
  }
  const fails = setup({ relayFails: true })
  expect(await fails.d.open('w0:p1', 'https://example.com/')).toEqual({
    ok: false,
    error: 'the browser did not take the address',
  })
  const none = setup({ noRelay: true })
  expect((await none.d.open('w0:p1', 'https://example.com/')).ok).toBe(false)
})

test('board browser run: the session’s display and its X cookie file, the browser started when it is not up; not for a session not on the board', async () => {
  const { d, server, root } = setup()
  expect(await d.display('w0:p9')).toEqual({ ok: false, error: 'this session is not on the board' })
  expect(server.procs.size).toBe(0)
  expect(await d.display('w0:p2')).toEqual({
    ok: true,
    display: 100,
    xauthority: join(root, 'sessions', '100', 'Xauthority'),
  })
  expect(await d.display('w0:p2')).toEqual({
    ok: true,
    display: 100,
    xauthority: join(root, 'sessions', '100', 'Xauthority'),
  })
  expect(chromeOf(server.procs)).toHaveLength(1)
  const none = setup({ noChrome: true })
  expect((await none.d.display('w0:p1')).ok).toBe(false)
})
