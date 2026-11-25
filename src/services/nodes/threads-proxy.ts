// Master-side runner for node-to-master threads read proxy (#759).
//
// For each online node link, holds `GET /api/node/threads-proxy` open, pushes `{ on, rev }`
// whenever the master's threads revision or enabled state changes, runs incoming read requests
// against the master's own threads read routes, and posts responses back to the node's door.
// Made by server/app.ts only once `nodes` is configured.
import { pace } from '../../adapters/pacing.ts'
import { takeEvents } from '../../core/event-stream.ts'
import {
  MAX_THREADS_PROXY_RESPONSE_BYTES,
  parseThreadsProxyRequest,
  type ThreadsProxyRequest,
  type ThreadsProxyRev,
} from '../../core/node-threads-proxy.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'

export interface ThreadsProxyRunner {
  notifyRev(on: boolean, rev: number): void
  close(): Promise<void>
}

export interface ThreadsProxyRunnerOptions {
  links: Pick<NodeLinks, 'link' | 'onChange'>
  handleRead: (req: ThreadsProxyRequest) => Promise<Response>
  currentRev: () => ThreadsProxyRev
  log(text: string): void
  maxInflightPerDevice?: number
}

const AGAIN_MS = 2000
const NONE_MS = 60_000
const POST_MS = 10_000
const MOST_EVENT_CHARS = 1 << 20
const DEFAULT_MAX_INFLIGHT_PER_DEVICE = 16

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

interface StreamRevPusher {
  notify(state: ThreadsProxyRev): void
}

export function createThreadsProxyRunner(o: ThreadsProxyRunnerOptions): ThreadsProxyRunner {
  const following = new Map<string, { ac: AbortController; done: Promise<void> }>()
  const pushers = new Map<string, StreamRevPusher>()
  const inflightByDevice = new Map<string, number>()
  const maxInflightPerDevice = Math.max(1, o.maxInflightPerDevice ?? DEFAULT_MAX_INFLIGHT_PER_DEVICE)
  let closed = false

  const online = (id: string): boolean => o.links.link(id)?.state().state === 'online'

  const inc = (id: string): void => {
    inflightByDevice.set(id, (inflightByDevice.get(id) ?? 0) + 1)
  }

  const dec = (id: string): void => {
    const next = (inflightByDevice.get(id) ?? 0) - 1
    if (next <= 0) inflightByDevice.delete(id)
    else inflightByDevice.set(id, next)
  }

  function changed(id: string): void {
    if (closed) return
    const held = following.get(id)
    if (online(id)) {
      if (!held || held.ac.signal.aborted) follow(id)
    } else {
      held?.ac.abort()
    }
  }

  function createStreamPusher(link: Link, signal: AbortSignal): StreamRevPusher {
    let desired: ThreadsProxyRev | null = null
    let lastSent: ThreadsProxyRev | null = null
    let pushing = false

    async function flush(): Promise<void> {
      pushing = true
      try {
        while (!closed && !signal.aborted && desired) {
          const want = desired
          if (lastSent && lastSent.on === want.on && lastSent.rev === want.rev) break
          try {
            const res = await link.fetch('/api/node/threads-proxy/rev', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(want),
              signal: AbortSignal.any([signal, AbortSignal.timeout(POST_MS)]),
            })
            await res.body?.cancel().catch(() => {})
            if (!res.ok) break
            lastSent = want
          } catch {
            break
          }
        }
      } finally {
        pushing = false
      }
    }

    return {
      notify(state) {
        desired = state
        if (!pushing && !closed && !signal.aborted) void flush()
      },
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
    let payload = JSON.stringify({ status, contentType, body })
    if (Buffer.byteLength(payload, 'utf8') > MAX_THREADS_PROXY_RESPONSE_BYTES) {
      payload = JSON.stringify({
        status: 502,
        contentType: 'application/json; charset=utf-8',
        body: jsonStr({ ok: false, error: 'threads proxy response too large' }),
      })
    }
    await link
      .fetch(`/api/node/threads-proxy/res/${reqId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.any([signal, AbortSignal.timeout(POST_MS)]),
      })
      .then(r => r.body?.cancel())
      .catch(() => {})
  }

  async function dispatchReq(
    deviceId: string,
    link: Link,
    req: ThreadsProxyRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const res = await o.handleRead(req)
      const body = await res.text().catch(() => '')
      const contentType = res.headers.get('content-type') || 'application/json; charset=utf-8'
      if (!signal.aborted) {
        await postRes(link, req.id, res.status, contentType, body, signal)
      }
    } catch (err) {
      if (!signal.aborted) {
        await postRes(
          link,
          req.id,
          500,
          'application/json; charset=utf-8',
          jsonStr({ ok: false, error: messageOf(err) }),
          signal,
        )
      }
    } finally {
      dec(deviceId)
    }
  }

  function scheduleReq(deviceId: string, link: Link, data: string, signal: AbortSignal): void {
    let raw: unknown = null
    try {
      raw = JSON.parse(data)
    } catch {}
    const req = parseThreadsProxyRequest(raw)
    if (!req) {
      const maybeId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
      if (typeof maybeId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(maybeId)) {
        void postRes(
          link,
          maybeId,
          400,
          'application/json; charset=utf-8',
          jsonStr({ ok: false, error: 'bad request' }),
          signal,
        )
      }
      return
    }
    if ((inflightByDevice.get(deviceId) ?? 0) >= maxInflightPerDevice) {
      void postRes(
        link,
        req.id,
        429,
        'application/json; charset=utf-8',
        jsonStr({ ok: false, error: 'too many threads proxy requests' }),
        signal,
      )
      return
    }
    inc(deviceId)
    void dispatchReq(deviceId, link, req, signal)
  }

  function follow(id: string): void {
    const ac = new AbortController()
    const done = (async () => {
      while (!closed && !ac.signal.aborted && online(id)) {
        const link = o.links.link(id)
        if (!link) break
        let wait = AGAIN_MS
        try {
          const res = await link.fetch('/api/node/threads-proxy', { signal: ac.signal })
          if (res.status === 404) wait = NONE_MS
          if (!res.ok || !res.body) {
            await res.body?.cancel()
          } else {
            const pusher = createStreamPusher(link, ac.signal)
            pushers.set(id, pusher)
            pusher.notify(o.currentRev())
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
                  o.log(`node ${id}: threads-proxy event too large, dropping`)
                  break
                }
                for (const e of got.events) {
                  if (e.name === 'req') scheduleReq(id, link, e.data, ac.signal)
                }
              }
            } finally {
              if (pushers.get(id) === pusher) pushers.delete(id)
              ac.signal.removeEventListener('abort', stop)
              await reader.cancel().catch(() => {})
              reader.releaseLock()
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) o.log(`node ${id}: threads-proxy: ${messageOf(err)}`)
        }
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
    notifyRev(on, rev) {
      if (closed) return
      const state: ThreadsProxyRev = { on, rev }
      for (const pusher of pushers.values()) pusher.notify(state)
    },
    async close() {
      closed = true
      off()
      pushers.clear()
      const held = [...following.values()]
      for (const f of held) f.ac.abort()
      await Promise.all(held.map(f => f.done))
    },
  }
}
