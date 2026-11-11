// The hub's store (#231): one SQLite file in the hub's directory, WAL, with a schema version in
// `meta`. Peers, invites, messages, presence events and an audit log whose rows are chained by
// hash. Nothing here reads a clock: every write is told the time, so tests keep their own.
// Bodies live only in message.payload, and only until a message is acked or expired. Blobs
// (#371) live in files of their own (blobs.ts); their rows here hold ids, sizes and peers.
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson } from '../../src/core/team.ts'

export type PeerStatus = 'active' | 'revoked'
export interface PeerRow {
  id: string
  name: string
  status: PeerStatus
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
  invite_id: string | null
  /** What the peer's board said it understands, as JSON (#216); null before it said anything. */
  caps: string | null
  /** The peer's box claim as JSON (#371), verified by the hub when it came; null without one. */
  box: string | null
}

export type BlobState = 'uploading' | 'ready' | 'gone'
export interface BlobRow {
  id: string
  owner: string
  size: number
  hash: string
  /** The peers that may fetch it, as JSON. */
  recipients: string
  /** The peers that fetched it, as JSON. */
  fetched: string
  state: BlobState
  created_at: number
  /** The last chunk in (an upload that stops is dropped after a while). */
  touched_at: number
  expires_at: number
  gone_at: number | null
  gone_why: string | null
}
export type NewBlob = Pick<BlobRow, 'id' | 'owner' | 'size' | 'hash' | 'recipients' | 'created_at' | 'expires_at'>

export interface InviteRow {
  id: string
  code_hash: string
  note: string | null
  created_at: number
  expires_at: number
  used_by: string | null
  used_at: number | null
  revoked_at: number | null
}

export type InviteState = 'open' | 'used' | 'revoked' | 'expired'

export interface AuditRow {
  seq: number
  at: number
  peer_id: string | null
  action: string
  detail: string
  prev_hash: string
  hash: string
}

/** Each step takes the database from schema_version n to n + 1; a new schema is a new step. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE peer (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER,
    invite_id TEXT
  );
  CREATE UNIQUE INDEX peer_name_active ON peer (name) WHERE status = 'active';

  CREATE TABLE invite (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    note TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT,
    used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    v INTEGER NOT NULL,
    from_peer TEXT NOT NULL,
    to_peer TEXT NOT NULL,
    kind TEXT NOT NULL,
    reply_to TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'acked', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER,
    acked_at INTEGER,
    size INTEGER NOT NULL,
    body_hash TEXT NOT NULL,
    payload TEXT,
    ack_json TEXT,
    sender_notified TEXT
  );
  CREATE INDEX message_to_state ON message (to_peer, state);
  CREATE INDEX message_from_notified ON message (from_peer, sender_notified);
  CREATE INDEX message_due ON message (expires_at) WHERE state IN ('queued', 'delivered');

  CREATE TABLE presence_event (
    peer_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('online', 'offline')),
    at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    peer_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  `,
  // #216: what each board says it understands (its hello's caps), for the roster.
  `ALTER TABLE peer ADD COLUMN caps TEXT`,
  // #371: each board's box key, for the roster, and the blobs the hub keeps for a while.
  `
  ALTER TABLE peer ADD COLUMN box TEXT;
  CREATE TABLE blob (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    recipients TEXT NOT NULL,
    fetched TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state IN ('uploading', 'ready', 'gone')),
    created_at INTEGER NOT NULL,
    touched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    gone_at INTEGER,
    gone_why TEXT
  );
  CREATE INDEX blob_owner_state ON blob (owner, state);
  CREATE INDEX blob_live ON blob (expires_at) WHERE state IN ('uploading', 'ready');
  `,
]

export type MessageState = 'queued' | 'delivered' | 'acked' | 'expired'
export interface MessageRow {
  id: string
  v: number
  from_peer: string
  to_peer: string
  kind: string
  reply_to: string | null
  state: MessageState
  created_at: number
  expires_at: number
  delivered_at: number | null
  acked_at: number | null
  size: number
  body_hash: string
  /** The signed envelope as JSON; null once acked or expired. */
  payload: string | null
  ack_json: string | null
  /** The last state the sender was told of. */
  sender_notified: MessageState | null
}

