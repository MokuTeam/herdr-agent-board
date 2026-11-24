// Master-side runner for node-to-master MokuPilot calls (#700).
//
// For each online node link, holds `GET /api/node/pilot-bridge` open, reads incoming bridge
// requests from the node's MokuPilot, runs them through `NodePilotCalls` (against the master's
// own local sessions or a third node's door), and posts responses / SSE stream chunks back to
// the calling node's door. Made by server/app.ts only once `nodes` is configured.
import { pace } from '../../adapters/pacing.ts'
import { takeEvents } from '../../core/event-stream.ts'
import { t } from '../../core/lang.ts'
import {
  MAX_BRIDGE_RESPONSE_BYTES,
  MAX_BRIDGE_STREAM_BATCH_BYTES,
  MAX_CALL_FILES_REQUEST_BYTES,
  type PilotBridgeRequest,
  type PilotBridgeStreamEvent,
  parseBridgeRequest,
} from '../../core/pilot-call.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'
import type { NodePilotCalls } from './pilot-call.ts'

export interface PilotBridgeRunner {
  sync(): void
  close(): Promise<void>
}

export interface PilotBridgeRunnerOptions {
  links: Pick<NodeLinks, 'link' | 'onChange'>
  pilotCalls: NodePilotCalls
  log(text: string): void
  deviceIds?: () => readonly string[]
  maxInflightPerDevice?: number
  maxBodyFetchesPerDevice?: number
  maxStreamsPerDevice?: number
}

const AGAIN_MS = 2000
const NONE_MS = 60_000
const MOST_EVENT_CHARS = 1 << 20
const DEFAULT_MAX_INFLIGHT_PER_DEVICE = 32
const DEFAULT_MAX_BODY_FETCHES_PER_DEVICE = 2
const DEFAULT_MAX_STREAMS_PER_DEVICE = 16
const STREAM_EVENT_NAMES: ReadonlySet<string> = new Set<PilotBridgeStreamEvent['name']>([
  'line',
  'stderr',
  'mcp',
  'exit',
])

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const jsonStr = (body: unknown): string => JSON.stringify(body)

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

