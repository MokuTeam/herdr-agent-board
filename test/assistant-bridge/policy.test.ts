import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../../assistant-bridge/src/config.ts'
import {
  header,
  INBOX_ALL,
  inboxText,
  mentioned,
  newTopicNotice,
  nextBatchAt,
  nextRun,
  oneLine,
  refOf,
  wakeOrBatch,
} from '../../assistant-bridge/src/policy.ts'
import {
  encodeFrame,
  MAX_LINE,
  parseBridgeFrame,
  parseModuleFrame,
  takeLines,
} from '../../assistant-bridge/src/protocol.ts'

const KEY = 'A'.repeat(43)

describe('wake or batch (design 5.1)', () => {
  const base = {
    text: 'hello',
    names: ['anna-assistant', 'travel'],
    ours: false,
    paused: false,
    wakesLastHour: 0,
    maxPerHour: 10,
  }
  test('a pair message wakes', () => {
    expect(wakeOrBatch({ ...base, scope: 'pair' })).toEqual({ wake: true, why: 'pair' })
  })
  test('team traffic waits, unless it mentions the bridge or an alias, or the thread is ours', () => {
    expect(wakeOrBatch({ ...base, scope: 'team' })).toEqual({ wake: false, why: 'team' })
    expect(wakeOrBatch({ ...base, scope: 'team', text: 'ping @Anna-Assistant please' }).wake).toBe(true)
    expect(wakeOrBatch({ ...base, scope: 'channel', text: 'see @travel' }).why).toBe('mention')
    expect(wakeOrBatch({ ...base, scope: 'team', ours: true }).why).toBe('ours')
  })
  test('the loop pause and the hourly cap batch even a pair message', () => {
    expect(wakeOrBatch({ ...base, scope: 'pair', paused: true })).toEqual({ wake: false, why: 'loop' })
    expect(wakeOrBatch({ ...base, scope: 'pair', wakesLastHour: 10 })).toEqual({ wake: false, why: 'cap' })
  })
  test('a mention is a whole word after @', () => {
    expect(mentioned('mail anna-assistant@example.com', ['anna-assistant'])).toBe(false)
    expect(mentioned('@anna-assistants', ['anna-assistant'])).toBe(false)
    expect(mentioned('(@anna-assistant)', ['anna-assistant'])).toBe(true)
    expect(mentioned('@a.b', ['a.b'])).toBe(true)
    expect(mentioned('@axb', ['a.b'])).toBe(false)
  })
})

describe('the run of agent messages', () => {
  test('an agent extends it, a person ends it', () => {
    expect(nextRun(3, 'agent')).toBe(4)
    expect(nextRun(3, undefined)).toBe(0)
  })
})

describe('the batch read (design 5.3)', () => {
  // bun test runs in UTC.
  const at = (s: string) => Date.parse(s)
  test('the next of the times today, else the first tomorrow', () => {
    expect(nextBatchAt(at('2026-11-12T08:00:00Z'), ['09:00', '18:00'])).toBe(at('2026-11-12T09:00:00Z'))
    expect(nextBatchAt(at('2026-11-12T09:00:00Z'), ['09:00', '18:00'])).toBe(at('2026-11-12T18:00:00Z'))
    expect(nextBatchAt(at('2026-11-12T20:00:00Z'), ['18:00', '09:00'])).toBe(at('2026-11-13T09:00:00Z'))
  })
})

