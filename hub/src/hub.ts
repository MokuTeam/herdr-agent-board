// The hub's heart (#231): what each connection may do, in what order, and who is told what. A
// connection is `await_hello`, `await_auth`, then `authed`; before that it sees nothing, not even
// the roster. The hub holds no sockets of its own: server.ts hands it a Conn per socket, tests
// hand it plain objects. Time comes from the injected clock; logs carry ids and codes, never
// bodies.
//
// Blobs (#371): a sender opens one for the peers it names, puts its bytes in chunks on its socket,
// and only then sends the messages that name it; each of those peers gets it in chunks and says
// when it is done. The hub keeps it once (blobs.ts), checks its size, the sender's quota and its
// SHA-256, and deletes it when every peer still a member is done, at its TTL, or an hour after its
// upload stopped. What it holds is sealed on the sender's board; no key to it ever reaches the hub.
import { createHash, randomBytes } from 'node:crypto'
import {
  ackBytes,
  authBytes,
  BLOB_CHUNK,
  BLOB_WINDOW,
  type BoxClaim,
  b64u,
  cleanCaps,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_QUOTA_BYTES,
  type Envelope,
  type ErrorCode,
  envelopeBytes,
  type Frame,
  isPeerId,
  joinBytes,
  MAX_MEMBERS,
  MAX_TTL_S,
  MIN_TTL_S,
  openEnvelope,
  parseFrame,
  type RosterPeer,
  TEAM_PROTOCOL,
  unb64u,
  validName,
  verify,
  verifyBox,
} from '../../src/core/team.ts'
import { usableBox } from '../../src/core/team-box.ts'
import { type BlobStore, memoryBlobs } from './blobs.ts'
import {
  type BlobRow,
  DEFAULT_KEEP_DAYS,
  type HubDb,
  type MessageRow,
  MIN_KEEP_DAYS,
  type PeerRow,
  type PruneCounts,
} from './db.ts'

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
  /** Where blobs are kept (#371); in memory when not given. */
  blobs?: BlobStore
  /** The largest file, and what one peer may hold at once, in bytes (#371). */
  maxFileBytes?: number
  quotaBytes?: number
}

