import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { afterCrash, CRASH_WINDOW_MS, MAX_CRASHES } from '../../src/core/crash-policy.ts'

test('a crashed board starts again: quickly at first, less often when it repeats', () => {
  let crashes: number[] = []
  const waits: number[] = []
  for (let i = 0; i < MAX_CRASHES - 1; i++) {
    const next = afterCrash(crashes, 1000 + i * 60_000)
    crashes = next.crashes
    waits.push(next.wait)
  }
  assert.deepEqual(waits, [2000, 10_000, 30_000, 30_000])
})

test('one that keeps crashing waits for a code change; old crashes do not count', () => {
  const now = 50 * 60_000
  const lately = Array.from({ length: MAX_CRASHES - 1 }, (_, i) => now - (i + 1) * 60_000)
  assert.equal(afterCrash(lately, now).wait, 0)
  const long = lately.map(at => at - CRASH_WINDOW_MS)
  const next = afterCrash(long, now)
  assert.equal(next.wait, 2000)
  assert.deepEqual(next.crashes, [now])
})
