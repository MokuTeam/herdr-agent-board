// The web board: a small HTTP server (Bun.serve) on 127.0.0.1 that serves web/, the board's data
// and live updates (Server-Sent Events), and takes the same actions as the terminal board.
// Runs inside the terminal board's process (tui.mjs); `bun src/server/app.ts` runs it alone.
//
// Only loopback, only the Host it was asked for, and every POST needs an X-Board header: a page
// on another site cannot send that without a CORS preflight, which this server never grants, so
// it cannot type into a session.
import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { liveConfig } from '../adapters/config-file.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { cardsDir, ROOT, scheduleDir } from '../adapters/paths.ts'
import { messageGate } from '../core/message-gate.ts'
import { type Deps, defaultDeps } from '../services/deps.ts'
import { createLaunches } from '../services/launch/launches.ts'
import { startScheduler } from '../services/scheduler.ts'
import { createBoardState } from './board-state.ts'
import { dispatch, json, type Route } from './http.ts'
import { boardRoutes } from './routes/board.ts'
import { fsRoutes } from './routes/fs.ts'
import { launchRoutes } from './routes/launch.ts'
import { scheduleRoute } from './routes/schedule.ts'
import { sessionRoutes } from './routes/session.ts'
import { categoriesRoute, settingsRoute } from './routes/settings.ts'
import { staticRoute } from './routes/static.ts'
import { createBroadcaster } from './sse.ts'
import { pruneUploads, uploadRoutes } from './uploads.ts'
import { createWebBundle } from './web-bundle.ts'

const WEB = join(ROOT, 'web')

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

/** `deps.cfg` is the live config (liveConfig): call the returned refresh from its onChange. */
export async function startServer({ deps, port: asked }: { deps: Deps; port?: number }): Promise<BoardServer> {
  const { cfg, log } = deps
  const port = asked ?? Number(cfg.port ?? 12422)
  pruneUploads(Number(cfg.keepUploadsDays ?? 14))
  // web/app.js is bundled in memory (Bun.build); its version, with the page's other files, tells open pages to reload.
  const bundle = await createWebBundle({ root: ROOT, entry: join(WEB, 'app.js'), log })
  // Sessions started from the board (services/launch): their progress goes out with the board.
  const launches = createLaunches({ deps, onChange: () => board.publish() })
  const events = createBroadcaster(() => board.payload())
  const board = createBoardState({ deps, launches, version: bundle.version, push: payload => events.send(payload) })
  board.publish()
  const refresh = (): void => void board.refresh()

  // The order of main's `if` chain: the first route that answers wins.
  const routes: Route[] = [
    ...boardRoutes(board, events),
    ...fsRoutes(),
    ...uploadRoutes(),
    settingsRoute(),
    scheduleRoute(refresh),
    categoriesRoute(),
    ...launchRoutes(launches, board.items),
    ...sessionRoutes({ deps, find: board.find, refresh, gate: messageGate(), answering: new Set() }),
    staticRoute(WEB, bundle),
  ]
  const guards = { port, token: FILE_TOKEN, stale: board.stale }
  const host = new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`)

  async function answer(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (!host.test(req.headers.get('host') ?? '')) return json(403, { error: 'host' })
      return await dispatch(routes, req, url, decodeURIComponent(url.pathname), guards)
    } catch (err) {
      log(`${req.method} ${url.pathname}${url.search}: ${messageOf(err)}`)
      return json(500, { error: messageOf(err) })
    }
  }

  // No idle timeout: answers that drive a session can take longer than Bun's default 10 s, and the
  // event stream is quiet between pings (main's node:http had none either).
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({ port, hostname: '127.0.0.1', idleTimeout: 0, fetch: answer })
  } catch (err) {
    // The port is taken (EADDRINUSE, which the terminal board retries): nothing may keep running.
    events.close()
    throw err
  }

  const poll = setInterval(refresh, Math.max(1, cfg.refreshSec ?? 2) * 1000)
  const watchers = [
    watchFolder(cardsDir(), 150, refresh, log),
    // Entries added or cancelled by agents (`board remind`), and runs the scheduler made.
    watchFolder(scheduleDir(), 150, refresh, log),
    // A change to the page: build it again; the new version makes open pages reload.
    watchFolder(WEB, 200, () => void bundle.rebuild().then(refresh), log, true),
  ]
  refresh()
  // The port makes it one board per machine, so one scheduler; claims cover an overlap.
  const scheduler = startScheduler({ deps, onChange: refresh })

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    refresh: board.refresh,
    async close() {
      clearInterval(poll)
      for (const watcher of watchers) watcher.close()
      scheduler.stop()
      events.close()
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  let server: BoardServer | undefined
  const cfg = liveConfig(() => void server?.refresh())
  startServer({ deps: defaultDeps(cfg, msg => console.error(msg)) })
    .then(s => {
      server = s
      console.log(`agent board: ${s.url}`)
    })
    .catch((err: unknown) => {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
      console.error(
        code === 'EADDRINUSE' ? 'agent board: the port is taken, another board already serves it' : messageOf(err),
      )
      process.exit(1)
    })
}
