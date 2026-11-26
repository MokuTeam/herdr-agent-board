// Decisions (#487) in the board's database (adapters/db-schema.ts, step 7): one row per `board ask`
// while `decisions` is on, from the question to how it closed. Each change goes through db.write
// with its journal row. A close takes only an open row, so of two that close one question at once
// (the page's click and the hook seeing the typed answer, say) the first is the one recorded.
import type { BoardDb } from './db.ts'

export type AnsweredBy = 'owner' | 'default' | 'withdrawn'
export type Via = 'button' | 'text' | 'prompt' | 'default' | 'replaced' | 'cleared'

export interface DecisionRow {
  id: string
  session: string
  name: string
  lane: string | null
  thread: string | null
  question: string
  options: string[]
  recommend: number | null
  defaultMs: number | null
  defaultAt: number | null
  entry: string | null
  held: number | null
  askedAt: number
  answer: string | null
  answeredBy: AnsweredBy | null
  via: Via | null
  answeredAt: number | null
}

type Raw = Record<string, unknown>
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function rowOf(r: Raw): DecisionRow {
  let options: string[] = []
  try {
    const v: unknown = JSON.parse(String(r.options ?? '[]'))
    if (Array.isArray(v)) options = v.filter((o): o is string => typeof o === 'string')
  } catch {}
  return {
    id: String(r.id),
    session: String(r.session),
    name: String(r.name ?? ''),
    lane: str(r.lane),
    thread: str(r.thread),
    question: String(r.question ?? ''),
    options,
    recommend: num(r.recommend),
    defaultMs: num(r.default_ms),
    defaultAt: num(r.default_at),
    entry: str(r.entry),
    held: num(r.held),
    askedAt: Number(r.asked_at) || 0,
    answer: str(r.answer),
    answeredBy: str(r.answered_by) as AnsweredBy | null,
    via: str(r.via) as Via | null,
    answeredAt: num(r.answered_at),
  }
}

export function getDecision(db: BoardDb, id: string): DecisionRow | null {
  const r = db.db.query('SELECT * FROM decisions WHERE id = ?').get(id) as Raw | null
  return r ? rowOf(r) : null
}

export type NewDecision = Pick<DecisionRow, 'id' | 'session' | 'question' | 'askedAt'> &
  Partial<Pick<DecisionRow, 'name' | 'lane' | 'thread' | 'options' | 'recommend' | 'defaultMs' | 'defaultAt' | 'entry'>>

export function insertDecision(db: BoardDb, d: NewDecision, by: string): DecisionRow {
  return db.write(by, tx => {
    tx.db
      .query(
        'INSERT INTO decisions (id, session, name, lane, thread, question, options, recommend, default_ms, default_at, entry, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        d.id,
        d.session,
        d.name ?? '',
        d.lane ?? null,
        d.thread ?? null,
        d.question,
        JSON.stringify(d.options ?? []),
        d.recommend ?? null,
        d.defaultMs ?? null,
        d.defaultAt ?? null,
        d.entry ?? null,
        d.askedAt,
      )
    const after = getDecision(db, d.id)
    tx.journal({ store: 'decisions', op: 'ask', ref: d.id, after })
    return after as DecisionRow
  })
}

/** Closes an open row; false when it was closed already (or is not there). */
export function closeDecision(
  db: BoardDb,
  id: string,
  close: { answer: string | null; answeredBy: AnsweredBy; via: Via; at: number },
  by: string,
): boolean {
  return db.write(by, tx => {
    const before = getDecision(db, id)
    if (!before || before.answeredAt !== null) return false
    tx.db
      .query(
        'UPDATE decisions SET answer = ?, answered_by = ?, via = ?, answered_at = ?, default_at = NULL WHERE id = ? AND answered_at IS NULL',
      )
      .run(close.answer, close.answeredBy, close.via, close.at, id)
    tx.journal({ store: 'decisions', op: 'close', ref: id, before, after: getDecision(db, id) })
    return true
  })
}

/** Hold: the default is off, the question stays open. False when it is not open. */
export function holdDecision(db: BoardDb, id: string, at: number, by: string): boolean {
  return db.write(by, tx => {
    const before = getDecision(db, id)
    if (!before || before.answeredAt !== null) return false
    tx.db.query('UPDATE decisions SET held = ?, default_at = NULL WHERE id = ?').run(at, id)
    tx.journal({ store: 'decisions', op: 'hold', ref: id, before, after: getDecision(db, id) })
    return true
  })
}

export function openDecisions(db: BoardDb): DecisionRow[] {
  return (db.db.query('SELECT * FROM decisions WHERE answered_at IS NULL ORDER BY asked_at').all() as Raw[]).map(rowOf)
}

/** Open decisions linked to `thread`, optionally narrowed to `session`. */
export function openThreadDecisions(db: BoardDb, thread: string, session?: string): DecisionRow[] {
  const sql =
    session === undefined
      ? 'SELECT * FROM decisions WHERE answered_at IS NULL AND thread = ? ORDER BY asked_at'
      : 'SELECT * FROM decisions WHERE answered_at IS NULL AND thread = ? AND session = ? ORDER BY asked_at'
  const rows = (session === undefined ? db.db.query(sql).all(thread) : db.db.query(sql).all(thread, session)) as Raw[]
  return rows.map(rowOf)
}

/** The closed ones, newest first: a session's, those the default answered since `since`, or all. */
export function closedDecisions(
  db: BoardDb,
  o: { session?: string; by?: AnsweredBy; since?: number; limit?: number } = {},
): DecisionRow[] {
  const where = ['answered_at IS NOT NULL']
  const args: (string | number)[] = []
  if (o.session !== undefined) {
    where.push('session = ?')
    args.push(o.session)
  }
  if (o.by !== undefined) {
    where.push('answered_by = ?')
    args.push(o.by)
  }
  if (o.since !== undefined) {
    where.push('answered_at > ?')
    args.push(o.since)
  }
  args.push(Math.max(1, Math.min(200, o.limit ?? 20)))
  return (
    db.db
      .query(`SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY answered_at DESC LIMIT ?`)
      .all(...args) as Raw[]
  ).map(rowOf)
}
