// Remote access as the board on this computer sets it up (services/remote-access.ts): the panel's
// view, and every change it makes. Never from elsewhere: each remote listener (Tailscale, serve,
// the tunnel) refuses /api/access in either spelling (core/remote.ts localOnly).
import type { RemoteAccess } from '../../services/remote-access.ts'
import { json, type Route } from '../http.ts'

export function accessRoutes(r: RemoteAccess): Route[] {
  return [
    { method: 'GET', path: '/api/access', handle: async () => json(200, await r.view()) },
    {
      method: 'POST',
      path: '/api/access',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const { status, body } = await r.op(await ctx.rawBody())
        return json(status, body)
      },
    },
  ]
}
