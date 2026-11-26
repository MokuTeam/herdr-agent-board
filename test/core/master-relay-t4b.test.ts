// The relay table's T4b groups and their helpers (#786, core/master-relay.ts, core/board-slices.ts):
// Team, Devices, starts, body-gated moves; how a node names its own sessions in a bulk body and how
// the master reads its own; the devices as a node's page shows them.
import { expect, test } from 'bun:test'
import {
  boardSlicesOf,
  cardsForNode,
  devicesForNode,
  nodeSlicesView,
  nodesAnswerForNode,
  slicesOf,
} from '../../src/core/board-slices.ts'
import {
  masterBulkBody,
  masterNodesBody,
  nodeBulkBody,
  relayBodyWants,
  relayDevicesPath,
  relayMatch,
  relayOwnerTeam,
  relayTablePath,
} from '../../src/core/master-relay.ts'
import type { BoardDevice } from '../../src/core/payload.ts'

const never = () => false

test('Team, Devices and its forms, starts and their follow-ups are in the table; Move master role and focus are not', () => {
  for (const [m, p] of [
    ['GET', '/api/team'],
    ['POST', '/api/team/send'],
    ['POST', '/api/team/draft/abc/send'],
    ['GET', '/api/team/unread'],
    ['POST', '/api/team/focus'],
    ['GET', '/api/nodes'],
    ['POST', '/api/nodes'],
    ['GET', '/api/nodes/setup'],
    ['POST', '/api/nodes/relay/setup'],
    ['POST', '/api/nodes/computer/setup'],
    ['GET', '/api/launch/options'],
    ['POST', '/api/launch'],
    ['POST', '/api/launch/l-1/dismiss'],
    ['POST', '/api/move'],
    ['POST', '/api/sleep'],
    ['POST', '/api/archive'],
  ] as const)
    expect([m, p, relayTablePath(m, p)]).toEqual([m, p, true])
  for (const [m, p] of [
    ['POST', '/api/nodes/handover'],
    ['GET', '/api/nodes/telegram'],
    ['POST', '/api/launch/l-1/focus'],
    ['POST', '/api/launcher'],
    ['GET', '/api/teams'],
  ] as const)
    expect([m, p, relayTablePath(m, p)]).toEqual([m, p, false])
  expect(relayMatch('POST', '/api/move', never)).toMatchObject({ kind: 'table', entry: { when: 'device' } })
  expect(relayMatch('POST', '/api/sleep', never)).toMatchObject({ kind: 'table', entry: { when: 'foreign' } })
})

test("a body-gated path goes up only for a move to another device or another machine's session", () => {
  expect(relayBodyWants('device', '/api/move', { targets: ['a'], device: 'atlas' }, 'ben')).toBe(true)
  expect(relayBodyWants('device', '/api/move', { targets: ['a'], device: 'local' }, 'ben')).toBe(false)
  // Another machine's session moved here: the master moves it.
  expect(relayBodyWants('device', '/api/move', { targets: ['@cleo:k1'], device: 'local' }, 'ben')).toBe(true)
  expect(relayBodyWants('device', '/api/move', { targets: ['@ben:k1'], device: 'local' }, 'ben')).toBe(false)
  expect(relayBodyWants('device', '/api/move', { targets: ['a'], profile: 'work' }, 'ben')).toBe(false)
  expect(relayBodyWants('foreign', '/api/sleep', { targets: ['@cleo:k1'] }, 'ben')).toBe(true)
  expect(relayBodyWants('foreign', '/api/sleep', { targets: ['@ben:k1', 'p1'] }, 'ben')).toBe(false)
  expect(relayBodyWants('foreign', '/api/archive', { op: 'archive', keys: ['@cleo:k1'] }, 'ben')).toBe(true)
  expect(relayBodyWants('foreign', '/api/archive', { op: 'archive', targets: ['@cleo:k1'] }, 'ben')).toBe(false)
  expect(relayBodyWants('foreign', '/api/sleep', null, 'ben')).toBe(false)
  expect(relayBodyWants('foreign', '/api/sleep', ['@cleo:k1'], 'ben')).toBe(false)
})

