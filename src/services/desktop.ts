// Each agent's own browser on the board's server (core/desktop.ts), in the board's process: the
// desktops it runs, one per session's pane, started on demand (the agent's first browser call
// through `board browser-mcp`, or `board browser ask|open|run`) and stopped when the session sleeps or
// ends (seen at the board's refresh). Each is an Xvnc display of its own (VNC on a Unix socket in
// the desktop's folder, 0600; X for its cookie only, never over TCP) and a headed Chrome on it
// with its profile: a named one (profiles/<name>, kept for later sessions; a copy for a second
// session while one has it, thrown away afterwards), or the session's own (gone with it). Chrome's
// DevTools are on a pipe, no TCP port: its holder (entrypoints/cdp-pipe.ts) serves the pipe on a
// Unix socket in the desktop's folder, and the agent reaches it only through the board's keyed
// route (routes/desktop.ts /api/browser/cdp), which this bridges. Xvnc and the holder run in
// sessions of their own (setsid), so the board's restart (run.ts) leaves them running; the next
// board takes them over from desktops.json, where each is from the moment it is spawned.
//
// It runs only while needed: the agent closes it once done (browser_close), and one unused a while
// (IDLE_MS: no call of the agent's, no view of it, the owner not holding it, no ask standing) stops
// by itself. Such a stop ends Chrome as a person quits it (its tabs and cookies saved) and its
// display with it, and keeps the session's profile folders (kept/<id>, on file in kept.json) until
// its next call starts it again with them and its last tabs, or until the session ends as a
// running one's do. The card shows none meanwhile, as for a session that never had one.
//
// The owner watches and takes over through the board's login: the VNC bytes go both ways over a
// WebSocket (routes/desktop.ts), a viewer's keys, mouse and clipboard only while the owner has the
// browser, and meanwhile the wrapper holds the agent's calls. The picture comes as H.264 video on a
// WebSocket of its own where the server has ffmpeg (services/desktop-video.ts: one encoder per
// desktop while it has viewers), the VNC connection then carrying the input and no picture; where
// it has none, the page asks VNC for the picture as before. Server mode only: app.ts makes none
// of this on a PC.
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { basename, join, sep } from 'node:path'
import type { ServerWebSocket, WebSocketHandler } from 'bun'
import type { CardPatch } from '../adapters/cards.ts'
import { boardChromium } from '../adapters/desktop-files.ts'
import {
  asksInTurn,
  BOARD_CHROMIUM_DIR,
  CHROME_BINS,
  type Control,
  chromeArgs,
  deskKeymap,
  desktopView,
  handedBackText,
  pickSlot,
  rfbInputFilter,
  slotDisplay,
  xauthority,
  xvncArgs,
} from '../core/desktop.ts'
import type { Card, Item, ItemDesktop } from '../core/types.ts'
import { nulFrames } from './cdp-pipe.ts'
import { createDesktopVideo, type DesktopVideo, VIDEO_NONE, type VideoViewer } from './desktop-video.ts'

/** What the desktops ask of the server: tests hand in their own. */
export interface DesktopSystem {
  /** A program in a session of its own (setsid), its output into `log`: its pid, and its end. */
  spawn(argv: string[], env: Record<string, string>, log: string): { pid: number; exited: Promise<unknown> }
  /**
   * Chrome (`argv`) with its DevTools on a pipe, under its holder in a session of its own, which
   * serves the pipe on the Unix socket `cdp` once Chrome answers there (entrypoints/cdp-pipe.ts):
   * the holder's pid (its command line has `cdp`), and its end, which is Chrome's.
   */
  spawnChrome(
    argv: string[],
    cdp: string,
    env: Record<string, string>,
    log: string,
  ): { pid: number; exited: Promise<unknown> }
  /** `signal` to the process group `pid` leads (setsid made it so). */
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  alive(pid: number): boolean
  /** Its command line ('' when not known): whether a recorded pid is still the program the board started. */
  cmdline(pid: number): string
  /** Whether an X server holds the display (its lock, a stale one cleared; or its socket). */
  displayHeld(display: number): boolean
  /** Whether Chrome answered on its pipe: its holder's socket is there. */
  cdpReady(cdp: string): boolean | Promise<boolean>
  /**
   * Chrome asked to quit as a person quits it (Browser.close on its holder's socket `cdp`), so its
   * tabs, cookies and settings are saved for its next start; done once asked (or not answered).
   * None: Chrome is ended by a signal only.
   */
  quit?(cdp: string): Promise<void>
  /**
   * Chrome (`argv`: its program, a running one's profile folder, an address) run once more: it
   * hands the address to the Chrome running on that profile (Chrome's process singleton), which
   * opens it in a tab, and ends. True when it ended so within `ms`; ended by a signal otherwise,
   * well before Chrome's own wait (20 s), after which it would end the running one as hung. None:
   * no address is opened.
   */
  relay?(argv: string[], env: Record<string, string>, ms: number): Promise<boolean>
  /** A program on PATH (and Chrome's own folder), or null. */
  which(name: string): string | null
  sleep(ms: number): Promise<void>
}

const PATH = '/usr/local/bin:/usr/bin:/bin:/opt/google/chrome'
/** Chrome's holder, run by the board's own bun. */
const HOLDER = join(import.meta.dir, '..', 'entrypoints', 'cdp-pipe.ts')