async function readTextBounded(res: Response, maxBytes: number): Promise<string | null> {
  const told = Number(res.headers.get('content-length'))
  if (Number.isFinite(told) && told > maxBytes) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > maxBytes) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function createPilotBridgeRunner(o: PilotBridgeRunnerOptions): PilotBridgeRunner {
  const following = new Map<string, { ac: AbortController; done: Promise<void> }>()
  const activeStreams = new Map<string, AbortController>()
  const inflightByDevice = new Map<string, number>()
  const bodyFetchesByDevice = new Map<string, number>()
  const stdinChains = new Map<string, Promise<void>>()
  const maxInflightPerDevice = Math.max(1, o.maxInflightPerDevice ?? DEFAULT_MAX_INFLIGHT_PER_DEVICE)
  const maxBodyFetchesPerDevice = Math.max(1, o.maxBodyFetchesPerDevice ?? DEFAULT_MAX_BODY_FETCHES_PER_DEVICE)
  const maxStreamsPerDevice = Math.max(1, o.maxStreamsPerDevice ?? DEFAULT_MAX_STREAMS_PER_DEVICE)
  let closed = false

  const online = (id: string): boolean => o.links.link(id)?.state().state === 'online'
  const shouldFollow = (id: string): boolean => online(id) && o.pilotCalls.bridgeEnabled(id)

  const inc = (map: Map<string, number>, id: string): void => {
    map.set(id, (map.get(id) ?? 0) + 1)
  }

  const dec = (map: Map<string, number>, id: string): void => {
    const next = (map.get(id) ?? 0) - 1
    if (next <= 0) map.delete(id)
    else map.set(id, next)
  }

  function streamsForDevice(id: string): number {
    const prefix = `${id}:`
    let count = 0
    for (const k of activeStreams.keys()) {
      if (k.startsWith(prefix)) count++
    }
    return count
  }

  function abortDeviceStreams(id: string): void {
    const prefix = `${id}:`
    for (const [k, ac] of [...activeStreams.entries()]) {
      if (k.startsWith(prefix)) {
        activeStreams.delete(k)
        ac.abort()
      }
    }
  }

  function changed(id: string): void {
    if (closed) return
    const held = following.get(id)
    if (shouldFollow(id)) {
      if (!held || held.ac.signal.aborted) follow(id)
    } else {
      held?.ac.abort()
      abortDeviceStreams(id)
      if (!o.pilotCalls.bridgeEnabled(id)) o.pilotCalls.revokeForNode(id)
    }
  }

  async function postRes(
    link: Link,
    reqId: string,
    status: number,
    contentType: string,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    const clipped =
      Buffer.byteLength(body, 'utf8') > MAX_BRIDGE_RESPONSE_BYTES
        ? jsonStr({ ok: false, error: 'bridge response too large' })
        : body
    const finalStatus = Buffer.byteLength(body, 'utf8') > MAX_BRIDGE_RESPONSE_BYTES ? 502 : status
    await link
      .fetch(`/api/node/pilot-bridge/res/${reqId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: finalStatus, contentType, body: clipped }),
        signal,
      })
      .then(r => r.body?.cancel())
      .catch(() => {})
  }

  async function postResponseObj(link: Link, reqId: string, res: Response, signal: AbortSignal): Promise<void> {
    const body = await res.text().catch(() => '')
    const contentType = res.headers.get('content-type') || 'application/json'
    await postRes(link, reqId, res.status, contentType, body, signal)
  }

  async function postChunk(
    link: Link,
    streamId: string,
    chunk: { events?: PilotBridgeStreamEvent[]; done?: boolean; error?: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const res = await link.fetch(`/api/node/pilot-bridge/stream/${streamId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk),
        signal,
      })
      await res.body?.cancel()
      return res.ok
    } catch {
      return false
    }
  }

  async function runStream(
    deviceId: string,
    link: Link,
    req: PilotBridgeRequest,
    streamAc: AbortController,
    linkSignal: AbortSignal,
  ): Promise<void> {
    const streamId = req.streamId
    if (!streamId) return
    const key = `${deviceId}:${streamId}`
    const onLinkAbort = (): void => streamAc.abort()
    linkSignal.addEventListener('abort', onLinkAbort, { once: true })

    let postedDone = false
    try {
      const grant = req.grantId ? o.pilotCalls.authorizeForNode(deviceId, req.grantId) : null
      if (!grant || !req.runId) {
        await postChunk(link, streamId, { done: true, error: !grant ? 'unauthorized' : 'run not found' }, linkSignal)
        postedDone = true
        return
      }
      const res = await o.pilotCalls.events(
        grant,
        req.runId,
        new Request('http://127.0.0.1/events', { signal: streamAc.signal }),
      )
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        let msg = `HTTP ${res.status}`
        try {
          const parsed = JSON.parse(text) as { error?: unknown }
          if (typeof parsed?.error === 'string' && parsed.error) msg = parsed.error
        } catch {}
        await postChunk(link, streamId, { done: true, error: msg }, linkSignal)
        postedDone = true
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const stopReader = (): void => void reader.cancel().catch(() => {})
      streamAc.signal.addEventListener('abort', stopReader, { once: true })
      let rest = ''
      try {
        for (;;) {
          if (streamAc.signal.aborted) break
          const next = await reader.read()
          if (next.done || streamAc.signal.aborted) break
          const got = takeEvents(rest + decoder.decode(next.value, { stream: true }))
          rest = got.rest
          const batch: PilotBridgeStreamEvent[] = []
          let batchBytes = 0
          for (const ev of got.events) {
            if (!STREAM_EVENT_NAMES.has(ev.name)) continue
            if (ev.data.includes('\n') || ev.data.includes('\r')) continue
            const item: PilotBridgeStreamEvent = { name: ev.name as PilotBridgeStreamEvent['name'], data: ev.data }
            const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1
            if (
              batch.length > 0 &&
              (batch.length >= 2000 || batchBytes + itemBytes > MAX_BRIDGE_STREAM_BATCH_BYTES - 1024)
            ) {
              const ok = await postChunk(link, streamId, { events: batch.splice(0) }, streamAc.signal)
              batchBytes = 0
              if (!ok) {
                streamAc.abort()
                break
              }
            }
            batch.push(item)
            batchBytes += itemBytes
          }
          if (batch.length > 0 && !streamAc.signal.aborted) {
            const ok = await postChunk(link, streamId, { events: batch }, streamAc.signal)
            if (!ok) {
              streamAc.abort()
              break
            }
          }
        }
      } finally {
        streamAc.signal.removeEventListener('abort', stopReader)
        await reader.cancel().catch(() => {})
      }

      if (!streamAc.signal.aborted && !postedDone) {
        await postChunk(link, streamId, { done: true }, linkSignal)
      }
    } catch (err) {
      if (!streamAc.signal.aborted && !postedDone) {
        await postChunk(link, streamId, { done: true, error: messageOf(err) }, linkSignal)
      }
    } finally {
      if (activeStreams.get(key) === streamAc) activeStreams.delete(key)
      linkSignal.removeEventListener('abort', onLinkAbort)
    }
  }

  async function dispatchRpc(
    deviceId: string,
    link: Link,
    req: PilotBridgeRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let bodyText = req.body ?? ''
      if (req.hasBody) {
        const bodyRes = await link.fetch(`/api/node/pilot-bridge/req/${req.id}/body`, { signal })
        if (!bodyRes.ok) {
          await bodyRes.body?.cancel()
          await postRes(
            link,
            req.id,
            bodyRes.status,
            'application/json',
            jsonStr({ ok: false, error: 'body fetch failed' }),
            signal,
          )
          return
        }
        const fetched = await readTextBounded(bodyRes, MAX_CALL_FILES_REQUEST_BYTES)
        if (fetched === null) {
          await postRes(link, req.id, 413, 'application/json', jsonStr({ ok: false, error: 'too large' }), signal)
          return
        }
        bodyText = fetched
      }

      if (req.op === 'open') {
        let parsed: unknown = {}
        try {
          parsed = JSON.parse(bodyText || '{}')
        } catch {
          await postRes(link, req.id, 400, 'application/json', jsonStr({ ok: false, error: 'invalid json' }), signal)
          return
        }
        const r = await o.pilotCalls.openForNode(deviceId, parsed)
        await postRes(link, req.id, r.status, 'application/json', jsonStr(r.body), signal)
        return
      }

      if (req.op === 'sessions') {
        if (!o.pilotCalls.bridgeEnabled(deviceId)) {
          await postRes(
            link,
            req.id,
            403,
            'application/json',
            jsonStr({ ok: false, error: t('mokupilot.err.bridgeOff') }),
            signal,
          )
          return
        }
        const sessions = o.pilotCalls.listSessions()
        await postRes(
          link,
          req.id,
          200,
          'application/json',
          jsonStr({ ok: true, sessions, masterOnline: true }),
          signal,
        )
        return
      }

      const grant = req.grantId ? o.pilotCalls.authorizeForNode(deviceId, req.grantId) : null
      if (!grant) {
        await postRes(link, req.id, 401, 'application/json', jsonStr({ ok: false, error: 'unauthorized' }), signal)
        return
      }

      if (req.op === 'start') {
        let parsed: unknown = {}
        try {
          parsed = JSON.parse(bodyText || '{}')
        } catch {
          await postRes(link, req.id, 400, 'application/json', jsonStr({ ok: false, error: 'invalid json' }), signal)
          return
        }
        await postResponseObj(link, req.id, await o.pilotCalls.startRun(grant, parsed), signal)
        return
      }

      if (req.op === 'stdin' || req.op === 'mcp-reply' || req.op === 'close') {
        await postResponseObj(
          link,
          req.id,
          await o.pilotCalls.runPost(grant, req.runId ?? '', req.op, bodyText || '{}'),
          signal,
        )
        return
      }

      if (req.op === 'files') {
        await postResponseObj(link, req.id, await o.pilotCalls.uploadFiles(grant, bodyText || '{}'), signal)
        return
      }

      if (req.op === 'report') {
        let parsed: unknown = {}
        try {
          parsed = JSON.parse(bodyText || '{}')
        } catch {
          await postRes(link, req.id, 400, 'application/json', jsonStr({ ok: false, error: 'invalid json' }), signal)
          return
        }
        await postResponseObj(link, req.id, await o.pilotCalls.deliverReport(grant, parsed), signal)
        return
      }

      if (req.op === 'end') {
        await postResponseObj(link, req.id, await o.pilotCalls.end(grant), signal)
      }
    } catch (err) {
      if (!signal.aborted) {
        await postRes(link, req.id, 500, 'application/json', jsonStr({ ok: false, error: messageOf(err) }), signal)
      }
    }
  }

  function scheduleReq(deviceId: string, link: Link, req: PilotBridgeRequest, signal: AbortSignal): void {
    if (req.op === 'events-close') {
      if (req.streamId) {
        const key = `${deviceId}:${req.streamId}`
        const ac = activeStreams.get(key)
        if (ac) {
          activeStreams.delete(key)
          ac.abort()
        }
      }
      return
    }
    if (req.op === 'events') {
      if (!req.streamId) return
      const key = `${deviceId}:${req.streamId}`
      if (activeStreams.has(key)) {
        void postChunk(link, req.streamId, { done: true, error: 'duplicate stream id' }, signal)
        return
      }
      if (streamsForDevice(deviceId) >= maxStreamsPerDevice) {
        void postChunk(link, req.streamId, { done: true, error: 'too many active streams' }, signal)
        return
      }
      const streamAc = new AbortController()
      activeStreams.set(key, streamAc)
      void runStream(deviceId, link, req, streamAc, signal)
      return
    }
    if ((inflightByDevice.get(deviceId) ?? 0) >= maxInflightPerDevice) {
      void postRes(
        link,
        req.id,
        429,
        'application/json',
        jsonStr({ ok: false, error: 'too many bridge requests' }),
        signal,
      )
      return
    }
    if (req.hasBody && (bodyFetchesByDevice.get(deviceId) ?? 0) >= maxBodyFetchesPerDevice) {
      void postRes(
        link,
        req.id,
        429,
        'application/json',
        jsonStr({ ok: false, error: 'too many large bridge requests' }),
        signal,
      )
      return
    }
    inc(inflightByDevice, deviceId)
    if (req.hasBody) inc(bodyFetchesByDevice, deviceId)
    const run = async (): Promise<void> => {
      try {
        if (signal.aborted) return
        await dispatchRpc(deviceId, link, req, signal)
      } finally {
        dec(inflightByDevice, deviceId)
        if (req.hasBody) dec(bodyFetchesByDevice, deviceId)
      }
    }
    if (req.op === 'stdin' && req.runId) {
      const chainKey = `${deviceId}\u0000${req.grantId ?? ''}\u0000${req.runId}`
      const prev = stdinChains.get(chainKey) ?? Promise.resolve()
      const tail = prev.then(run, run)
      stdinChains.set(chainKey, tail)
      void tail.then(() => {
        if (stdinChains.get(chainKey) === tail) stdinChains.delete(chainKey)
      })
      return
    }
    void run()
  }

  function follow(id: string): void {
    const ac = new AbortController()
    const done = (async () => {
      while (!closed && !ac.signal.aborted && shouldFollow(id)) {
        const link = o.links.link(id)
        if (!link) break
        let wait = AGAIN_MS
        try {
          const res = await link.fetch('/api/node/pilot-bridge', { signal: ac.signal })
          if (res.status === 404) wait = NONE_MS
          if (!res.ok || !res.body) {
            await res.body?.cancel()
          } else {
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            const stop = (): void => void reader.cancel().catch(() => {})
            ac.signal.addEventListener('abort', stop, { once: true })
            let rest = ''
            try {
              for (;;) {
                const next = await reader.read()
                if (next.done || ac.signal.aborted) break
                const got = takeEvents(rest + decoder.decode(next.value, { stream: true }))
                rest = got.rest
                if (rest.length > MOST_EVENT_CHARS) {
                  o.log(`node ${id}: pilot-bridge event too large, dropping`)
                  break
                }
                for (const e of got.events) {
                  if (e.name !== 'req') continue
                  let raw: unknown = null
                  try {
                    raw = JSON.parse(e.data)
                  } catch {}
                  const req = parseBridgeRequest(raw)
                  if (req) scheduleReq(id, link, req, ac.signal)
                }
              }
            } finally {
              ac.signal.removeEventListener('abort', stop)
              await reader.cancel().catch(() => {})
              reader.releaseLock()
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) o.log(`node ${id}: pilot-bridge: ${messageOf(err)}`)
        }
        abortDeviceStreams(id)
        if (closed || ac.signal.aborted) break
        await sleep(Math.round(wait * pace()), ac.signal)
      }
    })().finally(() => {
      if (following.get(id)?.ac === ac) following.delete(id)
    })
    following.set(id, { ac, done })
  }

  const off = o.links.onChange(changed)

  return {
    sync() {
      if (closed) return
      const ids = new Set<string>([...following.keys(), ...(o.deviceIds?.() ?? [])])
      for (const id of ids) changed(id)
    },
    async close() {
      closed = true
      off()
      for (const ac of activeStreams.values()) ac.abort()
      activeStreams.clear()
      const waiting = [...following.values()].map(f => {
        f.ac.abort()
        return f.done
      })
      following.clear()
      await Promise.all(waiting)
    },
  }
}
