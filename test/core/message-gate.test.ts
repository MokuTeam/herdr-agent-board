import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { messageGate } from '../../src/core/message-gate.ts'

test('duplicate clicks and completed replays send once; other sessions remain independent', async () => {
  const gate = messageGate()
  let release: () => void = () => {}
  let calls = 0
  const action = async () => {
    calls++
    await new Promise<void>(r => {
      release = r
    })
    return { ok: true }
  }
  const first = gate('a', 'id-1', ['a', 'text'], action)
  const duplicate = gate('a', 'id-1', ['a', 'text'], action)
  assert.equal((await gate('a', 'id-2', ['a', 'new'], action)).ok, false)
  assert.equal((await gate('b', 'id-1', ['b', 'text'], async () => ({ ok: true }))).ok, true)
  await Promise.resolve()
  release()
  await Promise.all([first, duplicate])
  assert.equal(calls, 1)
  assert.equal((await gate('a', 'id-1', ['a', 'text'], action)).ok, true)
  assert.equal(calls, 1)
  assert.equal((await gate('a', 'id-1', ['a', 'changed'], action)).ok, false)
})

test('interrupted preflight releases the guard', async () => {
  const gate = messageGate()
  await assert.rejects(
    gate('a', 'id', [], async () => {
      throw new Error('offline')
    }),
    /offline/,
  )
  assert.equal((await gate('a', 'new', [], async () => ({ ok: true }))).ok, true)
})

test('a request id must be a short token', async () => {
  const gate = messageGate()
  for (const id of [undefined, 7, '', 'has space', 'x'.repeat(81)]) {
    assert.equal((await gate('a', id, [], async () => ({ ok: true }))).ok, false)
  }
})
