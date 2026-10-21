// A stand-in for wake's local API (GET /status, /alive, /sleeping, /awake; POST /wake, /sleep) on a port of
// the test's own: Bun.serve on port 0, so never wake's 12421 nor the web board's 12422. It records
// every request it takes. Switches: `slow` holds every request unanswered while it is on; `down()`
// stops listening (a connection is refused), `up()` listens on the same port again. Stopped once the
// test is over.
import { onTestFinished } from 'bun:test'

/** A request as the stand-in took it: its method, path and parsed body (null for none). */
export interface WakeRequest {
  method: string
  path: string
  body: unknown
}

export interface FakeWakeOptions {
  /** GET /sleeping's answer. */
  sleeping?: unknown[]
  /** GET /awake's answer; null: 404, as an older router answers. */
  awake?: unknown[] | null
  /** POST /wake's answer for the body's target; `{ ok: true }` without it. */
  wake?: (target: unknown) => unknown
  /** POST /sleep's answer for the body's target; `{ ok: true }` without it. */
  sleep?: (target: unknown) => unknown
  /**
   * The separate herdr-wake plugin's router: no GET /alive (404) and no Telegram state in /status.
   * Without it, the board's wake: /alive answers its pid, /status has Telegram's state (off).
   */
  oldRouter?: boolean
}

export interface FakeWake {
  url: string
  port: number
  /** Every request taken so far, in order. */
  requests(): WakeRequest[]
  sleeping: unknown[]
  awake: unknown[] | null
  /** While on, requests are taken and held unanswered. */
  slow: boolean
  /** Stops listening: a connection is refused. */
  down(): void
  /** Listens on the same port again. */
  up(): void
}

/** Ports the stand-in never takes: wake's and the web board's. */
const THEIRS = new Set([12421, 12422])

export async function fakeWake(o: FakeWakeOptions = {}): Promise<FakeWake> {
  const requests: WakeRequest[] = []
  let server: ReturnType<typeof Bun.serve> | null = null
  const fake: FakeWake = {
    url: '',
    port: 0,
    requests: () => [...requests],
    sleeping: o.sleeping ?? [],
    awake: o.awake === undefined ? [] : o.awake,
    slow: false,
    down() {
      void server?.stop(true)
      server = null
    },
    up() {
      server ??= listen(fake.port)
    },
  }
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  async function answer(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    const text = await req.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    requests.push({ method: req.method, path, body })
    while (fake.slow) await Bun.sleep(10)
    const target = body && typeof body === 'object' ? (body as { target?: unknown }).target : undefined
    if (req.method === 'GET' && path === '/status')
      return json({ pid: process.pid, sessions: {}, ...(!o.oldRouter && { telegram: { state: 'off' } }) })
    if (req.method === 'GET' && path === '/alive' && !o.oldRouter) return json({ pid: process.pid })
    if (req.method === 'GET' && path === '/sleeping') return json(fake.sleeping)
    if (req.method === 'GET' && path === '/awake')
      return fake.awake ? json(fake.awake) : new Response(null, { status: 404 })
    if (req.method === 'POST' && path === '/wake') return json(o.wake ? o.wake(target) : { ok: true })
    if (req.method === 'POST' && path === '/sleep') return json(o.sleep ? o.sleep(target) : { ok: true })
    return new Response(null, { status: 404 })
  }
  function listen(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, development: false, fetch: answer })
  }
  server = listen(0)
  fake.port = server.port ?? 0
  if (!fake.port || THEIRS.has(fake.port)) {
    fake.down()
    throw new Error(`fake wake took port ${fake.port}`)
  }
  fake.url = `http://127.0.0.1:${fake.port}`
  onTestFinished(() => {
    fake.slow = false
    fake.down()
  })
  return fake
}
