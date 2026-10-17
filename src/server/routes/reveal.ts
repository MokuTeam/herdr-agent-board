// A session to show (entrypoints/web-open.ts, when a notification is clicked): pages open its sheet,
// those connected now and those that connect within REVEAL_MS (a window being raised).
// { ok, key, pages } or 404 when the board has no session in that pane.
import { t } from '../../core/lang.ts'
import type { BoardState } from '../board-state.ts'
import { json, type Route } from '../http.ts'
import { type Broadcaster, namedEvent } from '../sse.ts'

export const REVEAL_MS = 15_000

export interface RevealState {
  /** A notification click asked for this session. */
  asked(key: string): void
  /**
   * What a page that connects now is told besides the board: the session asked for within
   * REVEAL_MS, once. A page in a minimized or covered window keeps no stream, and connects again
   * only once its window is raised; one that comes back later on its own is not sent there.
   */
  greet(): string
}

export function revealState(now: () => number = Date.now): RevealState {
  let revealing: { key: string; at: number } | null = null
  return {
    asked(key) {
      revealing = { key, at: now() }
    },
    greet() {
      const r = revealing
      revealing = null
      return r && now() - r.at < REVEAL_MS ? namedEvent('reveal', { key: r.key }) : ''
    },
  }
}

export function revealRoute(
  board: Pick<BoardState, 'find' | 'items'>,
  events: Pick<Broadcaster, 'event' | 'size'>,
  state: Pick<RevealState, 'asked'>,
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
      state.asked(item.key)
      events.event('reveal', { key: item.key })
      return json(200, { ok: true, key: item.key, pages: events.size() })
    },
  }
}
