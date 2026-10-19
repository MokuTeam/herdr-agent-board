// Opt-in idempotency for call exports (`board call-report --report-id`). This journals transport
// attempts, not agent execution. No automatic expiry: forgetting a report id would make an old
// retry unsafe to replay. One journal for the board, whatever profile a session runs in: a report
// is keyed by its session's UUID, which no two profiles share.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export const receiptsFile = (): string => join(stateDir(), 'call-receipts.json')
export const MAX_RECEIPTS = 1000
export const MAX_REPORT_BYTES = 1024 * 1024
const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const ENTRY_ID = /^[0-9a-f]{6}$/
const STATES = ['queued', 'dispatching', 'sent', 'delivery-unknown', 'cancelled', 'missed'] as const
export type ReceiptState = (typeof STATES)[number]
const isState = (s: unknown): s is ReceiptState => STATES.some(state => state === s)

/** A report's session and id; `key` is the journal's key for the pair. */
export type ReportKey = { key: string; session: string; reportId: string }
/** The same with the hash of the report's full normalized text: a queue entry's `receipt`. */
export type ReportIdentity = ReportKey & { hash: string }
/** A journal record: the identity, its queue entry, and how far its delivery got. */
export type Receipt = ReportIdentity & {
  entryId: string
  state: ReceiptState
  createdAt?: number
  updatedAt?: number
  [extra: string]: unknown
}
type Journal = { version: 1; records: Record<string, Receipt>; [extra: string]: unknown }
/** A queue entry as far as receipts go: its id, its session's key and the identity it carries. */
export type ReceiptEntry = { id: string; key: string; receipt?: unknown }

