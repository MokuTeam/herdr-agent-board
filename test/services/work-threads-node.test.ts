// Thread watcher notices and carryWatches for node sessions (#869).
import { expect, test } from 'bun:test'
import { openDb } from '../../src/adapters/db.ts'
import { listEntries } from '../../src/adapters/schedule-store.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { carryWatches, newThread, postEntry, tellWatchers, watch } from '../../src/services/work-threads.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-26T10:00:00Z')
const CFG = { agents: true, gapSec: 60, share: true }
const BARE = '44444444-5555-4666-8777-888888888888'
const NEXT_BARE = '55555555-6666-4777-8888-999999999999'
const WORKER: Party = { kind: 'session', key: 'worker-1', name: 'worker' }

test('tellWatchers and carryWatches use resolveKey for schedule entries while preserving local parity (#869)', () => {
  isolatedHome()
  const db = openDb({ create: true })
  if (!db) throw new Error('openDb failed')
  try {
    const resolveKey = (k: string) => (k === BARE || k === NEXT_BARE ? `@laptop:${k}` : k)
    const watcher: Party = { kind: 'session', key: BARE, name: 'node-day' }
    const created = newThread(
      { db, cfg: CFG, actor: watcher, now: NOW, resolveKey },
      { lane: 'atlas', title: 'Node watch test', to: WORKER, doing: true },
    )
    const posted = postEntry({ db, cfg: CFG, actor: WORKER, now: NOW + 1000, resolveKey }, created.head, {
      status: 'done',
      summary: 'done on worker',
    })
    expect(posted.told).toEqual([BARE])
    expect(
      listEntries()
        .filter(e => e.by === 'threads')
        .map(e => e.key),
    ).toEqual([`@laptop:${BARE}`])

    // Without resolveKey (non-node board), tellWatchers keeps the bare key as before.
    const localWatcher: Party = { kind: 'session', key: 'local-watcher', name: 'local-day' }
    watch(
      { db, cfg: CFG, actor: localWatcher, now: NOW },
      { session: localWatcher, target: created.head.id, what: 'all', idle: false, wake: false },
    )
    const posted2 = postEntry({ db, cfg: CFG, actor: WORKER, now: NOW + 2000 }, posted.head, { text: 'follow-up' })
    expect(posted2.told).toContain('local-watcher')
    expect(listEntries().some(e => e.by === 'threads' && e.key === 'local-watcher')).toBe(true)

    // carryWatches resolves the destination key when moving a pending entry.
    postEntry({ db, cfg: CFG, actor: WORKER, now: NOW + 3000, resolveKey }, posted2.head, { text: 'before carry' })
    const moved = carryWatches(
      { db, cfg: CFG, actor: { kind: 'session', key: NEXT_BARE, name: 'node-day-2' }, now: NOW + 4000, resolveKey },
      { kind: 'session', key: NEXT_BARE, name: 'node-day-2' },
      [BARE],
    )
    expect(moved).toBeGreaterThan(0)
    expect(listEntries().some(e => e.by === 'threads-carried' && e.key === `@laptop:${NEXT_BARE}`)).toBe(true)
    // Verify tellWatchers directly accepts resolveKey too.
    expect(tellWatchers({ db, cfg: CFG, actor: WORKER, now: NOW + 5000, resolveKey }, [posted2.head]).told).toEqual([])
  } finally {
    db.close()
  }
})
