// The owner's side of the team's notifications (#355, services/team-notify.ts):
// GET /api/team/unread: the count of unread messages and each thread's.
// POST /api/team/read { thread }: the owner opened that thread; its unread messages are read.
// POST /api/team/focus { thread }: a notification's click on the desktop (web-open.ts --team): the
// pages open the Team panel on that thread (the stream's `team-open`), and a page that connects
// within REVEAL_MS is told as it connects (one in a minimized window has no stream).
// Each answers 409 while `team` is not on.
import { THREAD_KEY } from '../../core/team-unread.ts'
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
    typeof body.thread === 'string' && THREAD_KEY.test(body.thread) ? body.thread : null
  return [
    {
      method: 'GET',
      path: '/api/team/unread',
      handle() {
        const notify = o.notify()
        if (!notify) return json(409, { ok: false, error: 'off' })
        return json(200, { unread: notify.unread(), threads: notify.unreadByThread() })
      },
    },
    {
      method: 'POST',
      path: '/api/team/read',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const notify = o.notify()
        if (!notify) return json(409, { ok: false, error: 'off' })
        const thread = threadOf(await ctx.body())
        if (!thread) return json(400, { ok: false, error: 'thread' })
        notify.read(thread)
        o.changed()
        return json(200, { ok: true, unread: notify.unread() })
      },
    },
    {
      method: 'POST',
      path: '/api/team/focus',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        if (!o.notify()) return json(409, { ok: false, error: 'off' })
        const thread = threadOf(await ctx.body())
        if (!thread) return json(400, { ok: false, error: 'thread' })
        o.shown.asked(thread)
        o.events.event('team-open', { thread })
        return json(200, { ok: true })
      },
    },
  ]
}
