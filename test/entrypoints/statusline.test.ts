import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readUsageCache } from '../../src/adapters/claude-home.ts'
import { root, sandbox } from '../support/sandbox.ts'

const plain = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
const input = {
  session_id: 'abc-123',
  context_window: {
    context_window_size: 200000,
    used_percentage: 8,
    current_usage: {
      input_tokens: 8500,
      output_tokens: 1200,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 2000,
    },
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
}

test('as the command Claude runs: files for the board, the line on stdout, old windows kept on an empty input', async () => {
  const box = await sandbox()
  const script = join(root, 'src', 'entrypoints', 'statusline.ts')
  const run = (stdin: unknown) =>
    spawnSync(process.execPath, [script], { input: JSON.stringify(stdin), encoding: 'utf8', env: box.env })
  const out = run(input)
  assert.equal(out.status, 0)
  assert.equal(plain(out.stdout), 'ctx 8% · 5h 24% · 7d 41%')
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  const usage = JSON.parse(readFileSync(join(state, 'claude-limits-latest.json'), 'utf8'))
  assert.equal(usage.fiveHour.usedPercentage, 23.5)
  assert.equal(JSON.parse(readFileSync(join(state, 'context', 'abc-123.json'), 'utf8')).usedPercentage, 8)
  assert.equal(run({}).status, 0)
  assert.equal(JSON.parse(readFileSync(join(state, 'claude-limits-latest.json'), 'utf8')).fiveHour.usedPercentage, 23.5)
  assert.equal(run('not json').stdout, '') // a bad input leaves the line blank, no error
  // The board reads it with the usagebar reader: resets in seconds become milliseconds.
  const read = readUsageCache(state, usage.fetchedAtMs + 1000).limits
  assert.equal(read.available, true)
  assert.deepEqual(
    (read.windows ?? []).map(w => [w.minutes, w.usedPercentage, w.resetsAt]),
    [
      [300, 23.5, 1738425600000],
      [10080, 41.2, 1738857600000],
    ],
  )
})
