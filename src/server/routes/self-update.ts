// Settings → Updates… (#617, services/self-update.ts): how the board's update of itself from git
// stands, its switch and schedule, and Check now; `board update` asks the same. Paired nodes
// use the master's settings through the owner relay.
import { editAutoUpdate, loadConfig } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { autoUpdateConfig, standing, standingText, type UpdateState } from '../../core/self-update.ts'
import type { SelfUpdate } from '../../services/self-update.ts'
import { json, type Route } from '../http.ts'

export interface SelfUpdateApp {
  updater: SelfUpdate
  load(): UpdateState
  /** The checkout's branch and commit now (null: no checkout). */
  checkout(): Promise<{ branch: string | null; commit: string } | null>
  node(): boolean
  masterId?(): string | undefined
  canRestart: boolean
  changed(): void
}

export function selfUpdateRoutes(app: SelfUpdateApp): Route[] {
  const view = async () => {
    const config = autoUpdateConfig(loadConfig().autoUpdate)
    const state = app.load()
    const st = standing(config, state, Date.now())
    const masterId = app.masterId?.()
    return {
      config,
      state,
      standing: st && { level: st.level, text: standingText(st, t) },
      checkout: await app.checkout(),
      node: app.node(),
      ...(masterId && { masterId }),
      canRestart: app.canRestart,
      running: app.updater.running(),
    }
  }
  return [
    { method: 'GET', path: '/api/self-update', handle: async () => json(200, await view()) },
    {
      method: 'POST',
      path: '/api/self-update',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const b = isRecord(raw) ? raw : {}
        if (b.op === 'settings') {
          const r = editAutoUpdate({ on: b.on, every: b.every, at: b.at })
          app.changed()
          return json(r.ok ? 200 : 400, { ...r, view: await view() })
        }
        if (b.op === 'check') {
          const result = await app.updater.check({ byHand: true })
          app.changed()
          return json(200, { ok: true, result, view: await view() })
        }
        return json(400, { ok: false, error: t('selfUpdate.err.op') })
      },
    },
  ]
}
