import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { attentionOf, columnOf, noteOf } from '../../src/core/board.ts'
import { parseCodexTail } from '../../src/core/codex.ts'
import { compactStep } from '../../src/core/compact.ts'
import { planMemoryGuard } from '../../src/core/housekeeping.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { t, useLanguage } from '../../src/core/lang.ts'
import { lostAccessLine, parseLostAccess, parseResetTime } from '../../src/core/lost-access.ts'
import { nodePart } from '../../src/core/node-items.ts'
import { parsePiTail } from '../../src/core/pi.ts'
import { parseTranscriptTail } from '../../src/core/transcript.ts'
import type { Item } from '../../src/core/types.ts'

beforeEach(() => useLanguage('en'))
afterEach(() => useLanguage('en'))

const REF = Date.UTC(2026, 10, 23, 14, 0, 0) // 2026-11-23T14:00:00Z

describe('parseResetTime & parseLostAccess', () => {
  test('parses Claude usage limit reset times across formats', () => {
    const pipe = parseLostAccess('Claude AI usage limit reached|1795456800', { at: REF })
    expect(pipe).toEqual({ kind: 'limit', resetsAt: 1795456800_000, at: REF })

    const utcClock = parseLostAccess("You've hit your limit · resets 6pm (UTC)", { at: REF })
    expect(utcClock).toEqual({ kind: 'limit', resetsAt: Date.UTC(2026, 10, 23, 18, 0, 0), at: REF })

    const rollover = parseLostAccess("You've hit your limit · resets 11am (UTC)", { at: REF })
    expect(rollover).toEqual({ kind: 'limit', resetsAt: Date.UTC(2026, 10, 24, 11, 0, 0), at: REF })

    const iso = parseLostAccess('Usage limit reached. Try again after 2026-11-23T18:30:00Z', { at: REF })
    expect(iso).toEqual({ kind: 'limit', resetsAt: Date.UTC(2026, 10, 23, 18, 30, 0), at: REF })

    const jsonRetry = parseLostAccess('API Error: 429 {"error":{"type":"rate_limit_error"},"retry_after":120}', {
      at: REF,
    })
    expect(jsonRetry).toEqual({ kind: 'limit', resetsAt: REF + 120_000, at: REF })

    const relative = parseLostAccess('Usage limit reached, resets in 2 hours 15 minutes', { at: REF })
    expect(relative).toEqual({ kind: 'limit', resetsAt: REF + (2 * 60 + 15) * 60_000, at: REF })

    const compactRel = parseLostAccess('Rate limit reached, try again in 4m32s', { at: REF })
    expect(compactRel).toEqual({ kind: 'limit', resetsAt: REF + (4 * 60 + 32) * 1000, at: REF })

    const monthClock = parseLostAccess('Rate limit exceeded, resets Nov 25, 3:30pm (UTC)', { at: REF })
    expect(monthClock).toEqual({ kind: 'limit', resetsAt: Date.UTC(2026, 10, 25, 15, 30, 0), at: REF })

    const badDate = parseLostAccess('Usage limit reached, resets Feb 30, 3pm (UTC)', { at: REF })
    expect(badDate).toEqual({ kind: 'limit', resetsAt: null, resetText: 'Feb 30, 3pm (UTC)', at: REF })

    const badTz = parseLostAccess("You've hit your limit · resets 6pm (Mars/Olympus)", { at: REF })
    expect(badTz).toEqual({ kind: 'limit', resetsAt: null, resetText: '6pm (Mars/Olympus)', at: REF })
  })

  test('ignores bare integers as clock times', () => {
    expect(parseResetTime('rate limit resets 5 times', REF)).toEqual({ resetsAt: null, resetText: '' })
  })

  test('classifies logged out and expired OAuth errors, ignores 5xx and 400 errors', () => {
    expect(
      parseLostAccess('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}', { at: REF }),
    ).toEqual({ kind: 'logged_out', resetsAt: null, at: REF })

    expect(
      parseLostAccess('Not logged in · Please run /login', { errorCode: 'authentication_failed', at: REF }),
    ).toEqual({ kind: 'logged_out', resetsAt: null, at: REF })

    expect(parseLostAccess('OAuth token has expired. Please obtain a new token.', { at: REF })).toEqual({
      kind: 'expired',
      resetsAt: null,
      at: REF,
    })

    expect(parseLostAccess('Refresh token could not be refreshed', { at: REF })).toEqual({
      kind: 'expired',
      resetsAt: null,
      at: REF,
    })

    for (const msg of [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      'API Error: 500 Internal server error',
      'API Error: 400 Prompt is too long (line 401)',
      'Connection reset by peer',
    ]) {
      expect(parseLostAccess(msg, { at: REF })).toBeNull()
    }
  })

  test('formats EN and RU lines with reset time and profile title', () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const limit = { kind: 'limit' as const, resetsAt: Date.UTC(2026, 10, 23, 18, 0, 0), at: REF }
      expect(lostAccessLine(limit, null, t, REF)).toMatch(/^limit until /)
      expect(lostAccessLine({ kind: 'logged_out', resetsAt: null, at: REF }, 'Work', t, REF)).toBe(
        'logged out of the Work profile',
      )
      expect(lostAccessLine({ kind: 'logged_out', resetsAt: null, at: REF }, null, t, REF)).toBe('logged out')
      expect(lostAccessLine({ kind: 'expired', resetsAt: null, at: REF }, 'Work', t, REF)).toBe(
        'expired login in the Work profile',
      )

      const ru = translator('ru')
      expect(lostAccessLine(limit, null, ru, REF)).toMatch(/^лимит до /)
      expect(lostAccessLine({ kind: 'logged_out', resetsAt: null, at: REF }, 'Работа', ru, REF)).toBe(
        'разлогинен в профиле Работа',
      )
      expect(lostAccessLine({ kind: 'expired', resetsAt: null, at: REF }, null, ru, REF)).toBe('истёк вход')
    } finally {
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })
})

