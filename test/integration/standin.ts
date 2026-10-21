// The stand-in board of the integration tests (server-setup and two-proxies): what the board's
// tunnel listener would be at the end of the socket, reduced to what the tests look at. It answers
// every request with the Host and X-Forwarded-* it got, as JSON, and `GET /events` with an event
// stream that ticks every 500 ms. It listens on 127.0.0.1 of this PC: the tunnel's ssh forwards the
// server's socket there (server-setup), or a socat container makes the socket in a shared folder
// and passes it on through host.docker.internal (two-proxies), as sshd passes the tunnel's on.
import type { Server } from 'bun'

/** What the stand-in got, as it answers it. */
export interface Echo {
  standin: true
  method: string
  path: string
  host: string | null
  proto: string | null
  forwardedFor: string | null
  forwardedHost: string | null
}

export interface Standin {
  port: number
  /** How many requests reached it. */
  count(): number
  stop(): void
}

export const TICK_MS = 500

/** The rightmost X-Forwarded-For entry: the caller as the proxy in front of the board saw it. */
export const rightmost = (forwardedFor: string | null): string | null =>
  forwardedFor
    ?.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .at(-1) ?? null

export function startStandin(): Standin {
  let count = 0
  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // an event stream stays open for as long as a test reads it
    idleTimeout: 0,
    development: false,
    fetch(req) {
      count += 1
      const url = new URL(req.url)
      if (url.pathname === '/events') {
        let n = 0
        let timer: ReturnType<typeof setInterval> | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            const tick = (): void => {
              n += 1
              try {
                controller.enqueue(encoder.encode(`data: tick ${n}\n\n`))
              } catch {
                clearInterval(timer)
              }
            }
            tick()
            timer = setInterval(tick, TICK_MS)
          },
          cancel() {
            clearInterval(timer)
          },
        })
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        })
      }
      const echo: Echo = {
        standin: true,
        method: req.method,
        path: url.pathname,
        host: req.headers.get('host'),
        proto: req.headers.get('x-forwarded-proto'),
        forwardedFor: req.headers.get('x-forwarded-for'),
        forwardedHost: req.headers.get('x-forwarded-host'),
      }
      return Response.json(echo)
    },
  })
  return {
    port: server.port ?? 0,
    count: () => count,
    stop: () => void server.stop(true),
  }
}

/** An Echo from a JSON text, or null. */
export function readEcho(text: string): Echo | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && (v as { standin?: unknown }).standin === true ? (v as Echo) : null
  } catch {
    return null
  }
}
