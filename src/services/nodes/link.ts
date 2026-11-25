// One device's link from the master (#499, docs/design/nodes 4.2, 5, 6.5): the master dials, the
// node's door (server/node-listener.ts) answers. Through a pipe that differs by the link's kind:
// `direct` is the door's own URL (tests, a forward the owner keeps up himself), `ssh` a local
// forward this link keeps up (adapters/node-ssh.ts), and `relay` a local forward to the relay
// server's unix socket with pinned TLS (services/nodes/relay.ts); `tailnet` is not built yet and
// is refused so. The link only receives: the node's payload stream and its status.
//
// - fetch(): a request to the node with its bearer token, X-Board: 1 on writes and no Origin; over
//   ssh with the door's own Host, which it checks. Only while the door was found to be this
//   device's: 503 node-offline before that and while refused.
// - The payload stream: `GET /api/events`, its unnamed data lines read as the page reads them
//   (core/payload-check.ts). Every byte, pings too, says the node is there.
// - Offline: no byte for 90 s (BOARD_NODE_DEAD_MS in tests). A silent stream is then dropped; the
//   last payload stays.
// - Again after a drop with the tunnel's backoff (core/tunnel.ts backoffMs), which starts over once
//   a stream lasted a minute; at once when the computer woke or its addresses changed (links.ts
//   calls reconnect()). Never two streams: a new one is asked for only after the last one ended.
// - Refused: a cause waiting does not heal (core/nodes.ts LinkReason), tried again once a minute.
//   A token the node does not take is tried once a minute, never faster, a wake or a new address
//   included: the door locks out a caller after five wrong tokens a minute.
// - status(): `GET /api/node/status` every 30 s while the stream is open, and when asked, each
//   within 1.5 s.
import { isCertError } from '../../adapters/door-cert.ts'
import type { PidRecord, SshChild } from '../../adapters/ssh.ts'
import { takeEvents } from '../../core/event-stream.ts'
import { NODE_API } from '../../core/node-door.ts'
import {
  type DeviceConfig,
  type DeviceView,
  type LinkConfig,
  type LinkReason,
  type LinkStatus,
  type NodeStatus,
  nodeStatusOf,
  statusShown,
} from '../../core/nodes.ts'
import type { BoardPayload } from '../../core/payload.ts'
import { isBoardPayload } from '../../core/payload-check.ts'
import { backoffMs, isLasting, sshHint } from '../../core/tunnel.ts'
import type { Clock } from '../tunnel.ts'

/** What the ssh pipe runs (adapters/node-ssh.ts, adapters/ssh.ts), handed in so tests can stand in. */
export interface SshPipeDeps {
  /** The ssh binary; null when none is found (the start then fails as ssh not found). */
  bin(): string | null
  /** The whole argument list for this local port. */
  args(localPort: number): string[]
  /** `-L`'s value for this local port, which the pid record names. */
  forward(localPort: number): string
  /** The device's local port; `fresh`: a new one, the old one being taken. */
  localPort(fresh: boolean): Promise<number>
  /** The device's link key is there. */
  keyExists(): boolean
  spawn(bin: string, args: string[]): SshChild
  /** The device's pid record, and ending the ssh it names (true once none of ours runs under its pid). */
  stray: { read(): PidRecord | null; write(r: PidRecord | null): void; end(r: PidRecord): Promise<boolean> }
  /** ssh -v saying the forward listens on this port. */
  up(line: string, localPort: number): boolean
  /** ssh could not listen on its local port. */
  portTaken(line: string): boolean
}

/** What the relay pipe runs (services/nodes/relay.ts): an ssh -L to the relay socket plus TLS pinning. */
export interface RelayPipeDeps extends SshPipeDeps {
  /** The device's pinned door certificate PEM, or null if none is pinned yet. */
  pinnedCert(): string | null
  /** Builds the Bun TLS options pinning `certPem` (adapters/door-cert.ts pinnedTls). */
  tlsFor(certPem: string): NonNullable<BunFetchRequestInit['tls']>
  /** False when the configured socket name does not pass validation. */
  socketValid?: boolean
}

