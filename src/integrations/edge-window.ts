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
 * The board's own window (#841, #845): a Chromium window (`Chrome_WidgetWin_1`: Edge, Chrome and
 * their installed apps) titled exactly as the page is (web/index.html, models/toolbar.ts
 * documentTitle: `MokuBoard`, `(3) MokuBoard`; `Agent board` before #720, a master not updated
 * yet), the node's page or the master's. The one longer form is the installed app's: Chromium puts
 * the app's name (the manifest's MokuBoard) before a page title that does not start with it,
 * `MokuBoard - (3) MokuBoard`. Nothing else: a browser's own window (` - Microsoft Edge`), an editor
 * or Slack (Chromium too) with a file or channel of that name, Explorer on a folder of that name.
 */
export const BOARD_WINDOW = {
  match: '^((MokuBoard|Agent board) - )?(\\(\\d+\\) )?(MokuBoard|Agent board)$',
  windowClass: 'Chrome_WidgetWin_1',
} as const

/** Whether a window of `windowClass` titled `title` is the board's (BOARD_WINDOW, as the raise reads it on Windows). */
export const isBoardWindow = (title: string, windowClass: string = BOARD_WINDOW.windowClass): boolean =>
  windowClass === BOARD_WINDOW.windowClass && new RegExp(BOARD_WINDOW.match).test(title)

/**
 * `browser`: the config's browser program; else the first known browser that is installed.
 * `raiseMatching`: what brings a window up by its title (tests give a fake).
 */
export function edgeWindow(
  browser?: string | null,
  raiseMatching: (match: string, windowClass: string) => Promise<boolean> = raiseWindowMatching,
): BoardWindow {
  const raise = () => raiseMatching(BOARD_WINDOW.match, BOARD_WINDOW.windowClass)
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
