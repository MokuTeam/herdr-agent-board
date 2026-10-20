// Several sessions put to sleep in one go (services/sleep.ts), for agents that coordinate others:
// POST /api/sleep { targets: [<id|name|pane>, ...], whenFree?: true } answers { ok, results }, one
// outcome per target, as `board sleep` prints them. Through herdr, so only on fresh data, as the
// sheet's "Put to sleep".
import type { Item } from '../../core/types.ts'
import { wakeAnswers } from '../../services/actions.ts'
import type { Deps } from '../../services/deps.ts'
import { sleepMany } from '../../services/sleep.ts'
import { json, type Route } from '../http.ts'

export interface SleepApp {
  deps: Deps
  items(): Item[]
  refresh(): void
}

// More than a board shows; a request cannot keep herdr busy for long.
const MAX_TARGETS = 200

export function sleepRoute(app: SleepApp): Route {
  return {
    method: 'POST',
    path: '/api/sleep',
    guard: ['board-header', 'fresh-data'],
    async handle(_req, ctx) {
      const body = await ctx.body()
      const targets = (Array.isArray(body.targets) ? body.targets : [])
        .filter((v): v is string => typeof v === 'string')
        .slice(0, MAX_TARGETS)
      if (!targets.some(v => v.trim()))
        return json(400, { ok: false, error: 'targets: the ids, names or panes of the sessions to put to sleep' })
      const up = await wakeAnswers(app.deps)
      if (!up.ok) return json(409, { ok: false, error: up.error })
      const results = await sleepMany(app.deps, app.items(), targets, { whenFree: body.whenFree === true })
      const asleep = results.filter(o => o.result === 'asleep').length
      app.deps.log(`sleep: ${asleep} of ${results.length} put to sleep`)
      app.refresh()
      return json(200, { ok: true, results })
    },
  }
}
