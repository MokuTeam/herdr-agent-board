// The web vault through the board's login (core/vault.ts): on the board's own server, the domain's
// listener (server/tunnel.ts) hands what is under /vault to Vaultwarden on 127.0.0.1, once the
// caller's login checks out, as it came (its path, query and body) and back as it comes, but for
// the board's login cookie, which never goes there, and the connection's own headers. Its
// notifications' WebSocket (the web vault's live sync) goes the same way, ending with the login.
// Nothing here logs a request: a query can hold a token of the vault's.
import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { downstreamHeaders, upstreamHeaders, vaultOrigin } from '../core/vault.ts'
import { json } from './http.ts'

/** What the domain's listener needs of the vault: where Vaultwarden is, and whether it still takes a new account. */
export interface VaultGate {
  /** Vaultwarden's port on 127.0.0.1; null while config.json has no vault (then /vault is the board's as before). */
  port(): number | null
  /** Its certificate there (PEM), the one the proxy trusts; null when it cannot be read. */
  ca(): string | null
  /** No account yet: the web vault's register goes through (the owner's first). */
  signupsOpen(): boolean
  /** A register call went through: the board closes signups once the account is there. */
  registered(): void
}

/** What a vault WebSocket carries: where it goes on, with which headers; when its login ends. */
export interface VaultSocketData {
  vault: { url: string; headers: Record<string, string>; ca: string }
  watch?: (gone: () => void) => () => void
}

const WAIT_MAX = 256

/** A request's answer from Vaultwarden at `raw` (the path as it came) with its query; 502 when it does not answer. */
export async function vaultAnswer(
  req: Request,
  url: URL,
  o: { port: number; ca: string; domain: string; address: string; cookie: string },
): Promise<Response> {
  const target = `${vaultOrigin(o)}${url.pathname}${url.search}`
  const headers = upstreamHeaders(req.headers, o)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let res: Response
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      redirect: 'manual',
      ...(hasBody && { body: req.body, duplex: 'half' }),
      // Bun: what comes back goes on as it is, compressed or not
      decompress: false,
      // Vaultwarden's own certificate, and no other, on 127.0.0.1
      tls: { ca: o.ca },
    } as RequestInit)
  } catch {
    return json(502, { error: 'vault' })
  }
  return new Response(req.method === 'HEAD' ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: downstreamHeaders(res.headers, o.cookie),
  })
}

/** The upgrade's headers for Vaultwarden: the caller's address, as a request's (upstreamHeaders). */
export function socketHeaders(
  req: Request,
  o: { domain: string; address: string; cookie: string },
): Record<string, string> {
  const h = upstreamHeaders(req.headers, o, [
    'origin',
    'user-agent',
    'accept',
    'accept-language',
    'cache-control',
    'pragma',
  ])
  return Object.fromEntries(h)
}

/** The vault's WebSockets: each one relayed to Vaultwarden's and back, both ending together, and with the login. */
export function vaultSockets(): WebSocketHandler<VaultSocketData> {
  const peers = new WeakMap<
    ServerWebSocket<VaultSocketData>,
    { up: WebSocket; waiting: (string | Uint8Array<ArrayBuffer>)[]; unwatch: () => void }
  >()
  const end = (ws: ServerWebSocket<VaultSocketData>, code = 1000, reason = ''): void => {
    try {
      ws.close(code, reason)
    } catch {}
  }
  return {
    open(ws) {
      let up: WebSocket
      try {
        // Bun's WebSocket takes headers of its own
        up = new WebSocket(ws.data.vault.url, {
          headers: ws.data.vault.headers,
          tls: { ca: ws.data.vault.ca },
        } as unknown as string[])
      } catch {
        return end(ws, 1011, 'vault')
      }
      up.binaryType = 'arraybuffer'
      const unwatch = ws.data.watch?.(() => end(ws, 4001, 'login')) ?? (() => {})
      const peer = { up, waiting: [] as (string | Uint8Array<ArrayBuffer>)[], unwatch }
      peers.set(ws, peer)
      up.onopen = () => {
        for (const m of peer.waiting.splice(0)) up.send(m)
      }
      up.onmessage = e => {
        const data = e.data
        ws.send(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
      }
      up.onclose = e => end(ws, e.code === 1005 || e.code === 1006 ? 1000 : e.code, '')
      up.onerror = () => end(ws, 1011, 'vault')
    },
    message(ws, msg) {
      const peer = peers.get(ws)
      if (!peer) return
      const data = typeof msg === 'string' ? msg : new Uint8Array(msg as Uint8Array<ArrayBuffer>)
      if (peer.up.readyState === WebSocket.OPEN) peer.up.send(data)
      else if (peer.up.readyState === WebSocket.CONNECTING && peer.waiting.length < WAIT_MAX) peer.waiting.push(data)
    },
    close(ws) {
      const peer = peers.get(ws)
      peers.delete(ws)
      if (!peer) return
      peer.unwatch()
      try {
        peer.up.close()
      } catch {}
    },
  }
}

/**
 * One WebSocket handler for a listener that serves two kinds: the vault's (its data says `vault`)
 * and the rest (a desktop's VNC, video and DevTools), each to its own.
 */
export function bothSockets<T extends object>(
  other: WebSocketHandler<T> | undefined,
  vault: WebSocketHandler<VaultSocketData>,
): WebSocketHandler<object> {
  const isVault = (ws: ServerWebSocket<object>): boolean => 'vault' in (ws.data ?? {})
  type Any = ServerWebSocket<never>
  return {
    ...(other && { perMessageDeflate: other.perMessageDeflate }),
    open(ws) {
      if (isVault(ws)) return vault.open?.(ws as Any)
      return other?.open?.(ws as Any)
    },
    message(ws, msg) {
      if (isVault(ws)) return vault.message(ws as Any, msg)
      return other?.message(ws as Any, msg)
    },
    drain(ws) {
      if (isVault(ws)) return vault.drain?.(ws as Any)
      return other?.drain?.(ws as Any)
    },
    close(ws, code, reason) {
      if (isVault(ws)) return vault.close?.(ws as Any, code, reason)
      return other?.close?.(ws as Any, code, reason)
    },
  }
}
