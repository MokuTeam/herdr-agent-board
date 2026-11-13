// The bridge's store (#384, design 3.2): one SQLite file in the state directory, WAL. Nothing here
// reads a clock: every write is told the time, so tests keep their own. Message text lives in
// `messages` for KEEP_DAYS at most and KEEP_PER_THREAD per thread (prune); the log never has it.
import { Database } from 'bun:sqlite'
import type { Location } from './protocol.ts'

export const KEEP_DAYS = 7
export const KEEP_PER_THREAD = 200
const DAY = 24 * 3600_000

export type PinStatus = 'trusted' | 'changed'
export interface Pin {
  name: string
  peer: string
  status: PinStatus
  /** A changed pin: the key the hub shows under that name now. */
  seen: string | null
  at: number
}

export interface Thread {
  /** The board's form: `<peer>/<id>` in a pair, `team/<id>` for the team. */
  key: string
  scope: string
  id: string
  title: string | null
  /** A channel's members (peer ids), as the first copy named them. */
  members: string[] | null
  /** Who started it: a peer id, or `self` for the bridge. */
  by: string
  createdAt: number
  /** Where its messages go; null for the inbox. */
  location: Location | null
  /** The run of agent messages in a row (design 5.4), and whether the owner heard of its pause. */
  run: number
  pauseTold: boolean
  /** The newest message in it that was handed to a location. */
  lastAt: number
}

export type MessageState = 'batched' | 'delivered' | 'read' | 'dropped' | 'held' | 'sent'
export interface StoredMessage {
  id: string
  thread: string
  dir: 'in' | 'out'
  /** The sender (in) or the recipient (out). */
  peer: string
  name: string
  via: string | null
  agent: string | null
  text: string
  replyTo: string | null
  ts: string
  at: number
  state: MessageState
  location: Location | null
}

export type OutState = 'queued' | 'delivered' | 'acked' | 'expired' | 'refused'
export interface OutItem {
  id: string
  to: string
  env: string
  state: OutState
  at: number
}

export type JobKind = 'deliver' | 'schedule' | 'notice'
/** Something for the module, sent until it confirms. */
export interface Job {
  id: string
  kind: JobKind
  location: Location
  trigger: 0 | 1
  text: string
  /** deliver: not before (the wake gap); schedule: the time the row is due. */
  due: number
  createdAt: number
  confirmedAt: number | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pins (name TEXT PRIMARY KEY, peer TEXT NOT NULL, status TEXT NOT NULL, seen TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS threads (key TEXT PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT, members TEXT,
  by TEXT NOT NULL, created_at INTEGER NOT NULL, location TEXT, run INTEGER NOT NULL DEFAULT 0,
  pause_told INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread TEXT NOT NULL, dir TEXT NOT NULL, peer TEXT NOT NULL,
  name TEXT NOT NULL, via TEXT, agent TEXT, text TEXT NOT NULL, reply_to TEXT, ts TEXT NOT NULL, at INTEGER NOT NULL,
  state TEXT NOT NULL, location TEXT);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread, at);
CREATE INDEX IF NOT EXISTS messages_state ON messages (state, location);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, to_peer TEXT NOT NULL, env TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, location TEXT NOT NULL, trigger INTEGER NOT NULL,
  text TEXT NOT NULL, due INTEGER NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER);
