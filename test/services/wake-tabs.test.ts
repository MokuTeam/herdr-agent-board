// The workspace a sleeper whose pane is gone wakes in (#178, #204): its own while herdr has it as it
// was, else one of its label, else a new one; herdr gives a workspace's id out again after it starts
// over, so an id whose label changed is another workspace.
import { expect, test } from 'bun:test'
import { workspaceFor } from '../../src/services/wake/tabs.ts'

const snap = {
  workspaces: [
    { workspace_id: 'w1', label: 'Other now' },
    { workspace_id: 'w7', label: 'Main' },
    { workspace_id: 'w8' },
  ],
}

test('its own by id while the label is the one it had, or not known; else one of its label; else none', () => {
  expect(workspaceFor(snap, { workspace: 'w7', workspaceLabel: 'Main' })).toBe('w7')
  expect(workspaceFor(snap, { workspace: 'w7' })).toBe('w7')
  expect(workspaceFor(snap, { workspace: 'w8', workspaceLabel: 'Main' })).toBe('w8')
  expect(workspaceFor(snap, { workspace: 'w1', workspaceLabel: 'Main' })).toBe('w7')
  expect(workspaceFor(snap, { workspace: 'w1', workspaceLabel: 'Gone' })).toBeNull()
  expect(workspaceFor(snap, { workspaceLabel: 'Main' })).toBe('w7')
  expect(workspaceFor(snap, {})).toBeNull()
})
