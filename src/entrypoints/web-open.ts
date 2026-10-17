// The "web" action (and o on the terminal board): shows the web board in an app window of its
// own (Edge --app), or brings that window to the front when it is open. The server lives in the
// terminal board's process, so that board is started in the background first when needed.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { loadConfig } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { ROOT } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import { type BoardWindow, edgeWindow } from '../integrations/edge-window.ts'

export type WebOpenResult = { ok: true; url: string; key?: string } | { ok: false; error: string; missing?: boolean }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}api/board`, { signal: AbortSignal.timeout(1500) })).ok
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
async function reveal(url: string, pane: string): Promise<Revealed> {
  try {
    const res = await fetch(`${url}api/reveal`, {
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

/** What of the config it reads (config.json's `port` and `browser`). */
export interface WebConfig {
  port?: unknown
  browser?: unknown
  [extra: string]: unknown
}

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
  const win = options.window ?? edgeWindow(typeof cfg.browser === 'string' ? cfg.browser : undefined)
  if (options.pane) {
    const r = await reveal(url, options.pane)
    if (!r.ok) return { ok: false, missing: true, error: r.error || t('err.notRunning') }
    // The board's window comes up and shows the session: a page in a minimized or covered
    // window has no stream, so it may be told only as it connects again (server/routes/reveal.ts).
    if (await win.raise()) return { ok: true, url, key: r.key }
    win.launch(`${url}#session=${encodeURIComponent(r.key)}`)
    return { ok: true, url }
  }
  if (!(await up(url))) {
    await new Promise(r =>
      execFile(
        process.execPath,
        [join(ROOT, 'src', 'entrypoints', 'open.ts'), '--background'],
        { windowsHide: true },
        r,
      ),
    )
    for (let i = 0; i < 40 && !(await up(url)); i++) await sleep(250)
    if (!(await up(url))) return { ok: false, error: t('err.notRunning') }
  }
  await win.open(url)
  return { ok: true, url }
}

// `bun src/entrypoints/web-open.ts [--pane <herdr pane id>]`: exit code 3 when the board cannot
// show that session (not running, or no session there), for a caller that then goes to herdr.
if (import.meta.main) {
  const at = process.argv.indexOf('--pane')
  const pane = at > 0 ? process.argv[at + 1] : undefined
  const r = await openWeb(loadConfig(), { pane })
  console.log(r.ok ? `web board: ${r.url}${r.key ? ` (${r.key})` : ''}` : r.error)
  process.exitCode = r.ok ? 0 : r.missing ? 3 : 1
}
