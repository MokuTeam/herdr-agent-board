// The Devices panel's edits of config.json's `nodes` (#510, docs/design/nodes 7.1, 12): each op read
// from a body (nodesEditOf), then held to the rules nodesConfig reads with (applyNodesEdit). A bad
// value is refused with its field and leaves the section as it was.
import { describe, expect, test } from 'bun:test'
import {
  applyNodesEdit,
  type NodesEdit,
  nodeConfig,
  nodeProblems,
  nodeStatusOf,
  nodesConfig,
  nodesEditOf,
  statusShown,
} from '../../src/core/nodes.ts'

const section = (): Record<string, unknown> => ({
  id: 'laptop',
  order: ['server-1', 'local'],
  devices: {
    'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:12430' }, maxSessions: 3 },
    'server-2': { link: { kind: 'direct', url: 'http://127.0.0.1:12431' } },
  },
})

const read = (body: Record<string, unknown>): NodesEdit => {
  const e = nodesEditOf(body)
  if (!e || 'error' in e) throw new Error(`not an edit: ${JSON.stringify(e)}`)
  return e
}

/** The edit applied to a fresh section: what it answered and the section after. */
function applied(body: Record<string, unknown>, nodes = section()) {
  const before = JSON.stringify(nodes)
  const r = applyNodesEdit(nodes, read(body))
  if ('error' in r) expect(JSON.stringify(nodes)).toBe(before)
  return { r, nodes }
}

describe('nodesEditOf', () => {
  test('another op, or none, is not the panel’s: the route reads it as before', () => {
    expect(nodesEditOf({ op: 'retry', id: 'server-1' })).toBeNull()
    expect(nodesEditOf({ op: 'sync', id: 'server-1' })).toBeNull()
    expect(nodesEditOf({})).toBeNull()
  })

  test('the shape of each op, refused by its field', () => {
    expect(nodesEditOf({ op: 'order', ids: 'local' })).toEqual({ error: 'ids' })
    expect(nodesEditOf({ op: 'order', ids: ['local', 3] })).toEqual({ error: 'ids' })
    expect(nodesEditOf({ op: 'lanes', lanes: 'some' })).toEqual({ error: 'lanes' })
    expect(nodesEditOf({ op: 'lanes', lanes: [], shown: 'x' })).toEqual({ error: 'shown' })
    expect(nodesEditOf({ op: 'whenFull', whenFull: 'later' })).toEqual({ error: 'whenFull' })
    expect(nodesEditOf({ op: 'set', id: 'Server 1', paused: true })).toEqual({ error: 'id' })
    expect(nodesEditOf({ op: 'set', id: 'server-1' })).toEqual({ error: 'values' })
    expect(nodesEditOf({ op: 'set', id: 'server-1', paused: 'yes' })).toEqual({ error: 'paused' })
    expect(nodesEditOf({ op: 'set', id: 'server-1', maxSessions: '4' })).toEqual({ error: 'maxSessions' })
    // This computer is never paused.
    expect(nodesEditOf({ op: 'set', id: 'local', paused: true })).toEqual({ error: 'paused' })
    expect(nodesEditOf({ op: 'set', id: 'local', drain: true })).toEqual({
      op: 'set',
      id: 'local',
      values: { drain: true },
    })
  })
})