describe('transcript tail parsers: detect and self-clear on next successful turn', () => {
  test('Claude transcript detects lost access and clears on real assistant turn or tool_use', () => {
    const user = (text: string) =>
      JSON.stringify({ type: 'user', timestamp: '2026-11-23T14:00:00Z', message: { role: 'user', content: text } })
    const err = (text: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T14:01:00Z',
        isApiErrorMessage: true,
        ...extra,
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
      })
    const okText = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T14:05:00Z',
        message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text }] },
      })
    const okTool = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-23T14:05:00Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    })

    const lost = parseTranscriptTail([user('go'), err("You've hit your limit · resets 6pm (UTC)")])
    expect(lost.lostAccess).toEqual({
      kind: 'limit',
      resetsAt: Date.UTC(2026, 11 - 1, 23, 18, 0, 0),
      at: Date.parse('2026-11-23T14:01:00Z'),
    })

    // User retry prompt before any successful reply keeps lostAccess active
    const retried = parseTranscriptTail([
      user('go'),
      err("You've hit your limit · resets 6pm (UTC)"),
      user('try again'),
    ])
    expect(retried.lostAccess?.kind).toBe('limit')

    // Next real assistant text or tool call clears lostAccess
    expect(
      parseTranscriptTail([user('go'), err('API Error: 401 unauthorized'), okText('Back online.')]).lostAccess,
    ).toBeUndefined()
    expect(parseTranscriptTail([user('go'), err('API Error: 401 unauthorized'), okTool]).lostAccess).toBeUndefined()

    // Normal prose mentioning rate limit is ignored
    expect(
      parseTranscriptTail([user('go'), okText('API Error: 401 unauthorized is handled in auth.ts.')]).lostAccess,
    ).toBeUndefined()
    // 529 overloaded keeps apiError without lostAccess
    const overloaded = parseTranscriptTail([user('go'), err('API Error: 529 overloaded')])
    expect(overloaded.apiError).toBe(true)
    expect(overloaded.lostAccess).toBeUndefined()
  })

  test('Codex rollout detects lost access and clears on next assistant message or tool call', () => {
    const row = (type: string, payload: Record<string, unknown>, ts = '2026-11-23T14:01:00Z') =>
      JSON.stringify({ timestamp: ts, type, payload })
    const msg = (role: string, text: string) =>
      row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] }, '2026-11-23T14:05:00Z')

    const lost = parseCodexTail([
      msg('user', 'fix ci'),
      row('event_msg', {
        type: 'error',
        message: "You've hit your usage limit. Try again at 2026-11-23T18:00:00Z",
        codex_error_info: 'usage_limit_exceeded',
      }),
    ])
    expect(lost.lostAccess).toEqual({
      kind: 'limit',
      resetsAt: Date.UTC(2026, 10, 23, 18, 0, 0),
      at: Date.parse('2026-11-23T14:01:00Z'),
    })

    const structured = parseCodexTail([
      msg('user', 'fix ci'),
      row('event_msg', {
        type: 'error',
        message: 'Usage limit exceeded',
        codex_error_info: { UsageLimitExceeded: { resets_in_seconds: 900 } },
      }),
    ])
    expect(structured.lostAccess).toEqual({
      kind: 'limit',
      resetsAt: Date.parse('2026-11-23T14:01:00Z') + 900_000,
      at: Date.parse('2026-11-23T14:01:00Z'),
    })

    const cleared = parseCodexTail([
      msg('user', 'fix ci'),
      row('event_msg', { type: 'error', message: 'Unauthorized', codex_error_info: { http_status_code: 401 } }),
      msg('assistant', 'Fixed the test.'),
    ])
    expect(cleared.lostAccess).toBeUndefined()

    const clearedByTool = parseCodexTail([
      msg('user', 'fix ci'),
      row('event_msg', { type: 'turn_aborted', reason: 'usage_limit_exceeded' }),
      row('response_item', { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' }),
    ])
    expect(clearedByTool.lostAccess).toBeUndefined()

    // Normal interruption does not trigger lostAccess
    const aborted = parseCodexTail([
      msg('user', 'fix ci'),
      row('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    ])
    expect(aborted.lostAccess).toBeUndefined()
  })

  test('pi session detects stopReason error and clears on next successful turn on active branch', () => {
    let n = 0
    let parent: string | null = null
    const header = JSON.stringify({
      type: 'session',
      version: 3,
      id: 'p1',
      timestamp: '2026-11-23T14:00:00Z',
      cwd: '/w',
    })
    const entry = (message: Record<string, unknown>, id = `e${++n}`, p = parent) => {
      parent = id
      return JSON.stringify({ type: 'message', id, parentId: p, timestamp: '2026-11-23T14:01:00Z', message })
    }

    const lost = parsePiTail([
      header,
      entry({ role: 'user', content: [{ type: 'text', text: 'go' }] }),
      entry({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '401 Unauthorized: please log in again',
      }),
    ])
    expect(lost.lostAccess).toEqual({
      kind: 'logged_out',
      resetsAt: null,
      at: Date.parse('2026-11-23T14:01:00Z'),
    })

    const cleared = parsePiTail([
      header,
      entry({ role: 'user', content: [{ type: 'text', text: 'go' }] }),
      entry({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 Unauthorized' }),
      entry({ role: 'assistant', content: [{ type: 'text', text: 'Resumed!' }], stopReason: 'stop' }),
    ])
    expect(cleared.lostAccess).toBeUndefined()
  })
})

describe('board routing, node serialization, and guards', () => {
  const lost = { kind: 'limit' as const, resetsAt: Date.UTC(2026, 10, 23, 18, 0, 0), at: REF }
  const item = (over: Partial<Item> = {}): Item => ({
    key: 's1',
    session: 's1',
    pane: 'p1',
    workspace: 'w1',
    cwd: '/w',
    status: 'idle',
    name: 'anna',
    autoName: 'anna',
    category: 'other',
    categorySet: false,
    column: 'me',
    attention: 'access',
    question: 'limit until 18:00',
    lostAccess: lost,
    ...over,
  })

  test('attentionOf and columnOf put lost-access sessions under Needs me even when working or blocked', () => {
    expect(attentionOf('working', {}, { lostAccess: lost })).toBe('access')
    expect(columnOf('working', {}, { lostAccess: lost })).toBe('me')
    expect(attentionOf('blocked', {}, { lostAccess: lost })).toBe('access')
    expect(attentionOf('idle', { pin: 'done' }, { lostAccess: lost })).toBe('')
    expect(columnOf('idle', { pin: 'done' }, { lostAccess: lost })).toBe('done')
    expect(noteOf(item())).toBe('limit until 18:00')

    // Non-lost-access sessions are unchanged
    expect(attentionOf('working', {}, {})).toBe('')
    expect(columnOf('working', {}, {})).toBe('work')
  })

  test('nodePart keeps attention=access and lostAccess fields', () => {
    const part = nodePart({ items: [item()] }, 'node-1')
    expect(part?.items[0]?.attention).toBe('access')
    expect(part?.items[0]?.lostAccess).toEqual(lost)
  })

  test('compact and housekeeping treat attention=access as waiting on owner', () => {
    const it = item({
      agent: 'claude',
      status: 'idle',
      context: 180_000,
      contextSize: 200_000,
    })
    expect(compactStep(it, { limit: { tokens: 100_000 }, source: 'default', note: '' }, null, REF)).toEqual({
      do: 'wait',
      why: 'asked',
    })
    const hk = planMemoryGuard({
      memAvailableMb: 500,
      memTotalMb: 8000,
      cpus: 4,
      cfg: {
        on: true,
        intervalSec: 60,
        warnMb: 2000,
        actionMb: 1000,
        maxSleepPerRound: 2,
        exclude: [],
        notifyTo: null,
      },
      placerMinFreeMb: null,
      items: [it],
      wakeExclude: [],
      warned: false,
      now: REF,
    })
    expect(hk.candidates).toEqual([])
    expect(hk.skipped).toEqual([{ key: 's1', name: 'anna', reason: 'waiting-on-owner' }])
  })
})
