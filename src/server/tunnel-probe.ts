// The probe's answer through the domain (spec, Test connection's step 3), and Test's probe-only
// listener: while the tunnel is off, or the login is not set up yet, Test's own ssh forwards to
// this listener on a free port of 127.0.0.1. It answers its one nonce and gives 404 to everything
// else: no page, no login, no board route. It is not the tunnel listener, and lives for one Test.
import { json } from './http.ts'

/** How long a probe-only listener lives at most, should nobody close it. */
const CLOSE_AFTER_MS = 30_000

/** GET /api/probe/<nonce>'s answer, here and on the tunnel listener. */
export function probeAnswer(nonce: string): Response {
  return json(200, { board: 'agent-board', probe: nonce })
}

/** A listener on 127.0.0.1 (port 0: a free one) that answers only `GET /api/probe/<nonce>`. */
export async function openProbeListener(
  nonce: string,
  o: { closeAfterMs?: number } = {},
): Promise<{ port: number; close(): void }> {
  const path = `/api/probe/${nonce}`
  // Not development, no idle timeout, no port reuse: as the board's other listeners (app.ts).
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    development: false,
    reusePort: false,
    fetch: req =>
      req.method === 'GET' && new URL(req.url).pathname === path
        ? probeAnswer(nonce)
        : json(404, { error: 'not found' }),
  })
  let open = true
  const close = (): void => {
    if (!open) return
    open = false
    clearTimeout(timer)
    void server.stop(true)
  }
  const timer = setTimeout(close, o.closeAfterMs ?? CLOSE_AFTER_MS)
  return { port: server.port ?? 0, close }
}
