// The hub's heart (#231): what each connection may do, in what order, and who is told what. A
// connection is `await_hello`, `await_auth`, then `authed`; before that it sees nothing, not even
// the roster. The hub holds no sockets of its own: server.ts hands it a Conn per socket, tests
// hand it plain objects. Time comes from the injected clock; logs carry ids and codes, never
// bodies.
import { randomBytes } from 'node:crypto'
import {
  authBytes,
  type ErrorCode,
  type Frame,
  isPeerId,
  joinBytes,
  parseFrame,
  type RosterPeer,
  TEAM_PROTOCOL,
  validName,
  verify,
} from '../../src/core/team.ts'
import type { HubDb, PeerRow } from './db.ts'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(h: unknown): void
}

type Handle = ReturnType<typeof setTimeout>

/** The computer's clock; its timers keep no process alive. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: h => clearTimeout(h as Handle),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: h => clearInterval(h as Handle),
}

/** A connection as the hub sees it. */
export interface Conn {
  send(text: string): void
  close(code: number, reason?: string): void
}

export interface ConnHandle {
  /** One text frame in; frames of a connection are handled in the order they came. */
  message(text: string): Promise<void>
  close(): void
}

export interface HubOptions {
  db: HubDb
  clock: Clock
  log: (msg: string) => void
}

export interface Hub {
  open(conn: Conn): ConnHandle
  /** Revokes a peer by id or by name, closes its connection at once; null when there is no active one. */
  revoke(ref: string): PeerRow | null
  online(peer: string): boolean
  stop(): void
}

/** How long a challenge, and a connection that has not authed, lives. */
export const CHALLENGE_LIVES_MS = 30_000

export const CLOSE_BAD_REQUEST = 4400
export const CLOSE_UNKNOWN = 4401
export const CLOSE_REVOKED = 4403
export const CLOSE_REPLACED = 4409

interface Session {
  conn: Conn
  peer: string
}

