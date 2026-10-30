// A secret request answered on the board (#273, services/secrets.ts): POST /api/secret/<id>
// { op: 'submit', values, fingerprint, session? } writes the sink, { op: 'decline' } declines. The
// form's values come here and go straight to the sink; no answer holds one, and nothing here
// logs the body. Guarded as the board's other changes, and through the remote listeners with
// their own pairing or login: the owner answers from the phone too. The requests themselves go
// out on their cards, in the payload.
import { loadConfig } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { declineSecret, submitSecret } from '../../services/secrets.ts'
import { json, type Route } from '../http.ts'

export interface SecretsApp {
  /** The cards changed: the board goes out again. */
  refresh(): void
}

export function secretsRoutes(app: SecretsApp): Route[] {
  return [
    {
      method: 'POST',
      path: /^\/api\/secret\/([0-9a-f]{12})$/,
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const id = ctx.params[0] ?? ''
        let body: unknown
        try {
          body = await ctx.rawBody()
        } catch {
          return json(400, { ok: false, error: t('secret.err.values') })
        }
        const b = isRecord(body) ? body : {}
        try {
          // config.json as it is now, not as the watcher last saw it: the sink the owner was shown
          // is checked against the one that would be written
          const answer =
            b.op === 'decline'
              ? declineSecret(id)
              : b.op === 'submit'
                ? await submitSecret({ secrets: loadConfig().secrets }, id, {
                    values: b.values,
                    fingerprint: b.fingerprint,
                    session: b.session,
                  })
                : { status: 400, body: { ok: false, error: t('secret.err.op') } }
          app.refresh()
          return json(answer.status, answer.body)
        } catch {
          // whatever threw may have held a value in its message: none of it goes out or into the log
          app.refresh()
          return json(500, { ok: false, error: t('secret.err.internal') })
        }
      },
    },
  ]
}
