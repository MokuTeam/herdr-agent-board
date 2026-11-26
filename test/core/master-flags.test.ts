// Feature flags from the master (#775, core/master-flags.ts): what a node takes from its master, and how
// its gates and briefs read them. A board without flags reads its config exactly as before.
import { expect, test } from 'bun:test'
import { decisionsConfig } from '../../src/core/decisions.ts'
import {
  briefFlags,
  FLAGS_STALE_MS,
  type MasterFlagsWire,
  masterFlagsOf,
  masterFlagsWireOf,
  sameFlags,
  staleFlagsLine,
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
  presence: { state: 'away', since: 1000, by: 'user', mode: 'auto' },
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
  expect(b.presence).toEqual({ state: 'away', since: 1000, by: 'user' })
  expect(b.team).toBe(true)
  expect(briefFlags({ master: 'm', on: [] }).team).toBe(false)
  expect(briefFlags(null)).toEqual({ threads: undefined, calendar: false, presence: null, team: false })
  expect(briefFlags({ master: 'm', on: [] }).threads).toBeUndefined()
  // Presence on at the master but no state said: nothing told, never a made-up "at the computer".
  expect(briefFlags({ master: 'm', on: ['presence'] }).presence).toBeNull()
})

test("presence: the master's state kept only when well formed and on", () => {
  const p: NonNullable<MasterFlagsWire['presence']> = { state: 'call', since: 5, by: 'auto', mode: 'suggest' }
  expect(masterFlagsWireOf({ master: 'm', on: ['presence'], presence: p })?.presence).toEqual(p)
  expect(masterFlagsWireOf({ master: 'm', on: [], presence: p })?.presence).toBeUndefined()
  expect(
    masterFlagsWireOf({ master: 'm', on: ['presence'], presence: { ...p, state: 'gone' } })?.presence,
  ).toBeUndefined()
  expect(masterFlagsWireOf({ master: 'm', on: ['presence'], presence: { ...p, since: -1 } })?.presence).toBeUndefined()
  // A change of the state alone is not a change of the features.
  const away: MasterFlagsWire = { master: 'm', on: ['presence'], presence: { ...p, state: 'away' } }
  expect(sameFlags(away, { ...away, presence: p })).toBe(false)
  expect(sameFlags(away, { ...away, presence: p }, { presence: false })).toBe(true)
})

test('stale flags: the age of the last word from the master, nothing while current', () => {
  const now = 10 * 3_600_000
  expect(staleFlagsLine(null, now)).toBeNull()
  expect(staleFlagsLine({ at: now - FLAGS_STALE_MS }, now)).toBeNull()
  expect(staleFlagsLine({ at: now - 20 * 60_000 }, now)).toBe(
    "[agent-board] The master board was last heard from 20 min ago: the user's presence above is as it was then and may have changed.",
  )
  expect(staleFlagsLine({ at: now - 5 * 3_600_000 }, now)).toContain('5 h ago')
})

test("threads' verify and share are kept when they are booleans, and absent otherwise (#797)", () => {
  expect(
    masterFlagsWireOf({ master: 'laptop', on: ['threads'], threads: { agents: true, verify: true, share: false } }),
  ).toEqual({ master: 'laptop', on: ['threads'], threads: { agents: true, verify: true, share: false } })
  expect(
    masterFlagsWireOf({ master: 'laptop', on: ['threads'], threads: { agents: true, verify: 'on', share: 1 } }),
  ).toEqual({ master: 'laptop', on: ['threads'], threads: { agents: true } })
})
