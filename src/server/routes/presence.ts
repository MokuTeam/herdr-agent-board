// The user's presence (#172, core/presence.ts): GET reads it, for the page, the phone and the
// Android app; POST { state: 'here' | 'away', from? } is the user's switch; POST { op: 'settings',
// on?, mode?, idleMinutes? } turns it on or off and sets detection, in config.json's `presence`
// (the config watcher picks it up). A phone may do all of it, as it may change the settings.
// While presence is not on, GET answers { presence: null } and a switch is refused: turning it on
// is the setting's job, so a setup that never turned it on never gets a presence file.
import { editPresence } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { isPresenceSource, isPresenceState } from '../../core/presence.ts'
import type { PresenceService } from '../../services/presence.ts'
import { json, type Route } from '../http.ts'

export function presenceRoutes(presence: PresenceService): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/presence',
      handle: () => json(200, { presence: presence.view() }),
    },
    {
      method: 'POST',
      path: '/api/presence',
      guard: ['board-header'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (body.op === 'settings') {
          const r = editPresence(body)
          return json(r.ok ? 200 : 409, r)
        }
        if (!isPresenceState(body.state)) return json(400, { ok: false, error: t('err.presenceState') })
        if (!presence.view()) return json(409, { ok: false, error: t('err.presenceOff') })
        const from = isPresenceSource(body.from) && body.from !== 'auto' ? body.from : 'api'
        const { presence: p, changed } = presence.set(body.state, from)
        return json(200, { ok: true, changed, presence: { ...presence.view(), ...p } })
      },
    },
  ]
}
