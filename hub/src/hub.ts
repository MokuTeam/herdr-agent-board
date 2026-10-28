// The hub's heart (#231): what each connection may do, in what order, and who is told what. A
// connection is `await_hello`, `await_auth`, then `authed`; before that it sees nothing, not even
// the roster. The hub holds no sockets of its own: server.ts hands it a Conn per socket, tests
// hand it plain objects. Time comes from the injected clock; logs carry ids and codes, never
// bodies.
import { createHash, randomBytes } from 'node:crypto'
import {
  ackBytes,
  authBytes,
  checkEnvelope,
  type Envelope,
  type ErrorCode,
  envelopeBytes,
  type Frame,
  isPeerId,
  joinBytes,
  MAX_TTL_S,
  MIN_TTL_S,
  parseFrame,
  type RosterPeer,
  TEAM_PROTOCOL,
  validName,
  verify,
} from '../../src/core/team.ts'
import { DEFAULT_KEEP_DAYS, type HubDb, type MessageRow, MIN_KEEP_DAYS, type PeerRow, type PruneCounts } from './db.ts'

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
  /** How many days finished rows are kept (default 90, at least 8). */
  keepDays?: number
}

export interface Hub {
  open(conn: Conn): ConnHandle
  /** Revokes a peer by id or by name, closes its connection at once; null when there is no active one. */
  revoke(ref: string): PeerRow | null
  online(peer: string): boolean
  /** Expires what is due now and tells the senders; the sweeper calls it every SWEEP_MS. */
  sweep(): number
  /** Deletes what is older than keep-days, audits the counts when anything went; the sweeper calls it hourly. */
  prune(): PruneCounts
  stop(): void
}

/** How long a challenge, and a connection that has not authed, lives. */
export const CHALLENGE_LIVES_MS = 30_000

/** How often due messages are expired. */
export const SWEEP_MS = 60_000

/** How often rows older than keep-days are deleted. */
export const PRUNE_MS = 3_600_000

export const CLOSE_BAD_REQUEST = 4400
export const CLOSE_UNKNOWN = 4401
export const CLOSE_REVOKED = 4403
export const CLOSE_REPLACED = 4409

interface Session {
  conn: Conn
  peer: string
}

const isRecordId = (v: unknown): string | undefined =>
  typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string'
    ? (v as { id: string }).id
    : undefined