function spawnInSession(
  argv: string[],
  env: Record<string, string>,
  log: string,
): { pid: number; exited: Promise<unknown> } {
  const fd = openSync(log, 'a', 0o600)
  try {
    const proc = Bun.spawn(['setsid', ...argv], { env, stdin: 'ignore', stdout: fd, stderr: fd })
    proc.unref()
    return { pid: proc.pid, exited: proc.exited }
  } finally {
    closeSync(fd)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

/**
 * Whether an X server holds `display` (its lock in `tmp`, with a pid that runs). A lock whose
 * server is gone (a SIGKILL leaves it, and the socket) is cleared with its socket, so the slot is
 * free again; one that cannot be cleared (another account's) holds it. A socket with no lock is
 * not known to be stale: held.
 */
export function displayHeldAt(display: number, tmp = '/tmp', alive: (pid: number) => boolean = pidAlive): boolean {
  const lock = join(tmp, `.X${display}-lock`)
  const socket = join(tmp, '.X11-unix', `X${display}`)
  let text: string
  try {
    text = readFileSync(lock, 'utf8')
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT' ? existsSync(socket) : true
  }
  const pid = Number.parseInt(text.trim(), 10)
  if (!(pid > 0) || alive(pid)) return true
  try {
    rmSync(socket, { force: true })
    rmSync(lock)
    return false
  } catch {
    return true
  }
}

/** The server's own. */
export const realSystem: DesktopSystem = {
  spawn: spawnInSession,
  spawnChrome: (argv, cdp, env, log) => spawnInSession([process.execPath, HOLDER, cdp, ...argv], env, log),
  kill(pid, signal) {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {}
    }
  },
  alive: pidAlive,
  cmdline(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    } catch {
      return ''
    }
  },
  displayHeld: display => displayHeldAt(display),
  cdpReady: cdp => existsSync(cdp),
  quit: cdp =>
    new Promise<void>(resolve => {
      const sock = createConnection({ path: cdp })
      const late = setTimeout(() => sock.destroy(), 3000)
      sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, method: 'Browser.close' })}\0`))
      sock.on('data', () => sock.destroy())
      sock.on('error', () => {})
      sock.on('close', () => {
        clearTimeout(late)
        resolve()
      })
    }),
  async relay(argv, env, ms) {
    const proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    let late = false
    const timer = setTimeout(() => {
      late = true
      proc.kill('SIGKILL')
    }, ms)
    const code = await proc.exited
    clearTimeout(timer)
    return !late && code === 0
  },
  which: name => Bun.which(name, { PATH: `${process.env.PATH ?? ''}:${PATH}` }),
  sleep: ms => Bun.sleep(ms),
}

/** A session's desktop. */
interface Desktop {
  pane: string
  /** The card's key as last seen. */
  key: string
  /** The session it was started for ('' not known yet): another one in the pane (/clear) stops it. */
  session: string
  slot: number
  display: number
  /** Its folder (0700): the VNC socket, Chrome's DevTools socket, the X cookie, the logs, the session's own profile, a copy. */
  dir: string
  vnc: string
  /** Chrome's DevTools: its holder's Unix socket (0600), there once Chrome answers on its pipe. */
  cdp: string
  /** The named profile open in it; null: the session's own. */
  profile: string | null
  /** The named profile is a throwaway copy (another session has it). */
  copy: boolean
  control: Control
  /** Its browser ask stands: from the ask until handed back, or until its card's ask is over (not the agent working on). */
  asks: boolean
  /** What that ask said (the browser's own view shows it while it stands). */
  ask: string
  /** When the browser ask put its ask on the card (the card's askSince): handing back clears that ask only. */
  askSince: number | null
  xvnc: number | null
  /** Chrome's holder (Chrome under it, in its session). */
  chrome: number | null
  startedAt: number
  /** Chrome is up and answers on its pipe. */
  running: boolean
  /** Since when no session is awake in its pane (0: one is). */
  goneSince: number
  /** It is being stopped: an exit now is not a crash. */
  stopping: boolean
  /** Since when the owner has the browser with no view connected (0: a view is, or the agent has it). */
  unviewedSince: number
  /** The agent's last call (or the last view, the owner's control or an ask ending): IDLE_MS on, it stops. */
  usedAt: number
  /** Started again after its stop: the profile it had then (its last tabs reopened in that one only). */
  restore: { profile: string | null; copy: boolean } | null
  /** It stops (browser_close, idle): the card has no browser from the stop's start. */
  closing: boolean
}

/**
 * A session's browser stopped while the session goes on (browser_close, or idle): Chrome and its
 * display ended, its profile folders (its own, a named profile's copy) kept in a folder of their
 * own until its next call starts it again with them, or the session ends as a running one's does.
 */
interface Kept {
  pane: string
  key: string
  session: string
  /** Its folder (kept/<id>): the stopped desktop's `profile` and `copy-<name>`, moved there. */
  dir: string
  /** The profile it had open (null: the session's own), and whether a copy of it. */
  profile: string | null
  copy: boolean
  /** Since when no session is awake in its pane (0: one is). */
  goneSince: number
}

/** What a hand-over came to: who has the browser now, or why not (404: no desktop; 409: no view to take it in). */
export type ControlAnswer = { ok: true; control: Control } | { ok: false; status: 404 | 409; error: string }

/** What a desktop's WebSocket carries (routes/desktop.ts): a view's VNC, its video, or the agent's DevTools (`cdp`). */
export interface VncData {
  pane: string
  socket: string
  /** The agent's DevTools (chrome-devtools-mcp through the keyed route), not a view. */
  cdp?: boolean
  /** A view's video (services/desktop-video.ts), not its VNC: `socket` is not used. */
  video?: boolean
  /** Called with a close when the viewer's login ends (the domain's listener); returns its unwatch. */
  watch?: (gone: () => void) => () => void
}

export type Started = { ok: true } | { ok: false; error: string }

export interface DesktopsOptions {
  /** The desktops' folder (stateDir()/desktop). */
  root: string
  /** The sessions on the board now. */
  items(): Item[]
  /** A card's change (adapters/cards.ts writeCard): `board browser ask` puts it under "needs you". */
  writeCard(key: string, patch: CardPatch): void
  /**
   * A session's card as it is now (adapters/cards.ts readCard): whether the browser ask on it is
   * still there, which the board's item does not say while the agent works on.
   */
  readCard(key: string): Card | null
  /**
   * A board reminder to the session, due now (adapters/schedule-store.ts addEntry): the scheduler
   * types it into its prompt, waking it if it sleeps, queued into its turn if it works.
   */
  remind(item: Item, text: string): void
  onChange(): void
  log(line: string): void
  system?: DesktopSystem
  now?: () => number
  /** Chrome's extra arguments (BOARD_DESKTOP_CHROME_ARGS, for a test server only). */
  chromeExtra?: readonly string[]
  /** The machine's (process.arch; a test's own): on arm64 the board's own Chromium comes first where it is. */
  arch?: string
  /** The desktops' video (a test's own); by default the board's, with ffmpeg where the server has it. */
  video?: DesktopVideo
  /** A desktop unused this long stops (IDLE_MS; a test's own). */
  idleMs?: number
  /** The languages its Chrome tells pages (core/desktop.ts deskLanguages), as the board's setting is at its start; null: Chrome's own. */
  languages?: () => readonly string[] | null
}

export interface Desktops {
  /** The card's field for `item`, or undefined: none, or the session sleeps. */
  view(item: Item): ItemDesktop | undefined
  /**
   * What its browser ask puts on the card of `item` while the agent's turn runs on: under "needs
   * you" with the ask as its question, as a `board ask` (core/desktop.ts asksInTurn); else nothing.
   */
  card(item: Item): Partial<Item>
  /** The sessions on the board as of a fresh refresh: a desktop with none awake in its pane stops. */
  observe(items: readonly Item[]): void
  /** Started (or running already) for the session in `pane`. */
  ensure(pane: string): Promise<Started>
  /** The DevTools socket of the pane's running Chrome, or null. */
  cdpOf(pane: string): string | null
  /** The profile the session wants (null: its own); a running Chrome opens it now. */
  profile(pane: string, name: string | null): Promise<Started & { copy?: boolean }>
  /**
   * The agent is done with its browser for now (browser_close): Chrome and its display stop as one,
   * its profile kept, and its next call starts it again with its tabs. Not while the owner has it or
   * its ask to them stands. `closed`: false when none ran.
   */
  close(pane: string): Promise<{ ok: true; closed: boolean } | { ok: false; error: string }>
  /** The agent asks the owner to act in its browser: its card under "needs you", its desktop up. */
  ask(pane: string, text: string): Promise<Started>
  /**
   * An address (core/desktop.ts openUrl) opened in the session's browser, in a tab of its own,
   * the browser started when it is not up (`board browser open`). Not while the owner has it.
   */
  open(pane: string, url: string): Promise<Started>
  /**
   * The session's display for a program of its own (`board browser run`), started when it is not
   * up: its number and its X cookie file.
   */
  display(pane: string): Promise<{ ok: true; display: number; xauthority: string } | { ok: false; error: string }>
  /** Who has the browser of the session in `pane` (the wrapper asks before each call: its idle clock starts again). */
  control(pane: string): Control
  /** Its browser ask stands (the wrapper: while the owner has the browser for it, a call that acts fails at once). */
  asks(pane: string): boolean
  /** The owner takes the browser (only with a view of it connected) or hands it back. */
  setControl(item: Item, to: Control): ControlAnswer
  /** The VNC socket of the session's running desktop, or null. */
  vncOf(item: Item): { pane: string; socket: string } | null
  /** The session's running desktop's pane for its video: null with no desktop; `none` where the server has no ffmpeg. */
  videoOf(item: Item): { pane: string } | 'none' | null
  stop(pane: string, why: string): Promise<void>
  stopAll(): Promise<void>
  websocket: WebSocketHandler<VncData>
}

/**
 * No session awake in its pane for this long on end (asleep, ended, not on the board yet): the
 * desktop stops. A restart (sleep, then wake) and a refresh that misses the pane keep it.
 */
const GONE_MS = 2 * 60_000
/** The owner has the browser and no view of it is connected for this long: the agent has it again. */
const UNVIEWED_MS = 30_000
/**
 * No call of the agent's for this long, no view of it connected (VNC or video), the owner not
 * holding it and no ask standing: it stops as browser_close stops it (its profile kept).
 */
const IDLE_MS = 15 * 60_000
/** Chrome asked to quit and still running this long after: ended by a signal. */
const QUIT_MS = 10_000
/** Chrome run to hand an address to the running one and not ended this long after: ended by a signal. */
const RELAY_MS = 10_000
/** A desktop's folders that are the session's profiles: its own, and a named profile's copy. */
const PROFILE_FOLDER = /^(profile|copy-.+)$/
/** Viewers' bytes queued over this pause the VNC socket until they drain. */
const HIGH_WATER = 4 << 20
/**
 * What Chrome holds a profile with (its locks, LevelDB's): never copied. Caches, service workers'
 * caches and scripts and Chrome's own downloads neither: a copy is for one session, and its
 * sign-ins are in its cookies, local storage and IndexedDB, which are.
 */
const NOT_COPIED =
  /^(Singleton(Lock|Socket|Cookie)|LOCK|lockfile|Cache|Code Cache|GPUCache|ShaderCache|GrShaderCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Service Worker|Crashpad|BrowserMetrics|component_crx_cache|extensions_crx_cache|optimization_guide_model_store)$/

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
  const idleMs = o.idleMs ?? IDLE_MS
  const video = o.video ?? createDesktopVideo({ log: o.log })
  /** Each video viewer's socket as the video sends to it. */
  const watchers = new WeakMap<ServerWebSocket<VncData>, { viewer: VideoViewer; unwatch: () => void }>()
  const record = join(o.root, 'desktops.json')
  const desktops = new Map<string, Desktop>()
  /** The browsers stopped while their sessions go on (browser_close, idle), by pane; on file in kept.json. */
  const kept = new Map<string, Kept>()
  const keptRecord = join(o.root, 'kept.json')
  const keptRoot = join(o.root, 'kept')
  /** The profile each pane asked for, kept for its next start. */
  const wanted = new Map<string, string | null>()
  const viewers = new Map<string, Set<ServerWebSocket<VncData>>>()
  /** Each pane's video viewers. */
  const videos = new Map<string, Set<ServerWebSocket<VncData>>>()
  /** Slots picked for a start that is not in the list yet. */
  const picking = new Set<number>()
  /** Each viewer's VNC connection (`up` once connected), and what of its bytes go on (core/desktop.ts rfbInputFilter). */
  const conns = new WeakMap<
    ServerWebSocket<VncData>,
    { sock: Socket; unwatch: () => void; up: boolean; filter: ReturnType<typeof rfbInputFilter> }
  >()
  /** Whether a view of the pane's desktop is connected to its display. */
  const viewed = (pane: string): boolean => [...(viewers.get(pane) ?? [])].some(ws => conns.get(ws)?.up)
  /** Whether a view of it is open on the board, its VNC or its video. */
  const watched = (pane: string): boolean => !!viewers.get(pane)?.size || !!videos.get(pane)?.size
  /** The pane's desktop was used now: its idle clock starts again. */
  const touch = (pane: string): void => {
    const d = desktops.get(pane)
    if (d) d.usedAt = now()
  }
  /** Displays whose keyboard has the Cyrillic letters (deskKeymap), loading or loaded. */
  const keyed = new WeakSet<Desktop>()

  /**
   * The display's keyboard with the Cyrillic letters too (core/desktop.ts deskKeymap), once, as its
   * first view opens (so a display that ran before it, the board's restart, has them too): what the
   * owner types in Russian then goes as keys. Without xkbcomp (it comes with Xvnc), as before.
   */
  async function keymapOf(d: Desktop): Promise<void> {
    if (keyed.has(d)) return
    keyed.add(d)
    const xkbcomp = sys.which('xkbcomp')
    if (!xkbcomp) return
    const file = join(d.dir, 'keymap.xkb')
    try {
      writeFileSync(file, deskKeymap(), { mode: 0o600 })
    } catch {
      return
    }
    const proc = sys.spawn(
      [xkbcomp, '-w', '0', file, `:${d.display}`],
      {
        HOME: process.env.HOME ?? '',
        PATH: `${process.env.PATH ?? ''}:${PATH}`,
        XAUTHORITY: join(d.dir, 'Xauthority'),
      },
      join(d.dir, 'xkbcomp.log'),
    )
    const code = await proc.exited
    if (code === 0) return
    keyed.delete(d)
    o.log(
      `desktop :${d.display}: its keymap did not load (xkbcomp ${String(code)}: ${tailOf(join(d.dir, 'xkbcomp.log'))})`,
    )
  }

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
      const list = [...desktops.values()].map(
        ({ running, goneSince, stopping, unviewedSince, usedAt, restore, closing, ...d }) => d,
      )
      writeFileSync(record, `${JSON.stringify(list, null, 1)}\n`, { mode: 0o600 })
      if (kept.size || existsSync(keptRecord)) {
        const stopped = [...kept.values()].map(({ goneSince, ...k }) => k)
        writeFileSync(keptRecord, `${JSON.stringify(stopped, null, 1)}\n`, { mode: 0o600 })
      }
    } catch (err) {
      o.log(`desktop: ${messageOf(err)}`)
    }
  }

  const ours = (pid: number | null, mark: string): boolean =>
    pid !== null && sys.alive(pid) && sys.cmdline(pid).includes(mark)
  const xvncMark = (d: Pick<Desktop, 'vnc'>): string => d.vnc
  const chromeMark = (d: Pick<Desktop, 'cdp'>): string => d.cdp
  /** The agent's DevTools bridges (to each Chrome's holder): the socket, and sends what waits. */
  const cdps = new WeakMap<ServerWebSocket<VncData>, { sock: Socket; flush: () => void }>()

  async function ended(pid: number | null, ms: number): Promise<void> {
    if (pid === null) return
    sys.kill(pid, 'SIGTERM')
    for (let waited = 0; waited < ms && sys.alive(pid); waited += 100) await sys.sleep(100)
    if (sys.alive(pid)) sys.kill(pid, 'SIGKILL')
  }

  /**
   * Chrome asked to quit as a person quits it, and waited for (QUIT_MS): its tabs and cookies on
   * disk (a signal alone loses what it did in the last half minute, and its tabs). What is left of
   * it after that is ended by a signal.
   */
  async function quitChrome(d: Desktop): Promise<void> {
    const pid = d.chrome
    if (pid === null || !sys.quit || !sys.alive(pid) || !existsSync(d.cdp)) return
    try {
      await sys.quit(d.cdp)
    } catch {
      return
    }
    for (let waited = 0; waited < QUIT_MS && sys.alive(pid); waited += 100) await sys.sleep(100)
  }

  /** The session's profile folders moved out of a desktop's folder into one of their own (kept/<id>). */
  function keepProfiles(d: Desktop): string | null {
    const to = join(keptRoot, randomBytes(8).toString('hex'))
    try {
      mkdirSync(to, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(d.dir))
        if (PROFILE_FOLDER.test(name)) renameSync(join(d.dir, name), join(to, name))
      return to
    } catch (err) {
      o.log(`desktop :${d.display}: its profile was not kept: ${messageOf(err)}`)
      return existsSync(to) ? to : null
    }
  }

  /**
   * Its processes ended (Chrome asked to quit first: what it did last is on disk, a named profile's
   * too) and its folder gone (named profiles stay); its viewers closed. `keep`: the session's
   * profile folders kept (their folder's path).
   */
  async function teardown(d: Desktop, keep = false): Promise<string | null> {
    d.stopping = true
    await quitChrome(d)
    await ended(d.chrome, 5000)
    await ended(d.xvnc, 3000)
    d.chrome = null
    d.xvnc = null
    d.running = false
    video.stop(d.pane)
    for (const ws of viewers.get(d.pane) ?? []) ws.close(1001, 'stopped')
    viewers.delete(d.pane)
    videos.delete(d.pane)
    const dir = keep ? keepProfiles(d) : null
    rmSync(d.dir, { recursive: true, force: true })
    return dir
  }

  // A board before this one left desktops running: taken over when they are still the programs it
  // started and were up (one it was starting is ended: the next call starts it again), else what is
  // left of them ended. The agent has each again: no view of this board's is open yet.
  try {
    const list: unknown = JSON.parse(readFileSync(record, 'utf8'))
    for (const r of Array.isArray(list) ? (list as Desktop[]) : []) {
      if (typeof r?.pane !== 'string' || typeof r.dir !== 'string' || !r.dir.startsWith(o.root)) continue
      if (typeof r.cdp !== 'string' || typeof r.vnc !== 'string') {
        // a board before the DevTools pipe: its Chrome on a TCP port, ended with its display
        const port = (r as { port?: unknown }).port
        if (typeof port === 'number' && ours(r.chrome, `--remote-debugging-port=${port}`))
          sys.kill(r.chrome as number, 'SIGKILL')
        if (typeof r.vnc === 'string' && ours(r.xvnc, r.vnc)) sys.kill(r.xvnc as number, 'SIGKILL')
        rmSync(r.dir, { recursive: true, force: true })
        continue
      }
      const d: Desktop = {
        ...r,
        session: typeof r.session === 'string' ? r.session : '',
        ask: typeof r.ask === 'string' ? r.ask : '',
        askSince: typeof r.askSince === 'number' ? r.askSince : null,
        control: 'agent',
        running: false,
        goneSince: 0,
        stopping: false,
        unviewedSince: 0,
        usedAt: now(),
        restore: null,
        closing: false,
        startedAt: now(),
      }
      const chrome = ours(d.chrome, chromeMark(d))
      if (ours(d.xvnc, xvncMark(d)) && existsSync(d.vnc)) {
        d.running = chrome && existsSync(d.cdp)
        if (chrome && !d.running) sys.kill(d.chrome as number, 'SIGKILL')
        if (!d.running) d.chrome = null
        desktops.set(d.pane, d)
      } else {
        if (chrome) sys.kill(d.chrome as number, 'SIGKILL')
        if (ours(d.xvnc, xvncMark(d))) sys.kill(d.xvnc as number, 'SIGKILL')
        rmSync(d.dir, { recursive: true, force: true })
      }
    }
    if (desktops.size) o.log(`desktop: ${desktops.size} running from before`)
  } catch {}
  // and the browsers it had stopped while their sessions went on: their profiles still kept; a kept
  // folder no record has (a board that ended between its move and its record) is cleared away
  try {
    const list: unknown = JSON.parse(readFileSync(keptRecord, 'utf8'))
    for (const r of Array.isArray(list) ? (list as Kept[]) : []) {
      if (typeof r?.pane !== 'string' || typeof r.dir !== 'string' || !r.dir.startsWith(keptRoot + sep)) continue
      if (desktops.has(r.pane) || !existsSync(r.dir)) continue
      kept.set(r.pane, {
        pane: r.pane,
        key: typeof r.key === 'string' ? r.key : '',
        session: typeof r.session === 'string' ? r.session : '',
        dir: r.dir,
        profile: typeof r.profile === 'string' ? r.profile : null,
        copy: r.copy === true,
        goneSince: 0,
      })
    }
  } catch {}
  try {
    const known = new Set([...kept.values()].map(k => k.dir))
    for (const name of readdirSync(keptRoot))
      if (!known.has(join(keptRoot, name))) rmSync(join(keptRoot, name), { recursive: true, force: true })
  } catch {}

  const itemIn = (pane: string): Item | undefined => o.items().find(i => i.pane === pane && !i.sleeping)
  /** The card of `key` still has the ask the browser ask put on it (the same one, by its askSince). */
  const cardAsks = (key: string, d: Desktop): boolean => {
    if (d.askSince === null) return false
    const card = o.readCard(key)
    return !!card?.ask && card.askSince === d.askSince
  }

  /**
   * Where Chrome keeps the profile `name` for `d`: its own folder, a copy while another has it, or
   * the session's own. The copy is made without holding up the board (other panes' calls, refreshes);
   * `ownCopy`: the session's copy from before its stop is its own still, as it was. `fresh`: a copy
   * made now (what is in it is the other session's).
   */
  async function profileDir(
    d: Desktop,
    name: string | null,
    ownCopy = false,
  ): Promise<{ dir: string; copy: boolean; fresh: boolean }> {
    if (name === null) return { dir: join(d.dir, 'profile'), copy: false, fresh: false }
    const copy = join(d.dir, `copy-${name}`)
    if (ownCopy && existsSync(copy)) return { dir: copy, copy: true, fresh: false }
    const own = join(o.root, 'profiles', name)
    const busy = [...desktops.values()].some(x => x !== d && x.chrome !== null && x.profile === name && !x.copy)
    mkdirSync(own, { recursive: true, mode: 0o700 })
    if (!busy) return { dir: own, copy: false, fresh: false }
    rmSync(copy, { recursive: true, force: true })
    await cp(own, copy, { recursive: true, filter: src => !NOT_COPIED.test(basename(src)) })
    return { dir: copy, copy: true, fresh: true }
  }

  /** The browser the desktops run: the board's own Chromium (Ubuntu's arm64, where the install put it), else the PATH's. */
  const chromeBin = (): string | null =>
    boardChromium(join(o.root, BOARD_CHROMIUM_DIR), o.arch) ?? CHROME_BINS.map(b => sys.which(b)).find(Boolean) ?? null

  /** What Chrome runs with on `d`'s display. */
  const chromeEnv = (d: Desktop): Record<string, string> => ({
    DISPLAY: `:${d.display}`,
    XAUTHORITY: join(d.dir, 'Xauthority'),
    HOME: process.env.HOME ?? '',
    PATH: `${process.env.PATH ?? ''}:${PATH}`,
    LANG: process.env.LANG || 'C.UTF-8',
  })

  /** The profile folder `d`'s Chrome runs on: the session's own, a named profile's, or its copy. */
  const profileIn = (d: Desktop): string =>
    d.profile === null
      ? join(d.dir, 'profile')
      : d.copy
        ? join(d.dir, `copy-${d.profile}`)
        : join(o.root, 'profiles', d.profile)

  async function launchChrome(d: Desktop): Promise<Started> {
    const bin = chromeBin()
    if (!bin) return { ok: false, error: 'no Google Chrome or Chromium on this server (the install puts it in place)' }
    const name = wanted.get(d.pane) ?? null
    // started again after its stop with the profile it had: its last tabs (in that profile only)
    const back = d.restore
    d.restore = null
    const same = back !== null && back.profile === name
    const p = await profileDir(d, name, same && back.copy)
    d.profile = name
    d.copy = p.copy
    const env = chromeEnv(d)
    rmSync(d.cdp, { force: true })
    const proc = sys.spawnChrome(
      [
        bin,
        ...chromeArgs({
          profileDir: p.dir,
          extra: o.chromeExtra ?? [],
          restore: same && !p.fresh,
          languages: o.languages?.() ?? null,
        }),
      ],
      d.cdp,
      env,
      join(d.dir, 'chrome.log'),
    )
    d.chrome = proc.pid
    // on file at once: a board that ends while it starts leaves it to the next one, not running on unknown
    save()
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
      if (await sys.cdpReady(d.cdp)) {
        d.running = true
        return { ok: true }
      }
      await sys.sleep(250)
    }
    await ended(gone ? null : proc.pid, 2000)
    d.chrome = null
    return { ok: false, error: `Chrome did not start: ${tailOf(join(d.dir, 'chrome.log')) || 'no answer on its pipe'}` }
  }

  async function startNew(pane: string): Promise<Started> {
    // picked one at a time, and held until its desktop is in the list: two starts never share one
    const slot = await serial('slots', async () => {
      const picked = await pickSlot(new Set([...desktops.values()].map(d => d.slot).concat([...picking])), s =>
        sys.displayHeld(slotDisplay(s)),
      )
      if (picked !== null) picking.add(picked)
      return picked
    })
    if (slot === null) return { ok: false, error: 'every desktop is in use on this server' }
    picking.delete(slot)
    const xvncBin = sys.which('Xvnc')
    if (!xvncBin) return { ok: false, error: 'no Xvnc on this server (the install puts TigerVNC in place)' }
    const display = slotDisplay(slot)
    const dir = join(o.root, 'sessions', String(display))
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const d: Desktop = {
      pane,
      key: itemIn(pane)?.key ?? '',
      session: itemIn(pane)?.session ?? '',
      slot,
      display,
      dir,
      vnc: join(dir, 'vnc.sock'),
      cdp: join(dir, 'cdp.sock'),
      profile: null,
      copy: false,
      control: 'agent',
      asks: false,
      ask: '',
      askSince: null,
      xvnc: null,
      chrome: null,
      startedAt: now(),
      running: false,
      goneSince: 0,
      stopping: false,
      unviewedSince: 0,
      usedAt: now(),
      restore: null,
      closing: false,
    }
    desktops.set(pane, d)
    // stopped before (browser_close, idle) while the session went on: its profile folders back in place
    const back = kept.get(pane)
    if (back) {
      kept.delete(pane)
      d.restore = { profile: back.profile, copy: back.copy }
      if (!wanted.has(pane)) wanted.set(pane, back.profile)
      try {
        for (const name of readdirSync(back.dir)) renameSync(join(back.dir, name), join(dir, name))
      } catch (err) {
        o.log(`desktop :${display}: its kept profile did not come back: ${messageOf(err)}`)
      }
      rmSync(back.dir, { recursive: true, force: true })
    }
    const auth = join(dir, 'Xauthority')
    writeFileSync(auth, xauthority(display, randomBytes(16)), { mode: 0o600 })
    const proc = sys.spawn(
      [xvncBin, ...xvncArgs({ display, socket: d.vnc, auth, name: `agent-board ${d.key || pane}` })],
      { HOME: process.env.HOME ?? '', PATH: `${process.env.PATH ?? ''}:${PATH}` },
      join(dir, 'xvnc.log'),
    )
    d.xvnc = proc.pid
    // on file at once, as Chrome is
    save()
    let gone = false
    void proc.exited.then(() => {
      gone = true
      if (d.xvnc !== proc.pid || d.stopping) return
      o.log(`desktop :${display}: Xvnc ended`)
      void stopIf(d, 'its display ended')
    })
    let up = false
    for (let waited = 0; waited < 10_000 && !gone && !up; waited += 100) {
      up = existsSync(d.vnc) && sys.displayHeld(display)
      if (!up) await sys.sleep(100)
    }
    // one started again that fails keeps its profile for the next try
    const fail = async (error: string): Promise<Started> => {
      const again = await teardown(d, !!back)
      desktops.delete(pane)
      if (back && again) kept.set(pane, { ...back, dir: again })
      save()
      return { ok: false, error }
    }
    if (!up) return fail(`Xvnc did not start on :${display}: ${tailOf(join(dir, 'xvnc.log')) || 'no socket'}`)
    const r = await launchChrome(d)
    if (!r.ok) return fail(r.error)
    save()
    o.log(`desktop :${display} for ${d.key || pane}: Chrome up`)
    o.onChange()
    return r
  }

  async function ensureNow(pane: string): Promise<Started> {
    let d = desktops.get(pane)
    // another session in the pane since (/clear, before a refresh saw it): not its browser
    const session = itemIn(pane)?.session ?? ''
    if (d?.session && session && d.session !== session) {
      await stopNow(pane, 'a new session in its pane')
      d = undefined
    }
    const back = kept.get(pane)
    if (back?.session && session && back.session !== session) forget(back, 'a new session in its pane')
    if (d && d.xvnc !== null && sys.alive(d.xvnc)) {
      if (d.chrome !== null && sys.alive(d.chrome) && d.running) return { ok: true }
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

  /**
   * Stopped while the session goes on (browser_close, idle): the card has no browser at once (its
   * views go with the board's word, not an error), Chrome quits as a person quits it, its display
   * ends with it, and the session's profile folders are kept for its next start.
   */
  async function closeNow(pane: string, why: string): Promise<void> {
    const d = desktops.get(pane)
    if (!d) return
    d.closing = true
    o.onChange()
    const dir = await teardown(d, true)
    desktops.delete(pane)
    if (dir)
      kept.set(pane, { pane, key: d.key, session: d.session, dir, profile: d.profile, copy: d.copy, goneSince: 0 })
    save()
    o.log(`desktop :${d.display} for ${d.key || pane} stopped: ${why}; its profile kept for its next start`)
    o.onChange()
  }

  /** A stopped browser's kept profile gone with its session (as a running one's goes), in its pane's turn. */
  function forget(k: Kept, why: string): void {
    if (kept.get(k.pane) !== k) return
    kept.delete(k.pane)
    wanted.delete(k.pane)
    rmSync(k.dir, { recursive: true, force: true })
    save()
    o.log(`desktop for ${k.key || k.pane}: its kept profile removed: ${why}`)
  }

  /** Unused: no call for IDLE_MS, no view of it, the owner not holding it, no ask standing. */
  const idle = (d: Desktop): boolean =>
    !d.stopping && !d.closing && d.control === 'agent' && !d.asks && !watched(d.pane) && now() - d.usedAt >= idleMs
  const idleFor = idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)} min` : `${Math.round(idleMs / 1000)} s`
  /** `d` stopped as idle, when it still is in its pane's turn (a call may have come meanwhile). */
  const idleStop = (d: Desktop): Promise<void> =>
    serial(d.pane, async () => {
      if (desktops.get(d.pane) === d && idle(d))
        await closeNow(d.pane, `no browser call for ${idleFor}, no view of it, no ask standing`)
    })

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
  /** `d` stopped, when it is still the pane's desktop by then (not one started since). */
  const stopIf = (d: Desktop, why: string): Promise<void> =>
    serial(d.pane, async () => {
      if (desktops.get(d.pane) === d) await stopNow(d.pane, why)
    })

  /**
   * The agent's DevTools to its Chrome's holder: each message a text frame one way, NUL-ended the
   * other. Messages wait in order while the WebSocket has much queued (and the socket pauses):
   * past Bun's limit a send is dropped, and a CDP message lost is a call that never ends.
   */
  function openCdp(ws: ServerWebSocket<VncData>): void {
    const sock = createConnection({ path: ws.data.socket })
    const frames = nulFrames()
    const waiting: string[] = []
    const flush = (): void => {
      while (waiting.length && ws.getBufferedAmount() <= HIGH_WATER) ws.send(waiting.shift() as string)
      if (waiting.length) sock.pause()
      else sock.resume()
    }
    sock.on('data', (chunk: Buffer) => {
      waiting.push(...frames(chunk))
      flush()
    })
    sock.on('error', () => ws.close(1011, 'cdp'))
    sock.on('close', () => ws.close(1000, 'cdp'))
    cdps.set(ws, { sock, flush })
  }

  /**
   * A view's video: its desktop's encoder's frames to it (started for it where none runs), until
   * it closes, its login ends or the desktop stops. Control is not the video's: it goes with the
   * view's VNC connection, which carries the input.
   */
  function openVideo(ws: ServerWebSocket<VncData>): void {
    const d = desktops.get(ws.data.pane)
    if (!d || d.stopping || d.closing || d.xvnc === null) {
      ws.close(1001, 'stopped')
      return
    }
    if (!video.available()) {
      ws.close(VIDEO_NONE, 'no ffmpeg')
      return
    }
    const viewer: VideoViewer = {
      send: bytes => ws.send(bytes),
      close: (code, reason) => ws.close(code, reason),
    }
    const unwatch = ws.data.watch?.(() => ws.close(4001, 'login')) ?? (() => {})
    watchers.set(ws, { viewer, unwatch })
    const set = videos.get(d.pane) ?? new Set()
    set.add(ws)
    videos.set(d.pane, set)
    video.join(
      { pane: d.pane, display: d.display, auth: join(d.dir, 'Xauthority'), log: join(d.dir, 'video.log') },
      viewer,
    )
  }

  function closeVideo(ws: ServerWebSocket<VncData>): void {
    const w = watchers.get(ws)
    watchers.delete(ws)
    if (!w) return
    w.unwatch()
    video.leave(ws.data.pane, w.viewer)
    const set = videos.get(ws.data.pane)
    set?.delete(ws)
    if (!set?.size) videos.delete(ws.data.pane)
    // the idle clock from the last view on
    touch(ws.data.pane)
  }

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
    touch(ws.data.pane)
    if (set?.size) return
    viewers.delete(ws.data.pane)
    const d = desktops.get(ws.data.pane)
    if (d?.control !== 'owner' || d.stopping) return
    d.control = 'agent'
    handedBack(d, d.key || itemIn(d.pane)?.key || '')
    save()
    o.log(`desktop :${d.display} for ${d.key || d.pane}: back to the agent (the owner's view closed)`)
    o.onChange()
  }

  /**
   * The owner's control is over (handed back, its view gone, no view of it a while) while the
   * agent's ask stands: what it asked is done, its card's ask too (the browser's own only), and the
   * agent is told so by a board reminder, which wakes it or goes into its turn. An ask that ended
   * another way meanwhile ("No reply needed", `board doing`, another ask) wakes nobody; what the user
   * writes does not end it (entrypoints/hook.ts, the card's askBrowser).
   */
  function handedBack(d: Desktop, key: string): void {
    if (!d.asks) return
    const ask = d.ask
    const ours = !!key && cardAsks(key, d)
    d.asks = false
    d.ask = ''
    if (!ours) return
    o.writeCard(key, { ask: '', askSince: '', askBrowser: '' })
    const item = o.items().find(i => i.key === key)
    if (!item) return
    try {
      o.remind(item, handedBackText(ask))
    } catch (err) {
      o.log(`desktop :${d.display} for ${key}: the hand-back's reminder: ${messageOf(err)}`)
    }
  }

  return {
    view(item) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping || d.closing) return undefined
      return desktopView(d, d.askSince !== null && (item.askSince === d.askSince || asksInTurn(item.status, d)))
    },

    card(item) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping || d.closing || !asksInTurn(item.status, d)) return {}
      return { column: 'me', attention: 'ask', question: d.ask, askSince: d.askSince }
    },

    observe(items) {
      let changed = false
      for (const d of desktops.values()) {
        const item = items.find(i => i.pane === d.pane && !i.sleeping)
        if (item && d.session && item.session && item.session !== d.session) {
          void stopIf(d, 'a new session in its pane')
          continue
        }
        if (item) {
          d.goneSince = 0
          d.key = item.key
          if (!d.session && item.session) {
            d.session = item.session
            changed = true
          }
          // its card asks no more, or asks something else: "No reply needed", or the agent moved on
          // (`board doing`, another ask); the agent working on meanwhile is not that
          if (d.asks && !cardAsks(item.key, d)) {
            d.asks = false
            d.ask = ''
            changed = true
          }
        } else {
          d.goneSince ||= now()
          if (now() - d.goneSince >= GONE_MS) {
            const asleep = items.some(i => i.pane === d.pane && i.sleeping)
            void stopIf(d, asleep ? 'the session sleeps' : 'the session ended')
          }
        }
        // the owner has it and no view is connected (its close never came): back to the agent a while later
        if (d.control === 'owner' && !viewed(d.pane)) {
          d.unviewedSince ||= now()
          if (now() - d.unviewedSince >= UNVIEWED_MS) {
            d.control = 'agent'
            d.unviewedSince = 0
            handedBack(d, d.key)
            o.log(`desktop :${d.display} for ${d.key || d.pane}: back to the agent (no view of the owner's)`)
            changed = true
          }
        } else d.unviewedSince = 0
        if (d.chrome !== null && !d.stopping && !sys.alive(d.chrome)) {
          d.chrome = null
          d.running = false
          changed = true
        }
        // only while needed: unused a while (no call, no view, the owner not holding it, no ask), it stops
        if (item && !d.stopping && !d.closing) {
          if (d.control === 'owner' || d.asks || watched(d.pane)) d.usedAt = now()
          else if (idle(d)) void idleStop(d)
        }
      }
      // the browsers stopped while their sessions go on: a kept profile goes when its session does
      for (const k of kept.values()) {
        const item = items.find(i => i.pane === k.pane && !i.sleeping)
        if (item && k.session && item.session && item.session !== k.session) {
          void serial(k.pane, async () => forget(k, 'a new session in its pane'))
          continue
        }
        if (item) {
          k.goneSince = 0
          k.key = item.key
          if (!k.session && item.session) k.session = item.session
          continue
        }
        k.goneSince ||= now()
        if (now() - k.goneSince < GONE_MS) continue
        const asleep = items.some(i => i.pane === k.pane && i.sleeping)
        void serial(k.pane, async () => forget(k, asleep ? 'the session sleeps' : 'the session ended'))
      }
      if (changed) {
        save()
        o.onChange()
      }
    },

    ensure: pane => {
      touch(pane)
      return serial(pane, async () => {
        const r = await ensureNow(pane)
        touch(pane)
        return r
      })
    },

    cdpOf(pane) {
      const d = desktops.get(pane)
      return d?.running && d.chrome !== null && existsSync(d.cdp) ? d.cdp : null
    },

    profile: (pane, name) =>
      serial(pane, async () => {
        touch(pane)
        // a switch restarts the browser under the owner's hands: never while they have it
        if (desktops.get(pane)?.control === 'owner')
          return { ok: false, error: 'the owner has the browser now: no profile switch until they hand it back' }
        wanted.set(pane, name)
        const d = desktops.get(pane)
        if (!d || d.chrome === null)
          return ensureNow(pane).then(r => (r.ok ? { ...r, copy: desktops.get(pane)?.copy ?? false } : r))
        if (d.profile === name && !d.copy) return { ok: true, copy: false }
        d.stopping = true
        await quitChrome(d)
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

    close: pane =>
      serial(pane, async () => {
        const d = desktops.get(pane)
        if (!d) return { ok: true, closed: false }
        // another session's in the pane (/clear, before a refresh saw it): stopped as such, nothing kept
        const session = itemIn(pane)?.session ?? ''
        if (d.session && session && d.session !== session) {
          await stopNow(pane, 'a new session in its pane')
          return { ok: true, closed: false }
        }
        if (d.control === 'owner')
          return { ok: false, error: 'the owner has your browser now: it stays open until they hand it back' }
        if (d.asks)
          return {
            ok: false,
            error: 'your ask to the owner stands (browser_ask_owner): your browser stays open until they hand it back',
          }
        await closeNow(pane, 'the agent closed it (browser_close)')
        return { ok: true, closed: true }
      }),

    async ask(pane, text) {
      const item = itemIn(pane)
      if (!item) return { ok: false, error: 'this session is not on the board' }
      const r = await serial(pane, () => ensureNow(pane))
      if (!r.ok) return r
      touch(pane)
      const since = now()
      o.writeCard(item.key, { ask: text, askSince: since, askBrowser: since, by: 'agent' })
      const d = desktops.get(pane)
      if (d) {
        d.asks = true
        d.ask = text
        d.askSince = since
        save()
      }
      o.onChange()
      return r
    },

    open: (pane, url) =>
      serial(pane, async () => {
        if (!itemIn(pane)) return { ok: false, error: 'this session is not on the board' }
        touch(pane)
        // a tab of its own in front: never under the owner's hands
        if (desktops.get(pane)?.control === 'owner')
          return {
            ok: false,
            error: 'the owner has your browser now: nothing opened; try again once they hand it back',
          }
        const r = await ensureNow(pane)
        if (!r.ok) return r
        touch(pane)
        const d = desktops.get(pane)
        const bin = chromeBin()
        if (!d || !bin || !sys.relay) return { ok: false, error: 'no browser to open it in on this server' }
        // Chrome on the same profile hands the address to the running one: no DevTools client of the agent's is kicked
        if (!(await sys.relay([bin, `--user-data-dir=${profileIn(d)}`, url], chromeEnv(d), RELAY_MS)))
          return { ok: false, error: 'the browser did not take the address' }
        o.log(`desktop :${d.display} for ${d.key || pane}: opened a page of ${new URL(url).host}`)
        return { ok: true }
      }),

    display: pane =>
      serial(pane, async () => {
        if (!itemIn(pane)) return { ok: false, error: 'this session is not on the board' }
        touch(pane)
        const r = await ensureNow(pane)
        touch(pane)
        if (!r.ok) return r
        const d = desktops.get(pane)
        if (!d) return { ok: false, error: 'no desktop' }
        return { ok: true, display: d.display, xauthority: join(d.dir, 'Xauthority') }
      }),

    // the wrapper asks before each of the agent's calls: its browser is used now
    control: pane => {
      touch(pane)
      return desktops.get(pane)?.control ?? 'agent'
    },

    asks: pane => !!desktops.get(pane)?.asks,

    setControl(item, to) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping || d.closing) return { ok: false, status: 404, error: 'no desktop' }
      if (d.control === to) return { ok: true, control: to }
      // taken only where it is seen: a view of it connected, which hands it back when it closes
      if (to === 'owner' && !viewed(d.pane))
        return { ok: false, status: 409, error: 'open the browser’s view first: control goes with a view of it' }
      d.control = to
      d.unviewedSince = 0
      // handed back: what the agent asked is done (its own ask only: a later `board ask` stays), and it is told
      if (to === 'agent') handedBack(d, item.key)
      save()
      o.log(`desktop :${d.display} for ${item.key}: ${to === 'owner' ? 'the owner has it' : 'back to the agent'}`)
      o.onChange()
      return { ok: true, control: to }
    },

    vncOf(item) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping || d.closing || d.xvnc === null || !existsSync(d.vnc)) return null
      return { pane: d.pane, socket: d.vnc }
    },

    videoOf(item) {
      const d = item.pane ? desktops.get(item.pane) : undefined
      if (!d || item.sleeping || d.closing || d.xvnc === null || !existsSync(d.vnc)) return null
      return video.available() ? { pane: d.pane } : 'none'
    },

    stop,

    // server mode off: the running ones stopped, and the stopped ones' kept profiles gone with them
    async stopAll() {
      await Promise.all([
        ...[...desktops.keys()].map(pane => stop(pane, 'the board stopped them')),
        ...[...kept.values()].map(k => serial(k.pane, async () => forget(k, 'the board stopped them'))),
      ])
    },

    websocket: {
      // Not compressed again: the picture comes compressed from Xvnc (Tight: zlib and JPEG). (On,
      // it did nothing either: Bun deflates only what is sent asking for it.) Each piece goes on
      // as it comes, the socket paused while much waits; Xvnc paces itself by the viewer's fences.
      perMessageDeflate: false,
      open(ws) {
        if (ws.data.cdp) return openCdp(ws)
        if (ws.data.video) return openVideo(ws)
        const sock = createConnection({ path: ws.data.socket })
        sock.on('connect', () => {
          const c = conns.get(ws)
          if (c) c.up = true
        })
        sock.on('data', chunk => {
          ws.send(chunk)
          if (ws.getBufferedAmount() > HIGH_WATER) sock.pause()
        })
        sock.on('error', () => ws.close(1011, 'vnc'))
        sock.on('close', () => {
          const c = conns.get(ws)
          if (c) c.up = false
          ws.close(1000, 'vnc')
        })
        const unwatch = ws.data.watch?.(() => ws.close(4001, 'login')) ?? (() => {})
        conns.set(ws, { sock, unwatch, up: false, filter: rfbInputFilter() })
        const set = viewers.get(ws.data.pane) ?? new Set()
        set.add(ws)
        viewers.set(ws.data.pane, set)
        const d = desktops.get(ws.data.pane)
        touch(ws.data.pane)
        if (d && !d.stopping) void keymapOf(d)
      },
      // keys, the mouse and the clipboard reach the display only while the owner has the browser
      message(ws, msg) {
        if (ws.data.cdp) {
          cdps.get(ws)?.sock.write(`${typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8')}\0`)
          return
        }
        if (ws.data.video) {
          const w = watchers.get(ws)
          if (w && typeof msg === 'string') video.message(ws.data.pane, w.viewer, msg)
          return
        }
        const c = conns.get(ws)
        if (!c) return
        const bytes = typeof msg === 'string' ? Buffer.from(msg) : msg
        const out = c.filter(bytes, desktops.get(ws.data.pane)?.control === 'owner')
        if (out === null) return ws.close(1008, 'rfb')
        if (out.length) c.sock.write(out)
      },
      drain(ws) {
        if (ws.data.cdp) cdps.get(ws)?.flush()
        else if (!ws.data.video) conns.get(ws)?.sock.resume()
      },
      close(ws) {
        if (ws.data.video) return closeVideo(ws)
        if (!ws.data.cdp) return closeViewer(ws)
        cdps.get(ws)?.sock.destroy()
        cdps.delete(ws)
      },
    },
  }
}
