// Unit tests for continue-after-restart (#633): config parsing, mark parsing/comparison,
// Claude-only eligibility gating, recovery decisions, and exact-session schedule targeting.
import { describe, expect, test } from 'bun:test'
import { isNotice, reminderNotice } from '../../src/core/notices.ts'
import { promptOf, type ScheduleEntry, targetOf } from '../../src/core/schedule-rules.ts'
import {
  evaluatePending,
  isIdleStatus,
  isTurnResumeEligible,
  parseTurnMark,
  sameTurnMark,
  TURN_RESUME_DEFAULT_WAIT_MS,
  TURN_RESUME_KIND,
  TURN_RESUME_MAX_WAIT_MS,
  TURN_RESUME_MIN_WAIT_MS,
  TURN_RESUME_TEXT,
  turnResumeConfig,
} from '../../src/core/turn-resume.ts'
import type { Item } from '../../src/core/types.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'

function item(overrides: Partial<Item> = {}): Item {
  return {
    key: S1,
    session: S1,
    pane: 'w1:p1',
    workspace: 'ws',
    cwd: '/work/atlas',
    status: 'idle',
    name: 'anna',
    autoName: 'anna',
    category: 'other',
    categorySet: false,
    column: 'idle',
    attention: '',
    agent: 'claude',
    sleeping: false,
    ...overrides,
  }
}

describe('turnResumeConfig (#633)', () => {
  test('on by default, off on false or { on: false }, respects clamped waitSec and waitMin', () => {
    expect(turnResumeConfig(undefined)).toEqual({ on: true, waitMs: TURN_RESUME_DEFAULT_WAIT_MS })
    expect(turnResumeConfig(null)).toEqual({ on: true, waitMs: TURN_RESUME_DEFAULT_WAIT_MS })
    expect(turnResumeConfig(true)).toEqual({ on: true, waitMs: TURN_RESUME_DEFAULT_WAIT_MS })
    expect(turnResumeConfig(false)).toEqual({ on: false, waitMs: TURN_RESUME_DEFAULT_WAIT_MS })
    expect(turnResumeConfig({ on: false, waitMin: 10 })).toEqual({ on: false, waitMs: 10 * 60_000 })
    expect(turnResumeConfig({ waitSec: 30 })).toEqual({ on: true, waitMs: 30_000 })
    expect(turnResumeConfig({ waitSec: 1 })).toEqual({ on: true, waitMs: TURN_RESUME_MIN_WAIT_MS })
    expect(turnResumeConfig({ waitMin: 999 })).toEqual({ on: true, waitMs: TURN_RESUME_MAX_WAIT_MS })
    expect(turnResumeConfig({ waitSec: -5, waitMin: 'bad' })).toEqual({ on: true, waitMs: TURN_RESUME_DEFAULT_WAIT_MS })
  })
})

describe('parseTurnMark and sameTurnMark (#633)', () => {
  test('parses valid marks, drops malformed ones, and compares equality', () => {
    expect(parseTurnMark(null)).toBeNull()
    expect(parseTurnMark({})).toBeNull()
    expect(parseTurnMark({ session: '  ', startedAt: 100 })).toBeNull()
    expect(parseTurnMark({ session: S1, startedAt: 0 })).toBeNull()
    expect(parseTurnMark({ session: S1, startedAt: -5 })).toBeNull()

    const a = parseTurnMark({ session: S1, startedAt: 1000, pane: 'p1', processStartedAt: 900 })
    const b = parseTurnMark({ session: S1, startedAt: 1000, pane: 'p1', processStartedAt: 900 })
    const c = parseTurnMark({ session: S1, startedAt: 1000, pane: 'p2', processStartedAt: 900 })
    expect(a).toEqual({ session: S1, startedAt: 1000, pane: 'p1', processStartedAt: 900 })
    expect(sameTurnMark(a, b)).toBe(true)
    expect(sameTurnMark(a, c)).toBe(false)
    expect(sameTurnMark(a, null)).toBe(false)
    expect(sameTurnMark(null, null)).toBe(true)
  })
})

describe('isTurnResumeEligible (#633)', () => {
  test('accepts only local awake Claude panes with a real session id', () => {
    expect(isTurnResumeEligible(item())).toBe(true)
    expect(isTurnResumeEligible(item({ agent: 'pi' }))).toBe(false)
    expect(isTurnResumeEligible(item({ agent: 'codex' }))).toBe(false)
    expect(isTurnResumeEligible(item({ agent: 'agy' }))).toBe(false)
    expect(isTurnResumeEligible(item({ key: 'pane-w1:p1', session: null }))).toBe(false)
    expect(isTurnResumeEligible(item({ pane: null }))).toBe(false)
    expect(isTurnResumeEligible(item({ sleeping: true }))).toBe(false)
    expect(isTurnResumeEligible(item({ day: true }))).toBe(false)
    expect(isTurnResumeEligible(item({ call: { phase: 'on', since: 1, parent: null, helpers: 0, tasks: [] } }))).toBe(
      false,
    )
    expect(isTurnResumeEligible(item({ device: 'atlas-node' }))).toBe(false)
  })
})

