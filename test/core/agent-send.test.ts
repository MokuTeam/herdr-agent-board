import { expect, test } from 'bun:test'
import {
  agentViewsOf,
  formatAgentLines,
  isOtherAgent,
  labelOf,
  matching,
  messageEntry,
  offlineDevices,
  ownDeviceOf,
  targetsOf,
} from '../../src/core/agent-send.ts'
import { promptOf, type ScheduleEntry } from '../../src/core/schedule-rules.ts'

// Who a message through the board (#619) can go to, and what the receiver is told.
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'

const card = (key: string, name: string, more: Record<string, unknown> = {}) => ({
  key,
  session: key.replace(/^@[^:]+:/, ''),
  name,
  pane: 'w1:p1',
  status: 'idle',
  ...more,
})

test('a card another session’s awake card replaced in its pane is no target; a sleeping one, a day, another device’s pane are', () => {
  const names = (items: unknown[]) => targetsOf(items).map(t => t.name)
  // The newer of two awake cards in one pane wins; one with a session id wins over one without.
  expect(names([card(A, 'old', { activity: 1 }), card(B, 'new', { activity: 2 })])).toEqual(['new'])
  expect(
    names([card('pane-w1:p1', 'bare', { session: null, activity: 9 }), card(B, 'claude', { activity: 1 })]),
  ).toEqual(['claude'])
  // Asleep: wake opens it in a new tab when its pane is taken.
  expect(names([card(A, 'asleep', { sleeping: true }), card(B, 'awake')])).toEqual(['asleep', 'awake'])
  // The same pane id on two devices is two panes.
  expect(
    names([
      card(`@server-1:${A}`, 'one', { device: 'server-1' }),
      card(`@server-2:${B}`, 'two', { device: 'server-2' }),
    ]),
  ).toEqual(['one', 'two'])
  // No pane: only MokuPilot's day takes a message (its inbox); no name, or no key: not listed at all.
  expect(
    names([card(A, 'paneless', { pane: null }), card(B, 'day', { pane: null, day: true }), card(C, ''), { name: 'x' }]),
  ).toEqual(['day'])
  // The automatic name answers too.
  expect(matching(targetsOf([card(A, 'Card', { autoName: 'auto-name' })]), 'AUTO-NAME').map(t => t.name)).toEqual([
    'Card',
  ])
})

test('a name, a name with its ref, the whole key or session id pick their cards', () => {
  const targets = targetsOf([
    card(`@server-2:${A}`, 'Worker', { device: 'server-2' }),
    card(`@server-1:${B}`, 'Worker', { device: 'server-1', pane: 'w2:p1' }),
  ])
  expect(matching(targets, 'worker').map(labelOf)).toEqual(['Worker [aaaaaaaa]', 'Worker [bbbbbbbb]'])
  expect(matching(targets, 'Worker [bbbbbbbb]').map(t => t.key)).toEqual([`@server-1:${B}`])
  // A ref shorter than 8 picks nothing out: the name alone counts.
  expect(matching(targets, 'Worker [bbbb]')).toHaveLength(2)
  expect(matching(targets, `@server-2:${A}`).map(t => t.device)).toEqual(['server-2'])
  expect(matching(targets, B.toUpperCase()).map(t => t.device)).toEqual(['server-1'])
  expect(matching(targets, '  ')).toEqual([])
})

test('what the receiver is told: the name and ref to answer with board send, and from which computer', () => {
  const [target] = targetsOf([card(`@server-2:${A}`, 'Master', { device: 'server-2' })])
  if (!target) throw new Error('no target')
  const plain = messageEntry(target, 'hello', { key: B, name: 'Laptop [x]' }, 1000)
  expect(plain).toMatchObject({ key: `@server-2:${A}`, replyTo: 'Laptop x [bbbbbbbb]', replyBy: 'board' })
  expect(promptOf({ ...plain, id: 'abcdef' } as ScheduleEntry, 1000)).toBe(
    '[board reminder from Laptop x; answer with board send "Laptop x [bbbbbbbb]" "<your answer>"] hello',
  )
  // No name: the whole key finds the sender again.
  const nameless = messageEntry(target, 'hi', { key: B, name: '', device: 'laptop' }, 1000)
  expect(nameless.replyTo).toBe(B)
  expect(promptOf({ ...nameless, id: 'abcdef' } as ScheduleEntry, 1000)).toBe(
    `[board reminder from bbbbbbbb; from laptop, answer with board send "${B}" "<your answer>"] hi`,
  )
})

