// The master door's allowlist (core/node-door.ts, docs/design/nodes 6.2): what a master may call,
// and the refusal of the rest, checked on the path as it came and decoded. Every route of the
// board's real table is classified in test/server/node-door.test.ts.
import { describe, expect, test } from 'bun:test'
import { DOOR_ROUTES, doorRefusal, doorRoute, loopbackHost, NODE_API } from '../../src/core/node-door.ts'

/** The door's answer to a request as it came: null, or its refusal. */
const refusal = (method: string, raw: string) => doorRefusal(method, raw, decodeURIComponent(raw))
const NOT_FOUND = { status: 404, error: 'not found' } as const

describe('the door takes what 6.2 lists', () => {
  test('the payload, the card and its sheet, the bulk actions', () => {
    for (const [method, raw] of [
      ['GET', '/api/hello'],
      ['GET', '/api/events'],
      ['GET', '/api/board'],
      ['GET', '/api/session/s1'],
      ['GET', '/api/session/s1/changes'],
      ['GET', '/api/session/s1/history'],
      ['GET', '/api/session/s1/meter'],
      ...[
        'answer',
        'permit',
        'stop',
        'sendnow',
        'message',
        'wake',
        'sleep',
        'restart',
        'rename',
        'workspace',
        'card',
        'archive',
        'fork',
        'aside',
      ].map(a => ['POST', `/api/session/s1/${a}`]),
      ['POST', '/api/sleep'],
      ['POST', '/api/move'],
      ['POST', '/api/archive'],
      ['POST', '/api/todos'],
      ['GET', '/api/term/s1/agent/stream'],
      ['GET', '/api/term/s1/shell/stream'],
      ['POST', '/api/term/s1/shell/input'],
      ['POST', '/api/term/s1/agent/open'],
      ['POST', '/api/term/s1/agent/close'],
      ['POST', '/api/fs/stat'],
      ['POST', '/api/fs/preview'],
      ['POST', '/api/fs/dirs'],
      ['GET', '/api/fs/raw'],
      ['GET', '/api/fs/download'],
      ['GET', '/uploads/2026-11-21/a.png'],
      ['POST', '/api/upload'],
      ['POST', '/api/schedule'],
      ['POST', '/api/secret/0123456789ab'],
      ['GET', '/api/launch/options'],
      ['POST', '/api/launch/l-1/trust'],
      ['POST', '/api/launch/l-1/dismiss'],
      ['GET', '/api/node/status'],
    ] as const)
      expect([method, raw, refusal(method, raw)]).toEqual([method, raw, null])
  })

  test("keys as the board's own routes take them: a pi session's file, a Windows path, spaces, Cyrillic, %", () => {
    for (const key of [
      'c0ffee00-1234-4abc-8def-0123456789ab',
      'pane-12',
      'C:\\Users\\owner\\.pi\\sessions\\2026 11\\a.jsonl',
      '/home/owner/.pi/sessions/a b.jsonl',
      'Атлас 12',
      '100% done',
    ]) {
      const raw = `/api/session/${encodeURIComponent(key)}/wake`
      expect([key, refusal('POST', raw)]).toEqual([key, null])
      expect([key, refusal('GET', `/api/term/${encodeURIComponent(key)}/agent/stream`)]).toEqual([key, null])
    }
  })

  test("the API version is 1, and the status, a start from the master (#504) and the bundle's routes (#506) are the door's own", () => {
    expect(NODE_API).toBe(1)
    expect(DOOR_ROUTES.filter(r => r.door).map(r => [r.method, String(r.path)])).toEqual([
      ['GET', '/api/node/status'],
      ['POST', '/api/node/launch'],
      ['GET', String(/^\/api\/node\/bundle\/[^/]+$/)],
      ['PUT', String(/^\/api\/node\/bundle\/[^/]+\/blob\/[0-9a-f]{64}$/)],
      ['POST', String(/^\/api\/node\/bundle\/[^/]+\/commit$/)],
    ])
    // Not as a GET, nor spelled otherwise.
    expect(refusal('GET', '/api/node/launch')).toEqual(NOT_FOUND)
    expect(refusal('POST', '/api/node/%6Caunch')).toEqual(NOT_FOUND)
  })

  test("the bundle's routes (#506): each by its method only, a blob by a SHA-256 only", () => {
    const sha = 'a'.repeat(64)
    expect(doorRefusal('GET', '/api/node/bundle/default', '/api/node/bundle/default')).toBeNull()
    expect(
      doorRefusal('PUT', `/api/node/bundle/default/blob/${sha}`, `/api/node/bundle/default/blob/${sha}`),
    ).toBeNull()
    expect(doorRefusal('POST', '/api/node/bundle/default/commit', '/api/node/bundle/default/commit')).toBeNull()
    for (const [method, raw] of [
      ['POST', '/api/node/bundle/default'],
      ['GET', '/api/node/bundle/default/commit'],
      ['POST', `/api/node/bundle/default/blob/${sha}`],
      ['PUT', '/api/node/bundle/default/blob/nope'],
      ['PUT', `/api/node/bundle/default/blob/${sha.toUpperCase()}`],
      ['GET', '/api/node/bundle/a/b'],
      ['GET', '/api/node/bundle/'],
    ] as const)
      expect([method, raw, doorRefusal(method, raw, raw)]).toEqual([method, raw, { status: 404, error: 'not found' }])
  })
})

