// Node-side MokuPilot remote-master bridge (#700).
//
// Serves two halves when `node` is configured:
// 1. Local MokuPilot endpoints (/api/mokupilot/node-call/open, /sessions, and per-grant routes)
//    so MokuPilot on this node can call local sessions directly OR sessions on the master or a
//    third node via the master's link.
// 2. Door-side reverse SSE stream (GET /api/node/pilot-bridge) + body/response/stream endpoints
//    that the master subscribes to (services/nodes/pilot-bridge.ts), so no inbound connection from
//    node to master is ever needed (works behind NAT and ssh/relay links).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { readCard } from '../../adapters/cards.ts'
import { knobMs } from '../../adapters/pacing.ts'
import { t } from '../../core/lang.ts'
import { callable } from '../../core/mokupilot.ts'
import { nodeConfig } from '../../core/nodes.ts'
import {
  isPilotCallId,
  PILOT_BRIDGE_INLINE_BYTES,
  type PilotBridgeOp,
  type PilotBridgeRequest,
  type PilotSessionSummary,
  parseBridgeResponse,
  parseBridgeStreamChunk,
  parseOpenRequest,
} from '../../core/pilot-call.ts'
import { type ProfileSet, profileLabel } from '../../core/profiles.ts'
import type { Config, Item } from '../../core/types.ts'
import { callProfileEnv } from '../mokupilot.ts'
import type { Answer } from './bundle.ts'
import type { NodePilotCall } from './pilot-call.ts'

export interface NodeBridgeGrant {
  id: string
  token: string
  remoteGrantId: string
  expiresAt: number
}

export interface NodePilotBridge {
  // Door-facing endpoints (server/routes/node.ts)
  stream(req: Request): Response
  reqBody(reqId: string): Response
  respond(reqId: string, rawBody: unknown): Answer
  streamChunk(streamId: string, rawBody: unknown, signal?: AbortSignal): Promise<Answer>

  // Local MokuPilot-facing endpoints (server/routes/pilot-call.ts)
  open(rawBody: unknown): Promise<Response>
  sessions(): Promise<Response>
  authorize(grantId: string, authHeader: string | null): NodeBridgeGrant | null
  startRun(grant: NodeBridgeGrant, rawBody: unknown): Promise<Response>
  events(grant: NodeBridgeGrant, runId: string, req: Request): Promise<Response>
  runPost(
    grant: NodeBridgeGrant,
    runId: string,
    action: 'stdin' | 'mcp-reply' | 'close',
    rawBody: string,
  ): Promise<Response>
  uploadFiles(grant: NodeBridgeGrant, rawBody: string): Promise<Response>
  deliverReport(grant: NodeBridgeGrant, rawBody: unknown): Promise<Response>
  end(grant: NodeBridgeGrant): Promise<Response>
  close(): void
}

export interface NodePilotBridgeDeps {
  cfg: Config
  port(): number
  localPilotCall: NodePilotCall
  items(): Item[]
  profiles(): ProfileSet
  log(text: string): void
  home?: string
  platform?: string
  env?: Record<string, string | undefined>
  grantTtlMs?: number
  rpcTimeoutMs?: number
  startTimeoutMs?: number
  filesTimeoutMs?: number
  streamQueueBytes?: number
}

interface PendingRpc {
  resolve(res: Response): void
  timer: ReturnType<typeof setTimeout>
}

interface ActiveStream {
  write(chunk: string, signal?: AbortSignal): Promise<boolean>
  end(): void
  abort(): void
}

