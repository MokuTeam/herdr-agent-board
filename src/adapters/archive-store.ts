// The archive on disk: one small JSON file per session taken off the board, in the state folder's
// archive/, written under the same per-file lock as the cards (json-store.ts updateJson), and
// log.jsonl beside them, what became of the latest ones (the page's toasts). What a record holds
// and what it goes through is core/archive.ts and services/archive.ts.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchiveLogEntry, ArchiveRecord } from '../core/archive.ts'
import { removeCard } from './cards.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { archiveDir, contextDir } from './paths.ts'

const safe = (key: string): string => String(key).replace(/[^A-Za-z0-9_-]/g, '_')
const fileOf = (key: string): string => join(archiveDir(), `${safe(key)}.json`)
const logFile = (): string => join(archiveDir(), 'log.jsonl')

const STATES: ReadonlySet<unknown> = new Set(['closing', 'archived', 'restoring'])

/** A record as its file holds it: a key, a session, a state; its held entries a list (none: an empty one when read). */
const isArchiveRecord = (v: unknown): v is ArchiveRecord =>
  isRecord(v) &&
  typeof v.key === 'string' &&
  !!v.key &&
  typeof v.session === 'string' &&
  STATES.has(v.state) &&
  (v.held === undefined || Array.isArray(v.held))

/** The record with its held entries as a list: a file written without them has none. */
const withHeld = (r: ArchiveRecord): ArchiveRecord => (Array.isArray(r.held) ? r : { ...r, held: [] })

/** The file names of the records: cheap, for the board's refresh to tell which items to look up. */
export function archivedFiles(): Set<string> {
  try {
    return new Set(readdirSync(archiveDir()).filter(n => n.endsWith('.json')))
  } catch {
    return new Set()
  }
}

/** Whether `files` (archivedFiles) has a record for the key. */
export const isArchived = (files: ReadonlySet<string>, key: string): boolean => files.has(`${safe(key)}.json`)

/** The session's record, or null. */
export function getArchived(key: string): ArchiveRecord | null {
  const r = readJson(fileOf(key), isArchiveRecord)
  return r && withHeld(r)
}

/** Every record, newest first. */
export function listArchive(): ArchiveRecord[] {
  const list: ArchiveRecord[] = []
  for (const name of archivedFiles()) {
    const r = readJson(join(archiveDir(), name), isArchiveRecord)
    if (r) list.push(withHeld(r))
  }
  return list.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/**
 * Change a record under its lock. `change(record)` gets the record (null when there is none) and
 * returns the new one, null to delete it, or undefined to leave it as it is. Returns what it returned.
 */
export function updateArchived(
  key: string,
  change: (current: ArchiveRecord | null) => ArchiveRecord | null | undefined,
): ArchiveRecord | null | undefined {
  mkdirSync(archiveDir(), { recursive: true })
  return updateJson(fileOf(key), r => change(r && withHeld(r)), isArchiveRecord)
}

/**
 * A session's own files the board keeps, gone with its record ("Remove from archive"): its card
 * and the context fill the status line kept. Claude's own folders are never touched.
 */
export function removeSessionFiles(key: string): void {
  removeCard(key)
  try {
    unlinkSync(join(contextDir(), `${safe(key)}.json`))
  } catch {}
}

// ------------------------------------------------------------------ what happened, for the page

const LOG_KEEP = 60

/** One line of the log; it is cut back to the newest LOG_KEEP now and then. */
export function logArchive(entry: ArchiveLogEntry): void {
  try {
    mkdirSync(archiveDir(), { recursive: true })
    appendFileSync(logFile(), `${JSON.stringify(entry)}\n`)
    const lines = readFileSync(logFile(), 'utf8').split('\n').filter(Boolean)
    if (lines.length > LOG_KEEP * 1.5) writeFileSync(logFile(), `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch {}
}

const isLogEntry = (v: unknown): v is ArchiveLogEntry =>
  isRecord(v) && typeof v.key === 'string' && typeof v.result === 'string'

/** The newest `limit` events, newest first. */
export function readArchiveLog(limit = 10): ArchiveLogEntry[] {
  try {
    return readFileSync(logFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .flatMap(line => {
        try {
          const entry: unknown = JSON.parse(line)
          return isLogEntry(entry) ? [entry] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
