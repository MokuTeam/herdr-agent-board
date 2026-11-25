// A node's Settings for its master's features (#775, web/src/models/master-owned.ts): what is on at the
// master, read-only, never this computer's own off values.
import { expect, test } from 'bun:test'
import { masterOwnedNow } from '../../web/src/models/master-owned.ts'

test('each feature as the master has it', () => {
  expect(
    masterOwnedNow({
      master: 'laptop',
      at: 1,
      on: ['threads', 'todos', 'decisions', 'watches', 'journal', 'presence'],
      threads: { agents: false, cases: true },
      todos: { agents: true, autoClose: true },
      decisions: { defaults: false },
      presenceMode: 'suggest',
    }),
  ).toEqual({
    todos: 'auto',
    threads: 'mine',
    threadsCases: true,
    watches: true,
    decisions: true,
    decisionsDefaults: false,
    journal: true,
    presence: 'suggest',
  })
})

test('off at the master: off here too; on without its fields: the readers defaults', () => {
  expect(masterOwnedNow({ master: 'laptop', at: 1, on: [] })).toEqual({
    todos: 'none',
    threads: 'none',
    threadsCases: false,
    watches: false,
    decisions: false,
    decisionsDefaults: false,
    journal: false,
    presence: 'none',
  })
  const bare = masterOwnedNow({ master: 'laptop', at: 1, on: ['threads', 'todos', 'decisions', 'presence'] })
  expect([bare.todos, bare.threads, bare.decisionsDefaults, bare.presence]).toEqual(['agents', 'agents', true, 'auto'])
})
