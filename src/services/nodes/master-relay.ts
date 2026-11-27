// The master's half of the relay from its nodes (#764; the wire and the table: core/master-relay.ts).
//
// For each online node link, holds `GET /api/node/master-relay` open on the node's door, reads the requests
// the node puts on it and runs each against this board's own routes (`replay`, server/app.ts: the
// same table and guards as any request here, as a remote owner's), then posts the answer back to
// the node's door: its head, and a stream (SSE) chunk by chunk. A request for another machine's
// session goes the same way, which hands it to the node proxy (server/routes/node-proxy.ts).
//
// What a node sends is its word only: the path is held to the declared table again here, and who
// it is to the rules there (the machines are one mesh: a device's requests are the owner's unless
// the master's owner turned it off, `nodes.devices.<id>.owner: false`; a session of that node reads
// only; never a Team peer). A write's idempotency key is remembered per device with
// its answer, so a write retried after a broken link runs once: the same answer comes back again.
// Made by server/app.ts only once `nodes` is configured.
import { createHash } from 'node:crypto'
import { pace } from '../../adapters/pacing.ts'
import { takeEvents } from '../../core/event-stream.ts'
import { FLAGS_EVERY_MS } from '../../core/master-flags.ts'
import {
  isRelayId,
  masterPath,
  plainPath,
  RELAY_ANSWER_HEADERS,
  RELAY_ANSWER_MAX,
  RELAY_CHUNK_MAX,
  RELAY_ERRORS,
  RELAY_REQUEST_HEADERS,
  type RelayHead,
  type RelayRequest,
  type RelayWho,
  rawPathOf,
  relayBodyMax,
  relayError,
  relayMatch,
  relayRequestOf,
} from '../../core/master-relay.ts'
import { TEAM_FILE_PATH } from '../../core/upload-name.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'

export interface MasterRelayRunner {
  sync(): void
  /** The flags may have changed (#775: the user's presence): posted to the nodes whose stream is up, where they did. */
  flagsChanged(): void
  close(): Promise<void>
}

export interface MasterRelayRunnerOptions {
  links: Pick<NodeLinks, 'link' | 'onChange'>
  log(text: string): void
  deviceIds?: () => readonly string[]
  /** This board's own device id: a session key with it is one of this board's own. */
  selfId(): string
  /** The device's requests are taken as the owner's: on unless `nodes.devices.<id>.owner: false` (or revoked). */
  ownerAllowed(device: string): boolean
  /** `key` is a session of `device` this board knows (its card in the nodes' part). */
  sessionKnown(device: string, key: string): boolean
  /** The request run against this board's own routes; `device` asked it, as `who`. */
  replay(req: Request, o: { device: string; who: RelayWho }): Promise<Response>
  maxInflightPerDevice?: number
  maxStreamsPerDevice?: number
  /** How many writes' answers are remembered per device. */
  ledgerMax?: number
  /**
   * This board's feature flags for its nodes (#775, services/nodes/master-flags.ts): posted to a
   * node's door when its stream opens, and again when they change.
   */
  flags?(): unknown
}

interface Recorded {
  status: number
  headers: Record<string, string>
  body?: string
}

const AGAIN_MS = 2000
/** core/master-flags.ts FLAGS_EVERY_MS: the flags again, so a node can tell they are current. */
const FLAGS_AGAIN_MS = FLAGS_EVERY_MS
const NONE_MS = 60_000
const MOST_EVENT_CHARS = 1 << 20
const DEFAULT_MAX_INFLIGHT = 32
const DEFAULT_MAX_STREAMS = 16
/** As the uplink's ledger (core/node-uplink.ts UPLINK_SEEN_MAX). */
const DEFAULT_LEDGER_MAX = 500

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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

function answerHeadersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of RELAY_ANSWER_HEADERS) {
    const v = res.headers.get(name)
    if (v !== null) out[name] = v
  }
  return out
}

/** The answer's body, at most `max` bytes; null when larger. */
async function bytesUpTo(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array(0)
  const parts: Uint8Array[] = []
  let size = 0
  for await (const part of res.body) {
    size += part.byteLength
    if (size > max) {
      await res.body.cancel().catch(() => {})
      return null
    }
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

/** The largest answer the ledger keeps. */
const LEDGER_BODY_MAX = 64 * 1024

/** Whether an answer is kept for its idempotency key: one that may pass on a retry is not. */
const keep = (r: Recorded): boolean => r.status < 500 && r.status !== 429 && (r.body?.length ?? 0) <= LEDGER_BODY_MAX

/** What a write was, for its idempotency key: the method, the path it ran and its body. */
function printOf(req: RelayRequest, path: string): string {
  return createHash('sha256')
    .update(`${req.method} ${path}\u0000`)
    .update(req.body ?? req.bodySha ?? '')
    .digest('base64url')
}

const failure = (status: number, code: string): Recorded => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: Buffer.from(JSON.stringify(relayError(code))).toString('base64'),
})

