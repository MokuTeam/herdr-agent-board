// The schedule panel's changes: cancel an entry, or switch it between on time and when free.
import { getEntry, removeEntry, updateEntry } from '../../adapters/schedule-store.ts'
import { t } from '../../core/lang.ts'
import type { ScheduleEntry } from '../../core/schedule-rules.ts'
import { json, type Route } from '../http.ts'

export function scheduleRoute(refresh: () => void): Route {
  return {
    method: 'POST',
    path: '/api/schedule',
    guard: ['board-header'],
    async handle(_req, ctx) {
      const body = await ctx.body()
      const id = String(body.id ?? '')
      // A restart, and a sleep, always wait until the session is free.
      const kind = body.op === 'mode' ? getEntry(id)?.kind : undefined
      if (kind === 'restart' || kind === 'sleep')
        return json(400, { ok: false, error: t(kind === 'sleep' ? 'err.sleep.mode' : 'err.restart.mode') })
      // cancel: remove the entry; mode: on time (idle false) or when the session is free.
      const done =
        body.op === 'cancel'
          ? removeEntry(id)
          : body.op === 'mode'
            ? updateEntry(id, entry => {
                // In place of main's `idle: undefined`: the key keeps its place, or goes.
                const next: ScheduleEntry = { ...entry, idle: true }
                if (!body.idle) delete next.idle
                return next
              })
            : undefined
      if (body.op !== 'cancel' && body.op !== 'mode') return json(400, { error: `unknown op ${body.op}` })
      refresh()
      return json(done ? 200 : 404, done ? { ok: true } : { ok: false, error: t('sched.err.gone') })
    },
  }
}
