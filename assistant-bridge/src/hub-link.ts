// The bridge's one connection to the hub (#384, design 3.1): the board's protocol, the board's
// shape (src/services/team-hub.ts): hello, challenge, auth, welcome; a ping every PING_MS and the
// connection dropped after DEAD_MS without a word; backoff between tries; what the hub has not
// settled sent again after each welcome; every delivery acked once it is kept, a redelivery too.
// The link keeps nothing itself: the bridge's store does.

import {
  ackBytes,
  authBytes,
  type Envelope,
  type ErrorCode,
  type Frame,
  type KeyPair,
  type Message,
  openEnvelope,
  parseFrame,
  type RosterPeer,
  sign,
  TEAM_PROTOCOL,
} from '../../src/core/team.ts'
import { backoffMs } from '../../src/core/tunnel.ts'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(h: unknown): void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
}

export interface WsLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export const PING_MS = 30_000
export const DEAD_MS = 75_000
export const UP_RESETS_MS = 60_000
export const UNKNOWN_RETRY_MS = 60_000
const CLOSE_REVOKED = 4403
const CLOSE_UNKNOWN = 4401

export type LinkState = 'off' | 'connecting' | 'online' | 'reconnecting' | 'unknown' | 'revoked'

export interface LinkOptions {
  hub: string
  key: KeyPair
  caps: string[]
  version: string
  clock?: Clock
  random?: () => number
  socket?: (url: string) => WsLike
  log: (line: string) => void
  /** Each welcome: the bridge's roster name. */
  onWelcome: (name: string) => void
  onRoster: (peers: RosterPeer[]) => void
  onPresence: (f: Extract<Frame, { t: 'presence' }>) => void
  /** A message whose signature and shape passed; resolves once it is kept, and the link acks it then. */
  onMessage: (msg: Message) => Promise<void>
  onState: (f: Extract<Frame, { t: 'state' }>) => Promise<void> | void
  /** The hub refused a message of ours (an error that names it). */
  onRefused: (id: string, code: ErrorCode) => void
  /** What to send again after a welcome. */
  unsettled: () => Envelope[]
  onStateChange?: (s: LinkState) => void
}

export interface HubLink {
  start(): void
  stop(): void
  /** Sends a message now when online; false otherwise (it goes after the next welcome). */
  send(env: Envelope): boolean
  state(): LinkState
}

export function createHubLink(o: LinkOptions): HubLink {
  const clock = o.clock ?? realClock
  const random = o.random ?? Math.random
  const socket = o.socket ?? (url => new WebSocket(url) as unknown as WsLike)
  let ws: WsLike | null = null
  let gen = 0
  let authed = false
  let attempt = 0
  let lastRx = 0
  let state: LinkState = 'off'
  let retry: unknown
  let upTimer: unknown
  let pinger: unknown
  let running = false

  const setState = (s: LinkState): void => {
    if (s === state) return
    state = s
    o.onStateChange?.(s)
  }
  const frame = (f: Frame): void => {
    if (ws) ws.send(JSON.stringify(f))
  }
  const clearTimers = (): void => {
    if (retry !== undefined) clock.clearTimeout(retry)
    if (upTimer !== undefined) clock.clearTimeout(upTimer)
    if (pinger !== undefined) clock.clearInterval(pinger)
    retry = upTimer = pinger = undefined
  }
  function drop(code = 1000, reason?: string): void {
    gen++
    clearTimers()
    authed = false
    const w = ws
    ws = null
    if (w) {
      w.onopen = w.onmessage = w.onclose = w.onerror = null
      try {
        w.close(code, reason)
      } catch {}
    }
  }
  function again(fixed?: number, next: LinkState = 'reconnecting'): void {
    if (!running) return
    attempt++
    retry = clock.setTimeout(connect, fixed ?? backoffMs(attempt, random))
    setState(next)
  }

  function connect(): void {
    if (!running) return
    const mine = ++gen
    retry = undefined
    if (state !== 'unknown') setState(attempt > 0 ? 'reconnecting' : 'connecting')
    let w: WsLike
    try {
      w = socket(`${o.hub}/v1`)
    } catch (err) {
      o.log(`hub: ${err instanceof Error ? err.message : String(err)}`)
      again()
      return
    }
    ws = w
    w.onopen = () => {
      if (mine !== gen) return
      lastRx = clock.now()
      frame({ t: 'hello', v: TEAM_PROTOCOL, peer: o.key.pub, client: `assistant-bridge/${o.version}`, caps: o.caps })
    }
    w.onmessage = e => {
      if (mine !== gen || typeof e.data !== 'string') return
      lastRx = clock.now()
      const f = parseFrame(e.data)
      if (f) void handle(mine, f).catch(err => o.log(`hub: ${err instanceof Error ? err.message : String(err)}`))
    }
    w.onerror = () => {}
    w.onclose = e => {
      if (mine !== gen) return
      drop()
      if (e.code === CLOSE_REVOKED) {
        o.log('hub: this bridge was revoked by the hub')
        running = false
        setState('revoked')
        return
      }
      if (e.code === CLOSE_UNKNOWN) {
        o.log('hub: the hub does not know this key; run assistant-bridge join <invite>')
        again(UNKNOWN_RETRY_MS, 'unknown')
        return
      }
      again()
    }
  }

  async function handle(mine: number, f: Frame): Promise<void> {
    switch (f.t) {
      case 'challenge': {
        const sig = await sign(o.key.pkcs8, authBytes({ hub: f.hub, nonce: f.nonce, peer: o.key.pub }))
        if (mine === gen) frame({ t: 'auth', sig })
        return
      }
      case 'welcome':
        if (authed) return
        authed = true
        upTimer = clock.setTimeout(() => {
          attempt = 0
        }, UP_RESETS_MS)
        pinger = clock.setInterval(() => {
          if (clock.now() - lastRx >= DEAD_MS) {
            o.log('hub: the hub went silent; reconnecting')
            drop(4000, 'silent')
            again()
            return
          }
          frame({ t: 'ping' })
        }, PING_MS)
        setState('online')
        o.onWelcome(f.name)
        for (const env of o.unsettled()) frame({ t: 'send', env })
        return
      case 'roster':
        o.onRoster(f.peers)
        return
      case 'presence':
        o.onPresence(f)
        return
      case 'state':
        await o.onState(f)
        return
      case 'deliver': {
        if (!authed) return
        const opened = await openEnvelope(f.env)
        if (!opened.ok || opened.msg.to !== o.key.pub) {
          o.log(`hub: dropped a delivery (${opened.ok ? 'not for this bridge' : opened.code})`)
          return
        }
        await o.onMessage(opened.msg)
        if (mine !== gen) return
        const msg = opened.msg
        const ts = new Date(clock.now()).toISOString()
        const sig = await sign(o.key.pkcs8, ackBytes({ by: o.key.pub, id: msg.id, to: msg.from, ts }))
        frame({ t: 'ack', id: msg.id, ts, sig })
        return
      }
      case 'error':
        o.log(`hub: the hub says ${f.code}${f.id ? ` for ${f.id}` : ''}`)
        if (f.id) o.onRefused(f.id, f.code)
        return
      case 'ping':
        frame({ t: 'pong' })
        return
      default:
        return
    }
  }

  return {
    start: () => {
      if (running) return
      running = true
      attempt = 0
      connect()
    },
    stop: () => {
      running = false
      drop()
      setState('off')
    },
    send: env => {
      if (!authed || !ws) return false
      frame({ t: 'send', env })
      return true
    },
    state: () => state,
  }
}
