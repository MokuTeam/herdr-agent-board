// Auto-compact's rules (#378, core/compact.ts): limits as the owner writes them, which one is in
// force, when /compact goes in, and how a run on its way settles.
import { describe, expect, test } from 'bun:test'
import {
  type CompactItem,
  type CompactRun,
  compactCommand,
  compactConfig,
  compactionSince,
  compactRule,
  compactStep,
  compactView,
  limitText,
  limitTokens,
  noteText,
  parseCompactLimit,
  SENT_IDLE_MS,
  SENT_WORKING_MS,
  settleRun,
} from '../../src/core/compact.ts'

const idle: CompactItem = {
  key: 's1',
  session: 's1',
  pane: 'p1',
  agent: 'claude',
  status: 'idle',
  sleeping: false,
  attention: '',
  context: 150_000,
  contextSize: 1_000_000,
}
const own = (at: unknown, note?: string) => ({ compactAt: at, ...(note && { compactNote: note }) }) as never

describe('limits', () => {
  test('tokens, shares and never as the owner writes them; nonsense and limits that would compact every turn are refused', () => {
    expect(parseCompactLimit('300k')).toEqual({ tokens: 300_000 })
    expect(parseCompactLimit(' 1.2M ')).toEqual({ tokens: 1_200_000 })
    expect(parseCompactLimit('1,5m')).toEqual({ tokens: 1_500_000 })
    expect(parseCompactLimit('250000')).toEqual({ tokens: 250_000 })
    expect(parseCompactLimit(400_000)).toEqual({ tokens: 400_000 })
    expect(parseCompactLimit('60%')).toEqual({ share: 60 })
    expect(parseCompactLimit('Never')).toBe('never')
    for (const bad of ['', 'off', '5k', '9999', '2%', '96%', 'k', '300 tokens', '-300k', null, undefined, {}, Number.NaN])
      expect(parseCompactLimit(bad)).toBeNull()
    expect(limitText({ tokens: 300_000 })).toBe('300k')
    expect(limitText({ tokens: 1_200_000 })).toBe('1.2m')
    expect(limitText({ share: 60 })).toBe('60%')
    expect(limitText('never')).toBe('never')
  })

  test("a share is of the session's window; without the window's size it is not known", () => {
    expect(limitTokens({ share: 30 }, 1_000_000)).toBe(300_000)
    expect(limitTokens({ share: 30 }, null)).toBeNull()
    expect(limitTokens({ tokens: 200_000 }, null)).toBe(200_000)
    expect(limitTokens(null, 1_000_000)).toBeNull()
  })

  test('instructions go into a terminal: one line, no control characters, 500 characters at most', () => {
    expect(noteText('keep\nthe  ticket\u001b[2J list ')).toBe('keep the ticket [2J list')
    expect(noteText('x'.repeat(600))).toHaveLength(500)
    expect(noteText(42)).toBe('')
    expect(compactCommand('')).toBe('/compact')
    expect(compactCommand('keep the plan')).toBe('/compact keep the plan')
  })
})

describe('which limit is in force', () => {
  test("off unless set: Settings' default, a session's own beats it, its own never beats both", () => {
    expect(compactRule(null, undefined)).toEqual({ limit: null, source: 'off', note: '' })
    expect(compactRule(null, { at: '300k', note: 'keep the plan' })).toEqual({
      limit: { tokens: 300_000 },
      source: 'default',
      note: 'keep the plan',
    })
    expect(compactRule(own('60%', 'keep the tickets'), { at: '300k', note: 'keep the plan' })).toEqual({
      limit: { share: 60 },
      source: 'session',
      note: 'keep the tickets',
    })
    expect(compactRule(own('never'), { at: '300k' })).toMatchObject({ limit: null, source: 'never' })
    // A limit the card holds that is no limit is no setting: the default applies.
    expect(compactRule(own('soon'), { at: '300k' })).toMatchObject({ source: 'default' })
    // A bare limit and a "never" default in config.json.
    expect(compactConfig('400k').at).toEqual({ tokens: 400_000 })
    expect(compactConfig({ at: 'never' }).at).toBeNull()
  })

  test('the view: nothing for a card with nothing set and no default, so other boards send what they sent', () => {
    expect(compactView({ key: 's1', doing: 'x' }, undefined, 1_000_000)).toBeNull()
    expect(compactView(own('60%'), undefined, 1_000_000)).toEqual({
      own: '60%',
      note: '',
      limit: '60%',
      source: 'session',
      tokens: 600_000,
      run: null,
    })
    expect(compactView(null, { at: '300k' }, null)).toMatchObject({ own: '', limit: '300k', source: 'default' })
  })
})

