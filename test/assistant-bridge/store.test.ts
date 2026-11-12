import { describe, expect, test } from 'bun:test'
import { openStore } from '../../assistant-bridge/src/store.ts'

// Rows made in the same millisecond (held messages released in one loop, a new topic's notice and its
// delivery) come out in the order they were made, not by their random ids (#406). The ids below sort
// against that order on purpose.
const AT = Date.parse('2026-11-12T10:00:00Z')
const IDS = [
  'ffffffff-0000-4000-8000-000000000003',
  'bbbbbbbb-0000-4000-8000-000000000002',
  '11111111-0000-4000-8000-000000000001',
]

describe('rows of the same millisecond keep the order they were made in', () => {
  test("the module's jobs", () => {
    const store = openStore(':memory:')
    for (const id of IDS)
      store.addJob({ id, kind: 'deliver', location: 'host:inbox', trigger: 1, text: id, due: AT, createdAt: AT })
    expect(store.openJobs().map(j => j.id)).toEqual(IDS)
    store.close()
  })

  test('messages by state', () => {
    const store = openStore(':memory:')
    for (const id of IDS)
      store.addMessage({
        id,
        thread: 'peer/general',
        dir: 'in',
        peer: 'peer',
        name: 'anna',
        via: null,
        agent: null,
        text: id,
        replyTo: null,
        ts: new Date(AT).toISOString(),
        at: AT,
        state: 'held',
        location: null,
      })
    expect(store.byState(['held'], null).map(m => m.id)).toEqual(IDS)
    store.close()
  })

  test('the outbox', () => {
    const store = openStore(':memory:')
    for (const id of IDS) store.addOut({ id, to: 'peer', env: '{}', state: 'queued', at: AT })
    expect(store.unsettled().map(o => o.id)).toEqual(IDS)
    store.close()
  })
})
