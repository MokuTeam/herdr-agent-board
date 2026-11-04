// A MokuPilot call agent as its file says (#326): MokuPilot's shape and version, named after its
// session, its MokuPilot alive, started within a day; its task board's roots with their steps
// rolled up; its card placed right after the session it is a fork of.
import { expect, test } from 'bun:test'
import { besideParents, parseCallAgent, tasksOf } from '../../src/core/call-agent.ts'

const NOW = 1_800_000_000_000
const S = '1f0c9a3e-0000-4000-8000-000000000001'
const P = '7a2b4c6d-0000-4000-8000-000000000002'
const file = (over: Record<string, unknown> = {}) => ({
  format: 'mokupilot-call-agent',
  version: 1,
  pid: 4242,
  session_id: S,
  harness: 'claude',
  parent_session_id: P,
  config_dir: '/home/me/.claude-work',
  cwd: '/home/me/project',
  started: NOW / 1000 - 600,
  call: 'on',
  busy: true,
  helpers: 2,
  updated: NOW / 1000 - 30,
  ...over,
})
const read = (raw: unknown, { name = S, alive = true } = {}) =>
  parseCallAgent(raw, { name, now: NOW, alive: () => alive })

test('a call agent: its session, parent, folder, call and turn, times in ms', () => {
  expect(read(file())).toEqual({
    session: S,
    harness: 'claude',
    parent: P,
    configDir: '/home/me/.claude-work',
    cwd: '/home/me/project',
    started: NOW - 600_000,
    phase: 'on',
    busy: true,
    helpers: 2,
    updated: NOW - 30_000,
  })
  // After the call; no turn; no count; no parent; unknown keys are skipped.
  expect(
    read(file({ call: 'after', busy: false, helpers: undefined, parent_session_id: '', extra: { x: 1 } })),
  ).toMatchObject({ phase: 'after', busy: false, helpers: null, parent: '' })
  expect(read(file({ harness: 'pi' }))?.harness).toBe('pi')
  // No harness named: Claude's. No update time: its start.
  expect(read(file({ harness: undefined, updated: undefined }))).toMatchObject({
    harness: 'claude',
    updated: NOW - 600_000,
  })
})

test('not MokuPilot’s, not its version, not named after its session, or of a MokuPilot gone: no agent', () => {
  for (const bad of [
    file({ format: 'agent-board' }),
    file({ format: undefined }),
    file({ version: 2 }),
    file({ version: 0 }),
    file({ version: '1' }),
    file({ session_id: '../x' }),
    file({ session_id: '' }),
    file({ harness: '../pi' }),
    file({ harness: 'codex' }),
    file({ pid: 0 }),
    file({ pid: '4242' }),
    file({ started: NOW / 1000 - 25 * 3600 }),
    file({ started: NOW / 1000 + 3600 }),
    file({ started: 'today' }),
    [],
    null,
    'x',
  ])
    expect(read(bad)).toBeNull()
  expect(read(file(), { name: 'other' })).toBeNull()
  expect(read(file(), { alive: false })).toBeNull()
})

const board = (items: unknown[], over: Record<string, unknown> = {}) => ({
  format: 'agent-board',
  version: 1,
  harness: 'claude',
  session_id: S,
  writer: 'mokupilot',
  items,
  ...over,
})

test('a task board: its roots in order, steps rolled up into their root', () => {
  const tasks = tasksOf(
    board([
      { id: 'b1', text: 'Check  the\ninvoice totals', status: 'doing' },
      { id: 'b2', text: 'Send the summary', status: 'next', owner: '' },
      { id: 'b3', text: 'Read the contract', status: 'next' },
      { id: 'b4', text: 'Clause 4', status: 'done', parent_id: 'b3' },
      { id: 'b5', text: 'Clause 7', status: 'next', parent_id: 'b3' },
      { id: 'b6', text: 'Orphan step', status: 'done', parent_id: 'gone' },
      { id: 'b7', text: 'Book the room', status: 'done' },
      { id: 'b8', text: '', status: 'doing' },
      { id: 'b9', text: 'Odd', status: 'blocked' },
    ]),
  )
  expect(tasks).toEqual([
    { id: 'b1', text: 'Check the invoice totals', status: 'doing' },
    { id: 'b2', text: 'Send the summary', status: 'next' },
    { id: 'b3', text: 'Read the contract', status: 'doing', steps: { done: 1, total: 2 } },
    { id: 'b6', text: 'Orphan step', status: 'done' },
    { id: 'b7', text: 'Book the room', status: 'done' },
  ])
  // All steps done: the root is done.
  expect(
    tasksOf(
      board([
        { id: 'b1', text: 'Root', status: 'next' },
        { id: 'b2', text: 'Step', status: 'done', parent_id: 'b1' },
      ]),
    ),
  ).toEqual([{ id: 'b1', text: 'Root', status: 'done', steps: { done: 1, total: 1 } }])
})

test('not a task board, or a newer one: no tasks', () => {
  const items = [{ id: 'b1', text: 'x', status: 'doing' }]
  expect(tasksOf(board(items, { format: 'other' }))).toEqual([])
  expect(tasksOf(board(items, { version: 2 }))).toEqual([])
  expect(tasksOf(board(items, { version: undefined }))).toHaveLength(1)
  expect(tasksOf(board('nope' as unknown as unknown[]))).toEqual([])
  expect(tasksOf(null)).toEqual([])
})

test('a call agent’s card goes right after its parent’s; the others keep their order', () => {
  const it = (key: string, parent?: string) => ({ key, ...(parent !== undefined && { call: { parent } }) })
  const order = (items: ReturnType<typeof it>[]) => besideParents(items).map(i => i.key)
  expect(order([it('c1', 'p'), it('a'), it('p'), it('b'), it('c2', 'p')])).toEqual(['a', 'p', 'c1', 'c2', 'b'])
  // Its parent not on the board, none, or itself (MokuPilot went on in the session): where it was.
  expect(order([it('c', 'gone'), it('a'), it('d', ''), it('e', 'e')])).toEqual(['c', 'a', 'd', 'e'])
  // One under another call agent goes after that one; a ring keeps its places; none is lost.
  expect(order([it('b', 'a'), it('p'), it('a', 'p'), it('z')])).toEqual(['p', 'a', 'b', 'z'])
  expect(order([it('x', 'y'), it('q'), it('y', 'x')])).toEqual(['x', 'q', 'y'])
  const plain = [it('a'), it('b')]
  expect(besideParents(plain)).toEqual(plain)
})
