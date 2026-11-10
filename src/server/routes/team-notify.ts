// The owner's side of the team's notifications (#355, services/team-notify.ts):
// GET /api/team/unread: the count of unread messages and each thread's.
// POST /api/team/read { thread, upTo? }: the owner opened that thread; what came in up to `upTo`
// (when the reader fetched what it showed; now when absent, never later than now) is read.
// POST /api/team/focus { thread }: a notification's click on the desktop (web-open.ts --team): the
// pages open the Team panel on that thread (the stream's `team-open`), and a page that connects
// within REVEAL_MS is told as it connects (one in a minimized window has no stream).
// While `team` is not on each answers undefined, as routes/team.ts's do: the request goes on as if
// the route were not there (404 for the GET, 405 for a POST), and the POSTs' guards are not asked.
import { isThreadKey } from '../../core/team-unread.ts'
import type { TeamNotify } from '../../services/team-notify.ts'
import { json, type Route } from '../http.ts'
import { type Broadcaster, namedEvent } from '../sse.ts'
import { REVEAL_MS } from './reveal.ts'

export interface TeamReveal {
  asked(thread: string): void
  /** What a page that connects now is told: the thread asked for within REVEAL_MS, once. */
  greet(): string
}

export function teamReveal(now: () => number = Date.now): TeamReveal {
  let asked: { thread: string; at: number } | null = null
  return {
    asked(thread) {
      asked = { thread, at: now() }
    },
    greet() {
      const a = asked
      asked = null
      return a && now() - a.at < REVEAL_MS ? namedEvent('team-open', { thread: a.thread }) : ''
    },
  }
}

export interface TeamNotifyRoutes {
  /** The notifications, while `team` is on; null while it is off. */
  notify: () => TeamNotify | null
  events: Pick<Broadcaster, 'event'>
  shown: Pick<TeamReveal, 'asked'>
  /** The count changed: the board is published again. */
  changed: () => void
}

export function teamNotifyRoutes(o: TeamNotifyRoutes): Route[] {
  const threadOf = (body: Record<string, unknown>): string | null =>
    typeof body.thread === 'string' && isThreadKey(body.thread) ? body.thread : null
  return [
    {
      method: 'GET',
      path: '/api/team/unread',
      handle() {
        const notify = o.notify()
        if (!notify) return undefined
        return json(200, { unread: notify.unread(), threads: notify.unreadByThread() })
      },
    },
    {
      method: 'POST',
      path: '/api/team/read',
      async handle(_req, ctx) {
        const notify = o.notify()
        if (!notify) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const body = await ctx.body()
        const thread = threadOf(body)
        if (!thread) return json(400, { ok: false, error: 'thread' })
        const upTo = body.upTo
        if (upTo !== undefined && !(typeof upTo === 'number' && Number.isFinite(upTo) && upTo > 0))
          return json(400, { ok: false, error: 'upTo' })
        notify.read(thread, upTo)
        o.changed()
        return json(200, { ok: true, unread: notify.unread() })
      },
    },
    {
      method: 'POST',
      path: '/api/team/focus',
      async handle(_req, ctx) {
        if (!o.notify()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const thread = threadOf(await ctx.body())
        if (!thread) return json(400, { ok: false, error: 'thread' })
        o.shown.asked(thread)
        o.events.event('team-open', { thread })
        return json(200, { ok: true })
      },
    },
  ]
}
