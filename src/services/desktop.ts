// Each agent's own browser on the board's server (core/desktop.ts), in the board's process: the
// desktops it runs, one per session's pane, started on demand (the agent's first browser call
// through `board browser-mcp`, or `board browser ask`) and stopped when the session sleeps or
// ends (seen at the board's refresh). Each is an Xvnc display of its own (VNC on a Unix socket in
// the desktop's folder, 0600; X for its cookie only, never over TCP) and a headed Chrome on it
// with its own DevTools port on 127.0.0.1 and its profile: a named one (profiles/<name>, kept for
// later sessions; a copy for a second session while one has it, thrown away afterwards), or the
// session's own (gone with it). Both run in sessions of their own (setsid), so the board's
// restart (run.ts) leaves them running; the next board takes them over from desktops.json.
//
// The owner watches and takes over through the board's login: the VNC bytes go both ways over a
// WebSocket (routes/desktop.ts), and while the owner has the browser the wrapper holds the
// agent's calls. Server mode only: app.ts makes none of this on a PC.
import { randomBytes } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { basename, join } from 'node:path'
import type { ServerWebSocket, WebSocketHandler } from 'bun'
import type { CardPatch } from '../adapters/cards.ts'
import {
  CHROME_BINS,
  type Control,
  chromeArgs,
  desktopView,
  pickSlot,
  slotDisplay,
  slotPort,
  xauthority,
  xvncArgs,
} from '../core/desktop.ts'
import type { Item, ItemDesktop } from '../core/types.ts'

/** What the desktops ask of the server: tests hand in their own. */
export interface DesktopSystem {
  /** A program in a session of its own (setsid), its output into `log`: its pid, and its end. */
  spawn(argv: string[], env: Record<string, string>, log: string): { pid: number; exited: Promise<unknown> }
  /** `signal` to the process group `pid` leads (setsid made it so). */
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  alive(pid: number): boolean
  /** Its command line ('' when not known): whether a recorded pid is still the program the board started. */
  cmdline(pid: number): string
  /** Whether an X server holds the display (its lock or its socket). */
  displayHeld(display: number): boolean
  portFree(port: number): Promise<boolean>
  /** Whether Chrome's DevTools answer on the port. */
  devtools(port: number): Promise<boolean>
  /** A program on PATH (and Chrome's own folder), or null. */
  which(name: string): string | null
  sleep(ms: number): Promise<void>
}

const PATH = '/usr/local/bin:/usr/bin:/bin:/opt/google/chrome'

