// The remote mode as the board on this computer runs it (core/remote.ts): turning it on and off,
// and answering the phones that ask to pair. Never from a phone: the remote listener refuses
// /api/remote for them (server/remote.ts). /api/hello says what this board is, on both.
import { setRemoteOn } from '../../adapters/config-file.ts'
import type { Remote } from '../../services/remote.ts'
import { json, type Route } from '../http.ts'
import type { RemoteListener } from '../remote.ts'

export function remoteRoutes(listener: RemoteListener, remote: Remote): Route[] {
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
          case 'on':
          case 'off': {
            const r = setRemoteOn(op === 'on')
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
