import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { alarmOf } from '../../web/src/models/card.ts'
import { watchOf, watchView } from '../../web/src/models/watch.ts'

// A watch on the page (#486): the card's line and the sheet's row read it from the payload's
// schedule; its next check is no alarm by the card's name.
const en = translator('en')
const T0 = Date.UTC(2026, 10, 20, 12)
const watch = {
  id: 'abc123',
  key: 's1',
  kind: 'watch',
  text: 'CI on PR 12',
  next: T0 + 6 * 60_000,
  created: T0 - 3600e3,
  lastCheck: T0 - 4 * 60_000,
  checks: 3,
  probe: { cmd: 'gh pr checks 12 --json state', everyMs: 600_000, timeoutMs: 20_000 },
} as ScheduleEntry
const reminder: ScheduleEntry = { id: 'def456', key: 's1', text: 'look again', next: T0 + 3600e3, at: T0 + 3600e3 }

test("the session's watch and how it stands, with the whole command", () => {
  const w = watchOf([reminder, watch], 's1')
  assert.ok(w)
  assert.deepEqual(watchView(w, T0, en), {
    state: 'checked 4 min ago, nothing yet',
    cmd: 'gh pr checks 12 --json state',
    every: 'every 10 min',
    error: false,
  })
  assert.equal(watchOf([reminder, watch], 's2'), undefined)
  assert.equal(watchOf([reminder], 's1'), undefined)
})

test("a watch's next check is no alarm: the clock shows the reminders only", () => {
  assert.equal(alarmOf([watch], 's1', T0, en), null)
  assert.match(alarmOf([watch, reminder], 's1', T0, en)?.title ?? '', /look again/)
})
