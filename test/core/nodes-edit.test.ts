// The Devices panel's edits of config.json's `nodes` (#510, docs/design/nodes 7.1, 12): each op read
// from a body (nodesEditOf), then held to the rules nodesConfig reads with (applyNodesEdit). A bad
// value is refused with its field and leaves the section as it was.
import { describe, expect, test } from 'bun:test'
import { applyNodesEdit, type NodesEdit, nodesConfig, nodesEditOf } from '../../src/core/nodes.ts'

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
