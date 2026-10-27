// #204: what knew a session by its pane follows it when wake closes that pane and wakes it in a new
// tab: its card keeps the panes it had, its schedule entries take the pane it woke in. The board's
// own files, in a temp state folder.
import { expect, test } from 'bun:test'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { addEntry, getEntry } from '../../src/adapters/schedule-store.ts'
import { paneClosed, paneOpened } from '../../src/services/wake/follow.ts'
import { isolatedHome } from '../support/env.ts'

const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'

test('the card keeps its earlier panes, once each, the newest last, at most 8', () => {
  isolatedHome()
  writeCard(SID, { name: 'Billing', category: 'work' })
  paneClosed(SID, 'w1:p2')
  paneClosed(SID, 'w1:p2')
  expect(readCard(SID)).toMatchObject({ name: 'Billing', category: 'work', panes: ['w1:p2'] })
  for (let i = 3; i <= 11; i++) paneClosed(SID, `w1:p${i}`)
  expect(readCard(SID)?.panes).toEqual(['w1:p4', 'w1:p5', 'w1:p6', 'w1:p7', 'w1:p8', 'w1:p9', 'w1:p10', 'w1:p11'])
})

test('its schedule entries take the pane it woke in; another session’s are left alone', () => {
  isolatedHome()
  const next = Date.now() + 3_600_000
  const own = addEntry({ key: SID, name: 'Billing', pane: 'w1:p2', cwd: 'C:\\w', text: 'check the PR', next })
  const asleep = addEntry({ key: SID, name: 'Billing', text: 'set while it slept', next })
  const other = addEntry({ key: 'another', name: 'Other', pane: 'w1:p2', text: 'not this one', next })
  paneOpened(SID, 'w1:new1')
  expect(getEntry(own.id)?.pane).toBe('w1:new1')
  expect(getEntry(asleep.id)?.pane).toBe('w1:new1')
  expect(getEntry(other.id)?.pane).toBe('w1:p2')
  expect(getEntry(own.id)?.text).toBe('check the PR')
})
