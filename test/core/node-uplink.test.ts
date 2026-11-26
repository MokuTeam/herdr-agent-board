// A call from a node and its result as the link carries them (#508, core/node-uplink.ts): read field
// by field on both sides, a file by its number and name only, never a path.
import { describe, expect, test } from 'bun:test'
import {
  CAL_WRITE_SUBS,
  fileTooBig,
  isKeptCall,
  isRememberedCall,
  isSlowCall,
  KEPT_SUBS,
  NOT_FROM_NODE,
  TEAM_NOT_FROM_NODE,
  TIME_WRITE_SUBS,
  teamRefusal,
  UPLINK_COMMANDS,
  uplinkCallOf,
  uplinkResultOf,
} from '../../src/core/node-uplink.ts'

const SHA = 'a'.repeat(64)
const call = {
  id: '5d0c6a1e-77',
  cmd: 'thread',
  argv: ['post', 'atlas-1', '--file', '/w/r.md', 'note'],
  session: 's-1',
  lane: 'atlas',
  files: [{ n: 0, name: 'r.md', size: 3, sha256: SHA }],
}

describe('a call', () => {
  test('one as the node sends it is taken; no lane and no files are fine', () => {
    expect(uplinkCallOf(call)).toEqual(call)
    expect(uplinkCallOf({ ...call, claimed: true })).toEqual({ ...call, claimed: true })
    const { lane: _l, files: _f, ...bare } = call
    expect(uplinkCallOf(bare)).toEqual({ ...bare, lane: null, files: [] })
  })

  test('anything else is not one', () => {
    for (const bad of [
      null,
      [],
      { ...call, id: '../x' },
      { ...call, id: 'a'.repeat(65) },
      { ...call, argv: 'post' },
      { ...call, argv: [1] },
      { ...call, session: 7 },
      { ...call, session: 's-1\u001b[2J' },
      { ...call, files: [{ ...call.files[0], name: 'a:b' }] },
      { ...call, files: [{ ...call.files[0], name: 'r\u0000.md' }] },
      { ...call, lane: 3 },
      { ...call, files: [{ ...call.files[0], name: '../r.md' }] },
      { ...call, files: [{ ...call.files[0], name: 'C:\\r.md' }] },
      { ...call, files: [{ ...call.files[0], name: '..' }] },
      { ...call, files: [{ ...call.files[0], n: 5 }] },
      { ...call, files: [{ ...call.files[0], size: -1 }] },
      { ...call, files: [{ ...call.files[0], sha256: 'xyz' }] },
      { ...call, files: [call.files[0], call.files[0]] },
      { ...call, files: Array.from({ length: 6 }, (_, n) => ({ ...call.files[0], n })) },
      { ...call, claimed: 'yes' },
    ])
      expect(uplinkCallOf(bad)).toBeNull()
  })
})

test('a result: an exit code and lines', () => {
  expect(uplinkResultOf({ code: 0, out: ['ok'], err: [] })).toEqual({ code: 0, out: ['ok'], err: [] })
  for (const bad of [
    null,
    { code: 1.5, out: [], err: [] },
    { code: 0, out: 'ok', err: [] },
    { code: 300, out: [], err: [] },
  ])
    expect(uplinkResultOf(bad)).toBeNull()
})