export type NewMessage = Pick<
  MessageRow,
  | 'id'
  | 'v'
  | 'from_peer'
  | 'to_peer'
  | 'kind'
  | 'reply_to'
  | 'created_at'
  | 'expires_at'
  | 'size'
  | 'body_hash'
  | 'payload'
>

/** The hash before the first audit row. */
export const AUDIT_GENESIS = '0'.repeat(64)

/** How long finished rows are kept; at least longer than the longest message TTL (7 days). */
export const DEFAULT_KEEP_DAYS = 90
export const MIN_KEEP_DAYS = 8

/** Where the audit chain starts after its old rows were pruned: the last row deleted. */
export interface AuditAnchor {
  seq: number
  hash: string
}

/** How many rows a prune removed, per table. `blobs` (#371) only when some went. */
export interface PruneCounts {
  messages: number
  presence: number
  invites: number
  audit: number
  blobs?: number
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export const auditHash = (prev: string, at: number, peer: string | null, action: string, detail: string): string =>
  sha256(`${prev}\n${canonicalJson({ at, peer, action, detail })}`)

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** An invite code: 120 random bits as `hab-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` (base32). */
export function newInviteCode(): string {
  const b = randomBytes(15)
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of b) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(acc >> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  return `hab-${out.match(/.{4}/g)?.join('-')}`
}

/** What is stored of a code: its hash, never the code. */
export const inviteHash = (code: string): string => sha256(code.trim().toLowerCase())

export type JoinResult = { ok: true } | { ok: false; why: 'invite_invalid' | 'name_taken' | 'known_peer' }

export interface HubDb {
  readonly raw: Database
  hubId(): string
  schemaVersion(): number
  // peers
  peer(id: string): PeerRow | null
  activePeerByName(name: string): PeerRow | null
  peers(): PeerRow[]
  touchSeen(id: string, at: number): void
  /** Keeps what a peer's board said it understands (#216); true when that changed. */
  setCaps(id: string, caps: string[] | null): boolean
  /** Keeps a peer's verified box claim as JSON (#371), null for none; true when that changed. */
  setBox(id: string, box: string | null): boolean
  /** Revokes a peer; false when there is none, or it is revoked already. */
  revokePeer(id: string, at: number): boolean
  // invites
  createInvite(now: number, ttlMs: number, note: string | null): { code: string; id: string; expiresAt: number }
  invites(now: number): Array<InviteRow & { state: InviteState }>
  revokeInvite(id: string, now: number): boolean
  /** Checks the code, uses it and creates the peer, in one transaction. */
  join(code: string, peer: string, name: string, now: number): JoinResult
  // messages
  message(id: string): MessageRow | null
  insertMessage(m: NewMessage): void
  /** What waits for a recipient, oldest first: queued or delivered, not yet due. */
  pendingFor(peer: string, now: number): MessageRow[]
  markDelivered(id: string, at: number): void
  /** Acks a message and drops its payload. */
  markAcked(id: string, at: number, ackJson: string): void
  /** Expires every queued or delivered message due before `now`, drops their payloads, returns them. */
  expireDue(now: number): MessageRow[]
  /** Expires every queued or delivered message `sender` sent (it was revoked), drops their payloads, returns them. */
  expireFrom(sender: string): MessageRow[]
  /** What the sender has not been told of yet. */
  unnotified(sender: string): MessageRow[]
  setNotified(id: string, state: MessageState): void
  // blobs (#371)
  blob(id: string): BlobRow | null
  insertBlob(b: NewBlob): void
  touchBlob(id: string, at: number): void
  readyBlob(id: string, at: number): void
  /** Notes that `peer` fetched the blob; the peers that have, after. */
  blobFetched(id: string, peer: string): string[]
  goneBlob(id: string, at: number, why: string): void
  /** The bytes a peer's blobs take on the hub now: uploading or ready. */
  heldBytes(owner: string): number
  /** Uploading or ready blobs past `now`, and uploads untouched since `staleBefore`. */
  dueBlobs(now: number, staleBefore: number): BlobRow[]
  /** Every blob that is uploading or ready, a peer's only when `owner` is given. */
  liveBlobs(owner?: string): BlobRow[]
  // presence
  presenceEvent(peer: string, online: boolean, at: number): void
  // audit
  audit(at: number, peer: string | null, action: string, detail?: Record<string, unknown>): void
  auditRows(): AuditRow[]
  /** The hash the first audit row still held must chain from; null while nothing was pruned. */
  auditAnchor(): AuditAnchor | null
  /**
   * Deletes what finished before `cutoff`: acked or expired messages, presence events, used, revoked
   * or expired invites, and the oldest run of audit rows (their last hash becomes the anchor).
   * Peers and queued or delivered messages stay.
   */
  prune(cutoff: number): PruneCounts
  /** Folds the write-ahead log into hub.db and truncates it, so no old page of it outlives the pass. */
  checkpoint(): void
  /** The seq of the first row whose chain does not hold, or null when it all does. */
  auditBroken(): number | null
  close(): void
}

/** Brings the database to the newest schema; refuses one from a newer hub. Returns the version. */
export function migrate(db: Database, steps: readonly string[] = MIGRATIONS): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('schema_version')
  const have = row ? Number(row.value) : 0
  if (!Number.isInteger(have) || have < 0)
    throw new Error(`hub database: schema_version ${row?.value} is not a version`)
  if (have > steps.length)
    throw new Error(`hub database: schema ${have} is newer than this hub knows (${steps.length})`)
  for (let v = have; v < steps.length; v++) {
    db.transaction(() => {
      db.exec(steps[v] as string)
      db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(v + 1))
    })()
  }
  return steps.length
}

