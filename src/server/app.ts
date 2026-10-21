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
import { omarchyTheme } from '../adapters/omarchy.ts'
import { archiveDir, cardsDir, ROOT, scheduleDir } from '../adapters/paths.ts'
import { inheritedProfileDir } from '../adapters/profiles.ts'
import { messageGate } from '../core/message-gate.ts'
import { pageWithLook } from '../core/omarchy-theme.ts'
import { shownProfiles } from '../core/profiles.ts'
import { pwaPage } from '../core/pwa.ts'
import type { SetupFacts } from '../core/setup.ts'
import { asideCheck } from '../services/aside.ts'
import type { Deps } from '../services/deps.ts'
import { createLaunches } from '../services/launch/launches.ts'
import { mokupilotCheck } from '../services/mokupilot.ts'
import { editProfile, installProfile, wakeHooksInPlace } from '../services/profiles.ts'
import { createRemote } from '../services/remote.ts'
import { startScheduler } from '../services/scheduler.ts'
import { createSetupChecks } from '../services/setup-check.ts'
import { createTerminals, terminalOn } from '../services/terminals.ts'
import { createWakeControl, startWakeStart } from '../services/wake/control.ts'
import { createBoardState } from './board-state.ts'
import { dispatch, json, type Route } from './http.ts'
import { createRemoteListener } from './remote.ts'
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
import { wakeRoutes } from './routes/wake.ts'
import { createBroadcaster } from './sse.ts'
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

export interface ServerOptions {
  deps: Deps
  port?: number
  /** What the setup check reads of this computer (services/setup-check.ts; tests hand in their own). */
  gather?: () => Promise<SetupFacts>
  /** Starts wake's start (entrypoints/wake-start.ts, with `--again` for Start again); tests hand in a recorder. */
  wakeStarter?: (args?: string[]) => void
}

/** `deps.cfg` is the live config (liveConfig): call the returned refresh from its onChange. */
export async function startServer({ deps, port: asked, gather, wakeStarter }: ServerOptions): Promise<BoardServer> {
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
  const listener = createRemoteListener({
    cfg,
    webPort: port,
    version: PLUGIN_VERSION,
    routes,
    guards,
    // The page for a phone's browser through `tailscale serve`, while remote.pwa is on.
    page: staticRoute(WEB, bundle, html => pwaPage(page(html), bundle.version())),
    remote,
    log,
    onChange: () => board.publish(),
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
    ...(omarchy && { omarchy: omarchy.stamp }),
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
    staticRoute(WEB, bundle, page),
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
    events.close()
    throw err
  }

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
  // Wake on but not running (its startup entry did not run, or it ended): started once.
  void wake.ensure()

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    // Called when config.json changes, too: the remote mode follows it.
    async refresh() {
      listener.configChanged()
      // Turned on in config.json (by hand, or from the panel): started at once.
      wake.configChanged()
      await board.refresh()
    },
    async close() {
      clearInterval(poll)
      for (const watcher of watchers) watcher.close()
      omarchy?.close()
      scheduler.stop()
      wake.stop()
      terminals.stopAll()
      setup.stop()
      events.close()
      await listener.close()
      await server.stop(true)
    },
  }
}
