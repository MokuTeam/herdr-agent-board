// The board's database (#233): one SQLite file in the state folder, board.db, that stores move
// into (time first). This module knows no store: it opens the file, keeps its settings, takes it
// through the steps of db-schema.ts, and gives a store one way to change it, a transaction that
// writes the change and its journal row together.
//
// Several processes use the file at once: the web board keeps a connection for its life, and every
// `board` command opens one, does its one thing and closes it. WAL lets readers go on while one
// writer writes; a writer waits up to busy_timeout for another; every change takes the write lock
// at its start (BEGIN IMMEDIATE), so it waits there instead of failing halfway when another process
// committed between its read and its write. synchronous=FULL: a change that returned is on disk,
// power cut or not (1 to 2 ms a change). Reads keep no transaction open between calls, so the WAL
// is always checkpointed back into the file.
//
// Nothing here opens the file until a store asks: a board without such a feature never makes it.
// A file found damaged (PRAGMA quick_check, or SQLite's own error in a change) gets a mark beside
// it, board.db.damaged.json, and from then on every change is refused until a restore
// (services/backup.ts) clears the mark. A file newer than the code (an older board after a
// downgrade) opens for reading only.
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from '../core/lang.ts'
import { LATEST, MIGRATIONS, type Migration } from './db-schema.ts'
import { stateDir } from './paths.ts'

export const dbFile = (): string => join(stateDir(), 'board.db')
/** The mark of a damaged file, beside it: what was found and when. */
export const damagedMark = (path: string): string => `${path}.damaged.json`

/** What keeps a change from happening, in words the owner reads (core/i18n/backup-strings.ts). */
export type DbProblem = 'damaged' | 'newer' | 'oldSqlite' | 'busy'

export class DbError extends Error {
  constructor(
    readonly problem: DbProblem,
    detail = '',
  ) {
    super(t(`db.err.${problem}`, { detail }))
    this.name = 'DbError'
  }
}

/** STRICT tables came with SQLite 3.37. */
export const MIN_SQLITE = [3, 37, 0] as const
/** How long a writer waits for another one, in ms. */
export const BUSY_TIMEOUT_MS = 5000
/** Pre-migration copies kept beside the file. */
const COPIES_KEPT = 3

