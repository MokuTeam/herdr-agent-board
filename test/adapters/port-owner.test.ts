// The process on a port, from the system (#356, adapters/port-owner.ts): an old board server run
// from another folder is named by its pid, its command line and when it started; what it says of
// itself is a version and no /api/process.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { elapsedMs, listenerIn, listening, portOwner, serverSays } from '../../src/adapters/port-owner.ts'
import { checkoutOf } from '../../src/core/board-port.ts'
import { type OldBoard, startOldBoard } from '../support/old-board.ts'

setDefaultTimeout(30_000)

let old: OldBoard
beforeAll(async () => {
  old = await startOldBoard()
})
afterAll(() => old.stop())

test('the system names the old server: its pid, a command line with its script, a recent start', async () => {
  const owner = await portOwner(old.port)
  expect(owner?.pid).toBe(old.pid)
  expect(owner?.command).toContain('server.ts')
  expect(owner && checkoutOf(owner)?.toLowerCase()).toBe(old.checkout.toLowerCase())
  expect(owner?.startedAt ?? 0).toBeGreaterThan(Date.now() - 120_000)
})

test('it says it is a board, of a version, and does not know /api/process', async () => {
  expect(await serverSays(old.port)).toEqual({ version: '0.1.0', root: null })
})

test('a port nothing listens on: not listening, no owner, nothing said', async () => {
  const free = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = free.port as number
  free.stop(true)
  expect(await listening(port)).toBe(false)
  expect(await portOwner(port)).toBeNull()
  expect(await serverSays(port)).toEqual({ version: null, root: null })
  expect(await listening(old.port)).toBe(true)
})

test('a pid board.json vouches for is not asked about further', async () => {
  expect(await portOwner(old.port, pid => pid === old.pid)).toEqual({
    pid: old.pid,
    command: null,
    cwd: null,
    startedAt: null,
  })
})

test("netstat's table: the listener on the port by its wildcard foreign address, in any language", () => {
  const table = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:12422        127.0.0.1:50000        ESTABLISHED     11',
    '  TCP    127.0.0.1:124220       0.0.0.0:0              LISTENING       12',
    '  TCP    127.0.0.1:12422        0.0.0.0:0              ПРОСЛУШИВАНИЕ   4242',
    '  TCP    [::]:7443              [::]:0                 ABHÖREN         77',
  ].join('\r\n')
  expect(listenerIn(table, 12422)).toBe(4242)
  expect(listenerIn(table, 7443)).toBe(77)
  expect(listenerIn(table, 50000)).toBeNull()
})

test.each([
  ['05:07', 307_000],
  ['01:00:00', 3_600_000],
  ['3-02:00:01', (3 * 24 * 3600 + 2 * 3600 + 1) * 1000],
  ['nonsense', null],
])('ps elapsed time %s', (etime, ms) => expect(elapsedMs(etime)).toBe(ms))
