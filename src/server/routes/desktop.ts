// Each agent's own browser on the board's server (services/desktop.ts), server mode only (app.ts
// adds these routes there and nowhere else):
//
//   GET  /api/desktop/<card key>/vnc?t=<the page's file token>   a WebSocket: the session's VNC,
//        raw RFB bytes both ways (binary frames); 404 while it has no desktop running. A WebSocket
//        sends no X-Board: the per-run token stands in for it, as for the terminal's stream
//   POST /api/desktop/<card key>/control   { "to": "owner" | "agent" } → { ok: true, control }; 409 for
//        "owner" while no view of it is connected (control goes with a view, which hands it back)
//
// for the owner's page, through the board's login (the domain's listener) with its Origin rules,
// and on 127.0.0.1 with the board's local key (app.ts asks it of every request there); and for the
// agent's own programs (`board browser-mcp`, `board browser …`), with the board's local key on
// every listener, so nothing through the domain reaches them:
//
//   POST /api/browser/start    { pane }            the desktop up: { ok }
//   GET  /api/browser/cdp?pane=<pane>              a WebSocket: the desktop up, then its Chrome's
//        DevTools (one CDP message a text frame), which listen on no port: chrome-devtools-mcp's
//        --wsEndpoint, the key in its --wsHeaders (services/browser-mcp.ts)
//   POST /api/browser/call     { pane }            who has the browser: { control }
//   POST /api/browser/profile  { pane, name|null } a named profile (null: the session's own)
//   POST /api/browser/ask      { pane, text }      the card under "needs you", the desktop up
import { controlOf, profileName } from '../../core/desktop.ts'
import type { Item } from '../../core/types.ts'
import type { Desktops, VncData } from '../../services/desktop.ts'
import { json, type Route } from '../http.ts'

export interface DesktopApp {
  desktops: Desktops
  find(key: string): Item | undefined
  /** Whether the request carries the board's local key (adapters/local-key.ts). */
  keyOk(req: Request): boolean
}

const DESKTOP = /^\/api\/desktop\/([^/]+)\/(vnc|control)$/
const BROWSER = /^\/api\/browser\/(start|call|profile|ask)$/
const PANE = /^[\w:.-]{1,80}$/
/** What a route answers once the request became a WebSocket: Bun answers it with 101 itself. */
const UPGRADED = (): Response => new Response(null, { status: 200 })
const MAX_ASK = 2000

export function desktopRoutes(app: DesktopApp): Route[] {
  return [
    {
      method: 'ANY',
      path: /^\/api\/desktop\//,
      async handle(req, ctx) {
        const m = DESKTOP.exec(ctx.rawPath)
        if (!m) return json(404, { error: 'not found' })
        const item = app.find(decodeURIComponent(m[1] ?? ''))
        if (m[2] === 'vnc') {
          if (req.method !== 'GET') return json(405, { error: 'method' })
          const refused = ctx.refuse('fs-token') ?? ctx.refuse('origin')
          if (refused) return refused
          const vnc = item ? app.desktops.vncOf(item) : null
          if (!vnc) return json(404, { error: 'no desktop' })
          if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !ctx.upgrade)
            return json(400, { error: 'upgrade' })
          // a viewer that asks for the "binary" subprotocol (noVNC's older default) gets it back
          const offered = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(p => p.trim())
          const data: VncData = { pane: vnc.pane, socket: vnc.socket }
          const ok = ctx.upgrade(data, offered.includes('binary') ? { 'Sec-WebSocket-Protocol': 'binary' } : undefined)
          return ok ? UPGRADED() : json(400, { error: 'upgrade' })
        }
        if (req.method !== 'POST') return json(405, { error: 'method' })
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const to = controlOf(await ctx.rawBody())
        if (!to) return json(400, { ok: false, error: 'to: owner or agent' })
        const r = item ? app.desktops.setControl(item, to) : null
        if (!r) return json(404, { ok: false, error: 'no desktop' })
        return r.ok ? json(200, r) : json(r.status, { ok: false, error: r.error })
      },
    },
    {
      method: 'GET',
      path: '/api/browser/cdp',
      async handle(req, ctx) {
        if (!app.keyOk(req)) return json(403, { error: 'key' })
        const pane = (ctx.url.searchParams.get('pane') ?? '').trim()
        if (!PANE.test(pane)) return json(400, { ok: false, error: 'pane' })
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !ctx.upgrade)
          return json(400, { error: 'upgrade' })
        const r = await app.desktops.ensure(pane)
        if (!r.ok) return json(409, r)
        const socket = app.desktops.cdpOf(pane)
        if (!socket) return json(409, { ok: false, error: 'no browser' })
        const data: VncData = { pane, socket, cdp: true }
        return ctx.upgrade(data) ? UPGRADED() : json(400, { error: 'upgrade' })
      },
    },
    {
      method: 'POST',
      path: BROWSER,
      async handle(req, ctx) {
        if (!app.keyOk(req)) return json(403, { error: 'key' })
        const body = await ctx.body()
        const pane = typeof body.pane === 'string' ? body.pane.trim() : ''
        if (!PANE.test(pane)) return json(400, { ok: false, error: 'pane' })
        const op = ctx.params[0]
        if (op === 'call') return json(200, { ok: true, control: app.desktops.control(pane) })
        if (op === 'start') {
          const r = await app.desktops.ensure(pane)
          return json(r.ok ? 200 : 409, r)
        }
        if (op === 'profile') {
          const name = profileName(body.name)
          if (name !== null && typeof name === 'object') return json(400, { ok: false, error: name.error })
          const r = await app.desktops.profile(pane, name)
          return json(r.ok ? 200 : 409, { ...r, profile: name })
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text || text.length > MAX_ASK) return json(400, { ok: false, error: 'text' })
        const r = await app.desktops.ask(pane, text)
        return json(r.ok ? 200 : 409, r)
      },
    },
  ]
}
