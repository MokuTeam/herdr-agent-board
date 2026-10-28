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
import type { Item } from '../../src/core/types.ts'
import { createDesktops, type DesktopSystem, type VncData } from '../../src/services/desktop.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Proc {
  argv: string[]
  env: Record<string, string>
  alive: boolean
  end: () => void
}

/** A server whose Xvnc makes its socket and Chrome answers on its port at once; what ran, and what it was told. */
function fakeServer(o: { held?: number[]; noChrome?: boolean; chromeFails?: boolean } = {}) {
  const procs = new Map<number, Proc>()
  let next = 1000
  const ports = new Set<number>()
  const sys: DesktopSystem = {
    spawn(argv, env) {
      const pid = next++
      let end = (): void => {}
      const exited = new Promise<unknown>(resolve => {
        end = () => resolve(0)
      })
      const p: Proc = {
        argv,
        env,
        alive: true,
        end: () => {
          p.alive = false
          end()
        },
      }
      procs.set(pid, p)
      if (argv[0] === '/usr/bin/Xvnc') writeFileSync(argv[argv.indexOf('-rfbunixpath') + 1] as string, '')
      else {
        const port = Number(argv.find(a => a.startsWith('--remote-debugging-port='))?.split('=')[1])
        if (o.chromeFails) p.end()
        else ports.add(port)
      }
      return { pid, exited }
    },
    kill(pid) {
      const p = procs.get(pid)
      if (!p?.alive) return
      p.end()
      const port = Number(p.argv.find(a => a.startsWith('--remote-debugging-port='))?.split('=')[1])
      ports.delete(port)
    },
    alive: pid => !!procs.get(pid)?.alive,
    cmdline: pid => procs.get(pid)?.argv.join(' ') ?? '',
    displayHeld: d => (o.held ?? []).includes(d) || [...procs.values()].some(p => p.alive && p.argv[1] === `:${d}`),
    portFree: async () => true,
    devtools: async port => ports.has(port),
    which: name =>
      name === 'Xvnc' ? '/usr/bin/Xvnc' : name === 'google-chrome-stable' && !o.noChrome ? '/usr/bin/chrome' : null,
    sleep: async () => {},
  }
  return { sys, procs }
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
      onChange: () => state.changes++,
      log: () => {},
      system: server.sys,
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
  expect([a, b]).toEqual([
    { ok: true, port: 9300 },
    { ok: true, port: 9301 },
  ])
  // the same session again: what runs, nothing new
  expect(await d.ensure('w0:p1')).toEqual({ ok: true, port: 9300 })
  const xvncs = [...server.procs.values()].filter(p => p.argv[0] === '/usr/bin/Xvnc')
  expect(xvncs.map(p => p.argv[1])).toEqual([':100', ':101'])
  const chromes = chromeOf(server.procs)
  expect(chromes.map(p => p.env.DISPLAY)).toEqual([':100', ':101'])
  expect(chromes[0]?.env.XAUTHORITY).toMatch(/sessions[\\/]100[\\/]Xauthority$/)
  expect(d.view(state.items[0] as Item)).toEqual({ running: true, profile: null, control: 'agent', asks: false })
})

test('two sessions starting at once never share a slot', async () => {
  const { d } = setup()
  const [a, b] = await Promise.all([d.ensure('w0:p1'), d.ensure('w0:p2')])
  expect([a, b]).toEqual([
    { ok: true, port: 9300 },
    { ok: true, port: 9301 },
  ])
})