export function sqliteAtLeast(version: string, min: readonly number[] = MIN_SQLITE): boolean {
  const parts = version.split('.').map(Number)
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/** A change's journal row: which store, what it did to which row, and the row before and after (JSON; null: none). */
export interface JournalRow {
  store: string
  op: string
  ref: string
  before?: unknown
  after?: unknown
}

/** What a store's change gets: the connection, and the journal of that same transaction. */
export interface Tx {
  db: Database
  /** Writes the row (who and when are the change's) and returns its seq. */
  journal(row: JournalRow): number
}

export interface BoardDb {
  readonly path: string
  readonly db: Database
  /** The file's version is newer than the code knows: it is read, never changed. */
  readonly newer: boolean
  /**
   * Runs `fn` as one transaction that holds the write lock from its start, the journal rows it
   * writes included; it throws DbError when the file is damaged, newer than the code, or the lock
   * stays taken past busy_timeout. `by`: who changes it, as the journal keeps it. `fn` may run
   * again when SQLite answered busy at its start (whileBusy): it changes the database and nothing
   * else.
   */
  write<T>(by: string, fn: (tx: Tx) => T): T
  /** The journal's last row: the change counter (0 and 0 for an empty journal). */
  lastChange(): { seq: number; at: number }
  /** The first change after `seq`, when there is one: when it was made. */
  firstChangeAfter(seq: number): number | null
  /** PRAGMA quick_check (the whole file, without its indexes' contents); a damage found is marked. */
  check(): { ok: true } | { ok: false; detail: string }
  /** A consistent copy of the whole file at `to`, made while writers go on (VACUUM INTO). */
  copyTo(to: string): void
  close(): void
}

const corrupt = (err: unknown): boolean => {
  const code = String((err as { code?: unknown } | null)?.code ?? '')
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB'
}
const busy = (err: unknown): boolean => String((err as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_BUSY')

/** The damage mark's detail, or null when the file is not marked. */
export function damageOf(path: string = dbFile()): string | null {
  try {
    const mark = JSON.parse(readFileSync(damagedMark(path), 'utf8')) as { detail?: unknown }
    return typeof mark.detail === 'string' ? mark.detail : ''
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return '' // a mark that cannot be read is still a mark
  }
}

export function markDamaged(path: string, detail: string): void {
  writeFileSync(damagedMark(path), JSON.stringify({ at: Date.now(), detail: detail.slice(0, 2000) }))
}

export function clearDamaged(path: string): void {
  rmSync(damagedMark(path), { force: true })
}

/** The settings every connection runs with; journal_mode stays in the file once set. */
function settle(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  // SQLite's page cache: 2 MB (its default, said here so nobody raises it by accident), and the
  // file never mapped into the process, so memory does not grow with the file.
  db.exec('PRAGMA cache_size = -2000')
  db.exec('PRAGMA mmap_size = 0')
}

const userVersion = (db: Database): number =>
  Number((db.query('PRAGMA user_version').get() as { user_version?: number } | null)?.user_version ?? 0)

/** A copy of the file as it is, before a step changes it: board.db.before-v<n>-<stamp>, the last COPIES_KEPT kept. */
function copyBeforeMigration(db: Database, path: string, from: number): void {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const copy = `${path}.before-v${from}-${stamp}`
  db.query('VACUUM INTO ?').run(copy)
  const dir = dirname(path)
  const prefix = `${path.slice(dir.length + 1)}.before-v`
  const copies = readdirSync(dir)
    .filter(f => f.startsWith(prefix))
    .map(f => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const old of copies.slice(COPIES_KEPT)) rmSync(join(dir, old.f), { force: true })
}

/**
 * Takes the file through the steps it has not had, in one transaction that holds the write lock:
 * of two processes opening it at once, one does them and the other finds nothing to do. A file
 * that had steps already is copied first (`path`: none for a copy being restored). Returns whether
 * the file is newer than the code. `steps` is for the tests.
 */
export function migrate(db: Database, path: string | null, steps: readonly Migration[] = MIGRATIONS): boolean {
  const latest = steps.at(-1)?.version ?? 0
  const before = userVersion(db)
  if (before > latest) return true
  if (before === latest) return false
  if (before > 0 && path) copyBeforeMigration(db, path, before)
  let newer = false
  db.transaction(() => {
    const now = userVersion(db) // another process may have done it while we copied
    if (now > latest) {
      newer = true
      return
    }
    for (const m of steps) if (m.version > now) db.exec(m.sql)
    if (now < latest) db.exec(`PRAGMA user_version = ${latest}`)
  }).immediate()
  return newer
}

export interface OpenOptions {
  /** The file; dbFile() when not given. */
  path?: string
  /** Make the file when it is not there (a store about to write); false: null for a missing file. */
  create?: boolean
}

const pause = new Int32Array(new SharedArrayBuffer(4))
/** A short wait between tries, without giving up the thread (a `board` command is synchronous). */
const nap = (ms: number): void => {
  Atomics.wait(pause, 0, 0, ms)
}

/**
 * `fn` again while SQLite says the file is busy, up to busy_timeout in all. SQLite waits by itself
 * for a lock another connection holds, but some moments it answers busy at once and leaves the
 * waiting to the caller: a file several processes open at once while the first of them sets up its
 * WAL, or switches its journal mode.
 */
function whileBusy<T>(fn: () => T): T {
  const deadline = performance.now() + BUSY_TIMEOUT_MS
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      return fn()
    } catch (err) {
      if (!busy(err) || performance.now() >= deadline) throw err
      nap(wait)
    }
  }
}

/** The database, its settings and steps done; null when it is not there and `create` is false. */
export function openDb({ path = dbFile(), create = true }: OpenOptions = {}): BoardDb | null {
  if (!create && !existsSync(path)) return null
  mkdirSync(dirname(path), { recursive: true })
  let db: Database | null = null
  try {
    return whileBusy(() => {
      db?.close(false)
      db = new Database(path, { create: true, readwrite: true, strict: true })
      const version = (db.query('SELECT sqlite_version() AS v').get() as { v: string }).v
      if (!sqliteAtLeast(version)) throw new DbError('oldSqlite', version)
      settle(db)
      const newer = damageOf(path) === null ? migrate(db, path) : userVersion(db) > LATEST
      return handle(db, path, newer)
    })
  } catch (err) {
    ;(db as Database | null)?.close(false)
    if (err instanceof DbError) throw err
    if (corrupt(err)) {
      markDamaged(path, String((err as Error).message))
      throw new DbError('damaged', String((err as Error).message))
    }
    if (busy(err)) throw new DbError('busy')
    throw err
  }
}

function handle(db: Database, path: string, newer: boolean): BoardDb {
  const insertJournal = db.query(
    'INSERT INTO journal (at, by, store, op, ref, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))
  return {
    path,
    db,
    newer,
    write<T>(by: string, fn: (tx: Tx) => T): T {
      const damage = damageOf(path)
      if (damage !== null) throw new DbError('damaged', damage)
      if (newer) throw new DbError('newer')
      const at = Date.now()
      const tx: Tx = {
        db,
        journal: row => {
          const r = insertJournal.run(at, by, row.store, row.op, row.ref, json(row.before), json(row.after))
          return Number(r.lastInsertRowid)
        },
      }
      try {
        return whileBusy(() => db.transaction(() => fn(tx)).immediate())
      } catch (err) {
        if (corrupt(err)) {
          markDamaged(path, String((err as Error).message))
          throw new DbError('damaged', String((err as Error).message))
        }
        if (busy(err)) throw new DbError('busy')
        throw err
      }
    },
    lastChange() {
      const row = db.query('SELECT seq, at FROM journal ORDER BY seq DESC LIMIT 1').get() as {
        seq: number
        at: number
      } | null
      return row ?? { seq: 0, at: 0 }
    },
    firstChangeAfter(seq: number) {
      const row = db.query('SELECT at FROM journal WHERE seq > ? ORDER BY seq LIMIT 1').get(seq) as {
        at: number
      } | null
      return row?.at ?? null
    },
    check() {
      let rows: { quick_check?: string }[]
      try {
        rows = db.query('PRAGMA quick_check').all() as { quick_check?: string }[]
      } catch (err) {
        if (!corrupt(err)) throw err
        rows = [{ quick_check: String((err as Error).message) }]
      }
      const said = rows.map(r => String(Object.values(r)[0] ?? ''))
      if (said.length === 1 && said[0] === 'ok') return { ok: true }
      const detail = said.join('\n')
      markDamaged(path, detail)
      return { ok: false, detail }
    },
    copyTo(to: string) {
      rmSync(to, { force: true })
      db.query('VACUUM INTO ?').run(to)
    },
    close() {
      db.close(false)
    },
  }
}

/** Whether a copy (a snapshot, a restore's file) is whole: PRAGMA integrity_check, the indexes' contents too. */
export function integrityOf(path: string): { ok: true; version: number } | { ok: false; detail: string } {
  let db: Database | null = null
  try {
    db = new Database(path, { readonly: true, strict: true })
    const rows = db.query('PRAGMA integrity_check').all() as Record<string, unknown>[]
    const said = rows.map(r => String(Object.values(r)[0] ?? ''))
    if (said.length === 1 && said[0] === 'ok') return { ok: true, version: userVersion(db) }
    return { ok: false, detail: said.join('\n') }
  } catch (err) {
    return { ok: false, detail: String((err as Error).message) }
  } finally {
    db?.close(false)
  }
}

/**
 * The live file's rows replaced by those of the copy at `from` (a restore), table by table in one
 * transaction that holds the write lock, a 'restore' row in the journal after them. Every other
 * connection stays open and sees the restored rows; nothing is renamed, which Windows would refuse
 * while another process has the file open. The copy is taken to the code's version first; a copy
 * newer than the code is refused. The journal's seq goes on from the live file's, so the change is
 * seen (by the backup above all). Clears the damage mark.
 */
export function replaceContents(live: BoardDb, from: string, by: string, note: string): void {
  if (live.newer) throw new DbError('newer')
  const copy = new Database(from, { readwrite: true, strict: true })
  try {
    if (migrate(copy, null)) throw new DbError('newer')
  } finally {
    copy.close(false)
  }
  const { db } = live
  db.query('ATTACH DATABASE ? AS restored').run(from)
  try {
    db.transaction(() => {
      const tables = (
        db.query("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
          name: string
        }[]
      ).map(r => r.name)
      for (const name of tables) {
        const q = `"${name.replaceAll('"', '""')}"`
        db.exec(`DELETE FROM main.${q}`)
        db.exec(`INSERT INTO main.${q} SELECT * FROM restored.${q}`)
      }
      db.query(
        "INSERT INTO journal (at, by, store, op, ref, before, after) VALUES (?, ?, 'db', 'restore', 'db', NULL, ?)",
      ).run(Date.now(), by, JSON.stringify({ from: note }))
    }).immediate()
  } finally {
    db.exec('DETACH DATABASE restored')
  }
  clearDamaged(live.path)
}
