// Tasks on the cards (#202): changeTodos under the card's lock, the rest of the card kept;
// editTodos, Settings → Tasks into config.json; and POST /api/todos, refused while tasks are off.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { changeTodos, readCard, writeCard } from '../../src/adapters/cards.ts'
import { configFile, editTodos } from '../../src/adapters/config-file.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { Item } from '../../src/core/types.ts'
import type { Route } from '../../src/server/http.ts'
import { todosRoutes } from '../../src/server/routes/todos.ts'
import { isolatedHome } from '../support/env.ts'

test('a change to the tasks keeps the rest of the card; the last one gone takes the field', () => {
  isolatedHome()
  writeCard('s1', { doing: 'work', category: 'work' })
  const a = changeTodos(
    's1',
    { op: 'add', text: 'Update the key', owner: 'user', by: 'user', anchor: { id: 'u', at: 1 } },
    10,
  )
  expect(a.ok).toBe(true)
  const card = readCard('s1')
  expect(card?.doing).toBe('work')
  expect(card?.todos).toEqual([
    {
      id: a.ok ? (a.todo?.id ?? '') : '',
      text: 'Update the key',
      owner: 'user',
      by: 'user',
      at: 10,
      n: 1,
      anchor: { id: 'u', at: 1 },
    },
  ])
  expect(card?.todoSeq).toBe(1)
  // An agent's done on the user's point proposes it (#319): it stays open.
  const proposed = changeTodos('s1', { op: 'done', id: a.ok ? (a.todo?.id ?? '') : '', by: 'agent', why: 'posted' }, 20)
  expect(proposed.ok && proposed.todo).toMatchObject({ proposed: { at: 20, why: 'posted' } })
  expect(readCard('s1')?.todos?.[0]?.done).toBeUndefined()
  expect(changeTodos('s1', { op: 'remove', id: a.ok ? (a.todo?.id ?? '') : '' }).ok).toBe(true)
  expect(readCard('s1')?.todos).toBeUndefined()
  expect(readCard('s1')?.category).toBe('work')
  // The number is not given again once its point is gone.
  const b = changeTodos('s1', { op: 'add', text: 'Next', owner: 'user', by: 'agent' }, 30)
  expect(b.ok && b.todo?.n).toBe(2)
  expect(readCard('s1')?.todoSeq).toBe(2)
  // A card that is not there is not made for a refused change.
  expect(changeTodos('nope', { op: 'remove', id: 'x' })).toEqual({ ok: false, error: 'todo.err.gone' })
  expect(readCard('nope')).toBeNull()
})

test('Settings → Tasks: off deletes the section, mine is agents false, agents is true, auto closes too', () => {
  isolatedHome()
  useLanguage('en')
  const todos = () => JSON.parse(readFileSync(configFile(), 'utf8')).todos
  expect(editTodos({ mode: 'mine' })).toEqual({ ok: true })
  expect(todos()).toEqual({ agents: false })
  expect(editTodos({ mode: 'agents' })).toEqual({ ok: true })
  expect(todos()).toBe(true)
  expect(editTodos({ mode: 'auto' })).toEqual({ ok: true })
  expect(todos()).toEqual({ autoClose: true })
  expect(editTodos({ mode: 'none' })).toEqual({ ok: true })
  expect(todos()).toBeUndefined()
  expect(editTodos({ mode: 'all' }).ok).toBe(false)
})

const item = (key: string): Item => ({ key }) as Item
async function post(routes: Route[], body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes[0]
  if (!route) throw new Error('no route')
  const res = await route.handle(new Request('http://x/api/todos', { method: 'POST' }), {
    params: [],
    rawBody: async () => body,
  } as never)
  if (!res) throw new Error('no answer')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

test('POST /api/todos: refused while off; a pin, done and a missing session while on', async () => {
  isolatedHome()
  useLanguage('en')
  const cfg: { todos?: unknown } = {}
  let refreshed = 0
  const routes = todosRoutes({ cfg, find: key => (key === 's1' ? item('s1') : undefined), refresh: () => refreshed++ })
  expect((await post(routes, { key: 's1', op: 'add', text: 'x' })).status).toBe(409)
  cfg.todos = { agents: false }
  const add = await post(routes, {
    key: 's1',
    op: 'add',
    text: 'x',
    owner: 'agent',
    anchor: { id: 'u-1', at: 3, extra: 1 },
  })
  expect(add.status).toBe(200)
  const todo = add.body.todo as { id: string; owner: string; by: string; anchor: unknown }
  expect(todo.owner).toBe('agent')
  expect(todo.by).toBe('user')
  expect(todo.anchor).toEqual({ id: 'u-1', at: 3 })
  // The user closes the agent's promise too.
  expect((await post(routes, { key: 's1', op: 'done', id: todo.id })).status).toBe(200)
  expect(readCard('s1')?.todos?.[0]?.doneBy).toBe('user')
  expect((await post(routes, { key: 'gone', op: 'done', id: todo.id })).status).toBe(404)
  expect((await post(routes, { key: 's1', op: 'done', id: 'nope' })).status).toBe(404)
  expect((await post(routes, { key: 's1', op: 'fly' })).status).toBe(400)
  expect(refreshed).toBe(2)
  // #319: an agent proposed the user's point done; the user keeps it open, or closes it.
  const mine = changeTodos('s1', { op: 'add', text: 'Post it', owner: 'user', by: 'agent' })
  const mineId = mine.ok ? (mine.todo?.id ?? '') : ''
  changeTodos('s1', { op: 'done', id: mineId, by: 'agent', why: 'posted' })
  expect((await post(routes, { key: 's1', op: 'keep', id: mineId })).status).toBe(200)
  expect(readCard('s1')?.todos?.find(x => x.id === mineId)).not.toHaveProperty('proposed')
  changeTodos('s1', { op: 'done', id: mineId, by: 'agent', why: 'posted' })
  expect((await post(routes, { key: 's1', op: 'done', id: mineId })).status).toBe(200)
  expect(readCard('s1')?.todos?.find(x => x.id === mineId)).toMatchObject({ doneBy: 'user', doneWhy: 'posted' })
  // The setting goes through while off too.
  cfg.todos = undefined
  expect((await post(routes, { op: 'settings', mode: 'agents' })).status).toBe(200)
})