export interface LinkDeps {
  /** The token the node gave this master, read at each try; null: none stored. */
  token(): string | null
  clock: Clock
  log(text: string): void
  fetch?: (url: string, init: BunFetchRequestInit) => Promise<Response>
  random?: () => number
  /** For a link of kind ssh. */
  ssh?: SshPipeDeps
  /** For a link of kind relay. */
  relay?: RelayPipeDeps
  /** Optional pinned TLS config for `direct` https:// links (handover over tailnet/LAN). */
  directTls?: () => BunFetchRequestInit['tls'] | undefined
  /** This board's own commit (adapters/git.ts headCommit), to say whether the node runs the same; '' unknown. */
  commit?: () => string
}

/** The link's waits: production's, or a test's (adapters/pacing.ts knobs and pace). */
export interface LinkTimes {
  /** No byte on the stream this long: offline (90 s). */
  deadMs: number
  /** The status is asked this often while the stream is open (30 s). */
  statusMs: number
  /** The factor the backoff and the minute between refused tries are multiplied by (1; less in tests). */
  pace: number
}

export interface Link {
  readonly id: string
  /** A request to the node's door, `path` from its root; 503 node-offline while there is no door found to be this device's. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** The node's status now, within 1.5 s; null when it could not be had. */
  status(): Promise<NodeStatus | null>
  state(): LinkStatus
  /** The node's last payload, kept when it goes offline; null before the first. */
  payload(): BoardPayload | null
  view(): DeviceView
  onPayload(fn: (payload: BoardPayload) => void): () => void
  onState(fn: (state: LinkStatus) => void): () => void
  /** A status came whose shown figures (core/nodes.ts statusShown) differ from the last one told. */
  onStatus(fn: (status: NodeStatus) => void): () => void
  /**
   * Tries again at once from the first attempt: the computer woke or its addresses changed. A link
   * the node refused for its token waits out its minute all the same, unless `force`: a token was
   * stored.
   */
  reconnect(why: string, force?: boolean): void
  /** For an exit handler: its ssh ended synchronously. */
  killNow(): void
  close(): Promise<void>
}

