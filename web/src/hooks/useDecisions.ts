// Decisions on the page (#487, src/server/routes/decisions.ts): an option or the owner's own words
// typed into the session, Hold, and the panel seen. Every change is POST /api/decisions; the board
// that comes back after it shows it. A refusal (a question no longer open, a session that would not
// take it) is a toast.
import type { Item } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export interface DecisionsUi {
  /** The option `n` (1-based) of the question `id`, or the owner's words; whether it went. */
  answer(key: string, id: string, choice: { option: number } | { text: string }): Promise<boolean>
  /** A question with no options of the board's (an ask from before): the words as a message. */
  message(item: Item, text: string): Promise<boolean>
  hold(key: string, id: string): Promise<boolean>
  /** The panel was opened: what went by default is seen. */
  seen(): void
}

export function useDecisions(): DecisionsUi {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board })

  async function post(path: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      await api.post(path, body)
      return true
    } catch (err) {
      latest.current.board.toast(errorText(err, latest.current.t), true)
      return false
    }
  }

  return {
    answer: (key, id, choice) => post('/api/decisions', { op: 'answer', key, id, ...choice }),
    message: (item, text) =>
      post(`/api/session/${encodeURIComponent(item.key)}/message`, { text, session: item.session ?? null }),
    hold: (key, id) => post('/api/decisions', { op: 'hold', key, id }),
    seen: () => void api.post('/api/decisions', { op: 'seen' }).catch(() => {}),
  }
}