test('a node names its own sessions by prefixed key and its own device by id; the master strips its own', () => {
  const own = (t: string) => ({ 'my session ☃ 100%': 'k-own', 'pane-3': 'pane-3' })[t] ?? null
  const sent = nodeBulkBody(
    '/api/move',
    { targets: ['my session ☃ 100%', '@cleo:k2', 'unknown', 'pane-3', 7], device: 'local', dryRun: true },
    'ben',
    own,
  )
  expect(sent).toEqual({
    targets: ['@ben:k-own', '@cleo:k2', 'unknown', '@ben:pane-3', 7],
    device: 'ben',
    dryRun: true,
  })
  expect(nodeBulkBody('/api/archive', { op: 'archive', keys: ['pane-3'] }, 'ben', own)).toEqual({
    op: 'archive',
    keys: ['@ben:pane-3'],
  })
  // The master: its own prefix goes, a move to its own id is a move to local; others stay.
  expect(masterBulkBody('/api/move', { targets: ['@atlas:k1', '@ben:k2', 'name'], device: 'atlas' }, 'atlas')).toEqual({
    targets: ['k1', '@ben:k2', 'name'],
    device: 'local',
  })
  expect(masterBulkBody('/api/sleep', { targets: ['@ben:k2'] }, 'atlas')).toEqual({ targets: ['@ben:k2'] })
  expect(masterBulkBody('/api/sleep', 'odd', 'atlas')).toBe('odd')
  expect(masterBulkBody('/api/threads', { targets: ['@atlas:k1'] }, 'atlas')).toEqual({ targets: ['@atlas:k1'] })
})

test("Team for a relayed owner: all of it but the passkey's window and its list's changes; Devices' paths", () => {
  expect(relayOwnerTeam('GET', '/api/team')).toBe(true)
  expect(relayOwnerTeam('POST', '/api/team/trust')).toBe(true)
  expect(relayOwnerTeam('POST', '/api/team/agents')).toBe(true)
  expect(relayOwnerTeam('GET', '/api/team/confirm')).toBe(true)
  expect(relayOwnerTeam('GET', '/api/team/passkeys')).toBe(true)
  expect(relayOwnerTeam('POST', '/api/team/passkeys')).toBe(false)
  expect(relayOwnerTeam('GET', '/api/team/confirm/abc')).toBe(false)
  expect(relayOwnerTeam('POST', '/api/team/confirm/abc')).toBe(false)
  expect(relayOwnerTeam('GET', '/api/threads')).toBe(false)
  expect(relayDevicesPath('/api/nodes')).toBe(true)
  expect(relayDevicesPath('/api/nodes/computer/setup')).toBe(true)
  expect(relayDevicesPath('/api/nodes/handover')).toBe(false)
})

const dev = (id: string, more: Partial<BoardDevice> = {}): BoardDevice => ({
  id,
  title: id,
  kind: id === 'local' ? null : 'ssh',
  link: id === 'local' ? null : { state: 'online', since: 1, heardAt: 2 },
  status: null,
  sameCommit: null,
  payloadAt: null,
  paused: false,
  drain: false,
  maxSessions: null,
  minFreeMemMb: null,
  maxLoad: null,
  ...more,
})

test("a node's page: this computer is the row with no link, the master named by its id", () => {
  const devices = [dev('local', { selfId: 'atlas', title: 'Atlas desk' }), dev('ben', { held: 2 }), dev('cleo')]
  const mine = devicesForNode(devices, 'ben', true)
  expect(mine?.map(d => d.id)).toEqual(['atlas', 'local', 'cleo'])
  expect(mine?.[0]).toMatchObject({ title: 'Atlas desk', kind: 'ssh', link: { state: 'online' } })
  expect(mine?.[0]?.selfId).toBeUndefined()
  expect(mine?.[1]).toMatchObject({ id: 'local', kind: null, link: null, selfId: 'ben' })
  expect(mine?.[1]?.held).toBeUndefined()
  expect(mine?.[2]).toBe(devices[2] as BoardDevice)
  expect(devicesForNode(devices, 'ben', false)?.[0]?.link?.state).toBe('offline')
  // The master does not list this node, or names no id of its own: none.
  expect(devicesForNode(devices, 'dana', true)).toBeNull()
  expect(devicesForNode([dev('local'), dev('ben')], 'ben', true)).toBeNull()
})

test("the slices in a node's payload: Team's numbers unless it runs its own, devices unless it is a master too", () => {
  const slices = slicesOf({
    teamRev: 4,
    teamUnread: 2,
    teamWaiting: 1,
    devices: [dev('local', { selfId: 'atlas' }), dev('ben')],
  } as never)
  // What waits for the passkey stays on the master's screen.
  expect('teamWaiting' in slices).toBe(false)
  const plain = nodeSlicesView(slices, { self: 'ben', ownTeam: false, ownDevices: false, online: true })
  expect(plain).toMatchObject({ teamRev: 4, teamUnread: 2, relayedDevices: { master: 'atlas' } })
  expect(plain.devices?.map(d => d.id)).toEqual(['atlas', 'local'])
  const own = nodeSlicesView(slices, { self: 'ben', ownTeam: true, ownDevices: true, online: true })
  expect(own).toEqual({})
  // A master that gave none of them: nothing added.
  expect(nodeSlicesView({}, { self: 'ben', ownTeam: false, ownDevices: false, online: true })).toEqual({})
})

