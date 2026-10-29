// Sessions moved to another Claude profile from the board's card and lane menus (#256), as
// `board move` moves them (services/move.ts): POST /api/move { targets: [<key>, ...], profile,
// whenFree?: true } answers { ok, results }, one outcome per target. It puts sessions to sleep and
// wakes them, so a browser must also say the request comes from this page (origin), on fresh data.
import type { Item } from '../../core/types.ts'
import type { Deps } from '../../services/deps.ts'
import { moveMany } from '../../services/move.ts'
import { json, type Route } from '../http.ts'

export interface MoveApp {
  deps: Deps
  items(): Item[]
  refresh(): void
}

// More than a lane shows; a request cannot keep herdr busy for long.
const MAX_TARGETS = 200

export function moveRoute(app: MoveApp): Route {
  return {
    method: 'POST',
    path: '/api/move',
    guard: ['board-header', 'origin', 'fresh-data'],
    async handle(_req, ctx) {
      const body = await ctx.body()
      const targets = (Array.isArray(body.targets) ? body.targets : [])
        .filter((v): v is string => typeof v === 'string')
        .slice(0, MAX_TARGETS)
      const profile = typeof body.profile === 'string' ? body.profile : ''
      if (!targets.some(v => v.trim()) || !profile)
        return json(400, { ok: false, error: 'targets and profile: the sessions to move, and the profile id' })
      const results = await moveMany(app.deps, app.items(), targets, {
        profile,
        whenFree: body.whenFree === true,
        by: 'user',
      })
      const moved = results.filter(o => o.result === 'moved').length
      app.deps.log(`move: ${moved} of ${results.length} moved to ${profile}`)
      app.refresh()
      return json(200, { ok: true, results })
    },
  }
}
