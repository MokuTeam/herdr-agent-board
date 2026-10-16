// The web board in an app window of its own (Edge --app), raised when it is already open.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { raiseWindow } from './terminal-window.ts'

export interface BoardWindow {
  /** Show the board at `url`: raise its window when open, else open one. */
  open(url: string): Promise<void>
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

/**
 * What to launch to show `url`. With a browser (the config's, else a known Windows install):
 * an app window. Without: the system opener (`cmd /c start` on Windows, `open` on macOS,
 * `xdg-open` elsewhere). Today something is always launched, so `null` is never returned yet.
 */
export function edgeCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  browser?: string | null,
): { file: string; args: string[] } | null {
  if (browser) return { file: browser, args: [`--app=${url}`, '--window-size=1600,1000'] }
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '', url] }
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] }
}

/** `browser`: the config's browser program; else the first known browser that is installed. */
export function edgeWindow(browser?: string | null): BoardWindow {
  return {
    async open(url) {
      if (await raiseWindow('*Agent board*')) return
      const program = browser || BROWSERS.find(p => existsSync(p))
      const cmd = edgeCommand(url, process.platform, program)
      if (!cmd) return
      // A browser window stays visible; the system openers must not flash a console.
      spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: !program }).unref()
    },
  }
}