export function createMasterRelayRunner(o: MasterRelayRunnerOptions): MasterRelayRunner {
  const following = new Map<string, { ac: AbortController; done: Promise<void> }>()
  /** Per device and request id, a run the node may end (its caller went away). */
  const running = new Map<string, AbortController>()
  const inflight = new Map<string, number>()
  const streams = new Map<string, number>()
  /** Per device, writes' answers by idempotency key, oldest first, each with what the request was. */
  const ledgers = new Map<string, Map<string, { print: string; answer: Promise<Recorded | null> }>>()
  const maxInflight = Math.max(1, o.maxInflightPerDevice ?? DEFAULT_MAX_INFLIGHT)
  const maxStreams = Math.max(1, o.maxStreamsPerDevice ?? DEFAULT_MAX_STREAMS)
  const ledgerMax = Math.max(1, o.ledgerMax ?? DEFAULT_LEDGER_MAX)
  /** Per device, the flags last posted (as JSON), so an unchanged config posts nothing. */
  const sentFlags = new Map<string, string>()
  /** The devices whose stream is open now: a change of the flags goes to those. */
  const streaming = new Set<string>()
  let closed = false

  const online = (id: string): boolean => o.links.link(id)?.state().state === 'online'
  const bump = (map: Map<string, number>, id: string, by: number): void => {
    const next = (map.get(id) ?? 0) + by
    if (next <= 0) map.delete(id)
    else map.set(id, next)
  }

  function endDevice(id: string): void {
    const prefix = `${id}\u0000`
    for (const [k, ac] of [...running]) {
      if (!k.startsWith(prefix)) continue
      running.delete(k)
      ac.abort()
    }
  }

  function changed(id: string): void {
    if (closed) return
    const held = following.get(id)
    // A device turned off (`owner: false`) or revoked keeps nothing running here.
    if (!o.ownerAllowed(id)) endDevice(id)
    if (online(id)) {
      if (!held || held.ac.signal.aborted) follow(id)
    } else {
      held?.ac.abort()
      endDevice(id)
      sentFlags.delete(id)
      // A device gone from config.json takes its ledger with it.
      if (!o.links.link(id)) ledgers.delete(id)
    }
  }

  async function post(link: Link, path: string, body: unknown, signal: AbortSignal): Promise<boolean> {
    try {
      const res = await link.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      await res.body?.cancel().catch(() => {})
      return res.ok
    } catch {
      return false
    }
  }

  /** The flags to a node's door (#775); `again`: even when they are the ones it was sent last. */
  async function sendFlags(id: string, link: Link, signal: AbortSignal, again: boolean): Promise<void> {
    const flags = o.flags?.()
    if (flags === undefined) return
    const text = JSON.stringify(flags)
    if (!again && sentFlags.get(id) === text) return
    sentFlags.set(id, text)
    // A node without the route (an older version) or a link that went: sent again on the next change or stream.
    if (!(await post(link, '/api/node/master-flags', flags, signal)) && sentFlags.get(id) === text) sentFlags.delete(id)
  }

  const postHead = (link: Link, id: string, head: RelayHead, signal: AbortSignal): Promise<boolean> =>
    post(link, `/api/node/master-relay/res/${id}`, head, signal)

  /** The request as this board's routes take it, or the refusal. */
  function check(device: string, req: RelayRequest): { path: string } | Recorded {
    // The device first: one turned off asks nothing here, whoever it says it is.
    if (!o.ownerAllowed(device)) return failure(403, RELAY_ERRORS.owner)
    // The path held to the table is the path that runs: a plain one only (core/master-relay.ts plainPath).
    const raw = rawPathOf(req.path)
    if (!plainPath(raw)) return failure(400, RELAY_ERRORS.path)
    const match = relayMatch(req.method, raw, () => false)
    if (!match) return failure(404, RELAY_ERRORS.path)
    if (match.kind === 'keyed' && match.device === device) return failure(400, RELAY_ERRORS.loop)
    if (req.who.kind === 'session') {
      if (req.method !== 'GET') return failure(403, RELAY_ERRORS.sessionWrite)
      if (!o.sessionKnown(device, req.who.key)) return failure(403, RELAY_ERRORS.session)
    }
    const path = masterPath(req.path, o.selfId())
    if (!plainPath(rawPathOf(path))) return failure(400, RELAY_ERRORS.path)
    return { path }
  }

  /**
   * A write's answer by its idempotency key: the one it had, or the one it is about to have; a run
   * now when there is none. Another request under the same key is refused (422). What did not end
   * in an answer (its caller or the link went first), and a failure that may pass (5xx, 429), is not
   * remembered: the next try runs. An answer larger than LEDGER_BODY_MAX is not kept either.
   */
  async function remembered(
    device: string,
    idem: string,
    print: string,
    once: () => Promise<Recorded | null>,
  ): Promise<Recorded | null> {
    for (;;) {
      let ledger = ledgers.get(device)
      if (!ledger) {
        ledger = new Map()
        ledgers.set(device, ledger)
      }
      const seen = ledger.get(idem)
      if (seen) {
        if (seen.print !== print) return failure(422, RELAY_ERRORS.idemMismatch)
        const got = await seen.answer
        if (got && keep(got)) return got
        // The run it waited for gave nothing to keep: one of those waiting runs it again.
        if (ledger.get(idem) === seen) ledger.delete(idem)
        continue
      }
      const entry = { print, answer: once() }
      ledger.set(idem, entry)
      while (ledger.size > ledgerMax) ledger.delete(ledger.keys().next().value as string)
      const got = await entry.answer
      if ((!got || !keep(got)) && ledger.get(idem) === entry) ledger.delete(idem)
      return got
    }
  }

  async function bodyOf(link: Link, req: RelayRequest, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
    if (req.body) {
      const decoded = Buffer.from(req.body, 'base64')
      const out = new Uint8Array(decoded.byteLength)
      out.set(decoded)
      return out
    }
    if (!req.hasBody) return null
    const res = await link.fetch(`/api/node/master-relay/req/${req.id}/body`, { signal })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`body fetch: HTTP ${res.status}`)
    }
    const bytes = await bytesUpTo(res, relayBodyMax(req.method, rawPathOf(req.path)))
    if (!bytes) throw new Error('body too large')
    if (createHash('sha256').update(bytes).digest('hex') !== req.bodySha)
      throw new Error('body does not match its hash')
    return bytes
  }

  /** Runs the request here; a stream is posted as it comes and gives null, any other answer its record. */
  async function run(
    device: string,
    link: Link,
    req: RelayRequest,
    path: string,
    ac: AbortController,
  ): Promise<Recorded | null> {
    const body = await bodyOf(link, req, ac.signal)
    const headers = new Headers()
    for (const name of RELAY_REQUEST_HEADERS) {
      const v = req.headers[name]
      if (v !== undefined) headers.set(name, v)
    }
    // Not this board's loopback: what asks the owner at the computer (#224, #377) treats it as from away.
    const request = new Request(`http://${device}.master-relay.invalid${path}`, {
      method: req.method,
      headers,
      ...(body && body.byteLength > 0 && { body }),
      signal: ac.signal,
    })
    const res = await o.replay(request, { device, who: req.who })
    const head = answerHeadersOf(res)
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    const teamFile = req.method === 'GET' && TEAM_FILE_PATH.test(rawPathOf(path)) && res.ok
    if ((!teamFile && !type.startsWith('text/event-stream')) || !res.body) {
      const bytes = await bytesUpTo(res, RELAY_ANSWER_MAX)
      if (!bytes) return failure(502, RELAY_ERRORS.tooBig)
      return {
        status: res.status,
        headers: head,
        ...(bytes.byteLength && { body: Buffer.from(bytes).toString('base64') }),
      }
    }
    if (!(await postHead(link, req.id, { status: res.status, headers: head, more: true }, ac.signal))) {
      await res.body.cancel().catch(() => {})
      return null
    }
    const reader = res.body.getReader()
    const stop = (): void => void reader.cancel().catch(() => {})
    ac.signal.addEventListener('abort', stop, { once: true })
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done || ac.signal.aborted) break
        for (let at = 0; at < next.value.byteLength; at += RELAY_CHUNK_MAX) {
          const part = next.value.subarray(at, at + RELAY_CHUNK_MAX)
          const data = Buffer.from(part).toString('base64')
          if (!(await post(link, `/api/node/master-relay/stream/${req.id}`, { data }, ac.signal))) {
            ac.abort()
            break
          }
        }
      }
      if (!ac.signal.aborted) await post(link, `/api/node/master-relay/stream/${req.id}`, { done: true }, ac.signal)
    } finally {
      ac.signal.removeEventListener('abort', stop)
      await reader.cancel().catch(() => {})
    }
    return null
  }

  async function handle(device: string, link: Link, req: RelayRequest, linkSignal: AbortSignal): Promise<void> {
    const key = `${device}\u0000${req.id}`
    const ac = new AbortController()
    const onLink = (): void => ac.abort()
    linkSignal.addEventListener('abort', onLink, { once: true })
    running.set(key, ac)
    try {
      const ok = check(device, req)
      if (!('path' in ok)) {
        await postHead(link, req.id, ok, ac.signal)
        return
      }
      const once = (): Promise<Recorded | null> =>
        run(device, link, req, ok.path, ac).catch(err => {
          if (ac.signal.aborted) return null
          o.log(`node ${device}: master relay ${req.method} ${rawPathOf(req.path)}: ${messageOf(err)}`)
          return {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: Buffer.from(JSON.stringify({ ok: false, error: messageOf(err) })).toString('base64'),
          }
        })
      const recorded =
        req.method !== 'GET' && req.idem
          ? await remembered(device, req.idem, printOf(req, ok.path), once)
          : await once()
      if (recorded && !ac.signal.aborted) await postHead(link, req.id, recorded, ac.signal)
    } finally {
      if (running.get(key) === ac) running.delete(key)
      linkSignal.removeEventListener('abort', onLink)
    }
  }

  function schedule(device: string, link: Link, req: RelayRequest, signal: AbortSignal): void {
    const stream = req.method === 'GET' && relayMatch('GET', rawPathOf(req.path), () => false)
    const isStream = !!stream && stream.kind === 'table' && stream.entry.stream === true
    const counts = isStream ? streams : inflight
    if ((counts.get(device) ?? 0) >= (isStream ? maxStreams : maxInflight)) {
      void postHead(link, req.id, failure(429, RELAY_ERRORS.busy), signal)
      return
    }
    bump(counts, device, 1)
    void handle(device, link, req, signal).finally(() => bump(counts, device, -1))
  }

  function follow(id: string): void {
    const ac = new AbortController()
    const done = (async () => {
      while (!closed && !ac.signal.aborted && online(id)) {
        const link = o.links.link(id)
        if (!link) break
        let wait = AGAIN_MS
        try {
          const res = await link.fetch('/api/node/master-relay', { signal: ac.signal })
          // A node without the relay (an older version): asked again much later.
          if (res.status === 404) wait = NONE_MS
          if (!res.ok || !res.body) await res.body?.cancel().catch(() => {})
          else {
            streaming.add(id)
            void sendFlags(id, link, ac.signal, true)
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
                  o.log(`node ${id}: master relay event too large, dropping the stream`)
                  break
                }
                for (const e of got.events) {
                  let raw: unknown = null
                  try {
                    raw = JSON.parse(e.data)
                  } catch {}
                  if (e.name === 'close') {
                    const reqId = (raw as { id?: unknown } | null)?.id
                    const run = typeof reqId === 'string' ? running.get(`${id}\u0000${reqId}`) : undefined
                    run?.abort()
                    continue
                  }
                  if (e.name !== 'req') continue
                  const req = relayRequestOf(raw)
                  if (req) schedule(id, link, req, ac.signal)
                  else {
                    // One the master does not take: said at once when it has an id to answer, not left to time out.
                    const reqId = (raw as { id?: unknown } | null)?.id
                    if (isRelayId(reqId)) void postHead(link, reqId, failure(400, RELAY_ERRORS.path), ac.signal)
                  }
                }
              }
            } finally {
              streaming.delete(id)
              ac.signal.removeEventListener('abort', stop)
              await reader.cancel().catch(() => {})
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) o.log(`node ${id}: master relay: ${messageOf(err)}`)
        }
        endDevice(id)
        if (closed || ac.signal.aborted) break
        await sleep(Math.round(wait * pace()), ac.signal)
      }
    })().finally(() => {
      if (following.get(id)?.ac === ac) following.delete(id)
    })
    following.set(id, { ac, done })
  }

  /** The flags to every node whose stream is up; `again`: even unchanged. */
  function flagsToAll(again: boolean): void {
    if (!o.flags) return
    for (const [id, held] of following) {
      const link = o.links.link(id)
      if (link && streaming.has(id) && !held.ac.signal.aborted) void sendFlags(id, link, held.ac.signal, again)
    }
  }
  // Only a runner with flags keeps a timer for them.
  const flagsTimer = o.flags ? setInterval(() => flagsToAll(true), Math.round(FLAGS_AGAIN_MS * pace())) : null

  const off = o.links.onChange(changed)

  return {
    sync() {
      if (closed) return
      for (const id of new Set([...following.keys(), ...(o.deviceIds?.() ?? [])])) changed(id)
      flagsToAll(false)
    },
    flagsChanged() {
      if (!closed) flagsToAll(false)
    },
    async close() {
      closed = true
      if (flagsTimer) clearInterval(flagsTimer)
      off()
      for (const ac of running.values()) ac.abort()
      running.clear()
      const waits = [...following.values()].map(f => {
        f.ac.abort()
        return f.done
      })
      following.clear()
      await Promise.all(waits)
    },
  }
}
