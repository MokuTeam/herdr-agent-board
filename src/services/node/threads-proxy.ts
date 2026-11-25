// Node-side threads read proxy (#759).
//
// Serves two halves when `node` is configured (and not a master):
// 1. Door-side reverse SSE stream (GET /api/node/threads-proxy) + response/rev endpoints
//    that the master subscribes to (services/nodes/threads-proxy.ts), so no inbound connection
//    from node to master is ever needed (works behind NAT and ssh/relay links).
// 2. Local loopback web board handlers for GET /api/threads, GET /api/threads/<key>,
//    GET /api/threads/events, and POST /api/reveal {thread}.
import { randomBytes } from 'node:crypto'
import { knobMs } from '../../adapters/pacing.ts'
import { t } from '../../core/lang.ts'
import {
  isAllowedThreadsQuery,
  isAllowedThreadsReadPath,
  isThreadsProxyId,
  parseThreadsProxyResponse,
  parseThreadsProxyRev,
  THREADS_PROXY_TIMEOUT_MS,
  type ThreadsProxyRequest,
} from '../../core/node-threads-proxy.ts'
import { nodeConfig, nodesConfig } from '../../core/nodes.ts'
import type { Config } from '../../core/types.ts'
import { THREAD_KEY } from '../../core/work-threads.ts'
import type { Answer } from './bundle.ts'

export interface NodeThreadsProxy {
  // Door-facing endpoints (server/routes/node.ts)
  stream(req: Request): Response
  respond(id: string, rawBody: unknown): Answer
  pushRev(rawBody: unknown): Answer

  // Loopback web-board endpoints (server/app.ts & server/routes/node.ts)
  read(rawPath: string, query: string): Promise<Response>
  events(req: Request): Promise<Response>
  reveal(word: unknown, onOpen: (key: string) => Response): Promise<Response>

  sync(): void
  close(): void
}

export interface NodeThreadsProxyDeps {
  cfg: Config
  log(text: string): void
  timeoutMs?: number
}

interface PendingRpc {
  resolve(res: Response): void
  timer: ReturnType<typeof setTimeout>
}

interface EventClient {
  controller: ReadableStreamDefaultController<Uint8Array>
  cleanup: () => void
}

const PING_MS = 20_000
const newId = (): string => randomBytes(12).toString('base64url')
const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

