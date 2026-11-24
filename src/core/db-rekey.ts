// Master move (#696): pure session-key rewriting rules for board.db, schedule entries, watches,
// legacy move marks, and owner-watch state. When the master role moves from `from` to `to`, every
// key relative to the master flips: local `<id>` becomes `@<from>:<id>`, `@<to>:<id>` becomes
// local `<id>`, and keys on any other device `@<other>:<id>` stay as they are.
//
// Zero I/O and no `node:` imports so tests and callers can inspect schema coverage directly.
import { DECISIONS_FROM } from './decisions.ts'
import { isDevice, LOCAL, parseNodeKey } from './node-key.ts'
import { ASKS_FROM } from './owner-watch.ts'
import type { ScheduleEntry } from './schedule-rules.ts'
import { TEAM } from './team-agents.ts'
import type { Card } from './types.ts'
import { WATCH_FROM } from './watches.ts'
import { EVENT_FROM, isParty } from './work-threads.ts'

/** What one column of board.db holds with respect to session keys. */
export type ColumnRekeyKind =
  | 'none'
  | 'key'
  | 'key-pk'
  | 'json-party'
  | 'json-actor'
  | 'json-proposed'
  | 'json-scope'
  | 'json-state'
  | 'json-verify'
  | 'json-entry-set'

export interface TableSchemaSpec {
  /** Lazy tables created outside db-schema.ts MIGRATIONS (e.g. Workdesk integration tables). */
  optional?: true
  columns: Readonly<Record<string, ColumnRekeyKind>>
}

/**
 * Exhaustive catalog of every table and column in board.db.
 * A schema-scan test fails whenever a migration or store adds a column without listing it here,
 * so new session-key columns cannot be silently missed during a master move.
 */
