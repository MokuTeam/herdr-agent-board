// `board team join`'s talk with the hub (#231, #356). One try is the protocol's join: hello, the
// hub's challenge, the signed join, welcome. When a try gets no answer it is made again, a few
// times, as long as the way to the hub is open (adapters/hub-reach.ts says what got through when
// the connection did not even open). A join that went out and was not answered may have reached
// the hub, which then took the invite: the next try's join is refused (the invite is used), so
// that try logs in with the same key instead, and a welcome means the board is a member after all.

import { authBytes, joinBytes, type KeyPair, parseFrame, sign, TEAM_PROTOCOL } from '../core/team.ts'
import { describeReach, type Reach, wayClosed } from '../core/team-reach.ts'

/** How long one try may wait for the hub's welcome. BOARD_TEAM_JOIN_MS shortens it (tests). */
export const TRY_MS = 10_000
export const TRIES = 3

type Mode = 'join' | 'auth'

/** How far a try got: the connection did not open, the hub said nothing, or the request went out unanswered. */
export type Stage = 'connect' | 'hello' | 'answer'

export type Try =
  | { ok: true }
  | { ok: false; stage: Stage; error: string; sent: boolean; refused?: { code: string; message?: string } }

export interface JoinRequest {
  hub: string
  invite: string
  name: string
  key: KeyPair
  /** The key was this board's before this join: the hub may know it already. */
  keyWasSaved: boolean
}

export interface JoinDeps {
  tryMs: number
  tries: number
  probe: (hub: string) => Promise<Reach>
  /** A line for the person while it tries again. */
  say: (line: string) => void
  pause: (ms: number) => Promise<void>
  /**
   * Runs before each join goes out: from then on the hub may take the invite for this key, so the
   * key must outlive this process (an interrupt between tries included).
   */
  beforeJoin?: () => Promise<void>
  /** One try (tests); tryOnce otherwise. */
  attempt?: typeof tryOnce
}

export type JoinOutcome =
  | { ok: true; via: Mode }
  | {
      ok: false
      error: string
      /**
       * A join went out and no answer came: the hub may have taken it, so the key is worth keeping.
       * False: the hub refused, or said it does not know the key, or no join went out.
       */
      unanswered: boolean
    }

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`

/** One try: `join` with the invite, or `auth` with the key alone. `beforeJoin` runs before a join goes out. */
export function tryOnce(r: JoinRequest, mode: Mode, ms: number, beforeJoin?: () => Promise<void>): Promise<Try> {
  return new Promise(resolve => {
    let ws: WebSocket | undefined
    let stage: Stage = 'connect'
    let sent = false
    let done = false
    const finish = (t: Try): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {}
      resolve(t)
    }
    const fail = (error: string, refused?: { code: string; message?: string }): void =>
      finish({ ok: false, stage, error, sent, ...(refused && { refused }) })
    const silent = (): string =>
      stage === 'connect'
        ? `the connection did not open in ${seconds(ms)}`
        : sent
          ? `the hub got the ${mode} but did not answer in ${seconds(ms)}`
          : `the connection opened but the hub did not answer the hello in ${seconds(ms)}`
    const timer = setTimeout(() => fail(silent()), ms)
    try {
      ws = new WebSocket(`${r.hub}/v1`)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    ws.onerror = e => {
      const said = e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : ''
      fail(stage === 'connect' ? `the connection failed${said ? ` (${said})` : ''}` : 'the connection broke')
    }
    ws.onclose = e =>
      fail(
        stage === 'connect'
          ? `the connection closed before it opened (${e.code})`
          : sent
            ? `the connection closed after the ${mode} went out, with no answer (${e.code})`
            : `the hub closed the connection before it answered (${e.code})`,
      )
    ws.onopen = () => {
      stage = 'hello'
      ws?.send(JSON.stringify({ t: 'hello', v: TEAM_PROTOCOL, peer: r.key.pub, client: 'agent-board/cli' }))
    }
    ws.onmessage = e => {
      const f = parseFrame(String(e.data))
      if (!f) return
      if (f.t === 'challenge') {
        stage = 'answer'
        const bytes =
          mode === 'join'
            ? joinBytes({ hub: f.hub, invite: r.invite, name: r.name, nonce: f.nonce, peer: r.key.pub })
            : authBytes({ hub: f.hub, nonce: f.nonce, peer: r.key.pub })
        void (async () => {
          const sig = await sign(r.key.pkcs8, bytes)
          if (mode === 'join') await beforeJoin?.()
          if (done) return
          ws?.send(
            JSON.stringify(mode === 'join' ? { t: 'join', invite: r.invite, name: r.name, sig } : { t: 'auth', sig }),
          )
          sent = true
        })().catch(err => fail(`the ${mode} did not go out: ${err instanceof Error ? err.message : String(err)}`))
      } else if (f.t === 'welcome') finish({ ok: true })
      else if (f.t === 'error')
        fail(`the hub refused: ${f.code}${f.message ? ` (${f.message})` : ''}`, {
          code: f.code,
          ...(f.message && { message: f.message }),
        })
    }
  })
}

/** A refusal that a join which reached the hub earlier would get: the invite is used, or the key is a member. */
const takenAlready = (refused: { code: string; message?: string }): boolean =>
  refused.code === 'invite_invalid' || (refused.code === 'bad_frame' && /already a member/.test(refused.message ?? ''))

/**
 * Joins the hub, trying again while the way may be open; says what got through when it gives up.
 * A join refused because the invite is used or the key is a member, after a join of this run went
 * unanswered or with a key the board had before, logs in with the key: a welcome is a member, the
 * hub not knowing the key settles that the join never landed.
 */
export async function joinHub(r: JoinRequest, d: JoinDeps): Promise<JoinOutcome> {
  const attempt = d.attempt ?? tryOnce
  let unanswered = false
  for (let n = 1; ; n++) {
    const t = await attempt(r, 'join', d.tryMs, d.beforeJoin)
    if (t.ok) return { ok: true, via: 'join' }
    if (t.refused) {
      if ((unanswered || r.keyWasSaved) && takenAlready(t.refused)) {
        const again = await attempt(r, 'auth', d.tryMs)
        if (again.ok) return { ok: true, via: 'auth' }
        // The hub answered the login: it does not know the key (the join never landed) or says why not.
        if (again.refused)
          return { ok: false, error: again.refused.code === 'unknown_peer' ? t.error : again.error, unanswered: false }
      }
      return { ok: false, error: t.error, unanswered }
    }
    if (t.sent) unanswered = true
    let way = ''
    if (t.stage === 'connect') {
      const reach = await d.probe(r.hub)
      way = describeReach(reach)
      if (wayClosed(reach))
        return { ok: false, error: `cannot reach the hub at ${r.hub}: ${t.error} · ${way}`, unanswered }
    }
    const said = `${t.error}${way ? ` · ${way}` : ''}`
    if (n >= d.tries)
      return { ok: false, error: `the hub at ${r.hub} did not answer in ${d.tries} tries: ${said}`, unanswered }
    d.say(`try ${n} of ${d.tries}: ${said}; trying again`)
    await d.pause(n * 1000)
  }
}