const DEFAULT_GRANT_TTL_MS = 6 * 3600 * 1000
const DEFAULT_RPC_TIMEOUT_MS = 30_000
const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_FILES_TIMEOUT_MS = 300_000
const DEFAULT_STREAM_QUEUE_BYTES = 1024 * 1024
const EXPIRED_START_TTL_MS = 10 * 60 * 1000
const PING_MS = 20_000

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const newId = (): string => randomBytes(12).toString('base64url')

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function createNodePilotBridge(deps: NodePilotBridgeDeps): NodePilotBridge {
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const platform = deps.platform ?? process.platform
  const grantTtlMs = deps.grantTtlMs ?? knobMs('BOARD_PILOT_GRANT_TTL_MS', DEFAULT_GRANT_TTL_MS)
  const rpcTimeoutMs = deps.rpcTimeoutMs ?? knobMs('BOARD_PILOT_BRIDGE_MS', DEFAULT_RPC_TIMEOUT_MS)
  const startTimeoutMs = deps.startTimeoutMs ?? knobMs('BOARD_PILOT_START_MS', DEFAULT_START_TIMEOUT_MS)
  const filesTimeoutMs = deps.filesTimeoutMs ?? knobMs('BOARD_PILOT_FILES_MS', DEFAULT_FILES_TIMEOUT_MS)
  const maxStreamQueueBytes = Math.max(
    64,
    deps.streamQueueBytes ?? knobMs('BOARD_PILOT_STREAM_QUEUE_BYTES', DEFAULT_STREAM_QUEUE_BYTES),
  )

  const encoder = new TextEncoder()
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const grants = new Map<string, NodeBridgeGrant>()
  const pendingRpcs = new Map<string, PendingRpc>()
  const pendingBodies = new Map<string, string>()
  const expiredStarts = new Map<string, { grantId: string; at: number }>()
  const activeStreams = new Map<string, ActiveStream>()
  let ping: ReturnType<typeof setInterval> | null = null
  let closed = false

  function sweepGrants(): void {
    const now = Date.now()
    for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id)
    for (const [id, s] of expiredStarts) if (now - s.at > EXPIRED_START_TTL_MS) expiredStarts.delete(id)
  }

  function timeoutFor(op: PilotBridgeOp): number {
    if (op === 'files') return filesTimeoutMs
    if (op === 'start') return startTimeoutMs
    return rpcTimeoutMs
  }

  function failAllWaiting(): void {
    for (const [id, pending] of [...pendingRpcs.entries()]) {
      pendingRpcs.delete(id)
      pendingBodies.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(jsonRes(503, { ok: false, error: t('mokupilot.err.masterOffline') }))
    }
    expiredStarts.clear()
    for (const [streamId, s] of [...activeStreams.entries()]) {
      activeStreams.delete(streamId)
      s.abort()
    }
  }

  function leave(client: ReadableStreamDefaultController<Uint8Array>): void {
    if (!clients.delete(client)) return
    if (!clients.size) {
      if (ping) {
        clearInterval(ping)
        ping = null
      }
      failAllWaiting()
    }
  }

  function writeClient(client: ReadableStreamDefaultController<Uint8Array>, text: string): void {
    try {
      client.enqueue(encoder.encode(text))
    } catch {
      leave(client)
    }
  }

  function emitReq(req: PilotBridgeRequest): boolean {
    if (!clients.size) return false
    const payload = `event: req\ndata: ${JSON.stringify(req)}\n\n`
    for (const client of [...clients]) writeClient(client, payload)
    return clients.size > 0
  }

  function rpc(
    op: PilotBridgeOp,
    o: { grantId?: string; runId?: string; streamId?: string; body?: string } = {},
  ): Promise<Response> {
    if (closed || !clients.size) {
      return Promise.resolve(jsonRes(503, { ok: false, error: t('mokupilot.err.masterOffline') }))
    }
    const id = newId()
    const bodyText = o.body
    const large = bodyText !== undefined && Buffer.byteLength(bodyText, 'utf8') > PILOT_BRIDGE_INLINE_BYTES
    if (large && bodyText !== undefined) {
      pendingBodies.set(id, bodyText)
    }
    const req: PilotBridgeRequest = {
      id,
      op,
      ...(o.grantId !== undefined && { grantId: o.grantId }),
      ...(o.runId !== undefined && { runId: o.runId }),
      ...(o.streamId !== undefined && { streamId: o.streamId }),
      ...(bodyText !== undefined && !large ? { body: bodyText } : {}),
      ...(large ? { hasBody: true } : {}),
    }

    return new Promise<Response>(resolve => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(id)
        pendingBodies.delete(id)
        if (op === 'start' && o.grantId) {
          sweepGrants()
          expiredStarts.set(id, { grantId: o.grantId, at: Date.now() })
        }
        resolve(jsonRes(504, { ok: false, error: 'master bridge request timed out' }))
      }, timeoutFor(op))
      pendingRpcs.set(id, { resolve, timer })
      if (!emitReq(req)) {
        pendingRpcs.delete(id)
        pendingBodies.delete(id)
        clearTimeout(timer)
        resolve(jsonRes(503, { ok: false, error: t('mokupilot.err.masterOffline') }))
      }
    })
  }

  function localOpenResponse(session: string, cwd: string, profile: string, item?: Item): Response {
    const set = deps.profiles()
    const profItem = { profile: profile || item?.profile || null, profileFolder: item?.profileFolder ?? '' }
    const prof = callProfileEnv(profItem, set, { env, home, platform })
    if (prof === null) {
      return jsonRes(409, {
        ok: false,
        error: t('mokupilot.err.profileUnknown', { profile: profileLabel(profItem, set) }),
      })
    }
    return jsonRes(200, {
      ok: true,
      locality: 'local',
      session,
      cwd,
      profile,
      ...(prof !== undefined && { claudeConfigDir: prof.dir }),
    })
  }

  function localSessions(): PilotSessionSummary[] {
    const out: PilotSessionSummary[] = []
    for (const it of deps.items()) {
      if (it.call || it.day || it.movedTo || !callable(it)) continue
      out.push({
        key: it.key,
        session: String(it.session),
        name: it.name,
        device: null,
        cwd: it.cwd,
        category: it.category,
        profile: it.profile ?? null,
        status: it.status,
      })
    }
    return out
  }

  return {
    stream(req) {
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
          // Supersede any half-open previous bridge connection immediately so stale
          // streams/RPCs fail promptly and late aborts on the old socket cannot clear the new one.
          if (clients.size > 0) {
            const stale = [...clients]
            clients.clear()
            if (ping) {
              clearInterval(ping)
              ping = null
            }
            failAllWaiting()
            for (const old of stale) {
              try {
                old.close()
              } catch {}
            }
          }
          clients.add(controller)
          writeClient(controller, ': pilot-bridge\n\n')
          if (!clients.has(controller)) return
          ping ??= setInterval(
            () => {
              for (const c of [...clients]) writeClient(c, ': ping\n\n')
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
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      })
    },

    reqBody(reqId) {
      if (!isPilotCallId(reqId)) return jsonRes(404, { ok: false, error: 'not found' })
      const body = pendingBodies.get(reqId)
      if (body === undefined) return jsonRes(404, { ok: false, error: 'not found' })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    },

    respond(reqId, rawBody) {
      if (!isPilotCallId(reqId)) return { status: 404, body: { ok: false, error: 'not found' } }
      const pending = pendingRpcs.get(reqId)
      if (!pending) {
        const expired = expiredStarts.get(reqId)
        if (expired) {
          expiredStarts.delete(reqId)
          const parsed = parseBridgeResponse(rawBody)
          if (parsed?.status === 200 && clients.size > 0) {
            try {
              const body = JSON.parse(parsed.body) as { ok?: unknown; id?: unknown }
              if (body?.ok === true && isPilotCallId(body.id)) {
                emitReq({
                  id: newId(),
                  op: 'close',
                  grantId: expired.grantId,
                  runId: body.id,
                  body: JSON.stringify({ kill: true }),
                })
              }
            } catch {}
          }
        }
        return { status: 404, body: { ok: false, error: 'unknown or expired bridge request' } }
      }
      const parsed = parseBridgeResponse(rawBody)
      if (!parsed) return { status: 400, body: { ok: false, error: 'invalid bridge response' } }
      pendingRpcs.delete(reqId)
      pendingBodies.delete(reqId)
      clearTimeout(pending.timer)
      pending.resolve(
        new Response(parsed.body, {
          status: parsed.status,
          headers: { 'content-type': parsed.contentType },
        }),
      )
      return { status: 200, body: { ok: true } }
    },

    async streamChunk(streamId, rawBody, signal) {
      if (!isPilotCallId(streamId)) return { status: 404, body: { ok: false, error: 'not found' } }
      const active = activeStreams.get(streamId)
      if (!active) return { status: 404, body: { ok: false, error: 'stream closed' } }
      const chunk = parseBridgeStreamChunk(rawBody)
      if (!chunk) return { status: 400, body: { ok: false, error: 'invalid stream chunk' } }
      let payload = ''
      if (chunk.events) {
        for (const ev of chunk.events) payload += `event: ${ev.name}\ndata: ${ev.data}\n\n`
      }
      if (chunk.error) {
        payload += `event: exit\ndata: ${JSON.stringify({ code: -1, stderr: chunk.error })}\n\n`
      }
      if (payload) {
        const ok = await active.write(payload, signal)
        if (!ok) {
          activeStreams.delete(streamId)
          active.abort()
          return { status: 404, body: { ok: false, error: 'stream closed' } }
        }
      }
      if (chunk.done) {
        activeStreams.delete(streamId)
        active.end()
      }
      return { status: 200, body: { ok: true } }
    },

    async open(rawBody) {
      if (deps.cfg.mokupilot === false) return jsonRes(409, { ok: false, error: t('mokupilot.err.off') })
      const parsed = parseOpenRequest(rawBody)
      if ('error' in parsed) return jsonRes(400, { ok: false, error: parsed.error })

      const selfId = nodeConfig(deps.cfg.node)?.id ?? ''
      const lower = parsed.session.toLowerCase()
      const localItem = deps
        .items()
        .find(i => !i.call && !i.day && !i.movedTo && callable(i) && String(i.session).toLowerCase() === lower)
      let foreignCwdFallback: { cwd: string; profile: string } | null = null

      if (!parsed.device || (selfId && parsed.device === selfId)) {
        const movedAway = !localItem && !!readCard(parsed.session)?.moved
        const check = await deps.localPilotCall.check({
          session: parsed.session,
          cwd: parsed.cwd || localItem?.cwd || '',
          profile: localItem?.profile || '',
          profileFolder: localItem?.profileFolder || '',
        })
        const checkBody = check.body as Record<string, unknown>
        if (!movedAway && check.status === 200 && checkBody.ok === true && typeof checkBody.cwd === 'string') {
          const profile = typeof checkBody.profile === 'string' ? checkBody.profile : localItem?.profile || ''
          const foreignCwd = !parsed.device && !!parsed.cwd && !localItem && !isDir(parsed.cwd) && clients.size > 0
          if (!foreignCwd) {
            return localOpenResponse(parsed.session, checkBody.cwd, profile, localItem)
          }
          foreignCwdFallback = { cwd: checkBody.cwd, profile }
        }
        if (parsed.device && selfId && parsed.device === selfId) {
          return jsonRes(check.status, check.body)
        }
      }

      if (!clients.size) {
        if (foreignCwdFallback) {
          return localOpenResponse(parsed.session, foreignCwdFallback.cwd, foreignCwdFallback.profile, localItem)
        }
        return jsonRes(503, { ok: false, error: t('mokupilot.err.masterOffline') })
      }

      const res = await rpc('open', { body: JSON.stringify(rawBody ?? {}) })
      const text = await res.text()
      let data: Record<string, unknown> | null = null
      try {
        data = JSON.parse(text) as Record<string, unknown>
      } catch {}

      if (res.status === 200 && data?.ok === true) {
        if (data.locality === 'local') {
          const check = await deps.localPilotCall.check({
            session: parsed.session,
            cwd: parsed.cwd || (typeof data.cwd === 'string' ? data.cwd : '') || localItem?.cwd || '',
            profile: localItem?.profile || '',
            profileFolder: localItem?.profileFolder || '',
          })
          const checkBody = check.body as Record<string, unknown>
          if (check.status === 200 && checkBody.ok === true && typeof checkBody.cwd === 'string') {
            const profile = typeof checkBody.profile === 'string' ? checkBody.profile : localItem?.profile || ''
            return localOpenResponse(parsed.session, checkBody.cwd, profile, localItem)
          }
          return jsonRes(check.status, check.body)
        }
        if (data.locality === 'remote' && isPilotCallId(data.grantId)) {
          sweepGrants()
          const id = randomBytes(16).toString('base64url')
          const token = randomBytes(32).toString('base64url')
          grants.set(id, {
            id,
            token,
            remoteGrantId: data.grantId,
            expiresAt: Date.now() + grantTtlMs,
          })
          const url = `http://127.0.0.1:${deps.port()}/api/mokupilot/node-call/${id}`
          return jsonRes(200, {
            ok: true,
            locality: 'remote',
            url,
            token,
            device: data.device,
            parent: data.parent,
            session: data.session,
            cwd: data.cwd,
          })
        }
      }

      if (res.status === 404 && foreignCwdFallback) {
        return localOpenResponse(parsed.session, foreignCwdFallback.cwd, foreignCwdFallback.profile, localItem)
      }

      return new Response(text, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
      })
    },

    async sessions() {
      if (!clients.size) {
        return jsonRes(200, { ok: true, sessions: localSessions(), masterOnline: false })
      }
      return rpc('sessions', { body: '{}' })
    },

    authorize(grantId, authHeader) {
      if (!isPilotCallId(grantId)) return null
      sweepGrants()
      const grant = grants.get(grantId)
      if (!grant) return null
      const m = /^Bearer\s+(\S+)$/i.exec((authHeader ?? '').trim())
      if (!m || !safeEqual(m[1] ?? '', grant.token)) return null
      return grant
    },

    startRun(grant, rawBody) {
      return rpc('start', { grantId: grant.remoteGrantId, body: JSON.stringify(rawBody ?? {}) })
    },

    async events(grant, runId, req) {
      if (!isPilotCallId(runId)) return jsonRes(404, { ok: false, error: 'run not found' })
      if (closed || !clients.size) {
        return jsonRes(503, { ok: false, error: t('mokupilot.err.masterOffline') })
      }
      if (req.signal.aborted) {
        return new Response(null, { status: 499 })
      }
      const streamId = newId()
      let ended = false
      let eof = false
      let pingTimer: ReturnType<typeof setInterval> | null = null
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
      const queue: Uint8Array[] = []
      let queuedBytes = 0
      const drainWaiters: (() => void)[] = []

      const wakeWaiters = (): void => {
        for (const resolve of drainWaiters.splice(0)) resolve()
      }

      const cleanup = (notifyMaster: boolean): void => {
        if (ended) return
        ended = true
        queue.length = 0
        queuedBytes = 0
        activeStreams.delete(streamId)
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        req.signal.removeEventListener('abort', onAbort)
        try {
          streamController?.close()
        } catch {}
        wakeWaiters()
        if (notifyMaster && clients.size > 0) {
          emitReq({ id: newId(), op: 'events-close', streamId })
        }
      }
      const onAbort = (): void => cleanup(true)

      const flush = (): void => {
        if (ended || !streamController) return
        while (queue.length > 0 && (streamController.desiredSize ?? 0) > 0) {
          const next = queue.shift() as Uint8Array
          queuedBytes -= next.byteLength
          try {
            streamController.enqueue(next)
          } catch {
            cleanup(true)
            return
          }
        }
        if (queuedBytes < maxStreamQueueBytes && drainWaiters.length > 0) {
          wakeWaiters()
        }
        if (eof && queue.length === 0) {
          cleanup(false)
        }
      }

      const enqueueDirect = (text: string): boolean => {
        if (ended || !streamController) return false
        try {
          streamController.enqueue(encoder.encode(text))
          return true
        } catch {
          cleanup(true)
          return false
        }
      }

      const write = async (chunk: string, signal?: AbortSignal): Promise<boolean> => {
        if (ended || eof || signal?.aborted) return false
        const bytes = encoder.encode(chunk)
        queue.push(bytes)
        queuedBytes += bytes.byteLength
        flush()
        while (!ended && queuedBytes >= maxStreamQueueBytes) {
          if (signal?.aborted) return false
          await new Promise<void>(resolve => {
            const onWake = (): void => {
              signal?.removeEventListener('abort', onSignalAbort)
              resolve()
            }
            const onSignalAbort = (): void => {
              const idx = drainWaiters.indexOf(onWake)
              if (idx >= 0) drainWaiters.splice(idx, 1)
              resolve()
            }
            drainWaiters.push(onWake)
            signal?.addEventListener('abort', onSignalAbort, { once: true })
          })
        }
        return !ended && !signal?.aborted
      }

      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller
            if (req.signal.aborted || closed || !clients.size) {
              cleanup(false)
              return
            }
            req.signal.addEventListener('abort', onAbort, { once: true })

            activeStreams.set(streamId, {
              write,
              end: () => {
                if (ended || eof) return
                eof = true
                activeStreams.delete(streamId)
                if (pingTimer) clearInterval(pingTimer)
                pingTimer = null
                flush()
              },
              abort: () => cleanup(false),
            })

            if (!enqueueDirect(': connected\n\n')) return
            pingTimer = setInterval(
              () => {
                if (ended || eof || queue.length > 0 || (streamController?.desiredSize ?? 0) <= 0) return
                enqueueDirect(': ping\n\n')
              },
              Math.max(50, knobMs('BOARD_EVENTS_PING_MS', PING_MS)),
            )

            if (!emitReq({ id: streamId, op: 'events', grantId: grant.remoteGrantId, runId, streamId })) {
              cleanup(false)
            }
          },
          pull() {
            flush()
          },
          cancel() {
            cleanup(true)
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: Math.min(64 * 1024, maxStreamQueueBytes) }),
      )

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        },
      })
    },

    runPost(grant, runId, action, rawBody) {
      if (!isPilotCallId(runId)) return Promise.resolve(jsonRes(404, { ok: false, error: 'run not found' }))
      return rpc(action, { grantId: grant.remoteGrantId, runId, body: rawBody })
    },

    uploadFiles(grant, rawBody) {
      return rpc('files', { grantId: grant.remoteGrantId, body: rawBody })
    },

    deliverReport(grant, rawBody) {
      return rpc('report', { grantId: grant.remoteGrantId, body: JSON.stringify(rawBody ?? {}) })
    },

    async end(grant) {
      grants.delete(grant.id)
      if (!clients.size) return jsonRes(200, { ok: true })
      return rpc('end', { grantId: grant.remoteGrantId, body: '{}' })
    },

    close() {
      closed = true
      if (ping) clearInterval(ping)
      ping = null
      failAllWaiting()
      grants.clear()
      for (const c of clients) {
        try {
          c.close()
        } catch {}
      }
      clients.clear()
    },
  }
}
