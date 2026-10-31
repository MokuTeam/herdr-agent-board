// Tasks on the page (#202, src/core/todos.ts): the 📌 menu under an agent's message, and the
// panel's buttons (done, open again, remove, to chat). Every change is POST /api/todos; the board
// that comes back after it shows it. The 📌 menu stays open for the next point, its checks as the
// answers say.

import { messagePoints, type Todo } from '../../../src/core/todos.ts'
import type { AssistantTurn } from '../../../src/core/transcript.ts'
import type { Item } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'
import type { MenuEngine } from '../components/menu/menu-engine.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { draftKey } from '../models/sheet.ts'
import { anchorOf, pinMenu, pinnedPoint, pinPicked } from '../models/todos.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { quoteInDraft } from './useComposer.ts'
import { useLatest } from './useLatest.ts'

export interface TodosUi {
  /** An agent message's points as a menu out of its 📌. */
  pin(key: string, turn: AssistantTurn, el: HTMLElement): void
  done(key: string, id: string): void
  reopen(key: string, id: string): void
  remove(key: string, id: string): void
  /** The point quoted in the session's message box, its sheet open. */
  toChat(item: Item, todo: Todo): void
}

type Reply = { ok?: boolean; todo?: Todo }

export function useTodos(menu: Pick<MenuEngine, 'open' | 'update'>): TodosUi {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board })

  async function post(body: Record<string, unknown>): Promise<Reply | null> {
    try {
      return (await api.post('/api/todos', body)) as Reply
    } catch (err) {
      latest.current.board.toast(errorText(err, latest.current.t), true)
      return null
    }
  }

  return {
    pin(key, turn, el) {
      const { t, board } = latest.current
      const points = messagePoints(turn.text)
      if (!points.length) return
      const anchor = anchorOf(turn)
      // The checks as this menu knows them: the board's, then each answer's.
      let todos: Todo[] = [...(board.data?.items.find(i => i.key === key)?.todos ?? [])]
      const rect = el.getBoundingClientRect()
      menu.open(pinMenu(points, todos, anchor, t), {
        x: rect.left,
        y: rect.bottom + 4,
        up: rect.bottom > innerHeight * 0.6,
        source: matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse',
        origin: el,
        label: t('todo.pin'),
        onPick: async id => {
          const pick = pinPicked(id)
          const text = pick && points[pick.n]
          if (!pick || !text) return
          const was = pinnedPoint(todos, anchor, text, pick.owner)
          const r = await post(
            was ? { key, op: 'remove', id: was.id } : { key, op: 'add', text, owner: pick.owner, anchor },
          )
          if (!r?.ok) return
          todos = was ? todos.filter(x => x.id !== was.id) : r.todo ? [...todos, r.todo] : todos
          menu.update(pinMenu(points, todos, anchor, latest.current.t))
        },
      })
    },
    done: (key, id) => void post({ key, op: 'done', id }),
    reopen: (key, id) => void post({ key, op: 'reopen', id }),
    remove: (key, id) => void post({ key, op: 'remove', id }),
    toChat(item, todo) {
      quoteInDraft(draftKey(item), todo.text)
      latest.current.board.dispatch({ type: 'open', key: item.key })
    },
  }
}
