// SQLite schema scan and single-transaction rekey for board.db (#696).
import type { Database } from 'bun:sqlite'
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { DB_SCHEMA_COLUMNS, rekeyColumnValue, rekeyKey, type TableRekeyCount } from '../core/db-rekey.ts'
import { type WatchWhat, wider } from '../core/work-threads.ts'
import { type BoardDb, integrityOf } from './db.ts'

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Every non-internal table currently in `db`. */
export function tableNames(db: Database): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map(r => r.name)
}

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]).map(c => c.name)
}

/**
 * Every `table.column` in `db` that is not listed in `DB_SCHEMA_COLUMNS`.
 * Fails in tests whenever a new migration or lazy store adds a column without classifying it.
 */
export function unlistedSchemaColumns(db: Database): string[] {
  const unlisted: string[] = []
  for (const table of tableNames(db)) {
    const cols = tableColumns(db, table)
    const spec = DB_SCHEMA_COLUMNS[table]
    if (!spec) {
      if (!cols.length) unlisted.push(table)
      else for (const col of cols) unlisted.push(`${table}.${col}`)
      continue
    }
    for (const col of cols) {
      if (!(col in spec.columns)) unlisted.push(`${table}.${col}`)
    }
  }
  return unlisted.sort()
}

/**
 * Every non-optional `table.column` in `DB_SCHEMA_COLUMNS` missing from `db`.
 * Keeps the catalog honest if a migration or schema changes.
 */
export function missingSchemaColumns(db: Database): string[] {
  const existing = new Set(tableNames(db))
  const missing: string[] = []
  for (const [table, spec] of Object.entries(DB_SCHEMA_COLUMNS)) {
    if (spec.optional) continue
    if (!existing.has(table)) {
      for (const col of Object.keys(spec.columns)) missing.push(`${table}.${col}`)
      continue
    }
    const cols = new Set(tableColumns(db, table))
    for (const col of Object.keys(spec.columns)) {
      if (!cols.has(col)) missing.push(`${table}.${col}`)
    }
  }
  return missing.sort()
}

/** The last `(from, to)` rekey recorded in the database journal, or null when none. */
export function lastDbRekey(db: Database): { from: string; to: string } | null {
  const hasJournal = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal'").get()
  if (!hasJournal) return null
  const row = db
    .query("SELECT after FROM journal WHERE store = 'db' AND op = 'rekey' ORDER BY seq DESC LIMIT 1")
    .get() as { after: string | null } | null
  if (!row?.after) return null
  try {
    const parsed = JSON.parse(row.after) as { from?: unknown; to?: unknown }
    if (typeof parsed.from === 'string' && parsed.from && typeof parsed.to === 'string' && parsed.to) {
      return { from: parsed.from, to: parsed.to }
    }
  } catch {}
  return null
}