export const DB_SCHEMA_COLUMNS: Readonly<Record<string, TableSchemaSpec>> = {
  journal: {
    columns: {
      seq: 'none',
      at: 'none',
      by: 'none',
      store: 'none',
      op: 'none',
      ref: 'none',
      before: 'none',
      after: 'none',
    },
  },
  time_entries: {
    columns: {
      id: 'none',
      client: 'none',
      project: 'none',
      description: 'none',
      tags: 'none',
      start: 'none',
      stop: 'none',
      date: 'none',
      by: 'json-actor',
      at: 'none',
      changed: 'none',
      changed_by: 'json-actor',
      rev: 'none',
      deleted: 'none',
      toggl: 'none',
      billable: 'none',
    },
  },
  time_marks: {
    columns: {
      entry: 'none',
      system: 'none',
      at: 'none',
      by: 'json-actor',
      record: 'none',
      rev: 'none',
    },
  },
  cal_events: {
    columns: {
      id: 'none',
      title: 'none',
      start: 'none',
      end: 'none',
      all_day: 'none',
      location: 'none',
      join_url: 'none',
      note: 'none',
      by: 'json-actor',
      at: 'none',
      changed: 'none',
      changed_by: 'json-actor',
      rev: 'none',
      deleted: 'none',
    },
  },
  threads: {
    columns: {
      id: 'none',
      key: 'none',
      lane: 'none',
      title: 'none',
      summary: 'none',
      status: 'none',
      waiting_on: 'none',
      proposed: 'json-proposed',
      assignee: 'json-party',
      parent: 'none',
      scope: 'json-scope',
      created_by: 'json-party',
      created_at: 'none',
      updated_at: 'none',
      done_at: 'none',
      rev: 'none',
      origin: 'none',
      ref: 'none',
      state: 'json-state',
      verify: 'json-verify',
    },
  },
  thread_entries: {
    columns: {
      id: 'none',
      thread: 'none',
      n: 'none',
      seq: 'none',
      at: 'none',
      author: 'json-party',
      type: 'none',
      text: 'none',
      fields: 'json-entry-set',
      links: 'none',
      files: 'none',
      reply_to: 'none',
      private: 'none',
      closed: 'none',
      out: 'none',
    },
  },
  thread_seq: {
    columns: {
      lane: 'none',
      n: 'none',
    },
  },
  thread_watch: {
    columns: {
      session: 'key-pk',
      target: 'none',
      what: 'none',
      idle: 'none',
      wake: 'none',
      name: 'none',
      at: 'none',
      since: 'none',
    },
  },
  thread_cursor: {
    columns: {
      session: 'key-pk',
      seq: 'none',
      at: 'none',
      asked: 'none',
    },
  },
  workdesk_dialog_bindings: {
    columns: {
      task_id: 'none',
      assignment_id: 'none',
      executor: 'none',
      thread_id: 'none',
      // Native Herdr SID, not a master-relative board key.
      sid: 'none',
      revision: 'none',
    },
  },
  workdesk_dialog_cursor: {
    columns: {
      singleton: 'none',
      cursor: 'none',
    },
  },
  workdesk_dialog_events: {
    columns: {
      id: 'none',
      board_task_id: 'none',
      assignment_id: 'none',
      revision: 'none',
      executor: 'none',
      board_status: 'none',
      kind: 'none',
      created_at: 'none',
      noticed: 'none',
    },
  },
  decisions: {
    columns: {
      id: 'none',
      session: 'key',
      name: 'none',
      lane: 'none',
      thread: 'none',
      question: 'none',
      options: 'none',
      recommend: 'none',
      default_ms: 'none',
      default_at: 'none',
      entry: 'none',
      held: 'none',
      asked_at: 'none',
      answer: 'none',
      answered_by: 'none',
      via: 'none',
      answered_at: 'none',
    },
  },
  workdesk_handoffs: {
    optional: true,
    columns: {
      task_id: 'none',
      executor: 'none',
      session_key: 'key',
      thread_id: 'none',
      schedule_id: 'none',
      released: 'none',
    },
  },
  workdesk_workers: {
    optional: true,
    columns: {
      // Native Herdr SIDs, not master-relative board keys.
      worker_sid: 'none',
      master_sid: 'none',
    },
  },
  workdesk_worker_coverage: {
    optional: true,
    columns: {
      master_sid: 'none',
    },
  },
}

/** Validate `from` (old master device id) and `to` (new master device id). */
export function validateRekeyDevices(
  from: string | undefined,
  to: string | undefined,
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const f = (from ?? '').trim()
  const t = (to ?? '').trim()
  if (!f || !t) return { ok: false, error: 'both --from and --to device ids are required' }
  if (!isDevice(f))
    return {
      ok: false,
      error: `invalid --from device id "${f}": use lowercase letters, digits and hyphens (1-32 chars, not "local")`,
    }
  if (!isDevice(t))
    return {
      ok: false,
      error: `invalid --to device id "${t}": use lowercase letters, digits and hyphens (1-32 chars, not "local")`,
    }
  if (f === t) return { ok: false, error: `--from and --to must name different devices (both are "${f}")` }
  return { ok: true, from: f, to: t }
}

/**
 * Rewrite one session key for a master move from `from` to `to`:
 * - unprefixed `<id>` (was local on `from`) -> `@<from>:<id>`
 * - `@<to>:<id>` (was on node `to`, now local on `to`) -> `<id>`
 * - `@<other>:<id>` (including `@<from>:<id>`) -> unchanged
 */