export function createHub(opts: HubOptions): Hub {
  const { db, clock, log } = opts
  const sessions = new Map<string, Session>()
  const handles = new Set<Conn>()

  const put = (conn: Conn, f: Frame) => conn.send(JSON.stringify(f))
  const fail = (conn: Conn, code: ErrorCode, message: string, closeWith?: number, id?: string) => {
    put(conn, { t: 'error', code, message, ...(id !== undefined && { id }) })
    if (closeWith !== undefined) conn.close(closeWith, code)
  }

  const roster = (): RosterPeer[] =>
    db
      .peers()
      .filter(p => p.status === 'active')
      .map(p => ({ peer: p.id, name: p.name, online: sessions.has(p.id), last_seen: p.last_seen_at }))

  const broadcastRoster = () => {
    const f: Frame = { t: 'roster', peers: roster() }
    for (const s of sessions.values()) put(s.conn, f)
  }

  const open: Hub['open'] = conn => {
    handles.add(conn)
    let state: 'await_hello' | 'await_auth' | 'authed' = 'await_hello'
    let peer = ''
    let nonce = ''
    let challengedAt = 0
    let closed = false
    let chain: Promise<void> = Promise.resolve()

    const deadline = clock.setTimeout(() => {
      if (state === 'authed') return
      fail(conn, 'bad_frame', 'no auth in time', CLOSE_BAD_REQUEST)
    }, CHALLENGE_LIVES_MS)

    const refuse = (code: ErrorCode, message: string, closeWith: number) => {
      log(`refused ${peer.slice(0, 8) || '-'}: ${code}`)
      fail(conn, code, message, closeWith)
    }

    const enter = (row: PeerRow) => {
      clock.clearTimeout(deadline)
      state = 'authed'
      const old = sessions.get(row.id)
      sessions.set(row.id, { conn, peer: row.id })
      if (old) {
        fail(old.conn, 'bad_frame', 'replaced by a newer connection', CLOSE_REPLACED)
      } else {
        db.presenceEvent(row.id, true, clock.now())
      }
      db.touchSeen(row.id, clock.now())
      put(conn, { t: 'welcome', peer: row.id, name: row.name, hub: db.hubId() })
      put(conn, { t: 'roster', peers: roster() })
      if (!old)
        for (const s of sessions.values())
          if (s.peer !== row.id) put(s.conn, { t: 'presence', peer: row.id, online: true, at: clock.now() })
      log(`online ${row.id.slice(0, 8)} ${row.name}`)
    }

    const challenged = (): boolean => {
      if (clock.now() - challengedAt <= CHALLENGE_LIVES_MS) return true
      refuse('bad_frame', 'the challenge has expired', CLOSE_BAD_REQUEST)
      return false
    }

    const handle = async (text: string) => {
      if (closed) return
      const f = parseFrame(text)
      if (!f) {
        if (state === 'authed') fail(conn, 'bad_frame', 'not a frame')
        else refuse('bad_frame', 'not a frame', CLOSE_BAD_REQUEST)
        return
      }
      if (state === 'await_hello') {
        if (f.t !== 'hello') return refuse('bad_frame', 'hello first', CLOSE_BAD_REQUEST)
        if (f.v !== TEAM_PROTOCOL) return refuse('version', `protocol ${TEAM_PROTOCOL} only`, CLOSE_BAD_REQUEST)
        if (!isPeerId(f.peer)) return refuse('bad_frame', 'peer is no key', CLOSE_BAD_REQUEST)
        peer = f.peer
        nonce = randomBytes(32).toString('base64url')
        challengedAt = clock.now()
        state = 'await_auth'
        put(conn, { t: 'challenge', hub: db.hubId(), nonce })
        return
      }
      if (state === 'await_auth') {
        if (f.t === 'auth') {
          if (!challenged()) return
          if (!(await verify(peer, authBytes({ hub: db.hubId(), nonce, peer }), f.sig)))
            return refuse('bad_sig', 'the signature does not verify', CLOSE_UNKNOWN)
          const row = db.peer(peer)
          if (!row) return refuse('unknown_peer', 'not a member; join with an invite', CLOSE_UNKNOWN)
          if (row.status === 'revoked') return refuse('revoked', 'this peer is revoked', CLOSE_REVOKED)
          if (closed) return
          return enter(row)
        }
        if (f.t === 'join') {
          if (!challenged()) return
          if (!validName(f.name)) return refuse('bad_frame', 'name must be 1..40 characters', CLOSE_BAD_REQUEST)
          if (!(await verify(peer, joinBytes({ hub: db.hubId(), invite: f.invite, name: f.name, nonce, peer }), f.sig)))
            return refuse('bad_sig', 'the signature does not verify', CLOSE_UNKNOWN)
          if (closed) return
          const now = clock.now()
          const r = db.join(f.invite, peer, f.name, now)
          if (!r.ok) {
            db.audit(now, peer, 'join_refused', { why: r.why })
            if (r.why === 'name_taken') return refuse('name_taken', 'that name is in use', CLOSE_BAD_REQUEST)
            if (r.why === 'known_peer')
              return db.peer(peer)?.status === 'revoked'
                ? refuse('revoked', 'this peer is revoked', CLOSE_REVOKED)
                : refuse('bad_frame', 'already a member; connect with auth', CLOSE_BAD_REQUEST)
            return refuse('invite_invalid', 'the invite is not valid', CLOSE_REVOKED)
          }
          db.audit(now, peer, 'join', { name: f.name })
          const row = db.peer(peer) as PeerRow
          enter(row)
          // Everyone else learns of the new member; the new one has its roster from enter().
          for (const s of sessions.values()) if (s.peer !== peer) put(s.conn, { t: 'roster', peers: roster() })
          return
        }
        return refuse('bad_frame', 'auth or join expected', CLOSE_BAD_REQUEST)
      }
      switch (f.t) {
        case 'ping':
          return put(conn, { t: 'pong' })
        case 'pong':
          return
        default:
          return fail(conn, 'bad_frame', `${f.t} is not for the hub`)
      }
    }

    return {
      message: text => {
        chain = chain.then(() => handle(text)).catch(e => log(`frame failed: ${e instanceof Error ? e.message : e}`))
        return chain
      },
      close: () => {
        if (closed) return
        closed = true
        handles.delete(conn)
        clock.clearTimeout(deadline)
        if (state !== 'authed') return
        const s = sessions.get(peer)
        if (!s || s.conn !== conn) return
        sessions.delete(peer)
        const at = clock.now()
        db.touchSeen(peer, at)
        db.presenceEvent(peer, false, at)
        for (const o of sessions.values()) put(o.conn, { t: 'presence', peer, online: false, at })
        log(`offline ${peer.slice(0, 8)}`)
      },
    }
  }

  return {
    open,
    revoke: ref => {
      const row = db.peer(ref) ?? db.activePeerByName(ref)
      if (!row || !db.revokePeer(row.id, clock.now())) return null
      db.audit(clock.now(), row.id, 'revoke', { name: row.name })
      const s = sessions.get(row.id)
      if (s) fail(s.conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED)
      broadcastRoster()
      log(`revoked ${row.id.slice(0, 8)} ${row.name}`)
      return db.peer(row.id)
    },
    online: peer => sessions.has(peer),
    stop: () => {
      for (const c of handles) c.close(1001, 'hub stopping')
    },
  }
}
