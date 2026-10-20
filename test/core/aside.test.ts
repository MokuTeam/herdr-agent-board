import { expect, test } from 'bun:test'
import { ASIDE_MAX, asideArgs, parseAside } from '../../src/core/aside.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('a side question is a one-off copy of the conversation: never written, no tools, no MCP, no hooks, JSON out', () => {
  expect(asideArgs(S)).toEqual([
    '-p',
    '--resume',
    S,
    '--fork-session',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    '--max-turns',
    '1',
    '--output-format',
    'json',
  ])
  // The question goes on stdin, never as an argument: no option can hide in it.
  expect(asideArgs(S).some(a => a.includes('?'))).toBe(false)
  expect(ASIDE_MAX).toBe(4000)
})

test('what claude -p printed: the answer with its price and context, or why there is none', () => {
  const ok = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: ' MANGO-77\n',
    total_cost_usd: 0.270216,
    duration_ms: 2920,
    usage: { input_tokens: 2, cache_creation_input_tokens: 33756, cache_read_input_tokens: 1200, output_tokens: 8 },
  }
  // A warning before the JSON is skipped.
  expect(parseAside(`Warning: no stdin data received in 3s\n${JSON.stringify(ok)}`)).toEqual({
    ok: true,
    answer: { text: 'MANGO-77', costUsd: 0.270216, tokens: { context: 34958, cached: 1200, output: 8 }, ms: 2920 },
  })
  expect(parseAside(JSON.stringify({ ...ok, total_cost_usd: undefined, usage: undefined }))).toMatchObject({
    ok: true,
    answer: { costUsd: null, tokens: { context: 0, cached: 0, output: 0 } },
  })
  expect(parseAside(JSON.stringify({ ...ok, is_error: true, result: 'Prompt is too long' }))).toEqual({
    ok: false,
    error: 'Prompt is too long',
  })
  expect(parseAside(JSON.stringify({ ...ok, subtype: 'error_max_turns', result: '' }))).toEqual({
    ok: false,
    error: 'error_max_turns',
  })
  expect(parseAside('not json', 'No conversation found')).toEqual({ ok: false, error: 'No conversation found' })
  expect(parseAside('')).toEqual({ ok: false, error: 'no answer' })
})
