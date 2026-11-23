import { describe, expect, test } from 'bun:test'
import { aggregateSpend, formatTokens, parseClaudeSpend, parseCodexSpend, parsePiSpend } from '../../src/core/spend.ts'

const line = (obj: unknown): string => JSON.stringify(obj)

describe('Claude spend parser', () => {
  test('sums input, output, cache read and write once per response by local day', () => {
    const lines = [
      line({
        type: 'assistant',
        timestamp: '2026-11-23T04:30:00.000Z',
        requestId: 'req-1',
        message: {
          id: 'msg-1',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
          content: [{ type: 'thinking', thinking: 'hmm' }],
        },
      }),
      // Same streaming response, later chunk with higher output tokens: counted once with max.
      line({
        type: 'assistant',
        timestamp: '2026-11-23T04:30:02.000Z',
        requestId: 'req-1',
        message: {
          id: 'msg-1',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 85,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
          content: [{ type: 'text', text: 'Done.' }],
        },
      }),
      // Synthetic error message and sidechain helper must be skipped.
      line({
        type: 'assistant',
        timestamp: '2026-11-23T04:31:00.000Z',
        message: {
          id: 'msg-syn',
          model: '<synthetic>',
          usage: { input_tokens: 999, output_tokens: 999 },
          content: [{ type: 'text', text: 'err' }],
        },
      }),
      line({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-11-23T04:32:00.000Z',
        message: {
          id: 'msg-side',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 400, output_tokens: 100 },
          content: [{ type: 'text', text: 'sub' }],
        },
      }),
      '{malformed',
      // Second response, after UTC midnight vs New York local day boundary.
      line({
        type: 'assistant',
        timestamp: '2026-11-23T23:30:00.000Z',
        requestId: 'req-2',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'Next' }],
        },
      }),
    ]

    // In America/New_York (UTC-5): 04:30Z is 2026-11-22 23:30; 23:30Z is 2026-11-23 18:30.
    const ny = parseClaudeSpend(lines, { zone: 'America/New_York' })
    expect(ny.total).toEqual({
      input: 150,
      output: 95,
      cacheRead: 500,
      cacheWrite: 200,
      total: 945,
      responses: 2,
    })
    expect(Object.keys(ny.byDay).sort()).toEqual(['2026-11-22', '2026-11-23'])
    expect(ny.byDay['2026-11-22']?.total).toBe(885)
    expect(ny.byDay['2026-11-23']?.total).toBe(60)

    // In Asia/Tokyo (UTC+9): 04:30Z is 2026-11-23 13:30; 23:30Z is 2026-11-24 08:30.
    const tokyo = parseClaudeSpend(lines, { zone: 'Asia/Tokyo' })
    expect(Object.keys(tokyo.byDay).sort()).toEqual(['2026-11-23', '2026-11-24'])
  })

  test('minAt ignores copied parent history in forked transcripts', () => {
    const t0 = Date.parse('2026-11-22T10:00:00Z')
    const t1 = Date.parse('2026-11-23T10:00:00Z')
    const lines = [
      line({
        type: 'assistant',
        timestamp: new Date(t0).toISOString(),
        message: { id: 'old', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } },
      }),
      line({
        type: 'assistant',
        timestamp: new Date(t1).toISOString(),
        message: { id: 'new', model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 50 } },
      }),
    ]
    const fork = parseClaudeSpend(lines, { zone: 'UTC', minAt: t1 })
    expect(fork.total).toEqual({ input: 200, output: 50, cacheRead: 0, cacheWrite: 0, total: 250, responses: 1 })
  })
})

describe('Codex spend parser', () => {
  test('computes deltas from total_token_usage without double counting cached input or duplicate events', () => {
    const ev = (timestamp: string, info: Record<string, unknown>) =>
      line({ timestamp, type: 'event_msg', payload: { type: 'token_count', info } })

    const lines = [
      // Turn 1: input_tokens=2000 includes cached_input_tokens=1500 -> uncached=500, cacheRead=1500, out=100.
      ev('2026-11-22T20:00:00Z', {
        total_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100 },
        last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100 },
      }),
      // Duplicate emission of same total_token_usage: ignored.
      ev('2026-11-22T20:00:01Z', {
        total_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100 },
        last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100 },
      }),
      // Turn 2: cumulative total grows by (in=1000, cached=800, out=50) -> uncached=200, cacheRead=800, out=50.
      ev('2026-11-23T12:00:00Z', {
        total_token_usage: { input_tokens: 3000, cached_input_tokens: 2300, output_tokens: 150 },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
      }),
      // Counter reset in same rollout: falls back to last_token_usage.
      ev('2026-11-23T12:05:00Z', {
        total_token_usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 40 },
        last_token_usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 40 },
      }),
    ]

    const res = parseCodexSpend(lines, { zone: 'UTC' })
    expect(res.total).toEqual({
      input: 1000,
      output: 190,
      cacheRead: 2400,
      cacheWrite: 0,
      total: 3590,
      responses: 3,
    })
    expect(res.byDay['2026-11-22']?.total).toBe(2100)
    expect(res.byDay['2026-11-23']?.total).toBe(1490)
  })
})

