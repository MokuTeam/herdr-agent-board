// Whether a session scheduled work for itself (src/adapters/wake-transcripts.ts): its transcript
// read asynchronously, once until the file changes; one that cannot be read keeps it up.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scheduledJobs } from '../../src/adapters/wake-transcripts.ts'

const NOW = Date.parse('2026-10-21T12:00:00Z')

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'board-wake-transcripts-'))
  made.push(dir)
  return dir
}

/** A transcript line with a tool call, as Claude Code writes it. */
const toolCall = (name: string, timestamp: string): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { content: [{ type: 'tool_use', id: 'toolu_01', name, input: {} }] },
  })

test('a CronCreate within 7 days keeps it up; read once until the file changes', async () => {
  const dir = join(folder(), 'C--Work-Проект-x-50-')
  mkdirSync(dir)
  const file = join(dir, '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b.jsonl')
  const seen = new Date('2026-10-21T10:00:00Z')
  const scheduled = `${JSON.stringify({ type: 'user', timestamp: '2026-10-20T11:59:00.000Z' })}\n${toolCall('CronCreate', '2026-10-20T12:00:00.000Z')}\n`
  writeFileSync(file, scheduled)
  utimesSync(file, seen, seen)
  expect(await scheduledJobs(file, NOW)).toBe(true)

  // The same size and time, other text: the answer is the one read before.
  const other = scheduled.replace('CronCreate', 'CronDelete')
  expect(other.length).toBe(scheduled.length)
  writeFileSync(file, other)
  utimesSync(file, seen, seen)
  expect(await scheduledJobs(file, NOW)).toBe(true)

  // Touched: read again.
  const later = new Date('2026-10-21T11:00:00Z')
  utimesSync(file, later, later)
  expect(await scheduledJobs(file, NOW)).toBe(false)

  // Grown at the same time: read again too.
  writeFileSync(file, `${other}${toolCall('ScheduleWakeup', '2026-10-21T11:30:00.000Z')}\n`)
  utimesSync(file, later, later)
  expect(await scheduledJobs(file, NOW)).toBe(true)
})

test('the week is counted at every look, not when the transcript was read', async () => {
  const file = join(folder(), 'six-days.jsonl')
  writeFileSync(file, `${toolCall('CronCreate', new Date(NOW - 6 * 86_400_000).toISOString())}\n`)
  expect(await scheduledJobs(file, NOW)).toBe(true)
  expect(await scheduledJobs(file, NOW + 12 * 3_600_000)).toBe(true)
  // Two days on, the transcript untouched: the cron has expired, the session may sleep.
  expect(await scheduledJobs(file, NOW + 2 * 86_400_000)).toBe(false)
})

test('a schedule older than 7 days, or none, lets it sleep; no transcript is nothing scheduled', async () => {
  const file = join(folder(), 'old.jsonl')
  writeFileSync(file, `${toolCall('CronCreate', '2026-10-14T11:59:59.000Z')}\n`)
  expect(await scheduledJobs(file, NOW)).toBe(false)
  expect(await scheduledJobs(null, NOW)).toBe(false)
})

test('an unreadable path counts as scheduled', async () => {
  const dir = folder()
  expect(await scheduledJobs(join(dir, 'missing.jsonl'), NOW)).toBe(true)
  expect(await scheduledJobs(dir, NOW)).toBe(true)
})