export function createNodeThreadsProxy(deps: NodeThreadsProxyDeps): NodeThreadsProxy {
  const timeoutMs = deps.timeoutMs ?? knobMs('BOARD_NODE_THREADS_MS', THREADS_PROXY_TIMEOUT_MS)
  const encoder = new TextEncoder()
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const pendingRpcs = new Map<string, PendingRpc>()
  const eventClients = new Set<EventClient>()
  const revReadyWaiters = new Set<() => void>()
  let masterState = { known: false, on: false, rev: 0 }
  let doorPing: ReturnType<typeof setInterval> | null = null
  let eventPing: ReturnType<typeof setInterval> | null = null
  let closed = false

  const enabled = (): boolean => nodeConfig(deps.cfg.node) !== null && nodesConfig(deps.cfg.nodes) === null

  function wakeRevWaiters(): void {
    for (const wake of [...revReadyWaiters]) wake()
    revReadyWaiters.clear()
  }

  function closeAllEventClients(): void {
    if (eventPing) {
      clearInterval(eventPing)
      eventPing = null
    }
    for (const client of [...eventClients]) client.cleanup()
    eventClients.clear()
  }

  function failAllWaiting(): void {
    for (const [id, pending] of [...pendingRpcs.entries()]) {
      pendingRpcs.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(jsonRes(503, { ok: false, error: t('thread.err.masterOffline') }))
    }
  }

  function resetMasterState(): void {
    masterState = { known: false, on: false, rev: 0 }
    wakeRevWaiters()
    failAllWaiting()
    closeAllEventClients()
  }

  function disconnectAll(): void {
    if (doorPing) {
      clearInterval(doorPing)
      doorPing = null
    }
    resetMasterState()
    for (const c of clients) {
      try {
        c.close()
      } catch {}
    }
    clients.clear()
  }

  function leaveDoor(client: ReadableStreamDefaultController<Uint8Array>): void {
    if (!clients.delete(client)) return
    if (!clients.size) {
      if (doorPing) {
        clearInterval(doorPing)
        doorPing = null
      }
      resetMasterState()
    }
  }

  function writeDoor(client: ReadableStreamDefaultController<Uint8Array>, text: string): void {
    try {
      client.enqueue(encoder.encode(text))
    } catch {
      leaveDoor(client)
    }
  }

  function emitReq(req: ThreadsProxyRequest): boolean {
    if (!clients.size) return false
    const payload = `event: req\ndata: ${JSON.stringify(req)}\n\n`
    for (const client of [...clients]) writeDoor(client, payload)
    return clients.size > 0
  }

  function broadcastEventRev(rev: number): void {
    const payload = encoder.encode(`event: rev\ndata: ${JSON.stringify({ rev })}\n\n`)
    for (const client of [...eventClients]) {
      try {
        client.controller.enqueue(payload)
      } catch {
        client.cleanup()
      }
    }
  }

  function waitForRevReady(signal: AbortSignal): Promise<void> {
    if (masterState.known || closed || !clients.size || signal.aborted) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        revReadyWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      revReadyWaiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  async function read(rawPath: string, query: string): Promise<Response> {
    if (!isAllowedThreadsReadPath(rawPath) || !isAllowedThreadsQuery(query)) {
      return jsonRes(400, { ok: false, error: t('thread.err.bad') })
    }
    if (closed || !clients.size) {
      return jsonRes(503, { ok: false, error: t('thread.err.masterOffline') })
    }
    const id = newId()
    const req: ThreadsProxyRequest = { id, path: rawPath, query }
    return new Promise<Response>(resolve => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(id)
        resolve(jsonRes(504, { ok: false, error: t('thread.err.masterTimeout') }))
      }, timeoutMs)
      pendingRpcs.set(id, { resolve, timer })
      if (!emitReq(req)) {
        pendingRpcs.delete(id)
        clearTimeout(timer)
        resolve(jsonRes(503, { ok: false, error: t('thread.err.masterOffline') }))
      }
    })
  }

  return {
    stream(req) {
      if (!enabled()) return jsonRes(404, { ok: false, error: 'not found' })
      let client: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          if (closed || req.signal.aborted) {
            try {
              controller.close()
            } catch {}
            return
          }
          // Supersede any half-open previous stream so stale RPCs fail promptly and late aborts on
          // the old socket cannot clear the new one. Keep revReadyWaiters waiting for the new stream.
          if (clients.size > 0) {
            const stale = [...clients]
            clients.clear()
            if (doorPing) {
              clearInterval(doorPing)
              doorPing = null
            }
            masterState = { known: false, on: false, rev: 0 }
            failAllWaiting()
            closeAllEventClients()
            for (const old of stale) {
              try {
                old.close()
              } catch {}
            }
          }
          clients.add(controller)
          writeDoor(controller, ': threads-proxy\n\n')
          if (!clients.has(controller)) return
          doorPing ??= setInterval(
            () => {
              for (const c of [...clients]) writeDoor(c, ': ping\n\n')
            },
            knobMs('BOARD_EVENTS_PING_MS', PING_MS),
          )
        },
        cancel() {
          if (client) leaveDoor(client)
        },
      })
      req.signal.addEventListener('abort', () => client && leaveDoor(client), { once: true })
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      })
    },

    respond(id, rawBody) {
      if (!isThreadsProxyId(id)) return { status: 404, body: { ok: false, error: 'not found' } }
      const pending = pendingRpcs.get(id)
      if (!pending) return { status: 404, body: { ok: false, error: 'unknown or expired threads proxy request' } }
      const parsed = parseThreadsProxyResponse(rawBody)
      if (!parsed) return { status: 400, body: { ok: false, error: 'invalid threads proxy response' } }
      pendingRpcs.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(
        new Response(parsed.body, {
          status: parsed.status,
          headers: { 'content-type': parsed.contentType, 'cache-control': 'no-store' },
        }),
      )
      return { status: 200, body: { ok: true } }
    },

    pushRev(rawBody) {
      const parsed = parseThreadsProxyRev(rawBody)
      if (!parsed) return { status: 400, body: { ok: false, error: 'invalid threads rev' } }
      if (!clients.size) return { status: 409, body: { ok: false, error: 'master stream not connected' } }
      const prev = masterState
      masterState = { known: true, on: parsed.on, rev: parsed.rev }
      wakeRevWaiters()
      if (!parsed.on) {
        closeAllEventClients()
      } else if (!prev.known || !prev.on || prev.rev !== parsed.rev) {
        broadcastEventRev(parsed.rev)
      }
      return { status: 200, body: { ok: true } }
    },

    read,

    async events(req) {
      if (closed || !clients.size) {
        return jsonRes(503, { ok: false, error: t('thread.err.masterOffline') })
      }
      if (!masterState.known) {
        await waitForRevReady(req.signal)
      }
      if (req.signal.aborted) {
        return new Response(null, { status: 499 })
      }
      if (closed || !clients.size) {
        return jsonRes(503, { ok: false, error: t('thread.err.masterOffline') })
      }
      if (!masterState.known) {
        return jsonRes(504, { ok: false, error: t('thread.err.masterTimeout') })
      }
      if (!masterState.on) {
        return jsonRes(409, { ok: false, error: t('thread.err.off') })
      }
      let entry: EventClient | null = null
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let done = false
          const cleanup = (): void => {
            if (done) return
            done = true
            if (entry) eventClients.delete(entry)
            req.signal.removeEventListener('abort', cleanup)
            if (!eventClients.size && eventPing) {
              clearInterval(eventPing)
              eventPing = null
            }
            try {
              controller.close()
            } catch {}
          }
          entry = { controller, cleanup }
          if (closed || !clients.size || !masterState.on || req.signal.aborted) {
            cleanup()
            return
          }
          eventClients.add(entry)
          req.signal.addEventListener('abort', cleanup, { once: true })
          try {
            controller.enqueue(encoder.encode(`event: rev\ndata: ${JSON.stringify({ rev: masterState.rev })}\n\n`))
          } catch {
            cleanup()
            return
          }
          eventPing ??= setInterval(
            () => {
              const pingBytes = encoder.encode(': ping\n\n')
              for (const c of [...eventClients]) {
                try {
                  c.controller.enqueue(pingBytes)
                } catch {
                  c.cleanup()
                }
              }
            },
            knobMs('BOARD_EVENTS_PING_MS', PING_MS),
          )
        },
        cancel() {
          entry?.cleanup()
        },
      })
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    },

    async reveal(word, onOpen) {
      if (closed || !clients.size) {
        return jsonRes(503, { ok: false, error: t('thread.err.masterOffline') })
      }
      const key = String(word ?? '')
        .trim()
        .toLowerCase()
      if (!THREAD_KEY.test(key)) return jsonRes(400, { ok: false, error: t('thread.err.bad') })
      // Use ?last=1 because ?last=0 triggers slice(-0) on the master and returns all entries.
      const res = await read(`/api/threads/${encodeURIComponent(key)}`, '?last=1')
      if (res.status !== 200) return res
      await res.body?.cancel().catch(() => {})
      return onOpen(key)
    },

    sync() {
      if (!enabled()) disconnectAll()
    },

    close() {
      closed = true
      disconnectAll()
    },
  }
}
