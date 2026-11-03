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
  findTodo,
  isProposed,
  messagePoints,
  numberTodos,
  sortTodos,
  TODO_TEXT_MAX,
  type Todo,
  todoKey,
  todoModeOf,
  todosConfig,
  todosNews,
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
  assert.deepEqual(todosConfig({ autoClose: true }), { agents: true, autoClose: true })
  assert.deepEqual(todosConfig({ agents: false, autoClose: true }), { agents: false })
  assert.deepEqual(todosConfig({ autoClose: 'yes' }), { agents: true })
  assert.equal(todoModeOf(null), 'none')
  assert.equal(todoModeOf({ agents: false }), 'mine')
  assert.equal(todoModeOf({ agents: true }), 'agents')
  assert.equal(todoModeOf({ agents: true, autoClose: true }), 'auto')
})

test('a pin adds a point once: the same open point of the same message again changes nothing', () => {
  const anchor = { id: 'u1', at: 5 }
  const a = applyTodo([], { op: 'add', text: '  Update  the key ', owner: 'user', by: 'user', anchor }, T0, id)
  assert.ok('list' in a)
  assert.equal(a.list.length, 1)
  assert.deepEqual(a.todo, { id: a.todo?.id, text: 'Update the key', owner: 'user', by: 'user', at: T0, n: 1, anchor })
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

test("an agent closes its own promises, and proposes the user's; the user closes any; reopen and remove", () => {
  const user: Todo = { id: 'a', text: 'yours', owner: 'user', by: 'user', at: T0, n: 1 }
  const agent: Todo = { id: 'b', text: 'mine', owner: 'agent', by: 'agent', at: T0, n: 2 }
  const p = applyTodo([user, agent], { op: 'done', id: 'a', by: 'agent' }, T0, id)
  assert.ok('list' in p)
  assert.deepEqual(p.todo, { ...user, proposed: { at: T0 } })
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

// #319: numbers and keys, what a point refers to, and closing by agents with the user's approval.
const pt = (id: string, at: number, more: Partial<Todo> = {}): Todo => ({
  id,
  text: id,
  owner: 'user',
  by: 'agent',
  at,
  ...more,
})

test('#319 points without a number get the next ones, in the order they were made; the same input numbers the same', () => {
  const list = [pt('late', 30), pt('kept', 5, { n: 4 }), pt('early', 10), pt('twin-b', 20), pt('twin-a', 20)]
  const once = numberTodos(list, 2)
  assert.deepEqual(
    once.list.map(x => [x.id, x.n]),
    [
      ['late', 8],
      ['kept', 4],
      ['early', 5],
      ['twin-b', 7],
      ['twin-a', 6],
    ],
  )
  assert.equal(once.seq, 8)
  assert.deepEqual(numberTodos(list, 2), once)
  // A counter past every number keeps counting from there; nothing to number keeps the list.
  assert.equal(numberTodos([pt('a', 1, { n: 1 })], 9).seq, 9)
  assert.equal(numberTodos([], 0).seq, 0)
  // An add numbers what was there first, then itself.
  const r = applyTodo([pt('old', 1)], { op: 'add', text: 'new', owner: 'user', by: 'agent' }, T0, id, 3)
  assert.ok('list' in r)
  assert.deepEqual(
    r.list.map(x => x.n),
    [4, 5],
  )
  assert.equal(r.seq, 5)
})

test('#319 a key: lane, session and number; the lane once when the name starts with it; any alphabet, spaces and %', () => {
  const x = pt('abc', 1, { n: 3 })
  assert.equal(todoKey({ category: 'acme', name: 'ticket-12' }, x), 'acme-ticket-12-3')
  assert.equal(todoKey({ category: 'acme', name: 'acme-7f' }, x), 'acme-7f-3')
  assert.equal(todoKey({ category: 'acme', name: 'Acme' }, x), 'acme-3')
  assert.equal(todoKey({ category: 'work', name: 'Счета 100% x' }, x), 'work-счета-100-x-3')
  assert.equal(todoKey({ name: 'Solo' }, x), 'solo-3')
  assert.equal(todoKey({}, x), '3')
  assert.equal(todoKey({ category: 'acme', name: 'x' }, pt('abc', 1)), 'abc')
})

test('#319 a task by its key, its number or its id; nothing for a word that names none', () => {
  const list = [pt('a1b2c3d4', 1, { n: 2 }), pt('e5f6a7b8', 2, { n: 12 })]
  assert.equal(findTodo(list, 'acme-ticket-12-12')?.id, 'e5f6a7b8')
  assert.equal(findTodo(list, '#2')?.id, 'a1b2c3d4')
  assert.equal(findTodo(list, '12')?.id, 'e5f6a7b8')
  assert.equal(findTodo(list, 'a1b2c3d4')?.id, 'a1b2c3d4')
  assert.equal(findTodo(list, 'acme-3'), undefined)
  assert.equal(findTodo(list, 'ticket12'), undefined)
  assert.equal(findTodo(list, ' '), undefined)
})

test('#319 what a point refers to and waits on: kept as one line, cut, left out when empty', () => {
  const r = applyTodo(
    [],
    { op: 'add', text: 'Post the reply', owner: 'user', by: 'agent', ref: ' TICKET-12 ', why: `${'x'.repeat(400)}\n` },
    T0,
    id,
  )
  assert.ok('list' in r)
  assert.equal(r.todo?.ref, 'TICKET-12')
  assert.equal(r.todo?.why?.length, 300)
  const bare = applyTodo([], { op: 'add', text: 'x', owner: 'user', by: 'agent', ref: '  ', why: '' }, T0, id)
  assert.ok('list' in bare)
  assert.ok(!('ref' in (bare.todo ?? {})) && !('why' in (bare.todo ?? {})))
})

test("#319 an agent proposes the user's point done; the user closes it or keeps it open; autoClose closes it", () => {
  const user = pt('a', 1, { n: 1 })
  const p = applyTodo([user], { op: 'done', id: 'a', by: 'agent', why: 'comment posted' }, T0, id)
  assert.ok('list' in p)
  assert.deepEqual(p.todo, { ...user, proposed: { at: T0, why: 'comment posted' } })
  assert.ok(p.todo && isProposed(p.todo))
  // The user confirms: done by the user, the agent's reason kept.
  const c = applyTodo(p.list, { op: 'done', id: 'a', by: 'user' }, T0 + 1, id)
  assert.ok('list' in c)
  assert.deepEqual(c.todo, { ...user, done: T0 + 1, doneBy: 'user', doneWhy: 'comment posted' })
  // Or keeps it open: no proposal left.
  const k = applyTodo(p.list, { op: 'keep', id: 'a' }, T0 + 1, id)
  assert.ok('list' in k)
  assert.deepEqual(k.todo, user)
  // autoClose: closed by the agent with its reason, and it can be opened again.
  const auto = applyTodo([user], { op: 'done', id: 'a', by: 'agent', why: 'sent', auto: true }, T0, id)
  assert.ok('list' in auto)
  assert.deepEqual(auto.todo, { ...user, done: T0, doneBy: 'agent', doneWhy: 'sent' })
  const back = applyTodo(auto.list, { op: 'reopen', id: 'a' }, T0 + 2, id)
  assert.ok('list' in back)
  assert.deepEqual(back.todo, user)
  // A done point stays as it is.
  const again = applyTodo(c.list, { op: 'done', id: 'a', by: 'agent', why: 'later' }, T0 + 5, id)
  assert.ok('list' in again)
  assert.deepEqual(again.todo, c.todo)
})

test('#319 the open points told to the agent once per change, with their keys; a start tells them again', () => {
  const card = {
    category: 'acme',
    name: 'ticket-12',
    todos: [pt('a', 1, { n: 1, ref: 'TICKET-12' }), pt('b', 2, { n: 2, owner: 'agent' })],
    todoSeq: 2,
  }
  const first = todosNews(card)
  assert.ok(first?.line)
  assert.ok(first.line.includes('board todo done <key> --why'))
  assert.ok(first.line.includes("acme-ticket-12-1 · the user's · a · ref TICKET-12"))
  assert.ok(first.line.includes('acme-ticket-12-2 · yours · b'))
  assert.equal(first.seen, 'a,b')
  assert.equal(todosNews({ ...card, todosSeen: first.seen }), null)
  // Proposed: a change, told again.
  const proposed = {
    ...card,
    todos: [pt('a', 1, { n: 1, proposed: { at: 3 } }), card.todos[1] as Todo],
    todosSeen: 'a,b',
  }
  assert.ok(todosNews(proposed)?.line?.includes('you proposed it done'))
  // All closed: nothing to say, the mark cleared; a card with none and no mark reads nothing.
  assert.deepEqual(todosNews({ ...card, todos: [], todosSeen: 'a,b' }), { line: null, seen: '' })
  assert.equal(todosNews({ name: 'x' }), null)
  assert.equal(todosNews(null), null)
})

test("#319 the brief names keys, --ref and closing the user's points", () => {
  const b = brief(normalizeConfig({}), null, '', {}, 'Claude', null, { agents: true })
  assert.ok(b.includes('--ref'))
  assert.ok(b.includes('board todo done <key> --why'))
})
