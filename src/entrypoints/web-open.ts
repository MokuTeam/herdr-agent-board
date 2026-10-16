// The "web" action (and o on the terminal board): shows the web board in an app window of its
// own (Edge --app), or brings that window to the front when it is open. The server lives in the
// terminal board's process, so that board is started in the background first when needed.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { loadConfig } from '../adapters/config-file.ts'
import { ROOT } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import type { Config } from '../core/types.ts'
import { edgeWindow } from '../integrations/edge-window.ts'

export type WebOpenResult = { ok: true; url: string } | { ok: false; error: string }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}api/board`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

export async function openWeb(cfg: Config = loadConfig()): Promise<WebOpenResult> {
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/`
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
  await edgeWindow(typeof cfg.browser === 'string' ? cfg.browser : undefined).open(url)
  return { ok: true, url }
}

if (import.meta.main) {
  const r = await openWeb()
  console.log(r.ok ? `web board: ${r.url}` : r.error)
  process.exitCode = r.ok ? 0 : 1
}
