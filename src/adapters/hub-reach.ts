// The way to the team hub, step by step (#356): the name's addresses, a TCP connection to one
// address of each family, and the TLS handshake for wss. `board team join` asks it only when its
// WebSocket did not open, to say what got through; core/team-reach.ts words the answer.
import { lookup } from 'node:dns/promises'
import { isIP, connect as tcpConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Reach, ReachAddress, ReachStep } from '../core/team-reach.ts'

/** How long one step may take before it counts as no answer. */
export const STEP_MS = 4000

const codeOf = (err: unknown): string =>
  err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : err instanceof Error
      ? err.message
      : String(err)

/** Runs `fn` with a deadline; what does not settle by then is `timeout`. */
async function timed<T>(ms: number, fn: () => Promise<T>): Promise<ReachStep & { value?: T }> {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms)
      }),
    ])
    return { ok: true, ms: Date.now() - start, value }
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: codeOf(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** A TCP connection that opens and closes again; the socket is destroyed whatever happens. */
function openTcp(a: ReachAddress, port: number, ms: number): Promise<ReachStep> {
  let socket: ReturnType<typeof tcpConnect> | undefined
  return timed(
    ms,
    () =>
      new Promise<void>((resolve, reject) => {
        socket = tcpConnect({ host: a.address, port, family: a.family })
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      }),
  ).finally(() => socket?.destroy())
}

/** A TLS handshake to `address` for the name `host` (its certificate is checked as the WebSocket would). */
function handshake(address: string, host: string, port: number, ms: number): Promise<ReachStep> {
  let socket: ReturnType<typeof tlsConnect> | undefined
  return timed(
    ms,
    () =>
      new Promise<void>((resolve, reject) => {
        socket = tlsConnect({
          host: address,
          port,
          ...(isIP(host) ? {} : { servername: host }),
          ALPNProtocols: ['http/1.1'],
        })
        socket.once('secureConnect', () => resolve())
        socket.once('error', reject)
      }),
  ).finally(() => socket?.destroy())
}

/** Each step of the way to `hub` (a ws:// or wss:// address), none longer than `stepMs`. */
export async function probeHub(hub: string, stepMs = STEP_MS): Promise<Reach> {
  const url = new URL(hub)
  const secure = url.protocol === 'wss:'
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const port = Number(url.port) || (secure ? 443 : 80)
  const family = isIP(host)
  const found = family
    ? { ok: true, ms: 0, value: [{ address: host, family: family as 4 | 6 }] }
    : await timed(stepMs, async () =>
        (await lookup(host, { all: true, verbatim: true })).map(a => ({
          address: a.address,
          family: a.family as 4 | 6,
        })),
      )
  const addresses = found.value ?? []
  const picks = [addresses.find(a => a.family === 6), addresses.find(a => a.family === 4)].filter(
    (a): a is ReachAddress => a !== undefined,
  )
  // The lookup's order first: it is the order a client tries them in.
  picks.sort((a, b) => addresses.indexOf(a) - addresses.indexOf(b))
  const tcp = await Promise.all(picks.map(async a => ({ ...a, ...(await openTcp(a, port, stepMs)) })))
  const first = tcp.find(s => s.ok)
  const tls =
    secure && first ? { address: first.address, ...(await handshake(first.address, host, port, stepMs)) } : null
  const { value: _v, ...dnsStep } = found
  return { host, port, secure, stepMs, literal: family !== 0, dns: { ...dnsStep, addresses }, tcp, tls }
}
