// Feature flags from the master (#775, core/master-flags.ts): what a node takes from its master, and how
// its gates and briefs read them. A board without flags reads its config exactly as before.
import { expect, test } from 'bun:test'
import { decisionsConfig } from '../../src/core/decisions.ts'
import {
  briefFlags,
  type MasterFlagsWire,
  masterFlagsOf,
  masterFlagsWireOf,
  sameFlags,
  withMasterFlags,
} from '../../src/core/master-flags.ts'
import { todosConfig } from '../../src/core/todos.ts'
import { watchesConfig } from '../../src/core/watches.ts'
import { threadsConfig } from '../../src/core/work-threads.ts'

const ALL: MasterFlagsWire = {
  master: 'laptop',
  on: ['threads', 'calendar', 'decisions', 'presence', 'watches', 'todos', 'team'],
  threads: { agents: true, cases: true },
  todos: { agents: true, autoClose: true },
  decisions: { defaults: false },
}

test('the wire keeps known keys and fields of their kind only', () => {
  expect(
    masterFlagsWireOf({
      master: 'laptop',
      on: ['threads', 'nonsense', 'todos', 7],
      threads: { agents: false, cases: 'yes', hub: 'ws://x' },
      todos: { agents: true },
      decisions: { defaults: true },
      team: { hub: 'ws://secret' },
    }),
  ).toEqual({ master: 'laptop', on: ['threads', 'todos'], threads: { agents: false }, todos: { agents: true } })
  expect(masterFlagsWireOf({ master: '', on: [] })).toBeNull()
  expect(masterFlagsWireOf({ master: 'a b', on: [] })).toBeNull()
  expect(masterFlagsWireOf({ master: 'laptop' })).toBeNull()
  expect(masterFlagsOf({ ...ALL, at: 5 })?.at).toBe(5)
  expect(masterFlagsOf(ALL)).toBeNull()
})

test('sameFlags ignores when they came', () => {
  expect(sameFlags({ ...ALL }, masterFlagsOf({ ...ALL, at: 9 }))).toBe(true)
  expect(sameFlags(ALL, { ...ALL, on: ['threads'] })).toBe(false)
  expect(sameFlags(null, ALL)).toBe(false)
})

test('no flags: the config itself, nothing added', () => {
  const cfg = { language: 'en' }
  expect(withMasterFlags(cfg, null)).toBe(cfg)
  expect(withMasterFlags(cfg, { master: 'laptop', on: ['threads', 'calendar'] })).toBe(cfg)
})

test('on at the master: the card-level features read as on, with its settings; the master-run ones are not added', () => {
  const cfg = { language: 'en' } as Record<string, unknown>
  const g = withMasterFlags(cfg, ALL)
  expect(g).not.toBe(cfg)
  expect(cfg).toEqual({ language: 'en' })
  expect(watchesConfig(g.watches)).toEqual({ on: true })
  expect(todosConfig(g.todos)).toEqual({ agents: true, autoClose: true })
  expect(decisionsConfig(g.decisions)).toEqual({ defaults: false })
  expect(g.threads).toBeUndefined()
  expect(g.calendar).toBeUndefined()
  expect(g.team).toBeUndefined()
  expect(
    todosConfig(
      withMasterFlags({} as Record<string, unknown>, { master: 'm', on: ['todos'], todos: { agents: false } }).todos,
    ),
  ).toEqual({
    agents: false,
  })
})

test("the node's own section wins; one it turned off reads the master's", () => {
  const own = { todos: { agents: false }, watches: { on: false } }
  const g = withMasterFlags(own, ALL)
  expect(g.todos).toEqual({ agents: false })
  expect(watchesConfig(g.watches)).toEqual({ on: true })
})

test('the briefs: threads as their reader takes them, calendar, presence', () => {
  const b = briefFlags(ALL)
  expect(threadsConfig(b.threads)).toMatchObject({ agents: true, cases: true })
  expect(b.calendar).toBe(true)
  expect(b.presence).toBe(true)
  expect(briefFlags(null)).toEqual({ threads: undefined, calendar: false, presence: false })
  expect(briefFlags({ master: 'm', on: [] }).threads).toBeUndefined()
})
