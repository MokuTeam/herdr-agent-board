// The web board in an app window of its own (Edge --app), raised when it is already open.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { raiseWindowMatching } from './terminal-window.ts'

export interface BoardWindow {
  /** Show the board at `url`: raise its window when open, else open one. */
  open(url: string): Promise<void>
  /** Bring the board's window to the front; false when there is none. */
  raise(): Promise<boolean>
  /** Open a new window on `url`. */
  launch(url: string): void
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

/**
 * The board's own window by its title (#841): the page's title (web/index.html, models/toolbar.ts
 * documentTitle: `MokuBoard`, `(3) MokuBoard`; `Agent board` before #720, a master not updated
 * yet), as an Edge --app window shows it, or after the app's name as the installed app (the
 * manifest's MokuBoard) shows it: `MokuBoard - (3) MokuBoard`. The node's page or the master's, the
 * same titles. A browser's own window is not the board's even with the board in its tab in front:
 * raised, it may show another tab, and a reveal would open the sheet out of sight.
 */
export const BOARD_WINDOW = {
  match: '^(\\(\\d+\\) )?(MokuBoard|Agent board)( - .*)?$',
  not: ' - (Microsoft.{0,2}Edge|Google Chrome|Chromium|Brave|Opera|Mozilla Firefox|Vivaldi)$',
} as const

/** Whether a window titled `title` is the board's (BOARD_WINDOW, as the raise reads it on Windows). */
export const isBoardWindow = (title: string): boolean =>
  new RegExp(BOARD_WINDOW.match).test(title) && !new RegExp(BOARD_WINDOW.not).test(title)

/**
 * `browser`: the config's browser program; else the first known browser that is installed.
 * `raiseMatching`: what brings a window up by its title (tests give a fake).
 */
export function edgeWindow(
  browser?: string | null,
  raiseMatching: (match: string, not: string) => Promise<boolean> = raiseWindowMatching,
): BoardWindow {
  const raise = () => raiseMatching(BOARD_WINDOW.match, BOARD_WINDOW.not)
  function launch(url: string): void {
    const program = browser || BROWSERS.find(p => existsSync(p))
    const cmd = edgeCommand(url, process.platform, program)
    if (!cmd) return
    // A browser window stays visible; the system openers must not flash a console.
    spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: !program }).unref()
  }
  return {
    async open(url) {
      if (await raise()) return
      launch(url)
    },
    raise,
    launch,
  }
}
