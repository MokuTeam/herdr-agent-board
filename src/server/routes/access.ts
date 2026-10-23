// Remote access as the board on this computer sets it up (services/remote-access.ts): the panel's
// view, and every change it makes. Never from elsewhere: each remote listener (Tailscale, serve,
// the tunnel) refuses /api/access in either spelling (core/remote.ts localOnly).
import type { RemoteAccess } from '../../services/remote-access.ts'
import { json, type Route } from '../http.ts'

export function accessRoutes(r: RemoteAccess): Route[] {
  return [
    { method: 'GET', path: '/api/access', handle: async () => json(200, await r.view()) },
    // "Do it myself" as one command: { command, script, undoCommand, undoScript } (services/server-setup.ts oneshot)
    {
      method: 'GET',
      path: '/api/access/server-command',
      async handle() {
        const { status, body } = await r.command()
        return json(status, body)
      },
    },
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
