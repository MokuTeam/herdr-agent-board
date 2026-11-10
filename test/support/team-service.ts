// The board's team service against a socket the test plays the hub with (#231): a fake WebSocket,
// a handshake from the hub's side, and a service in an isolated home with a clock the test moves.
import { expect } from 'bun:test'
import { authBytes, type Frame, parseFrame, verify } from '../../src/core/team.ts'
import { createTeam, type TeamService, type WsLike } from '../../src/services/team-hub.ts'
import { fakeClock } from '../hub/harness.ts'
import { isolatedHome } from './env.ts'

export class FakeWs implements WsLike {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  sent: Frame[] = []
  closed: number | null = null
  constructor(readonly url: string) {}
  send(text: string): void {
    const f = parseFrame(text)
    if (f) this.sent.push(f)
  }
  close(code = 1000): void {
    this.closed = code
  }
  open(): void {
    this.onopen?.()
  }
  recv(f: unknown): void {
    this.onmessage?.({ data: typeof f === 'string' ? f : JSON.stringify(f) })
  }
  hangUp(code: number): void {
    this.onclose?.({ code })
  }
  of<T extends Frame['t']>(t: T): Array<Extract<Frame, { t: T }>> {
    return this.sent.filter((f): f is Extract<Frame, { t: T }> => f.t === t)
  }
}

export async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise(r => setTimeout(r, 4))
  }
}
export const settle = () => new Promise(r => setTimeout(r, 40))

export const HUB = 'ws://127.0.0.1:7443'
let live: TeamService[] = []
/** Stops every service a test made. */
export function stopAll(): void {
  for (const t of live) t.stop()
  live = []
}

export function setup(...given: [unknown?]) {
  const team = given.length ? given[0] : { hub: HUB, name: 'me' }
  isolatedHome()
  const cfg: { team: unknown } = { team }
  const clock = fakeClock()
  const sockets: FakeWs[] = []
  const logs: string[] = []
  let changes = 0
  const svc = createTeam({
    cfg,
    clock,
    log: l => logs.push(l),
    onChange: () => void changes++,
    random: () => 0.5,
    socket: url => {
      const w = new FakeWs(url)
      sockets.push(w)
      return w
    },
  })
  live.push(svc)
  return { svc, cfg, clock, sockets, logs, changes: () => changes }
}

export type Setup = ReturnType<typeof setup>

/** The hub's side of a handshake on the newest socket, ending with welcome and a roster. */
export async function handshake(s: Setup, roster: Array<{ peer: string; name: string }> = [], n = 1) {
  await until(() => s.sockets.length >= n, 'a socket')
  const ws = s.sockets[n - 1] as FakeWs
  ws.open()
  expect(ws.of('hello')).toHaveLength(1)
  const hello = ws.of('hello')[0]
  ws.recv({ t: 'challenge', hub: 'hub-1', nonce: 'N'.repeat(43) })
  await until(() => ws.of('auth').length === 1, 'an auth')
  const auth = ws.of('auth')[0]
  expect(
    await verify(
      hello?.peer ?? '',
      authBytes({ hub: 'hub-1', nonce: 'N'.repeat(43), peer: hello?.peer ?? '' }),
      auth?.sig ?? '',
    ),
  ).toBe(true)
  ws.recv({ t: 'welcome', peer: hello?.peer, name: 'me', hub: 'hub-1' })
  ws.recv({ t: 'roster', peers: roster.map(p => ({ ...p, online: true, last_seen: null })) })
  await until(() => s.svc.view()?.state === 'online' && (s.svc.view()?.roster.length ?? 0) === roster.length, 'online')
  return { ws, me: hello?.peer ?? '' }
}
