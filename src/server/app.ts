// The web board: a small HTTP server (Bun.serve) on 127.0.0.1 that serves web/, the board's data
// and live updates (Server-Sent Events), and takes the same actions as the terminal board.
// Runs inside the terminal board's process (entrypoints/tui.ts); `bun src/entrypoints/server.ts` runs it alone.
//
// Only loopback, only the Host it was asked for, and every POST needs an X-Board header: a page
// on another site cannot send that without a CORS preflight, which this server never grants, so
// it cannot type into a session.
import { type FSWatcher, mkdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { saveFoundProfiles } from '../adapters/config-file.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { ownFileCheck } from '../adapters/own-files.ts'
import { archiveDir, cardsDir, ROOT, scheduleDir } from '../adapters/paths.ts'
import { fetchProbe, probeOrigin } from '../adapters/probe.ts'
import { inheritedProfileDir } from '../adapters/profiles.ts'
import {
  endStraySsh,
  keyPath,
  knownHostsFile,
  publicKeyOf,
  readPidRecord,
  spawnSsh,
  sshBin,
  writePidRecord,
} from '../adapters/ssh.ts'
import { messageGate } from '../core/message-gate.ts'
import { pwaPage } from '../core/pwa.ts'
import type { SetupFacts } from '../core/setup.ts'
import { boardPorts, forwardSpec, sshArgs, tunnelConfig, tunnelProblems } from '../core/tunnel.ts'
import { createAccess } from '../services/access.ts'
import { asideCheck } from '../services/aside.ts'
import type { Deps } from '../services/deps.ts'
import { createLaunches } from '../services/launch/launches.ts'
import { mokupilotCheck } from '../services/mokupilot.ts'
import { editProfile, installProfile } from '../services/profiles.ts'
import { createRemote } from '../services/remote.ts'
import { createRemoteAccess } from '../services/remote-access.ts'
import { startScheduler } from '../services/scheduler.ts'
import { createSetupChecks } from '../services/setup-check.ts'
import { createTerminals, terminalOn } from '../services/terminals.ts'
import { createProbes, createSupervisor, networkSignature, realClock, type TunnelPlan } from '../services/tunnel.ts'
import { createBoardState } from './board-state.ts'
import { dispatch, json, type Route } from './http.ts'
import { createRemoteListener } from './remote.ts'
import { accessRoutes } from './routes/access.ts'
import { archiveRoutes } from './routes/archive.ts'
import { boardRoutes } from './routes/board.ts'
import { fsRoutes } from './routes/fs.ts'
import { launchRoutes } from './routes/launch.ts'
import { pageLogRoute } from './routes/page-log.ts'
import { remoteRoutes } from './routes/remote.ts'
import { revealRoute, revealState } from './routes/reveal.ts'
import { scheduleRoute } from './routes/schedule.ts'
import { sessionRoutes } from './routes/session.ts'
import { categoriesRoute, profilesRoute, settingsRoute } from './routes/settings.ts'
import { setupRoute } from './routes/setup.ts'
import { sleepRoute } from './routes/sleep.ts'
import { staticRoute } from './routes/static.ts'
import { terminalRoute } from './routes/terminal.ts'
import { createBroadcaster } from './sse.ts'
import { createTunnelListener } from './tunnel.ts'
import { openProbeListener } from './tunnel-probe.ts'
import { pruneUploads, uploadRoutes } from './uploads.ts'
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
}

/** `deps.cfg` is the live config (liveConfig): call the returned refresh from its onChange. */
export async function startServer({ deps, port: asked, gather }: ServerOptions): Promise<BoardServer> {
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
  // other files, tells open pages to reload.
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(WEB, 'src', 'main.tsx'),
    early: join(WEB, 'src', 'theme.ts'),
    log,
  })
  // Sessions started from the board (services/launch): their progress goes out with the board.
  const launches = createLaunches({ deps, onChange: () => board.publish() })
  // The terminal (services/terminals.ts): shells the board opened in sessions' folders, and live panes.
  const terminals = createTerminals({ onChange: () => board.publish() })
  // What of the board is not set up on this computer, for the page's quiet note.
  const setup = createSetupChecks({ deps, onChange: () => board.publish(), ...(gather && { gather }) })
  // Whether MokuPilot is here for calls with a fork of a session: looked up again when its
  // setting changes, and once a minute for one installed or removed meanwhile.
  const mokupilot = mokupilotCheck(cfg)
  // Whether Claude Code is here for side questions to a session: looked up again once a minute.
  const aside = asideCheck()
  // A notification click asks for a session: pages that connect right after are told it too.
  const reveals = revealState()
  const events = createBroadcaster(() => board.payload(), { greet: reveals.greet })
  // The remote mode (core/remote.ts): pairing, and the listener on the Tailscale address while it
  // is on. Off, it reads the config and nothing else.
  const remote = createRemote({ onChange: () => board.publish() })
  const routes: Route[] = []
  const guards = { port, token: FILE_TOKEN, stale: () => board.stale() }
  // The page for a phone's browser through `tailscale serve`, while remote.pwa is on, and through
  // the owner's domain: marked remote, with what installs it.
  const page = staticRoute(WEB, bundle, html => pwaPage(html, bundle.version()))
  const listener = createRemoteListener({
    cfg,
    webPort: port,
    version: PLUGIN_VERSION,
    routes,
    guards,
    page,
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
    page,
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
    probe: nonce => fetchProbe(probeOrigin(tunnelConf().domain), nonce),
    // Test's own line, whether the tunnel is on or not.
    testPlan: lineTo,
    checkKey: () => publicKeyOf(keyPath(tunnelConf())),
    sshFound: () => sshBin(),
    openProbeListener,
    onChange: accessChanged,
    log,
  })
  // The "Remote access…" panel's view and changes (/api/access, the local board's only).
  const remoteAccess = createRemoteAccess({
    cfg,
    webPort: port,
    access,
    supervisor,
    tunnel,
    onChange: accessChanged,
  })
  const board = createBoardState({
    deps,
    launches,
    terminals,
    version: bundle.version,
    push: payload => events.send(payload),
    setup: setup.summary,
    mokupilot,
    remote: listener.view,
    aside,
    accessRev: () => accessRev,
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
    // A line from the page for this log (a phone's browser says what it could not do there).
    pageLogRoute(log),
    scheduleRoute(refresh),
    // Several sessions put to sleep at once, for agents (services/sleep.ts).
    sleepRoute({ deps, items: board.items, refresh }),
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
    staticRoute(WEB, bundle),
  )
  const host = new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`)

  async function answer(req: Request): Promise<Response> {
    // The header first: with an empty, invalid or missing Host, Bun's req.url is a bare path.
    if (!host.test(req.headers.get('host') ?? '')) return json(403, { error: 'host' })
    let url: URL | undefined
    try {
      url = new URL(req.url)
      return await dispatch(routes, req, url, decodeURIComponent(url.pathname), guards)
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
      await board.refresh()
    },
    async close() {
      clearInterval(poll)
      for (const watcher of watchers) watcher.close()
      scheduler.stop()
      terminals.stopAll()
      setup.stop()
      accessOut.cancel()
      events.close()
      await listener.close()
      // ssh before the listener it forwards to.
      await supervisor.close()
      process.off('exit', supervisor.killNow)
      await tunnel.close()
      await server.stop(true)
    },
  }
}
