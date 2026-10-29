import { expect, test } from 'bun:test'
import {
  asFreedPlace,
  type FreedSnapshot,
  freePlan,
  promptIdle,
  promptRows,
  promptShows,
  tabFocused,
} from '../../../src/core/wake/freed.ts'

const now = Date.parse('2026-10-27T12:00:00Z')
const PROJECT = 'C:\\Work\\Проект x 50%'
const sidebar = (pane: string, tab: string) => ({
  pane_id: pane,
  tab_id: tab,
  workspace_id: 'w1',
  cwd: PROJECT,
  tokens: { 'herdr-sidebar-git': '1' },
})
const shell = (pane: string, tab: string, more: Record<string, unknown> = {}) => ({
  pane_id: pane,
  tab_id: tab,
  workspace_id: 'w1',
  cwd: PROJECT,
  ...more,
})

/** Workspace "Счета 100%" with tabs t1 (first) and t2 "Billing", each with a sidebar; `extra` panes added. */
function snap(o: { tabs?: string[]; extra?: FreedSnapshot['panes'] } = {}): FreedSnapshot {
  const tabs = o.tabs ?? ['t1', 't2']
  return {
    workspaces: [{ workspace_id: 'w1', label: 'Main 100%' }],
    tabs: tabs.map((id, i) => ({ tab_id: id, workspace_id: 'w1', label: i ? 'Billing' : '1', number: i + 1 })),
    panes: [...tabs.flatMap(t => [shell(`${t}-claude`, t), sidebar(`${t}-side`, t)]), ...(o.extra ?? [])],
  }
}

test('a tab that is not its workspace’s first, nothing but a sidebar beside: the tab goes, its topic kept', () => {
  expect(freePlan(snap(), 't2-claude', now)).toEqual({
    close: { tab: 't2' },
    place: {
      pane: 't2-claude',
      workspace: 'w1',
      workspaceLabel: 'Main 100%',
      tabLabel: 'Billing',
      topic: 'topic:Main 100% / Billing',
      at: now,
    },
  })
})

test('the user’s pane beside it (a shell, another agent): only the sleeper’s pane goes', () => {
  for (const other of [shell('mine', 't2'), shell('agent', 't2', { agent: 'pi' })])
    expect(freePlan(snap({ extra: [other] }), 't2-claude', now)?.close).toEqual({ pane: 't2-claude' })
})

test('a workspace’s first tab with other tabs keeps its pane: closing it would move the topics', () => {
  expect(freePlan(snap(), 't1-claude', now)).toBeNull()
  expect(freePlan(snap({ extra: [shell('mine', 't1')] }), 't1-claude', now)).toBeNull()
})

test('a workspace’s only tab, alone in it: the tab goes (and the workspace), back as a new one’s first', () => {
  expect(freePlan(snap({ tabs: ['t1'] }), 't1-claude', now)).toMatchObject({
    close: { tab: 't1' },
    place: { topic: 'topic:Main 100%', tabLabel: '1', workspaceLabel: 'Main 100%' },
  })
  // With the user's pane beside it, it would wake in a second tab: another topic.
  expect(freePlan(snap({ tabs: ['t1'], extra: [shell('mine', 't1')] }), 't1-claude', now)).toBeNull()
})

test('nothing to close: an agent in the pane, a pane herdr does not have, a tab or workspace herdr does not show', () => {
  const s = snap()
  expect(freePlan(s, 'nope', now)).toBeNull()
  const busy = snap({ extra: [] })
  busy.panes = busy.panes.map(p => (p.pane_id === 't2-claude' ? { ...p, agent: 'claude' } : p))
  expect(freePlan(busy, 't2-claude', now)).toBeNull()
  expect(freePlan({ ...s, tabs: [] }, 't2-claude', now)).toBeNull()
  expect(freePlan({ ...s, workspaces: [] }, 't2-claude', now)).toBeNull()
})

test('a place as the session file has it; what does not read as one is none', () => {
  const place = {
    pane: 'w1:p2',
    workspace: 'w1',
    workspaceLabel: 'Main',
    tabLabel: 'B',
    topic: 'topic:Main / B',
    at: now,
  }
  expect(asFreedPlace({ ...place, extra: 1 })).toEqual(place)
  expect(asFreedPlace({ pane: 'w1:p2', topic: '', at: now })).toEqual({ pane: 'w1:p2', topic: '', at: now })
  for (const bad of [null, 'x', [], { ...place, pane: '' }, { ...place, at: 'now' }, { ...place, topic: 1 }])
    expect(asFreedPlace(bad)).toBeNull()
})

test('the tab the user looks at is left as it is, whichever of its panes has the focus', () => {
  const focused = snap()
  focused.focused_pane_id = 't2-side'
  expect(freePlan(focused, 't2-claude', now)).toBeNull()
  const flagged = snap()
  flagged.panes = flagged.panes.map(p => (p.pane_id === 't2-claude' ? { ...p, focused: true } : p))
  expect(freePlan(flagged, 't2-claude', now)).toBeNull()
  // Another tab focused: this one goes.
  const elsewhere = snap()
  elsewhere.focused_pane_id = 't1-claude'
  expect(freePlan(elsewhere, 't2-claude', now)?.close).toEqual({ tab: 't2' })
})

test('a pane taken back later must still have its 💤 label; a workspace another sleeper comes back to keeps its last tab', () => {
  const s = snap({ tabs: ['t1'] })
  s.panes = s.panes.map(p => (p.pane_id === 't1-claude' ? { ...p, label: '💤 Billing' } : p))
  expect(freePlan(s, 't1-claude', now, { label: '💤 Billing' })?.close).toEqual({ tab: 't1' })
  expect(freePlan(s, 't1-claude', now, { label: '💤 Other' })).toBeNull()
  expect(freePlan(s, 't1-claude', now, { held: ws => ws.label === 'Main 100%' })).toBeNull()
  // Not its last tab: the workspace stays whatever comes back to it.
  expect(freePlan(snap(), 't2-claude', now, { held: () => true })?.close).toEqual({ tab: 't2' })
})