export function rekeyKey(key: string, from: string, to: string): string {
  if (!key) return key
  const at = parseNodeKey(key)
  if (!at) return `@${from}:${key}`
  if (at.device === to) return at.key
  return key
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const parseJson = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

/** Rewrite a `Party` when it is `{ kind: 'session', key, ... }`. */
export function rekeyParty(party: unknown, from: string, to: string): { value: unknown; changed: boolean } {
  if (!isParty(party) || party.kind !== 'session' || !party.key) return { value: party, changed: false }
  const next = rekeyKey(party.key, from, to)
  if (next === party.key) return { value: party, changed: false }
  return { value: { ...party, key: next }, changed: true }
}

/** Rewrite an `Actor` column (`time_entries` / `cal_events`): `'user'`, `'import'`, or JSON `{ key, name }`. */
export function rekeyActorText(raw: string, from: string, to: string): { value: string; changed: boolean } {
  if (!raw || raw === 'user' || raw === 'import') return { value: raw, changed: false }
  const parsed = parseJson(raw)
  if (!parsed.ok || !isObj(parsed.value)) return { value: raw, changed: false }
  const key = parsed.value.key
  if (typeof key !== 'string' || !key) return { value: raw, changed: false }
  const next = rekeyKey(key, from, to)
  if (next === key) return { value: raw, changed: false }
  return { value: JSON.stringify({ ...parsed.value, key: next }), changed: true }
}

/** Rewrite a single column value according to its `ColumnRekeyKind`. */
export function rekeyColumnValue(
  kind: ColumnRekeyKind,
  raw: string | null,
  from: string,
  to: string,
): { value: string | null; changed: boolean } {
  if (raw === null || kind === 'none') return { value: raw, changed: false }
  if (kind === 'key' || kind === 'key-pk') {
    const next = rekeyKey(raw, from, to)
    return { value: next, changed: next !== raw }
  }
  if (kind === 'json-actor') return rekeyActorText(raw, from, to)

  const parsed = parseJson(raw)
  if (!parsed.ok) return { value: raw, changed: false }
  const val = parsed.value

  if (kind === 'json-party') {
    const r = rekeyParty(val, from, to)
    return r.changed ? { value: JSON.stringify(r.value), changed: true } : { value: raw, changed: false }
  }

  if (!isObj(val)) return { value: raw, changed: false }

  if (kind === 'json-proposed' || kind === 'json-state') {
    const r = rekeyParty(val.by, from, to)
    return r.changed
      ? { value: JSON.stringify({ ...val, by: r.value }), changed: true }
      : { value: raw, changed: false }
  }

  if (kind === 'json-scope') {
    if (val.kind !== 'local' || !isObj(val.request)) return { value: raw, changed: false }
    const r = rekeyParty(val.request.by, from, to)
    if (!r.changed) return { value: raw, changed: false }
    return { value: JSON.stringify({ ...val, request: { ...val.request, by: r.value } }), changed: true }
  }

  if (kind === 'json-verify') {
    if (!isObj(val.run) || typeof val.run.key !== 'string' || !val.run.key) return { value: raw, changed: false }
    const next = rekeyKey(val.run.key, from, to)
    if (next === val.run.key) return { value: raw, changed: false }
    return { value: JSON.stringify({ ...val, run: { ...val.run, key: next } }), changed: true }
  }

  if (kind === 'json-entry-set') {
    let changed = false
    const copy: Record<string, unknown> = { ...val }
    if ('assignee' in val && val.assignee !== null) {
      const r = rekeyParty(val.assignee, from, to)
      if (r.changed) {
        copy.assignee = r.value
        changed = true
      }
    }
    if (isObj(val.verifier) && typeof val.verifier.key === 'string' && val.verifier.key) {
      const next = rekeyKey(val.verifier.key, from, to)
      if (next !== val.verifier.key) {
        copy.verifier = { ...val.verifier, key: next }
        changed = true
      }
    }
    return changed ? { value: JSON.stringify(copy), changed: true } : { value: raw, changed: false }
  }

  return { value: raw, changed: false }
}

/** Synthetic `from.key` tags written by board subsystems, never real session keys. */
export const SYNTHETIC_FROM_KEYS: ReadonlySet<string> = new Set([
  EVENT_FROM.key,
  ASKS_FROM.key,
  WATCH_FROM.key,
  DECISIONS_FROM.key,
  'housekeeping',
  TEAM,
])

/** Rewrite session keys in a schedule entry or watch (`key`, non-synthetic `from.key`, `movedFrom.key`). */
export function rekeyScheduleEntry<T extends ScheduleEntry>(
  entry: T,
  from: string,
  to: string,
): { entry: T; changed: boolean; fields: string[] } {
  const fields: string[] = []
  let next: T = entry
  const touch = (): void => {
    if (next === entry) next = { ...entry }
  }

  const nextKey = rekeyKey(entry.key, from, to)
  if (nextKey !== entry.key) {
    touch()
    next.key = nextKey
    fields.push('key')
  }

  if (entry.from && typeof entry.from.key === 'string' && entry.from.key && !SYNTHETIC_FROM_KEYS.has(entry.from.key)) {
    const nextFromKey = rekeyKey(entry.from.key, from, to)
    if (nextFromKey !== entry.from.key) {
      touch()
      next.from = { ...entry.from, key: nextFromKey }
      fields.push('from')
    }
  }

  if (entry.movedFrom && typeof entry.movedFrom.key === 'string' && entry.movedFrom.key) {
    const nextMovedKey = rekeyKey(entry.movedFrom.key, from, to)
    if (nextMovedKey !== entry.movedFrom.key) {
      touch()
      next.movedFrom = { ...entry.movedFrom, key: nextMovedKey }
      fields.push('movedFrom')
    }
  }

  return { entry: next, changed: fields.length > 0, fields }
}

const LEGACY_MASTER = 'board'

/**
 * Rewrite legacy move marks on local cards (`card.moved.to === 'local'` or `'board'`) to point at
 * the old master device id `from`. Marks already naming a real device id stay as they are.
 */
export function rekeyMoveMark(card: Card, from: string, to: string): { card: Card; changed: boolean; fromTo?: string } {
  const m = card.moved
  if (!isObj(m) || typeof m.to !== 'string') return { card, changed: false }
  const cur = m.to.trim()
  const isLegacyBoard = cur === LEGACY_MASTER && from !== LEGACY_MASTER && to !== LEGACY_MASTER
  if (cur !== LOCAL && !isLegacyBoard) return { card, changed: false }
  return {
    card: { ...card, moved: { ...m, to: from } },
    changed: true,
    fromTo: cur,
  }
}

const CARD_PREFIX = 'card:'

function rekeyToldMap(
  raw: unknown,
  from: string,
  to: string,
): { map: Record<string, unknown>; changed: boolean; cards: number } {
  if (!isObj(raw)) return { map: {}, changed: false, cards: 0 }
  const out: Record<string, unknown> = {}
  let changed = false
  let cards = 0
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith(CARD_PREFIX)) {
      const rest = k.slice(CARD_PREFIX.length)
      const nextRest = rekeyKey(rest, from, to)
      const nextKey = `${CARD_PREFIX}${nextRest}`
      if (nextKey !== k) {
        changed = true
        cards++
      }
      out[nextKey] = v
    } else {
      out[k] = v
    }
  }
  return { map: out, changed, cards }
}

