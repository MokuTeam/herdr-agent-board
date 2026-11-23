import { expect, test } from 'bun:test'
import { labelOf, matching, messageEntry, offlineDevices, ownDeviceOf, targetsOf } from '../../src/core/agent-send.ts'
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