test('a sidebar whose tokens have expired, known by its label, is still nothing of the user’s', () => {
  const s = snap()
  s.panes = s.panes.map(p => (p.pane_id === 't2-side' ? { ...shell('t2-side', 't2'), label: 'Sidebar' } : p))
  expect(freePlan(s, 't2-claude', now)?.close).toEqual({ tab: 't2' })
})

test('promptIdle: an empty prompt of any shell, or nothing but this session’s wake line, wrapped or not', () => {
  const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
  const PS = 'PS C:\\Work\\Проект x 50%> '
  for (const screen of [
    PS,
    'out\nuser@box:~/w$ ',
    'C:\\Work>',
    'host% ',
    '~/w ❯ ',
    `Resume this session with:\nclaude --resume ${SID}\n${PS}`,
    `${PS}board resume ${SID} --profile work`,
    `$ board resume ${SID}`,
    `$ claude-tg --dangerously-skip-permissions --resume ${SID}`,
    `$ cldt --resume ${SID}`,
    // Wrapped at the pane's width: the id split, or a space lost at a row's end.
    `${PS}board resume 0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f\n4a5b --profile defau\nlt`,
    `${PS}claude-tg --dangerously-skip-permissions --resume\n${SID.slice(0, 20)}\n${SID.slice(20)}\n\n`,
  ])
    expect([screen, promptIdle(screen, SID)]).toEqual([screen, true])
  for (const screen of [
    '',
    '\n\n',
    // No prompt on the screen (Claude's last words, a program's output).
    `claude --resume ${SID}`,
    `${PS}cd ..`,
    '$ ls -la',
    'PS> echo 100%',
    `${PS}Get-ChildItem -Recurse #`,
    '$ cat file >',
    // PowerShell's continuation prompt: a command not finished.
    `${PS}Get-Item x |\n>> `,
    `$ echo ${SID}`,
    `${PS}board resume ${SID} --profile work; rm x`,
    `${PS}board resume ${SID} && claude`,
    `$ board resume 6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d`,
    `$ board resume ${SID}\nls`,
  ])
    expect([screen, promptIdle(screen, SID)]).toEqual([screen, false])
})

test('#243 promptShows: no prompt yet, the wake line (wrapped too), an empty prompt, or anything else', () => {
  const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
  const PS = 'PS C:WorkПроект x 50%> '
  const cases: [string, ReturnType<typeof promptShows>][] = [
    ['', 'none'],
    ['\n\n', 'none'],
    [`claude --resume ${SID}`, 'none'],
    [PS, 'empty'],
    ['out\nuser@box:~/w$ ', 'empty'],
    [`${PS}board resume ${SID}\n${PS}git status\nOn branch main\n${PS}`, 'empty'],
    [`${PS}board resume ${SID} --profile work`, 'line'],
    [`$ claude-tg --dangerously-skip-permissions --resume ${SID}`, 'line'],
    [`${PS}board resume 0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f\n4a5b --profile defau\nlt`, 'line'],
    [`${PS}cd ..`, 'other'],
    [`${PS}Get-Item x |\n>> `, 'other'],
    [`$ board resume 6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d`, 'other'],
    [`$ board resume ${SID} && claude`, 'other'],
  ]
  for (const [screen, shows] of cases) expect([screen, promptShows(screen, SID)]).toEqual([screen, shows])
  // Not a session id: never its wake line.
  expect(promptShows('$ board resume pane-7', 'pane-7')).toBe('other')
})

test('#243 promptRows: one in a shell that has just started (its prompt wrapped too), more once anything ran', () => {
  const PS = 'PS C:\\Work\\Проект x 50%> '
  expect(promptRows(PS)).toBe(1)
  expect(promptRows(`\n\n${PS}\n\n`)).toBe(1)
  // A narrow pane wraps the prompt: the folder's part has no end mark.
  expect(promptRows('PS C:\\Work\\BB\\Proj\nect> ')).toBe(1)
  expect(promptRows(`${PS}git status\nOn branch main\n${PS}`)).toBe(2)
  expect(promptRows(`${PS}ssh prod\nLast login\nroot@prod:~# `)).toBe(2)
  expect(promptRows('')).toBe(0)
})

test('#243 tabFocused: herdr’s focused pane, or a pane marked focused, anywhere in the pane’s tab', () => {
  const snap = (focused: Record<string, unknown> = {}, id?: string): FreedSnapshot => ({
    workspaces: [{ workspace_id: 'w1', label: 'Main' }],
    tabs: [
      { tab_id: 't1', workspace_id: 'w1' },
      { tab_id: 't2', workspace_id: 'w1' },
    ],
    panes: [shell('w1:p1', 't1'), sidebar('w1:s1', 't1'), shell('w1:p2', 't2', focused)],
    ...(id && { focused_pane_id: id }),
  })
  expect(tabFocused(snap(), 'w1:p1')).toBe(false)
  expect(tabFocused(snap({ focused: true }), 'w1:p1')).toBe(false)
  expect(tabFocused(snap({}, 'w1:s1'), 'w1:p1')).toBe(true)
  expect(tabFocused(snap({}, 'w1:p1'), 'w1:p1')).toBe(true)
  expect(tabFocused(snap({ focused: true }), 'w1:p2')).toBe(true)
  expect(tabFocused(snap({}, 'w1:s1'), 'w9:p9')).toBe(false)
})
