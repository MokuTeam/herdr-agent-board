// A session to show (entrypoints/web-open.ts, when a notification is clicked): open pages open its
// sheet. { ok, key, pages } or 404 when the board has no session in that pane.
import { t } from '../../core/lang.ts'
import type { BoardState } from '../board-state.ts'
import { json, type Route } from '../http.ts'
import type { Broadcaster } from '../sse.ts'

export function revealRoute(
  board: Pick<BoardState, 'find' | 'items'>,
  events: Pick<Broadcaster, 'event' | 'size'>,
): Route {
  return {
    method: 'POST',
    path: '/api/reveal',
    guard: ['board-header'],
    async handle(_req, ctx) {
      const body = await ctx.body()
      const item = body.key
        ? board.find(String(body.key))
        : body.pane
          ? board.items().find(i => i.pane === String(body.pane))
          : undefined
      if (!item) return json(404, { ok: false, error: t('err.gone') })
      events.event('reveal', { key: item.key })
      return json(200, { ok: true, key: item.key, pages: events.size() })
    },
  }
}