CREATE INDEX IF NOT EXISTS jobs_open ON jobs (confirmed_at, due);
CREATE TABLE IF NOT EXISTS refusals (peer TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS told (what TEXT PRIMARY KEY, at INTEGER NOT NULL);
`

type Row = Record<string, string | number | null>

const toThread = (r: Row): Thread => ({
  key: String(r.key),
  scope: String(r.scope),
  id: String(r.id),
  title: r.title === null ? null : String(r.title),
  members: typeof r.members === 'string' ? (JSON.parse(r.members) as string[]) : null,
  by: String(r.by),
  createdAt: Number(r.created_at),
  location: r.location === null ? null : (String(r.location) as Location),
  run: Number(r.run),
  pauseTold: Number(r.pause_told) === 1,
  lastAt: Number(r.last_at),
})

const toMessage = (r: Row): StoredMessage => ({
  id: String(r.id),
  thread: String(r.thread),
  dir: r.dir === 'out' ? 'out' : 'in',
  peer: String(r.peer),
  name: String(r.name),
  via: r.via === null ? null : String(r.via),
  agent: r.agent === null ? null : String(r.agent),
  text: String(r.text),
  replyTo: r.reply_to === null ? null : String(r.reply_to),
  ts: String(r.ts),
  at: Number(r.at),
  state: String(r.state) as MessageState,
  location: r.location === null ? null : (String(r.location) as Location),
})

const toJob = (r: Row): Job => ({
  id: String(r.id),
  kind: String(r.kind) as JobKind,
  location: String(r.location) as Location,
  trigger: Number(r.trigger) === 1 ? 1 : 0,
  text: String(r.text),
  due: Number(r.due),
  createdAt: Number(r.created_at),
  confirmedAt: r.confirmed_at === null ? null : Number(r.confirmed_at),
})

export type Store = ReturnType<typeof openStore>

export function openStore(path: string) {
  const db = new Database(path, { create: true, strict: true })
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA secure_delete = ON')
  db.exec(SCHEMA)

  const all = (sql: string, ...args: (string | number | null)[]): Row[] => db.query(sql).all(...args) as Row[]
  const one = (sql: string, ...args: (string | number | null)[]): Row | null =>
    (db.query(sql).get(...args) as Row | null) ?? null
  const run = (sql: string, ...args: (string | number | null)[]): number => db.query(sql).run(...args).changes

  return {
    close: () => db.close(),

    // ---- pins
    pins: (): Pin[] =>
      all('SELECT * FROM pins ORDER BY name').map(r => ({
        name: String(r.name),
        peer: String(r.peer),
        status: r.status === 'changed' ? 'changed' : 'trusted',
        seen: r.seen === null ? null : String(r.seen),
        at: Number(r.at),
      })),
    pin: (name: string, peer: string, at: number): void => {
      run(
        `INSERT INTO pins (name, peer, status, seen, at) VALUES (?, ?, 'trusted', NULL, ?)
         ON CONFLICT(name) DO UPDATE SET peer = excluded.peer, status = 'trusted', seen = NULL, at = excluded.at`,
        name,
        peer,
        at,
      )
    },
    markChanged: (name: string, seen: string, at: number): boolean =>
      run(
        `UPDATE pins SET status = 'changed', seen = ?, at = ? WHERE name = ? AND (status = 'trusted' OR seen IS NOT ?)`,
        seen,
        at,
        name,
        seen,
      ) > 0,
    unpin: (name: string): void => void run('DELETE FROM pins WHERE name = ?', name),

    // ---- threads
    thread: (key: string): Thread | null => {
      const r = one('SELECT * FROM threads WHERE key = ?', key)
      return r ? toThread(r) : null
    },
    threads: (): Thread[] => all('SELECT * FROM threads ORDER BY last_at DESC').map(toThread),
    addThread: (t: Omit<Thread, 'run' | 'pauseTold' | 'lastAt'>): boolean =>
      run(
        `INSERT OR IGNORE INTO threads (key, scope, id, title, members, by, created_at, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        t.key,
        t.scope,
        t.id,
        t.title,
        t.members ? JSON.stringify(t.members) : null,
        t.by,
        t.createdAt,
        t.location,
      ) > 0,
    setRun: (key: string, n: number, pauseTold: boolean): void =>
      void run('UPDATE threads SET run = ?, pause_told = ? WHERE key = ?', n, pauseTold ? 1 : 0, key),
    touchThread: (key: string, at: number): void =>
      void run('UPDATE threads SET last_at = MAX(last_at, ?) WHERE key = ?', at, key),
    bind: (key: string, location: Location | null): void =>
      void run('UPDATE threads SET location = ? WHERE key = ?', location, key),

    // ---- messages
    hasMessage: (id: string): boolean => one('SELECT 1 AS x FROM messages WHERE id = ?', id) !== null,
    message: (id: string): StoredMessage | null => {
      const r = one('SELECT * FROM messages WHERE id = ?', id)
      return r ? toMessage(r) : null
    },
    addMessage: (m: StoredMessage): boolean =>
      run(
        `INSERT OR IGNORE INTO messages (id, thread, dir, peer, name, via, agent, text, reply_to, ts, at, state, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id,
        m.thread,
        m.dir,
        m.peer,
        m.name,
        m.via,
        m.agent,
        m.text,
        m.replyTo,
        m.ts,
        m.at,
        m.state,
        m.location,
      ) > 0,
    setState: (id: string, state: MessageState): void =>
      void run('UPDATE messages SET state = ? WHERE id = ?', state, id),
    /** Messages in one of the states for a location (all locations when null), oldest first. */
    byState: (states: MessageState[], location: Location | null): StoredMessage[] => {
      const marks = states.map(() => '?').join(', ')
      return (
        location === null
          ? all(`SELECT * FROM messages WHERE state IN (${marks}) ORDER BY at, rowid`, ...states)
          : all(
              `SELECT * FROM messages WHERE state IN (${marks}) AND location = ? ORDER BY at, rowid`,
              ...states,
              location,
            )
      ).map(toMessage)
    },
    /** A message whose id starts with `ref` (8 or more characters), when exactly one does. */
    messageByRef: (ref: string): StoredMessage | null => {
      if (!/^[0-9a-f-]{8,36}$/i.test(ref)) return null
      const rows = all('SELECT * FROM messages WHERE id LIKE ? LIMIT 2', `${ref.toLowerCase()}%`)
      return rows.length === 1 && rows[0] ? toMessage(rows[0]) : null
    },
    /** The newest inbound message handed to a location (its thread is where a reply without one goes). */
    newestIn: (location: Location): StoredMessage | null => {
      const r = one(
        `SELECT * FROM messages WHERE dir = 'in' AND location = ? AND state IN ('delivered', 'read', 'batched') ORDER BY at DESC, rowid DESC LIMIT 1`,
        location,
      )
      return r ? toMessage(r) : null
    },
    /** Outbound posts of the last `ms` (for the limits), optionally to one peer or from one location. */
    sentSince: (since: number, filter: { peer?: string; location?: Location; thread?: string } = {}): StoredMessage[] =>
      all(
        `SELECT * FROM messages WHERE dir = 'out' AND at >= ?
           AND (? IS NULL OR peer = ?) AND (? IS NULL OR location = ?) AND (? IS NULL OR thread = ?)`,
        since,
        filter.peer ?? null,
        filter.peer ?? null,
        filter.location ?? null,
        filter.location ?? null,
        filter.thread ?? null,
        filter.thread ?? null,
      ).map(toMessage),

    // ---- outbox
    addOut: (o: OutItem): void =>
      void run(
        'INSERT OR IGNORE INTO outbox (id, to_peer, env, state, at) VALUES (?, ?, ?, ?, ?)',
        o.id,
        o.to,
        o.env,
        o.state,
        o.at,
      ),
    out: (id: string): OutItem | null => {
      const r = one('SELECT * FROM outbox WHERE id = ?', id)
      return r
        ? {
            id: String(r.id),
            to: String(r.to_peer),
            env: String(r.env),
            state: String(r.state) as OutState,
            at: Number(r.at),
          }
        : null
    },
    unsettled: (): OutItem[] =>
      all(`SELECT * FROM outbox WHERE state IN ('queued', 'delivered') ORDER BY at, rowid`).map(r => ({
        id: String(r.id),
        to: String(r.to_peer),
        env: String(r.env),
        state: String(r.state) as OutState,
        at: Number(r.at),
      })),
    setOut: (id: string, state: OutState, at: number): void =>
      void run('UPDATE outbox SET state = ?, at = ? WHERE id = ?', state, at, id),

    // ---- jobs for the module
    addJob: (j: Omit<Job, 'confirmedAt'>): boolean =>
      run(
        `INSERT OR IGNORE INTO jobs (id, kind, location, trigger, text, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        j.id,
        j.kind,
        j.location,
        j.trigger,
        j.text,
        j.due,
        j.createdAt,
      ) > 0,
    openJobs: (): Job[] => all('SELECT * FROM jobs WHERE confirmed_at IS NULL ORDER BY created_at, rowid').map(toJob),
    confirm: (id: string, at: number): boolean =>
      run('UPDATE jobs SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL', at, id) > 0,
    /** The schedule job for a location that is still ahead (due after `now`), if any. */
    pendingSchedule: (location: Location, now: number): Job | null => {
      const r = one(
        `SELECT * FROM jobs WHERE kind = 'schedule' AND location = ? AND due > ? ORDER BY due LIMIT 1`,
        location,
        now,
      )
      return r ? toJob(r) : null
    },
    /** Wakes caused since `since`: deliver jobs with trigger 1 that share a location and a due time are one. */
    wakesSince: (since: number): number =>
      Number(
        one(
          `SELECT COUNT(*) AS n FROM (SELECT DISTINCT location, due FROM jobs WHERE kind = 'deliver' AND trigger = 1 AND created_at >= ?)`,
          since,
        )?.n ?? 0,
      ),
    /** The latest wake job made for a location (its time, for the gap). */
    lastWake: (location: Location): Job | null => {
      const r = one(
        `SELECT * FROM jobs WHERE kind = 'deliver' AND trigger = 1 AND location = ? ORDER BY due DESC LIMIT 1`,
        location,
      )
      return r ? toJob(r) : null
    },

    // ---- refusals and one-off lines
    refusedAt: (peer: string): number | null => {
      const r = one('SELECT at FROM refusals WHERE peer = ?', peer)
      return r ? Number(r.at) : null
    },
    refused: (peer: string, at: number): void =>
      void run(
        'INSERT INTO refusals (peer, at) VALUES (?, ?) ON CONFLICT(peer) DO UPDATE SET at = excluded.at',
        peer,
        at,
      ),
    /** Whether `what` was told since `since`; marks it told now when not. */
    tellOnce: (what: string, since: number, at: number): boolean => {
      const r = one('SELECT at FROM told WHERE what = ?', what)
      if (r && Number(r.at) >= since) return false
      run('INSERT INTO told (what, at) VALUES (?, ?) ON CONFLICT(what) DO UPDATE SET at = excluded.at', what, at)
      return true
    },

    /** Drops what is past its time: old text, settled outbox rows and confirmed jobs. */
    prune: (now: number): void => {
      const old = now - KEEP_DAYS * DAY
      db.transaction(() => {
        run(`DELETE FROM messages WHERE at < ? AND state NOT IN ('batched', 'held')`, old)
        run(
          `DELETE FROM messages WHERE id IN (
             SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY thread ORDER BY at DESC) AS n FROM messages) WHERE n > ?)`,
          KEEP_PER_THREAD,
        )
        run(`DELETE FROM outbox WHERE state IN ('acked', 'expired', 'refused') AND at < ?`, old)
        run('DELETE FROM jobs WHERE confirmed_at IS NOT NULL AND confirmed_at < ?', old)
        run('DELETE FROM told WHERE at < ?', now - 31 * DAY)
      })()
    },
    counts: (): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const r of all('SELECT state, COUNT(*) AS n FROM messages GROUP BY state'))
        out[String(r.state)] = Number(r.n)
      out.threads = Number(one('SELECT COUNT(*) AS n FROM threads')?.n ?? 0)
      out.jobsOpen = Number(one('SELECT COUNT(*) AS n FROM jobs WHERE confirmed_at IS NULL')?.n ?? 0)
      out.outboxOpen = Number(one(`SELECT COUNT(*) AS n FROM outbox WHERE state IN ('queued', 'delivered')`)?.n ?? 0)
      return out
    },
  }
}
