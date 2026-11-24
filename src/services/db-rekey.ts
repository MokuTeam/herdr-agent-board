// Master move (#696): full orchestration of rekeying board.db, schedule/, schedule/watches/,
// legacy move marks on cards, and owner-watch.json, with dry-run, backup before write, and
// idempotent second runs.
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DbError, damageOf, dbFile, openDb } from '../adapters/db.ts'
import { applyDbRekey, planDbRekey } from '../adapters/db-rekey.ts'
import { LATEST } from '../adapters/db-schema.ts'
import { isRecord, readJson, replaceFile, updateJson } from '../adapters/json-store.ts'
import { cardsDir, scheduleDir, stateDir } from '../adapters/paths.ts'
import {
  type MoveMarkChange,
  type RekeyReport,
  rekeyMoveMark,
  rekeyOwnerWatchState,
  rekeyScheduleEntry,
  type ScheduleRekeyChange,
  validateRekeyDevices,
} from '../core/db-rekey.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { Card } from '../core/types.ts'
import { isWatch, type WatchEntry } from '../core/watches.ts'
import { forgetOwnerWatch, ownerWatchFile } from './owner-watch.ts'

const REKEY_BACKUPS_KEPT = 5
const HEX6 = /^[0-9a-f]{6}\.json$/

const stamp = (at: number): string =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

let backupsMade = 0

interface ScheduleMarker {
  from: string
  to: string
  at: number
  done: boolean
  completed: string[]
  watchesCompleted: string[]
}

const isScheduleMarker = (v: unknown): v is ScheduleMarker =>
  isRecord(v) &&
  typeof v.from === 'string' &&
  typeof v.to === 'string' &&
  typeof v.at === 'number' &&
  typeof v.done === 'boolean' &&
  Array.isArray(v.completed) &&
  Array.isArray(v.watchesCompleted)

interface RekeyStateMarker {
  last?: {
    from: string
    to: string
    at: number
    hadDb: boolean
  }
  ownerWatch?: {
    from: string
    to: string
    at: number
  }
}

const isRekeyStateMarker = (v: unknown): v is RekeyStateMarker =>
  isRecord(v) &&
  (v.last === undefined ||
    (isRecord(v.last) &&
      typeof v.last.from === 'string' &&
      typeof v.last.to === 'string' &&
      typeof v.last.at === 'number' &&
      typeof v.last.hadDb === 'boolean')) &&
  (v.ownerWatch === undefined ||
    (isRecord(v.ownerWatch) &&
      typeof v.ownerWatch.from === 'string' &&
      typeof v.ownerWatch.to === 'string' &&
      typeof v.ownerWatch.at === 'number'))

const isCorruptErr = (err: unknown): boolean => {
  const code = String((err as { code?: unknown } | null)?.code ?? '')
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB'
}

const isEntry = (v: unknown): v is ScheduleEntry =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  !!v.id &&
  typeof v.key === 'string' &&
  !!v.key &&
  typeof v.next === 'number'

const isWatchEntry = (v: unknown): v is WatchEntry => isEntry(v) && isWatch(v)
const isCard = (v: unknown): v is Card => isRecord(v)

function listHexFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(n => HEX6.test(n))
      .sort()
  } catch {
    return []
  }
}

function listCardFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(n => n.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

function pruneRekeyBackups(baseStateDir: string): void {
  try {
    const dirs = readdirSync(baseStateDir)
      .filter(n => n.startsWith('before-rekey-'))
      .map(n => {
        try {
          const p = join(baseStateDir, n)
          const st = statSync(p)
          return st.isDirectory() ? { n, p, at: st.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter((x): x is { n: string; p: string; at: number } => x !== null)
      .sort((a, b) => b.at - a.at)
    for (const old of dirs.slice(REKEY_BACKUPS_KEPT)) rmSync(old.p, { recursive: true, force: true })
  } catch {}
}

export interface RekeyBoardOptions {
  from: string
  to: string
  dryRun?: boolean
  by?: string
  now?: () => number
  paths?: {
    stateDir?: string
    dbFile?: string
    scheduleDir?: string
    cardsDir?: string
    ownerWatchFile?: string
  }
}

/**
 * Rekey all master-relative session keys in board.db, schedule/, schedule/watches/, legacy card
 * move marks, and owner-watch.json for a master move from `from` to `to`.
 *
 * - Never creates `board.db` or empty state files if absent.
 * - Dry-run opens `board.db` read-only and writes nothing anywhere.
 * - Real run verifies a full backup before mutating any state, and is idempotent on repeat runs.
 */
export function rekeyBoard(opts: RekeyBoardOptions): RekeyReport {
  const checked = validateRekeyDevices(opts.from, opts.to)
  if (!checked.ok) throw new Error(checked.error)
  const { from, to } = checked
  const dryRun = opts.dryRun === true
  const now = opts.now ?? Date.now

  const baseStateDir = opts.paths?.stateDir ?? stateDir()
  const dbPath = opts.paths?.dbFile ?? dbFile()
  const schedPath = opts.paths?.scheduleDir ?? scheduleDir()
  const watchesPath = join(schedPath, 'watches')
  const cardsPath = opts.paths?.cardsDir ?? cardsDir()
  const owPath = opts.paths?.ownerWatchFile ?? ownerWatchFile()

  const schedMarkerPath = join(schedPath, '.rekey.json')
  const stateMarkerPath = join(baseStateDir, 'rekey-state.json')

  const dbExists = existsSync(dbPath)
  let dbPlan = { already: false, total: 0, tables: [] as RekeyReport['db']['tables'] }
  if (dbExists) {
    const damaged = damageOf(dbPath)
    if (damaged !== null) throw new DbError('damaged', damaged)
    const raw = new Database(dbPath, { readonly: true, strict: true })
    try {
      const version = Number(
        (raw.query('PRAGMA user_version').get() as { user_version?: number } | null)?.user_version ?? 0,
      )
      if (version > LATEST) throw new DbError('newer')
      dbPlan = planDbRekey(raw, from, to)
    } catch (err) {
      if (err instanceof DbError) throw err
      if (isCorruptErr(err)) throw new DbError('damaged', String((err as Error).message))
      throw err
    } finally {
      raw.close(false)
    }
  }

  const stateMarker = readJson(stateMarkerPath, isRekeyStateMarker)
  const lastSamePair = stateMarker?.last?.from === from && stateMarker?.last?.to === to

  const entryFiles = listHexFiles(schedPath)
  const watchFiles = listHexFiles(watchesPath)
  const schedHasFiles = entryFiles.length > 0 || watchFiles.length > 0
  const schedMarker = readJson(schedMarkerPath, isScheduleMarker)
  const schedSamePair = schedMarker?.from === from && schedMarker?.to === to
  const schedDone = (schedSamePair && schedMarker?.done === true) || (lastSamePair && schedMarker === null)

  const entryChanges: ScheduleRekeyChange[] = []
  const watchChanges: ScheduleRekeyChange[] = []
  const completedEntries = new Set(schedSamePair ? (schedMarker?.completed ?? []) : [])
  const completedWatches = new Set(schedSamePair ? (schedMarker?.watchesCompleted ?? []) : [])

  if (!schedDone) {
    for (const file of entryFiles) {
      const e = readJson(join(schedPath, file), isEntry)
      if (!e || completedEntries.has(e.id)) continue
      const r = rekeyScheduleEntry(e, from, to)
      if (r.changed) {
        entryChanges.push({ id: e.id, kind: 'entry', fromKey: e.key, toKey: r.entry.key, fields: r.fields })
      }
    }
    for (const file of watchFiles) {
      const w = readJson(join(watchesPath, file), isWatchEntry)
      if (!w || completedWatches.has(w.id)) continue
      const r = rekeyScheduleEntry(w, from, to)
      if (r.changed) {
        watchChanges.push({ id: w.id, kind: 'watch', fromKey: w.key, toKey: r.entry.key, fields: r.fields })
      }
    }
  }

  const moveMarks: MoveMarkChange[] = []
  for (const file of listCardFiles(cardsPath)) {
    const c = readJson(join(cardsPath, file), isCard)
    if (!c) continue
    const r = rekeyMoveMark(c, from, to)
    if (r.changed) {
      moveMarks.push({ file, key: typeof c.key === 'string' ? c.key : '', fromTo: r.fromTo ?? '', to: from })
    }
  }

  const owExists = existsSync(owPath)
  const owDone = lastSamePair || (stateMarker?.ownerWatch?.from === from && stateMarker?.ownerWatch?.to === to)
  let owSessions = 0
  let owCards = 0
  if (owExists && !owDone) {
    const rawOw = readJson(owPath, isRecord)
    if (rawOw) {
      const r = rekeyOwnerWatchState(rawOw, from, to)
      owSessions = r.sessions
      owCards = r.cards
    }
  }

  // Idempotent detection: every present component must be marked done for `(from, to)`, with no
  // remaining legacy move marks, and at least one component (or completed board run) recorded.
  const dbDone = !dbExists || dbPlan.already || (lastSamePair && stateMarker?.last?.hadDb === false)
  const anyRecorded =
    lastSamePair ||
    (dbExists && dbPlan.already) ||
    ((schedHasFiles || schedMarker !== null) && schedDone) ||
    (owExists && owDone)
  const already =
    anyRecorded &&
    dbDone &&
    (!(schedHasFiles || schedMarker !== null) || schedDone) &&
    (!owExists || owDone) &&
    moveMarks.length === 0

  if (dryRun || already) {
    return {
      from,
      to,
      dryRun,
      already,
      backup: null,
      db: {
        exists: dbExists,
        total: dbPlan.total,
        tables: dbPlan.tables,
      },
      schedule: {
        entries: entryChanges,
        watches: watchChanges,
      },
      moveMarks,
      ownerWatch: {
        exists: owExists,
        sessions: owSessions,
        cards: owCards,
      },
    }
  }

  const at = now()
  const needsBackupDir = dbExists || schedHasFiles || moveMarks.length > 0 || owExists
  let backupDir: string | null = null
  if (needsBackupDir) {
    mkdirSync(baseStateDir, { recursive: true })
    backupDir = join(baseStateDir, `before-rekey-${from}-to-${to}-${stamp(at)}-${process.pid}-${++backupsMade}`)
    mkdirSync(backupDir, { recursive: true })
  }

  // 1. Database: single write transaction with verified backup inside the lock.
  let dbResult = { already: false, total: 0, tables: [] as RekeyReport['db']['tables'] }
  if (dbExists && !dbDone) {
    try {
      const live = openDb({ path: dbPath, create: false })
      if (live) {
        try {
          dbResult = applyDbRekey(live, from, to, {
            ...(backupDir && { backupFile: join(backupDir, 'board.db') }),
            by: opts.by ?? 'db-rekey',
          })
        } finally {
          live.close()
        }
      }
    } catch (err) {
      if (backupDir) rmSync(backupDir, { recursive: true, force: true })
      throw err
    }
  }

  // 2. Schedule entries and watches (with backup and incremental crash-safe `.rekey.json` marker).
  const appliedEntries: ScheduleRekeyChange[] = []
  const appliedWatches: ScheduleRekeyChange[] = []
  if ((schedHasFiles || schedMarker !== null) && !schedDone) {
    const doneIds = [...completedEntries]
    const doneWatchIds = [...completedWatches]
    const writeSchedMarker = (done: boolean): void => {
      mkdirSync(schedPath, { recursive: true })
      replaceFile(
        schedMarkerPath,
        JSON.stringify({
          from,
          to,
          at,
          done,
          completed: doneIds,
          watchesCompleted: doneWatchIds,
        } satisfies ScheduleMarker),
      )
    }

    if (entryFiles.length && backupDir) {
      mkdirSync(join(backupDir, 'schedule'), { recursive: true })
      for (const file of entryFiles) copyFileSync(join(schedPath, file), join(backupDir, 'schedule', file))
    }
    if (watchFiles.length && backupDir) {
      mkdirSync(join(backupDir, 'schedule', 'watches'), { recursive: true })
      for (const file of watchFiles) copyFileSync(join(watchesPath, file), join(backupDir, 'schedule', 'watches', file))
    }

    writeSchedMarker(false)

    for (const file of entryFiles) {
      const id = file.slice(0, -5)
      if (completedEntries.has(id)) continue
      let change: ScheduleRekeyChange | null = null
      updateJson(
        join(schedPath, file),
        (cur: ScheduleEntry | null) => {
          if (!cur) return undefined
          const r = rekeyScheduleEntry(cur, from, to)
          if (!r.changed) return undefined
          change = { id: cur.id, kind: 'entry', fromKey: cur.key, toKey: r.entry.key, fields: r.fields }
          return r.entry
        },
        isEntry,
        // Preserve 0600 on call reports holding receipts.
        readJson(join(schedPath, file), isEntry)?.receipt ? { mode: 0o600 } : undefined,
      )
      doneIds.push(id)
      writeSchedMarker(false)
      if (change) appliedEntries.push(change)
    }

    for (const file of watchFiles) {
      const id = file.slice(0, -5)
      if (completedWatches.has(id)) continue
      let change: ScheduleRekeyChange | null = null
      updateJson(
        join(watchesPath, file),
        (cur: WatchEntry | null) => {
          if (!cur) return undefined
          const r = rekeyScheduleEntry(cur, from, to)
          if (!r.changed) return undefined
          change = { id: cur.id, kind: 'watch', fromKey: cur.key, toKey: r.entry.key, fields: r.fields }
          return r.entry
        },
        isWatchEntry,
      )
      doneWatchIds.push(id)
      writeSchedMarker(false)
      if (change) appliedWatches.push(change)
    }

    writeSchedMarker(true)
  }

  // 3. Legacy card move marks (`moved.to === 'local' | 'board'`).
  const appliedMarks: MoveMarkChange[] = []
  if (moveMarks.length) {
    if (backupDir) mkdirSync(join(backupDir, 'cards'), { recursive: true })
    for (const m of moveMarks) {
      const cardFile = join(cardsPath, m.file)
      if (backupDir && existsSync(cardFile)) copyFileSync(cardFile, join(backupDir, 'cards', m.file))
      updateJson(
        cardFile,
        (cur: Card | null) => {
          if (!cur) return undefined
          const r = rekeyMoveMark(cur, from, to)
          if (!r.changed) return undefined
          appliedMarks.push({
            file: m.file,
            key: typeof cur.key === 'string' ? cur.key : '',
            fromTo: r.fromTo ?? '',
            to,
          })
          return r.card
        },
        isCard,
      )
    }
  }

  // 4. Owner-watch state (`owner-watch.json`), only when the file exists.
  let appliedOwSessions = 0
  let appliedOwCards = 0
  if (owExists && !owDone) {
    if (backupDir) copyFileSync(owPath, join(backupDir, 'owner-watch.json'))
    const rawOw = readJson(owPath, isRecord)
    if (rawOw) {
      const r = rekeyOwnerWatchState(rawOw, from, to)
      if (r.changed) {
        replaceFile(owPath, JSON.stringify(r.state), undefined, 0o600)
        forgetOwnerWatch()
        appliedOwSessions = r.sessions
        appliedOwCards = r.cards
      }
    }
  }

  if (needsBackupDir) {
    const prevState = readJson(stateMarkerPath, isRekeyStateMarker) ?? {}
    replaceFile(
      stateMarkerPath,
      JSON.stringify({
        ...prevState,
        last: { from, to, at, hadDb: dbExists },
        ...(owExists && { ownerWatch: { from, to, at } }),
      } satisfies RekeyStateMarker),
    )
  }

  if (backupDir) pruneRekeyBackups(baseStateDir)

  return {
    from,
    to,
    dryRun: false,
    already: false,
    backup: backupDir,
    db: {
      exists: dbExists,
      total: dbResult.total,
      tables: dbResult.tables,
    },
    schedule: {
      entries: appliedEntries,
      watches: appliedWatches,
    },
    moveMarks: appliedMarks,
    ownerWatch: {
      exists: owExists,
      sessions: appliedOwSessions,
      cards: appliedOwCards,
    },
  }
}