function writeWhole(file: string, bytes: Uint8Array): void {
  const fd = openSync(file, 'wx')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export interface DbRekeySummary {
  already: boolean
  total: number
  tables: TableRekeyCount[]
}

/** Read-only dry run of `board.db`: counts every row/column that would change without writing anything. */
export function planDbRekey(db: Database, from: string, to: string): DbRekeySummary {
  const last = lastDbRekey(db)
  if (last?.from === from && last?.to === to) return { already: true, total: 0, tables: [] }
  const present = new Set(tableNames(db))
  const tables: TableRekeyCount[] = []
  let total = 0

  for (const [table, spec] of Object.entries(DB_SCHEMA_COLUMNS)) {
    if (!present.has(table)) continue
    const actualCols = new Set(tableColumns(db, table))
    for (const [col, kind] of Object.entries(spec.columns)) {
      if (kind === 'none' || !actualCols.has(col)) continue
      const rows = db.query(`SELECT ${q(col)} AS val FROM ${q(table)} WHERE ${q(col)} IS NOT NULL`).all() as {
        val: unknown
      }[]
      let changed = 0
      for (const r of rows) {
        const str = typeof r.val === 'string' ? r.val : String(r.val)
        if (rekeyColumnValue(kind, str, from, to).changed) changed++
      }
      if (changed > 0) {
        tables.push({ table, column: col, rows: changed })
        total += changed
      }
    }
  }

  return { already: false, total, tables }
}

interface WatchDbRow {
  session: string
  target: string
  what: string
  idle: number
  wake: number
  name: string
  at: number
  since: number
}

interface CursorDbRow {
  session: string
  seq: number
  at: number
  asked: number
}

function rekeyThreadWatch(db: Database, from: string, to: string): number {
  const rows = db
    .query('SELECT session, target, what, idle, wake, name, at, since FROM thread_watch')
    .all() as WatchDbRow[]
  let changed = 0
  const merged = new Map<string, WatchDbRow>()
  for (const r of rows) {
    const nextSession = rekeyKey(r.session, from, to)
    if (nextSession !== r.session) changed++
    const mapKey = `${nextSession}\0${r.target}`
    const prev = merged.get(mapKey)
    if (!prev) {
      merged.set(mapKey, { ...r, session: nextSession })
    } else {
      merged.set(mapKey, {
        session: nextSession,
        target: r.target,
        what: wider(prev.what as WatchWhat, r.what as WatchWhat),
        idle: prev.idle === 1 && r.idle === 1 ? 1 : 0,
        wake: prev.wake === 1 || r.wake === 1 ? 1 : 0,
        name: prev.name || r.name,
        at: Math.max(prev.at, r.at),
        since: Math.min(prev.since, r.since),
      })
    }
  }
  if (changed === 0) return 0
  db.exec('DELETE FROM thread_watch')
  const ins = db.query(
    'INSERT INTO thread_watch (session, target, what, idle, wake, name, at, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const r of merged.values()) ins.run(r.session, r.target, r.what, r.idle, r.wake, r.name, r.at, r.since)
  return changed
}

function rekeyThreadCursor(db: Database, from: string, to: string): number {
  const rows = db.query('SELECT session, seq, at, asked FROM thread_cursor').all() as CursorDbRow[]
  let changed = 0
  const merged = new Map<string, CursorDbRow>()
  for (const r of rows) {
    const nextSession = rekeyKey(r.session, from, to)
    if (nextSession !== r.session) changed++
    const prev = merged.get(nextSession)
    if (!prev) {
      merged.set(nextSession, { ...r, session: nextSession })
    } else {
      merged.set(nextSession, {
        session: nextSession,
        seq: Math.max(prev.seq, r.seq),
        at: Math.max(prev.at, r.at),
        asked: Math.max(prev.asked, r.asked),
      })
    }
  }
  if (changed === 0) return 0
  db.exec('DELETE FROM thread_cursor')
  const ins = db.query('INSERT INTO thread_cursor (session, seq, at, asked) VALUES (?, ?, ?, ?)')
  for (const r of merged.values()) ins.run(r.session, r.seq, r.at, r.asked)
  return changed
}

/**
 * Rekey every session-key column in `board.db` inside ONE write transaction (`BEGIN IMMEDIATE`).
 * Takes and verifies `opts.backupFile` under that same write lock before mutating any row.
 */
export function applyDbRekey(
  db: BoardDb,
  from: string,
  to: string,
  opts: { backupFile?: string; by?: string } = {},
): DbRekeySummary {
  return db.write(opts.by ?? 'db-rekey', tx => {
    const last = lastDbRekey(tx.db)
    if (last?.from === from && last?.to === to) return { already: true, total: 0, tables: [] }

    if (opts.backupFile) {
      writeWhole(opts.backupFile, tx.db.serialize())
      const whole = integrityOf(opts.backupFile)
      if (!whole.ok) throw new Error(`backup verification failed: ${whole.detail}`)
    }

    const present = new Set(tableNames(tx.db))
    const tables: TableRekeyCount[] = []
    let total = 0

    for (const [table, spec] of Object.entries(DB_SCHEMA_COLUMNS)) {
      if (!present.has(table)) continue
      if (table === 'thread_watch') {
        const rows = rekeyThreadWatch(tx.db, from, to)
        if (rows > 0) {
          tables.push({ table, column: 'session', rows })
          total += rows
        }
        continue
      }
      if (table === 'thread_cursor') {
        const rows = rekeyThreadCursor(tx.db, from, to)
        if (rows > 0) {
          tables.push({ table, column: 'session', rows })
          total += rows
        }
        continue
      }

      const actualCols = new Set(tableColumns(tx.db, table))
      const active = Object.entries(spec.columns).filter(([, kind]) => kind !== 'none')
      const cols = active.filter(([col]) => actualCols.has(col))
      if (!cols.length) continue

      const colCounts = new Map<string, number>(cols.map(([c]) => [c, 0]))
      const selectCols = cols.map(([c]) => q(c)).join(', ')
      const rows = tx.db.query(`SELECT rowid AS _rowid, ${selectCols} FROM ${q(table)}`).all() as Record<
        string,
        unknown
      >[]

      for (const row of rows) {
        const updates: { col: string; value: string }[] = []
        for (const [col, kind] of cols) {
          const raw = row[col]
          if (raw === null || raw === undefined) continue
          const str = typeof raw === 'string' ? raw : String(raw)
          const r = rekeyColumnValue(kind, str, from, to)
          if (r.changed && r.value !== null) {
            updates.push({ col, value: r.value })
            colCounts.set(col, (colCounts.get(col) ?? 0) + 1)
          }
        }
        if (updates.length) {
          const sets = updates.map(u => `${q(u.col)} = ?`).join(', ')
          const vals = updates.map(u => u.value)
          tx.db.query(`UPDATE ${q(table)} SET ${sets} WHERE rowid = ?`).run(...vals, row._rowid as number)
        }
      }

      for (const [col, count] of colCounts) {
        if (count > 0) {
          tables.push({ table, column: col, rows: count })
          total += count
        }
      }
    }

    tx.journal({
      store: 'db',
      op: 'rekey',
      ref: 'db',
      before: { master: from },
      after: { from, to, master: to, total, tables },
    })

    return { already: false, total, tables }
  })
}