test('the payload’s own computer and the devices that are not online', () => {
  const payload = {
    devices: [
      { id: 'server-2', link: { state: 'online' } },
      { id: 'server-1', link: { state: 'offline' } },
      { id: 'local', link: null, status: { id: 'laptop' } },
    ],
  }
  expect(ownDeviceOf(payload)).toBe('laptop')
  expect([...offlineDevices(payload)]).toEqual(['server-1'])
  expect(ownDeviceOf({})).toBe('')
  expect([...offlineDevices(null)]).toEqual([])
})

test('a ref after /clear gives way to a name only one card has; a key for a card with no hex id; a name stays one line', () => {
  const targets = targetsOf([
    card(A, 'Solo'),
    card('pane-w9:p1', 'Paned', { session: null, pane: 'w9:p1' }),
    card(C, 'Two\nlines\u0007', { pane: 'w3:p1' }),
  ])
  expect(matching(targets, 'Solo [deadbeef]').map(t => t.name)).toEqual(['Solo'])
  const paned = targets.find(t => t.name === 'Paned')
  if (!paned) throw new Error('no card')
  expect(labelOf(paned)).toBe('Paned (key pane-w9:p1)')
  expect(matching(targets, 'pane-w9:p1').map(t => t.name)).toEqual(['Paned'])
  expect(targets.map(t => t.name)).toContain('Two lines')
})

test('a reply finds a sender whose name has brackets or runs past 60 characters, as its replyTo signs it', () => {
  const long = `Long ${'x'.repeat(75)}`
  const targets = targetsOf([card(A, 'Fix [WIP] thing'), card(B, long, { pane: 'w2:p1' })])
  for (const t of targets) {
    const signed = messageEntry(t, 'hi', { key: t.key, name: t.name }, 0).replyTo
    expect(matching(targets, signed).map(x => x.key)).toEqual([t.key])
  }
  expect(matching(targets, 'fix [wip] thing').map(x => x.key)).toEqual([A])
  expect(matching(targets, long).map(x => x.key)).toEqual([B])
})

test('#628 other local agents and formatted agent lines (live first, self marked, offline node, sleep cap)', () => {
  const targets = targetsOf([
    card(A, 'Agent-board Master', { agent: 'claude', status: 'done', pane: 'w5:p2' }),
    card(B, 'Гемини dev 100%', { agent: 'agy', status: 'working', pane: 'w5:p7' }),
    card(`@server-1:${C}`, 'Remote Agy', {
      agent: 'agy',
      device: 'server-1',
      pane: null,
      sleeping: true,
      status: 'sleeping',
      activity: 50,
    }),
  ])
  expect(targets.filter(isOtherAgent).map(t => t.name)).toEqual(['Гемини dev 100%'])
  expect(
    formatAgentLines(targets, {
      selfKey: B,
      own: 'laptop',
      offline: new Set(['server-1']),
    }),
  ).toEqual([
    'Agent-board Master [aaaaaaaa]  ·  claude  ·  laptop  ·  done',
    'Гемини dev 100% [bbbbbbbb]  ·  agy  ·  laptop  ·  working  ·  (this session)',
    'Remote Agy [cccccccc]  ·  agy  ·  node server-1  ·  asleep  ·  node offline now: goes out once it is back',
  ])
  expect(
    formatAgentLines(targets, {
      selfKey: B,
      own: 'laptop',
      maxSleeping: 0,
    }).at(-1),
  ).toBe('... and 1 more asleep; board send / SendMessage reaches them too')
  expect(agentViewsOf(targets, { selfKey: B, offline: new Set(['server-1']) })).toMatchObject([
    { key: A, agent: 'claude', self: false, offline: false },
    { key: B, agent: 'agy', self: true, offline: false },
    { key: `@server-1:${C}`, agent: 'agy', device: 'server-1', sleeping: true, offline: true },
  ])
})