describe('applyNodesEdit', () => {
  test('order: every device once, written as sent', () => {
    const { r, nodes } = applied({ op: 'order', ids: ['local', 'server-2', 'server-1'] })
    expect(r).toEqual({ changed: true })
    expect(nodes.order).toEqual(['local', 'server-2', 'server-1'])
    // A device left out, one twice, one unknown: refused, nothing changed.
    expect(applied({ op: 'order', ids: ['server-1', 'local'] }).r).toEqual({ error: 'ids' })
    expect(applied({ op: 'order', ids: ['server-1', 'server-1', 'server-2', 'local'] }).r).toEqual({ error: 'ids' })
    expect(applied({ op: 'order', ids: ['server-1', 'server-2', 'server-9', 'local'] }).r).toEqual({ error: 'ids' })
  })

  test('set: switches and thresholds by nodesConfig’s rules; null is no limit', () => {
    const { r, nodes } = applied({ op: 'set', id: 'server-1', paused: true, drain: false, minFreeMemMb: 1200 })
    expect(r).toEqual({ changed: true })
    const devices = nodes.devices as Record<string, Record<string, unknown>>
    expect(devices['server-1']).toMatchObject({ paused: true, drain: false, minFreeMemMb: 1200, maxSessions: 3 })
    const out = applied({ op: 'set', id: 'server-1', maxSessions: null })
    expect((out.nodes.devices as Record<string, Record<string, unknown>>)['server-1']?.maxSessions).toBeNull()
    expect(applied({ op: 'set', id: 'server-1', maxSessions: 0 }).r).toEqual({ error: 'maxSessions' })
    expect(applied({ op: 'set', id: 'server-1', maxSessions: 2.5 }).r).toEqual({ error: 'maxSessions' })
    expect(applied({ op: 'set', id: 'server-1', minFreeMemMb: -1 }).r).toEqual({ error: 'minFreeMemMb' })
    expect(applied({ op: 'set', id: 'server-1', maxLoad: 0 }).r).toEqual({ error: 'maxLoad' })
    // A device the section does not hold.
    expect(applied({ op: 'set', id: 'server-9', paused: true }).r).toEqual({ error: 'id' })
    // The same value again: nothing to write.
    expect(applied({ op: 'set', id: 'server-1', maxSessions: 3 }).r).toEqual({ changed: false })
  })

  test('set on this computer makes its entry', () => {
    const { r, nodes } = applied({ op: 'set', id: 'local', maxSessions: 6 })
    expect(r).toEqual({ changed: true })
    expect((nodes.devices as Record<string, unknown>).local).toEqual({ maxSessions: 6 })
    const bare = applied({ op: 'set', id: 'local', drain: true }, { id: 'laptop' })
    expect(bare.nodes.devices).toEqual({ local: { drain: true } })
  })

  test('lanes: a list lower-cased, or all; an empty name refused', () => {
    expect(applied({ op: 'lanes', lanes: ['Atlas', 'tools', 'atlas'] }).nodes.lanes).toEqual(['atlas', 'tools'])
    expect(applied({ op: 'lanes', lanes: 'all' }).nodes.lanes).toBe('all')
    expect(applied({ op: 'lanes', lanes: [] }).nodes.lanes).toEqual([])
    expect(applied({ op: 'lanes', lanes: ['atlas', ' '] }).r).toEqual({ error: 'lanes' })
  })

  test('whenFull', () => {
    expect(applied({ op: 'whenFull', whenFull: 'wait' }).nodes.whenFull).toBe('wait')
    expect(applied({ op: 'whenFull', whenFull: 'local' }).r).toEqual({ changed: true })
  })

  test('a problem the section already had does not stop an edit of something else', () => {
    const nodes = section()
    ;(nodes.devices as Record<string, unknown>)['bad id'] = {}
    const r = applyNodesEdit(nodes, read({ op: 'whenFull', whenFull: 'wait' }))
    expect(r).toEqual({ changed: true })
    expect(nodes.whenFull).toBe('wait')
  })

  test('order with a device left out for a problem of its own: the usable ones, that one kept after them', () => {
    const nodes = section()
    const devices = nodes.devices as Record<string, unknown>
    devices['server-3'] = { link: { kind: 'direct', url: 'http://127.0.0.1:1' }, bogus: 1 }
    expect(applyNodesEdit(nodes, read({ op: 'order', ids: ['server-2', 'local', 'server-1'] }))).toEqual({
      changed: true,
    })
    expect(nodes.order).toEqual(['server-2', 'local', 'server-1', 'server-3'])
    // Naming it is a stale list: the panel never showed it.
    expect(applied({ op: 'order', ids: ['server-2', 'local', 'server-1', 'server-3'] }, nodes).r).toEqual({
      error: 'ids',
    })
  })

  test('a bad value over a bad value is refused too', () => {
    const nodes = section()
    nodes.lanes = 5
    expect(applied({ op: 'lanes', lanes: ['', 'x'] }, nodes).r).toEqual({ error: 'lanes' })
    expect(applied({ op: 'lanes', lanes: ['x'] }, nodes).r).toEqual({ changed: true })
    const zero = section()
    ;(zero.devices as Record<string, Record<string, unknown>>)['server-2'] = {
      link: { kind: 'direct', url: 'http://127.0.0.1:12431' },
      maxSessions: 0,
    }
    expect(applied({ op: 'set', id: 'server-2', maxSessions: -3 }, zero).r).toEqual({ error: 'maxSessions' })
    expect(applied({ op: 'set', id: 'server-2', maxSessions: 2 }, zero).r).toEqual({ changed: true })
  })
})

