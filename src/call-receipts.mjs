// Opt-in idempotency for call exports. This journals transport attempts, not agent execution.
// No automatic expiry: forgetting a report id would make an old retry unsafe to replay.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './paths.mjs'
import { readJson, updateJson } from './store.mjs'

export const RECEIPTS_FILE = join(STATE_DIR, 'call-receipts.json')
export const MAX_RECEIPTS = 1000
export const MAX_REPORT_BYTES = 1024 * 1024
const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const STATES = new Set(['queued', 'dispatching', 'sent', 'delivery-unknown', 'cancelled', 'missed'])
export const reportHash = text => createHash('sha256').update(text).digest('hex')
export function reportIdentity(session, reportId, hash) {
  if (!UUID.test(session) || !REPORT_ID.test(reportId)) throw new Error('report-id must be 1–128 letters, digits, dots, colons, underscores or hyphens; session must be a UUID')
  session = session.toLowerCase()
  return { key: reportHash(`${session}\n${reportId}`), session, reportId, hash }
}
function validate(saved) {
  if (saved === null && !existsSync(RECEIPTS_FILE)) return { version: 1, records: {} }
  if (saved?.version !== 1 || !saved.records || typeof saved.records !== 'object' || Array.isArray(saved.records) || Object.entries(saved.records).some(([key, r]) => !r || !HASH.test(r.hash) || !UUID.test(r.session) || r.session !== r.session.toLowerCase() || !REPORT_ID.test(r.reportId) || key !== reportHash(`${r.session}\n${r.reportId}`) || r.key !== key || !/^[0-9a-f]{6}$/.test(r.entryId) || !STATES.has(r.state))) {
    throw new Error('call receipt journal is missing or corrupt; refusing automatic replay')
  }
  return saved
}
function change(fn) {
  mkdirSync(STATE_DIR, { recursive: true })
  let result
  try {
    updateJson(RECEIPTS_FILE, saved => { const journal = validate(saved); result = fn(journal.records); return journal }, { mode: 0o600, recoverStale: false })
  } catch (error) {
    if (/Timed out waiting for lock:/.test(error.message)) error.message += '; stop receipt writers and reconcile interrupted exports before removing a stale receipt lock'
    throw error
  }
  return result
}
export function getReceipt(session, reportId) {
  const { key } = reportIdentity(session, reportId)
  return validate(readJson(RECEIPTS_FILE)).records[key] ?? null
}

// createEntry runs under the receipt journal lock. A crash between entry creation and journal
// persistence leaves an orphan, recovered as unknown rather than silently risking a replay.
export function enqueueReport(identity, { findEntry, createEntry }) {
  return change(records => {
    const saved = records[identity.key]
    if (saved) {
      if (saved.hash !== identity.hash) throw new Error('report-id conflict: content differs from the original export; use a new revision id')
      if (saved.state === 'queued' && !findEntry(identity.key)) Object.assign(saved, { state: 'delivery-unknown', updatedAt: Date.now() })
      return { ...saved, reused: true }
    }
    if (Object.keys(records).length >= MAX_RECEIPTS) throw new Error(`call receipt limit (${MAX_RECEIPTS}) reached; archive/reconcile receipts explicitly, no ids were evicted`)
    const orphan = findEntry(identity.key)
    if (orphan && orphan.receipt.hash !== identity.hash) throw new Error('report-id conflict with an existing queued export')
    const entry = orphan ?? createEntry(identity)
    const now = Date.now()
    return records[identity.key] = { ...identity, entryId: entry.id, state: orphan ? 'delivery-unknown' : 'queued', createdAt: now, updatedAt: now }
  })
}
export function verifyReport(entry) {
  const saved = getReceipt(entry.receipt.session, entry.receipt.reportId)
  if (!saved || saved.key !== entry.receipt.key || saved.hash !== entry.receipt.hash || saved.entryId !== entry.id || entry.key !== saved.session) throw new Error('call receipt does not match its queue identity; refusing dispatch')
  return saved
}

export function beginReport(entry) {
  return change(records => {
    const saved = records[entry.receipt.key]
    if (!saved || saved.hash !== entry.receipt.hash || saved.entryId !== entry.id || entry.key !== saved.session || entry.receipt.session !== saved.session || entry.receipt.reportId !== saved.reportId) throw new Error('call receipt does not match its queue entry; refusing dispatch')
    if (saved.state === 'queued') Object.assign(saved, { state: 'dispatching', updatedAt: Date.now() })
    else if (saved.state === 'dispatching') Object.assign(saved, { state: 'delivery-unknown', updatedAt: Date.now() })
    return saved.state
  })
}
export function settleReport(entry, state) {
  if (!entry.receipt) return
  if (!STATES.has(state)) throw new Error('invalid call receipt state')
  return change(records => {
    const saved = records[entry.receipt.key]
    if (!saved || saved.hash !== entry.receipt.hash || saved.entryId !== entry.id || entry.key !== saved.session || entry.receipt.session !== saved.session || entry.receipt.reportId !== saved.reportId) throw new Error('call receipt does not match its queue entry')
    // Cancellation cannot unsend a dispatch already in progress. Keep terminal receipts immutable.
    if (saved.state === 'queued') Object.assign(saved, { state, updatedAt: Date.now() })
    else if (saved.state === 'dispatching') Object.assign(saved, { state: state === 'sent' ? 'sent' : 'delivery-unknown', updatedAt: Date.now() })
    return saved.state
  })
}

// Only the send() busy/draft/dialog guards prove that no prompt command was attempted.
export function deferReport(entry) {
  return change(records => {
    const saved = records[entry.receipt.key]
    if (!saved || saved.entryId !== entry.id || saved.hash !== entry.receipt.hash || entry.key !== saved.session) throw new Error('call receipt does not match its queue entry')
    if (saved.state === 'dispatching') Object.assign(saved, { state: 'queued', updatedAt: Date.now() })
    return saved.state
  })
}