/** The server's own. */
export const realSystem: DesktopSystem = {
  spawn(argv, env, log) {
    const fd = openSync(log, 'a', 0o600)
    try {
      const proc = Bun.spawn(['setsid', ...argv], { env, stdin: 'ignore', stdout: fd, stderr: fd })
      proc.unref()
      return { pid: proc.pid, exited: proc.exited }
    } finally {
      closeSync(fd)
    }
  },
  kill(pid, signal) {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {}
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as { code?: string }).code === 'EPERM'
    }
  },
  cmdline(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    } catch {
      return ''
    }
  },
  displayHeld: display => existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`),
  portFree: port =>
    new Promise(resolve => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
    }),
  async devtools(port) {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok
    } catch {
      return false
    }
  },
  which: name => Bun.which(name, { PATH: `${process.env.PATH ?? ''}:${PATH}` }),
  sleep: ms => Bun.sleep(ms),
}

/** A session's desktop. */
interface Desktop {
  pane: string
  /** The card's key as last seen. */
  key: string
  slot: number
  display: number
  port: number
  /** Its folder: the VNC socket, the X cookie, the logs, the session's own profile, a copy. */
  dir: string
  vnc: string
  /** The named profile open in it; null: the session's own. */
  profile: string | null
  /** The named profile is a throwaway copy (another session has it). */
  copy: boolean
  control: Control
  asks: boolean
  xvnc: number | null
  chrome: number | null
  startedAt: number
  /** Chrome is up and answers on its port. */
  running: boolean
  /** Refreshes in a row that found no session awake in its pane. */
  missing: number
  /** It is being stopped: an exit now is not a crash. */
  stopping: boolean
}

/** What a desktop's VNC WebSocket carries (routes/desktop.ts). */
export interface VncData {
  pane: string
  socket: string
  /** Called with a close when the viewer's login ends (the domain's listener); returns its unwatch. */
  watch?: (gone: () => void) => () => void
}

export type Started = { ok: true; port: number } | { ok: false; error: string }

export interface DesktopsOptions {
  /** The desktops' folder (stateDir()/desktop). */
  root: string
  /** The sessions on the board now. */
  items(): Item[]
  /** A card's change (adapters/cards.ts writeCard): `board browser ask` puts it under "needs you". */
  writeCard(key: string, patch: CardPatch): void
  onChange(): void
  log(line: string): void
  system?: DesktopSystem
  now?: () => number
  /** Chrome's extra arguments (BOARD_DESKTOP_CHROME_ARGS, for a test server only). */
  chromeExtra?: readonly string[]
}

export interface Desktops {
  /** The card's field for `item`, or undefined: none, or the session sleeps. */
  view(item: Item): ItemDesktop | undefined
  /** The sessions on the board as of a fresh refresh: a desktop with none awake in its pane stops. */
  observe(items: readonly Item[]): void
  /** Started (or running already) for the session in `pane`: Chrome's DevTools port. */
  ensure(pane: string): Promise<Started>
  /** The profile the session wants (null: its own); a running Chrome opens it now. */
  profile(pane: string, name: string | null): Promise<Started & { copy?: boolean }>
  /** The agent asks the owner to act in its browser: its card under "needs you", its desktop up. */
  ask(pane: string, text: string): Promise<Started>
  /** Who has the browser of the session in `pane` (the wrapper asks before each call). */
  control(pane: string): Control
  /** The owner takes the browser or hands it back; null: the session has no desktop. */
  setControl(item: Item, to: Control): Control | null
  /** The VNC socket of the session's running desktop, or null. */
  vncOf(item: Item): { pane: string; socket: string } | null
  stop(pane: string, why: string): Promise<void>
  stopAll(): Promise<void>
  websocket: WebSocketHandler<VncData>
}

/** A session asleep, ended or not yet on the board for this long after its desktop started: it stops. */
const GRACE_MS = 60_000
/** Viewers' bytes queued over this pause the VNC socket until they drain. */
const HIGH_WATER = 4 << 20
/** Files Chrome holds a profile with: never copied. Caches neither: a copy is for one session. */
const NOT_COPIED =
  /^(Singleton(Lock|Socket|Cookie)|Cache|Code Cache|GPUCache|ShaderCache|GrShaderCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache)$/

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A log's last lines, on one line: what a program said before it failed. */
function tailOf(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-3).join(' | ').slice(-400)
  } catch {
    return ''
  }
}

export function createDesktops(o: DesktopsOptions): Desktops {
  const sys = o.system ?? realSystem
  const now = o.now ?? Date.now
  const record = join(o.root, 'desktops.json')
  const desktops = new Map<string, Desktop>()
  /** The profile each pane asked for, kept for its next start. */
  const wanted = new Map<string, string | null>()
  const viewers = new Map<string, Set<ServerWebSocket<VncData>>>()
  const conns = new WeakMap<ServerWebSocket<VncData>, { sock: Socket; unwatch: () => void }>()

  /** One thing at a time per pane, and slots picked one at a time. */
  const chains = new Map<string, Promise<unknown>>()
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = next.catch(() => {})
    chains.set(key, tail)
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return next
  }

  function save(): void {
    try {
      mkdirSync(o.root, { recursive: true, mode: 0o700 })
      const list = [...desktops.values()].map(({ running, missing, stopping, ...d }) => d)
      writeFileSync(record, `${JSON.stringify(list, null, 1)}\n`, { mode: 0o600 })
    } catch (err) {
      o.log(`desktop: ${messageOf(err)}`)
    }
  }

  const ours = (pid: number | null, mark: string): boolean =>
    pid !== null && sys.alive(pid) && sys.cmdline(pid).includes(mark)
  const xvncMark = (d: Pick<Desktop, 'display' | 'vnc'>): string => d.vnc
  const chromeMark = (d: Pick<Desktop, 'port'>): string => `--remote-debugging-port=${d.port}`

  async function ended(pid: number | null, ms: number): Promise<void> {
    if (pid === null) return
    sys.kill(pid, 'SIGTERM')
    for (let waited = 0; waited < ms && sys.alive(pid); waited += 100) await sys.sleep(100)
    if (sys.alive(pid)) sys.kill(pid, 'SIGKILL')
  }

  /** Its processes ended and its folder gone (named profiles stay); its viewers closed. */
  async function teardown(d: Desktop): Promise<void> {
    d.stopping = true
    await ended(d.chrome, 5000)
    await ended(d.xvnc, 3000)
    d.chrome = null
    d.xvnc = null
    d.running = false
    for (const ws of viewers.get(d.pane) ?? []) ws.close(1001, 'stopped')
    viewers.delete(d.pane)
    rmSync(d.dir, { recursive: true, force: true })
  }

  // A board before this one left desktops running: taken over when they are still the programs it
  // started, else what is left of them ended.
  try {
    const list: unknown = JSON.parse(readFileSync(record, 'utf8'))
    for (const r of Array.isArray(list) ? (list as Desktop[]) : []) {
      if (typeof r?.pane !== 'string' || typeof r.dir !== 'string' || !r.dir.startsWith(o.root)) continue
      const d: Desktop = { ...r, running: false, missing: 0, stopping: false, startedAt: now() }
      if (ours(d.xvnc, xvncMark(d))) {
        d.chrome = ours(d.chrome, chromeMark(d)) ? d.chrome : null
        d.running = d.chrome !== null
        desktops.set(d.pane, d)
      } else {
        if (ours(d.chrome, chromeMark(d))) sys.kill(d.chrome as number, 'SIGKILL')
        rmSync(d.dir, { recursive: true, force: true })
      }
    }
    if (desktops.size) o.log(`desktop: ${desktops.size} running from before`)
  } catch {}

  const itemIn = (pane: string): Item | undefined => o.items().find(i => i.pane === pane && !i.sleeping)

  /** Where Chrome keeps the profile `name` for `d`: its own folder, a copy while another has it, or the session's own. */
  function profileDir(d: Desktop, name: string | null): { dir: string; copy: boolean } {
    if (name === null) return { dir: join(d.dir, 'profile'), copy: false }
    const own = join(o.root, 'profiles', name)
    const busy = [...desktops.values()].some(x => x !== d && x.chrome !== null && x.profile === name && !x.copy)
    mkdirSync(own, { recursive: true, mode: 0o700 })
    if (!busy) return { dir: own, copy: false }
    const copy = join(d.dir, `copy-${name}`)
    rmSync(copy, { recursive: true, force: true })
    cpSync(own, copy, { recursive: true, filter: src => !NOT_COPIED.test(basename(src)) })
    return { dir: copy, copy: true }
  }

  async function launchChrome(d: Desktop): Promise<Started> {
    const bin = CHROME_BINS.map(b => sys.which(b)).find(Boolean)
    if (!bin) return { ok: false, error: 'no Google Chrome or Chromium on this server (the install puts it in place)' }
    const name = wanted.get(d.pane) ?? null
    const p = profileDir(d, name)
    d.profile = name
    d.copy = p.copy
    const env = {
      DISPLAY: `:${d.display}`,
      XAUTHORITY: join(d.dir, 'Xauthority'),
      HOME: process.env.HOME ?? '',
      PATH: `${process.env.PATH ?? ''}:${PATH}`,
      LANG: process.env.LANG || 'C.UTF-8',
    }
    const proc = sys.spawn(
      [bin, ...chromeArgs({ profileDir: p.dir, port: d.port, extra: o.chromeExtra ?? [] })],
      env,
      join(d.dir, 'chrome.log'),
    )
    d.chrome = proc.pid
    let gone = false
    void proc.exited.then(() => {
      gone = true
      if (d.chrome !== proc.pid || d.stopping) return
      d.chrome = null
      d.running = false
      o.log(`desktop :${d.display}: Chrome ended`)
      o.onChange()
    })
    for (let waited = 0; waited < 30_000 && !gone; waited += 250) {
      if (await sys.devtools(d.port)) {
        d.running = true
        return { ok: true, port: d.port }
      }
      await sys.sleep(250)
    }
    await ended(gone ? null : proc.pid, 2000)
    d.chrome = null
    return { ok: false, error: `Chrome did not start: ${tailOf(join(d.dir, 'chrome.log')) || 'no answer on its port'}` }
  }

  async function startNew(pane: string): Promise<Started> {
    const slot = await serial('slots', () =>
      pickSlot(
        new Set([...desktops.values()].map(d => d.slot)),
        async s => sys.displayHeld(slotDisplay(s)) || !(await sys.portFree(slotPort(s))),
      ),
    )
    if (slot === null) return { ok: false, error: 'every desktop is in use on this server' }
    const xvncBin = sys.which('Xvnc')
    if (!xvncBin) return { ok: false, error: 'no Xvnc on this server (the install puts TigerVNC in place)' }
    const display = slotDisplay(slot)
    const dir = join(o.root, 'sessions', String(display))
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const d: Desktop = {
      pane,
      key: itemIn(pane)?.key ?? '',
      slot,
      display,
      port: slotPort(slot),
      dir,
      vnc: join(dir, 'vnc.sock'),
      profile: null,
      copy: false,
      control: 'agent',
      asks: false,
      xvnc: null,
      chrome: null,
      startedAt: now(),
      running: false,
      missing: 0,
      stopping: false,
    }
    desktops.set(pane, d)
    const auth = join(dir, 'Xauthority')
    writeFileSync(auth, xauthority(display, randomBytes(16)), { mode: 0o600 })
    const proc = sys.spawn(
      [xvncBin, ...xvncArgs({ display, socket: d.vnc, auth, name: `agent-board ${d.key || pane}` })],
      { HOME: process.env.HOME ?? '', PATH: `${process.env.PATH ?? ''}:${PATH}` },
      join(dir, 'xvnc.log'),
    )
    d.xvnc = proc.pid
    let gone = false
    void proc.exited.then(() => {
      gone = true
      if (d.xvnc !== proc.pid || d.stopping) return
      o.log(`desktop :${display}: Xvnc ended`)
      void stop(pane, 'its display ended')
    })
    let up = false
    for (let waited = 0; waited < 10_000 && !gone && !up; waited += 100) {
      up = existsSync(d.vnc) && sys.displayHeld(display)
      if (!up) await sys.sleep(100)
    }
    const fail = async (error: string): Promise<Started> => {
      await teardown(d)
      desktops.delete(pane)
      save()
      return { ok: false, error }
    }
    if (!up) return fail(`Xvnc did not start on :${display}: ${tailOf(join(dir, 'xvnc.log')) || 'no socket'}`)
    const r = await launchChrome(d)
    if (!r.ok) return fail(r.error)
    save()
    o.log(`desktop :${display} for ${d.key || pane}: Chrome on 127.0.0.1:${d.port}`)
    o.onChange()
    return r
  }

  async function ensureNow(pane: string): Promise<Started> {
    const d = desktops.get(pane)
    if (d && d.xvnc !== null && sys.alive(d.xvnc)) {
      if (d.chrome !== null && sys.alive(d.chrome) && d.running) return { ok: true, port: d.port }
      // the display is there, Chrome not (it ended, or the board took it over without it)
      const r = await launchChrome(d)
      save()
      o.onChange()
      return r
    }
    if (d) {
      await teardown(d)
      desktops.delete(pane)
    }
    return startNew(pane)
  }

  async function stopNow(pane: string, why: string): Promise<void> {
    const d = desktops.get(pane)
    if (!d) return
    await teardown(d)
    desktops.delete(pane)
    wanted.delete(pane)
    save()
    o.log(`desktop :${d.display} for ${d.key || pane} stopped: ${why}`)
    o.onChange()
  }

  const stop = (pane: string, why: string): Promise<void> => serial(pane, () => stopNow(pane, why))

  /**
   * A viewer gone. The last one gone while the owner has the browser hands it back to the agent:
   * a closed tab cannot say so (what the agent asked stays asked).
   */
  function closeViewer(ws: ServerWebSocket<VncData>): void {
    const c = conns.get(ws)
    conns.delete(ws)
    c?.unwatch()
    c?.sock.destroy()
    const set = viewers.get(ws.data.pane)
    set?.delete(ws)
    if (set?.size) return
    viewers.delete(ws.data.pane)
    const d = desktops.get(ws.data.pane)
    if (d?.control !== 'owner' || d.stopping) return
    d.control = 'agent'
    save()
    o.log(`desktop :${d.display} for ${d.key || d.pane}: back to the agent (the owner's view closed)`)
    o.onChange()
  }

  return {
    view(item) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping) return undefined
      return desktopView(d, !!item.question)
    },

    observe(items) {
      let changed = false
      for (const d of desktops.values()) {
        const item = items.find(i => i.pane === d.pane && !i.sleeping)
        if (item) {
          d.missing = 0
          d.key = item.key
          // the card asks no more: the agent went on, or the user answered
          if (d.asks && !item.question) {
            d.asks = false
            changed = true
          }
        } else if (now() - d.startedAt >= GRACE_MS && ++d.missing >= 2) {
          const asleep = items.some(i => i.pane === d.pane && i.sleeping)
          void stop(d.pane, asleep ? 'the session sleeps' : 'the session ended')
        }
        if (d.chrome !== null && !d.stopping && !sys.alive(d.chrome)) {
          d.chrome = null
          d.running = false
          changed = true
        }
      }
      if (changed) {
        save()
        o.onChange()
      }
    },

    ensure: pane => serial(pane, () => ensureNow(pane)),

    profile: (pane, name) =>
      serial(pane, async () => {
        wanted.set(pane, name)
        const d = desktops.get(pane)
        if (!d || d.chrome === null)
          return ensureNow(pane).then(r => (r.ok ? { ...r, copy: desktops.get(pane)?.copy ?? false } : r))
        if (d.profile === name && !d.copy) return { ok: true, port: d.port, copy: false }
        d.stopping = true
        await ended(d.chrome, 5000)
        d.stopping = false
        d.chrome = null
        d.running = false
        if (d.copy && d.profile) rmSync(join(d.dir, `copy-${d.profile}`), { recursive: true, force: true })
        const r = await launchChrome(d)
        save()
        o.onChange()
        return r.ok ? { ...r, copy: d.copy } : r
      }),

    async ask(pane, text) {
      const item = itemIn(pane)
      if (!item) return { ok: false, error: 'this session is not on the board' }
      const r = await serial(pane, () => ensureNow(pane))
      if (!r.ok) return r
      o.writeCard(item.key, { ask: text, askSince: now(), by: 'agent' })
      const d = desktops.get(pane)
      if (d) {
        d.asks = true
        save()
      }
      o.onChange()
      return r
    },

    control: pane => desktops.get(pane)?.control ?? 'agent',

    setControl(item, to) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping) return null
      if (d.control === to) return to
      d.control = to
      // handed back: what the agent asked for is done
      if (to === 'agent' && d.asks) {
        d.asks = false
        if (item.question) o.writeCard(item.key, { ask: '', askSince: '' })
      }
      save()
      o.log(`desktop :${d.display} for ${item.key}: ${to === 'owner' ? 'the owner has it' : 'back to the agent'}`)
      o.onChange()
      return to
    },

    vncOf(item) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping || d.xvnc === null || !existsSync(d.vnc)) return null
      return { pane: d.pane, socket: d.vnc }
    },

    stop,

    async stopAll() {
      await Promise.all([...desktops.keys()].map(pane => stop(pane, 'the board stopped them')))
    },

    websocket: {
      // the picture compresses well; Bun keeps it per message
      perMessageDeflate: true,
      open(ws) {
        const sock = createConnection({ path: ws.data.socket })
        sock.on('data', chunk => {
          ws.send(chunk)
          if (ws.getBufferedAmount() > HIGH_WATER) sock.pause()
        })
        sock.on('error', () => ws.close(1011, 'vnc'))
        sock.on('close', () => ws.close(1000, 'vnc'))
        const unwatch = ws.data.watch?.(() => ws.close(4001, 'login')) ?? (() => {})
        conns.set(ws, { sock, unwatch })
        const set = viewers.get(ws.data.pane) ?? new Set()
        set.add(ws)
        viewers.set(ws.data.pane, set)
      },
      message(ws, msg) {
        conns.get(ws)?.sock.write(typeof msg === 'string' ? Buffer.from(msg) : msg)
      },
      drain(ws) {
        conns.get(ws)?.sock.resume()
      },
      close(ws) {
        closeViewer(ws)
      },
    },
  }
}
