import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the brief tells agents about the schedule', async () => {
  const { brief, BRIEF_VERSION } = await import('../src/brief.mjs')
  const text = brief({ categories: [{ id: 'other', title: 'Other' }] }, null, 'C:\X')
  assert.match(text, /board remind <when> "<text>"/)
  assert.match(text, /board every "<cron, 5 fields>"/)
  assert.match(text, /CronCreate or ScheduleWakeup/)
  assert.ok(BRIEF_VERSION >= 3)
})
