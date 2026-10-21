// Ported from herdr-wake/test/launcher.test.mjs ("the launcher’s topic…"): the key claude-tg puts
// in TG_KEY, and the router finding the tab again by that key.
import { expect, test } from 'bun:test'
import { keyFor, type TopicSnapshot, tabKeys } from '../../../src/core/wake/topics.ts'

const snap: TopicSnapshot = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета 2' },
    { workspace_id: 'w3', label: '' },
    { workspace_id: 'w4', label: 'Счета' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
    { tab_id: 'w3:t1', workspace_id: 'w3', label: '1', number: 1 },
    { tab_id: 'w4:t1', workspace_id: 'w4', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
    { pane_id: 'w3:p1', tab_id: 'w3:t1', workspace_id: 'w3' },
    { pane_id: 'w4:p1', tab_id: 'w4:t1', workspace_id: 'w4' },
  ],
}

test('the launcher’s topic: the workspace for its first tab, workspace / tab for the others, else the folder', () => {
  expect(keyFor(snap, 'w1:p1', 'C:\\w')).toBe('topic:Billing')
  expect(keyFor(snap, 'w1:p3', 'C:\\w')).toBe('topic:Billing / hotfix')
  expect(keyFor(snap, 'w2:p1', 'C:\\w')).toBe('topic: 2') // headers are ASCII: the rest is dropped
  expect(keyFor(snap, 'w3:p1', 'C:\\Work\\Проект x')).toBe('C:\\Work\\ x') // no workspace label: the folder
  expect(keyFor(snap, 'w4:p1', '/home/u/app')).toBe('/home/u/app') // nothing left of the name: not a nameless topic
  expect(keyFor(snap, 'gone', '/home/u/app')).toBe('/home/u/app')
  expect(keyFor(null, undefined, '/home/u/app')).toBe('/home/u/app')
  // The router finds the tab by the very key the launcher gave the session.
  for (const pane of snap.panes.filter(p => p.workspace_id === 'w1' || p.workspace_id === 'w2')) {
    const tabs = tabKeys(snap).get(keyFor(snap, pane.pane_id, ''))
    expect(tabs?.includes(pane.tab_id ?? ''), pane.pane_id).toBeTruthy()
  }
})