describe('giveSecrets (#604)', () => {
  const devices = (nodes: Record<string, unknown>) => nodes.devices as Record<string, Record<string, unknown>>

  test('absent is on; false is off; anything else is a problem of that device', () => {
    const on = nodesConfig(section(), 'laptop')
    expect(on?.devices['server-1'] && 'giveSecrets' in on.devices['server-1']).toBe(false)
    const off = section()
    devices(off)['server-1'] = { ...devices(off)['server-1'], giveSecrets: false }
    expect(nodesConfig(off, 'laptop')?.devices['server-1']?.giveSecrets).toBe(false)
    const bad = section()
    devices(bad)['server-1'] = { ...devices(bad)['server-1'], giveSecrets: 'yes' }
    const cfg = nodesConfig(bad, 'laptop')
    expect(cfg?.devices['server-1']).toBeUndefined()
    expect(cfg?.problems).toContainEqual({ device: 'server-1', key: 'giveSecrets', why: 'type' })
  })

  test('the switch: off writes false, on takes the key out, as an owner who never touched it has it', () => {
    const { r, nodes } = applied({ op: 'set', id: 'server-1', giveSecrets: false })
    expect(r).toEqual({ changed: true })
    expect(devices(nodes)['server-1']?.giveSecrets).toBe(false)
    const back = applyNodesEdit(nodes, read({ op: 'set', id: 'server-1', giveSecrets: true }))
    expect(back).toEqual({ changed: true })
    expect('giveSecrets' in (devices(nodes)['server-1'] ?? {})).toBe(false)
  })

  test('refused: not a boolean, and on this computer', () => {
    expect(nodesEditOf({ op: 'set', id: 'server-1', giveSecrets: 'off' })).toEqual({ error: 'giveSecrets' })
    expect(nodesEditOf({ op: 'set', id: 'local', giveSecrets: false })).toEqual({ error: 'giveSecrets' })
  })
})

describe('pilotBridge (#730, #738)', () => {
  const devices = (nodes: Record<string, unknown>) => nodes.devices as Record<string, Record<string, unknown>>

  test('absent or true is on (key omitted); false turns it off; non-boolean is flagged', () => {
    const on = nodesConfig(section(), 'laptop')
    expect(on?.devices['server-1'] && 'pilotBridge' in on.devices['server-1']).toBe(false)
    const explicitOn = section()
    devices(explicitOn)['server-1'] = { ...devices(explicitOn)['server-1'], pilotBridge: true }
    const explicitCfg = nodesConfig(explicitOn, 'laptop')
    expect(explicitCfg?.devices['server-1'] && 'pilotBridge' in explicitCfg.devices['server-1']).toBe(false)
    const off = section()
    devices(off)['server-1'] = { ...devices(off)['server-1'], pilotBridge: false }
    expect(nodesConfig(off, 'laptop')?.devices['server-1']?.pilotBridge).toBe(false)
    const bad = section()
    devices(bad)['server-1'] = { ...devices(bad)['server-1'], pilotBridge: 'yes' }
    const cfg = nodesConfig(bad, 'laptop')
    expect(cfg?.devices['server-1']).toBeUndefined()
    expect(cfg?.problems).toContainEqual({ device: 'server-1', key: 'pilotBridge', why: 'type' })
  })

  test('the switch works on remote nodes and local; true removes the key', () => {
    for (const id of ['server-1', 'local']) {
      const { r, nodes } = applied({ op: 'set', id, pilotBridge: false })
      expect(r).toEqual({ changed: true })
      expect(devices(nodes)[id]?.pilotBridge).toBe(false)
      const back = applyNodesEdit(nodes, read({ op: 'set', id, pilotBridge: true }))
      expect(back).toEqual({ changed: true })
      expect('pilotBridge' in (devices(nodes)[id] ?? {})).toBe(false)
    }
    expect(nodesEditOf({ op: 'set', id: 'server-1', pilotBridge: 'on' })).toEqual({ error: 'pilotBridge' })
  })
})

