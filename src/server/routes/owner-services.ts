import { isRecord } from '../../adapters/json-store.ts'
import { ownerServiceNameError, ownerServices, revokeOwnerService } from '../../adapters/owner-services.ts'
import { validName } from '../../core/team.ts'
import type { OwnerAction } from '../../core/team-confirm.ts'
import type { TeamConfirm } from '../../services/team-confirm.ts'
import { json, type Route } from '../http.ts'
import { isLoopback } from './mcp.ts'

export function ownerServicesRoutes(
  confirm: TeamConfirm,
  openConfirmation: () => void,
  changed: () => void,
  enabled: () => boolean,
): Route[] {
  return [
    {
      method: 'ANY',
      path: '/api/owner-services',
      async handle(req, ctx) {
        // This computer's own page, or the owner on a node's page asking for this master's (#887).
        if (!enabled() || (!ctx.masterScope && (ctx.remote || !isLoopback(ctx.peer()))))
          return json(404, { error: 'not found' })
        const refused = ctx.refuse('origin')
        if (refused) return refused
        if (req.method === 'GET') return json(200, { services: ownerServices(), hasPasskey: confirm.hasPasskey() })
        if (req.method !== 'POST') return json(405, { error: 'method' })
        const missing = ctx.refuse('board-header')
        if (missing) return missing
        const raw = await ctx.rawBody()
        if (!isRecord(raw)) return json(400, { ok: false, error: 'body' })
        if (raw.op === 'revoke' && typeof raw.key === 'string') {
          if (!revokeOwnerService(raw.key)) return json(404, { ok: false, error: 'service' })
          changed()
          return json(200, { ok: true })
        }

        let action: OwnerAction
        if (raw.op === 'passkey' && !confirm.hasPasskey()) action = { kind: 'passkey-add' }
        else if (raw.op === 'add') {
          const name = typeof raw.name === 'string' ? raw.name.trim() : raw.name
          if (!validName(name)) return json(400, { ok: false, error: 'name' })
          if (!confirm.hasPasskey()) return json(403, { ok: false, error: 'passkey' })
          const error = ownerServiceNameError(ownerServices(), name)
          if (error) return json(400, { ok: false, error })
          action = { kind: 'owner-service-add', name }
        } else return json(400, { ok: false, error: 'body' })
        openConfirmation()
        // A node's page (#887) confirms on its own localhost, through the relay.
        if (ctx.masterScope) {
          const id = confirm.pend(action, false, ctx.relayFrom)
          return json(428, { ok: false, error: 'confirm', id, scope: 'master' })
        }
        if (!confirm.safe()) return json(503, { ok: false, error: 'loopback' })
        const id = confirm.pend(action)
        return json(428, { ok: false, error: 'confirm', id, confirm: confirm.urlOf(id) })
      },
    },
  ]
}
