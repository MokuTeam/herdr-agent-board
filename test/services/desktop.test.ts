// The desktops in the board's process (services/desktop.ts), with a server of the test's own (its
// programs fake): started on demand, a slot each, stopped when the session sleeps or ends, a named
// profile's copy for a second session, control and asks, taken over by the next board, and the
// owner's last view closing hands the browser back.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { CardPatch } from '../../src/adapters/cards.ts'
import type { Card, Item } from '../../src/core/types.ts'
import { createDesktops, type DesktopSystem, displayHeldAt, type VncData } from '../../src/services/desktop.ts'

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
  o: { held?: number[]; noChrome?: boolean; chromeFails?: boolean; ready?: () => Promise<void>; arch?: string } = {},
) {
  const procs = new Map<number, Proc>()
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
      const { pid, exited } = start(argv, env)
      if (argv[0] === '/usr/bin/Xvnc') writeFileSync(argv[argv.indexOf('-rfbunixpath') + 1] as string, '')
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
      if (p?.alive) p.end()
    },
    alive: pid => !!procs.get(pid)?.alive,
    cmdline: pid => procs.get(pid)?.cmdline ?? '',
    displayHeld: d => (o.held ?? []).includes(d) || [...procs.values()].some(p => p.alive && p.argv[1] === `:${d}`),
    cdpReady: async cdp => {
      await o.ready?.()
      await Bun.sleep(0)
      return existsSync(cdp)
    },
    which: name =>
      name === 'Xvnc' ? '/usr/bin/Xvnc' : name === 'google-chrome-stable' && !o.noChrome ? '/usr/bin/chrome' : null,
    sleep: async () => {},
  }
  return { sys, procs, start }
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

function setup(o: Parameters<typeof fakeServer>[0] = {}, items: Item[] = [item('s1', 'w0:p1'), item('s2', 'w0:p2')]) {
  const root = mkdtempSync(join(tmpdir(), 'desktops-'))
  dirs.push(root)
  const server = fakeServer(o)
  const cards: [string, CardPatch][] = []
  let clock = 1_000_000
  const state = { items, changes: 0 }
  const make = () =>
    createDesktops({
      root,
      items: () => state.items,
      writeCard: (key, patch) => cards.push([key, patch]),
      readCard: key => cardOf(cards, key),
      onChange: () => state.changes++,
      log: () => {},
      system: server.sys,
      ...(o.arch && { arch: o.arch }),
      now: () => clock,
    })
  return { root, server, cards, state, make, d: make(), tick: (ms: number) => (clock += ms) }
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
  expect(cards).toEqual([['s1', { ask: 'Sign in to GitHub', askSince: expect.any(Number), by: 'agent' }]])
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
  expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '' }])
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
  // the user answered (its card's ask cleared): over
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
    expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '' }])
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
    expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '' }])
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