describe('title (#601)', () => {
  const devices = (nodes: Record<string, unknown>) => nodes.devices as Record<string, Record<string, unknown>>

  test('nodesEditOf accepts string or null for a node and local, and refuses other types', () => {
    expect(nodesEditOf({ op: 'set', id: 'server-1', title: 'Atlas Box' })).toEqual({
      op: 'set',
      id: 'server-1',
      values: { title: 'Atlas Box' },
    })
    expect(nodesEditOf({ op: 'set', id: 'local', title: '' })).toEqual({
      op: 'set',
      id: 'local',
      values: { title: '' },
    })
    expect(nodesEditOf({ op: 'set', id: 'local', title: null })).toEqual({
      op: 'set',
      id: 'local',
      values: { title: null },
    })
    expect(nodesEditOf({ op: 'set', id: 'server-1', title: 42 })).toEqual({ error: 'title' })
    expect(nodesEditOf({ op: 'set', id: 'server-1', title: true })).toEqual({ error: 'title' })
  })

  test('renames a node or local (with spaces, non-ASCII, %), keeping id, order and link intact', () => {
    const base = section()
    const { r, nodes } = applied({ op: 'set', id: 'server-1', title: '  Сервер 100%  ' }, base)
    expect(r).toEqual({ changed: true })
    expect(nodes.order).toEqual(['server-1', 'local'])
    expect(devices(nodes)['server-1']).toEqual({
      link: { kind: 'direct', url: 'http://127.0.0.1:12430' },
      maxSessions: 3,
      title: 'Сервер 100%',
    })
    expect(nodesConfig(nodes, 'laptop')?.devices['server-1']?.title).toBe('Сервер 100%')

    const loc = applied({ op: 'set', id: 'local', title: ' Work Laptop ' }, { id: 'laptop' })
    expect(loc.r).toEqual({ changed: true })
    expect(devices(loc.nodes).local).toEqual({ title: 'Work Laptop' })
    expect(nodesConfig(loc.nodes, 'laptop')?.devices.local?.title).toBe('Work Laptop')
  })

  test('empty, whitespace, null, or own id deletes title and returns to default', () => {
    const base = section()
    devices(base)['server-1'] = { ...devices(base)['server-1'], title: 'Atlas Box' }
    expect(applied({ op: 'set', id: 'server-1', title: '   ' }, base).r).toEqual({ changed: true })
    expect('title' in (devices(base)['server-1'] ?? {})).toBe(false)
    expect(nodesConfig(base, 'laptop')?.devices['server-1']?.title).toBe('server-1')

    devices(base)['server-1'] = { ...devices(base)['server-1'], title: 'Atlas Box' }
    expect(applied({ op: 'set', id: 'server-1', title: 'server-1' }, base).r).toEqual({ changed: true })
    expect('title' in (devices(base)['server-1'] ?? {})).toBe(false)

    // Clearing local's only key leaves no empty local entry (and creates no devices section from bare).
    const untouched: Record<string, unknown> = { id: 'laptop' }
    expect(applied({ op: 'set', id: 'local', title: '' }, untouched).r).toEqual({ changed: false })
    expect(untouched).toEqual({ id: 'laptop' })
    const bare: Record<string, unknown> = { id: 'laptop' }
    expect(applied({ op: 'set', id: 'local', title: 'Desk' }, bare).r).toEqual({ changed: true })
    expect(applied({ op: 'set', id: 'local', title: '' }, bare).r).toEqual({ changed: true })
    expect(bare).toEqual({ id: 'laptop', devices: {} })
    expect(applied({ op: 'set', id: 'local', title: null }, bare).r).toEqual({ changed: false })
  })

  test('setting local title to nodes.id or "local" (any case) deletes title and falls back to id (#752, #758)', () => {
    const base: Record<string, unknown> = { id: 'server-2', devices: { local: { title: 'Main Server' } } }
    expect(applied({ op: 'set', id: 'local', title: 'server-2' }, base).r).toEqual({ changed: true })
    expect(devices(base).local).toBeUndefined()
    expect(nodesConfig(base, 'laptop')?.devices.local?.title).toBe('server-2')

    const remoteBase = section()
    devices(remoteBase)['server-1'] = { ...devices(remoteBase)['server-1'], title: 'Atlas Box' }
    expect(applied({ op: 'set', id: 'server-1', title: 'Local' }, remoteBase).r).toEqual({ changed: true })
    expect('title' in (devices(remoteBase)['server-1'] ?? {})).toBe(false)
    expect(nodesConfig(remoteBase, 'laptop')?.devices['server-1']?.title).toBe('server-1')
  })

  test('unchanged title returns changed: false; invalid or unknown device is refused without writing', () => {
    const base = section()
    expect(applied({ op: 'set', id: 'server-1', title: '' }, base).r).toEqual({ changed: false })
    expect(applied({ op: 'set', id: 'server-1', title: 'x'.repeat(201) }, base).r).toEqual({ error: 'title' })
    expect(applied({ op: 'set', id: 'server-1', title: 'bad\u001bname' }, base).r).toEqual({ error: 'title' })
    expect(applied({ op: 'set', id: 'server-9', title: 'Ghost' }, base).r).toEqual({ error: 'id' })
  })

  test('sets, clears, and validates device color (#758)', () => {
    const base = section()
    expect(nodesEditOf({ op: 'set', id: 'server-1', color: 'rose' })).toEqual({
      op: 'set',
      id: 'server-1',
      values: { color: 'rose' },
    })
    expect(applied({ op: 'set', id: 'server-1', color: 'Rose' }, base).r).toEqual({ changed: true })
    expect(devices(base)['server-1']?.color).toBe('rose')
    expect(nodesConfig(base, 'laptop')?.devices['server-1']?.color).toBe('rose')

    expect(applied({ op: 'set', id: 'local', color: '#336699' }, base).r).toEqual({ changed: true })
    expect(devices(base).local?.color).toBe('#336699')

    expect(applied({ op: 'set', id: 'server-1', color: 'invalid' }, base).r).toEqual({ error: 'color' })
    expect(devices(base)['server-1']?.color).toBe('rose')

    expect(applied({ op: 'set', id: 'server-1', color: '' }, base).r).toEqual({ changed: true })
    expect('color' in (devices(base)['server-1'] ?? {})).toBe(false)
    expect(applied({ op: 'set', id: 'local', color: null }, base).r).toEqual({ changed: true })
    expect(devices(base).local).toBeUndefined()
  })
})

