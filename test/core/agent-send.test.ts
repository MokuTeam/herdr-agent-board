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
  planSend,
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

test('#639 a session moved to a node keeps the way to answer, and to be answered, by the name and ref signed before the move', () => {
  // Before the move both ran on the laptop: Legacy-master (A) got a message from work-00 (B).
  const before = targetsOf([card(A, 'Legacy-master'), card(B, 'work-00', { pane: null, day: true })])
  const [legacy] = matching(before, 'Legacy-master')
  const [work00] = matching(before, 'work-00')
  if (!legacy || !work00) throw new Error('no target')
  const asked = messageEntry(legacy, 'how is it going', { key: B, name: 'work-00' }, 1000)
  expect(asked.replyTo).toBe('work-00 [bbbbbbbb]')
  const toLegacy = messageEntry(work00, 'x', { key: A, name: 'Legacy-master' }, 1000).replyTo

  // After `board move --device server-2` its card is the node's, under the prefixed key; the laptop's
  // card of it may linger, older, and is no target any more.
  const after = [
    card(A, 'Legacy-master', { status: 'done', activity: 100 }),
    card(`@server-2:${A}`, 'Legacy-master', { device: 'server-2', activity: 200 }),
    card(B, 'work-00', { pane: null, day: true }),
  ]
  const answer = planSend({
    targets: targetsOf(after),
    to: asked.replyTo,
    message: 'done',
    from: { key: `@server-2:${A}`, name: 'Legacy-master', device: 'server-2' },
    own: 'laptop',
    now: 2000,
  })
  if ('error' in answer) throw new Error(answer.error)
  expect(answer.entry).toMatchObject({ key: B, replyTo: 'Legacy-master [aaaaaaaa]', fromDevice: 'server-2' })
  // And whoever kept its reply address from before the move still finds it on the node.
  expect(matching(targetsOf(after), toLegacy).map(t => t.key)).toEqual([`@server-2:${A}`])
})

test('#639 one session on two devices: the card with the newer activity is its target, awake before asleep at a tie', () => {
  const keys = (items: unknown[]) => targetsOf(items).map(t => t.key)
  const laptop = (more: Record<string, unknown>) => card(A, 'Legacy-master', more)
  const node = (more: Record<string, unknown>) =>
    card(`@server-2:${A}`, 'Legacy-master', { device: 'server-2', ...more })
  expect(keys([laptop({ activity: 100 }), node({ activity: 200 })])).toEqual([`@server-2:${A}`])
  // Moved back: the laptop's is the newer.
  expect(keys([laptop({ activity: 300 }), node({ activity: 200, sleeping: true })])).toEqual([A])
  // Asleep on the node since, still newer than the laptop's stale awake card.
  expect(keys([laptop({ activity: 100 }), node({ activity: 200, sleeping: true })])).toEqual([`@server-2:${A}`])
  expect(keys([laptop({ activity: 200, sleeping: true }), node({ activity: 200 })])).toEqual([`@server-2:${A}`])
  // Two sessions of one name on two devices stay two.
  expect(
    keys([laptop({ activity: 100 }), card(`@server-2:${B}`, 'Legacy-master', { device: 'server-2' })]),
  ).toHaveLength(2)
  // So a reply by name and ref finds one.
  expect(
    matching(targetsOf([laptop({ activity: 100 }), node({ activity: 200 })]), 'Legacy-master [aaaaaaaa]'),
  ).toHaveLength(1)
})

test('#639 the moved card is weighed against targets only; one device’s cards and cards with no session are as before', () => {
  const keys = (items: unknown[]) => targetsOf(items).map(t => t.key)
  // Right after a move the node's card may have no pane yet: no target, so it does not push out the laptop's.
  expect(
    keys([
      card(A, 'L', { activity: 100 }),
      card(`@server-2:${A}`, 'L', { device: 'server-2', pane: null, activity: 200 }),
    ]),
  ).toEqual([A])
  // Two cards of one session on one device: the pane rule, as before.
  expect(keys([card(A, 'L', { activity: 100 }), card(`pane-w1:p1`, 'L', { session: null, activity: 200 })])).toEqual([
    A,
  ])
  // No session id: never weighed across devices.
  expect(
    keys([
      card('pane-w1:p1', 'L', { session: null }),
      card('@server-2:pane-w1:p1', 'L', { session: null, device: 'server-2' }),
    ]),
  ).toHaveLength(2)
  // One session, equal activity and state on two devices: both stay, listed with their computers.
  expect(
    keys([card(A, 'L', { activity: 5 }), card(`@server-2:${A}`, 'L', { device: 'server-2', activity: 5 })]),
  ).toHaveLength(2)
})