export const DEAD_MS = 90_000
export const STATUS_MS = 30_000
/** The status within this long (6.3). A deadline, never paced. */
export const ASK_MS = 1500
/** Hello within this long: the first request through a fresh ssh channel may take a while. */
const HELLO_MS = 5000
/** A stream that lasted this long (paced): the backoff starts over when it ends. */
const UP_RESETS_MS = 60_000
/** A refused link is tried again this often (paced). */
const REFUSED_RETRY_MS = 60_000
/** ssh up to its forward within this long, else ended (ssh's own ConnectTimeout is 15 s). */
const SSH_UP_MS = 30_000
/** A payload larger than this (one event) ends the stream: no node's board is that big. */
const MOST_EVENT_CHARS = 64 * 1024 * 1024
/** ssh's last lines kept for the detail. */
const LINES_KEPT = 20

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** What a node says, as it goes into a state's detail and the log: printable, and short. */
const said = (v: unknown): string =>
  String(v)
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 64)
const offline = (): Response =>
  new Response(JSON.stringify({ error: 'node-offline' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })

/** What a pipe's open() gives: the door's base URL (and the Host it checks, plus TLS pinning for relay), or why not. */
type Opened =
  | { ok: true; base: string; host?: string; tls?: BunFetchRequestInit['tls'] }
  | { ok: false; refused?: { reason: LinkReason; detail: string }; error: string }
type Door = Extract<Opened, { ok: true }>

interface Pipe {
  open(): Promise<Opened>
  /** Ends what it holds; the next open() starts over. */
  reset(): Promise<void>
  /** Ends what it holds, and an open() under way starts nothing more. */
  close(): Promise<void>
  killNow(): void
}

const NOTHING = { reset: async () => {}, close: async () => {}, killNow: () => {} }

const directPipe = (url: string, directTls?: () => BunFetchRequestInit['tls'] | undefined): Pipe => ({
  ...NOTHING,
  open: async () => {
    const base = url.replace(/\/+$/, '')
    const tls = base.startsWith('https://') ? directTls?.() : undefined
    return { ok: true, base, ...(tls ? { tls } : {}) }
  },
})

const notBuilt = (kind: string): Pipe => ({
  ...NOTHING,
  open: async () => ({
    ok: false,
    refused: { reason: 'not-built', detail: `a ${kind} link is not built yet` },
    error: '',
  }),
})

/** A line of ssh's that may say what went wrong: not -v's own. */
const worthKeeping = (line: string): boolean => !line.startsWith('debug')

/**
 * Shared ssh local-forward pipe for both direct `ssh` and `relay` links: started on open() unless
 * up; ended on reset(). Never two: a recorded ssh a board before left is ended first, none starts
 * while it may still run, and none after close(). Its record is cleared when it ends.
 */
function forwardPipe(
  d: SshPipeDeps,
  clock: Clock,
  log: (t: string) => void,
  o: {
    makeDoor: (port: number) => Opened
    missingKeyDetail: string
    preCheck?: () => Opened | null
  },
): Pipe {
  let held: { child: SshChild; port: number; up: boolean; asked: boolean } | null = null
  let fresh = false
  let closed = false
  /** The reset under way: a second one, and open(), wait for it, so no record is cleared under a new ssh. */
  let resetting: Promise<void> | null = null
  const record = (r: PidRecord | null): void => {
    try {
      d.stray.write(r)
    } catch (err) {
      log(`the pid record: ${messageOf(err)}`)
    }
  }
  const stopped: Opened = { ok: false, error: 'the link is closing' }

  function reset(): Promise<void> {
    resetting ??= (async () => {
      const h = held
      if (!h) return
      held = null
      h.asked = true
      h.child.kill()
      await h.child.exited
      record(null)
    })().finally(() => {
      resetting = null
    })
    return resetting
  }

  async function open(): Promise<Opened> {
    if (closed) return stopped
    const refused = o.preCheck?.()
    if (refused) return refused
    if (held?.up) return o.makeDoor(held.port)
    await reset()
    if (!d.keyExists()) return { ok: false, refused: { reason: 'key', detail: o.missingKeyDetail }, error: '' }
    const stray = d.stray.read()
    if (stray) {
      const gone = await d.stray.end(stray).catch(() => false)
      if (closed) return stopped
      if (!gone) return { ok: false, error: `an ssh a board before left (pid ${stray.pid}) may still run` }
      record(null)
    }
    const bin = d.bin() ?? 'ssh'
    const port = await d.localPort(fresh)
    // close() came while this waited, or another open() started one meanwhile: none started here.
    if (closed) return stopped
    if (held) return { ok: false, error: 'an ssh of this link is starting' }
    fresh = false
    const child = d.spawn(bin, d.args(port))
    const h = { child, port, up: false, asked: false }
    held = h
    if (child.pid > 0) record({ pid: child.pid, forward: d.forward(port), at: clock.now() })
    log(`ssh started (pid ${child.pid})`)
    const lines: string[] = []
    return new Promise<Opened>(resolve => {
      let done = false
      const finish = (res: Opened): void => {
        if (done) return
        done = true
        clock.clearTimeout(deadline)
        resolve(res)
      }
      const deadline = clock.setTimeout(() => {
        if (held === h) void reset()
        finish({ ok: false, error: 'ssh did not open its forward in time' })
      }, SSH_UP_MS)
      child.onLine(line => {
        if (h.up || h.asked) return
        if (d.up(line, port)) {
          h.up = true
          log('ssh forward up')
          finish(o.makeDoor(port))
          return
        }
        if (d.portTaken(line)) fresh = true
        if (worthKeeping(line)) {
          lines.push(line)
          if (lines.length > LINES_KEPT) lines.shift()
        }
      })
      void child.exited.then(r => {
        if (held === h) {
          held = null
          record(null)
        }
        if (!h.asked) log(`ssh exited (${r.error ?? `code ${String(r.code)}`})`)
        if (r.error) {
          finish({ ok: false, refused: { reason: 'ssh', detail: `noSsh: ${bin}: ${r.error}` }, error: '' })
          return
        }
        const hint = sshHint(lines)
        const last = lines.at(-1) ?? `ssh exited with code ${String(r.code)}`
        if (hint === 'hostKey') finish({ ok: false, refused: { reason: 'host-key', detail: last }, error: '' })
        else if (isLasting(hint))
          finish({ ok: false, refused: { reason: 'ssh', detail: `${hint}: ${last}` }, error: '' })
        else finish({ ok: false, error: last })
      })
    })
  }

  return {
    open,
    reset,
    async close() {
      closed = true
      await reset()
    },
    killNow: () => held?.child.killNow(),
  }
}

function sshPipe(
  link: Extract<LinkConfig, { kind: 'ssh' }>,
  d: SshPipeDeps,
  clock: Clock,
  log: (t: string) => void,
): Pipe {
  return forwardPipe(d, clock, log, {
    makeDoor: port => ({ ok: true, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${link.port}` }),
    missingKeyDetail: 'no link key yet: board nodes key <id>',
  })
}

function relayPipe(d: RelayPipeDeps, clock: Clock, log: (t: string) => void): Pipe {
  const door = (port: number): Opened => {
    const cert = d.pinnedCert()
    if (!cert) return { ok: false, refused: { reason: 'cert', detail: 'no pinned door certificate' }, error: '' }
    try {
      return { ok: true, base: `https://127.0.0.1:${port}`, host: '127.0.0.1', tls: d.tlsFor(cert) }
    } catch {
      return { ok: false, refused: { reason: 'cert', detail: 'invalid pinned door certificate' }, error: '' }
    }
  }
  return forwardPipe(d, clock, log, {
    makeDoor: door,
    missingKeyDetail: 'no relay master key yet: set up the relay first',
    preCheck: () => {
      if (d.socketValid === false)
        return { ok: false, refused: { reason: 'ssh', detail: 'invalid relay socket name' }, error: '' }
      if (!d.pinnedCert())
        return { ok: false, refused: { reason: 'cert', detail: 'no pinned door certificate' }, error: '' }
      return null
    },
  })
}

function pipeFor(device: DeviceConfig, deps: LinkDeps): Pipe {
  const link = device.link
  if (!link) return notBuilt('local')
  if (link.kind === 'direct') return directPipe(link.url, deps.directTls)
  if (link.kind === 'ssh' && deps.ssh)
    return sshPipe(link, deps.ssh, deps.clock, t => deps.log(`node ${device.id}: ${t}`))
  if (link.kind === 'relay' && deps.relay)
    return relayPipe(deps.relay, deps.clock, t => deps.log(`node ${device.id}: ${t}`))
  return notBuilt(link.kind)
}

/** Why a stream we hold was dropped by us. */
type Drop = 'close' | 'dead' | 'again' | 'refused'

export function createLink({ device, cfg, deps }: { device: DeviceConfig; cfg: LinkTimes; deps: LinkDeps }): Link {
  const { clock } = deps
  const ask = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const pipe = pipeFor(device, deps)
  const log = (text: string): void => deps.log(`node ${device.id}: ${text}`)
  let status: LinkStatus = { state: 'connecting', since: clock.now(), heardAt: null }
  /** The last byte, or the link's start before any: what offline is counted from. */
  let lastByte = clock.now()
  let payload: BoardPayload | null = null
  let payloadAt: number | null = null
  let nodeStatus: NodeStatus | null = null
  /** The door, once its hello said it is this device's; null before, while refused, and when the pipe fails. */
  let door: Door | null = null
  let attempt = 1
  let retry: unknown = null
  let statusTimer: unknown = null
  let stream: { ac: AbortController; drop: Drop | null } | null = null
  let running = false
  let again = false
  let closed = false
  const payloadFns = new Set<(p: BoardPayload) => void>()
  const stateFns = new Set<(s: LinkStatus) => void>()
  const statusFns = new Set<(s: NodeStatus) => void>()
  /** The shown figures of the last status told: one every 30 s that rounds the same tells nobody. */
  let toldStatus = ''

  const set = (next: Omit<LinkStatus, 'heardAt'>): void => {
    const was = status
    status = { ...next, heardAt: was.heardAt }
    if (
      was.state === status.state &&
      was.reason === status.reason &&
      was.detail === status.detail &&
      was.attempt === status.attempt &&
      was.nextAt === status.nextAt
    )
      return
    if (was.state !== status.state)
      log(`${status.state}${status.reason ? ` (${status.reason})` : ''}${status.detail ? `: ${status.detail}` : ''}`)
    for (const fn of stateFns) fn({ ...status })
  }
  const dead = (): boolean => clock.now() - lastByte >= cfg.deadMs

  function cancelRetry(): void {
    if (retry === null) return
    clock.clearTimeout(retry)
    retry = null
  }
  function retryIn(ms: number): void {
    cancelRetry()
    retry = clock.setTimeout(() => {
      retry = null
      kick()
    }, ms)
  }

  /** Tried again after the backoff. Online stays online until the node has been silent too long. */
  function later(detail: string): void {
    if (closed) return
    const now = clock.now()
    const wait = Math.round(backoffMs(attempt, deps.random) * cfg.pace)
    const state = dead() ? 'offline' : status.state === 'online' ? 'online' : 'connecting'
    set({ state, since: state === status.state ? status.since : now, detail, attempt, nextAt: now + wait })
    attempt += 1
    retryIn(wait)
  }

  /** A cause waiting does not heal: tried again in a minute (`afterMs` when the node says longer); never for a link not built. */
  function refuse(reason: LinkReason, detail: string, afterMs = 0): void {
    door = null
    if (closed) return
    const now = clock.now()
    const wait = Math.max(Math.round(REFUSED_RETRY_MS * cfg.pace), afterMs)
    const nextAt = reason === 'not-built' ? undefined : now + wait
    set({
      state: 'refused',
      since: status.state === 'refused' ? status.since : now,
      reason,
      detail,
      ...(nextAt && { nextAt }),
    })
    if (nextAt) retryIn(wait)
  }

  function headers(init: RequestInit | undefined, token: string | null, o: Door): Headers {
    const h = new Headers(init?.headers)
    h.delete('origin')
    h.delete('authorization')
    if (token) h.set('authorization', `Bearer ${token}`)
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') h.set('x-board', '1')
    if (o.host) h.set('host', o.host)
    return h
  }

  function call(o: Door, path: string, init: RequestInit, token: string | null): Promise<Response> {
    return ask(`${o.base}${path}`, { ...init, headers: headers(init, token, o), ...(o.tls && { tls: o.tls }) })
  }

  /** Drops an active stream and marks the link refused for a door certificate mismatch. */
  function refuseCert(): void {
    if (stream && !stream.drop) {
      stream.drop = 'refused'
      stream.ac.abort()
    }
    refuse('cert', 'the door answered with another certificate')
  }

  async function askStatus(): Promise<NodeStatus | null> {
    const o = door
    const token = deps.token()
    if (!o || !token || status.state === 'refused') return null
    try {
      const res = await call(o, '/api/node/status', { signal: AbortSignal.timeout(ASK_MS) }, token)
      const got = res.ok ? nodeStatusOf(await res.json()) : null
      if (!res.ok) await res.body?.cancel()
      if (got) nodeStatus = got
      tellStatus(got)
      return got
    } catch (err) {
      if (o.tls && isCertError(err)) refuseCert()
      return null
    }
  }

  /** The listeners hear a status only when its shown figures moved; one that throws stops nothing. */
  function tellStatus(got: NodeStatus | null): void {
    if (!got) return
    const shown = statusShown(got)
    if (shown === toldStatus) return
    toldStatus = shown
    for (const fn of statusFns)
      try {
        fn(got)
      } catch (err) {
        log(`a status listener: ${messageOf(err)}`)
      }
  }

  function statusOff(): void {
    if (statusTimer === null) return
    clock.clearInterval(statusTimer)
    statusTimer = null
  }
  function statusOn(): void {
    statusOff()
    void askStatus()
    statusTimer = clock.setInterval(() => void askStatus(), cfg.statusMs)
  }

  /** Every byte counts as the node being there. */
  function heard(): void {
    lastByte = clock.now()
    status = { ...status, heardAt: lastByte }
  }

  function took(p: BoardPayload): void {
    payload = p
    payloadAt = clock.now()
    // Online, and what a retry before said is cleared.
    if (status.state !== 'online' || status.detail !== undefined || status.nextAt !== undefined)
      set({ state: 'online', since: status.state === 'online' ? status.since : clock.now() })
    for (const fn of payloadFns) fn(p)
  }

  /** Reads the stream to its end; a refusal it carries (the master forgotten) is handled here. */
  async function read(body: ReadableStream<Uint8Array>, held: NonNullable<typeof stream>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let rest = ''
    let refusedOne = false
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done || held.drop) return
        heard()
        const text = decoder.decode(next.value, { stream: true })
        // No line break in it: no event ends here, so nothing is scanned again.
        if (!text.includes('\n')) {
          rest += text
          if (rest.length > MOST_EVENT_CHARS) return log('an event larger than the board takes: the stream dropped')
          continue
        }
        const { events, rest: left } = takeEvents(rest + text)
        rest = left
        if (rest.length > MOST_EVENT_CHARS) return log('an event larger than the board takes: the stream dropped')
        for (const e of events) {
          if (e.name === 'unpaired') {
            held.drop = 'refused'
            refuse('token', 'the node forgot this master')
            return
          }
          if (e.name) continue
          let value: unknown
          try {
            value = JSON.parse(e.data)
          } catch {
            value = null
          }
          if (isBoardPayload(value)) took(value)
          else if (!refusedOne) {
            refusedOne = true
            log('a payload that is not one: left out')
          }
        }
      }
    } catch (err) {
      if (!held.drop) log(`the stream: ${messageOf(err)}`)
    } finally {
      reader.releaseLock()
      held.ac.abort()
    }
  }

  /** One try: the pipe, hello, the stream until it ends. Whatever comes next is scheduled here. */
  async function once(): Promise<void> {
    cancelRetry()
    const token = deps.token()
    if (!token) return refuse('token', 'no token stored: board nodes token <id>')
    const o = await pipe.open()
    if (closed) return
    if (!o.ok) {
      door = null
      return o.refused ? refuse(o.refused.reason, o.refused.detail) : later(o.error)
    }
    let hello: unknown
    try {
      const res = await call(o, '/api/hello', { signal: AbortSignal.timeout(HELLO_MS) }, null)
      hello = res.ok ? await res.json() : null
      if (!res.ok) return later(`hello: HTTP ${res.status}`)
    } catch (err) {
      if (o.tls && isCertError(err)) return refuse('cert', 'the door answered with another certificate')
      return later(`hello: ${messageOf(err)}`)
    }
    const node = isObject(hello) ? hello.node : undefined
    if (!isObject(node) || node.api !== NODE_API)
      return refuse(
        'api',
        `the door's node.api is ${isObject(node) ? said(node.api) : 'none'}, this board's ${NODE_API}`,
      )
    if (node.id !== device.id) return refuse('device', `the door is ${said(node.id)}'s`)
    if (closed) return
    door = o
    const held = { ac: new AbortController(), drop: null as Drop | null }
    stream = held
    let res: Response
    try {
      res = await call(o, '/api/events', { signal: held.ac.signal }, token)
    } catch (err) {
      stream = null
      if (held.drop) return afterDrop(held.drop)
      if (o.tls && isCertError(err)) return refuse('cert', 'the door answered with another certificate')
      return later(`the stream: ${messageOf(err)}`)
    }
    if (res.status === 401 || res.status === 429) {
      await res.body?.cancel()
      stream = null
      // The door says when it takes this caller again; a wrong token is never tried sooner than a minute.
      const after = Number(res.headers.get('retry-after')) * 1000
      return refuse(
        'token',
        res.status === 401 ? 'the node does not take the token' : 'the node took too many wrong tokens',
        Number.isFinite(after) ? after : 0,
      )
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      stream = null
      return later(`the stream: HTTP ${res.status}`)
    }
    const upAt = clock.now()
    statusOn()
    await read(res.body, held)
    statusOff()
    if (stream === held) stream = null
    if (held.drop) return afterDrop(held.drop)
    if (clock.now() - upAt >= UP_RESETS_MS * cfg.pace) attempt = 1
    later('the stream ended')
  }

  function afterDrop(drop: Drop): void {
    if (drop === 'dead') later(`nothing from the node for ${Math.round(cfg.deadMs / 1000)} s`)
    // close: nothing more; again: run() goes on; refused: refuse() was called.
  }

  async function run(): Promise<void> {
    do {
      again = false
      try {
        await once()
      } catch (err) {
        log(messageOf(err))
        later(messageOf(err))
      }
      if (again) cancelRetry()
    } while (again && !closed)
    running = false
  }

  function kick(): void {
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = true
    void run()
  }

  /** Silent too long: offline, and a stream that says nothing is dropped and asked for again. */
  const watch = clock.setInterval(
    () => {
      if (closed || !dead()) return
      if (status.state === 'online' || status.state === 'connecting')
        set({ ...status, state: 'offline', since: clock.now() })
      if (stream && !stream.drop) {
        stream.drop = 'dead'
        stream.ac.abort()
      }
    },
    Math.max(20, Math.round(cfg.deadMs / 30)),
  )

  kick()

  return {
    id: device.id,
    async fetch(path, init) {
      if (!path.startsWith('/')) throw new Error(`a path from the door's root: ${JSON.stringify(path)}`)
      const o = door
      if (!o || closed || status.state === 'refused') return offline()
      try {
        return await call(o, path, init ?? {}, deps.token())
      } catch (err) {
        if (o.tls && isCertError(err)) refuseCert()
        throw err
      }
    },
    status: askStatus,
    state: () => ({ ...status }),
    payload: () => payload,
    view() {
      const own = deps.commit?.() ?? ''
      return {
        id: device.id,
        title: device.title,
        kind: device.link?.kind ?? null,
        link: { ...status },
        status: nodeStatus,
        sameCommit: own && nodeStatus?.commit ? own === nodeStatus.commit : null,
        payloadAt,
      }
    },
    onPayload(fn) {
      payloadFns.add(fn)
      return () => payloadFns.delete(fn)
    },
    onState(fn) {
      stateFns.add(fn)
      return () => stateFns.delete(fn)
    },
    onStatus(fn) {
      statusFns.add(fn)
      return () => statusFns.delete(fn)
    },
    reconnect(why, force = false) {
      if (closed) return
      if (!force && status.state === 'refused' && (status.reason === 'token' || status.reason === 'not-built')) return
      log(`${why}: trying again now`)
      attempt = 1
      cancelRetry()
      if (stream && !stream.drop) {
        stream.drop = 'again'
        stream.ac.abort()
      }
      void pipe.reset().then(kick)
    },
    killNow: () => pipe.killNow(),
    async close() {
      if (closed) return
      closed = true
      door = null
      cancelRetry()
      statusOff()
      clock.clearInterval(watch)
      if (stream && !stream.drop) {
        stream.drop = 'close'
        stream.ac.abort()
      }
      await pipe.close()
    },
  }
}
