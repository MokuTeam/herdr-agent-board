// Showing the web board (the "web" action, o on the terminal board, a notification clicked;
// entrypoints/web-open.ts): in an app window of its own (Edge --app), or that window brought to
// the front when it is open. The server lives in the terminal board's process, so that board is
// started in the background first when needed.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { loadConfig } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { ROOT } from '../adapters/paths.ts'
import { REMINDER_ACTS, REMINDER_ID } from '../core/calendar-reminders.ts'
import { t } from '../core/lang.ts'
import { THREAD_KEY } from '../core/team-unread.ts'
import type { Config } from '../core/types.ts'
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

/**
 * A calendar reminder's button on the desktop (#335, toast.ps1's `claude-pane:cal/<act>/<id>`, the
 * Mac helper's click): the board snoozes it or is done with it; Open also brings its window up on
 * the event. Nothing for an act or id that is not one; the board is not started for it.
 */
export async function reminderClick(
  act: string,
  id: string,
  cfg: WebConfig = loadConfig(),
  options: Pick<WebOpenOptions, 'window'> = {},
): Promise<WebOpenResult> {
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/`
  if (!REMINDER_ID.test(id) || !(act === 'open' || (REMINDER_ACTS as readonly string[]).includes(act)))
    return { ok: false, error: t('cal.err.usage') }
  let answer: unknown
  try {
    const res = await fetch(`${url}api/calendar-reminders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ id, act, desktop: true }),
      signal: AbortSignal.timeout(3000),
    })
    answer = await res.json()
  } catch {
    return { ok: false, missing: true, error: t('err.notRunning') }
  }
  if (!isRecord(answer) || answer.ok !== true)
    return { ok: false, error: isRecord(answer) && typeof answer.error === 'string' ? answer.error : '' }
  if (act !== 'open') return { ok: true, url }
  const win = options.window ?? edgeWindow(typeof cfg.browser === 'string' ? cfg.browser : undefined)
  // a page in a minimized or covered window has no stream: it is told as it connects again
  if (!(await win.raise())) win.launch(url)
  return { ok: true, url }
}

/**
 * A team message's click on the desktop (#355, toast.ps1's `claude-pane:team/<thread>`, the Mac
 * helper's click): the board's pages open the Team panel on that thread, and its window comes up.
 * Nothing for a thread that is no thread's key; the board is not started for it.
 */
export async function teamClick(
  thread: string,
  cfg: WebConfig = loadConfig(),
  options: Pick<WebOpenOptions, 'window'> = {},
): Promise<WebOpenResult> {
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/`
  if (!THREAD_KEY.test(thread)) return { ok: false, error: 'usage: web-open.ts --team <thread key>' }
  let answer: unknown
  try {
    const res = await fetch(`${url}api/team/focus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ thread }),
      signal: AbortSignal.timeout(3000),
    })
    answer = await res.json()
  } catch {
    return { ok: false, missing: true, error: t('err.notRunning') }
  }
  if (!isRecord(answer) || answer.ok !== true)
    return { ok: false, error: isRecord(answer) && typeof answer.error === 'string' ? answer.error : '' }
  const win = options.window ?? edgeWindow(typeof cfg.browser === 'string' ? cfg.browser : undefined)
  // a page in a minimized or covered window has no stream: it is told as it connects again
  if (!(await win.raise())) win.launch(url)
  return { ok: true, url }
}

/** What of the config it reads (config.json's `port` and `browser`). */
export type WebConfig = Pick<Config, 'port' | 'browser'>

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
