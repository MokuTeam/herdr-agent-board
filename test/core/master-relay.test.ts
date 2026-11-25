// The master relay's declared table, wire and rules (#764, core/master-relay.ts): pure.
import { describe, expect, test } from 'bun:test'
import {
  masterPath,
  plainPath,
  RELAY_INLINE_BYTES,
  relayChunkOf,
  relayHeadOf,
  relayMatch,
  relayRequestOf,
} from '../../src/core/master-relay.ts'
import { applyNodesEdit, nodesConfig, nodesEditOf } from '../../src/core/nodes.ts'

const none = (): boolean => false

describe("relayMatch: the threads group and other machines' sessions, nothing else", () => {
  test('the threads routes the issue names are the table', () => {
    for (const [method, path] of [
      ['GET', '/api/threads'],
      ['GET', '/api/threads/events'],
      ['GET', '/api/threads/atlas-12'],
      ['GET', '/api/threads/%D0%B0-1'],
      ['POST', '/api/threads'],
      ['POST', '/api/threads/atlas-12'],
    ] as const) {
      const m = relayMatch(method, path, none)
      expect(m?.kind).toBe('table')
      expect(m?.kind === 'table' && m.entry.group).toBe('threads')
    }
    const events = relayMatch('GET', '/api/threads/events', none)
    expect(events?.kind === 'table' && events.entry.stream).toBe(true)
  })

  test("what stays local is not the relay's: settings, other groups, local sessions, other methods", () => {
    for (const [method, path] of [
      ['GET', '/api/threads-settings'],
      ['POST', '/api/threads-settings'],
      ['GET', '/api/threads/a/b'],
      ['GET', '/api/board'],
      ['GET', '/api/time'],
      ['POST', '/api/reveal'],
      ['GET', '/api/session/pane-p1'],
      ['GET', '/api/term/@ben:k/agent/stream'],
      ['PUT', '/api/threads'],
      ['ANY', '/api/threads'],
    ] as const) {
      expect(relayMatch(method, path, none)).toBeNull()
    }
  })

  test("another machine's session goes up, this node's own and a skipped device stay", () => {
    expect(relayMatch('POST', '/api/session/@ben:pane-p1/message', none)).toEqual({ kind: 'keyed', device: 'ben' })
    expect(relayMatch('GET', '/api/session/%40ben%3As%201', none)).toEqual({ kind: 'keyed', device: 'ben' })
    const skip = (d: string): boolean => d === 'server-1'
    expect(relayMatch('POST', '/api/session/@server-1:pane-p1/message', skip)).toBeNull()
  })
})

describe('masterPath: a key of the master itself loses its prefix', () => {
  test('own key bare, query kept; another device and other paths as they came', () => {
    expect(masterPath('/api/session/@laptop:pane%2F1/message?x=1', 'laptop')).toBe('/api/session/pane%2F1/message?x=1')
    expect(masterPath('/api/session/@ben:p1/message', 'laptop')).toBe('/api/session/@ben:p1/message')
    expect(masterPath('/api/threads?lane=atlas', 'laptop')).toBe('/api/threads?lane=atlas')
    expect(masterPath('/api/session/@laptop:p1', '')).toBe('/api/session/@laptop:p1')
  })
})

