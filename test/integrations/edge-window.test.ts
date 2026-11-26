// The board's app window (#841): launched with a browser, or by the system opener; and found again by
// its title (the page's, as an Edge --app window or the installed MokuBoard app shows it, on a node
// or its master), never a browser's own window or another program's that names the board.
import { expect, test } from 'bun:test'
import { BOARD_WINDOW, edgeCommand, edgeWindow, isBoardWindow } from '../../src/integrations/edge-window.ts'

const url = 'http://127.0.0.1:12422/'
const edge = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'

test('with a browser: an app window, on every platform', () => {
  const expected = { file: edge, args: [`--app=${url}`, '--window-size=1600,1000'] }
  for (const platform of ['win32', 'darwin', 'linux'] as const)
    expect(edgeCommand(url, platform, edge)).toEqual(expected)
  expect(edgeCommand(url, 'linux', '/usr/bin/chromium')?.file).toBe('/usr/bin/chromium')
})

test('without a browser: the system opener of each platform', () => {
  expect(edgeCommand(url, 'win32')).toEqual({ file: 'cmd', args: ['/c', 'start', '', url] })
  expect(edgeCommand(url, 'darwin')).toEqual({ file: 'open', args: [url] })
  expect(edgeCommand(url, 'linux')).toEqual({ file: 'xdg-open', args: [url] })
})

test("the board's window: the page's exact titles, the installed app's form, on the node or the master", () => {
  for (const title of [
    'MokuBoard',
    '(3) MokuBoard',
    '(12) MokuBoard',
    'MokuBoard - MokuBoard',
    'MokuBoard - (3) MokuBoard',
    'Agent board',
    '(1) Agent board',
  ])
    expect([title, isBoardWindow(title)]).toEqual([title, true])
  for (const title of [
    // a browser's own window with the board in its tab in front: raised, it may show another tab
    'MokuBoard - Personal - Microsoft\u200b Edge',
    'MokuBoard - Microsoft Edge',
    '(3) MokuBoard - Google Chrome',
    'MokuBoard and 2 more pages - Work - Microsoft\u200b Edge',
    // Chromium programs that only name it (Electron: the same window class)
    'MokuBoard - Visual Studio Code',
    'notes about MokuBoard.md - Visual Studio Code',
    'MokuBoard - Slack',
    'Agent board - Slack',
    'Agent board review - Slack',
    // others
    'LAPTOP: claude-mokuboard-fix',
    'mokuboard',
    'MOKUBOARD',
    'MokuBoard ',
    ' MokuBoard',
    '() MokuBoard',
    '(3)MokuBoard',
    'Agent-board',
    'MokuBoard - MokuBoard - MokuBoard',
    '',
  ])
    expect([title, isBoardWindow(title)]).toEqual([title, false])
})

test("a window of another class titled so is not the board's: Explorer on a folder named MokuBoard", () => {
  expect(isBoardWindow('MokuBoard', 'Chrome_WidgetWin_1')).toBe(true)
  for (const cls of ['CabinetWClass', 'Notepad', 'CASCADIA_HOSTING_WINDOW_CLASS', 'MozillaWindowClass', ''])
    expect([cls, isBoardWindow('MokuBoard', cls)]).toEqual([cls, false])
})

test('the window is raised by that title and class, and an open one is not opened again', async () => {
  const asked: [string, string][] = []
  const win = edgeWindow('/usr/bin/false', async (match, windowClass) => {
    asked.push([match, windowClass])
    return true
  })
  expect(await win.raise()).toBe(true)
  await win.open('http://127.0.0.1:12422/')
  expect(asked).toEqual([
    [BOARD_WINDOW.match, 'Chrome_WidgetWin_1'],
    [BOARD_WINDOW.match, 'Chrome_WidgetWin_1'],
  ])
  // The pattern holds to what .NET reads as JavaScript does: no flags, lookarounds or named groups.
  expect(BOARD_WINDOW.match).not.toMatch(/\(\?|\\k<|\\p\{/)
})
