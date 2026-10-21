// Ported from herdr-wake/test/route.test.mjs: the Telegram router's choice of pane and its prompt.
import { expect, test } from 'bun:test'
import { formatPrompt, localPane, resolve } from '../../../src/core/wake/route.ts'
import { asciiKey, tabKeys } from '../../../src/core/wake/topics.ts'

type Snapshot = Parameters<typeof resolve>[1]

// Two workspaces: "Billing" with tabs 1 and "hotfix", and a Cyrillic one.
const snap: Snapshot = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета монитор (2)' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', terminal_title_stripped: 'Billing-master' },
    { pane_id: 'w1:p2', tab_id: 'w1:t1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1' },
  ],
  agents: [{ pane_id: 'w1:p1', state_change_seq: 10 }],
}

test('routing keys follow the claude-tg launcher', () => {
  const keys = tabKeys(snap)
  expect(keys.get('topic:Billing')).toEqual(['w1:t1'])
  expect(keys.get('topic:Billing / hotfix')).toEqual(['w1:t2'])
  expect(keys.get('topic:  (2)')).toEqual(['w2:t1']) // non-ASCII stripped like claude-tg does, inner spaces stay
  expect(asciiKey('topic:Счета монитор')).toBe('topic:')
})

test('a running Claude in the tab wins', () => {
  expect(resolve({ key: 'topic:Billing' }, snap, {}, 'PC')).toStrictEqual({ pane: 'w1:p1', title: 'Billing-master' })
})

test('a stopped session is resumed in its pane', () => {
  const known = { 'w1:p3': { session: 'abc', title: 'Hotfix' } }
  expect(resolve({ key: 'topic:Billing / hotfix' }, snap, known, 'PC')).toStrictEqual({
    pane: 'w1:p3',
    session: 'abc',
    title: 'Hotfix',
  })
})

test('the server pane hint comes first, but only from this machine', () => {
  const known = { 'w2:p1': { session: 'xyz', title: 'Monitor' } }
  expect(resolve({ key: 'topic:other', pane: 'PC:w2:p1' }, snap, known, 'pc')?.pane).toBe('w2:p1')
  expect(resolve({ key: 'topic:other', pane: 'LAPTOP2:w2:p1' }, snap, known, 'pc')).toBeNull()
})

test('a key that is a working directory finds the pane in it', () => {
  const s: Snapshot = {
    ...snap,
    panes: [
      ...snap.panes,
      { pane_id: 'w2:p2', tab_id: 'w2:t1', cwd: 'C:\\Work\\Acme\\', agent: 'claude', terminal_title_stripped: 'acme' },
    ],
  }
  expect(resolve({ key: 'C:/Work/Acme' }, s, {}, 'PC')?.pane).toBe('w2:p2')
  expect(resolve({ key: '/home/me/proj' }, s, {}, 'PC')).toBeNull()
})

test('nothing to deliver to', () => {
  expect(resolve({ key: 'topic:Billing / hotfix' }, snap, {}, 'PC')).toBeNull()
  expect(resolve({ key: 'unknown' }, snap, {}, 'PC')).toBeNull()
})

test('pane hints', () => {
  expect(localPane('w1:p2', 'PC')).toBe('w1:p2')
  expect(localPane('PC:w1:p2', 'pc')).toBe('w1:p2')
  expect(localPane('PC:', 'PC')).toBe('PC:') // "PC:" alone has one colon: treated as a bare id that matches no pane
  expect(localPane('OTHER:w1:p2', 'PC')).toBeNull()
  expect(localPane('', 'PC')).toBeNull()
})

test('prompt format', () => {
  const now = Date.parse('2026-10-13T20:00:00Z')
  const items = [
    { key: 'topic:Billing', meta: { message_id: '5' }, queued_at: '2026-10-13T19:59:30Z', text: 'hello' },
    {
      key: 'topic:Billing',
      meta: { message_id: '6', file_id: 'AgAC-1', file_kind: 'photo', in_reply_to: 'did you "check"?' },
      queued_at: '2026-10-13T19:50:00Z',
      text: '(photo attached)',
    },
  ]
  expect(formatPrompt(items, now)).toBe(
    '[telegram message_id=5]\nhello\n\n' +
      '[telegram message_id=6 file_id=AgAC-1 file_kind=photo in_reply_to="did you \\"check\\"?" queued_at=2026-10-13T19:50:00Z]\n(photo attached)',
  )
})
