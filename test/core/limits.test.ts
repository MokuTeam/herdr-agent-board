import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { parseLimits } from '../../src/core/limits.ts'

const now = 1000000
const SOURCE = 'usagebar default-profile statusLine cache'

test('only known numeric cache fields leave the parser; zero is valid, the account stays unverified', () => {
  const limits = parseLimits(
    {
      fetchedAtMs: now - 1000,
      fiveHour: { usedPercentage: 0, resetsAt: 2000 },
      sevenDay: { usedPercentage: 50 },
      secret: 'must not leave parser',
    },
    now,
  )
  assert.equal(limits.available, true)
  assert.deepEqual(limits.windows, [
    { minutes: 300, usedPercentage: 0, resetsAt: 2_000_000, expired: false },
    { minutes: 10080, usedPercentage: 50, resetsAt: null, expired: false },
  ])
  assert.equal(limits.ageMs, 1000)
  assert.equal(limits.stale, false)
  assert.equal(limits.observedAt, now - 1000)
  assert.equal(limits.source, SOURCE)
  assert.equal(limits.sessionAccountVerified, false)
  assert.doesNotMatch(JSON.stringify(limits), /must not leave/)
})

test('old/expired, malformed and future data never become invented fresh usage', () => {
  const old = parseLimits({ fetchedAtMs: 1, fiveHour: { usedPercentage: 90, resetsAt: 10 } }, now)
  assert.equal(old.available, true)
  assert.equal(old.stale, true)
  assert.equal(old.windows?.[0]?.expired, true)
  // Fresh reading whose window has already reset: stale too.
  assert.equal(parseLimits({ fetchedAtMs: now, fiveHour: { usedPercentage: 5, resetsAt: 1 } }, now).stale, true)
  const unknown = { available: false, observedAt: null, source: SOURCE, sessionAccountVerified: false }
  for (const raw of [
    null,
    'bad',
    [],
    {},
    { fetchedAtMs: now + 6000, fiveHour: { usedPercentage: 10 } },
    { fetchedAtMs: 0, fiveHour: { usedPercentage: 10 } },
    { fetchedAtMs: now },
    { fetchedAtMs: now, fiveHour: { usedPercentage: '10' } },
    { fetchedAtMs: now, fiveHour: { usedPercentage: 101 } },
    { fetchedAtMs: now, fiveHour: { usedPercentage: -1 } },
  ]) {
    assert.deepEqual(parseLimits(raw, now), unknown)
  }
  // Five seconds ahead of the clock is still accepted.
  assert.equal(parseLimits({ fetchedAtMs: now + 5000, fiveHour: { usedPercentage: 10 } }, now).available, true)
})