/** Opens (creating it) the hub's database: `:memory:` or a file path. */
export function openDb(path: string): HubDb {
  const db = new Database(path, { create: true, strict: true })
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // A dropped payload is overwritten with zeros, not just unlinked (the text must not stay in free pages).
  db.exec('PRAGMA secure_delete = ON')
  migrate(db)
  const meta = (k: string) =>
    db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(k)?.value
  if (!meta('hub_id'))
    db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('hub_id', `hub-${randomBytes(8).toString('hex')}`)

  const peerRow = db.query<PeerRow, [string]>('SELECT * FROM peer WHERE id = ?')
  const readAnchor = (): AuditAnchor | null => {
    const v = meta('audit_anchor')
    return v ? (JSON.parse(v) as AuditAnchor) : null
  }
  const lastAudit = db.query<{ hash: string }, []>('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')
  const insertAudit = db.query(
    'INSERT INTO audit (at, peer_id, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const audit: HubDb['audit'] = (at, peer, action, detail = {}) => {
    db.transaction(() => {
      const prev = lastAudit.get()?.hash ?? readAnchor()?.hash ?? AUDIT_GENESIS
      const d = canonicalJson(detail)
      insertAudit.run(at, peer, action, d, prev, auditHash(prev, at, peer, action, d))
    })()
  }

  const inviteState = (r: InviteRow, now: number): InviteState =>
    r.used_by ? 'used' : r.revoked_at !== null ? 'revoked' : r.expires_at <= now ? 'expired' : 'open'

  return {
    raw: db,
    hubId: () => meta('hub_id') as string,
    schemaVersion: () => Number(meta('schema_version')),
    peer: id => peerRow.get(id),
    activePeerByName: name =>
      db.query<PeerRow, [string]>("SELECT * FROM peer WHERE name = ? AND status = 'active'").get(name),
    peers: () => db.query<PeerRow, []>('SELECT * FROM peer ORDER BY created_at, id').all(),
    touchSeen: (id, at) => void db.query('UPDATE peer SET last_seen_at = ? WHERE id = ?').run(at, id),
    setCaps: (id, caps) => {
      const json = caps?.length ? JSON.stringify(caps) : null
      if ((peerRow.get(id)?.caps ?? null) === json) return false
      db.query('UPDATE peer SET caps = ? WHERE id = ?').run(json, id)
      return true
    },
    setBox: (id, box) => {
      if ((peerRow.get(id)?.box ?? null) === box) return false
      db.query('UPDATE peer SET box = ? WHERE id = ?').run(box, id)
      return true
    },
    blob: id => db.query<BlobRow, [string]>('SELECT * FROM blob WHERE id = ?').get(id),
    insertBlob: b =>
      void db
        .query(
          `INSERT INTO blob (id, owner, size, hash, recipients, state, created_at, touched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
        )
        .run(b.id, b.owner, b.size, b.hash, b.recipients, b.created_at, b.created_at, b.expires_at),
    touchBlob: (id, at) => void db.query('UPDATE blob SET touched_at = ? WHERE id = ?').run(at, id),
    readyBlob: (id, at) =>
      void db.query("UPDATE blob SET state = 'ready', touched_at = ? WHERE id = ? AND state = 'uploading'").run(at, id),
    blobFetched: (id, peer) =>
      db.transaction((): string[] => {
        const row = db.query<{ fetched: string }, [string]>('SELECT fetched FROM blob WHERE id = ?').get(id)
        const have = row ? (JSON.parse(row.fetched) as string[]) : []
        if (!have.includes(peer)) have.push(peer)
        db.query('UPDATE blob SET fetched = ? WHERE id = ?').run(JSON.stringify(have), id)
        return have
      })(),
    goneBlob: (id, at, why) =>
      void db
        .query("UPDATE blob SET state = 'gone', gone_at = ?, gone_why = ? WHERE id = ? AND state != 'gone'")
        .run(at, why, id),
    heldBytes: owner =>
      db
        .query<{ n: number | null }, [string]>(
          "SELECT SUM(size) AS n FROM blob WHERE owner = ? AND state IN ('uploading', 'ready')",
        )
        .get(owner)?.n ?? 0,
    dueBlobs: (now, staleBefore) =>
      db
        .query<BlobRow, [number, number]>(
          "SELECT * FROM blob WHERE state IN ('uploading', 'ready') AND (expires_at < ? OR (state = 'uploading' AND touched_at < ?))",
        )
        .all(now, staleBefore),
    liveBlobs: owner =>
      owner === undefined
        ? db.query<BlobRow, []>("SELECT * FROM blob WHERE state IN ('uploading', 'ready')").all()
        : db
            .query<BlobRow, [string]>("SELECT * FROM blob WHERE owner = ? AND state IN ('uploading', 'ready')")
            .all(owner),
    revokePeer: (id, at) =>
      db.query("UPDATE peer SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").run(at, id)
        .changes > 0,
    createInvite: (now, ttlMs, note) => {
      const code = newInviteCode()
      const hash = inviteHash(code)
      const expiresAt = now + ttlMs
      const id = hash.slice(0, 8)
      db.query('INSERT INTO invite (id, code_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        hash,
        note,
        now,
        expiresAt,
      )
      return { code, id, expiresAt }
    },
    invites: now =>
      db
        .query<InviteRow, []>('SELECT * FROM invite ORDER BY created_at, id')
        .all()
        .map(r => ({ ...r, state: inviteState(r, now) })),
    revokeInvite: (id, now) =>
      db.query('UPDATE invite SET revoked_at = ? WHERE id = ? AND used_by IS NULL AND revoked_at IS NULL').run(now, id)
        .changes > 0,
    join: (code, peer, name, now) =>
      db.transaction((): JoinResult => {
        const inv = db.query<InviteRow, [string]>('SELECT * FROM invite WHERE code_hash = ?').get(inviteHash(code))
        if (!inv || inviteState(inv, now) !== 'open') return { ok: false, why: 'invite_invalid' }
        if (peerRow.get(peer)) return { ok: false, why: 'known_peer' }
        if (db.query<PeerRow, [string]>("SELECT * FROM peer WHERE name = ? AND status = 'active'").get(name))
          return { ok: false, why: 'name_taken' }
        db.query('UPDATE invite SET used_by = ?, used_at = ? WHERE id = ?').run(peer, now, inv.id)
        db.query(
          "INSERT INTO peer (id, name, status, created_at, last_seen_at, invite_id) VALUES (?, ?, 'active', ?, ?, ?)",
        ).run(peer, name, now, now, inv.id)
        return { ok: true }
      })(),
    message: id => db.query<MessageRow, [string]>('SELECT * FROM message WHERE id = ?').get(id),
    insertMessage: m =>
      void db
        .query(
          `INSERT INTO message (id, v, from_peer, to_peer, kind, reply_to, state, created_at, expires_at, size, body_hash, payload, sender_notified)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 'queued')`,
        )
        .run(
          m.id,
          m.v,
          m.from_peer,
          m.to_peer,
          m.kind,
          m.reply_to,
          m.created_at,
          m.expires_at,
          m.size,
          m.body_hash,
          m.payload,
        ),
    pendingFor: (peer, now) =>
      db
        .query<MessageRow, [string, number]>(
          "SELECT * FROM message WHERE to_peer = ? AND state IN ('queued', 'delivered') AND expires_at >= ? AND from_peer IN (SELECT id FROM peer WHERE status = 'active') ORDER BY created_at, rowid",
        )
        .all(peer, now),
    markDelivered: (id, at) =>
      void db
        .query("UPDATE message SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'queued'")
        .run(at, id),
    markAcked: (id, at, ackJson) =>
      void db
        .query(
          "UPDATE message SET state = 'acked', acked_at = ?, ack_json = ?, payload = NULL WHERE id = ? AND state IN ('queued', 'delivered')",
        )
        .run(at, ackJson, id),
    expireDue: now =>
      db.transaction(() => {
        const due = db
          .query<MessageRow, [number]>(
            "SELECT * FROM message WHERE state IN ('queued', 'delivered') AND expires_at < ?",
          )
          .all(now)
        const expire = db.query("UPDATE message SET state = 'expired', payload = NULL WHERE id = ?")
        for (const r of due) expire.run(r.id)
        return due.map(r => ({ ...r, state: 'expired' as const, payload: null }))
      })(),
    expireFrom: sender =>
      db.transaction(() => {
        const rows = db
          .query<MessageRow, [string]>("SELECT * FROM message WHERE from_peer = ? AND state IN ('queued', 'delivered')")
          .all(sender)
        const expire = db.query("UPDATE message SET state = 'expired', payload = NULL WHERE id = ?")
        for (const r of rows) expire.run(r.id)
        return rows.map(r => ({ ...r, state: 'expired' as const, payload: null }))
      })(),
    unnotified: sender =>
      db
        .query<MessageRow, [string]>(
          'SELECT * FROM message WHERE from_peer = ? AND (sender_notified IS NULL OR sender_notified != state) ORDER BY created_at, rowid',
        )
        .all(sender),
    setNotified: (id, state) => void db.query('UPDATE message SET sender_notified = ? WHERE id = ?').run(state, id),
    presenceEvent: (peer, online, at) =>
      void db
        .query('INSERT INTO presence_event (peer_id, state, at) VALUES (?, ?, ?)')
        .run(peer, online ? 'online' : 'offline', at),
    audit,
    auditRows: () => db.query<AuditRow, []>('SELECT * FROM audit ORDER BY seq').all(),
    auditAnchor: readAnchor,
    checkpoint: () => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    },
    prune: cutoff =>
      db.transaction((): PruneCounts => {
        const messages = db
          .query(
            "DELETE FROM message WHERE state IN ('acked', 'expired') AND COALESCE(acked_at, expires_at, created_at) < ?",
          )
          .run(cutoff).changes
        const presence = db.query('DELETE FROM presence_event WHERE at < ?').run(cutoff).changes
        const blobs = db.query("DELETE FROM blob WHERE state = 'gone' AND gone_at < ?").run(cutoff).changes
        const invites = db
          .query('DELETE FROM invite WHERE COALESCE(used_at, revoked_at, expires_at) < ?')
          .run(cutoff).changes
        // Only a run from the oldest row on, so what is left still chains from the anchor.
        const keep = db
          .query<{ seq: number | null }, [number]>('SELECT MIN(seq) AS seq FROM audit WHERE at >= ?')
          .get(cutoff)
        const upTo = keep?.seq ?? Number.MAX_SAFE_INTEGER
        const last = db
          .query<AuditAnchor, [number]>('SELECT seq, hash FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT 1')
          .get(upTo)
        let audit = 0
        if (last) {
          audit = db.query('DELETE FROM audit WHERE seq <= ?').run(last.seq).changes
          db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
            'audit_anchor',
            JSON.stringify({ seq: last.seq, hash: last.hash }),
          )
        }
        return { messages, presence, invites, audit, ...(blobs > 0 && { blobs }) }
      })(),
    auditBroken: () => {
      let prev = readAnchor()?.hash ?? AUDIT_GENESIS
      for (const r of db.query<AuditRow, []>('SELECT * FROM audit ORDER BY seq').all()) {
        if (r.prev_hash !== prev || r.hash !== auditHash(prev, r.at, r.peer_id, r.action, r.detail)) return r.seq
        prev = r.hash
      }
      return null
    },
    close: () => db.close(),
  }
}