export function createHub(opts: HubOptions): Hub {
  const { db, clock, log } = opts
  const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS
  if (!Number.isInteger(keepDays) || keepDays < MIN_KEEP_DAYS)
    throw new Error(`keep-days must be a whole number of ${MIN_KEEP_DAYS} or more, not ${keepDays}`)
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

  const stateOf = (r: MessageRow): Frame => {
    const at =
      r.state === 'acked'
        ? r.acked_at
        : r.state === 'delivered'
          ? r.delivered_at
          : r.state === 'expired'
            ? r.expires_at
            : r.created_at
    const f: Frame = { t: 'state', id: r.id, state: r.state, at: at ?? r.created_at }
    if (r.state === 'acked' && r.ack_json) f.ack = JSON.parse(r.ack_json)
    return f
  }

  /** Tells the sender of a message its state, now if it is connected, else on its next welcome. */
  const notify = (r: MessageRow) => {
    const s = sessions.get(r.from_peer)
    if (!s) return
    put(s.conn, stateOf(r))
    db.setNotified(r.id, r.state)
  }

  const deliver = (s: Session, r: MessageRow) => {
    if (r.payload === null || db.peer(r.from_peer)?.status !== 'active') return
    put(s.conn, { t: 'deliver', env: JSON.parse(r.payload) as Envelope })
    if (r.state !== 'queued') return
    db.markDelivered(r.id, clock.now())
    const now = db.message(r.id)
    if (now) notify(now)
  }

  /** What waited for a peer that just came in: its deliveries, then what its senders were not told. */
  const flush = (s: Session) => {
    for (const r of db.pendingFor(s.peer, clock.now())) deliver(s, r)
    for (const r of db.unnotified(s.peer)) notify(r)
  }

  const send = async (conn: Conn, peer: string, f: { env: unknown }) => {
    const idOf = isRecordId(f.env)
    const checked = checkEnvelope(f.env)
    if (!checked.ok) {
      log(`dropped from ${peer.slice(0, 8)}: ${checked.code}`)
      return fail(conn, checked.code, `envelope refused: ${checked.code}`, undefined, idOf)
    }
    const env = checked.env
    if (env.from !== peer) return fail(conn, 'bad_sig', 'from is not the connected peer', undefined, env.id)
    if (env.to === peer) return fail(conn, 'bad_frame', 'a message to yourself', undefined, env.id)
    const bytes = envelopeBytes(env)
    if (!(await verify(env.from, bytes, env.sig)))
      return fail(conn, 'bad_sig', 'the signature does not verify', undefined, env.id)
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, env.id)
    const to = db.peer(env.to)
    if (to?.status !== 'active') return fail(conn, 'not_member', 'the recipient is not a member', undefined, env.id)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const have = db.message(env.id)
    if (have) {
      if (have.from_peer !== peer || have.body_hash !== hash)
        return fail(conn, 'dup_id', 'that id is taken', undefined, env.id)
      put(conn, stateOf(have))
      return
    }
    const now = clock.now()
    const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, env.ttl_s))
    const payload = JSON.stringify(env)
    db.insertMessage({
      id: env.id,
      v: env.v,
      from_peer: peer,
      to_peer: env.to,
      kind: env.kind,
      reply_to: env.reply_to,
      created_at: now,
      expires_at: now + ttl * 1000,
      size: Buffer.byteLength(payload),
      body_hash: hash,
      payload,
    })
    db.audit(now, peer, 'send', { id: env.id, to: env.to, size: Buffer.byteLength(payload) })
    const row = db.message(env.id) as MessageRow
    notify(row)
    const s = sessions.get(env.to)
    if (s) deliver(s, row)
  }

  const ack = async (conn: Conn, peer: string, f: { id: string; ts: string; sig: string }) => {
    const row = db.message(f.id)
    if (!row || row.to_peer !== peer) return fail(conn, 'bad_frame', 'no such message for you', undefined, f.id)
    if (row.state === 'acked') return
    if (row.state === 'expired' || Number.isNaN(Date.parse(f.ts)))
      return fail(conn, 'bad_frame', 'cannot ack that', undefined, f.id)
    if (!(await verify(peer, ackBytes({ by: peer, id: f.id, to: row.from_peer, ts: f.ts }), f.sig)))
      return fail(conn, 'bad_sig', 'the signature does not verify', undefined, f.id)
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, f.id)
    const now = clock.now()
    db.markAcked(f.id, now, JSON.stringify({ by: peer, ts: f.ts, sig: f.sig }))
    db.audit(now, peer, 'ack', { id: f.id, from: row.from_peer })
    const done = db.message(f.id)
    if (done) notify(done)
  }

  const sweep = (): number => {
    const now = clock.now()
    const gone = db.expireDue(now)
    for (const r of gone) {
      db.audit(now, null, 'expired', { id: r.id, from: r.from_peer, to: r.to_peer })
      notify(r)
    }
    return gone.length
  }
  const sweeper = clock.setInterval(sweep, SWEEP_MS)

  const prune = (): PruneCounts => {
    const now = clock.now()
    const counts = db.prune(now - keepDays * 86_400_000)
    if (counts.messages + counts.presence + counts.invites + counts.audit > 0) {
      db.audit(now, null, 'prune', { ...counts, keep_days: keepDays })
      log(
        `pruned ${counts.messages} messages, ${counts.presence} presence events, ${counts.invites} invites, ${counts.audit} audit rows`,
      )
    }
    return counts
  }
  const pruner = clock.setInterval(() => {
    try {
      prune()
    } catch (e) {
      log(`prune failed: ${e instanceof Error ? e.message : e}`)
    }
  }, PRUNE_MS)

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
      flush({ conn, peer: row.id })
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
        case 'send':
          return send(conn, peer, f)
        case 'ack':
          return ack(conn, peer, f)
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
      // What it still had in the queue is not delivered any more, and nobody is told anything new
      // of it (the sender cannot connect again; the recipient never sees these).
      for (const m of db.expireFrom(row.id))
        db.audit(clock.now(), row.id, 'expired', { id: m.id, to: m.to_peer, why: 'sender_revoked' })
      const s = sessions.get(row.id)
      if (s) fail(s.conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED)
      broadcastRoster()
      log(`revoked ${row.id.slice(0, 8)} ${row.name}`)
      return db.peer(row.id)
    },
    online: peer => sessions.has(peer),
    sweep,
    prune,
    stop: () => {
      clock.clearInterval(sweeper)
      clock.clearInterval(pruner)
      for (const c of handles) c.close(1001, 'hub stopping')
    },
  }
}