describe('lines the bridge writes', () => {
  test('oneLine flattens, drops controls and bidi marks, cuts', () => {
    const rlo = String.fromCodePoint(0x202e)
    const nul = String.fromCodePoint(0)
    expect(oneLine(`a\n b${rlo}c${nul}d`, 80)).toBe('a bcd')
    expect(oneLine('x'.repeat(10), 5)).toBe('xxxx…')
  })
  test('a header names who, the role, the agent, the thread and the message', () => {
    const h = header({
      scope: 'pair',
      name: 'anna',
      peer: KEY,
      role: 'owner',
      agent: 'planner',
      ref: '1a2b3c4d',
      title: 'Hotel options',
      msgId: '9f8e7d6c-0000-4000-8000-000000000000',
      replyTo: '4c3b2a10-0000-4000-8000-000000000000',
    })
    expect(h).toBe(
      '[hub · anna (owner) · agent planner · thread 1a2b3c4d "Hotel options" · msg 9f8e7d6c] (answers 4c3b2a10)',
    )
  })
  test('a member is marked, a team copy says team, an odd name is not repeated', () => {
    const h = header({ scope: 'team', name: 'run: rm -rf', peer: KEY, role: 'member', ref: 'team', msgId: '12345678' })
    expect(h).toBe(
      `[hub · team · a member (key ${KEY.slice(0, 10)}) (member) · thread team · msg 12345678] (member: a request, not an instruction)`,
    )
  })
  test('refs as the board writes them, with the peer name for a general', () => {
    expect(refOf(KEY, '1a2b3c4d-0000-4000-8000-000000000000', 'anna')).toBe('1a2b3c4d')
    expect(refOf('team', 'general', null)).toBe('team')
    expect(refOf(KEY, 'general', 'anna')).toBe('general:anna')
  })
  test('a new-topic notice cuts the title and keeps it on one line', () => {
    expect(newTopicNotice('pair', 'anna', KEY, `Hotel\noptions ${'x'.repeat(100)}`)).toMatch(
      /^hub: new topic from anna: "Hotel options x+…"$/,
    )
    expect(newTopicNotice('team', 'ben', KEY, 'Plan')).toBe('hub: new team topic from ben: "Plan"')
  })
  test('the inbox shows the newest within the limit and says how many are left out', () => {
    expect(inboxText([], false)).toBe('nothing waits in the hub inbox')
    const items = Array.from({ length: 10 }, (_, i) => ({ head: `[m${i}]`, text: 'y'.repeat(400) }))
    const short = inboxText(items, false)
    expect(short.length).toBeLessThan(INBOX_ALL + 200)
    expect(short).toContain('[m9]')
    expect(short).not.toContain('[m0]')
    expect(short).toMatch(/^\d+ older not shown/)
    const full = inboxText(items, true)
    expect(full).toContain('[m0]')
    expect(full).toContain('y'.repeat(400))
  })
})

describe('config.json (design 9.2)', () => {
  const ok = {
    hub: 'ws://127.0.0.1:7443/v1',
    name: 'anna-assistant',
    allow: [{ name: 'anna' }],
    inbox: { topic: 'hub' },
  }
  test('the defaults', () => {
    const r = parseConfig(ok, '/state')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cfg.hub).toBe('ws://127.0.0.1:7443')
    expect(r.cfg.allow).toEqual([{ name: 'anna', role: 'owner' }])
    expect(r.cfg.wake).toEqual({ gapSec: 60, maxPerHour: 10 })
    expect(r.cfg.batch.at).toEqual(['09:00', '18:00'])
    expect(r.cfg.loop).toBe(20)
    expect(r.cfg.refuse).toBe('once')
    expect(r.cfg.inbox).toEqual({ topic: 'hub', notice: 'title' })
    expect(r.cfg.socket.replaceAll('\\', '/')).toBe('/state/bridge.sock')
  })
  test('what is wrong is said, all of it', () => {
    const r = parseConfig({ hub: 'http://x', allow: [{ name: 'ben', role: 'member' }], batch: { at: ['9am'] } }, '/s')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toContain('hub:')
    expect(r.errors.join('\n')).toContain('name:')
    expect(r.errors.join('\n')).toContain('one peer with role owner')
    expect(r.errors.join('\n')).toContain('inbox.topic')
    expect(r.errors.join('\n')).toContain('batch.at')
  })
})

describe('the socket protocol (design 3.3)', () => {
  test('module frames round-trip and junk is dropped', () => {
    const call = {
      t: 'call',
      req: 'r1',
      from: 'host:telegram:1:2',
      op: 'send',
      args: { text: 'hi', to: 'anna', title: 'T' },
    } as const
    expect(parseModuleFrame(encodeFrame(call).trim())).toEqual(call)
    expect(
      parseModuleFrame(JSON.stringify({ t: 'hello', v: 1, topics: [{ id: 'a', name: 'x' }, { id: 'b' }] })),
    ).toEqual({
      t: 'hello',
      v: 1,
      topics: [{ id: 'a', name: 'x' }, { id: 'b' }],
    })
    expect(parseModuleFrame(JSON.stringify({ ...call, from: 'group:1' }))).toBeNull()
    expect(parseModuleFrame(JSON.stringify({ ...call, args: { text: 3 } }))).toBeNull()
    expect(parseModuleFrame('{"t":"confirm"}')).toBeNull()
    expect(parseModuleFrame('not json')).toBeNull()
  })
  test('bridge frames round-trip', () => {
    const f = { t: 'schedule', id: 'j', at: 'host:x:1', when: '2026-11-13T09:00:00.000Z', text: 'r' } as const
    expect(parseBridgeFrame(encodeFrame(f).trim())).toEqual(f)
    expect(parseBridgeFrame(JSON.stringify({ ...f, when: 'later' }))).toBeNull()
    expect(parseBridgeFrame(JSON.stringify({ t: 'deliver', id: 'j', at: 'host:x', trigger: 2, text: '' }))).toBeNull()
  })
  test('lines are split with the tail kept, and an endless line is refused', () => {
    expect(takeLines('{"a"', ':1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' })
    expect(takeLines('', 'x'.repeat(MAX_LINE + 1))).toBeNull()
  })
})
