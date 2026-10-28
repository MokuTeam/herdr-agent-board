// Tasks (#202), their pure rules: config.json's section, the changes to a card's list (who may
// close what, a double pin, the done ones kept), a message's points and the agents' brief line.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { brief } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import {
  applyTodo,
  cleanTodoText,
  DONE_KEPT,
  DONE_KEPT_MS,
  messagePoints,
  sortTodos,
  TODO_TEXT_MAX,
  type Todo,
  todoModeOf,
  todosConfig,
  todosOf,
} from '../../src/core/todos.ts'

let n = 0
const id = () => `t${++n}`
const T0 = 1_000_000

test('todos config: off unless config.json turns it on; agents unless the section says not', () => {
  assert.equal(todosConfig(undefined), null)
  assert.equal(todosConfig(false), null)
  assert.equal(todosConfig('yes'), null)
  assert.equal(todosConfig([]), null)
  assert.deepEqual(todosConfig(true), { agents: true })
  assert.deepEqual(todosConfig({}), { agents: true })
  assert.deepEqual(todosConfig({ agents: false }), { agents: false })
  assert.equal(todoModeOf(null), 'none')
  assert.equal(todoModeOf({ agents: false }), 'mine')
  assert.equal(todoModeOf({ agents: true }), 'agents')
})

test('a pin adds a point once: the same open point of the same message again changes nothing', () => {
  const anchor = { id: 'u1', at: 5 }
  const a = applyTodo([], { op: 'add', text: '  Update  the key ', owner: 'user', by: 'user', anchor }, T0, id)
  assert.ok('list' in a)
  assert.equal(a.list.length, 1)
  assert.deepEqual(a.todo, { id: a.todo?.id, text: 'Update the key', owner: 'user', by: 'user', at: T0, anchor })
  const b = applyTodo(a.list, { op: 'add', text: 'Update the key', owner: 'user', by: 'user', anchor }, T0 + 1, id)
  assert.ok('list' in b)
  assert.equal(b.list.length, 1)
  assert.equal(b.todo?.id, a.todo?.id)
  // Another message's point with the same words is another point.
  const c = applyTodo(
    b.list,
    { op: 'add', text: 'Update the key', owner: 'user', by: 'user', anchor: { at: 9 } },
    T0,
    id,
  )
  assert.ok('list' in c)
  assert.equal(c.list.length, 2)
  assert.deepEqual(applyTodo([], { op: 'add', text: '  ', owner: 'user', by: 'user' }, T0, id), {
    error: 'todo.err.empty',
  })
})

test('an agent closes only its own promises; the user closes any; reopen and remove', () => {
  const user: Todo = { id: 'a', text: 'yours', owner: 'user', by: 'user', at: T0 }
  const agent: Todo = { id: 'b', text: 'mine', owner: 'agent', by: 'agent', at: T0 }
  assert.deepEqual(applyTodo([user, agent], { op: 'done', id: 'a', by: 'agent' }, T0, id), {
    error: 'todo.err.notYours',
  })
  const r = applyTodo([user, agent], { op: 'done', id: 'b', by: 'agent' }, T0 + 5, id)
  assert.ok('list' in r)
  assert.deepEqual(r.todo, { ...agent, done: T0 + 5, doneBy: 'agent' })
  const u = applyTodo(r.list, { op: 'done', id: 'a', by: 'user' }, T0 + 6, id)
  assert.ok('list' in u)
  const back = applyTodo(u.list, { op: 'reopen', id: 'a' }, T0 + 7, id)
  assert.ok('list' in back)
  assert.deepEqual(back.todo, user)
  const gone = applyTodo(back.list, { op: 'remove', id: 'b' }, T0 + 8, id)
  assert.ok('list' in gone)
  assert.deepEqual(gone.list, [user])
  assert.deepEqual(applyTodo([], { op: 'done', id: 'x', by: 'user' }, T0, id), { error: 'todo.err.gone' })
})

test('done points go after DONE_KEPT_MS, and past DONE_KEPT the oldest go; open ones always stay', () => {
  const open: Todo = { id: 'o', text: 'open', owner: 'user', by: 'user', at: 0 }
  const old: Todo = { id: 'old', text: 'old', owner: 'user', by: 'user', at: 0, done: 1, doneBy: 'user' }
  const many: Todo[] = Array.from({ length: DONE_KEPT + 3 }, (_, k) => ({
    id: `d${k}`,
    text: `d${k}`,
    owner: 'user',
    by: 'user',
    at: 0,
    done: DONE_KEPT_MS + k,
    doneBy: 'user',
  }))
  const r = applyTodo([open, old, ...many], { op: 'reopen', id: 'o' }, DONE_KEPT_MS + 100, id)
  assert.ok('list' in r)
  assert.ok(r.list.some(x => x.id === 'o'))
  assert.ok(!r.list.some(x => x.id === 'old'))
  assert.equal(r.list.filter(x => x.done).length, DONE_KEPT)
  assert.ok(!r.list.some(x => x.id === 'd0'))
})

test("a message's points: its list items at any depth, outside code; else its first paragraph", () => {
  const text = [
    'Here is the plan:',
    '',
    '1. **Update** the key in `.env`',
    '2) Run [the migration](https://x.y/z)',
    '   - [ ] check the logs',
    '* last one',
    '```',
    '- not a point',
    '```',
  ].join('\n')
  assert.deepEqual(messagePoints(text), ['Update the key in `.env`', 'Run the migration', 'check the logs', 'last one'])
  assert.deepEqual(messagePoints('## Done\n\nAll merged.\n\nNext time.'), ['Done'])
  assert.deepEqual(messagePoints('All merged,\nnothing left.'), ['All merged, nothing left.'])
  assert.deepEqual(messagePoints('   '), [])
  assert.equal(cleanTodoText('x'.repeat(TODO_TEXT_MAX + 5)).length, TODO_TEXT_MAX)
})

test("a card's points as its file holds them: what is no point is left out; open first, oldest first", () => {
  const a: Todo = { id: 'a', text: 'a', owner: 'user', by: 'user', at: 2 }
  const b: Todo = { id: 'b', text: 'b', owner: 'agent', by: 'agent', at: 1 }
  const c: Todo = { id: 'c', text: 'c', owner: 'user', by: 'user', at: 0, done: 3, doneBy: 'user' }
  assert.deepEqual(todosOf([a, { id: 1 }, 'x', b]), [a, b])
  assert.deepEqual(todosOf({}), [])
  assert.deepEqual(
    sortTodos([c, a, b]).map(x => x.id),
    ['b', 'a', 'c'],
  )
})

test('the brief tells Claude of board todo only with agents on', () => {
  const cfg = normalizeConfig({})
  const env = {}
  assert.ok(!brief(cfg, null, '', env, 'Claude', null, null).includes('board todo'))
  assert.ok(!brief(cfg, null, '', env, 'Claude', null, { agents: false }).includes('board todo'))
  assert.ok(brief(cfg, null, '', env, 'Claude', null, { agents: true }).includes('board todo add'))
  assert.ok(!brief(cfg, null, '', env, 'Codex', null, { agents: true }).includes('board todo'))
})