describe('everything else is 404, whatever the spelling', () => {
  test("what acts on this computer's screen", () => {
    for (const [method, raw] of [
      ['POST', '/api/fs/open'],
      ['POST', '/api/open-url'],
      ['POST', '/api/reveal'],
      ['POST', '/api/session/s1/focus'],
      ['POST', '/api/term/s1/shell/focus'],
      ['POST', '/api/term/s1/agent/focus'],
      ['POST', '/api/launch/l1/focus'],
    ] as const)
      expect([method, raw, refusal(method, raw)]).toEqual([method, raw, NOT_FOUND])
  })

  test('an encoded letter is no way past it', () => {
    for (const [method, raw] of [
      ['POST', '/api/fs/%6Fpen'],
      ['GET', '/api/%72emote'],
      ['POST', '/api/%72emote'],
      ['POST', '/api/fs/%73tat'],
      ['GET', '/api/%62oard'],
      ['POST', '/api/session/s1/%77ake'],
      ['GET', '/api/node/%73tatus'],
      ['POST', '/api/session/s1/foc%75s'],
      ['GET', '/api/term/s1/agent/%73tream'],
      ['POST', '/api/term/s1/shell/f%6Fcus'],
    ] as const)
      expect([method, raw, refusal(method, raw)]).toEqual([method, raw, NOT_FOUND])
  })

  test('what is for the board on this computer only, and the routes of later tasks', () => {
    for (const [method, raw] of [
      ['GET', '/api/remote'],
      ['POST', '/api/remote'],
      ['GET', '/api/access'],
      ['GET', '/api/process'],
      ['GET', '/api/team'],
      ['GET', '/api/threads'],
      ['POST', '/api/launch'],
      ['POST', '/api/launch/l1/close'],
      ['GET', '/api/archive'],
      ['GET', '/api/session/s1/helper/h1'],
      ['POST', '/api/session/s1/mokupilot'],
      ['POST', '/api/node/claim'],
      ['POST', '/api/node/leave'],
      ['GET', '/api/node/uplink'],
      ['GET', '/'],
      ['GET', '/app.js'],
    ] as const)
      expect([method, raw, refusal(method, raw)]).toEqual([method, raw, NOT_FOUND])
  })

  test('a listed path with another method, and a method the board has no route for', () => {
    expect(refusal('POST', '/api/board')).toEqual(NOT_FOUND)
    expect(refusal('GET', '/api/sleep')).toEqual(NOT_FOUND)
    expect(refusal('POST', '/api/term/s1/agent/stream')).toEqual(NOT_FOUND)
    expect(refusal('GET', '/api/term/s1/agent/input')).toEqual(NOT_FOUND)
    expect(refusal('HEAD', '/api/board')).toEqual(NOT_FOUND)
    expect(refusal('PUT', '/api/upload')).toEqual(NOT_FOUND)
    expect(refusal('DELETE', '/api/session/s1')).toEqual(NOT_FOUND)
  })

  test('a string route must be both spellings; a path that decodes to another is refused', () => {
    expect(doorRoute('GET', '/api/board', '/api/board')).not.toBeNull()
    expect(doorRoute('GET', '/api/board', '/api/remote')).toBeNull()
    expect(doorRoute('GET', '/api/%62oard', '/api/board')).toBeNull()
    expect(refusal('GET', '/api/board/')).toEqual(NOT_FOUND)
    expect(refusal('GET', '/api/session/a/b/changes')).toEqual(NOT_FOUND)
  })
})

test("the door's Host: a loopback name with any port or none; nothing else", () => {
  for (const host of [
    '127.0.0.1:12430',
    '127.0.0.1:50123',
    '127.0.0.1',
    'localhost:1',
    'localhost',
    '[::1]:12430',
    '[::1]',
  ])
    expect([host, loopbackHost(host)]).toEqual([host, true])
  for (const host of [
    '',
    ':12430',
    'evil.example:12430',
    '127.0.0.1.evil.example:12430',
    'localhost.evil.example',
    '127.0.0.2:12430',
    '[::2]:12430',
    '::1:12430',
    '127.0.0.1:12430:1',
    '127.0.0.1:abc',
    '127.0.0.1:123456',
    'user@127.0.0.1:12430',
  ])
    expect([host, loopbackHost(host)]).toEqual([host, false])
})