export const reportHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A report's session (lower-cased) and id, checked; with `hash`, the identity an entry carries. */
export function reportIdentity(session: string, reportId: string): ReportKey
export function reportIdentity(session: string, reportId: string, hash: string): ReportIdentity
export function reportIdentity(session: string, reportId: string, hash?: string): ReportKey | ReportIdentity {
  if (!UUID.test(session) || !REPORT_ID.test(reportId))
    throw new Error(
      'report-id must be 1–128 letters, digits, dots, colons, underscores or hyphens; session must be a UUID',
    )
  const lower = session.toLowerCase()
  const key = reportHash(`${lower}\n${reportId}`)
  return hash === undefined ? { key, session: lower, reportId } : { key, session: lower, reportId, hash }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
/** The identity a queue entry carries, as read from its file: a field that is not text is ''. */
function identityOf(entry: ReceiptEntry): ReportIdentity {
  const r = isRecord(entry.receipt) ? entry.receipt : {}
  return { key: text(r.key), session: text(r.session), reportId: text(r.reportId), hash: text(r.hash) }
}

const isReceipt = (key: string, r: unknown): r is Receipt =>
  isRecord(r) &&
  typeof r.hash === 'string' &&
  HASH.test(r.hash) &&
  typeof r.session === 'string' &&
  UUID.test(r.session) &&
  r.session === r.session.toLowerCase() &&
  typeof r.reportId === 'string' &&
  REPORT_ID.test(r.reportId) &&
  key === reportHash(`${r.session}\n${r.reportId}`) &&
  r.key === key &&
  typeof r.entryId === 'string' &&
  ENTRY_ID.test(r.entryId) &&
  isState(r.state)
const isJournal = (v: unknown): v is Journal =>
  isRecord(v) && v.version === 1 && isRecord(v.records) && Object.entries(v.records).every(([k, r]) => isReceipt(k, r))

/** The journal as read (null: none, or not one): none yet is empty; anything else is refused. */
function validate(saved: Journal | null): Journal {
  if (saved) return saved
  if (!existsSync(receiptsFile())) return { version: 1, records: {} }
  throw new Error('call receipt journal is missing or corrupt; refusing automatic replay')
}

/** `fn` on the journal's records, under its lock, then saved (0600); returns what `fn` returned. */
function change<T>(fn: (records: Record<string, Receipt>) => T): T {
  mkdirSync(stateDir(), { recursive: true })
  let result: { value: T } | undefined
  try {
    updateJson(
      receiptsFile(),
      (saved: Journal | null) => {
        const journal = validate(saved)
        result = { value: fn(journal.records) }
        return journal
      },
      isJournal,
      { mode: 0o600, recoverStale: false },
    )
  } catch (err) {
    if (err instanceof Error && /Timed out waiting for lock:/.test(err.message))
      err.message += '; stop receipt writers and reconcile interrupted exports before removing a stale receipt lock'
    throw err
  }
  if (!result) throw new Error('call receipt journal was not changed')
  return result.value
}

const mark = (saved: Receipt, state: ReceiptState): void => {
  saved.state = state
  saved.updatedAt = Date.now()
}

export function getReceipt(session: string, reportId: string): Receipt | null {
  const { key } = reportIdentity(session, reportId)
  return validate(readJson(receiptsFile(), isJournal)).records[key] ?? null
}

/** The report file for a retry-safe report: more than MAX_REPORT_BYTES is refused unread. */
export function readReport(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1)
    let size = 0
    let count: number
    do {
      count = readSync(fd, buffer, size, buffer.length - size, null)
      size += count
    } while (count && size < buffer.length)
    if (size > MAX_REPORT_BYTES) throw new Error(`report exceeds ${MAX_REPORT_BYTES} bytes`)
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The schedule as enqueueReport sees it (given by the caller: the schedule store settles receipts). */
export type ReportQueue = {
  findEntry(key: string): ReceiptEntry | undefined
  createEntry(identity: ReportIdentity): { id: string }
}

// createEntry runs under the receipt journal lock. A crash between entry creation and journal
// persistence leaves an orphan, recovered as unknown rather than silently risking a replay.
export function enqueueReport(
  identity: ReportIdentity,
  { findEntry, createEntry }: ReportQueue,
): Receipt & { reused?: boolean } {
  return change(records => {
    const saved = records[identity.key]
    if (saved) {
      if (saved.hash !== identity.hash)
        throw new Error('report-id conflict: content differs from the original export; use a new revision id')
      if (saved.state === 'queued' && !findEntry(identity.key)) mark(saved, 'delivery-unknown')
      return { ...saved, reused: true }
    }
    if (Object.keys(records).length >= MAX_RECEIPTS)
      throw new Error(
        `call receipt limit (${MAX_RECEIPTS}) reached; archive/reconcile receipts explicitly, no ids were evicted`,
      )
    const orphan = findEntry(identity.key)
    if (orphan && identityOf(orphan).hash !== identity.hash)
      throw new Error('report-id conflict with an existing queued export')
    const entry = orphan ?? createEntry(identity)
    const now = Date.now()
    const receipt: Receipt = {
      ...identity,
      entryId: entry.id,
      state: orphan ? 'delivery-unknown' : 'queued',
      createdAt: now,
      updatedAt: now,
    }
    records[identity.key] = receipt
    return receipt
  })
}

export function verifyReport(entry: ReceiptEntry): Receipt {
  const identity = identityOf(entry)
  const saved = getReceipt(identity.session, identity.reportId)
  if (
    !saved ||
    saved.key !== identity.key ||
    saved.hash !== identity.hash ||
    saved.entryId !== entry.id ||
    entry.key !== saved.session
  )
    throw new Error('call receipt does not match its queue identity; refusing dispatch')
  return saved
}

/** The entry's record when it is the one the entry carries, every field alike; else undefined. */
function recordOf(records: Record<string, Receipt>, entry: ReceiptEntry): Receipt | undefined {
  const identity = identityOf(entry)
  const saved = records[identity.key]
  const same =
    saved &&
    saved.hash === identity.hash &&
    saved.entryId === entry.id &&
    entry.key === saved.session &&
    identity.session === saved.session &&
    identity.reportId === saved.reportId
  return same ? saved : undefined
}

export function beginReport(entry: ReceiptEntry): ReceiptState {
  return change(records => {
    const saved = recordOf(records, entry)
    if (!saved) throw new Error('call receipt does not match its queue entry; refusing dispatch')
    if (saved.state === 'queued') mark(saved, 'dispatching')
    else if (saved.state === 'dispatching') mark(saved, 'delivery-unknown')
    return saved.state
  })
}

export function settleReport(entry: ReceiptEntry, state: ReceiptState): ReceiptState | undefined {
  if (!entry.receipt) return undefined
  if (!isState(state)) throw new Error('invalid call receipt state')
  return change(records => {
    const saved = recordOf(records, entry)
    if (!saved) throw new Error('call receipt does not match its queue entry')
    // Cancellation cannot unsend a dispatch already in progress. Keep terminal receipts immutable.
    if (saved.state === 'queued') mark(saved, state)
    else if (saved.state === 'dispatching') mark(saved, state === 'sent' ? 'sent' : 'delivery-unknown')
    return saved.state
  })
}

// Only the send() busy/draft/dialog guards prove that no prompt command was attempted.
export function deferReport(entry: ReceiptEntry): ReceiptState {
  return change(records => {
    const identity = identityOf(entry)
    const saved = records[identity.key]
    if (!saved || saved.entryId !== entry.id || saved.hash !== identity.hash || entry.key !== saved.session)
      throw new Error('call receipt does not match its queue entry')
    if (saved.state === 'dispatching') mark(saved, 'queued')
    return saved.state
  })
}
