// Live updates as Server-Sent Events: each client gets the current board when it connects, every
// new one after, and a comment now and then that keeps an idle connection from being dropped.
type Client = ReadableStreamDefaultController<Uint8Array>

export interface Broadcaster {
  response(req: Request): Response
  /** A string is JSON already and goes as it is; anything else is serialised. */
  send(payload: unknown): void
  /** A named event (`event: <name>`) with its data serialised, to every client. */
  event(name: string, data: unknown): void
  size(): number
}

const HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }

/** One named event as the stream carries it. */
export const namedEvent = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

export interface BroadcasterOptions {
  pingMs?: number
  /** What a new client is told right after the payload it starts with ('' for nothing). */
  greet?: () => string
}

/** `current`: the payload a new client starts with. Call close() to stop the pings and end every stream. */
export function createBroadcaster(
  current: () => string,
  { pingMs = 20_000, greet }: BroadcasterOptions = {},
): Broadcaster & { close(): void } {
  const clients = new Set<Client>()
  const encoder = new TextEncoder()

  function write(client: Client, text: string): void {
    try {
      client.enqueue(encoder.encode(text))
    } catch {
      // Closed under us: the client left between its last event and this one.
      clients.delete(client)
    }
  }
  const all = (text: string): void => {
    for (const client of clients) write(client, text)
  }
  const ping = setInterval(() => all(': ping\n\n'), pingMs)

  return {
    response(req) {
      let client: Client | undefined
      const leave = (): void => {
        if (client) clients.delete(client)
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          clients.add(controller)
          write(controller, `retry: 2000\ndata: ${current()}\n\n`)
          const more = greet?.()
          if (more) write(controller, more)
        },
        cancel: leave,
      })
      req.signal.addEventListener('abort', leave, { once: true })
      return new Response(stream, { headers: HEADERS })
    },
    send(payload) {
      all(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
    },
    event(name, data) {
      all(namedEvent(name, data))
    },
    size: () => clients.size,
    close() {
      clearInterval(ping)
      for (const client of clients) {
        try {
          client.close()
        } catch {}
      }
      clients.clear()
    },
  }
}
