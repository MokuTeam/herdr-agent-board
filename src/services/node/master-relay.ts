// The node's half of the relay to its master (#764; the wire and the table: core/master-relay.ts).
//
// Made by server/app.ts only once config.json has `node`; its route goes first in the board's own
// route table (not the door's: the master asking this node's door gets this node's answers). A
// request for a path of the table, or for another machine's session, is put on the stream the
// master holds on this node's door (`GET /api/node/master-relay`), and its answer comes back: status,
// headers and body, a stream (SSE) chunk by chunk with the caller's pace. Without a master on the
// stream: 503 node-master-offline, never this board's own answer (a 409 "off" for a feature the
// master has).
//
// A body-gated path (#786: a move to a device, a bulk request naming another machine's session)
// goes up only when its body says so, with this computer's own sessions named by their prefixed
// keys; the rest stays with this board's own routes, as before.
import { createHash, randomBytes } from 'node:crypto'
import { knobMs } from '../../adapters/pacing.ts'
import {
  IDEMPOTENCY_HEADER,
  isIdemKey,
  isRelayId,
  nodeBulkBody,
  plainPath,
  RELAY_BODY_MAX,
  RELAY_ERRORS,
  RELAY_INLINE_BYTES,
  RELAY_PATH_MAX,
  RELAY_REQUEST_HEADERS,
  type RelayEntry,
  type RelayRequest,
  type RelayWho,
  relayBodyMax,
  relayBodyWants,
  relayChunkOf,
  relayError,
  relayHeadOf,
  relayMatch,
  SESSION_HEADER,
} from '../../core/master-relay.ts'
import { nodeConfig, nodesConfig } from '../../core/nodes.ts'
import type { Config, Item } from '../../core/types.ts'
import type { Answer } from './bundle.ts'

/** What the relay needs of the route that called it (server/http.ts RouteContext). */
export interface RelayCaller {
  /** The path as it came, still percent-encoded. */
  rawPath: string
  /** The query, with its "?" ('' for none). */
  search: string
  /** Through one of this board's remote listeners (Tailscale, serve, tunnel). */
  remote: boolean
  refuse(guard: 'board-header' | 'origin'): Response | null
}

export interface MasterRelay {
  /** A request of this board's listener: the relay's answer, or undefined when it is not the relay's. */
  relay(req: Request, caller: RelayCaller): Promise<Response | undefined>
  // The door's side (server/routes/node.ts), for the master.
  stream(req: Request): Response
  reqBody(id: string): Response
  respond(id: string, raw: unknown): Answer
  chunk(id: string, raw: unknown, signal?: AbortSignal): Promise<Answer>
  /** config.json changed: without `node` the master's stream goes. */
  sync(): void
  /** The master's stream goes and what waits fails, as when the master goes; the next stream is taken. */
  drop(): void
  /** The master holds its stream here now: what is relayed reaches it. */
  online(): boolean
  close(): void
}

export interface MasterRelayDeps {
  /** The live config. */
  cfg: Config
  /** This board's own items: a session a caller names must be one of them. */
  items(): Item[]
  log(text: string): void
  /** How long an answer's head may take (paced tests set it). */
  headMs?: number
  /** The most bytes a streamed answer keeps for a slow caller before the master waits. */
  streamQueueBytes?: number
  /**
   * A path of the table this board answers itself after all (#786): a group its own config.json
   * runs (its own Team), or a start of its own (a launch the master placed here). Absent: none.
   */
  stays?(entry: RelayEntry, rawPath: string, search: string): boolean
}

interface Waiting {
  resolve(res: Response): void
  timer: ReturnType<typeof setTimeout>
  /** A large body, until the master fetched it. */
  body?: Uint8Array<ArrayBuffer>
  /** The caller went away. */
  signal: AbortSignal
  /** A write: once sent, its outcome is unknown when no answer comes. */
  write: boolean
  onAbort(): void
}

interface Sink {
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<boolean>
  end(): void
  abort(): void
}

const DEFAULT_HEAD_MS = 30_000
const DEFAULT_STREAM_QUEUE_BYTES = 1024 * 1024
const PING_MS = 20_000

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
const refused = (status: number, code: string): Response => jsonRes(status, relayError(code))
const newId = (): string => randomBytes(12).toString('base64url')

