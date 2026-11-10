// The hub's WebSocket server (#231): ws://host:port/v1, frames are JSON text, at most 64 KiB each
// (Bun closes a socket that sends more). GET / answers a line of text for a health check. Each
// connection's address goes to the hub for its log; behind a reverse proxy (`trustProxy`) it is
// the one the proxy forwards (listen.ts).
import type { ConnHandle, Hub } from './hub.ts'
import { clientAddress } from './listen.ts'

export const MAX_FRAME_BYTES = 64 * 1024

export interface HubServer {
  port: number
  hostname: string
  stop(): void
}

export function startServer(opts: { hub: Hub; hostname: string; port: number; trustProxy?: boolean }): HubServer {
  const { hub } = opts
  const server = Bun.serve<{ h: ConnHandle | null; from: string }>({
    hostname: opts.hostname,
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/v1') {
        const from = clientAddress(
          srv.requestIP(req)?.address,
          req.headers.get('x-forwarded-for'),
          opts.trustProxy === true,
        )
        if (srv.upgrade(req, { data: { h: null, from } })) return undefined
        return new Response('upgrade required\n', { status: 426 })
      }
      if (url.pathname === '/') return new Response('agent-board hub\n')
      return new Response('not found\n', { status: 404 })
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      open(ws) {
        ws.data.h = hub.open({ send: s => void ws.send(s), close: (c, r) => ws.close(c, r) }, ws.data.from)
      },
      message(ws, m) {
        if (typeof m !== 'string') return ws.close(4400, 'text frames only')
        void ws.data.h?.message(m)
      },
      close(ws) {
        ws.data.h?.close()
      },
    },
  })
  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? opts.hostname,
    stop: () => void server.stop(true),
  }
}
