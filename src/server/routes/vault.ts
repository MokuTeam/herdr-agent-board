// The owner's password vault on the board's own server (core/vault.ts), its login fills
// (services/login-fill.ts), server mode with config.json's `vault` only (app.ts adds these there):
//
// for the agent's own programs (browser_fill_login in `board browser-mcp`, `board browser login`),
// with the board's local key on every listener, so nothing through the domain reaches them:
//   POST /api/browser/login         { pane, fields, submit?, username?, site?, wake? } → { ok, id }:
//        the card under "needs you" with the page that has the focus (read by the board); 409 with
//        why not (no field has the focus, another site, the owner has the browser)
//   POST /api/browser/login-status  { pane, id } → { ok, status, text }: never a value
//
// for the owner's page, through the domain's login only (every other listener refuses /api/vault,
// core/vault.ts vaultOwnerPath), guarded as the board's other changes:
//   POST /api/vault/fill/<id>  { op: 'approve', password?, code?, keep? } | { op: 'pick', item } |
//        { op: 'decline' }: the master password goes to bw's stdin and nowhere else; no answer, log
//        or error here holds it, nor anything typed
//   POST /api/vault/lock       the vault kept open: locked now
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { fillAsk } from '../../core/login-fill.ts'
import type { LoginFills } from '../../services/login-fill.ts'
import { json, type Route } from '../http.ts'

export interface VaultApp {
  fills: LoginFills
  /** Whether the request carries the board's local key (adapters/local-key.ts). */
  keyOk(req: Request): boolean
}

const PANE = /^[\w:.-]{1,80}$/

export function vaultRoutes(app: VaultApp): Route[] {
  return [
    {
      method: 'POST',
      path: /^\/api\/browser\/(login|login-status)$/,
      async handle(req, ctx) {
        if (!app.keyOk(req)) return json(403, { error: 'key' })
        const body = await ctx.body()
        const pane = typeof body.pane === 'string' ? body.pane.trim() : ''
        if (!PANE.test(pane)) return json(400, { ok: false, error: 'pane' })
        if (ctx.params[0] === 'login-status') {
          const id = typeof body.id === 'string' ? body.id : ''
          const s = app.fills.status(pane, id)
          return s ? json(200, { ok: true, ...s }) : json(404, { ok: false, error: 'no such login fill of this pane' })
        }
        const asked = fillAsk(body)
        if (!asked.ok) return json(400, { ok: false, error: asked.error })
        const r = await app.fills.ask(pane, asked.ask, body.wake === true)
        return r.ok ? json(200, r) : json(r.status, { ok: false, error: r.error })
      },
    },
    {
      method: 'POST',
      path: /^\/api\/vault\/fill\/([0-9a-f]{12})$/,
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const id = ctx.params[0] ?? ''
        let body: unknown
        try {
          body = await ctx.rawBody()
        } catch {
          return json(400, { ok: false, error: t('fill.err.op') })
        }
        const b = isRecord(body) ? body : {}
        try {
          const answer =
            b.op === 'approve'
              ? await app.fills.approve(id, { password: b.password, code: b.code, keep: b.keep })
              : b.op === 'pick'
                ? await app.fills.pick(id, b.item)
                : b.op === 'decline'
                  ? app.fills.decline(id)
                  : { status: 400, body: { ok: false, error: t('fill.err.op') } }
          return json(answer.status, answer.body)
        } catch {
          // whatever threw may have had the password near it: none of it goes out or into the log
          return json(500, { ok: false, error: t('fill.err.internal') })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/vault/lock',
      guard: ['board-header', 'origin'],
      async handle() {
        await app.fills.lockNow()
        return json(200, { ok: true })
      },
    },
  ]
}
