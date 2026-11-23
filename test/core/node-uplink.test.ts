// A call from a node and its result as the link carries them (#508, core/node-uplink.ts): read field
// by field on both sides, a file by its number and name only, never a path.
import { describe, expect, test } from 'bun:test'
import {
  fileTooBig,
  KEPT_SUBS,
  NOT_FROM_NODE,
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
  expect([...UPLINK_COMMANDS]).toEqual(['thread', 'threads', 'send', 'agents'])
  expect([...KEPT_SUBS].sort()).toEqual(['ask', 'done', 'new', 'post', 'set', 'unwatch', 'watch'])
  expect(Object.keys(NOT_FROM_NODE).sort()).toEqual(['import', 'open', 'share'])
  expect(fileTooBig('r.md', 5 * 1024 * 1024)).toBeNull()
  expect(fileTooBig('r.md', 5 * 1024 * 1024 + 1)).toBe('r.md: 6 MB; 5 MB at most on a local thread')
})