test('a display someone else holds is skipped', async () => {
  const { d, server } = setup({ held: [100] })
  expect(await d.ensure('w0:p1')).toEqual({ ok: true, port: 9301 })
  expect([...server.procs.values()][0]?.argv[1]).toBe(':101')
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

test('stopped when the session sleeps or ends (after a grace, two refreshes in a row); others go on', async () => {
  const { d, server, state, tick, root } = setup()
  await d.ensure('w0:p1')
  await d.ensure('w0:p2')
  // asleep at once after a start: the grace keeps it (the session may not be on the board yet)
  state.items = [item('s1', 'w0:p1', { sleeping: true }), item('s2', 'w0:p2')]
  d.observe(state.items)
  d.observe(state.items)
  expect(chromeOf(server.procs)).toHaveLength(2)
  tick(61_000)
  d.observe(state.items)
  expect(chromeOf(server.procs)).toHaveLength(2)
  d.observe(state.items)
  await d.ensure('w0:p2') // waits behind nothing; lets the stop run
  await Bun.sleep(10)
  expect(chromeOf(server.procs).map(p => p.env.DISPLAY)).toEqual([':101'])
  expect(existsSync(join(root, 'sessions', '100'))).toBe(false)
  expect(d.view(state.items[0] as Item)).toBeUndefined()
  // ended: no session in its pane any more
  state.items = []
  d.observe(state.items)
  d.observe(state.items)
  await Bun.sleep(10)
  expect([...server.procs.values()].some(p => p.alive)).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'desktops.json'), 'utf8'))).toEqual([])
})

test('a named profile: kept for later; a second session asking for it gets a throwaway copy', async () => {
  const { d, server, root } = setup()
  expect(await d.profile('w0:p1', 'github')).toEqual({ ok: true, port: 9300, copy: false })
  const own = join(root, 'profiles', 'github')
  expect(chromeOf(server.procs)[0]?.argv).toContain(`--user-data-dir=${own}`)
  writeFileSync(join(own, 'Cookies'), 'signed in')
  writeFileSync(join(own, 'SingletonLock'), 'held')
  mkdirSync(join(own, 'Cache'))
  const r = await d.profile('w0:p2', 'github')
  expect(r).toEqual({ ok: true, port: 9301, copy: true })
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
  const { d, state, cards } = setup()
  expect(await d.ask('w0:p9', 'Sign in')).toEqual({ ok: false, error: 'this session is not on the board' })
  expect((await d.ask('w0:p1', 'Sign in to GitHub')).ok).toBe(true)
  expect(cards).toEqual([['s1', { ask: 'Sign in to GitHub', askSince: expect.any(Number), by: 'agent' }]])
  const asking = item('s1', 'w0:p1', { question: 'Sign in to GitHub' })
  expect(d.view(asking)).toEqual({ running: true, profile: null, control: 'agent', asks: true })
  expect(d.setControl(asking, 'owner')).toBe('owner')
  expect(d.control('w0:p1')).toBe('owner')
  expect(d.view(asking)?.asks).toBe(true)
  expect(d.setControl(asking, 'agent')).toBe('agent')
  expect(d.view(asking)?.asks).toBe(false)
  expect(cards.at(-1)).toEqual(['s1', { ask: '', askSince: '' }])
  // the agent went on (the card asks no more): asks goes too, and stays gone
  await d.ask('w0:p1', 'Solve the captcha')
  state.items = [item('s1', 'w0:p1'), item('s2', 'w0:p2')]
  d.observe(state.items)
  expect(d.view(asking)?.asks).toBe(false)
  // no desktop, or asleep: no control to take
  expect(d.setControl(item('s2', 'w0:p2'), 'owner')).toBeNull()
  expect(d.setControl(item('s1', 'w0:p1', { sleeping: true }), 'owner')).toBeNull()
  expect(d.control('w0:p2')).toBe('agent')
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
  expect(await next.ensure('w0:p1')).toEqual({ ok: true, port: 9300 })
  expect(s.server.procs.size).toBe(before)
})

test('the owner’s last view closing hands the browser back to the agent; one of two does not', async () => {
  const { d, state } = setup()
  await d.ensure('w0:p1')
  const asking = state.items[0] as Item
  d.setControl(asking, 'owner')
  const vnc = d.vncOf(asking)
  expect(vnc?.pane).toBe('w0:p1')
  const view = () =>
    ({
      data: { pane: 'w0:p1', socket: join(tmpdir(), 'no-such-vnc.sock') },
      send: () => 0,
      close: () => {},
      getBufferedAmount: () => 0,
    }) as unknown as ServerWebSocket<VncData>
  const a = view()
  const b = view()
  d.websocket.open?.(a)
  d.websocket.open?.(b)
  d.websocket.close?.(a, 1000, '')
  expect(d.control('w0:p1')).toBe('owner')
  d.websocket.close?.(b, 1000, '')
  expect(d.control('w0:p1')).toBe('agent')
})
