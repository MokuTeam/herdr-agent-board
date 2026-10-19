// herdr's JSON answers as the board reads them (src/adapters/herdr.ts): narrowed, never cast.
import { expect, test } from 'bun:test'
import { asAgent, asSnapshot } from '../../src/adapters/herdr.ts'
import { isAgentStatus } from '../../src/core/board.ts'

test('a snapshot keeps the workspaces, tabs and panes with an id, and the fields of the type the board takes', () => {
  const snap = asSnapshot({
    snapshot: {
      focused_pane_id: 'p1',
      future: { kept: true },
      workspaces: [
        { workspace_id: 'w1', label: 'Acme', extra: 1 },
        { label: 'no id' },
        null,
        { workspace_id: 'w2', label: 7 },
      ],
      tabs: [{ tab_id: 't1', workspace_id: 'w1' }, { tab_id: 't2' }, 'tab'],
      panes: [
        {
          pane_id: 'p1',
          tab_id: 't1',
          workspace_id: 'w1',
          agent: 'claude',
          agent_status: 'working',
          agent_session: { value: 's1' },
          cwd: 'C:\\Acme',
          tokens: { 'herdr-sidebar': 1 },
          extra: 'kept',
        },
        { pane_id: 'p2', agent: 5, cwd: null, agent_session: { value: 9 }, tokens: [] },
        { pane_id: 'p3', agent_session: 'not a token' },
        { agent: 'claude' },
        42,
      ],
    },
  })
  expect(snap.focused_pane_id).toBe('p1')
  expect(snap.future).toEqual({ kept: true })
  expect(snap.workspaces).toEqual([{ workspace_id: 'w1', label: 'Acme', extra: 1 }, { workspace_id: 'w2' }])
  expect(snap.tabs).toEqual([{ tab_id: 't1', workspace_id: 'w1' }])
  expect(snap.panes).toEqual([
    {
      pane_id: 'p1',
      tab_id: 't1',
      workspace_id: 'w1',
      agent: 'claude',
      agent_status: 'working',
      agent_session: { value: 's1' },
      cwd: 'C:\\Acme',
      tokens: { 'herdr-sidebar': 1 },
      extra: 'kept',
    },
    { pane_id: 'p2', agent_session: { value: null } },
    { pane_id: 'p3' },
  ])
})

test('a snapshot without its lists has none; an answer without a snapshot is an error', () => {
  expect(asSnapshot({ snapshot: { focused_pane_id: 3 } })).toEqual({ workspaces: [], tabs: [], panes: [] })
  expect(() => asSnapshot(null)).toThrow(/no snapshot/)
  expect(() => asSnapshot({ snapshot: [] })).toThrow(/no snapshot/)
})

test('agent get: the kind, a status herdr may not know yet, the session and name; none without an agent', () => {
  expect(
    asAgent({ agent: { agent: 'claude', agent_status: 'blocked', agent_session: { value: 's1' }, name: 'acme' } }),
  ).toEqual({ kind: 'claude', status: 'blocked', session: 's1', name: 'acme' })
  expect(asAgent({ agent: { agent_status: 'thinking', agent_session: { value: 3 }, name: null } })).toEqual({
    kind: null,
    status: 'unknown',
    session: null,
    name: null,
  })
  expect(asAgent({ agent: null })).toBe(null)
  expect(asAgent(null)).toBe(null)
  expect(asAgent('claude')).toBe(null)
})

test("herdr's agent statuses, and nothing else", () => {
  for (const s of ['idle', 'working', 'blocked', 'done', 'unknown', 'sleeping']) expect(isAgentStatus(s)).toBe(true)
  for (const s of ['thinking', '', 'Idle', null, undefined, 1, {}]) expect(isAgentStatus(s)).toBe(false)
})
