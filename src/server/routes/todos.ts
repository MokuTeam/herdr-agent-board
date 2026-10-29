// Tasks (#202, core/todos.ts): POST { key, op: 'add', text, owner, anchor? } pins a point of a
// session's message; { key, op: 'done' | 'reopen' | 'remove', id } changes one; { op: 'settings',
// mode } turns them on or off (config.json's `todos`). The points live on the cards, which the
// board watches: the change goes out with the next board. While tasks are off only the setting is
// taken.
import { changeTodos } from '../../adapters/cards.ts'
import { editTodos } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { type TodoOp, todosConfig } from '../../core/todos.ts'
import type { Config, Item } from '../../core/types.ts'
import { json, type Route } from '../http.ts'

export interface TodosApp {
  cfg: Pick<Config, 'todos'>
  find(key: string): Item | undefined
  refresh(): void
}

/** The page's anchor, as far as it is one: a transcript id and a time. */
function anchorOf(raw: unknown): { id?: string; at?: number } | undefined {
  if (!isRecord(raw)) return undefined
  const id = typeof raw.id === 'string' && /^[\w-]{1,80}$/.test(raw.id) ? raw.id : undefined
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined
  return id || at ? { ...(id && { id }), ...(at && { at }) } : undefined
}

function opOf(body: Record<string, unknown>): TodoOp | null {
  const id = typeof body.id === 'string' ? body.id : ''
  if (body.op === 'add') {
    if (typeof body.text !== 'string') return null
    const anchor = anchorOf(body.anchor)
    return {
      op: 'add',
      text: body.text,
      owner: body.owner === 'agent' ? 'agent' : 'user',
      by: 'user',
      ...(anchor && { anchor }),
    }
  }
  if (!id) return null
  if (body.op === 'done') return { op: 'done', id, by: 'user' }
  if (body.op === 'reopen' || body.op === 'remove') return { op: body.op, id }
  return null
}

export function todosRoutes(app: TodosApp): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/todos',
      guard: ['board-header'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (body.op === 'settings') {
          const r = editTodos(body)
          return json(r.ok ? 200 : 400, r)
        }
        if (!todosConfig(app.cfg.todos)) return json(409, { ok: false, error: t('todo.err.off') })
        const item = typeof body.key === 'string' ? app.find(body.key) : undefined
        if (!item) return json(404, { ok: false, error: t('err.gone') })
        const op = opOf(body)
        if (!op) return json(400, { ok: false, error: t('todo.err.bad') })
        const r = changeTodos(item.key, op)
        if (!r.ok) return json(r.error === 'todo.err.gone' ? 404 : 409, { ok: false, error: t(r.error) })
        app.refresh()
        return json(200, { ok: true, ...(r.todo && { todo: r.todo }) })
      },
    },
  ]
}
