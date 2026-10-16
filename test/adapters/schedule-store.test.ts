import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scheduleDir } from '../../src/adapters/paths.ts'
import {
  addEntry,
  getEntry,
  listEntries,
  logRun,
  readLog,
  removeEntry,
  updateEntry,
} from '../../src/adapters/schedule-store.ts'
import { MAX_PER_SESSION } from '../../src/core/schedule-rules.ts'
import { isolatedHome } from '../support/env.ts'

const base = { key: 's1', name: 'Name', text: 'ping', at: 5, next: 5 }

test('addEntry stores a cleaned entry under a fresh id; list is soonest first', () => {
  isolatedHome()
  const late = addEntry({ ...base, next: 20 })
  const early = addEntry({ ...base, text: 'a\u0007b', next: 10 })
  assert.match(early.id, /^[0-9a-f]{6}$/)
  assert.equal(early.text, 'ab')
  assert.deepEqual(
    listEntries().map(e => e.id),
    [early.id, late.id],
  )
  assert.equal(getEntry(early.id)?.text, 'ab')
  assert.equal(getEntry('zzzzzz'), null)
})

test('addEntry refuses past the per-session limit', () => {
  isolatedHome()
  for (let i = 0; i < MAX_PER_SESSION; i++) addEntry(base)
  assert.throws(() => addEntry(base), /entries already/)
  addEntry({ ...base, key: 's2' })
})

test('updateEntry keeps fields it does not know', () => {
  isolatedHome()
  const e = addEntry(base)
  const file = join(scheduleDir(), `${e.id}.json`)
  writeFileSync(file, JSON.stringify({ ...e, futureField: 'keep' }))
  const next = updateEntry(e.id, cur => ({ ...cur, next: 99 }))
  assert.equal(next?.next, 99)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.futureField, 'keep')
  assert.equal(saved.next, 99)
  assert.equal(
    updateEntry('abcdef', cur => cur),
    undefined,
  )
  assert.equal(
    updateEntry('bad', cur => cur),
    undefined,
  )
})

test('removeEntry returns the entry once, then null', () => {
  isolatedHome()
  const e = addEntry(base)
  assert.equal(removeEntry(e.id)?.id, e.id)
  assert.equal(removeEntry(e.id), null)
  assert.deepEqual(listEntries(), [])
})

test('the log lists the newest runs first', () => {
  isolatedHome()
  for (let i = 0; i < 5; i++) logRun({ n: i })
  assert.deepEqual(readLog(2), [{ n: 4 }, { n: 3 }])
})
