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

test("the board's window by its title: the --app window and the installed app, on the node or the master", () => {
  for (const title of [
    'MokuBoard',
    '(3) MokuBoard',
    '(12) MokuBoard',
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
    // other programs that only name it
    'LAPTOP: claude-mokuboard-fix',
    'mokuboard',
    'notes about MokuBoard.md - Visual Studio Code',
    'Agent-board',
    'Agent board review - Slack',
    '',
  ])
    expect([title, isBoardWindow(title)]).toEqual([title, false])
})

test('the window is raised by those titles, and an open one is not opened again', async () => {
  const asked: [string, string][] = []
  const win = edgeWindow('/usr/bin/false', async (match, not) => {
    asked.push([match, not])
    return true
  })
  expect(await win.raise()).toBe(true)
  await win.open('http://127.0.0.1:12422/')
  expect(asked).toEqual([
    [BOARD_WINDOW.match, BOARD_WINDOW.not],
    [BOARD_WINDOW.match, BOARD_WINDOW.not],
  ])
  // The patterns hold to what .NET reads as JavaScript does: no flags, lookbehinds or named groups.
  for (const re of [BOARD_WINDOW.match, BOARD_WINDOW.not]) expect(re).not.toMatch(/\(\?|\\k<|\\p\{/)
})