describe('the machine marker on cards (#789)', () => {
  test('its shape: the whole marker, refused as marker when it is not one', () => {
    expect(nodesEditOf({ op: 'marker', marker: { style: 'stripe', position: 'top', size: 'small' } })).toEqual({
      op: 'marker',
      marker: { style: 'stripe', position: 'top', size: 'small' },
    })
    expect(nodesEditOf({ op: 'marker' })).toEqual({ error: 'marker' })
    expect(nodesEditOf({ op: 'marker', marker: { style: 'ribbon' } })).toEqual({ error: 'marker' })
    // A place the style does not take.
    expect(nodesEditOf({ op: 'marker', marker: { style: 'corner', position: 'left' } })).toEqual({ error: 'marker' })
  })

  test('kept as what differs from today’s corner; today’s corner again: the key goes', () => {
    const nodes = section()
    const first = applyNodesEdit(
      nodes,
      read({ op: 'marker', marker: { style: 'stripe', position: 'left', size: 'large' } }),
    )
    expect(first).toEqual({ changed: true })
    expect(nodes.marker).toEqual({ style: 'stripe', size: 'large' })
    expect(nodesConfig(nodes)?.marker).toEqual({ style: 'stripe', position: 'left', size: 'large' })
    expect(nodesConfig(nodes)?.problems).toEqual([])
    // The rest of the section as it was.
    expect({ ...nodes, marker: undefined }).toEqual({ ...section(), marker: undefined })
    const back = applyNodesEdit(
      nodes,
      read({ op: 'marker', marker: { style: 'corner', position: 'bottom-right', size: 'medium' } }),
    )
    expect(back).toEqual({ changed: true })
    expect(nodes).toEqual(section())
    // The same again changes nothing.
    expect(applyNodesEdit(nodes, read({ op: 'marker', marker: { style: 'corner' } }))).toEqual({ changed: false })
  })

  test('nodesConfig: no key, no marker; a bad one is named and leaves the rest working', () => {
    expect('marker' in (nodesConfig(section()) ?? {})).toBe(false)
    const bad = nodesConfig({ ...section(), marker: { style: 'ribbon' } })
    expect(bad?.problems).toEqual([{ key: 'marker', why: 'type' }])
    expect('marker' in (bad ?? {})).toBe(false)
    expect(bad?.order).toEqual(nodesConfig(section())?.order)
    // A section with a bad marker still takes an edit of another key, and a good marker over the bad one.
    const nodes = { ...section(), marker: { style: 'ribbon' } }
    expect(applyNodesEdit(nodes, read({ op: 'whenFull', whenFull: 'wait' }))).toEqual({ changed: true })
    expect(applyNodesEdit(nodes, read({ op: 'marker', marker: { style: 'off' } }))).toEqual({ changed: true })
    expect(nodes.marker).toEqual({ style: 'off' })
  })
})