/** The request's body, at most `max` bytes; null when larger. */
async function bodyUpTo(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array(0)
  const told = Number(req.headers.get('content-length'))
  if (Number.isFinite(told) && told > max) return null
  const parts: Uint8Array[] = []
  let size = 0
  for await (const part of req.body) {
    size += part.byteLength
    if (size > max) return null
    parts.push(part)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

export function createMasterRelay(deps: MasterRelayDeps): MasterRelay {
  const headMs = deps.headMs ?? DEFAULT_HEAD_MS
  const maxQueue = Math.max(64, deps.streamQueueBytes ?? DEFAULT_STREAM_QUEUE_BYTES)
  const encoder = new TextEncoder()
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const waiting = new Map<string, Waiting>()
  const sinks = new Map<string, Sink>()
  let ping: ReturnType<typeof setInterval> | null = null
  let closed = false

  const enabled = (): boolean => !closed && nodeConfig(deps.cfg.node) !== null

  /** Session keys that stay here: this node's own, and those of a master's own nodes when this board is one too. */
  function skip(device: string): boolean {
    if (device === nodeConfig(deps.cfg.node)?.id) return true
    return deps.cfg.nodes !== undefined && Object.hasOwn(nodesConfig(deps.cfg.nodes)?.devices ?? {}, device)
  }

  function failAll(): void {
    for (const [id, w] of [...waiting]) {
      waiting.delete(id)
      clearTimeout(w.timer)
      w.signal.removeEventListener('abort', w.onAbort)
      // Sent and not answered: a read may simply be asked again, a write may have been done.
      w.resolve(w.write ? refused(502, RELAY_ERRORS.unknown) : refused(503, RELAY_ERRORS.offline))
    }
    for (const [id, s] of [...sinks]) {
      sinks.delete(id)
      s.abort()
    }
  }

  function disconnect(): void {
    if (ping) clearInterval(ping)
    ping = null
    failAll()
    for (const c of [...clients]) {
      try {
        c.close()
      } catch {}
    }
    clients.clear()
  }

  function leave(client: ReadableStreamDefaultController<Uint8Array>): void {
    if (!clients.delete(client) || clients.size) return
    if (ping) clearInterval(ping)
    ping = null
    failAll()
  }

  function emit(name: 'req' | 'close', data: unknown): boolean {
    const text = encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const c of [...clients]) {
      try {
        c.enqueue(text)
      } catch {
        leave(c)
      }
    }
    return clients.size > 0
  }

  /** Who the caller is, or the refusal (core/master-relay.ts, "Who a relayed request is"). */
  function whoOf(req: Request, method: string): RelayWho | Response {
    const named = req.headers.get(SESSION_HEADER)
    if (named === null) return { kind: 'owner' }
    const word = named.trim()
    const item = word ? deps.items().find(i => i.key === word || String(i.session ?? '') === word) : undefined
    if (!item) return refused(403, RELAY_ERRORS.session)
    if (method !== 'GET') return refused(403, RELAY_ERRORS.sessionWrite)
    return { kind: 'session', key: item.key }
  }

  /** A streamed answer: its body for the caller, and the master's chunks written into it at the caller's pace. */
  function sinkFor(id: string, signal: AbortSignal): { body: ReadableStream<Uint8Array>; sink: Sink } {
    const queue: Uint8Array[] = []
    let queued = 0
    let ended = false
    let eof = false
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const drained: (() => void)[] = []
    const wake = (): void => {
      for (const fn of drained.splice(0)) fn()
    }
    const finish = (tellMaster: boolean): void => {
      if (ended) return
      ended = true
      queue.length = 0
      queued = 0
      sinks.delete(id)
      signal.removeEventListener('abort', onAbort)
      try {
        controller?.close()
      } catch {}
      wake()
      if (tellMaster && clients.size) emit('close', { id })
    }
    const onAbort = (): void => finish(true)
    const flush = (): void => {
      if (ended || !controller) return
      while (queue.length && (controller.desiredSize ?? 0) > 0) {
        const next = queue.shift() as Uint8Array
        queued -= next.byteLength
        try {
          controller.enqueue(next)
        } catch {
          finish(true)
          return
        }
      }
      if (queued < maxQueue) wake()
      if (eof && !queue.length) finish(false)
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c
          if (signal.aborted) finish(true)
          else signal.addEventListener('abort', onAbort, { once: true })
        },
        pull: flush,
        cancel: () => finish(true),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: Math.min(64 * 1024, maxQueue) }),
    )
    const sink: Sink = {
      async write(bytes, sig) {
        if (ended || eof || sig?.aborted) return false
        queue.push(bytes)
        queued += bytes.byteLength
        flush()
        while (!ended && queued >= maxQueue) {
          if (sig?.aborted) return false
          await new Promise<void>(resolve => {
            const done = (): void => {
              sig?.removeEventListener('abort', done)
              const at = drained.indexOf(done)
              if (at >= 0) drained.splice(at, 1)
              resolve()
            }
            drained.push(done)
            sig?.addEventListener('abort', done, { once: true })
          })
        }
        return !ended && !sig?.aborted
      },
      end() {
        if (ended || eof) return
        eof = true
        sinks.delete(id)
        flush()
      },
      abort: () => finish(false),
    }
    if (!ended) sinks.set(id, sink)
    return { body, sink }
  }

  return {
    async relay(req, caller) {
      if (!enabled()) return undefined
      const match = relayMatch(req.method, caller.rawPath, skip)
      if (!match) return undefined
      if (match.kind === 'table' && deps.stays?.(match.entry, caller.rawPath, caller.search)) return undefined
      // A body-gated entry (#786): its body decides, read from a copy so a body that stays here
      // reaches this board's own route whole.
      let gated: Uint8Array<ArrayBuffer> | null = null
      if (match.kind === 'table' && match.entry.when) {
        const self = nodeConfig(deps.cfg.node)?.id ?? ''
        const copy = await bodyUpTo(req.clone(), RELAY_BODY_MAX)
        let body: unknown = null
        try {
          body = copy ? JSON.parse(new TextDecoder().decode(copy)) : null
        } catch {}
        if (!copy || !self || !relayBodyWants(match.entry.when, caller.rawPath, body, self)) return undefined
        const own = (target: string): string | null => {
          const want = target.toLowerCase()
          const items = deps.items()
          let found = items.filter(i => [i.key, i.session, i.pane].some(v => !!v && String(v).toLowerCase() === want))
          if (!found.length) found = items.filter(i => !!i.name && i.name.toLowerCase() === want)
          return found.length === 1 ? (found[0]?.key ?? null) : null
        }
        const sent = nodeBulkBody(caller.rawPath, body as Record<string, unknown>, self, own)
        gated = new Uint8Array(Buffer.from(JSON.stringify(sent)))
      }
      // The node's own remote listeners: the master cannot tell who is behind them.
      if (caller.remote) return refused(403, RELAY_ERRORS.remote)
      const write = req.method !== 'GET'
      // A write of this board's page, as the master's own routes take it: the header, and this
      // board's own Origin when a browser sends one. The Origin itself never goes up.
      if (write) {
        const no = caller.refuse('board-header') ?? caller.refuse('origin')
        if (no) return no
      }
      const who = whoOf(req, req.method)
      if (who instanceof Response) return who
      if (caller.rawPath.length + caller.search.length > RELAY_PATH_MAX) return refused(414, RELAY_ERRORS.tooBig)
      // A path in a spelling the master does not take is refused here, at once.
      if (!plainPath(caller.rawPath)) return refused(400, RELAY_ERRORS.path)
      const given = req.headers.get(IDEMPOTENCY_HEADER)
      if (write && given !== null && !isIdemKey(given)) return refused(400, RELAY_ERRORS.badIdem)
      if (!clients.size) return refused(503, RELAY_ERRORS.offline)
      let bytes: Uint8Array<ArrayBuffer> | null = new Uint8Array(0)
      if (gated) bytes = gated
      else if (write) {
        bytes = await bodyUpTo(req, relayBodyMax(req.method, caller.rawPath))
        if (!bytes) return refused(413, RELAY_ERRORS.tooBig)
      }
      const headers: Record<string, string> = {}
      for (const name of RELAY_REQUEST_HEADERS) {
        const v = req.headers.get(name)
        if (v !== null) headers[name] = v
      }
      const id = newId()
      const large = bytes.byteLength > RELAY_INLINE_BYTES
      const sent: RelayRequest = {
        id,
        method: req.method as RelayRequest['method'],
        path: `${caller.rawPath}${caller.search}`,
        headers,
        who,
        ...(write && { idem: given ?? newId() }),
        ...(write && bytes.byteLength > 0 && !large && { body: Buffer.from(bytes).toString('base64') }),
        ...(large && { hasBody: true as const, bodySha: createHash('sha256').update(bytes).digest('hex') }),
      }
      return new Promise<Response>(resolve => {
        const onAbort = (): void => {
          const w = waiting.get(id)
          if (!w) return
          waiting.delete(id)
          clearTimeout(w.timer)
          emit('close', { id })
          resolve(new Response(null, { status: 499 }))
        }
        const timer = setTimeout(() => {
          const w = waiting.get(id)
          if (!w) return
          waiting.delete(id)
          req.signal.removeEventListener('abort', onAbort)
          emit('close', { id })
          resolve(refused(504, write ? RELAY_ERRORS.unknown : RELAY_ERRORS.timeout))
        }, headMs)
        waiting.set(id, {
          resolve,
          timer,
          signal: req.signal,
          onAbort,
          write,
          ...(large && { body: bytes as Uint8Array<ArrayBuffer> }),
        })
        req.signal.addEventListener('abort', onAbort, { once: true })
        if (!emit('req', sent)) {
          waiting.delete(id)
          clearTimeout(timer)
          req.signal.removeEventListener('abort', onAbort)
          resolve(refused(503, RELAY_ERRORS.offline))
        }
      })
    },

    stream(req) {
      if (!enabled()) return jsonRes(404, { ok: false, error: 'not found' })
      let client: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          if (req.signal.aborted) {
            controller.close()
            return
          }
          // A newer stream stands for the master from now on: a half-open old one fails what it held.
          if (clients.size) disconnect()
          clients.add(controller)
          controller.enqueue(encoder.encode(': master-relay\n\n'))
          ping ??= setInterval(
            () => {
              for (const c of [...clients]) {
                try {
                  c.enqueue(encoder.encode(': ping\n\n'))
                } catch {
                  leave(c)
                }
              }
            },
            knobMs('BOARD_EVENTS_PING_MS', PING_MS),
          )
        },
        cancel() {
          if (client) leave(client)
        },
      })
      req.signal.addEventListener('abort', () => client && leave(client), { once: true })
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      })
    },

    reqBody(id) {
      const body = isRelayId(id) ? waiting.get(id)?.body : undefined
      if (!body) return jsonRes(404, { ok: false, error: 'not found' })
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } })
    },

    respond(id, raw) {
      const w = isRelayId(id) ? waiting.get(id) : undefined
      if (!w) return { status: 404, body: { ok: false, error: 'unknown or expired relay request' } }
      const head = relayHeadOf(raw)
      if (!head) return { status: 400, body: { ok: false, error: 'invalid relay answer' } }
      waiting.delete(id)
      clearTimeout(w.timer)
      w.signal.removeEventListener('abort', w.onAbort)
      const headers = { ...head.headers, 'x-content-type-options': 'nosniff' }
      if (!head.more) {
        const bytes = head.body ? Buffer.from(head.body, 'base64') : null
        w.resolve(new Response(bytes?.byteLength ? bytes : null, { status: head.status, headers }))
        return { status: 200, body: { ok: true } }
      }
      const { body } = sinkFor(id, w.signal)
      w.resolve(new Response(body, { status: head.status, headers }))
      return { status: 200, body: { ok: true } }
    },

    async chunk(id, raw, signal) {
      const sink = isRelayId(id) ? sinks.get(id) : undefined
      if (!sink) return { status: 404, body: { ok: false, error: 'stream closed' } }
      const c = relayChunkOf(raw)
      if (!c) return { status: 400, body: { ok: false, error: 'invalid stream chunk' } }
      if (c.data) {
        const ok = await sink.write(new Uint8Array(Buffer.from(c.data, 'base64')), signal)
        if (!ok) {
          sink.abort()
          return { status: 404, body: { ok: false, error: 'stream closed' } }
        }
      }
      if (c.error) deps.log(`master relay: the master ended a stream: ${c.error}`)
      if (c.done || c.error) sink.end()
      return { status: 200, body: { ok: true } }
    },

    sync() {
      if (!enabled()) disconnect()
    },

    drop: disconnect,

    online: () => enabled() && clients.size > 0,

    close() {
      closed = true
      disconnect()
    },
  }
}