test('what the master takes, what a node keeps, and what is never run for a node', () => {
  expect([...UPLINK_COMMANDS]).toEqual([
    'thread',
    'threads',
    'send',
    'agents',
    'time',
    'cal',
    'team',
    'decisions',
    'journal',
    'presence',
    'away',
    'cats',
    'list',
    'remind',
    'every',
    'unschedule',
    'schedule',
    'spawn',
    'ask',
  ])
  // A node's `board schedule` (#806) is a read: neither kept nor remembered.
  expect(isKeptCall('schedule', [])).toBe(false)
  expect(isRememberedCall('schedule', [])).toBe(false)
  expect(UPLINK_COMMANDS.has('spend')).toBe(false)
  expect([...KEPT_SUBS].sort()).toEqual(['ask', 'done', 'new', 'post', 'set', 'unwatch', 'watch'])
  expect([...TIME_WRITE_SUBS].sort()).toEqual(['add', 'edit', 'import', 'move', 'post', 'restore', 'rm', 'unpost'])
  expect([...CAL_WRITE_SUBS].sort()).toEqual(['add', 'edit', 'push', 'rm'])
  expect(Object.keys(NOT_FROM_NODE).sort()).toEqual(['import', 'open', 'share'])
  expect(Object.keys(TEAM_NOT_FROM_NODE).sort()).toEqual(['join', 'watch'])
  expect(teamRefusal(['join', 'x'])).toContain('board team join')
  expect(teamRefusal(['watch'])).toContain('board team watch')
  expect(teamRefusal(['listen'])).toContain('owner to confirm')
  expect(teamRefusal(['listen', 'off'])).toBeNull()
  expect(teamRefusal(['loop', 'anna'])).toBeNull()
  expect(teamRefusal(['loop', 'anna', '5'])).toContain('owner to confirm')
  expect(isKeptCall('thread', ['post', 'k'])).toBe(true)
  // A thread ask with options (#784): never kept to go later without them; still one decision when sent again.
  expect(isKeptCall('thread', ['ask', 'k', 'q'])).toBe(true)
  expect(isKeptCall('thread', ['ask', 'k', 'q', '--option', 'a', '--option', 'b'])).toBe(false)
  expect(isKeptCall('thread', ['ask', 'k', 'q', '--default-after', '1h'])).toBe(false)
  expect(isKeptCall('thread', ['ask', 'k', '--', 'q with --option x'])).toBe(true)
  expect(isRememberedCall('thread', ['ask', 'k', 'q', '--option', 'a'])).toBe(true)
  expect(isRememberedCall('thread', ['ask', 'k', 'q'])).toBe(true)
  expect(isKeptCall('team', ['draft', 'anna', 'hi'])).toBe(true)
  expect(isKeptCall('team', ['post', 'anna', 'hi'])).toBe(false)
  expect(isRememberedCall('cal', ['add'])).toBe(true)
  expect(isRememberedCall('cal', ['list'])).toBe(false)
  expect(isSlowCall('cal', ['sync'])).toBe(true)
  expect(isSlowCall('cal', ['add'])).toBe(true)
  expect(isSlowCall('cal', ['list'])).toBe(false)
  expect(isSlowCall('team', ['post'])).toBe(true)
  expect(isSlowCall('team', ['draft'])).toBe(false)
  expect(isSlowCall('time', ['post'])).toBe(true)
  expect(isSlowCall('time', ['list'])).toBe(false)
  expect(isRememberedCall('team', ['thread', 'k', '--read'])).toBe(true)
  expect(isRememberedCall('team', ['thread', 'k'])).toBe(false)
  expect(isRememberedCall('team', ['thread', 'k', '--', '--read'])).toBe(false)
  expect(isRememberedCall('presence', ['away'])).toBe(true)
  expect(isRememberedCall('presence', [])).toBe(false)
  expect(isRememberedCall('away', [])).toBe(true)
  expect(isRememberedCall('remind', ['--session', 'x', 'in 5m', 'hi'])).toBe(true)
  expect(isRememberedCall('every', ['--session', 'x', '0 * * * *', 'hi'])).toBe(true)
  expect(isRememberedCall('unschedule', ['abc123'])).toBe(true)
  expect(fileTooBig('r.md', 5 * 1024 * 1024)).toBeNull()
  expect(fileTooBig('r.md', 5 * 1024 * 1024 + 1)).toBe('r.md: 6 MB; 5 MB at most on a local thread')
  expect(fileTooBig('f.txt', 5 * 1024 * 1024 + 1, 'team')).toBe('f.txt: 6 MB; 5 MB at most from a node')
  expect(fileTooBig('e.json', 5 * 1024 * 1024 + 1, 'cal')).toBe('e.json: 6 MB; 5 MB at most from a node')
})
