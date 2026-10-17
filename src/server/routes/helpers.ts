// A session's helpers for the page: one helper with its conversation, for its window, and the
// messages between sessions in a thread, named by the session on the other end.
import { helperDetail } from '../../adapters/helpers.ts'
import { t } from '../../core/lang.ts'
import type { ConversationTurn } from '../../core/transcript.ts'
import type { Item } from '../../core/types.ts'
import { json, type Route } from '../http.ts'

/**
 * Messages between sessions in a thread: the other session's card key, found by the pipe it
 * writes from (exact while it runs), and no pipes for the page.
 */
export function withSessions(items: readonly Item[], conv: readonly ConversationTurn[]): ConversationTurn[] {
  const byPipe = new Map(items.filter(i => i.pipe).map(i => [i.pipe, i]))
  const at = (pipe: unknown) => byPipe.get(String(pipe ?? '').replace(/^uds:/, ''))
  return conv.map(m => {
    if (m.role === 'peer') {
      const { pipe, ...rest } = m
      const other = at(pipe)
      return other ? { ...rest, key: other.key } : rest
    }
    if (m.role !== 'tool' || !m.send?.to.startsWith('uds:')) return m
    const other = at(m.send.to)
    return {
      ...m,
      send: { ...m.send, to: other?.autoName || other?.name || m.send.name || '', key: other?.key ?? null },
    }
  })
}

export interface HelperApp {
  find(key: string): Item | undefined
  items(): Item[]
}

/** One helper of a session, for its window: the id only picks among the session's own. */
export function helperRoute(app: HelperApp): Route {
  return {
    method: 'GET',
    path: /^\/api\/session\/([^/]+)\/helper\/([A-Za-z0-9-]{1,120})$/,
    async handle(_req, ctx) {
      const item = app.find(ctx.params[0] ?? '')
      if (!item) return json(404, { error: t('err.gone') })
      let d: Awaited<ReturnType<typeof helperDetail>>
      try {
        d = await helperDetail(item.transcript, ctx.params[1] ?? '', { alive: !!item.alive, since: item.since ?? null })
      } catch {
        // Its files could not be read: no paths in the answer.
        return json(500, { error: t('helpers.unreadable') })
      }
      return d
        ? json(200, { ...d, conversation: withSessions(app.items(), d.conversation) })
        : json(404, { error: t('helpers.gone') })
    },
  }
}
