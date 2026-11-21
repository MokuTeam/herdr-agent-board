// What the master sends on to a node (#501, core/node-proxy.ts): which paths name another device's
// key, in both spellings, for the keys every setup makes (a Claude session id, pane-<id>, a pi file
// path on Windows and POSIX, names with spaces, other alphabets and %); that no local key is one;
// the path the node gets; what is refused as desktop; a bulk request split by device and its
// outcomes put back under the keys the master asked for, in the order asked.
import { describe, expect, test } from 'bun:test'
import {
  answerHeaders,
  desktopRest,
  deviceKey,
  inAskedOrder,
  keyedPath,
  nodePath,
  nodeQuery,
  pickHeaders,
  rekeyOutcome,
  splitTargets,
} from '../../src/core/node-proxy.ts'
import { nodeKey } from '../../src/core/nodes.ts'

const SID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const KEYS = [
  SID,
  'pane-12',
  'C:\\Users\\Анна Мария\\.pi\\sessions\\100% done.jsonl',
  '/home/anna maria/.pi/sessions/план 100%.jsonl',
]

describe('keyedPath', () => {
  test('a node key in the path, encoded or as it is, gives the device and the node own key', () => {
    for (const key of KEYS) {
      const k = nodeKey('server-1', key)
      for (const seg of [encodeURIComponent(k), k.includes('/') || k.includes('%') ? null : k]) {
        if (seg === null) continue
        expect(keyedPath(`/api/session/${seg}/message`)).toEqual({
          area: 'session',
          device: 'server-1',
          key,
          rest: '/message',
        })
      }
      expect(keyedPath(`/api/term/${encodeURIComponent(k)}/agent/stream`)?.key).toBe(key)
      expect(keyedPath(`/api/session/${encodeURIComponent(k)}`)?.rest).toBe('')
    }
    expect(keyedPath('/api/session/%40server-1%3As1/history')).toEqual({
      area: 'session',
      device: 'server-1',
      key: 's1',
      rest: '/history',
    })
    expect(keyedPath('/api/launch/%40server-2%3Al1/trust')).toEqual({
      area: 'launch',
      device: 'server-2',
      key: 'l1',
      rest: '/trust',
    })
  })

  test('no key this board makes is a node key; nor is a path that does not decode or another route', () => {
    for (const key of KEYS) {
      expect(keyedPath(`/api/session/${encodeURIComponent(key)}/message`)).toBeNull()
      expect(keyedPath(`/api/term/${encodeURIComponent(key)}/agent/stream`)).toBeNull()
    }
    expect(keyedPath('/api/launch/options')).toBeNull()
    expect(keyedPath('/api/session/%E0%A4%A/message')).toBeNull()
    expect(keyedPath('/api/session/@local:s1')).toBeNull()
    expect(keyedPath('/api/session/@Server-1:s1')).toBeNull()
    expect(keyedPath('/api/session/@server-1:')).toBeNull()
    expect(keyedPath('/api/sessions/@server-1:s1')).toBeNull()
    expect(keyedPath('/api/fs/raw')).toBeNull()
  })

  test('the node is sent its own key, one encoded segment, whatever it holds', () => {
    for (const key of KEYS) {
      const p = keyedPath(`/api/session/${encodeURIComponent(nodeKey('server-1', key))}/card`)
      if (!p) throw new Error('no path')
      const sent = nodePath(p)
      expect(sent).toBe(`/api/session/${encodeURIComponent(key)}/card`)
      expect(sent.split('/')).toHaveLength(5)
      expect(decodeURIComponent(sent.split('/')[3] ?? '')).toBe(key)
    }
  })
})

test('desktop: a pane, a launch tab and a shell tab focused there; nothing else', () => {
  expect(desktopRest('session', '/focus')).toBe(true)
  expect(desktopRest('term', '/shell/focus')).toBe(true)
  expect(desktopRest('launch', '/focus')).toBe(true)
  for (const rest of ['', '/message', '/wake', '/history', '/card'])
    expect([rest, desktopRest('session', rest)]).toEqual([rest, false])
  expect(desktopRest('term', '/agent/stream')).toBe(false)
  expect(desktopRest('term', '/shell/open')).toBe(false)
  expect(desktopRest('launch', '/trust')).toBe(false)
})

test('deviceKey: only a string with a device prefix', () => {
  expect(deviceKey('@server-1:pane-1')).toEqual({ device: 'server-1', key: 'pane-1' })
  for (const v of [SID, 'pane-1', '', null, undefined, 3, ['@server-1:x'], { key: '@server-1:x' }])
    expect(deviceKey(v)).toBeNull()
})

test('splitTargets: local targets as they came, each device its own keys, in order', () => {
  const s = splitTargets(['pane-1', '@server-1:pane-1', 'Atlas', '@server-2:s2', '@server-1:s1', 7])
  expect(s.local).toEqual(['pane-1', 'Atlas', 7])
  expect([...s.devices]).toEqual([
    [
      'server-1',
      [
        { asked: '@server-1:pane-1', key: 'pane-1' },
        { asked: '@server-1:s1', key: 's1' },
      ],
    ],
    ['server-2', [{ asked: '@server-2:s2', key: 's2' }]],
  ])
  expect(splitTargets(['pane-1', SID]).devices.size).toBe(0)
})