/** Rewrite session keys and `card:<key>` entries in `owner-watch.json`. */
export function rekeyOwnerWatchState(
  raw: Record<string, unknown>,
  from: string,
  to: string,
): { state: Record<string, unknown>; changed: boolean; sessions: number; cards: number } {
  const out: Record<string, unknown> = {}
  let changed = false
  let sessions = 0
  let cards = 0
  for (const [session, entry] of Object.entries(raw)) {
    const nextSession = rekeyKey(session, from, to)
    if (nextSession !== session) {
      changed = true
      sessions++
    }
    let nextEntry = entry
    if (isObj(entry)) {
      const told = rekeyToldMap(entry.told, from, to)
      const base = entry.base !== undefined ? rekeyToldMap(entry.base, from, to) : null
      if (told.changed || base?.changed) {
        changed = true
        cards += told.cards + (base?.cards ?? 0)
        nextEntry = {
          ...entry,
          ...(told.changed && { told: told.map }),
          ...(base?.changed && { base: base.map }),
        }
      }
    }
    const existing = out[nextSession]
    if (isObj(existing) && isObj(nextEntry) && Number(existing.at ?? 0) > Number(nextEntry.at ?? 0)) continue
    out[nextSession] = nextEntry
  }
  return { state: out, changed, sessions, cards }
}

