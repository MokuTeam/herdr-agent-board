// Settings → Housekeeping… (#652, services/housekeeping.ts): memory guard and leftover browser tab
// sweep, off by default, local-only (core/remote.ts localOnly). Supports reading current status,
// updating switches/thresholds, and running a read-only dry run (`board housekeeping --dry-run`).
import { editHousekeeping, loadConfig } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import type { Housekeeping } from '../../services/housekeeping.ts'
import { json, type Route } from '../http.ts'

export interface HousekeepingApp {
  housekeeping: Housekeeping
  changed(): void
}

export function housekeepingRoutes(app: HousekeepingApp): Route[] {
  return [
    { method: 'GET', path: '/api/housekeeping', handle: async () => json(200, app.housekeeping.view()) },
    {
      method: 'POST',
      path: '/api/housekeeping',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const b = isRecord(raw) ? raw : {}
        if (b.op === 'settings') {
          const r = editHousekeeping({ memory: b.memory, tabs: b.tabs })
          if (r.ok) {
            app.housekeeping.sync(loadConfig().housekeeping)
            app.changed()
          }
          return json(r.ok ? 200 : 400, { ...r, view: app.housekeeping.view() })
        }
        if (b.op === 'dry-run') {
          const report = await app.housekeeping.dryRun()
          return json(200, { ok: true, report, view: app.housekeeping.view() })
        }
        return json(400, { ok: false, error: 'housekeeping: unknown op' })
      },
    },
  ]
}
