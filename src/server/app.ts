// The web board: a small HTTP server (Bun.serve) on 127.0.0.1 that serves web/, the board's data
// and live updates (Server-Sent Events), and takes the same actions as the terminal board.
// Runs inside the terminal board's process (entrypoints/tui.ts); `bun src/entrypoints/server.ts` runs it alone.
//
// Only loopback, only the Host it was asked for, and every POST needs an X-Board header: a page
// on another site cannot send that without a CORS preflight, which this server never grants, so
// it cannot type into a session.
import { randomBytes } from 'node:crypto'
import { type FSWatcher, mkdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { saveFoundProfiles } from '../adapters/config-file.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { omarchyTheme } from '../adapters/omarchy.ts'
import { ownFileCheck } from '../adapters/own-files.ts'
import { archiveDir, cardsDir, ROOT, scheduleDir } from '../adapters/paths.ts'
import { fetchProbe, PROBE_TIMEOUT_MS, probeOrigin, probeOriginAt } from '../adapters/probe.ts'
import { inheritedProfileDir } from '../adapters/profiles.ts'
import {
  endLogins,
  endStraySsh,
  hostKeyFingerprint,
  hostKeyPinned,
  keyPath,
  knownHostsFile,
  knownHostsReady,
  publicKeyOf,
  readPidRecord,
  spawnRemote,
  spawnSsh,
  sshBin,
  sshVersion,
  writePidRecord,
} from '../adapters/ssh.ts'
import { messageGate } from '../core/message-gate.ts'
import { pageWithLook } from '../core/omarchy-theme.ts'
import type { Observation } from '../core/presence.ts'
import { shownProfiles } from '../core/profiles.ts'
import { pwaPage } from '../core/pwa.ts'
import type { SetupFacts } from '../core/setup.ts'
import { boardPorts, forwardSpec, publicHosts, sshArgs, tunnelConfig, tunnelProblems } from '../core/tunnel.ts'
import { createAccess } from '../services/access.ts'
import type { Deps } from '../services/deps.ts'
import { createLaunches } from '../services/launch/launches.ts'
import { mokupilotCheck } from '../services/mokupilot.ts'
import { createPresence } from '../services/presence.ts'
import { editProfile, installProfile, wakeHooksInPlace } from '../services/profiles.ts'
import { createRemote } from '../services/remote.ts'
import { createRemoteAccess } from '../services/remote-access.ts'
import { startScheduler } from '../services/scheduler.ts'
import { createServerSetup } from '../services/server-setup.ts'
import { createSetupChecks } from '../services/setup-check.ts'
import { createTerminals, terminalOn } from '../services/terminals.ts'
import { createProbes, createSupervisor, networkSignature, realClock, type TunnelPlan } from '../services/tunnel.ts'
import { createWakeControl, startWakeStart } from '../services/wake/control.ts'
import { createBoardState } from './board-state.ts'
import { dispatch, json, peerOf, type Route } from './http.ts'
import { createRemoteListener } from './remote.ts'
import { accessRoutes } from './routes/access.ts'
import { archiveRoutes } from './routes/archive.ts'
import { boardRoutes } from './routes/board.ts'
import { fsRoutes } from './routes/fs.ts'
import { launchRoutes } from './routes/launch.ts'
import { mokupilotRoutes } from './routes/mokupilot.ts'
import { pageLogRoute } from './routes/page-log.ts'
import { presenceRoutes } from './routes/presence.ts'
import { remoteRoutes } from './routes/remote.ts'
import { revealRoute, revealState } from './routes/reveal.ts'
import { scheduleRoute } from './routes/schedule.ts'
import { sessionRoutes } from './routes/session.ts'
import { categoriesRoute, profilesRoute, settingsRoute } from './routes/settings.ts'
import { setupRoute } from './routes/setup.ts'
import { sleepRoute } from './routes/sleep.ts'
import { staticRoute } from './routes/static.ts'
import { terminalRoute } from './routes/terminal.ts'
import { wakeRoutes } from './routes/wake.ts'
import { createBroadcaster } from './sse.ts'
import { createTunnelListener } from './tunnel.ts'
import { openProbeListener } from './tunnel-probe.ts'
import { pruneUploads, uploadRoutes } from './uploads.ts'
import { VIEWER_COPIES, viewerDirs, viewerEntries, WORKER_POLICIES } from './viewers.ts'
import { createWebBundle } from './web-bundle.ts'

const WEB = join(ROOT, 'web')
/** The plugin's version, for /api/hello. */
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
})()