describe('the wire is read field by field', () => {
  const good = {
    id: 'abcdefgh12',
    method: 'POST',
    path: '/api/threads/atlas-1?x=%20',
    headers: { 'Content-Type': 'application/json', cookie: 'secret=1', 'x-board': '1' },
    who: { kind: 'owner' },
    idem: 'k-1',
    body: Buffer.from('{}').toString('base64'),
  }

  test('a request keeps only the forwarded headers, lower-cased', () => {
    expect(relayRequestOf(good)).toEqual({
      id: 'abcdefgh12',
      method: 'POST',
      path: '/api/threads/atlas-1?x=%20',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      who: { kind: 'owner' },
      idem: 'k-1',
      body: 'e30=',
    })
    expect(relayRequestOf({ ...good, who: { kind: 'session', key: 'pane-p1' } })?.who).toEqual({
      kind: 'session',
      key: 'pane-p1',
    })
  })

  test('junk is refused', () => {
    for (const bad of [
      null,
      { ...good, id: 'short' },
      { ...good, method: 'PUT' },
      { ...good, path: 'http://evil/api/threads' },
      { ...good, path: '/other' },
      { ...good, path: '/api/threads x' },
      { ...good, who: { kind: 'peer' } },
      { ...good, who: { kind: 'session', key: 'a\u0007b' } },
      { ...good, idem: 'has space' },
      { ...good, body: 'not base64!' },
      { ...good, body: 'e30=', hasBody: true },
      { ...good, body: Buffer.alloc(RELAY_INLINE_BYTES + 3).toString('base64') },
      { ...good, headers: { 'x-board': 'a\r\nset-cookie: x' } },
    ]) {
      expect(relayRequestOf(bad)).toBeNull()
    }
  })

  test('a head and a chunk', () => {
    expect(
      relayHeadOf({ status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'x' }, more: true }),
    ).toEqual({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      more: true,
    })
    expect(relayHeadOf({ status: 99, headers: {} })).toBeNull()
    expect(relayHeadOf({ status: 200, headers: {}, more: true, body: 'e30=' })).toBeNull()
    expect(relayChunkOf({ data: 'e30=', done: true })).toEqual({ data: 'e30=', done: true })
    expect(relayChunkOf({ data: '%%%' })).toBeNull()
    expect(relayChunkOf({ done: 'yes' })).toBeNull()
  })
})

describe("the owner switch on a device (nodes.devices.<id>.owner): on unless the master's owner turns it off", () => {
  const link = { kind: 'direct', url: 'http://127.0.0.1:12430' }
  test('absent is on, false is kept, a non-boolean refused, never on this computer', () => {
    const conf = nodesConfig({
      id: 'laptop',
      devices: { anna: { link, owner: false }, ben: { link }, cleo: { link, owner: true } },
    })
    expect(conf?.devices.anna?.owner).toBe(false)
    expect(conf?.devices.ben?.owner).toBeUndefined()
    expect(conf?.devices.cleo?.owner).toBeUndefined()
    const bad = nodesConfig({ id: 'laptop', devices: { anna: { link, owner: 'no' }, local: { owner: false } } })
    expect(bad?.devices.anna).toBeUndefined()
    expect(bad?.problems).toContainEqual({ device: 'anna', key: 'owner', why: 'type' })
    expect(bad?.problems).toContainEqual({ device: 'local', key: 'owner', why: 'local' })
  })

  test('the panel edit turns it off and back on (the key gone); this computer is refused', () => {
    const nodes: Record<string, unknown> = { id: 'laptop', devices: { anna: { link } } }
    const off = nodesEditOf({ op: 'set', id: 'anna', owner: false })
    expect(off).toEqual({ op: 'set', id: 'anna', values: { owner: false } })
    expect(applyNodesEdit(nodes, off as never)).toEqual({ changed: true })
    expect((nodes.devices as Record<string, Record<string, unknown>>).anna?.owner).toBe(false)
    expect(applyNodesEdit(nodes, nodesEditOf({ op: 'set', id: 'anna', owner: true }) as never)).toEqual({
      changed: true,
    })
    expect(Object.hasOwn((nodes.devices as Record<string, object>).anna ?? {}, 'owner')).toBe(false)
    expect(nodesEditOf({ op: 'set', id: 'local', owner: false })).toEqual({ error: 'owner' })
    expect(nodesEditOf({ op: 'set', id: 'anna', owner: 'no' })).toEqual({ error: 'owner' })
  })
})

describe('plainPath: the path checked is the path that runs', () => {
  test('a letter spelled as %XX is another spelling of a path, not plain', () => {
    expect(plainPath('/api/threads/%65vents')).toBe(false)
    expect(plainPath('/api/thr%65ads')).toBe(false)
    expect(plainPath('/api/threads/events')).toBe(true)
  })

  test('dot segments in any spelling and backslashes are not plain; encoded keys are', () => {
    for (const p of [
      '/api/threads/..',
      '/api/threads/%2e%2e',
      '/api/threads/%2E',
      '/api/threads/a\\b',
      '/api/threads/a%5cb',
      '/api/a/./b',
    ])
      expect([p, plainPath(p)]).toEqual([p, false])
    for (const p of ['/api/threads/atlas-1', '/api/session/%40ben%3Apane%2F1/message', '/api/threads/%D0%B0-1'])
      expect([p, plainPath(p)]).toEqual([p, true])
  })
})
