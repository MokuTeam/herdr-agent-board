// Settings → Sleep and wake… (#119): wake's state and settings, its switches, Start, Start again
// and Log (services/wake/control.ts). For the board on this computer only: every remote listener
// refuses these routes (server/remote.ts localOnly); a phone reads the state line in the payload.
import { type EditResult, editWake } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import type { WakeControl } from '../../services/wake/control.ts'
import { json, type Route } from '../http.ts'

/** The reaper's fields the panel sends, those it sent only. */
function reaperOf(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['enabled', 'idleMinutes', 'exclude'].filter(k => k in body).map(k => [k, body[k]]))
}

export function wakeRoutes(wake: WakeControl): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/wake',
      async handle() {
        const [view, settings] = await Promise.all([wake.view(), wake.settings()])
        return json(200, { view, settings })
      },
    },
    {
      // { op: 'on' | 'off' | 'reaper' | 'telegram' | 'start' | 'again' | 'log', … }: they change
      // config.json and start programs, so a page of another origin is refused, as for Install.
      method: 'POST',
      path: '/api/wake',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        let r: EditResult
        switch (body.op) {
          case 'on':
          case 'off':
            r = await wake.turn(body.op === 'on')
            break
          case 'reaper':
            r = editWake({ reaper: reaperOf(body) })
            break
          case 'telegram':
            r = editWake({ telegram: body.mode ?? null })
            break
          case 'start':
            r = await wake.start()
            break
          case 'again':
            r = await wake.again()
            break
          case 'log':
            return json(200, { ok: true, text: wake.logTail() })
          default:
            r = { ok: false, error: `unknown op ${String(body.op)}` }
        }
        return json(r.ok ? 200 : 409, r)
      },
    },
  ]
}
