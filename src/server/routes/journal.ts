// The away journal (#489, services/journal.ts): GET /api/journal?since=<ms>[&until=<ms>] or
// ?away=1 answers the list (core/journal.ts JournalList), for the page's "Since 23:56" and the
// phone; POST { op: 'dismiss' } dismisses the "While you were away" strip on every page. Read and
// dismissed from a phone too, as presence is. While config.json has no `journal`, 404.
import { isRecord } from '../../adapters/json-store.ts'
import type { JournalService } from '../../services/journal.ts'
import { json, type Route } from '../http.ts'

const ms = (v: string | null): number | null => {
  if (v === null || !/^\d{1,16}$/.test(v)) return null
  return Number(v)
}

export function journalRoutes(journal: JournalService, enabled: () => boolean): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/journal',
      handle(_req, { url }) {
        if (!enabled()) return json(404, { ok: false, error: 'off' })
        const away = url.searchParams.get('away') === '1'
        const since = away ? journal.awaySince() : ms(url.searchParams.get('since'))
        if (since === null) return json(away ? 409 : 400, { ok: false, error: away ? 'no_absence' : 'since' })
        const until = ms(url.searchParams.get('until')) ?? undefined
        const list = journal.list(since, until)
        return list ? json(200, { ok: true, journal: list }) : json(503, { ok: false, error: 'unavailable' })
      },
    },
    {
      method: 'POST',
      path: '/api/journal',
      guard: ['board-header'],
      async handle(_req, ctx) {
        if (!enabled()) return json(404, { ok: false, error: 'off' })
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (body.op !== 'dismiss') return json(400, { ok: false, error: 'op' })
        return json(200, { ok: true, dismissed: journal.dismiss() })
      },
    },
  ]
}