export interface BoardServer {
  port: number
  url: string
  /** The route table, in its order (the tests check every route against the tunnel listener). */
  routes: readonly Route[]
  refresh(): Promise<void>
  close(): Promise<void>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A plan's or a run's id on the server: when (UTC) and a little chance, `20261021-100400-3f9a`. */
const setupId = (): string =>
  `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(2).toString('hex')}`

/**
 * A folder watched with a debounce. An error (a deleted folder on Windows: EPERM), unhandled,
 * would end the board: it is logged and ends the watch instead; the poll goes on.
 */
function watchFolder(dir: string, ms: number, onChange: () => void, log: Deps['log'], recursive = false) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, { recursive }, () => {
      clearTimeout(timer)
      timer = setTimeout(onChange, ms)
    })
    watcher.on('error', err => {
      log(`watch ${dir}: ${err.message}`)
      watcher?.close()
    })
  } catch {}
  return {
    close() {
      clearTimeout(timer)
      watcher?.close()
    },
  }
}

/** The board goes out for changes of Remote access at most this often (see accessChanged). */
export const ACCESS_PUBLISH_MS = 1000

/**
 * `fn` at most once every `ms`: a call in a quiet time runs it at once; the calls during the
 * window after it run it once more at the window's end, which opens another.
 */
