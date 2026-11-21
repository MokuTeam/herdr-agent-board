// The away journal's records (#489, core/journal.ts): journal.db in the board's state folder, a
// file of its own like board-events.db (#447). It is the history of the live board, not content:
// a restore of board.db does not roll it back, and a card's move does not count as a change of
// board.db for its backup. Opened only while config.json has `journal`; a board without it never
// makes the file. The web board keeps one connection for its life and writes; `board journal`
// opens it to read (WAL lets both go on).
//
//   moves       one row per change of a card's state: key, name and lane then, kind, line, when
//   last_state  each card's state on record (`gone`: when it left the board), what a refresh is
//               compared with, so a restart records only what really changed
//   marks       left / back: when the owner last went away and came back; strip: the return the
//               page shows ({ from, to, dismissed }); start: when recording began
import { join } from 'node:path'
import type { AwayMarks, JournalKind, Move, StateRow } from '../core/journal.ts'
import { type BoardDb, openDb } from './db.ts'
import { MIGRATIONS } from './db-schema.ts'
import { stateDir } from './paths.ts'

const STORE = 'journal'

const JOURNAL_MIGRATIONS = [
  ...MIGRATIONS.slice(0, 1),
  {
    version: 2,
    store: STORE,
    sql: `
      CREATE TABLE moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        lane TEXT NOT NULL,
        kind TEXT NOT NULL,
        line TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX moves_by_at ON moves (at);
      CREATE TABLE last_state (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        line TEXT NOT NULL,
        name TEXT NOT NULL,
        lane TEXT NOT NULL,
        at INTEGER NOT NULL,
        gone INTEGER
      ) STRICT;
      CREATE TABLE marks (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `,
  },
]

export const journalFile = (): string => join(stateDir(), 'journal.db')

/** The journal's file; null when it is not there and `create` is false. */
export const openJournalDb = (create = true): BoardDb | null =>
  openDb({ path: journalFile(), create, steps: JOURNAL_MIGRATIONS })

/** The return the page shows: the absence it covers, and whether the owner dismissed it. */
export interface StripMark {
  from: number
  to: number
  dismissed: boolean
}

type MoveRow = Omit<Move, 'kind'> & { kind: string }
type StateDbRow = Omit<StateRow, 'kind'> & { key: string; kind: string }

export function journalStore(db: BoardDb) {
  const mark = (name: string): string | undefined =>
    db.db.query<{ value: string }, [string]>('SELECT value FROM marks WHERE name = ?').get(name)?.value
  const num = (name: string): number | undefined => {
    const v = Number(mark(name))
    return mark(name) !== undefined && Number.isFinite(v) ? v : undefined
  }
  return {
    /** Every card's state on record. */
    states(): Map<string, StateRow> {
      const rows = db.db.query<StateDbRow, []>('SELECT key, kind, line, name, lane, at, gone FROM last_state').all()
      return new Map(rows.map(({ key, ...s }) => [key, { ...s, kind: s.kind as JournalKind }]))
    },
    /** The moves at or after `since`, in the order they were recorded. */
    movesSince(since: number): Move[] {
      return db.db
        .query<MoveRow, [number]>('SELECT key, name, lane, kind, line, at FROM moves WHERE at >= ? ORDER BY id')
        .all(since)
        .map(m => ({ ...m, kind: m.kind as JournalKind }))
    },
    /**
     * One refresh, in one transaction: its moves, the changed states, the cards whose key changed
     * (`renames`, old to new: their moves and state go under the new key), and the start mark of
     * the refresh that seeded the journal.
     */
    record(
      moves: readonly Move[],
      states: ReadonlyMap<string, StateRow>,
      { renames = [], start }: { renames?: readonly (readonly [string, string])[]; start?: number } = {},
    ): void {
      if (!moves.length && !states.size && !renames.length && start === undefined) return
      db.write(STORE, ({ db: sql }) => {
        const rekey = sql.query('UPDATE moves SET key = ? WHERE key = ?')
        const drop = sql.query('DELETE FROM last_state WHERE key = ?')
        for (const [from, to] of renames) {
          rekey.run(to, from)
          drop.run(from)
        }
        if (start !== undefined)
          sql
            .query('INSERT INTO marks VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
            .run('start', String(start))
        const insert = sql.query('INSERT INTO moves (key, name, lane, kind, line, at) VALUES (?, ?, ?, ?, ?, ?)')
        for (const m of moves) insert.run(m.key, m.name, m.lane, m.kind, m.line, m.at)
        const upsert =
          sql.query(`INSERT INTO last_state (key, kind, line, name, lane, at, gone) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, line=excluded.line, name=excluded.name,
          lane=excluded.lane, at=excluded.at, gone=excluded.gone`)
        for (const [key, s] of states) upsert.run(key, s.kind, s.line, s.name, s.lane, s.at, s.gone)
      })
    },
    /** Moves older than `before`, and the states of cards gone from the board before it, removed. */
    prune(before: number): number {
      return db.write(STORE, ({ db: sql }) => {
        const moves = sql.query('DELETE FROM moves WHERE at < ?').run(before).changes
        const gone = sql.query('DELETE FROM last_state WHERE gone IS NOT NULL AND gone < ?').run(before).changes
        return moves + gone
      })
    },
    /** When recording began (the first refresh that noted the cards), null before. */
    start: (): number | null => num('start') ?? null,
    away: (): AwayMarks => {
      const left = num('left')
      const back = num('back')
      return { ...(left !== undefined && { left }), ...(back !== undefined && { back }) }
    },
    strip(): StripMark | null {
      try {
        const s = JSON.parse(mark('strip') ?? 'null') as StripMark | null
        return s && typeof s.from === 'number' && typeof s.to === 'number' ? { ...s, dismissed: !!s.dismissed } : null
      } catch {
        return null
      }
    },
    /** Marks set together; a value already on record writes nothing. */
    setMarks(values: { left?: number; back?: number; start?: number; strip?: StripMark }): void {
      const want = Object.entries(values)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, typeof v === 'number' ? String(v) : JSON.stringify(v)] as const)
        .filter(([k, v]) => mark(k) !== v)
      if (!want.length) return
      db.write(STORE, ({ db: sql }) => {
        const put = sql.query('INSERT INTO marks VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        for (const [k, v] of want) put.run(k, v)
      })
    },
  }
}

export type JournalStore = ReturnType<typeof journalStore>
