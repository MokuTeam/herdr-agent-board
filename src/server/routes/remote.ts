// The remote mode as the board on this computer runs it (core/remote.ts): turning it on and off,
// the board in a phone's browser too (core/pwa.ts), and answering the phones that ask to pair. Never from a phone: the remote listener refuses
// /api/remote for them (server/remote.ts). /api/hello says what this board is, on both.
import { setRemoteOn } from '../../adapters/config-file.ts'
import type { Config } from '../../core/types.ts'
import { pwaOff, pwaOn, remoteOff } from '../../services/pwa.ts'
import type { Remote } from '../../services/remote.ts'
import { json, type Route } from '../http.ts'
import type { RemoteListener } from '../remote.ts'

export function remoteRoutes(listener: RemoteListener, remote: Remote, cfg: Config, webPort: number): Route[] {
  return [
    { method: 'GET', path: '/api/hello', handle: () => json(200, listener.hello()) },
    { method: 'GET', path: '/api/remote', handle: () => json(200, listener.view() ?? { on: false }) },
    {
      method: 'POST',
      path: '/api/remote',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const { op, id } = await ctx.body()
        const key = typeof id === 'string' ? id : ''
        switch (op) {
          case 'on': {
            const r = setRemoteOn(true)
            return json(r.ok ? 200 : 409, r)
          }
          case 'off': {
            const r = await remoteOff(cfg, webPort)
            return json(r.ok ? 200 : 409, r)
          }
          case 'pwa-on':
          case 'pwa-off': {
            const r = op === 'pwa-on' ? await pwaOn(cfg, webPort) : await pwaOff(cfg, webPort)
            return json(r.ok ? 200 : 409, r)
          }
          case 'approve':
          case 'deny':
          case 'revoke': {
            const done = op === 'approve' ? remote.approve(key) : op === 'deny' ? remote.deny(key) : remote.revoke(key)
            return json(done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'gone' })
          }
          default:
            return json(400, { ok: false, error: `unknown op ${String(op)}` })
        }
      },
    },
  ]
}
