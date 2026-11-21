// The node link's pure parts (#499): events taken apart as a node's stream sends them
// (core/event-stream.ts), a node's status checked field by field (core/nodes.ts nodeStatusOf), the
// payload check the page and the master share (core/payload-check.ts), and the ssh line's words
// (adapters/node-ssh.ts).
import { expect, test } from 'bun:test'
import { localForward, localForwardUp, localPortTaken, nodeSshArgs } from '../../src/adapters/node-ssh.ts'
import { takeEvents } from '../../src/core/event-stream.ts'
import { nodeStatusOf } from '../../src/core/nodes.ts'
import { isBoardPayload } from '../../src/core/payload-check.ts'
import * as client from '../../web/src/api/client.ts'

test('events: whole ones out, the rest kept, comments and retry dropped, CRLF too', () => {
  const a = takeEvents('retry: 2000\ndata: {"a":1}\n\n: ping\n\nevent: unpaired\ndata: {}\n\ndata: {"b"')
  expect(a.events).toEqual([
    { name: '', data: '{"a":1}' },
    { name: 'unpaired', data: '{}' },
  ])
  expect(a.rest).toBe('data: {"b"')
  const b = takeEvents(`${a.rest}:2}\r\n\r\ndata: x\ndata: y\n\ndata\n\n`)
  expect(b.events).toEqual([
    { name: '', data: '{"b":2}' },
    { name: '', data: 'x\ny' },
    { name: '', data: '' },
  ])
  expect(b.rest).toBe('')
})

const STATUS = {
  api: 1,
  id: 'server-1',
  version: '0.1.0',
  commit: 'ee32fc89',
  platform: 'linux',
  arch: 'x64',
  cpus: 8,
  memTotalMb: 32013,
  memAvailableMb: 21480,
  load: [0.42, 0.61, 0.58],
  sessions: { awake: 2, working: 1, asleep: 5 },
  launches: 0,
  workRootFreeMb: 148000,
  profiles: [{ id: 'default', loggedIn: true, bundle: null }],
  agents: ['claude'],
  at: 1795210000000,
}

test("a node's status: kept as said, nulls kept null, anything else refused", () => {
  expect(nodeStatusOf(STATUS)).toEqual(STATUS as never)
  const nulls = {
    ...STATUS,
    memAvailableMb: null,
    load: null,
    workRootFreeMb: null,
    profiles: [{ id: 'd', loggedIn: null, bundle: null }],
  }
  expect(nodeStatusOf(nulls)).toEqual(nulls as never)
  expect(nodeStatusOf({ ...STATUS, extra: 'x' })).toEqual(STATUS as never)
  for (const bad of [
    null,
    [],
    'x',
    { ...STATUS, memAvailableMb: '21480' },
    { ...STATUS, memAvailableMb: undefined },
    { ...STATUS, load: [1, 2] },
    { ...STATUS, sessions: { awake: 1, working: 0 } },
    { ...STATUS, cpus: -1 },
    { ...STATUS, profiles: [{ id: 1 }] },
    { ...STATUS, agents: [1] },
  ])
    expect([bad, nodeStatusOf(bad)]).toEqual([bad, null])
})

test('the payload check is one: the page takes the core one', () => {
  expect(client.isBoardPayload).toBe(isBoardPayload)
  const payload = {
    items: [],
    launches: [],
    categories: [],
    swatches: [],
    columns: [],
    schedules: [],
    scheduleLog: [],
    version: '1',
    stale: false,
  }
  expect(isBoardPayload(payload)).toBe(true)
  expect(isBoardPayload({ ...payload, items: undefined })).toBe(false)
})

test("the ssh line: forward only, the board's known_hosts, the user's config ignored; up and port-taken lines", () => {
  const link = { kind: 'ssh', host: '203.0.113.10', sshPort: 2222, user: 'agent-board-link', port: 12430 } as const
  expect(
    nodeSshArgs({
      link,
      key: 'C:\\state\\nodes\\server-1\\link-key',
      knownHosts: 'C:\\state\\tunnel\\known_hosts',
      localPort: 50123,
      platform: 'win32',
    }),
  ).toEqual([
    '-F',
    'none',
    '-N',
    '-T',
    '-v',
    '-i',
    'C:/state/nodes/server-1/link-key',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'TCPKeepAlive=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'UserKnownHostsFile="C:/state/tunnel/known_hosts"',
    '-p',
    '2222',
    '-L',
    '127.0.0.1:50123:127.0.0.1:12430',
    'agent-board-link@203.0.113.10',
  ])
  expect(localForward(50123, 12430)).toBe('127.0.0.1:50123:127.0.0.1:12430')
  expect(localForwardUp('debug1: Local forwarding listening on 127.0.0.1 port 50123.', 50123)).toBe(true)
  expect(localForwardUp('debug1: Local forwarding listening on 127.0.0.1 port 50123.\r', 50123)).toBe(true)
  expect(localForwardUp('debug1: Local forwarding listening on 127.0.0.1 port 501234.', 50123)).toBe(false)
  expect(localForwardUp('debug1: Local forwarding listening on ::1 port 50123.', 50123)).toBe(false)
  expect(
    localForwardUp('debug1: Local connections to 127.0.0.1:50123 forwarded to remote address 127.0.0.1:12430', 50123),
  ).toBe(false)
  expect(localPortTaken('bind [127.0.0.1]:50123: Address already in use')).toBe(true)
})