test('the machine marker (#789): a node’s page draws its master’s beside its devices, never its own', () => {
  const marker = { style: 'stripe', position: 'top', size: 'small' } as const
  const slices = slicesOf({ devices: [dev('local', { selfId: 'atlas' }), dev('ben')], deviceMarker: marker } as never)
  expect(slices.deviceMarker).toEqual(marker)
  expect(nodeSlicesView(slices, { self: 'ben', ownTeam: false, ownDevices: false, online: true }).deviceMarker).toEqual(
    marker,
  )
  // A node that is a master itself keeps its own devices and its own marker.
  expect(nodeSlicesView(slices, { self: 'ben', ownTeam: false, ownDevices: true, online: true })).toEqual({})
  // A master that does not list this node: no devices, no marker.
  expect(
    'deviceMarker' in nodeSlicesView(slices, { self: 'cleo', ownTeam: true, ownDevices: false, online: true }),
  ).toBe(false)
  // None given, or one that is not a marker: none taken.
  expect('deviceMarker' in slicesOf({ devices: [dev('local', { selfId: 'atlas' })] } as never)).toBe(false)
  expect('deviceMarker' in slicesOf({ deviceMarker: { style: 'ribbon' } } as never)).toBe(false)
  // The marker op goes to the master as it is: it names no device.
  expect(masterNodesBody({ op: 'marker', marker }, 'ben', 'atlas')).toEqual({ op: 'marker', marker })
})

test("Devices from a node's page: its ids read the master's way, the answer in the node's terms", () => {
  // The node (ben) names itself local and the master (atlas) by its id.
  expect(masterNodesBody({ op: 'set', id: 'local', title: 'Ben desk' }, 'ben', 'atlas')).toEqual({
    op: 'set',
    id: 'ben',
    title: 'Ben desk',
  })
  expect(masterNodesBody({ op: 'set', id: 'atlas', color: 'green' }, 'ben', 'atlas')).toEqual({
    op: 'set',
    id: 'local',
    color: 'green',
  })
  expect(masterNodesBody({ op: 'set', id: 'cleo', paused: true }, 'ben', 'atlas')).toEqual({
    op: 'set',
    id: 'cleo',
    paused: true,
  })
  expect(masterNodesBody({ op: 'order', ids: ['cleo', 'local', 'atlas'] }, 'ben', 'atlas')).toEqual({
    op: 'order',
    ids: ['cleo', 'ben', 'local'],
  })
  expect(masterNodesBody({ op: 'whenFull', whenFull: 'local' }, 'ben', 'atlas')).toEqual({
    op: 'whenFull',
    whenFull: 'local',
  })
  expect(masterNodesBody(null, 'ben', 'atlas')).toBeNull()

  const answer = nodesAnswerForNode(
    {
      devices: [dev('local', { selfId: 'atlas' }), dev('ben'), dev('cleo')],
      settings: {
        whenFull: 'local',
        defaults: { local: { maxSessions: 9 }, ben: { maxSessions: 3 } },
        hosts: { ben: { host: 'h', sshPort: 22 } },
        noToken: ['cleo', 'ben'],
        next: 'ben',
      },
    },
    'ben',
    'atlas',
  ) as { master: string; devices: BoardDevice[]; settings: unknown }
  expect(answer.master).toBe('atlas')
  expect(answer.devices.map((d: BoardDevice) => d.id)).toEqual(['atlas', 'local', 'cleo'])
  expect(answer.settings).toEqual({
    whenFull: 'local',
    defaults: { atlas: { maxSessions: 9 }, local: { maxSessions: 3 } },
    hosts: { local: { host: 'h', sshPort: 22 } },
    noToken: ['cleo', 'local'],
    next: 'local',
  })
  expect(nodesAnswerForNode({ ok: true }, 'ben', 'atlas')).toEqual({ ok: true, master: 'atlas' })
  expect(nodesAnswerForNode('odd', 'ben', 'atlas')).toBe('odd')
})

test('a node shows the master and peer cards once, beside its own live cards', () => {
  const slices = slicesOf({
    devices: [dev('local', { selfId: 'atlas' }), dev('ben'), dev('cleo')],
    items: [
      { key: 'pane-w1:p3', name: 'Master session' },
      { key: '@ben:local-key', device: 'ben', name: 'Local session' },
      { key: '@cleo:peer-key', device: 'cleo', name: 'Peer session' },
    ],
  } as never)
  const received = boardSlicesOf({ ok: true, slices: cardsForNode(slices, 'ben') })
  const node = { self: 'ben', ownTeam: false, ownDevices: false, online: true }
  expect(nodeSlicesView(received ?? {}, node).items?.map(({ key, device, name }) => ({ key, device, name }))).toEqual([
    { key: '@atlas:pane-w1:p3', device: 'atlas', name: 'Master session' },
    { key: '@cleo:peer-key', device: 'cleo', name: 'Peer session' },
  ])
  expect(nodeSlicesView(received ?? {}, { ...node, ownDevices: true }).items).toBeUndefined()
  expect(nodeSlicesView({}, node).items).toBeUndefined()
})