function atMostEvery(ms: number, fn: () => void): { call(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let again = false
  const windowEnds = (): void => {
    timer = undefined
    if (!again) return
    again = false
    fn()
    timer = setTimeout(windowEnds, ms)
  }
  return {
    call() {
      if (timer) {
        again = true
        return
      }
      fn()
      timer = setTimeout(windowEnds, ms)
    },
    cancel() {
      clearTimeout(timer)
      timer = undefined
      again = false
    },
  }
}

export interface ServerOptions {
  deps: Deps
  port?: number
  /** What the setup check reads of this computer (services/setup-check.ts; tests hand in their own). */
  gather?: () => Promise<SetupFacts>
  /** Starts wake's start (entrypoints/wake-start.ts, with `--again` for Start again); tests hand in a recorder. */
  wakeStarter?: (args?: string[]) => void
  /** What presence detection asks the computer (adapters/idle.ts); tests hand in their own. */
  presenceObserve?: () => Promise<Observation>
  /** How often detection asks (30 s); tests ask sooner. */
  presenceIntervalMs?: number
}

/** `deps.cfg` is the live config (liveConfig): call the returned refresh from its onChange. */
export async function startServer({
  deps,
  port: asked,
  gather,
  wakeStarter,
  presenceObserve,
  presenceIntervalMs,
}: ServerOptions): Promise<BoardServer> {
  const { cfg, log } = deps
  // Validate before starting a scheduler or changing any state.
  const cards = cardsDir()
  const port = asked ?? Number(cfg.port ?? 12422)
  pruneUploads(Number(cfg.keepUploadsDays ?? 14))
  // The profile folders found on this computer that config.json does not list yet go into it,
  // hidden, but for the default one and the one this board's own env points to.
  try {
    saveFoundProfiles(inheritedProfileDir())
  } catch (err) {
    log(`profiles: ${messageOf(err)}`)
  }
  // The React page (web/src/main.tsx) is bundled in memory (Bun.build) and served as /app.js, with
  // what it runs before it paints (web/src/theme.ts) as /theme.js; their version, with the page's
  // other files, tells open pages to reload. The quick look's viewers are bundled apart, for the
  // page to import when it opens such a file (server/viewers.ts).
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(WEB, 'src', 'main.tsx'),
    early: join(WEB, 'src', 'theme.ts'),
    viewers: viewerEntries(WEB),
    copies: VIEWER_COPIES,
    log,
  })
  const viewerExtras = { dirs: viewerDirs(ROOT), policies: WORKER_POLICIES }
  // Sessions started from the board (services/launch): their progress goes out with the board.
  const launches = createLaunches({ deps, onChange: () => board.publish() })
  // The terminal (services/terminals.ts): shells the board opened in sessions' folders, and live panes.
  const terminals = createTerminals({ onChange: () => board.publish() })
  // What of the board is not set up on this computer, for the page's quiet note.
  const setup = createSetupChecks({ deps, onChange: () => board.publish(), ...(gather && { gather }) })
  // Whether MokuPilot is here for calls with a fork of a session: looked up again when its
  // setting changes, and once a minute for one installed or removed meanwhile.
  const mokupilot = mokupilotCheck(cfg)
  // Side questions to a session go as Claude Code's /btw in its pane: nothing to look up here.
  const aside = () => true
  // A notification click asks for a session: pages that connect right after are told it too.
  const reveals = revealState()
  const events = createBroadcaster(() => board.payload(), { greet: reveals.greet })
  // The remote mode (core/remote.ts): pairing, and the listener on the Tailscale address while it
  // is on. Off, it reads the config and nothing else.
  const remote = createRemote({ onChange: () => board.publish() })
  // Sleep and wake (#119): its state line, the panel's switches, and starting wake when it is on but
  // not running. Off, with no wake file, it asks nothing and starts nothing.
  const wake = createWakeControl({
    cfg,
    starter: wakeStarter ?? startWakeStart,
    asleep: () => board.items().filter(i => i.sleeping).length,
    hooks: () =>
      shownProfiles(deps.profiles().list).map(p => ({ id: p.id, title: p.title, state: wakeHooksInPlace(p.dir) })),
    onChange: () => board.publish(),
    // "Setup incomplete" follows wake's state (held, not running, running) at once, not at the next
    // check in up to 10 minutes.
    onState: () => void setup.again().catch(err => log(`setup check: ${messageOf(err)}`)),
    log,
  })
  const routes: Route[] = []
  const guards = { port, token: FILE_TOKEN, stale: () => board.stale() }
  // Omarchy here: the Terminal style takes the colors of its theme on now, and follows a switch.
  const omarchy = omarchyTheme(() => board.publish())
  // The page as config.json's `look` and Omarchy have it (core/omarchy-theme.ts); else as it is.
  const page = (html: string): string => pageWithLook(html, { look: cfg.look, omarchy: !!omarchy })
  // The page for a phone's browser through `tailscale serve`, while remote.pwa is on, and through
  // the owner's domain: marked remote, with what installs it.
  const remotePage = staticRoute(WEB, bundle, html => pwaPage(page(html), bundle.version()), viewerExtras)
  const listener = createRemoteListener({
    cfg,
    webPort: port,
    version: PLUGIN_VERSION,
    routes,
    guards,
    page: remotePage,
    remote,
    log,
    onChange: () => board.publish(),
  })
  // The board through the owner's domain (core/tunnel.ts): the login (services/access.ts), the
  // nonces the board's probe answers, and the tunnel listener on 127.0.0.1 while the tunnel is on
  // and the login set up. Off, it reads the config and nothing else.
  //
  // The Remote access view's revision (the payload's accessRev): a change of the login, of the
  // tunnel's status or of its settings counts one, and the board goes out again; the panel then
  // fetches the view, which never goes out with the board. Anyone on the internet can make such a
  // change (a failed sign-in is recorded): the board goes out for them at most once a window, at
  // the first change and then at the window's end with the latest revision.
  let accessRev = 0
  const accessOut = atMostEvery(ACCESS_PUBLISH_MS, () => board.publish())
  const accessChanged = (): void => {
    accessRev += 1
    accessOut.call()
  }
  const access = createAccess({
    onChange: () => {
      accessChanged()
      void tunnel.sync().then(() => supervisor.sync())
    },
    log,
  })
  const probes = createProbes()
  const tunnel = createTunnelListener({
    cfg,
    webPort: port,
    routes,
    guards,
    page: remotePage,
    access,
    probes,
    ownFiles: ownFileCheck(cfg),
    log,
    onChange: () => {
      accessChanged()
      void supervisor.sync()
    },
  })
  // The tunnel's ssh (services/tunnel.ts). It starts nothing until this board holds the web port
  // (below). Its line goes to the tunnel listener's port while that listens, the tunnel is on and
  // the settings check out: checked here too, since the listener follows a config change a moment
  // later, and a hand edit that fails its checks must never reach ssh meanwhile.
  const tunnelConf = () => tunnelConfig(cfg.tunnel)
  const lineTo = (target: number): TunnelPlan | null => {
    const conf = tunnelConf()
    if (tunnelProblems(conf, boardPorts(cfg.remote, port)).length) return null
    return {
      conf,
      // No ssh found: this one fails to start, which shows as noSsh.
      bin: sshBin() ?? 'ssh',
      args: sshArgs({ conf, key: keyPath(conf), knownHosts: knownHostsFile(), target }),
      forward: forwardSpec(conf.socket, target),
    }
  }
  const supervisor = createSupervisor({
    plan: () => {
      const at = tunnel.listening()
      return at !== null && tunnelConf().on ? lineTo(at) : null
    },
    spawn: spawnSsh,
    stray: { read: readPidRecord, write: writePidRecord, end: endStraySsh },
    clock: realClock,
    network: networkSignature,
    probes,
    // with a port, a Test that finds the public port ("Do it myself"): sent with the Host the
    // tunnel listener takes now, whichever port it came through
    probe: (nonce, port) =>
      port === undefined
        ? fetchProbe(probeOrigin(tunnelConf()), nonce)
        : fetchProbe(probeOriginAt(tunnelConf(), port), nonce, PROBE_TIMEOUT_MS, publicHosts(tunnelConf())[0]),
    // Test's own line, whether the tunnel is on or not.
    testPlan: lineTo,
    checkKey: () => publicKeyOf(keyPath(tunnelConf())),
    sshFound: () => sshBin(),
    openProbeListener,
    onChange: accessChanged,
    log,
  })
  // Setting up the server's web server through the owner's admin connection (services/server-setup.ts):
  // the tunnel's ssh binary, host and pinned key; a test CA for the board's Caddy only when both
  // test-only variables name one.
  const acmeCa = process.env.BOARD_SETUP_ACME_CA
  const acmeRoot = process.env.BOARD_SETUP_ACME_CA_ROOT
  const serverSetup = createServerSetup({
    cfg,
    webPort: port,
    ssh: () => sshBin(),
    sshVersion,
    knownHosts: knownHostsReady,
    hostKeyPinned: () => {
      const conf = tunnelConf()
      return hostKeyPinned(conf.host, conf.sshPort)
    },
    hostKeyFingerprint: () => {
      const conf = tunnelConf()
      return hostKeyFingerprint(conf.host, conf.sshPort)
    },
    spawn: spawnRemote,
    test: () => supervisor.test(),
    onChange: accessChanged,
    log,
    now: () => Date.now(),
    newId: setupId,
    ...(acmeCa && acmeRoot && { acme: { ca: acmeCa, root: acmeRoot } }),
    // the tunnel key's public half, which Apply puts in place on the server (none before Generate key)
    publicKey: async () => {
      const r = await publicKeyOf(keyPath(tunnelConf()))
      return r.ok ? r.publicKey : null
    },
    // the panel's own On and Off, so a refusal (no login set up) is the button's
    tunnel: async on => {
      if (tunnelConf().on !== on) await remoteAccess.op({ op: on ? 'on' : 'off' })
    },
  })
  // The "Remote access…" panel's view and changes (/api/access, the local board's only).
  const remoteAccess = createRemoteAccess({
    cfg,
    webPort: port,
    access,
    supervisor,
    tunnel,
    onChange: accessChanged,
    server: serverSetup,
  })
  // The user's presence (#172): nothing is read, asked or shown while config.json has no `presence`.
  const presence = createPresence({
    cfg,
    log,
    ...(presenceObserve && { observe: presenceObserve }),
    ...(presenceIntervalMs && { intervalMs: presenceIntervalMs }),
    onChange: () => board.publish(),
    sessions: () => board.items().map(i => i.key),
  })
  const board = createBoardState({
    deps,
    launches,
    terminals,
    version: bundle.version,
    push: payload => events.send(payload),
    setup: setup.summary,
    wake: wake.current,
    mokupilot,
    remote: listener.view,
    aside,
    accessRev: () => accessRev,
    ...(omarchy && { omarchy: omarchy.stamp }),
    presence: presence.view,
  })
  board.publish()
  const refresh = (): void => void board.refresh()
  // After Install from the Profiles panel, and the install a show runs: the panel's note and "Setup
  // incomplete" follow at once, not at the next refresh and the next check in up to 10 minutes;
  // also when only herdr's own hook failed, after the board's went in.
  const installed = (): void => {
    board.publish()
    setup.again().catch(err => log(`setup check: ${messageOf(err)}`))
  }

  // The order of main's `if` chain: the first route that answers wins.
  routes.push(
    setupRoute(setup),
    ...remoteRoutes(listener, remote, cfg, port),
    ...accessRoutes(remoteAccess),
    ...boardRoutes(board, events),
    ...fsRoutes(),
    ...uploadRoutes(),
    revealRoute(board, events, reveals),
    settingsRoute(),
    // Settings → MokuPilot…: where a call starts, here or on the viewer's computer.
    ...mokupilotRoutes(cfg),
    // The user's presence: read, switched and set (the page, the phone, the Android app).
    ...presenceRoutes(presence),
    // A line from the page for this log (a phone's browser says what it could not do there).
    pageLogRoute(log),
    scheduleRoute(refresh),
    // Several sessions put to sleep at once, for agents (services/sleep.ts).
    sleepRoute({ deps, items: board.items, refresh }),
    // Settings → Sleep and wake… (services/wake/control.ts), for this computer only.
    ...wakeRoutes(wake),
    // The archive: its list, and archiving, bringing back or removing sessions (services/archive.ts).
    ...archiveRoutes({ deps, launches, items: board.items, find: board.find, refresh }),
    categoriesRoute(),
    // The Profiles panel: Install, and its edits, a show installing too (services/profiles.ts).
    profilesRoute(
      async id => {
        const done = await installProfile(deps, id)
        installed()
        return done
      },
      body => editProfile(body, installed),
    ),
    ...launchRoutes(launches, board.items),
    terminalRoute({ cfg, terminals, find: board.find, publish: board.publish }),
    ...sessionRoutes({
      deps,
      launches,
      find: board.find,
      items: board.items,
      refresh,
      gate: messageGate(),
      answering: new Set(),
    }),
    // The Omarchy theme's colors for the Terminal style, on a computer with Omarchy.
    {
      method: 'GET',
      path: '/omarchy-theme.css',
      handle: () => {
        const css = omarchy?.css()
        if (!css) return json(404, { error: 'not found' })
        return new Response(css, {
          headers: {
            'content-type': 'text/css; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
    staticRoute(WEB, bundle, page, viewerExtras),
  )
  const host = new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`)
  const ownOrigin = (req: Request): boolean => {
    const origin = req.headers.get('origin')
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
  }

  async function answer(req: Request, srv?: ReturnType<typeof Bun.serve>): Promise<Response> {
    // The header first: with an empty, invalid or missing Host, Bun's req.url is a bare path.
    if (!host.test(req.headers.get('host') ?? '')) return json(403, { error: 'host' })
    let url: URL | undefined
    try {
      url = new URL(req.url)
      const path = decodeURIComponent(url.pathname)
      // Something done on this board's own page is the user at the computer (presence's "back");
      // the CLI and agents send no Origin, and the presence switch itself says what it says.
      if (req.method !== 'GET' && path.startsWith('/api/') && path !== '/api/presence' && ownOrigin(req))
        presence.touch()
      return await dispatch(routes, req, url, path, guards, () => peerOf(srv, req))
    } catch (err) {
      // The path only: a query can carry the page's token.
      log(`${req.method} ${url ? url.pathname : req.url.split('?')[0]}: ${messageOf(err)}`)
      return json(500, { error: messageOf(err) })
    }
  }

  // No idle timeout: answers that drive a session can take longer than Bun's default 10 s, and the
  // event stream is quiet between pings (main's node:http had none either). Not development: a
  // throw that got past answer() must never serve Bun's error page with the source and the cwd.
  // No port reuse: without development Bun reuses the port by default, and a second board on it
  // would start too (two schedulers) instead of failing with EADDRINUSE as on main.
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      development: false,
      reusePort: false,
      fetch: answer,
    })
  } catch (err) {
    // The port is taken (EADDRINUSE, which the terminal board retries): nothing may keep running.
    // The tunnel is the web port's board's: this one never listens for it, and never touches its
    // ssh (the supervisor, which started nothing, is left alone: closing it would end the
    // recorded ssh, the other board's).
    accessOut.cancel()
    events.close()
    void tunnel.close()
    throw err
  }
  // The tunnel is this board's now. Its ssh dies with it, also on an exit that skips close():
  // run.ts restarts the board by process.exit(75).
  process.on('exit', supervisor.killNow)
  // A login by password's ssh runs in a session of its own: ended with the board too.
  process.on('exit', endLogins)

  const poll = setInterval(refresh, Math.max(1, cfg.refreshSec ?? 2) * 1000)
  const watchers = [
    watchFolder(cards, 150, refresh, log),
    // Entries added or cancelled by agents (`board remind`), and runs the scheduler made.
    watchFolder(scheduleDir(), 150, refresh, log),
    // Sessions an agent put in the archive (`board archive`), whose cards go at once.
    watchFolder(archiveDir(), 150, refresh, log),
    // A change to the page: build it again; the new version makes open pages reload.
    watchFolder(WEB, 200, () => void bundle.rebuild().then(refresh), log, true),
  ]
  refresh()
  // The port makes it one board per machine, so one scheduler; claims cover an overlap.
  const scheduler = startScheduler({ deps, onChange: refresh })
  // Shells a board before this one opened and that are gone by now are forgotten.
  if (terminalOn(cfg)) void terminals.prune()
  setup.start()
  void listener.sync()
  // The listener first: ssh forwards to it, so it starts only once that listens (a stray ssh a
  // board before left is ended first).
  void tunnel.sync().then(() => supervisor.sync())
  // Wake on but not running (its startup entry did not run, or it ended): started once.
  void wake.ensure()
  presence.start()

  // What the Remote access view reads of config.json, and the tunnel's own settings in it, as of
  // the last config change.
  const viewConfig = (): string => JSON.stringify([cfg.tunnel ?? null, cfg.remote ?? null, cfg.language])
  const tunnelSettings = (): string => JSON.stringify(cfg.tunnel ?? null)
  let lastView = viewConfig()
  let lastSettings = tunnelSettings()

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    routes,
    // Called when config.json changes, too: the remote mode and the tunnel follow it. The panel
    // fetches its view again when what it reads changed; the tunnel's ssh follows its settings
    // (a new host, say) here, and the listener's port through its onChange.
    async refresh() {
      listener.configChanged()
      tunnel.configChanged()
      const view = viewConfig()
      if (view !== lastView) {
        lastView = view
        accessChanged()
      }
      const settings = tunnelSettings()
      if (settings !== lastSettings) {
        lastSettings = settings
        void supervisor.sync()
      }
      // Turned on in config.json (by hand, or from the panel): started at once.
      wake.configChanged()
      // Presence turned on or off: its sessions marked or unmarked, the board shown again.
      presence.refresh()
      await board.refresh()
    },
    async close() {
      clearInterval(poll)
      for (const watcher of watchers) watcher.close()
      omarchy?.close()
      scheduler.stop()
      wake.stop()
      presence.stop()
      terminals.stopAll()
      setup.stop()
      accessOut.cancel()
      events.close()
      await listener.close()
      // ssh before the listener it forwards to.
      await supervisor.close()
      process.off('exit', supervisor.killNow)
      endLogins()
      process.off('exit', endLogins)
      await tunnel.close()
      await server.stop(true)
    },
  }
}