describe('ownProfiles (#802)', () => {
  test('read: true on a device, absent otherwise; a bad value or one on this computer is a problem', () => {
    const cfg = nodesConfig(
      {
        id: 'server-2',
        devices: {
          laptop: { link: { kind: 'direct', url: 'http://127.0.0.1:12430' }, ownProfiles: true },
          'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:12431' }, ownProfiles: false },
          'server-3': { link: { kind: 'direct', url: 'http://127.0.0.1:12432' } },
          'server-4': { link: { kind: 'direct', url: 'http://127.0.0.1:12433' }, ownProfiles: 'yes' },
          local: { ownProfiles: true },
        },
      },
      'server-2',
    )
    expect(cfg?.devices.laptop?.ownProfiles).toBe(true)
    expect('ownProfiles' in (cfg?.devices['server-1'] ?? {})).toBe(false)
    expect('ownProfiles' in (cfg?.devices['server-3'] ?? {})).toBe(false)
    expect(cfg?.devices['server-4']).toBeUndefined()
    expect(cfg?.problems).toContainEqual({ device: 'server-4', key: 'ownProfiles', why: 'type' })
    expect(cfg?.problems).toContainEqual({ device: 'local', key: 'ownProfiles', why: 'local' })
  })

  test('the node side: node.ownProfiles true is kept, absent is absent, a bad value is a problem', () => {
    expect(nodeConfig({ id: 'laptop', ownProfiles: true })?.ownProfiles).toBe(true)
    expect('ownProfiles' in (nodeConfig({ id: 'laptop' }) ?? {})).toBe(false)
    expect(nodeConfig({ id: 'laptop', ownProfiles: 'yes' })).toBeNull()
    expect(nodeProblems({ id: 'laptop', ownProfiles: 'yes' })).toEqual([{ key: 'ownProfiles', why: 'type' }])
  })

  test('the status: kept only when true, and it moves what the page shows', () => {
    const base = {
      api: 1,
      id: 'laptop',
      version: 'v',
      commit: 'c',
      platform: 'linux',
      arch: 'x64',
      cpus: 4,
      memTotalMb: 1,
      memAvailableMb: 1,
      load: null,
      sessions: { awake: 0, working: 0, asleep: 0 },
      launches: 0,
      workRootFreeMb: null,
      profiles: [],
      agents: [],
      at: 1,
    }
    const plain = nodeStatusOf(base)
    expect(plain && 'ownProfiles' in plain).toBe(false)
    expect(nodeStatusOf({ ...base, ownProfiles: true })?.ownProfiles).toBe(true)
    expect(nodeStatusOf({ ...base, ownProfiles: 'yes' })?.ownProfiles).toBeUndefined()
    expect(statusShown(nodeStatusOf({ ...base, ownProfiles: true }))).not.toBe(statusShown(plain))
  })

  test('the panel: on writes the key, off removes it; this computer is refused', () => {
    const on = applied({ op: 'set', id: 'server-1', ownProfiles: true })
    expect(on.r).toEqual({ changed: true })
    expect((on.nodes.devices as Record<string, Record<string, unknown>>)['server-1']?.ownProfiles).toBe(true)
    const off = applied({ op: 'set', id: 'server-1', ownProfiles: false }, on.nodes)
    expect(off.r).toEqual({ changed: true })
    expect('ownProfiles' in ((off.nodes.devices as Record<string, Record<string, unknown>>)['server-1'] ?? {})).toBe(
      false,
    )
    expect(nodesEditOf({ op: 'set', id: 'server-1', ownProfiles: 'yes' })).toEqual({ error: 'ownProfiles' })
    expect(nodesEditOf({ op: 'set', id: 'local', ownProfiles: true })).toEqual({ error: 'ownProfiles' })
  })
})
