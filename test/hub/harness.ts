// A hub in the test's process (#231): the real server on port 0, an in-memory store, a clock the
// test moves, and clients that speak the wire protocol over the global WebSocket.
import assert from 'node:assert/strict'
import { type HubDb, openDb } from '../../hub/src/db.ts'
import { type Clock, createHub, type Hub } from '../../hub/src/hub.ts'
import { type HubServer, startServer } from '../../hub/src/server.ts'
import {
  ackBytes,
  authBytes,
  type Envelope,
  envelopeBytes,
  type Frame,
  generateKey,
  joinBytes,
  type KeyPair,
  parseFrame,
  sign,
} from '../../src/core/team.ts'

export interface FakeClock extends Clock {
  tick(ms: number): void
  set(t: number): void
  timers(): number
}

export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let t = start
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  const fire = () => {
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= t).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) return
      const [id, x] = due
      if (x.every) x.at += x.every
      else timers.delete(id)
      x.fn()
    }
  }
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(next, { at: t + ms, fn })
      return next++
    },
    clearTimeout: h => void timers.delete(h as number),
    setInterval: (fn, ms) => {
      timers.set(next, { at: t + ms, fn, every: ms })
      return next++
    },
    clearInterval: h => void timers.delete(h as number),
    tick: ms => {
      t += ms
      fire()
    },
    set: v => {
      t = v
      fire()
    },
    timers: () => timers.size,
  }
}

export class Client {
  frames: Frame[] = []
  closed: Promise<{ code: number }>
  private waiters: Array<() => void> = []
  private ws: WebSocket
  ready: Promise<void>

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('socket error'))
    })
    this.closed = new Promise(res => {
      this.ws.onclose = e => res({ code: e.code })
    })
    this.ws.onmessage = e => {
      const f = parseFrame(String(e.data))
      if (f) this.frames.push(f)
      for (const w of this.waiters.splice(0)) w()
    }
  }

  send(f: unknown): void {
    this.ws.send(typeof f === 'string' ? f : JSON.stringify(f))
  }

  close(): void {
    this.ws.close()
  }

  /** The next frame of type `t` not yet taken, waiting for it. */
  async take<T extends Frame['t']>(t: T, ms = 2000): Promise<Extract<Frame, { t: T }>> {
    const deadline = Date.now() + ms
    for (;;) {
      const i = this.frames.findIndex(f => f.t === t)
      if (i >= 0) return this.frames.splice(i, 1)[0] as Extract<Frame, { t: T }>
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ${t} frame; have ${this.frames.map(f => f.t).join(',') || 'none'}`)
      await new Promise<void>(res => {
        this.waiters.push(res)
        setTimeout(res, left)
      })
    }
  }

  /** Lets what is in flight arrive, then says what was received. */
  async settle(ms = 60): Promise<Frame[]> {
    await new Promise(r => setTimeout(r, ms))
    return this.frames
  }
}

export interface Harness {
  db: HubDb
  hub: Hub
  clock: FakeClock
  server: HubServer
  logs: string[]
  url: string
  hubId: string
  clients: Client[]
  invite(ttlMs?: number): string
  connect(): Promise<Client>
  /** hello, then auth with the key; the client is returned after welcome. */
  login(key: KeyPair): Promise<Client>
  join(key: KeyPair, name: string, invite?: string): Promise<Client>
  /** A hello, a challenge and nothing else yet. */
  hello(key: KeyPair): Promise<{ c: Client; nonce: string }>
  stop(): void
}

export async function startHarness(): Promise<Harness> {
  const db = openDb(':memory:')
  const clock = fakeClock()
  const logs: string[] = []
  const hub = createHub({ db, clock, log: m => logs.push(m) })
  const server = startServer({ hub, hostname: '127.0.0.1', port: 0 })
  const url = `ws://127.0.0.1:${server.port}/v1`
  const clients: Client[] = []
  const hubId = db.hubId()
  const h: Harness = {
    db,
    hub,
    clock,
    server,
    logs,
    url,
    hubId,
    clients,
    invite: (ttl = 3_600_000) => db.createInvite(clock.now(), ttl, null).code,
    connect: async () => {
      const c = new Client(url)
      clients.push(c)
      await c.ready
      return c
    },
    hello: async key => {
      const c = await h.connect()
      c.send({ t: 'hello', v: 1, peer: key.pub, client: 'test/0' })
      const ch = await c.take('challenge')
      assert.equal(ch.hub, hubId)
      return { c, nonce: ch.nonce }
    },
    login: async key => {
      const { c, nonce } = await h.hello(key)
      c.send({ t: 'auth', sig: await sign(key.pkcs8, authBytes({ hub: hubId, nonce, peer: key.pub })) })
      await c.take('welcome')
      return c
    },
    join: async (key, name, invite = h.invite()) => {
      const { c, nonce } = await h.hello(key)
      const sig = await sign(key.pkcs8, joinBytes({ hub: hubId, invite, name, nonce, peer: key.pub }))
      c.send({ t: 'join', invite, name, sig })
      await c.take('welcome')
      return c
    },
    stop: () => {
      for (const c of clients) c.close()
      hub.stop()
      server.stop()
      db.close()
    },
  }
  return h
}

export const keys = (n: number): Promise<KeyPair[]> => Promise.all(Array.from({ length: n }, generateKey))

let counter = 0
/** A signed question from `from` to `to`. */
export async function question(
  from: KeyPair,
  to: string,
  text: string,
  over: Partial<Envelope> = {},
  ts?: string,
): Promise<Envelope> {
  const env = {
    v: 1,
    id: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    from: from.pub,
    to,
    kind: 'question' as const,
    reply_to: null,
    ts: ts ?? '2026-01-02T03:04:05.000Z',
    ttl_s: 86_400,
    body: { text },
    ...over,
  }
  return { ...env, sig: await sign(from.pkcs8, envelopeBytes(env)) }
}

export async function ackOf(
  by: KeyPair,
  env: Envelope,
  ts = '2026-01-02T03:05:00.000Z',
): Promise<{ t: 'ack'; id: string; ts: string; sig: string }> {
  return { t: 'ack', id: env.id, ts, sig: await sign(by.pkcs8, ackBytes({ by: by.pub, id: env.id, to: env.from, ts })) }
}
