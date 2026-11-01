// Tasks on the page (#202): the 📌 menu's points and checks, the toolbar's count, the panel's
// groups and done list, "To chat"'s quote and a point's age.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Todo } from '../../src/core/todos.ts'
import type { Item } from '../../src/core/types.ts'
import {
  ageText,
  doneTodos,
  openMine,
  pinMenu,
  pinnedCount,
  pinPicked,
  quoteDraft,
  todoGroups,
} from '../../web/src/models/todos.ts'

const t = translator('en')
const todo = (over: Partial<Todo>): Todo => ({ id: 'x', text: 'x', owner: 'user', by: 'user', at: 0, ...over })
const item = (key: string, todos: Todo[]): Item => ({ key, name: key, todos }) as Item

test("the 📌 menu: the message's points for me, checked when pinned, then the agent's in a submenu", () => {
  const anchor = { id: 'u1', at: 5 }
  const pinned = [
    todo({ id: 'a', text: 'two', anchor }),
    todo({ id: 'b', text: 'one', owner: 'agent', anchor }),
    // Another message's point with the same words checks nothing here.
    todo({ id: 'c', text: 'one', anchor: { id: 'u2', at: 6 } }),
  ]
  const menu = pinMenu(['one', 'two'], pinned, anchor, t)
  assert.deepEqual(menu.slice(0, 3), [
    { id: 'user:0', label: 'one', checked: false, keep: true },
    { id: 'user:1', label: 'two', checked: true, keep: true },
    { separator: true },
  ])
  const sub = menu[3]
  assert.ok(sub && !('separator' in sub && sub.separator))
  assert.deepEqual('submenu' in sub ? sub.submenu : null, [
    { id: 'agent:0', label: 'one', checked: true },
    { id: 'agent:1', label: 'two', checked: false },
  ])
  assert.deepEqual(pinPicked('agent:1'), { owner: 'agent', n: 1 })
  assert.equal(pinPicked('agent'), null)
  assert.equal(pinnedCount(pinned, { id: 'u1', at: 5, text: '- one\n- two\n- three' }), 2)
  assert.equal(pinnedCount(undefined, { at: 5, text: '- one' }), 0)
})

test("the count is the user's open points; groups by session, oldest point first; done newest first", () => {
  const items = [
    item('s1', [todo({ id: '1', at: 30 }), todo({ id: '2', owner: 'agent', at: 10 })]),
    item('s2', [todo({ id: '3', at: 20 }), todo({ id: '4', at: 1, done: 50, doneBy: 'user' })]),
    item('s3', [todo({ id: '5', at: 2, done: 60, doneBy: 'agent', owner: 'agent' })]),
  ]
  assert.equal(openMine(items), 2)
  assert.deepEqual(
    todoGroups(items, 'mine').map(g => [g.item.key, g.open.map(x => x.id)]),
    [
      ['s2', ['3']],
      ['s1', ['1']],
    ],
  )
  assert.deepEqual(
    todoGroups(items, 'all').map(g => [g.item.key, g.open.map(x => x.id)]),
    [
      ['s1', ['2', '1']],
      ['s2', ['3']],
    ],
  )
  assert.deepEqual(
    doneTodos(items, 'all').map(d => d.todo.id),
    ['5', '4'],
  )
  assert.deepEqual(
    doneTodos(items, 'agents').map(d => d.todo.id),
    ['5'],
  )
})

test('"To chat" quotes the point above what the box held; ages are short', () => {
  assert.equal(quoteDraft('Update the key', ''), '> Update the key\n\n')
  assert.equal(quoteDraft('Update the key', 'and then?'), '> Update the key\n\nand then?')
  assert.equal(ageText(0, 5 * 60_000), '5m')
  assert.equal(ageText(0, 3 * 3600_000), '3h')
  assert.equal(ageText(0, 72 * 3600_000), '3d')
})
