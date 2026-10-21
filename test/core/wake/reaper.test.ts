import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  exitedPanes,
  lastScheduledAt,
  matchesAny,
  type ReapSnapshot,
  type Running,
  reapPlan,
  scheduledIn,
  scheduleLive,
} from '../../../src/core/wake/reaper.ts'

const now = Date.parse('2026-10-13T21:00:00Z')
const min = (m: number) => now - m * 60_000
const snap: ReapSnapshot = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета монитор' },
  ],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'a' } },
    { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'done', agent_session: { value: 'b' } },
    { pane_id: 'w1:p3', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'c' } },
    { pane_id: 'w1:p4', workspace_id: 'w1', agent: 'claude', agent_status: 'blocked', agent_session: { value: 'd' } },
    {
      pane_id: 'w1:p5',
      workspace_id: 'w1',
      agent: 'claude',
      agent_status: 'idle',
      agent_session: { value: 'e' },
      focused: true,
    },
    { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'idle', agent_session: { value: 'f' } },
    { pane_id: 'w1:p6', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'g' } },
    {
      pane_id: 'w1:p7',
      workspace_id: 'w1',
      agent: 'claude',
      agent_status: 'idle',
      agent_session: { value: 'unknown' },
    },
    { pane_id: 'w1:p8', workspace_id: 'w1' }, // a plain shell
  ],
}
const live = new Map<string, Running>(
  [
    { sessionId: 'a', name: 'Billing-master', status: 'idle', statusUpdatedAt: min(90), cwd: 'C:\\Work\\Acme' },
    { sessionId: 'b', name: 'recent', status: 'idle', statusUpdatedAt: min(20) },
    { sessionId: 'c', name: 'monitor-like', status: 'shell', statusUpdatedAt: min(300) },
    { sessionId: 'd', name: 'asking', status: 'idle', statusUpdatedAt: min(300) },
    { sessionId: 'e', name: 'looked-at', status: 'idle', statusUpdatedAt: min(300) },
    { sessionId: 'f', name: 'watcher', status: 'idle', statusUpdatedAt: min(300) },
    { sessionId: 'g', name: 'with-cron', status: 'idle', statusUpdatedAt: min(300) },
  ].map(s => [s.sessionId, s]),
)

test('who sleeps and why the rest stays up', () => {
  const plan = reapPlan(snap, live, {
    idleMinutes: 60,
    exclude: ['/монитор/'],
    now,
    scheduled: s => s.name === 'with-cron',
  })
  const byPane = Object.fromEntries(plan.map(p => [p.pane, p.sleep ? 'SLEEP' : p.reason]))
  assert.deepEqual(byPane, {
    'w1:p1': 'SLEEP',
    'w1:p2': 'idle 20 min',
    'w1:p3': 'status shell',
    'w1:p4': 'herdr says blocked',
    'w1:p5': 'focused',
    'w2:p1': 'excluded',
    'w1:p6': 'has scheduled jobs',
    'w1:p7': 'not in the session registry',
  })
  assert.deepEqual(plan[0], {
    pane: 'w1:p1',
    name: 'Billing-master',
    workspace: 'Billing',
    status: 'idle',
    since: min(90),
    idleMin: 90,
    sleep: true,
    session: 'a',
    cwd: 'C:\\Work\\Acme',
    reason: 'idle 90 min',
  })
  // only sessions that just need more idle time count down to sleep
  assert.deepEqual(
    plan.filter(p => p.waiting).map(p => p.pane),
    ['w1:p2'],
  )
  assert.equal(plan.find(p => p.pane === 'w1:p3')?.idleMin, 300)
})

test('a session exited by hand counts as asleep while its pane stays open', () => {
  const panes = [
    { pane_id: 'p1' }, // exited a minute ago
    { pane_id: 'p2' }, // Claude ended there long ago, now a plain shell
    { pane_id: 'p3', agent: 'claude', agent_session: { value: 's3' } }, // still running
    { pane_id: 'p4' }, // resumed by hand in another pane, still running there
    { pane_id: 'p5' }, // already asleep
    { pane_id: 'p6' }, // never ran Claude
  ]
  const known = {
    p1: { session: 's1', seen_at: min(1) },
    p2: { session: 's2', seen_at: min(300) },
    p3: { session: 's3', seen_at: min(0) },
    p4: { session: 's4', seen_at: min(1) },
    p5: { session: 's5', seen_at: min(90), slept_at: min(30) },
    gone: { session: 's7', seen_at: min(1) }, // pane closed
  }
  const running = new Map([
    ['s3', {}],
    ['s4', {}],
  ])
  assert.deepEqual(exitedPanes({ panes }, known, running, now), ['p1'])
})

