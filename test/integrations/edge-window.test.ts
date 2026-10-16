import { expect, test } from 'bun:test'
import { edgeCommand } from '../../src/integrations/edge-window.ts'

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