describe('evaluatePending (#633)', () => {
  const mark = { session: S1, startedAt: 1000, pane: 'w1:p1', processStartedAt: 500 }
  const pending = { key: S1, mark, name: 'anna' }

  test('resumes when same session returns idle or done after restart (new process or unknown since)', () => {
    expect(isIdleStatus('idle')).toBe(true)
    expect(isIdleStatus('done')).toBe(true)
    expect(isIdleStatus('working')).toBe(false)

    const idleNew = item({ status: 'idle', since: 2000, pane: 'w1:p9' })
    expect(evaluatePending(pending, [idleNew], 1500, 1000, 60_000)).toEqual({ action: 'resume', item: idleNew })

    const doneNoSince = item({ status: 'done', since: null })
    expect(evaluatePending(pending, [doneNoSince], 1500, 1000, 60_000)).toEqual({ action: 'resume', item: doneNoSince })
  })

  test('skips when same Claude process finished the turn without restarting', () => {
    const sameProc = item({ status: 'idle', since: 500 })
    const res = evaluatePending(pending, [sameProc], 1500, 1000, 60_000)
    expect(res).toMatchObject({ action: 'skip', reason: 'same-process' })
  })

  test('reports already-working when session is already mid-turn', () => {
    const busy = item({ status: 'working', since: 2000 })
    expect(evaluatePending(pending, [busy], 1500, 1000, 60_000)).toMatchObject({
      action: 'already-working',
      item: busy,
    })
  })

  test('skips when session is asleep or ineligible', () => {
    expect(evaluatePending(pending, [item({ sleeping: true, status: 'sleeping' })], 1500, 1000, 60_000)).toMatchObject({
      action: 'skip',
      reason: 'asleep',
    })
    expect(evaluatePending(pending, [item({ agent: 'pi', status: 'idle' })], 1500, 1000, 60_000)).toMatchObject({
      action: 'skip',
      reason: 'ineligible',
    })
  })

  test('skips with different-session when pane or key returned with another session or agent', () => {
    const otherSession = item({ key: S2, session: S2, pane: 'w1:p1', status: 'idle', name: 'ben' })
    expect(evaluatePending(pending, [otherSession], 1500, 1000, 60_000)).toMatchObject({
      action: 'skip',
      reason: 'different-session',
    })

    const otherAgent = item({ key: 'pane-w1:p1', session: null, pane: 'w1:p1', agent: 'pi', status: 'idle' })
    expect(evaluatePending(pending, [otherAgent], 1500, 1000, 60_000)).toMatchObject({
      action: 'skip',
      reason: 'different-session',
    })

    const bootingClaude = item({ key: 'pane-w1:p1', session: null, pane: 'w1:p1', agent: 'claude', status: 'idle' })
    expect(evaluatePending(pending, [bootingClaude], 1500, 1000, 60_000)).toEqual({ action: 'wait' })
  })

  test('waits until timeout when session is missing, blocked, or unknown, then skips with timeout', () => {
    expect(evaluatePending(pending, [], 1500, 1000, 60_000)).toEqual({ action: 'wait' })
    expect(evaluatePending(pending, [], 61_000, 1000, 60_000)).toMatchObject({ action: 'skip', reason: 'timeout' })

    const blocked = item({ status: 'blocked', since: 2000 })
    expect(evaluatePending(pending, [blocked], 1500, 1000, 60_000)).toEqual({ action: 'wait' })
    expect(evaluatePending(pending, [blocked], 61_000, 1000, 60_000)).toMatchObject({
      action: 'skip',
      reason: 'timeout',
    })
  })
})

describe('schedule targeting and notice recognition for turn-resume (#633)', () => {
  test('targetOf never follows a turn-resume entry to a replacement session in the same pane', () => {
    const entry: ScheduleEntry = {
      id: 'aa11bb',
      key: S1,
      name: 'anna',
      pane: 'w1:p1',
      cwd: '/work/atlas',
      text: TURN_RESUME_TEXT,
      kind: TURN_RESUME_KIND,
      idle: true,
      noWake: true,
      next: 1000,
    }
    const replacement = item({ key: S2, session: S2, pane: 'w1:p1', cwd: '/work/atlas', name: 'ben' })
    expect(targetOf(entry, [replacement], () => 'default')).toEqual({})
    const own = item({ key: S1, session: S1, pane: 'w1:p2', cwd: '/work/atlas', name: 'anna' })
    expect(targetOf(entry, [replacement, own], () => 'default')).toEqual({ item: own })

    const prompt = promptOf(entry, 1000)
    expect(prompt).toBe(`[board reminder] ${TURN_RESUME_TEXT}`)
    expect(isNotice(prompt)).toBe(true)
    expect(reminderNotice(prompt)?.name).toBe(TURN_RESUME_TEXT)
  })
})