describe('rekeyOutcome', () => {
  const asked = [{ asked: '@server-1:pane-1', key: 'pane-1' }]
  test('a sleep outcome: target as asked, key and entry id prefixed', () => {
    expect(
      rekeyOutcome('server-1', { target: 'pane-1', key: 'pane-1', name: 'p', result: 'scheduled', id: 'a1b2' }, asked),
    ).toEqual({
      target: '@server-1:pane-1',
      key: '@server-1:pane-1',
      name: 'p',
      result: 'scheduled',
      id: '@server-1:a1b2',
    })
  })
  test('a move outcome with its sleep; an archive entry; a target the node made up', () => {
    expect(
      rekeyOutcome(
        'server-1',
        { target: 'pane-1', result: 'scheduled', sleep: { target: 'pane-1', key: 'pane-1', id: 'e1' } },
        asked,
      ),
    ).toEqual({
      target: '@server-1:pane-1',
      result: 'scheduled',
      sleep: { target: '@server-1:pane-1', key: '@server-1:pane-1', id: '@server-1:e1' },
    })
    expect(rekeyOutcome('server-1', { key: 'pane-1', name: 'p', closeAt: 5 }, asked)).toEqual({
      key: '@server-1:pane-1',
      name: 'p',
      closeAt: 5,
    })
    expect(rekeyOutcome('server-1', { target: 'other', result: 'kept' }, asked)?.target).toBe('@server-1:other')
  })
  test('a key the node prefixed itself, an empty one, and what is no outcome are left as they are', () => {
    expect(rekeyOutcome('server-1', { key: '@server-2:x', id: '' }, asked)).toEqual({ key: '@server-2:x', id: '' })
    expect(rekeyOutcome('server-1', null, asked)).toBeNull()
    expect(rekeyOutcome('server-1', 'pane-1', asked)).toBeNull()
  })
})

test('inAskedOrder: by the target asked, one not asked last, ties as they came', () => {
  const asked = ['b', '@server-1:a', 'c']
  const out = inAskedOrder(
    asked,
    [{ target: 'c' }, { target: 'zz' }, { target: '@server-1:a' }, { target: 'b' }],
    'target',
  )
  expect(out.map(o => o.target)).toEqual(['b', '@server-1:a', 'c', 'zz'])
})

test('nodeQuery and pickHeaders: what the node reads, nothing else', () => {
  const q = new URLSearchParams({ key: '@server-1:p', path: 'C:\\a b\\план 100%.png', t: 'master-token' })
  const sent = nodeQuery(q, ['key'], { t: 'node-token' })
  const back = new URLSearchParams(sent.slice(1))
  expect([...back]).toEqual([
    ['path', 'C:\\a b\\план 100%.png'],
    ['t', 'node-token'],
  ])
  expect(nodeQuery(new URLSearchParams({ key: 'x' }), ['key'])).toBe('')
  const h = pickHeaders(
    new Headers({
      cookie: 'a=b',
      authorization: 'Bearer x',
      origin: 'https://evil',
      'content-type': 'text/plain',
      range: 'bytes=0-1',
    }),
    ['content-type', 'x-filename', 'range', 'accept'],
  )
  expect([...h]).toEqual([
    ['content-type', 'text/plain'],
    ['range', 'bytes=0-1'],
  ])
})

describe('answerHeaders: a node answer never runs as a page of the master', () => {
  const of = (h: Record<string, string>) => Object.fromEntries(answerHeaders(new Headers(h)))
  test('JSON and an event stream as they are, never sniffed; no cookie or hop header', () => {
    expect(of({ 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'a=b', connection: 'close' })).toEqual(
      {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    )
    expect(of({ 'content-type': 'text/event-stream', 'cache-control': 'no-store' })).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
  })
  test("media keeps the node's strict policy; a lax one or none is a sandbox", () => {
    const pdf = "default-src 'none'; frame-ancestors 'self'"
    expect(of({ 'content-type': 'application/pdf', 'content-security-policy': pdf })['content-security-policy']).toBe(
      pdf,
    )
    expect(of({ 'content-type': 'image/png' })['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(of({ 'content-type': 'image/svg+xml', 'content-security-policy': "script-src 'unsafe-inline'" })).toEqual({
      'content-type': 'image/svg+xml',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    })
  })
  test('a page or anything the board does not show goes as a download', () => {
    for (const type of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'application/javascript', ''])
      expect([type, of(type ? { 'content-type': type } : {})['content-disposition']]).toEqual([type, 'attachment'])
    expect(of({ 'content-type': 'image/png', 'content-disposition': 'inline' })['content-disposition']).toBe('inline')
  })
})
