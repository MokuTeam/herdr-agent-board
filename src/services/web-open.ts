// Showing the web board (the "web" action, o on the terminal board, a notification clicked;
// entrypoints/web-open.ts): in an app window of its own (Edge --app), or that window brought to
// the front when it is open. The server lives in the terminal board's process, so that board is
// started in the background first when needed.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { loadConfig } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { type LocalFetch, localFetch } from '../adapters/local-key.ts'
import { ROOT } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import type { Config } from '../core/types.ts'
import { type BoardWindow, edgeWindow } from '../integrations/edge-window.ts'

export type WebOpenResult = { ok: true; url: string; key?: string } | { ok: false; error: string; missing?: boolean }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function up(url: string, fetchFn: LocalFetch): Promise<boolean> {
  try {
    return (await fetchFn(`${url}api/board`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

type Revealed = { ok: true; key: string } | { ok: false; error: string }

/** What the board said to /api/reveal, read as main read it: no answer at all is not ok. */
function revealedOf(value: unknown): Revealed {
  if (!isRecord(value) || !value.ok) {
    const error = isRecord(value) && typeof value.error === 'string' ? value.error : ''
    return { ok: false, error }
  }
  return { ok: true, key: String(value.key) }
}

/** Ask the running board to show the session in a herdr pane. */
async function reveal(url: string, pane: string, fetchFn: LocalFetch): Promise<Revealed> {
  try {
    const res = await fetchFn(`${url}api/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ pane }),
      signal: AbortSignal.timeout(3000),
    })
    return revealedOf(await res.json())
  } catch {
    return { ok: false, error: '' }
  }
}

/** What of the config it reads (config.json's `port` and `browser`; `serverMode`, for the board's local key there). */
export type WebConfig = Pick<Config, 'port' | 'browser' | 'serverMode'>

export interface WebOpenOptions {
  /** The session in that herdr pane, its sheet open (a notification clicked). */
  pane?: string | undefined
  /** The board's window (Edge --app by default). */
  window?: BoardWindow
}

/**
 * With `pane`, the session in that herdr pane, its sheet open (a notification clicked). The board
 * is not started for it: { ok: false, missing: true } when it does not run or has no session
 * there, and the caller goes to herdr instead.
 */
export async function openWeb(cfg: WebConfig = loadConfig(), options: WebOpenOptions = {}): Promise<WebOpenResult> {
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/`
  const ask = localFetch(cfg)
  const win = options.window ?? edgeWindow(typeof cfg.browser === 'string' ? cfg.browser : undefined)
  if (options.pane) {
    const r = await reveal(url, options.pane, ask)
    if (!r.ok) return { ok: false, missing: true, error: r.error || t('err.notRunning') }
    // The board's window comes up and shows the session: a page in a minimized or covered
    // window has no stream, so it may be told only as it connects again (server/routes/reveal.ts).
    if (await win.raise()) return { ok: true, url, key: r.key }
    win.launch(`${url}#session=${encodeURIComponent(r.key)}`)
    return { ok: true, url }
  }
  if (!(await up(url, ask))) {
    await new Promise(r =>
      execFile(
        process.execPath,
        [join(ROOT, 'src', 'entrypoints', 'open.ts'), '--background'],
        { windowsHide: true },
        r,
      ),
    )
    for (let i = 0; i < 40 && !(await up(url, ask)); i++) await sleep(250)
    if (!(await up(url, ask))) return { ok: false, error: t('err.notRunning') }
  }
  await win.open(url)
  return { ok: true, url }
}