describe('when /compact goes in', () => {
  const rule = compactRule(own('100k'), undefined)

  test('over the limit while idle or done between turns: once; under it, or with no context known, nothing', () => {
    expect(compactStep(idle, rule, null)).toEqual({ do: 'compact', limit: 100_000, setting: '100k' })
    expect(compactStep({ ...idle, status: 'done' }, rule, null)).toMatchObject({ do: 'compact' })
    expect(compactStep({ ...idle, context: 99_999 }, rule, null)).toEqual({ do: 'none' })
    expect(compactStep({ ...idle, context: null }, rule, null)).toEqual({ do: 'none' })
    expect(compactStep(idle, compactRule(null, undefined), null)).toEqual({ do: 'none' })
  })

  test('never into a turn, a dialog, a question waiting on the owner, or a sleeper', () => {
    expect(compactStep({ ...idle, status: 'working' }, rule, null)).toEqual({ do: 'wait', why: 'busy' })
    expect(compactStep({ ...idle, status: 'blocked', attention: 'decision' }, rule, null)).toEqual({
      do: 'wait',
      why: 'dialog',
    })
    expect(compactStep({ ...idle, attention: 'ask' }, rule, null)).toEqual({ do: 'wait', why: 'asked' })
    expect(compactStep({ ...idle, attention: 'question' }, rule, null)).toEqual({ do: 'wait', why: 'asked' })
    expect(compactStep({ ...idle, status: 'sleeping', sleeping: true }, rule, null)).toEqual({
      do: 'wait',
      why: 'asleep',
    })
    expect(compactStep({ ...idle, status: 'unknown' }, rule, null)).toEqual({ do: 'wait', why: 'unknown' })
  })

  test('only a Claude session in a pane of its own', () => {
    for (const other of [
      { agent: 'pi' },
      { agent: 'codex' },
      { pane: null },
      { session: null },
      { day: true as const },
      { call: {} as never },
    ])
      expect(compactStep({ ...idle, ...other }, rule, null)).toEqual({ do: 'none' })
  })

  test('a run on its way types nothing more; a hold lasts until the context is below the limit or the limit changes', () => {
    const base: CompactRun = { state: 'done', at: 1, from: 612_000, limit: 100_000, setting: '100k', to: 120_000 }
    expect(compactStep(idle, rule, { ...base, state: 'sent' })).toEqual({ do: 'none' })
    const held = { ...base, hold: true as const }
    expect(compactStep(idle, rule, held)).toEqual({ do: 'none' })
    expect(compactStep({ ...idle, context: 90_000 }, rule, held)).toEqual({ do: 'release' })
    expect(compactStep(idle, compactRule(own('200k'), undefined), held)).toEqual({ do: 'release' })
    expect(compactStep(idle, compactRule(own('never'), undefined), held)).toEqual({ do: 'release' })
    // A run that did not hold (it went below the limit): over it again later, it compacts again.
    expect(compactStep(idle, rule, base)).toMatchObject({ do: 'compact' })
  })
})

describe('a run on its way', () => {
  const sent: CompactRun = { state: 'sent', at: 1_000_000, from: 612_000, limit: 300_000, setting: '300k' }
  const line = (o: Record<string, unknown>) => JSON.stringify(o)
  const boundary = (at: number, extra: Record<string, unknown> = {}) =>
    line({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: new Date(at).toISOString(),
      compactMetadata: { trigger: 'manual', preTokens: 611_000, postTokens: 48_000 },
      ...extra,
    })

  test("the transcript's newest compaction after the /compact; a subagent's own or an older one is not it", () => {
    const after = sent.at + 30_000
    expect(compactionSince([boundary(after)], sent.at)).toEqual({ at: after, pre: 611_000, post: 48_000 })
    expect(compactionSince([boundary(sent.at - 60_000)], sent.at)).toBeNull()
    expect(compactionSince([boundary(after, { isSidechain: true })], sent.at)).toBeNull()
    expect(compactionSince(['not json "compact_boundary"', line({ type: 'user' })], sent.at)).toBeNull()
  })

  test('settled: done below the limit, held at or above it, failed (held) when none came in time', () => {
    const at = sent.at + 30_000
    expect(settleRun(sent, { at, pre: 611_000, post: 48_000 }, 'idle', 48_000, at)).toEqual({
      ...sent,
      state: 'done',
      from: 611_000,
      to: 48_000,
      doneAt: at,
    })
    expect(settleRun(sent, { at, pre: null, post: 300_000 }, 'idle', null, at)).toMatchObject({
      state: 'done',
      from: 612_000,
      to: 300_000,
      hold: true,
    })
    // No count in the transcript: the context the board reads now.
    expect(settleRun(sent, { at, pre: null, post: null }, 'idle', 51_000, at)).toMatchObject({ to: 51_000 })
    expect(settleRun(sent, null, 'idle', 612_000, sent.at + SENT_IDLE_MS - 1)).toBeNull()
    expect(settleRun(sent, null, 'working', 612_000, sent.at + SENT_IDLE_MS + 1)).toBeNull()
    expect(settleRun(sent, null, 'idle', 612_000, sent.at + SENT_IDLE_MS)).toEqual({
      ...sent,
      state: 'failed',
      hold: true,
    })
    expect(settleRun(sent, null, 'working', 612_000, sent.at + SENT_WORKING_MS)).toMatchObject({ state: 'failed' })
  })
})