test('exclude patterns', () => {
  assert.equal(matchesAny(['billing-master'], ['Billing-master']), true)
  assert.equal(matchesAny(['/^Acme/'], ['acme-ledger']), true)
  assert.equal(matchesAny(['Billing'], ['Billing-master']), false)
  assert.equal(matchesAny([], ['x']), false)
})

test('scheduled jobs are found by recent CronCreate or ScheduleWakeup calls only', () => {
  const line = (name: string, ts: string) =>
    JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] } })
  const tools = JSON.stringify({
    attachment: { type: 'deferred_tools_record', entries: [{ name: 'CronCreate' }] },
    timestamp: '2026-10-13T00:00:00Z',
  })

  const recent = [tools, line('Bash', '2026-10-13T10:00:00Z'), line('CronCreate', '2026-10-10T10:00:00Z')]
  assert.equal(scheduledIn(recent.join('\n'), now), true)

  const old = [tools, line('ScheduleWakeup', '2026-10-01T10:00:00Z')]
  assert.equal(scheduledIn(old.join('\n'), now), false)

  const none = [tools] // the tool list mentions CronCreate, but nothing was called
  assert.equal(scheduledIn(none.join('\n'), now), false)

  const wakeup = [tools, line('ScheduleWakeup', '2026-10-13T20:00:00Z')]
  assert.equal(scheduledIn(wakeup.join('\r\n'), now), true)
})

test('the last schedule call is the newest CronCreate or ScheduleWakeup, whatever the order', () => {
  const line = (name: string, ts: unknown) =>
    JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] } })
  const text = [
    line('CronCreate', '2026-10-05T10:00:00Z'),
    line('ScheduleWakeup', '2026-10-12T08:30:00Z'),
    line('Bash', '2026-10-13T10:00:00Z'),
    line('CronCreate', '2026-10-09T10:00:00Z'),
    line('CronCreate', 'not a time'),
    line('ScheduleWakeup', 1_800_000_000_000), // a number, newer: not a transcript's time, ignored
  ].join('\r\n')
  assert.equal(lastScheduledAt(text), Date.parse('2026-10-12T08:30:00Z'))
  assert.equal(lastScheduledAt(line('Bash', '2026-10-13T10:00:00Z')), null)
  assert.equal(lastScheduledAt(''), null)

  // Kept up for a week from it.
  const at = Date.parse('2026-10-12T08:30:00Z')
  assert.equal(scheduleLive(at, at + 7 * 86_400_000 - 1), true)
  assert.equal(scheduleLive(at, at + 7 * 86_400_000), false)
  assert.equal(scheduleLive(null, at), false)
})

test('a session the board could not wake again is kept up, with the reason, and never counts down', () => {
  const plan = reapPlan(snap, live, {
    idleMinutes: 60,
    now,
    cannotWake: s =>
      s.name === 'Billing-master'
        ? 'cannot wake: no transcript in its profile folder'
        : s.name === 'recent'
          ? 'cannot wake: board is not on PATH'
          : null,
  })
  expect(plan.find(p => p.pane === 'w1:p1')).toMatchObject({
    sleep: false,
    reason: 'cannot wake: no transcript in its profile folder',
  })
  expect(plan.find(p => p.pane === 'w1:p2')?.waiting).toBeUndefined()
})

test('an exclude pattern that is no regex never matches and never throws', () => {
  expect(matchesAny(['/[/'], ['['])).toBe(false)
})

test('a session whose idle time Claude did not record stays up, without counting down', () => {
  const unstamped = new Map<string, Running>([['a', { sessionId: 'a', name: 'Billing-master', status: 'idle' }]])
  const plan = reapPlan(snap, unstamped, { idleMinutes: 60, now })
  assert.deepEqual(
    plan.find(p => p.pane === 'w1:p1'),
    {
      pane: 'w1:p1',
      name: 'Billing-master',
      workspace: 'Billing',
      status: 'idle',
      sleep: false,
      reason: 'idle time unknown',
    },
  )
})