export interface TableRekeyCount {
  table: string
  column: string
  rows: number
}

export interface ScheduleRekeyChange {
  id: string
  kind: 'entry' | 'watch'
  fromKey: string
  toKey: string
  fields: string[]
}

export interface MoveMarkChange {
  file: string
  key: string
  fromTo: string
  to: string
}

export interface RekeyReport {
  from: string
  to: string
  dryRun: boolean
  already: boolean
  backup: string | null
  db: {
    exists: boolean
    total: number
    tables: TableRekeyCount[]
  }
  schedule: {
    entries: ScheduleRekeyChange[]
    watches: ScheduleRekeyChange[]
  }
  moveMarks: MoveMarkChange[]
  ownerWatch: {
    exists: boolean
    sessions: number
    cards: number
  }
}

/** Human-readable lines for `board db rekey` CLI output (ASCII / middle-dot only). */
export function formatRekeyReport(r: RekeyReport): string[] {
  if (r.already) {
    return [`ok · already rekeyed from ${r.from} to ${r.to} (0 changes)`]
  }
  const lines: string[] = [
    r.dryRun ? `dry-run · rekey ${r.from} -> ${r.to} (no changes written)` : `ok · rekeyed ${r.from} -> ${r.to}`,
  ]
  if (r.backup) lines.push(`backup · ${r.backup}`)

  const totalDb = r.db.total
  const totalSched = r.schedule.entries.length + r.schedule.watches.length
  const totalMarks = r.moveMarks.length
  const totalOw = r.ownerWatch.sessions + r.ownerWatch.cards

  if (totalDb + totalSched + totalMarks + totalOw === 0) {
    lines.push(r.db.exists ? 'nothing to change' : 'no board.db or schedule entries to change')
    return lines
  }

  if (r.db.exists) {
    if (r.db.tables.length) {
      const detail = r.db.tables.map(t => `${t.table}.${t.column}: ${t.rows}`).join(', ')
      lines.push(`db · ${totalDb} change(s) (${detail})`)
    } else {
      lines.push('db · 0 changes')
    }
  }

  if (r.schedule.entries.length) {
    lines.push(`schedule · ${r.schedule.entries.length} entr${r.schedule.entries.length === 1 ? 'y' : 'ies'}`)
    if (r.dryRun) {
      for (const e of r.schedule.entries)
        lines.push(`  entry ${e.id}: ${e.fromKey} -> ${e.toKey} (${e.fields.join(', ')})`)
    }
  }
  if (r.schedule.watches.length) {
    lines.push(`watches · ${r.schedule.watches.length} watch${r.schedule.watches.length === 1 ? '' : 'es'}`)
    if (r.dryRun) {
      for (const w of r.schedule.watches)
        lines.push(`  watch ${w.id}: ${w.fromKey} -> ${w.toKey} (${w.fields.join(', ')})`)
    }
  }
  if (totalMarks) {
    lines.push(`move marks · ${totalMarks} card${totalMarks === 1 ? '' : 's'}`)
    if (r.dryRun) {
      for (const m of r.moveMarks) lines.push(`  card ${m.key || m.file}: moved.to ${m.fromTo} -> ${m.to}`)
    }
  }
  if (totalOw) {
    lines.push(`owner-watch · ${r.ownerWatch.sessions} session(s), ${r.ownerWatch.cards} card ref(s)`)
  }
  return lines
}
