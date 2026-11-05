// The workspace a sleeper whose pane is gone wakes in (#178, #204): its own while herdr has it as it
// was, else one of its label, else a new one; herdr gives a workspace's id out again after it starts
// over, so an id whose label changed is another workspace.
import { expect, test } from 'bun:test'
import { openTab, type TabOps, type TabPlace, workspaceFor } from '../../src/services/wake/tabs.ts'

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

// #317: a linked worktree's workspace that went with its sleeper's tab comes back linked to its
// repository (`herdr worktree open`), so herdr's sidebar groups it there; everything else as before.
const ROOT = process.platform === 'win32' ? 'C:\\Work\\Repo 50%' : '/work/Repo 50%'
const TREE = process.platform === 'win32' ? `${ROOT}\\.worktrees\\Счёт-1` : `${ROOT}/.worktrees/Счёт-1`

function ops(o: { missing?: string[]; alreadyOpen?: boolean; fails?: boolean; noWorktree?: boolean } = {}) {
  const calls: string[][] = []
  const tabs: TabOps = {
    async newTab(ws, cwd, label) {
      calls.push(['tab', ws, cwd, label])
      return `${ws}:new`
    },
    async newWorkspace(cwd, label, tabLabel) {
      calls.push(['workspace', cwd, label, tabLabel ?? ''])
      return 'w9:p1'
    },
    ...(!o.noWorktree && {
      async openWorktree(wt, label, tabLabel) {
        calls.push(['worktree', wt.root, wt.path, label, tabLabel ?? ''])
        if (o.fails) throw new Error('herdr worktree open: not a git repository')
        return {
          workspace: o.alreadyOpen ? 'w4' : 'w8',
          pane: o.alreadyOpen ? 'w4:p1' : 'w8:p1',
          alreadyOpen: !!o.alreadyOpen,
        }
      },
    }),
    exists: path => !(o.missing ?? []).includes(path),
    home: '/home/me',
  }
  return { tabs, calls }
}

const place: TabPlace = {
  workspace: 'w5',
  workspaceLabel: 'TICKET-1',
  cwd: TREE,
  label: 'ticket-1',
  tabLabel: '1',
  worktree: { root: ROOT, path: TREE },
}
const gone = { workspaces: [{ workspace_id: 'w1', label: 'Main' }] }

test('#317 its workspace gone: its worktree opened again under its label, its first pane the one it wakes in', async () => {
  const o = ops()
  expect(await openTab(o.tabs, place, gone)).toBe('w8:p1')
  expect(o.calls).toEqual([['worktree', ROOT, TREE, 'TICKET-1', '1']])
  // The folder herdr wrote with a closing separator is the same folder.
  const slash = ops()
  expect(await openTab(slash.tabs, { ...place, worktree: { root: ROOT, path: `${TREE}/` } }, gone)).toBe('w8:p1')
})

test('#317 herdr has the worktree open already under another label: a new tab there', async () => {
  const o = ops({ alreadyOpen: true })
  expect(await openTab(o.tabs, place, gone)).toBe('w4:new')
  expect(o.calls).toEqual([
    ['worktree', ROOT, TREE, 'TICKET-1', '1'],
    ['tab', 'w4', TREE, '1'],
  ])
})

test('#317 as before: its workspace still there, no worktree noted, the session in another folder, a folder gone', async () => {
  const there = ops()
  expect(await openTab(there.tabs, place, { workspaces: [{ workspace_id: 'w5', label: 'TICKET-1' }] })).toBe('w5:new')
  expect(there.calls).toEqual([['tab', 'w5', TREE, '1']])

  const { worktree: _w, ...plain } = place
  const none = ops()
  await openTab(none.tabs, plain, gone)
  expect(none.calls).toEqual([['workspace', TREE, 'TICKET-1', '1']])

  const sub = ops()
  const inSub = `${TREE}${process.platform === 'win32' ? '\\' : '/'}app`
  await openTab(sub.tabs, { ...place, cwd: inSub }, gone)
  expect(sub.calls).toEqual([['workspace', inSub, 'TICKET-1', '1']])

  const treeGone = ops({ missing: [TREE] })
  await openTab(treeGone.tabs, place, gone)
  expect(treeGone.calls).toEqual([['workspace', '/home/me', 'TICKET-1', '1']])

  const repoGone = ops({ missing: [ROOT] })
  await openTab(repoGone.tabs, place, gone)
  expect(repoGone.calls).toEqual([['workspace', TREE, 'TICKET-1', '1']])

  const noOp = ops({ noWorktree: true })
  await openTab(noOp.tabs, place, gone)
  expect(noOp.calls).toEqual([['workspace', TREE, 'TICKET-1', '1']])
})

test('#317 herdr or git refusing the worktree: a plain workspace, so it still wakes', async () => {
  const o = ops({ fails: true })
  expect(await openTab(o.tabs, place, gone)).toBe('w9:p1')
  expect(o.calls).toEqual([
    ['worktree', ROOT, TREE, 'TICKET-1', '1'],
    ['workspace', TREE, 'TICKET-1', '1'],
  ])
})