export interface Hub {
  /** `from`: the address the connection came from, for the log only. */
  open(conn: Conn, from?: string): ConnHandle
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

/** An upload that got no chunk for this long is dropped, and its bytes leave the sender's quota (#371). */
export const STALE_UPLOAD_MS = 3_600_000

/** Blobs one peer may have on the hub at once, uploading or ready, whatever their size (#371). */
export const MAX_LIVE_BLOBS = 64

export const CLOSE_BAD_REQUEST = 4400
export const CLOSE_UNKNOWN = 4401
export const CLOSE_REVOKED = 4403
export const CLOSE_REPLACED = 4409

interface Session {
  conn: Conn
  peer: string
}

/** A box claim as the hub keeps it (#371): only one whose signature is the peer's; null otherwise. */
async function boxClaimOf(peer: string, box: BoxClaim | undefined): Promise<string | null> {
  // A signed key nothing can be sealed to (one of low order) is no box either.
  return box && (await verifyBox(peer, box)) && (await usableBox(box.key))
    ? JSON.stringify({ key: box.key, sig: box.sig })
    : null
}

export function createHub(opts: HubOptions): Hub {
  const { db, clock, log } = opts
  const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS
  if (!Number.isInteger(keepDays) || keepDays < MIN_KEEP_DAYS)
    throw new Error(`keep-days must be a whole number of ${MIN_KEEP_DAYS} or more, not ${keepDays}`)
  const sessions = new Map<string, Session>()
  const handles = new Set<Conn>()
  const blobs = opts.blobs ?? memoryBlobs()
  const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const quota = opts.quotaBytes ?? DEFAULT_QUOTA_BYTES
  const mb = (n: number): string => String(Math.round((n / 1048576) * 10) / 10)

  const put = (conn: Conn, f: Frame) => conn.send(JSON.stringify(f))
  const fail = (conn: Conn, code: ErrorCode, message: string, closeWith?: number, id?: string) => {
    put(conn, { t: 'error', code, message, ...(id !== undefined && { id }) })
    if (closeWith !== undefined) conn.close(closeWith, code)
  }

  const roster = (): RosterPeer[] =>
    db
      .peers()
      .filter(p => p.status === 'active')
      .map(p => {
        const caps = capsOf(p)
        const box = boxOf(p)
        return {
          peer: p.id,
          name: p.name,
          online: sessions.has(p.id),
          last_seen: p.last_seen_at,
          ...(caps && { caps }),
          ...(box && { box }),
        }
      })

  /** A peer's caps as its board last said them (#216), or undefined. */
  const capsOf = (p: PeerRow): string[] | undefined => {
    try {
      return cleanCaps(p.caps ? JSON.parse(p.caps) : undefined)
    } catch {
      return undefined
    }
  }

  /** A peer's box claim as its board last said it (#371), checked when it came; or undefined. */
  const boxOf = (p: PeerRow): BoxClaim | undefined => {
    try {
      return p.box ? (JSON.parse(p.box) as BoxClaim) : undefined
    } catch {
      return undefined
    }
  }

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
    // The signature is checked over the payload string as it came, and only then is it read (#217).
    // As a relay: `text` is held to its limits, the other body fields go on as signed (#216).
    const opened = await openEnvelope(f.env, peer, 'relay')
    if (!opened.ok) {
      log(`dropped from ${peer.slice(0, 8)}: ${opened.code}`)
      return fail(conn, opened.code, `envelope refused: ${opened.code}`, undefined, opened.id)
    }
    const { env, msg } = opened
    if (msg.to === peer) return fail(conn, 'bad_frame', 'a message to yourself', undefined, msg.id)
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, msg.id)
    const to = db.peer(msg.to)
    if (to?.status !== 'active') return fail(conn, 'not_member', 'the recipient is not a member', undefined, msg.id)
    const hash = createHash('sha256').update(envelopeBytes(env.payload)).digest('hex')
    const have = db.message(msg.id)
    if (have) {
      if (have.from_peer !== peer || have.body_hash !== hash)
        return fail(conn, 'dup_id', 'that id is taken', undefined, msg.id)
      put(conn, stateOf(have))
      return
    }
    // A message that names a file names a blob of its sender's, all there, for its recipient (#371):
    // a copy no board could fetch is refused here instead of being brought again and again.
    if (msg.body.file) {
      const blob = db.blob(msg.body.file.blob)
      if (!blob || blob.owner !== peer || blob.state !== 'ready' || !recipientsOf(blob).includes(msg.to))
        return fail(conn, 'no_blob', 'the file it names is not on the hub for that member', undefined, msg.id)
    }
    const now = clock.now()
    const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, msg.ttl_s))
    // The row keeps the envelope as it came: the payload string is stored and sent on as it is.
    const stored = JSON.stringify(env)
    db.insertMessage({
      id: msg.id,
      v: msg.v,
      from_peer: peer,
      to_peer: msg.to,
      kind: msg.kind,
      reply_to: msg.reply_to,
      created_at: now,
      expires_at: now + ttl * 1000,
      size: Buffer.byteLength(stored),
      body_hash: hash,
      payload: stored,
    })
    db.audit(now, peer, 'send', {
      id: msg.id,
      to: msg.to,
      size: Buffer.byteLength(stored),
      // The sender's own signed words, never the text (#216), nor a file's name (#371).
      ...(msg.body.thread && { thread: msg.body.thread.id }),
      ...(msg.body.via && { via: msg.body.via }),
      ...(msg.body.file && { file: msg.body.file.blob }),
    })
    const row = db.message(msg.id) as MessageRow
    notify(row)
    const s = sessions.get(msg.to)
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

  // ---- Blobs (#371)

  const recipientsOf = (r: BlobRow): string[] => JSON.parse(r.recipients) as string[]

  const dropBlob = (r: BlobRow, why: string) => {
    const now = clock.now()
    blobs.remove(r.id)
    db.goneBlob(r.id, now, why)
    db.audit(now, null, 'blob_gone', { id: r.id, why })
  }

  /** Deletes a blob every recipient still a member has fetched. */
  const doneWith = (r: BlobRow, fetched: string[]) => {
    if (r.state !== 'ready') return
    const waiting = recipientsOf(r).filter(p => db.peer(p)?.status === 'active' && !fetched.includes(p))
    if (!waiting.length) dropBlob(r, 'fetched')
  }

  const blobOpen = (conn: Conn, peer: string, f: Extract<Frame, { t: 'blob_open' }>) => {
    const no = (code: ErrorCode, message: string) => fail(conn, code, message, undefined, f.id)
    const have = db.blob(f.id)
    if (have) {
      if (have.owner !== peer || have.size !== f.size || have.hash !== f.hash)
        return no('dup_id', 'that blob id is taken')
      if (have.state === 'gone') return no('no_blob', 'that blob is gone')
      if (have.state === 'ready') return put(conn, { t: 'blob_ready', id: f.id })
      return put(conn, { t: 'blob_have', id: f.id, have: blobs.have(f.id) })
    }
    const now = clock.now()
    if (f.size < 1 || f.size > maxFile) {
      db.audit(now, peer, 'blob_refused', { why: 'too_big', size: f.size })
      return no('too_big', `a file is at most ${mb(maxFile)} MB on this hub`)
    }
    const to = [...new Set(f.to)]
    if (!to.length || to.length > MAX_MEMBERS || to.includes(peer))
      return no('bad_frame', `a blob is for 1 to ${MAX_MEMBERS} other members`)
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, f.id)
    if (!to.every(p => db.peer(p)?.status === 'active')) return no('not_member', 'a recipient is not a member')
    if (db.heldBytes(peer) + f.size > quota || db.liveBlobs(peer).length >= MAX_LIVE_BLOBS) {
      db.audit(now, peer, 'blob_refused', { why: 'quota', size: f.size })
      return no(
        'quota',
        `the hub keeps at most ${mb(quota)} MB of your files at a time; it frees them as members fetch them, or at their TTL`,
      )
    }
    const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, f.ttl_s))
    // A file left from a blob of this id that has no row (a crash between the two) goes first.
    blobs.remove(f.id)
    db.insertBlob({
      id: f.id,
      owner: peer,
      size: f.size,
      hash: f.hash,
      recipients: JSON.stringify(to),
      created_at: now,
      expires_at: now + ttl * 1000,
    })
    db.audit(now, peer, 'blob_open', { id: f.id, size: f.size, to: to.length })
    put(conn, { t: 'blob_have', id: f.id, have: 0 })
  }

  const blobPut = (conn: Conn, peer: string, f: Extract<Frame, { t: 'blob_put' }>) => {
    const no = (code: ErrorCode, message: string) => fail(conn, code, message, undefined, f.id)
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, f.id)
    const row = db.blob(f.id)
    if (!row || row.owner !== peer || row.state === 'gone') return no('no_blob', 'no such upload')
    if (row.state === 'ready') return put(conn, { t: 'blob_ready', id: f.id })
    const data = unb64u(f.data)
    if (!data?.length || data.length > BLOB_CHUNK) return no('bad_frame', 'a chunk is 1 to 32 KiB of base64url')
    const have = blobs.have(f.id)
    // Not where the bytes end (a chunk again, or one ahead of a lost one): the sender is told where.
    if (f.at !== have) return put(conn, { t: 'blob_have', id: f.id, have })
    if (have + data.length > row.size) {
      dropBlob(row, 'too_big')
      return no('too_big', 'more bytes than the blob was opened for')
    }
    const now = clock.now()
    blobs.append(f.id, data)
    db.touchBlob(f.id, now)
    const next = have + data.length
    if (next < row.size) return put(conn, { t: 'blob_have', id: f.id, have: next })
    if (blobs.hash(f.id) !== row.hash) {
      dropBlob(row, 'bad_hash')
      return no('bad_hash', 'the bytes do not match their hash')
    }
    db.readyBlob(f.id, now)
    db.audit(now, peer, 'blob_ready', { id: f.id })
    put(conn, { t: 'blob_ready', id: f.id })
  }

  const blobGet = (conn: Conn, peer: string, f: Extract<Frame, { t: 'blob_get' }>) => {
    const no = (code: ErrorCode, message: string) => fail(conn, code, message, undefined, f.id)
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, f.id)
    const row = db.blob(f.id)
    if (!row) return no('no_blob', 'no such blob')
    if (!recipientsOf(row).includes(peer)) return no('not_member', 'that blob is not for you')
    if (row.state === 'gone') return no('no_blob', 'that blob is gone')
    if (row.state !== 'ready') return no('no_blob', 'that blob is not all there yet')
    if (f.at >= row.size) return no('bad_frame', 'past the end of the blob')
    for (let i = 0, at = f.at; i < BLOB_WINDOW && at < row.size; i++, at += BLOB_CHUNK)
      put(conn, { t: 'blob_data', id: f.id, at, data: b64u(blobs.read(f.id, at, BLOB_CHUNK)) })
  }

  const blobDone = (conn: Conn, peer: string, f: Extract<Frame, { t: 'blob_done' }>) => {
    if (db.peer(peer)?.status !== 'active') return fail(conn, 'revoked', 'this peer is revoked', CLOSE_REVOKED, f.id)
    const row = db.blob(f.id)
    if (!row || !recipientsOf(row).includes(peer))
      return fail(conn, 'not_member', 'that blob is not for you', undefined, f.id)
    if (row.state !== 'ready') return
    const fetched = db.blobFetched(f.id, peer)
    db.audit(clock.now(), peer, 'blob_fetched', { id: f.id })
    doneWith(row, fetched)
  }

  /** What the hub holds that no row keeps, and ready rows whose bytes are not all there: gone, at start. */
  const tidyBlobs = () => {
    const live = new Map(db.liveBlobs().map(r => [r.id, r]))
    for (const id of blobs.ids()) if (!live.has(id)) blobs.remove(id)
    for (const r of live.values()) if (r.state === 'ready' && blobs.have(r.id) !== r.size) dropBlob(r, 'lost')
  }
  tidyBlobs()

  const sweepBlobs = (now: number) => {
    for (const r of db.dueBlobs(now, now - STALE_UPLOAD_MS)) dropBlob(r, r.expires_at < now ? 'expired' : 'stale')
    for (const r of db.liveBlobs()) doneWith(r, JSON.parse(r.fetched) as string[])
  }

  const sweep = (): number => {
    const now = clock.now()
    const gone = db.expireDue(now)
    for (const r of gone) {
      db.audit(now, null, 'expired', { id: r.id, from: r.from_peer, to: r.to_peer })
      notify(r)
    }
    sweepBlobs(now)
    return gone.length
  }
  const sweeper = clock.setInterval(sweep, SWEEP_MS)

  const prune = (): PruneCounts => {
    const now = clock.now()
    const counts = db.prune(now - keepDays * 86_400_000)
    db.checkpoint()
    if (counts.messages + counts.presence + counts.invites + counts.audit + (counts.blobs ?? 0) > 0) {
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

  const open: Hub['open'] = (conn, from) => {
    const fromWhere = from ? ` from ${from}` : ''
    handles.add(conn)
    let state: 'await_hello' | 'await_auth' | 'authed' = 'await_hello'
    let peer = ''
    let caps: string[] | undefined
    let box: BoxClaim | undefined
    /** The box claim as kept, once its signature verified (#371); null without one. */
    let boxJson: string | null = null
    let nonce = ''
    let challengedAt = 0
    let closed = false
    let chain: Promise<void> = Promise.resolve()

    const deadline = clock.setTimeout(() => {
      if (state === 'authed') return
      fail(conn, 'bad_frame', 'no auth in time', CLOSE_BAD_REQUEST)
    }, CHALLENGE_LIVES_MS)

    const refuse = (code: ErrorCode, message: string, closeWith: number) => {
      log(`refused ${peer.slice(0, 8) || '-'}: ${code}${fromWhere}`)
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
      // What the board said it understands goes to the others with its presence, or with a new
      // roster when it changed on a connection that replaced another (#216).
      const capsChanged = db.setCaps(row.id, caps ?? null)
      // Its box key goes the same way (#371); an older board says none, and has none in the roster.
      const boxChanged = db.setBox(row.id, boxJson)
      const said = boxJson ? (JSON.parse(boxJson) as BoxClaim) : undefined
      put(conn, { t: 'welcome', peer: row.id, name: row.name, hub: db.hubId(), files: { max: maxFile, quota } })
      put(conn, { t: 'roster', peers: roster() })
      flush({ conn, peer: row.id })
      if (!old)
        for (const s of sessions.values())
          if (s.peer !== row.id)
            put(s.conn, {
              t: 'presence',
              peer: row.id,
              online: true,
              at: clock.now(),
              ...(caps && { caps }),
              ...(said && { box: said }),
            })
      if (old && (capsChanged || boxChanged))
        for (const s of sessions.values()) if (s.peer !== row.id) put(s.conn, { t: 'roster', peers: roster() })
      log(`online ${row.id.slice(0, 8)} ${row.name}${fromWhere}`)
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
        caps = f.caps
        box = f.box
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
          boxJson = await boxClaimOf(peer, box)
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
          boxJson = await boxClaimOf(peer, box)
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
        case 'blob_open':
          return blobOpen(conn, peer, f)
        case 'blob_put':
          return blobPut(conn, peer, f)
        case 'blob_get':
          return blobGet(conn, peer, f)
        case 'blob_done':
          return blobDone(conn, peer, f)
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
      // Its blobs go (#371); and a blob that waited for it alone is done with.
      for (const b of db.liveBlobs(row.id)) dropBlob(b, 'revoked')
      for (const b of db.liveBlobs()) doneWith(b, JSON.parse(b.fetched) as string[])
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
