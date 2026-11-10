// Who answers on the board's port (#356, core/board-port.ts): this install's board, a board from
// another folder, an older board server, or no board at all; and doctor's line on it.
import { describe, expect, test } from 'bun:test'
import {
  checkoutOf,
  describeOwner,
  type PortOwner,
  portCheck,
  scriptOf,
  strangerOf,
} from '../../src/core/board-port.ts'
import { translator } from '../../src/core/i18n/translator.ts'

const t = translator('en')
const NOW = 1_800_000_000_000
const owner = (o: Partial<PortOwner> = {}): PortOwner => ({
  pid: 4242,
  command: null,
  cwd: null,
  startedAt: null,
  ...o,
})

describe('the script and the checkout a process runs from', () => {
  test.each([
    ['bun "C:\\work\\old wt\\src\\entrypoints\\server.ts"', 'C:\\work\\old wt\\src\\entrypoints\\server.ts'],
    ['"C:\\bun\\bun.exe" src/entrypoints/server.ts', 'src/entrypoints/server.ts'],
    ['/usr/local/bin/bun /home/a/wt/src/entrypoints/tui.ts --x', '/home/a/wt/src/entrypoints/tui.ts'],
    ['node ./dist/main.mjs', './dist/main.mjs'],
    ['bun run dev', null],
  ])('%s', (command, script) => expect(scriptOf(command)).toBe(script))

  test('an absolute script path names the checkout before src/entrypoints, on either kind of path', () => {
    expect(checkoutOf(owner({ command: 'bun "C:\\work\\old wt\\src\\entrypoints\\server.ts"' }))).toBe(
      'C:\\work\\old wt',
    )
    expect(checkoutOf(owner({ command: 'bun /home/a/wt/src/entrypoints/server.ts' }))).toBe('/home/a/wt')
    expect(checkoutOf(owner({ command: 'bun /opt/tool/main.ts' }))).toBe('/opt/tool')
  })

  test('a relative script path: the working folder where the system tells it, else nothing', () => {
    expect(checkoutOf(owner({ command: 'bun src/entrypoints/server.ts', cwd: '/home/a/wt' }))).toBe('/home/a/wt')
    expect(checkoutOf(owner({ command: 'bun src/entrypoints/server.ts' }))).toBeNull()
  })
})

describe('whether it is this install’s board', () => {
  const root = 'C:\\Users\\a\\herdr\\agent-board'
  test('a server that does not tell its folder is this install’s board when board.json names its pid', () => {
    expect(strangerOf(owner(), { version: '0.1.0', root: null }, root, 4242, 'win32')).toBeNull()
    expect(strangerOf(owner(), { version: null, root: null }, root, 4242, 'win32')).toBeNull()
  })
  test('a server that tells its folder is judged by it, board.json or not', () => {
    expect(strangerOf(owner(), { version: '0.1.0', root: 'C:\\wt\\board-12' }, root, 4242, 'win32')).toBe('elsewhere')
  })
  test('a server that says this install’s folder (any case and slash on Windows) is it', () => {
    const says = { version: '0.1.0', root: 'c:/users/a/herdr/agent-board/' }
    expect(strangerOf(owner(), says, root, null, 'win32')).toBeNull()
    expect(strangerOf(owner(), says, root, 1, 'linux')).toBe('elsewhere')
  })
  test('another folder, a server without /api/process (older code), and no board at all are strangers', () => {
    expect(strangerOf(owner(), { version: '0.1.0', root: 'C:\\wt\\board-12' }, root, null, 'win32')).toBe('elsewhere')
    expect(strangerOf(owner(), { version: '0.1.0', root: null }, root, null, 'win32')).toBe('older')
    expect(strangerOf(owner(), { version: null, root: null }, root, 7, 'win32')).toBe('no-board')
  })
})

describe('the process in a line, and doctor’s check', () => {
  const old = owner({
    command: 'bun "C:\\wt\\board-12\\src\\entrypoints\\server.ts"',
    startedAt: NOW - 3 * 24 * 3600_000,
  })

  test('pid, folder, script, age, version and why', () => {
    expect(describeOwner(old, { version: '0.1.0', root: null }, 'older', NOW)).toBe(
      'pid 4242 · folder C:\\wt\\board-12 · runs C:\\wt\\board-12\\src\\entrypoints\\server.ts · started 3 days ago · agent-board 0.1.0 · a board server older than this install (it does not answer /api/process)',
    )
  })

  test('with no folder known, the whole command line', () => {
    const rel = owner({ command: 'bun src/entrypoints/server.ts', startedAt: NOW - 90 * 60_000 })
    expect(describeOwner(rel, { version: '0.1.0', root: null }, 'older', NOW)).toBe(
      'pid 4242 · command bun src/entrypoints/server.ts · started 2 h ago · agent-board 0.1.0 · a board server older than this install (it does not answer /api/process)',
    )
  })

  test('the server’s own folder wins over the system’s guess; not a board says so', () => {
    expect(describeOwner(owner(), { version: '', root: '/home/a/other' }, 'elsewhere', NOW)).toBe(
      'pid 4242 · folder /home/a/other · agent-board (no version) · a board installed in another folder',
    )
    expect(
      describeOwner(owner({ command: 'nginx: master process' }), { version: null, root: null }, 'no-board', NOW),
    ).toBe('pid 4242 · command nginx: master process · not an agent board')
  })

  test('doctor: no line without a process, ok for this install’s board, a warning naming the stranger', () => {
    const says = { version: '0.1.0', root: null }
    expect(portCheck(12422, null, says, null, '/r', NOW, t)).toBeNull()
    expect(portCheck(12422, owner(), says, null, '/r', NOW, t)).toMatchObject({
      id: 'board-port',
      level: 'ok',
      title: 'Board port 12422',
      detail: 'this install’s board answers (pid 4242)',
    })
    const warn = portCheck(12422, old, says, 'older', '/r', NOW, t)
    expect(warn?.level).toBe('warn')
    expect(warn?.detail).toContain('not this install’s board (/r): pid 4242 · folder C:\\wt\\board-12')
    expect(warn?.fix).toContain('kill 4242 (Stop-Process -Id 4242 on Windows)')
  })

  test('the Russian dictionary has the same lines', () => {
    const ru = translator('ru')
    expect(portCheck(12422, old, { version: '0.1.0', root: null }, 'older', '/r', NOW, ru)?.title).toBe(
      'Порт доски 12422',
    )
  })
})
