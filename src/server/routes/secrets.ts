// Settings → Secrets… (services/secrets.ts): the list, never a value, and setting or removing one.
// On the local board's own page, and on the board's own server through the owner's domain and its
// login; refused on every other remote listener (Tailscale, a PC's tunnel: server/streams.ts).
import type { Profile } from '../../core/profiles.ts'
import { SESSION_ID } from '../../core/resume.ts'
import { secretOp, secretsView } from '../../services/secrets.ts'
import { json, type Route } from '../http.ts'

export interface SecretRoutesOptions {
  /** The board's profiles: a profile's secret is for one of them. */
  profiles(): readonly Profile[]
  log(line: string): void
}

export function secretRoutes(o: SecretRoutesOptions): Route[] {
  return [
    { method: 'GET', path: '/api/secrets', handle: () => json(200, secretsView()) },
    {
      method: 'POST',
      path: '/api/secrets',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const r = secretOp(
          await ctx.rawBody(),
          {
            profile: id => o.profiles().some(p => p.id === id),
            // A Claude session, by its id: the hook knows a session by that alone.
            session: key => SESSION_ID.test(key),
          },
          o.log,
        )
        return json(r.status, r.body)
      },
    },
  ]
}