describe('pi spend parser', () => {
  test('sums pi assistant usage and deduplicates by entry id', () => {
    const t0 = Date.parse('2026-11-23T09:00:00Z')
    const lines = [
      line({ type: 'session', version: 3, id: 's1', timestamp: new Date(t0).toISOString(), cwd: '/work' }),
      line({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: new Date(t0).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input: 10, output: 50, cacheRead: 1000, cacheWrite: 25 },
        },
      }),
      line({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: new Date(t0).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi again' }],
          usage: { input: 10, output: 60, cacheRead: 1000, cacheWrite: 25 },
        },
      }),
      line({
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: new Date(t0 + 60_000).toISOString(),
        message: {
          role: 'assistant',
          timestamp: t0 + 60_000,
          content: [{ type: 'text', text: 'done' }],
          usage: { input: 5, output: 20, cacheRead: 500, cacheWrite: 0 },
        },
      }),
    ]
    const res = parsePiSpend(lines, { zone: 'UTC' })
    expect(res.total).toEqual({
      input: 15,
      output: 80,
      cacheRead: 1500,
      cacheWrite: 25,
      total: 1620,
      responses: 2,
    })
    expect(res.byDay['2026-11-23']?.total).toBe(1620)
  })
})

describe('formatTokens and aggregateSpend', () => {
  test('formats tokens cleanly without 1000k or 1000M artifacts', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(640)).toBe('640')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(42_400)).toBe('42k')
    expect(formatTokens(999_500)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(formatTokens(120_400_000)).toBe('120M')
    expect(formatTokens(999_500_000)).toBe('1B')
  })

  test('aggregates by lane and day across agents, including Cyrillic and % names', () => {
    const s1 = parseClaudeSpend(
      [
        line({
          type: 'assistant',
          timestamp: '2026-11-22T12:00:00Z',
          message: { id: 'a1', usage: { input_tokens: 100, output_tokens: 50 } },
        }),
        line({
          type: 'assistant',
          timestamp: '2026-11-23T12:00:00Z',
          message: { id: 'a2', usage: { input_tokens: 300, output_tokens: 100 } },
        }),
      ],
      { zone: 'UTC' },
    )
    const s2 = parseCodexSpend(
      [
        line({
          timestamp: '2026-11-23T14:00:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 50 } },
          },
        }),
      ],
      { zone: 'UTC' },
    )

    const report = aggregateSpend({
      from: '2026-11-22',
      to: '2026-11-23',
      zone: 'UTC',
      sessions: [
        { key: 's1', name: 'Проект 100% anna', lane: 'atlas', agent: 'claude', spend: s1 },
        { key: 'pane-1', name: 'ben', lane: 'personal', agent: 'codex', spend: s2 },
      ],
    })
    expect(report.total.total).toBe(1100)
    expect(report.lanes.map(l => [l.lane, l.counts.total, l.sessions])).toEqual([
      ['atlas', 550, 1],
      ['personal', 550, 1],
    ])
    expect(report.days.map(d => d.day)).toEqual(['2026-11-22', '2026-11-23'])

    const filtered = aggregateSpend({
      from: '2026-11-22',
      to: '2026-11-23',
      zone: 'UTC',
      lane: 'atlas',
      sessions: [
        { key: 's1', name: 'Проект 100% anna', lane: 'atlas', agent: 'claude', spend: s1 },
        { key: 'pane-1', name: 'ben', lane: 'personal', agent: 'codex', spend: s2 },
      ],
    })
    expect(filtered.total.total).toBe(550)
    expect(filtered.sessions).toHaveLength(1)
    expect(filtered.sessions[0]?.name).toBe('Проект 100% anna')
  })

  test('handles Object.prototype key names like constructor and toString as lanes', () => {
    const s1 = parseClaudeSpend(
      [
        line({
          type: 'assistant',
          timestamp: '2026-11-23T10:00:00Z',
          message: { id: 'p1', usage: { input_tokens: 100, output_tokens: 25 } },
        }),
      ],
      { zone: 'UTC' },
    )
    const report = aggregateSpend({
      from: '2026-11-23',
      to: '2026-11-23',
      zone: 'UTC',
      sessions: [
        { key: 's-ctor', name: 'ctor', lane: 'constructor', agent: 'claude', spend: s1 },
        { key: 's-str', name: 'str', lane: 'toString', agent: 'claude', spend: s1 },
      ],
    })
    expect(report.total.total).toBe(250)
    expect(report.lanes.map(l => [l.lane, l.counts.total])).toEqual([
      ['constructor', 125],
      ['toString', 125],
    ])
    const ctorKey = 'constructor'
    const strKey = 'toString'
    expect(report.days[0]?.byLane[ctorKey]?.total).toBe(125)
    expect(report.days[0]?.byLane[strKey]?.total).toBe(125)
  })
})
