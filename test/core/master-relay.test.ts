// The master relay's declared table, wire and rules (#764, core/master-relay.ts): pure.
import { describe, expect, test } from 'bun:test'
import { boardSlicesOf, slicesOf } from '../../src/core/board-slices.ts'
import {
  BOARD_SLICES_PATH,
  masterPath,
  NODE_CLI_PATH,
  OWNER_CLI_COMMANDS,
  ownerCliOf,
  plainPath,
  RELAY_INLINE_BYTES,
  RELAY_OWNER_SETTINGS,
  relayChunkOf,
  relayHeadOf,
  relayMatch,
  relayOwnerSetting,
  relayRequestOf,
  relayTablePath,
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

  test("decisions (#781) are the table: the master holds the node sessions' questions", () => {
    for (const method of ['GET', 'POST'] as const) {
      const m = relayMatch(method, '/api/decisions', none)
      expect(m?.kind === 'table' && m.entry.group).toBe('decisions')
    }
    expect(relayMatch('GET', '/api/decisions/x', none)).toBeNull()
  })

  test("what stays local is not the relay's: other settings, local sessions, other methods", () => {
    for (const [method, path] of [
      ['POST', '/api/settings'],
      ['POST', '/api/todos'],
      ['POST', '/api/profiles'],
      ['GET', '/api/feature-settings'],
      ['GET', '/api/categories'],
      ['GET', '/api/threads/a/b'],
      ['GET', '/api/time/x'],
      ['GET', '/api/calendar-reminders'],
      ['POST', '/api/board-slices'],
      ['GET', '/api/node-cli'],
      ['GET', '/api/board'],
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

describe('T4a groups (#780): time, calendar, journal, presence, their settings and the categories', () => {
  test('each route of the issue is the table, in its group', () => {
    for (const [method, path, group] of [
      ['GET', '/api/time', 'time'],
      ['POST', '/api/time', 'time'],
      ['GET', '/api/time-settings', 'time'],
      ['POST', '/api/time-settings', 'time'],
      ['GET', '/api/calendar', 'calendar'],
      ['POST', '/api/calendar', 'calendar'],
      ['GET', '/api/calendar-settings', 'calendar'],
      ['POST', '/api/calendar-settings', 'calendar'],
      ['POST', '/api/calendar-reminders', 'calendar'],
      ['GET', '/api/journal', 'journal'],
      ['POST', '/api/journal', 'journal'],
      ['GET', '/api/presence', 'presence'],
      ['POST', '/api/presence', 'presence'],
      ['POST', '/api/feature-settings', 'settings'],
      ['GET', '/api/threads-settings', 'settings'],
      ['POST', '/api/threads-settings', 'settings'],
      ['POST', '/api/categories', 'settings'],
    ] as const) {
      const m = relayMatch(method, path, none)
      expect(m?.kind === 'table' && m.entry.group).toBe(group)
      expect(m?.kind === 'table' && m.entry.relayOnly).toBeUndefined()
      expect(relayTablePath(method, path)).toBe(true)
    }
  })

  test('the two relay-only paths: the payload parts and a sessionless terminal', () => {
    const slices = relayMatch('GET', BOARD_SLICES_PATH, none)
    expect(slices?.kind === 'table' && slices.entry.relayOnly).toBe(true)
    const cli = relayMatch('POST', NODE_CLI_PATH, none)
    expect(cli?.kind === 'table' && cli.entry.relayOnly).toBe(true)
    // A keyed session path is not the table's, so it never passes localOnly by it.
    expect(relayTablePath('POST', '/api/session/@ben:p1/message')).toBe(false)
    expect(relayTablePath('GET', '/api/threads-settings/x')).toBe(false)
  })

  test('only the owner passes localOnly, and only for the settings of the features the master runs', () => {
    const owner = { kind: 'owner' } as const
    const session = { kind: 'session', key: 'k' } as const
    for (const path of RELAY_OWNER_SETTINGS) expect(relayOwnerSetting('POST', path, owner)).toBe(true)
    expect(relayOwnerSetting('GET', '/api/time-settings', owner)).toBe(true)
    expect(relayOwnerSetting('GET', '/api/time-settings', session)).toBe(false)
    expect(relayOwnerSetting('POST', '/api/time-settings', undefined)).toBe(false)
    // A table path that is no setting, and a setting that is no table path, pass nothing.
    expect(relayOwnerSetting('POST', '/api/presence', owner)).toBe(false)
    expect(relayOwnerSetting('GET', '/api/feature-settings', owner)).toBe(false)
    expect(relayOwnerSetting('POST', '/api/backup', owner)).toBe(false)
  })

  test("ownerCliOf takes the owner's few commands, with string arguments only", () => {
    expect(ownerCliOf({ cmd: 'presence', argv: ['away'] })).toEqual({ cmd: 'presence', argv: ['away'] })
    expect(ownerCliOf({ cmd: 'time', argv: [], lane: 'atlas' })).toEqual({ cmd: 'time', argv: [], lane: 'atlas' })
    expect(ownerCliOf({ cmd: 'time', argv: [], lane: null })).toEqual({ cmd: 'time', argv: [] })
    for (const lane of ['', 'x'.repeat(65), 'a\nb', 3]) expect(ownerCliOf({ cmd: 'time', argv: [], lane })).toBeNull()
    expect(ownerCliOf({ cmd: 'time', argv: ['list', '--json', 'ünï 100%'] })?.argv).toHaveLength(3)
    for (const cmd of OWNER_CLI_COMMANDS) expect(ownerCliOf({ cmd, argv: [] })?.cmd).toBe(cmd)
    for (const bad of [
      null,
      { cmd: 'thread', argv: [] },
      { cmd: 'send', argv: ['x'] },
      { cmd: 'presence' },
      { cmd: 'presence', argv: [1] },
      { cmd: 'presence', argv: ['a\u0000b'] },
      { cmd: 'presence', argv: Array.from({ length: 65 }, () => 'x') },
    ])
      expect(ownerCliOf(bad)).toBeNull()
  })

  test('boardSlicesOf keeps the four parts only, from an answer of that kind', () => {
    expect(
      boardSlicesOf({
        ok: true,
        slices: { time: { seq: 1, date: '2026-11-25', today: {} }, items: [], presence: null },
      }),
    ).toEqual({ time: { seq: 1, date: '2026-11-25', today: {} } })
    expect(boardSlicesOf({ ok: false, slices: {} })).toBeNull()
    expect(boardSlicesOf({ ok: true })).toBeNull()
    expect(slicesOf(null)).toEqual({})
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
