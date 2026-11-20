import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { digest, statusText } from '../../src/core/statusline.ts'

// The status line input as Claude Code documents it (trimmed to what the board reads).
const input = {
  session_id: 'abc-123',
  model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
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
const esc = String.fromCharCode(27)
const plain = (s: string) => s.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, 'g'), '')

test('status line input: usage windows, context fill and the session', () => {
  const d = digest(input, 1000)
  assert.deepEqual(d.usage, {
    fetchedAtMs: 1000,
    fiveHour: { usedPercentage: 23.5, resetsAt: 1738425600 },
    sevenDay: { usedPercentage: 41.2, resetsAt: 1738857600 },
  })
  assert.deepEqual(d.context, { usedPercentage: 8, size: 200000, tokens: 15500, at: 1000 }) // output tokens left out
  assert.equal(d.session, 'abc-123')
  assert.equal(d.model, 'Opus 4.5')
  assert.equal(plain(statusText(d)), 'ctx 8% · 5h 24% · 7d 41%')
  // Before the first reply, or on a plan without windows: nothing to keep, nothing to show.
  assert.deepEqual(digest({ session_id: 'x', context_window: { used_percentage: null, current_usage: null } }), {
    usage: null,
    context: null,
    session: 'x',
    model: null,
    effort: null,
  })
  assert.equal(statusText(digest({})), '')
  assert.equal(digest({ rate_limits: { five_hour: { used_percentage: 120 } } }).usage, null)
})

test('the numbers turn yellow from 70% and red from 90%; tokens stand in for a missing percentage', () => {
  const line = (pct: number) => statusText(digest({ rate_limits: { five_hour: { used_percentage: pct } } }, 1))
  assert.ok(!line(69).includes(`${esc}[33m`) && !line(69).includes(`${esc}[31m`))
  assert.ok(line(70).includes(`${esc}[33m70%`))
  assert.ok(line(90).includes(`${esc}[31m90%`))
  assert.equal(plain(statusText(digest({ context_window: { current_usage: { input_tokens: 15500 } } }, 1))), 'ctx 16k')
})

test('bad input shapes leave nothing', () => {
  for (const bad of [null, undefined, 'x', 7, []])
    assert.deepEqual(digest(bad), { usage: null, context: null, session: null, model: null, effort: null })
})

test('effort: the level the input says (a /effort changes it), none when it says none or a bad one (#193)', () => {
  assert.equal(digest({ ...input, effort: { level: 'high' } }).effort, 'high')
  assert.equal(digest({ ...input, effort: { level: ' XHigh ' } }).effort, 'xhigh')
  // A model without effort: Claude Code leaves effort out, and the board keeps none.
  assert.equal(digest(input).effort, null)
  for (const bad of [null, 'high', {}, { level: 7 }, { level: '' }, { level: 'h' }, { level: 'high; rm -rf' }])
    assert.equal(digest({ ...input, effort: bad }).effort, null)
  // Effort with no context yet (before the first reply, right after a compaction): kept all the same.
  const bare = digest({ session_id: 'x', context_window: { current_usage: null }, effort: { level: 'max' } })
  assert.equal(bare.context, null)
  assert.equal(bare.effort, 'max')
})

test('context: a zero it counted is kept, a count that is no number is no count (#193)', () => {
  const zero = digest({
    context_window: {
      context_window_size: 200000,
      used_percentage: 0,
      current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  assert.deepEqual(zero.context, { usedPercentage: 0, size: 200000, tokens: 0, at: zero.context?.at })
  const bad = digest({ context_window: { context_window_size: -5, current_usage: { input_tokens: 'x' } } })
  assert.equal(bad.context, null)
  // One part spoilt: no count (it would disagree with the percentage); one left out counts 0.
  assert.equal(
    digest({ context_window: { current_usage: { input_tokens: 'x', cache_read_input_tokens: 900 } } }).context,
    null,
  )
  const some = digest({ context_window: { current_usage: { cache_read_input_tokens: 900 } } })
  assert.equal(some.context?.tokens, 900)
  assert.equal(some.context?.size, null)
})
