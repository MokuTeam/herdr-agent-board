// Master handover storage adapter (#697): collects master state files, packs/seals and
// unseals encrypted MHB1 bundles (using core/backup-file.ts), takes/restores pre-handover backups,
// rekeys board.db/journal.db/schedule/owner-watch, and checks target backup readiness.
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { backupConfig, isTarget, targetWhere } from '../core/backup.ts'
import { type BackupKey, isBackupKey, seal, unseal } from '../core/backup-file.ts'
import { rekeyKey } from '../core/db-rekey.ts'
import {
  type HandoverCategory,
  type HandoverFileEntry,
  type HandoverManifest,
  type HandoverStateRecord,
  type HandoverSummaryItem,
  isBackupTargetSelf,
  isSafeHandoverRelPath,
  packHandoverBundle,
  unpackHandoverBundle,
} from '../core/master-handover.ts'
import { isDevice, LOCAL } from '../core/node-key.ts'
import { rekeyBoard } from '../services/db-rekey.ts'
import { forgetOwnerWatch, ownerWatchFile } from '../services/owner-watch.ts'
import { accessFile, attemptsFile, loginsFile, passkeysFile } from './access-store.ts'
import { backupDir, dropKey, folderProblem, keyFile, readKey, readStatus, writeKey } from './backup-store.ts'
import { calendarDir, secretDir } from './calendar-cache.ts'
import { configFile } from './config-file.ts'
import { dbFile, integrityOf, openDb } from './db.ts'
import { journalFile, openJournalDb } from './journal-store.ts'
import { isRecord, readJson, replaceFile } from './json-store.ts'
import { createDeviceStore, nodesDir } from './node-store.ts'
import {
  cardsDir,
  nodeDir,
  scheduleDir,
  stateDir,
  teamAgentsFile,
  teamAuditFile,
  teamBlobsFile,
  teamBoxFile,
  teamDraftsFile,
  teamFilesDir,
  teamInboxFile,
  teamKeyFile,
  teamOutboxFile,
  teamPasskeysFile,
  teamPinsFile,
  teamReactionsFile,
  teamThreadsFile,
  threadFilesDir,
} from './paths.ts'
import { remindersFile } from './reminder-store.ts'
import { generatedKey, knownHostsFile, protectKey, tunnelDir } from './ssh.ts'
import { teamReadsFile } from './team-reads.ts'

const HANDOVER_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/
const HEX6 = /^[0-9a-f]{6}\.json$/
const HANDOVER_BACKUPS_KEPT = 5
const PRIVATE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

export const handoverDir = (): string => join(stateDir(), 'handover')
export const handoverStateFile = (): string => join(handoverDir(), 'state.json')
export const handoverBackupsDir = (): string => join(handoverDir(), 'backups')
export const handoverStagingDir = (): string => join(handoverDir(), 'staging')

export function handoverBackupDir(id: string): string {
  if (!HANDOVER_ID_RE.test(id)) throw new Error(`invalid handover id: ${id}`)
  return join(handoverBackupsDir(), id)
}

export function handoverStageDir(id: string): string {
  if (!HANDOVER_ID_RE.test(id)) throw new Error(`invalid handover id: ${id}`)
  return join(handoverStagingDir(), id)
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Makes a non-secret BackupKey from random 32 bytes for ephemeral bundle encryption when neither side has one yet. */
export function makeEphemeralKey(now = Date.now()): BackupKey {
  return {
    v: 1,
    logN: 10,
    r: 8,
    p: 1,
    salt: randomBytes(16).toString('base64'),
    key: randomBytes(32).toString('base64'),
    made: now,
  }
}

/** Picks the master's existing backup key if present, otherwise returns null. */
export const readMasterBackupKey = (): BackupKey | null => readKey()

const isHandoverState = (v: unknown): v is HandoverStateRecord =>
  isRecord(v) &&
  v.v === 1 &&
  typeof v.id === 'string' &&
  HANDOVER_ID_RE.test(v.id) &&
  (v.role === 'old-master' || v.role === 'new-master' || v.role === 'peer') &&
  (v.phase === 'prepared' || v.phase === 'applied' || v.phase === 'committed' || v.phase === 'rolled-back') &&
  typeof v.from === 'string' &&
  typeof v.to === 'string' &&
  typeof v.peerId === 'string' &&
  Array.isArray(v.otherNodes) &&
  v.otherNodes.every(x => typeof x === 'string') &&
  (v.enrolledSocket === undefined || typeof v.enrolledSocket === 'string') &&
  (v.relayApplied === undefined || typeof v.relayApplied === 'boolean') &&
  typeof v.at === 'number'

export const readHandoverState = (): HandoverStateRecord | null => readJson(handoverStateFile(), isHandoverState)

export function writeHandoverState(state: HandoverStateRecord): void {
  mkdirSync(handoverDir(), { recursive: true, mode: PRIVATE_DIR_MODE })
  replaceFile(handoverStateFile(), `${JSON.stringify(state, null, 2)}\n`, undefined, PRIVATE_MODE)
}

function listFilesRecursive(dir: string, prefixRel: string): { abs: string; rel: string; size: number }[] {
  if (!existsSync(dir)) return []
  const out: { abs: string; rel: string; size: number }[] = []
  const walk = (curAbs: string, curRel: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(curAbs).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(curAbs, name)
      const rel = curRel ? `${curRel}/${name}` : name
      try {
        const st = lstatSync(abs)
        if (st.isDirectory()) walk(abs, rel)
        else if (st.isFile()) out.push({ abs, rel, size: st.size })
      } catch {}
    }
  }
  walk(dir, prefixRel)
  return out
}

function copyConsistentSqlite(
  kind: 'board' | 'journal',
  srcPath: string,
  tmpDir: string,
): { bytes: Uint8Array; size: number } {
  mkdirSync(tmpDir, { recursive: true })
  const tmpCopy = join(tmpDir, `${kind}-${process.pid}-${randomBytes(4).toString('hex')}.db`)
  try {
    const db = kind === 'board' ? openDb({ path: srcPath, create: false }) : openJournalDb(false)
    if (!db) throw new Error(`${kind}.db could not be opened`)
    try {
      db.copyTo(tmpCopy)
    } finally {
      db.close()
    }
    const whole = integrityOf(tmpCopy)
    if (!whole.ok) throw new Error(`${kind}.db integrity check failed: ${whole.detail}`)
    const bytes = readFileSync(tmpCopy)
    return { bytes, size: bytes.byteLength }
  } finally {
    for (const end of ['', '-wal', '-shm', '-journal']) rmSync(`${tmpCopy}${end}`, { force: true })
  }
}

export interface CollectedMasterState {
  entries: HandoverFileEntry[]
  bodies: Uint8Array[]
  summary: HandoverSummaryItem[]
  totalFiles: number
  totalBytes: number
  normalizedTunnelKey: boolean
  hasBackupKey: boolean
  hasDropKey: boolean
}

/**
 * Inventories (when `pack: false`) or reads and hashes (when `pack: true`) every piece of master
 * state that moves during a handover. Excludes `token` and `ssh-pid.json` files.
 */
export function collectMasterState(
  cfgRaw: Record<string, unknown> | null,
  targetId: string,
  opts: { pack: boolean; carryBackupKey?: boolean; carryBackupServer?: boolean },
): CollectedMasterState {
  const entries: HandoverFileEntry[] = []
  const bodies: Uint8Array[] = []
  const byCat = new Map<HandoverCategory, { files: number; bytes: number }>()
  let normalizedTunnelKey = false

  const tmpDir = opts.pack ? join(handoverDir(), `pack-${process.pid}-${randomBytes(4).toString('hex')}`) : ''

  const addSpec = (
    rel: string,
    abs: string,
    category: HandoverCategory,
    mode?: number,
    sqliteKind?: 'board' | 'journal',
  ): void => {
    if (!existsSync(abs)) return
    let size = 0
    let sha = '0'.repeat(64)
    if (opts.pack) {
      let bytes: Uint8Array
      if (sqliteKind) {
        const res = copyConsistentSqlite(sqliteKind, abs, tmpDir)
        bytes = res.bytes
        size = res.size
      } else {
        bytes = readFileSync(abs)
        size = bytes.byteLength
      }
      sha = sha256Hex(bytes)
      bodies.push(bytes)
    } else {
      try {
        const st = statSync(abs)
        if (!st.isFile()) return
        size = st.size
      } catch {
        return
      }
    }
    entries.push({ path: rel, category, size, sha256: sha, ...(mode !== undefined && { mode }) })
    const prev = byCat.get(category) ?? { files: 0, bytes: 0 }
    byCat.set(category, { files: prev.files + 1, bytes: prev.bytes + size })
  }

  try {
    // 1. board.db
    addSpec('board.db', dbFile(), 'db', undefined, 'board')

    // 2. thread-files/**
    for (const f of listFilesRecursive(threadFilesDir(), 'thread-files')) {
      addSpec(f.rel, f.abs, 'threadFiles')
    }

    // 3. journal.db
    addSpec('journal.db', journalFile(), 'journal', undefined, 'journal')

    // 4. access store
    addSpec('access.json', accessFile(), 'access', PRIVATE_MODE)
    addSpec('access-passkeys.json', passkeysFile(), 'access', PRIVATE_MODE)
    addSpec('access-logins.json', loginsFile(), 'access', PRIVATE_MODE)
    addSpec('access-attempts.json', attemptsFile(), 'access', PRIVATE_MODE)

    // 5. team keys & files
    addSpec('team-key.json', teamKeyFile(), 'team', PRIVATE_MODE)
    addSpec('team-box.json', teamBoxFile(), 'team', PRIVATE_MODE)
    addSpec('team-passkeys.json', teamPasskeysFile(), 'team', PRIVATE_MODE)
    addSpec('team-inbox.json', teamInboxFile(), 'team')
    addSpec('team-outbox.json', teamOutboxFile(), 'team')
    addSpec('team-reactions.json', teamReactionsFile(), 'team')
    addSpec('team-pins.json', teamPinsFile(), 'team')
    addSpec('team-audit.jsonl', teamAuditFile(), 'team')
    addSpec('team-drafts.json', teamDraftsFile(), 'team')
    addSpec('team-threads.json', teamThreadsFile(), 'team')
    addSpec('team-agents.json', teamAgentsFile(), 'team')
    addSpec('team-blobs.json', teamBlobsFile(), 'team')
    addSpec('team-reads.json', teamReadsFile(), 'team')
    for (const f of listFilesRecursive(teamFilesDir(), 'team-files')) {
      addSpec(f.rel, f.abs, 'team')
    }

    // 6. calendar secrets & cache
    for (const f of listFilesRecursive(secretDir(), 'calendar/secret')) {
      addSpec(f.rel, f.abs, 'calendar', PRIVATE_MODE)
    }
    if (existsSync(calendarDir())) {
      for (const name of readdirSync(calendarDir()).sort()) {
        if (!name.endsWith('.json')) continue
        addSpec(`calendar/${name}`, join(calendarDir(), name), 'calendar')
      }
    }
    addSpec('calendar-reminders.json', remindersFile(), 'calendar')

    // 7. tunnel key & known_hosts
    const rawTunnel = isRecord(cfgRaw?.tunnel) ? cfgRaw.tunnel : null
    const customTunnelKey = typeof rawTunnel?.key === 'string' && rawTunnel.key.trim() ? rawTunnel.key.trim() : null
    const defaultTunnelKey = generatedKey()
    if (customTunnelKey && existsSync(customTunnelKey)) {
      addSpec('tunnel/id_ed25519', customTunnelKey, 'tunnel', PRIVATE_MODE)
      if (existsSync(`${customTunnelKey}.pub`)) addSpec('tunnel/id_ed25519.pub', `${customTunnelKey}.pub`, 'tunnel')
      normalizedTunnelKey = true
    } else if (existsSync(defaultTunnelKey)) {
      addSpec('tunnel/id_ed25519', defaultTunnelKey, 'tunnel', PRIVATE_MODE)
      if (existsSync(`${defaultTunnelKey}.pub`)) addSpec('tunnel/id_ed25519.pub', `${defaultTunnelKey}.pub`, 'tunnel')
    }
    addSpec('tunnel/known_hosts', knownHostsFile(), 'tunnel')

    // 8. schedule entries, watches & owner-watch
    if (existsSync(scheduleDir())) {
      for (const name of readdirSync(scheduleDir()).sort()) {
        if (!HEX6.test(name)) continue
        const abs = join(scheduleDir(), name)
        let mode: number | undefined
        try {
          const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { receipt?: unknown }
          if (parsed?.receipt) mode = PRIVATE_MODE
        } catch {}
        addSpec(`schedule/${name}`, abs, 'schedule', mode)
      }
      const wDir = join(scheduleDir(), 'watches')
      if (existsSync(wDir)) {
        for (const name of readdirSync(wDir).sort()) {
          if (!HEX6.test(name)) continue
          addSpec(`schedule/watches/${name}`, join(wDir, name), 'schedule')
        }
      }
    }
    addSpec('owner-watch.json', ownerWatchFile(), 'schedule', PRIVATE_MODE)

    // 9. nodes' records & relay credentials (never tokens, never ssh-pid.json)
    const nDir = nodesDir()
    addSpec('nodes/relay/master-key', join(nDir, 'relay', 'master-key'), 'nodes', PRIVATE_MODE)
    addSpec('nodes/relay/master-key.pub', join(nDir, 'relay', 'master-key.pub'), 'nodes')
    addSpec('nodes/relay/enrol-key', join(nDir, 'relay', 'enrol-key'), 'nodes', PRIVATE_MODE)
    addSpec('nodes/relay/enrol-key.pub', join(nDir, 'relay', 'enrol-key.pub'), 'nodes')
    addSpec('nodes/lanes-seen.json', join(nDir, 'lanes-seen.json'), 'nodes')

    const rawNodes = isRecord(cfgRaw?.nodes) ? cfgRaw.nodes : null
    const oldMasterId = typeof rawNodes?.id === 'string' && isDevice(rawNodes.id) ? rawNodes.id : null
    if (oldMasterId) {
      const ownDevDir = join(nDir, oldMasterId)
      addSpec(`nodes/${oldMasterId}/link-key`, join(ownDevDir, 'link-key'), 'nodes', PRIVATE_MODE)
      addSpec(`nodes/${oldMasterId}/link-key.pub`, join(ownDevDir, 'link-key.pub'), 'nodes')
    }
    const rawDevices = isRecord(rawNodes?.devices) ? rawNodes.devices : null
    if (rawDevices) {
      for (const [id, entry] of Object.entries(rawDevices).sort(([a], [b]) => a.localeCompare(b))) {
        if (id === LOCAL || id === targetId || !isDevice(id)) continue
        if (isRecord(entry) && entry.revoked === true) continue
        const devDir = join(nDir, id)
        if (!existsSync(devDir)) continue
        addSpec(`nodes/${id}/link-key`, join(devDir, 'link-key'), 'nodes', PRIVATE_MODE)
        addSpec(`nodes/${id}/link-key.pub`, join(devDir, 'link-key.pub'), 'nodes')
        addSpec(`nodes/${id}/door-cert.pem`, join(devDir, 'door-cert.pem'), 'nodes', PRIVATE_MODE)
        addSpec(`nodes/${id}/snapshot.json`, join(devDir, 'snapshot.json'), 'nodes', PRIVATE_MODE)
        addSpec(`nodes/${id}/bundle.json`, join(devDir, 'bundle.json'), 'nodes', PRIVATE_MODE)
        addSpec(`nodes/${id}/uplink-seen.json`, join(devDir, 'uplink-seen.json'), 'nodes', PRIVATE_MODE)
      }
    }

    // 10. backup key & drop key when needed
    const hasBackupKey = existsSync(keyFile())
    const hasDropKey = existsSync(dropKey())
    if (opts.carryBackupKey && hasBackupKey) {
      addSpec('backup/backup-key.json', keyFile(), 'backup', PRIVATE_MODE)
    }
    if (opts.carryBackupServer && hasDropKey) {
      addSpec('backup/id_ed25519', dropKey(), 'backup', PRIVATE_MODE)
      if (existsSync(`${dropKey()}.pub`)) addSpec('backup/id_ed25519.pub', `${dropKey()}.pub`, 'backup')
    }

    const summary: HandoverSummaryItem[] = []
    for (const [category, stats] of byCat) {
      summary.push({ category, files: stats.files, bytes: stats.bytes })
    }
    const totalFiles = entries.length
    const totalBytes = entries.reduce((acc, e) => acc + e.size, 0)

    return {
      entries,
      bodies,
      summary,
      totalFiles,
      totalBytes,
      normalizedTunnelKey,
      hasBackupKey,
      hasDropKey,
    }
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Packs a manifest + bodies into MHB1 and seals it with `key` (ABK1 gzip + AES-256-GCM).
 */
export function sealHandoverBundle(manifest: HandoverManifest, bodies: readonly Uint8Array[], key: BackupKey): Buffer {
  const packed = packHandoverBundle(manifest, bodies)
  return seal(packed, key)
}

/**
 * Unseals an encrypted ABK1 handover bundle using `key`, unpacks MHB1, and verifies every file's
 * SHA-256 checksum before returning the manifest and file bodies.
 */
export function unsealHandoverBundle(
  sealed: Uint8Array,
  key: BackupKey,
): { manifest: HandoverManifest; bodies: Uint8Array[] } {
  const plain = unseal(sealed, key, null)
  const unpacked = unpackHandoverBundle(plain)
  for (const [i, entry] of unpacked.manifest.files.entries()) {
    const body = unpacked.bodies[i]
    if (!body) throw new Error(`handover bundle missing body for ${entry.path}`)
    const actual = sha256Hex(body)
    if (actual !== entry.sha256) {
      throw new Error(`handover bundle checksum mismatch for ${entry.path}`)
    }
  }
  return unpacked
}

/**
 * Rekeys `moves.key` and `last_state.key` inside `journal.db` in a single transaction, handling
 * `last_state(key)` primary key swaps cleanly without unique-constraint conflicts.
 */
export function rekeyJournalDb(dbPath: string, from: string, to: string): { moves: number; states: number } {
  if (!existsSync(dbPath)) return { moves: 0, states: 0 }
  const db = new Database(dbPath, { strict: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    try {
      let movesChanged = 0
      let statesChanged = 0
      const hasMoves = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'moves'").get()
      if (hasMoves) {
        const rows = db.query('SELECT id, key FROM moves').all() as { id: number; key: string }[]
        const upd = db.query('UPDATE moves SET key = ? WHERE id = ?')
        for (const r of rows) {
          const next = rekeyKey(r.key, from, to)
          if (next !== r.key) {
            upd.run(next, r.id)
            movesChanged++
          }
        }
      }
      const hasStates = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'last_state'").get()
      if (hasStates) {
        interface StateRowDb {
          key: string
          kind: string
          line: string
          name: string
          lane: string
          at: number
          gone: number | null
        }
        const rows = db.query('SELECT key, kind, line, name, lane, at, gone FROM last_state').all() as StateRowDb[]
        const merged = new Map<string, StateRowDb>()
        for (const r of rows) {
          const nextKey = rekeyKey(r.key, from, to)
          if (nextKey !== r.key) statesChanged++
          const prev = merged.get(nextKey)
          if (!prev || r.at > prev.at) {
            merged.set(nextKey, { ...r, key: nextKey })
          }
        }
        if (statesChanged > 0) {
          db.exec('DELETE FROM last_state')
          const ins = db.query(
            'INSERT INTO last_state (key, kind, line, name, lane, at, gone) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          for (const r of merged.values()) {
            ins.run(r.key, r.kind, r.line, r.name, r.lane, r.at, r.gone)
          }
        }
      }
      db.exec('COMMIT')
      return { moves: movesChanged, states: statesChanged }
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      throw err
    }
  } finally {
    db.close()
  }
}

interface BackupManifestEntry {
  rel: string
  kind: 'config' | 'state' | 'cards'
  mode?: number
}

interface BackupManifest {
  v: 1
  id: string
  at: number
  hadConfig: boolean
  files: BackupManifestEntry[]
  appliedFiles: string[]
}

const isBackupManifest = (v: unknown): v is BackupManifest =>
  isRecord(v) &&
  v.v === 1 &&
  typeof v.id === 'string' &&
  typeof v.at === 'number' &&
  typeof v.hadConfig === 'boolean' &&
  Array.isArray(v.files) &&
  Array.isArray(v.appliedFiles)

function pruneHandoverBackups(): void {
  const dir = handoverBackupsDir()
  if (!existsSync(dir)) return
  try {
    const dirs = readdirSync(dir)
      .map(n => {
        const p = join(dir, n)
        try {
          const st = statSync(p)
          return st.isDirectory() ? { p, at: st.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter((x): x is { p: string; at: number } => x !== null)
      .sort((a, b) => b.at - a.at)
    for (const old of dirs.slice(HANDOVER_BACKUPS_KEPT)) rmSync(old.p, { recursive: true, force: true })
  } catch {}
}

/** Finds the latest handover backup id on disk, or null if none exists. */
export function latestHandoverBackupId(): string | null {
  const dir = handoverBackupsDir()
  if (!existsSync(dir)) return null
  try {
    const dirs = readdirSync(dir)
      .map(n => {
        const p = join(dir, n)
        const manifest = join(p, 'backup-manifest.json')
        if (!existsSync(manifest)) return null
        try {
          return { n, at: statSync(manifest).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { n: string; at: number } => x !== null)
      .sort((a, b) => b.at - a.at)
    return dirs[0]?.n ?? null
  } catch {
    return null
  }
}

/**
 * Takes a full pre-handover backup of `config.json` and all present master/node state under
 * `handover/backups/<id>/` so rollback can restore exact pre-handover state on either device.
 */
export function takeLocalBackup(id: string, now: number = Date.now()): BackupManifest {
  const dir = handoverBackupDir(id)
  const manifestFile = join(dir, 'backup-manifest.json')
  // Idempotent if already taken for this id.
  const existing = readJson(manifestFile, isBackupManifest)
  if (existing) return existing

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })

  const stateRoot = stateDir()
  const files: BackupManifestEntry[] = []

  const copyStateFile = (rel: string, abs: string, mode?: number): void => {
    if (!existsSync(abs)) return
    const dest = join(dir, 'state', ...rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true, mode: PRIVATE_DIR_MODE })
    copyFileSync(abs, dest)
    if (mode !== undefined && process.platform !== 'win32') chmodSync(dest, mode)
    files.push({ rel, kind: 'state', ...(mode !== undefined && { mode }) })
  }

  // Config
  const cfgPath = configFile()
  const hadConfig = existsSync(cfgPath)
  if (hadConfig) {
    const cfgDest = join(dir, 'config.json')
    copyFileSync(cfgPath, cfgDest)
    if (process.platform !== 'win32') chmodSync(cfgDest, PRIVATE_MODE)
    files.push({ rel: 'config.json', kind: 'config', mode: PRIVATE_MODE })
  }

  // Consistent SQLite copies for board.db and journal.db
  if (existsSync(dbFile())) {
    const dest = join(dir, 'state', 'board.db')
    mkdirSync(dirname(dest), { recursive: true })
    const db = openDb({ path: dbFile(), create: false })
    if (!db) throw new Error('board.db could not be opened for backup')
    try {
      db.copyTo(dest)
    } finally {
      db.close()
    }
    const whole = integrityOf(dest)
    if (!whole.ok) throw new Error(`board.db backup integrity check failed: ${whole.detail}`)
    files.push({ rel: 'board.db', kind: 'state' })
  }
  if (existsSync(journalFile())) {
    const dest = join(dir, 'state', 'journal.db')
    mkdirSync(dirname(dest), { recursive: true })
    const db = openJournalDb(false)
    if (!db) throw new Error('journal.db could not be opened for backup')
    try {
      db.copyTo(dest)
    } finally {
      db.close()
    }
    const whole = integrityOf(dest)
    if (!whole.ok) throw new Error(`journal.db backup integrity check failed: ${whole.detail}`)
    files.push({ rel: 'journal.db', kind: 'state' })
  }

  // Single files under stateDir()
  const singleFiles: [string, string, number | undefined][] = [
    ['access.json', accessFile(), PRIVATE_MODE],
    ['access-passkeys.json', passkeysFile(), PRIVATE_MODE],
    ['access-logins.json', loginsFile(), PRIVATE_MODE],
    ['access-attempts.json', attemptsFile(), PRIVATE_MODE],
    ['team-key.json', teamKeyFile(), PRIVATE_MODE],
    ['team-box.json', teamBoxFile(), PRIVATE_MODE],
    ['team-passkeys.json', teamPasskeysFile(), PRIVATE_MODE],
    ['team-inbox.json', teamInboxFile(), undefined],
    ['team-outbox.json', teamOutboxFile(), undefined],
    ['team-reactions.json', teamReactionsFile(), undefined],
    ['team-pins.json', teamPinsFile(), undefined],
    ['team-audit.jsonl', teamAuditFile(), undefined],
    ['team-drafts.json', teamDraftsFile(), undefined],
    ['team-threads.json', teamThreadsFile(), undefined],
    ['team-agents.json', teamAgentsFile(), undefined],
    ['team-blobs.json', teamBlobsFile(), undefined],
    ['team-reads.json', teamReadsFile(), undefined],
    ['calendar-reminders.json', remindersFile(), undefined],
    ['owner-watch.json', ownerWatchFile(), PRIVATE_MODE],
    ['rekey-state.json', join(stateRoot, 'rekey-state.json'), undefined],
  ]
  for (const [rel, abs, mode] of singleFiles) copyStateFile(rel, abs, mode)

  // Directories under stateDir()
  const dirs: [string, string][] = [
    ['thread-files', threadFilesDir()],
    ['team-files', teamFilesDir()],
    ['calendar', calendarDir()],
    ['tunnel', tunnelDir()],
    ['schedule', scheduleDir()],
    ['nodes', nodesDir()],
    ['node', nodeDir()],
    ['backup', backupDir()],
  ]
  for (const [prefix, absDir] of dirs) {
    for (const f of listFilesRecursive(absDir, prefix)) {
      if (f.rel.endsWith('ssh-pid.json') || f.rel.endsWith('relay-pid.json')) continue
      const isPrivate =
        f.rel.includes('/secret/') ||
        f.rel.endsWith('token') ||
        f.rel.endsWith('link-key') ||
        f.rel.endsWith('master-key') ||
        f.rel.endsWith('enrol-key') ||
        f.rel.endsWith('relay-key') ||
        f.rel.endsWith('id_ed25519') ||
        f.rel.endsWith('door-cert.pem') ||
        f.rel.endsWith('door-key.pem') ||
        f.rel.endsWith('masters.json') ||
        f.rel.endsWith('backup-key.json') ||
        (f.rel.startsWith('nodes/') && f.rel.endsWith('.json')) ||
        (f.rel.startsWith('schedule/') && f.rel.endsWith('.json'))
      copyStateFile(f.rel, f.abs, isPrivate ? PRIVATE_MODE : undefined)
    }
  }

  // Legacy card files (may live outside stateDir() on some platforms, so store under kind: 'cards').
  const cDir = cardsDir()
  if (existsSync(cDir)) {
    for (const f of listFilesRecursive(cDir, '')) {
      const dest = join(dir, 'cards', ...f.rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true, mode: PRIVATE_DIR_MODE })
      copyFileSync(f.abs, dest)
      files.push({ rel: f.rel, kind: 'cards' })
    }
  }

  const manifest: BackupManifest = { v: 1, id, at: now, hadConfig, files, appliedFiles: [] }
  replaceFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, undefined, PRIVATE_MODE)
  pruneHandoverBackups()
  return manifest
}

/** Records relative paths newly written during apply so rollback can remove files that were not in the pre-handover backup. */
export function recordAppliedFiles(id: string, relPaths: readonly string[]): void {
  const dir = handoverBackupDir(id)
  const manifestFile = join(dir, 'backup-manifest.json')
  const manifest = readJson(manifestFile, isBackupManifest)
  if (!manifest) return
  const merged = [...new Set([...manifest.appliedFiles, ...relPaths])]
  replaceFile(
    manifestFile,
    `${JSON.stringify({ ...manifest, appliedFiles: merged }, null, 2)}\n`,
    undefined,
    PRIVATE_MODE,
  )
}

export type HandoverRestoreScope = 'all' | 'old-master-precommit' | 'old-master-committed'

const isOldMasterRetiredRel = (rel: string): boolean =>
  rel.startsWith('schedule/') || rel === 'calendar-reminders.json' || rel === 'owner-watch.json'

/**
 * Removes live shipped schedule, watch, calendar-reminder, and owner-watch files from a newly
 * demoted old master after the new master commits, preventing duplicate scheduler runs.
 * Backup copies remain in `handover/backups/<id>/` for rollback.
 */
export function retireShippedOldMasterState(id: string): number {
  const dir = handoverBackupDir(id)
  const manifest = readJson(join(dir, 'backup-manifest.json'), isBackupManifest)
  if (!manifest) throw new Error(`handover backup ${id} not found or unreadable`)

  let removed = 0
  const rmFile = (p: string): void => {
    if (!existsSync(p)) return
    rmSync(p, { force: true })
    removed++
  }
  const sDir = scheduleDir()
  if (existsSync(sDir)) {
    for (const name of readdirSync(sDir)) {
      if (HEX6.test(name)) rmFile(join(sDir, name))
    }
    const wDir = join(sDir, 'watches')
    if (existsSync(wDir)) {
      for (const name of readdirSync(wDir)) {
        if (HEX6.test(name)) rmFile(join(wDir, name))
      }
    }
  }
  rmFile(remindersFile())
  rmFile(ownerWatchFile())
  forgetOwnerWatch()
  return removed
}

/**
 * Restores `config.json` and backed-up state from `handover/backups/<id>/`.
 * Callers must close cached SQLite connections (`beforeDbReplace`) before calling `'all'` scope.
 * - `'all'` (default, target/new-master): full restore of all backed-up state and removal of appliedFiles.
 * - `'old-master-precommit'`: restores only `config.json` and `node/*` (clears stale `node/*` added
 *   during handover, preserving any live `board.db`/`journal.db`/`access*` on old master).
 * - `'old-master-committed'`: restores `config.json`, `node/*`, and retired schedule/watch/reminder
 *   files while still preserving live `board.db`/`journal.db`/`access*`.
 */
export async function restoreLocalBackup(
  id: string,
  opts: { scope?: HandoverRestoreScope } = {},
): Promise<{ restored: number; removed: number }> {
  const scope: HandoverRestoreScope = opts.scope ?? 'all'
  const dir = handoverBackupDir(id)
  const manifestFile = join(dir, 'backup-manifest.json')
  const manifest = readJson(manifestFile, isBackupManifest)
  if (!manifest) throw new Error(`handover backup ${id} not found or unreadable`)

  if (scope === 'all') {
    for (const dbRel of ['board.db', 'journal.db']) {
      const backed = join(dir, 'state', dbRel)
      if (existsSync(backed)) {
        const whole = integrityOf(backed)
        if (!whole.ok) throw new Error(`backed-up ${dbRel} failed integrity check: ${whole.detail}`)
      }
    }
  }

  const backedSet = new Set(manifest.files.filter(f => f.kind === 'state').map(f => f.rel))
  let removed = 0
  if (scope === 'all') {
    for (const rel of manifest.appliedFiles) {
      if (backedSet.has(rel) || !isSafeHandoverRelPath(rel)) continue
      const target = join(stateDir(), ...rel.split('/'))
      if (existsSync(target)) {
        rmSync(target, { force: true })
        removed++
      }
    }
    // Clear stale WAL/SHM sidecars for both SQLite databases before copying restored files.
    for (const liveDb of [dbFile(), journalFile()]) {
      for (const end of ['-wal', '-shm', '-journal']) rmSync(`${liveDb}${end}`, { force: true })
      if (!backedSet.has(liveDb === dbFile() ? 'board.db' : 'journal.db') && existsSync(liveDb)) {
        rmSync(liveDb, { force: true })
      }
    }
  } else {
    // Clear stale node/* credentials/certs created during handover (e.g. node/masters.json, door keys)
    // that were not present in the pre-handover backup.
    for (const f of listFilesRecursive(nodeDir(), 'node')) {
      if (backedSet.has(f.rel)) continue
      rmSync(f.abs, { force: true })
      removed++
    }
  }

  const wantStateEntry = (rel: string): boolean => {
    if (scope === 'all') return true
    if (scope === 'old-master-precommit') return rel.startsWith('node/')
    return rel.startsWith('node/') || isOldMasterRetiredRel(rel)
  }

  let restored = 0
  for (const entry of manifest.files) {
    if (entry.kind === 'config') {
      const src = join(dir, 'config.json')
      if (existsSync(src)) {
        mkdirSync(dirname(configFile()), { recursive: true })
        copyFileSync(src, configFile())
        if (process.platform !== 'win32') chmodSync(configFile(), PRIVATE_MODE)
        restored++
      }
      continue
    }
    if (entry.kind === 'cards') {
      if (scope !== 'all') continue
      if (!isSafeHandoverRelPath(entry.rel)) continue
      const src = join(dir, 'cards', ...entry.rel.split('/'))
      if (!existsSync(src)) continue
      const dest = join(cardsDir(), ...entry.rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      restored++
      continue
    }
    if (!wantStateEntry(entry.rel)) continue
    if (!isSafeHandoverRelPath(entry.rel)) continue
    const src = join(dir, 'state', ...entry.rel.split('/'))
    if (!existsSync(src)) continue
    const dest = join(stateDir(), ...entry.rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    if (entry.rel.startsWith('calendar/secret/') && process.platform !== 'win32') {
      chmodSync(dirname(dest), PRIVATE_DIR_MODE)
    }
    copyFileSync(src, dest)
    if (entry.mode !== undefined) {
      if (process.platform === 'win32') await protectKey(dest)
      else chmodSync(dest, entry.mode)
    }
    restored++
  }

  if (!manifest.hadConfig && existsSync(configFile())) {
    rmSync(configFile(), { force: true })
  }
  if (scope !== 'old-master-precommit') {
    forgetOwnerWatch()
  }
  return { restored, removed }
}

/**
 * Writes an unpacked handover bundle's files onto the target board, rekeying `board.db`,
 * `journal.db`, `schedule/`, `schedule/watches/`, `owner-watch.json`, and legacy card move marks
 * from `manifest.from` to `manifest.to`, and installs fresh node credentials.
 */
export async function applyHandoverFiles(
  id: string,
  manifest: HandoverManifest,
  bodies: readonly Uint8Array[],
  opts: { keepTargetBackupKey?: boolean } = {},
): Promise<{
  rekeyTotal: number
  journalRekeyed: { moves: number; states: number }
  appliedFiles: string[]
}> {
  const stage = handoverStageDir(id)
  const rekeyRoot = join(stage, 'rekey')
  const rekeySched = join(rekeyRoot, 'schedule')
  const rekeyWatches = join(rekeySched, 'watches')
  const rekeyDb = join(rekeyRoot, 'board.db')
  const rekeyJournal = join(rekeyRoot, 'journal.db')
  const rekeyOw = join(rekeyRoot, 'owner-watch.json')
  rmSync(rekeyRoot, { recursive: true, force: true })
  mkdirSync(rekeyRoot, { recursive: true, mode: PRIVATE_DIR_MODE })

  const rekeyedPaths = new Set<string>()
  const otherIndices: number[] = []
  let hasStagedDb = false
  let hasStagedSched = false
  let hasStagedJournal = false
  let hasStagedOw = false

  for (const [i, entry] of manifest.files.entries()) {
    const body = bodies[i]
    if (!body) throw new Error(`handover bundle missing body for ${entry.path}`)
    if (!isSafeHandoverRelPath(entry.path)) throw new Error(`unsafe path in handover bundle: ${entry.path}`)

    if (entry.path === 'board.db') {
      writeFileSync(rekeyDb, body)
      hasStagedDb = true
      rekeyedPaths.add(entry.path)
    } else if (entry.path === 'journal.db') {
      writeFileSync(rekeyJournal, body)
      hasStagedJournal = true
      rekeyedPaths.add(entry.path)
    } else if (entry.path === 'owner-watch.json') {
      writeFileSync(rekeyOw, body, { mode: PRIVATE_MODE })
      hasStagedOw = true
      rekeyedPaths.add(entry.path)
    } else if (entry.path.startsWith('schedule/watches/')) {
      mkdirSync(rekeyWatches, { recursive: true })
      const name = entry.path.slice('schedule/watches/'.length)
      writeFileSync(join(rekeyWatches, name), body)
      hasStagedSched = true
      rekeyedPaths.add(entry.path)
    } else if (entry.path.startsWith('schedule/')) {
      mkdirSync(rekeySched, { recursive: true })
      const name = entry.path.slice('schedule/'.length)
      writeFileSync(join(rekeySched, name), body)
      hasStagedSched = true
      rekeyedPaths.add(entry.path)
    } else {
      otherIndices.push(i)
    }
  }

  let rekeyTotal = 0
  if (hasStagedDb || hasStagedSched || hasStagedOw) {
    const report = rekeyBoard({
      from: manifest.from,
      to: manifest.to,
      by: 'master-handover',
      paths: {
        stateDir: rekeyRoot,
        dbFile: rekeyDb,
        scheduleDir: rekeySched,
        cardsDir: join(rekeyRoot, 'no-cards'),
        ownerWatchFile: rekeyOw,
      },
    })
    rekeyTotal +=
      report.db.total + report.schedule.entries.length + report.schedule.watches.length + report.ownerWatch.sessions
  }

  // Also rekey any legacy move marks on target's live cards folder without touching live DB/schedule.
  if (existsSync(cardsDir())) {
    const cardsReport = rekeyBoard({
      from: manifest.from,
      to: manifest.to,
      by: 'master-handover',
      paths: {
        stateDir: join(rekeyRoot, 'cards-state'),
        dbFile: join(rekeyRoot, 'no-db.db'),
        scheduleDir: join(rekeyRoot, 'no-sched'),
        cardsDir: cardsDir(),
        ownerWatchFile: join(rekeyRoot, 'no-ow.json'),
      },
    })
    rekeyTotal += cardsReport.moveMarks.length
  }

  const journalRekeyed = hasStagedJournal
    ? rekeyJournalDb(rekeyJournal, manifest.from, manifest.to)
    : { moves: 0, states: 0 }

  // Record all destination paths before writing any secret or state file so rollback
  // cleans up partial writes even if an error interrupts apply midway.
  const plannedFiles: string[] = []
  if (hasStagedDb) plannedFiles.push('board.db')
  if (hasStagedJournal) plannedFiles.push('journal.db')
  if (hasStagedOw) plannedFiles.push('owner-watch.json')
  if (hasStagedSched) {
    if (existsSync(rekeySched)) {
      for (const name of readdirSync(rekeySched)) {
        if (HEX6.test(name)) plannedFiles.push(`schedule/${name}`)
      }
    }
    if (existsSync(rekeyWatches)) {
      for (const name of readdirSync(rekeyWatches)) {
        if (HEX6.test(name)) plannedFiles.push(`schedule/watches/${name}`)
      }
    }
  }
  for (const idx of otherIndices) {
    const entry = manifest.files[idx]
    if (!entry || !bodies[idx]) continue
    if (entry.path === 'backup/backup-key.json' && opts.keepTargetBackupKey && existsSync(keyFile())) {
      continue
    }
    plannedFiles.push(entry.path)
  }
  for (const cred of manifest.credentials) {
    plannedFiles.push(`nodes/${cred.id}/token`)
    if (cred.cert) plannedFiles.push(`nodes/${cred.id}/door-cert.pem`)
  }
  recordAppliedFiles(id, plannedFiles)

  const appliedFiles: string[] = []
  const writeStateBytes = async (rel: string, bytes: Uint8Array, mode?: number): Promise<void> => {
    recordAppliedFiles(id, [rel])
    const dest = join(stateDir(), ...rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    if (rel.startsWith('calendar/secret/') && process.platform !== 'win32') {
      chmodSync(dirname(dest), 0o700)
    }
    writeFileSync(dest, bytes, mode !== undefined ? { mode } : undefined)
    if (mode !== undefined) {
      if (process.platform === 'win32') await protectKey(dest)
      else chmodSync(dest, mode)
    }
    appliedFiles.push(rel)
  }

  // Install rekeyed DBs (clearing stale WAL/SHM sidecars).
  if (hasStagedDb) {
    for (const end of ['-wal', '-shm', '-journal']) rmSync(`${dbFile()}${end}`, { force: true })
    await writeStateBytes('board.db', readFileSync(rekeyDb))
  }
  if (hasStagedJournal) {
    for (const end of ['-wal', '-shm', '-journal']) rmSync(`${journalFile()}${end}`, { force: true })
    await writeStateBytes('journal.db', readFileSync(rekeyJournal))
  }
  if (hasStagedOw) {
    await writeStateBytes('owner-watch.json', readFileSync(rekeyOw), PRIVATE_MODE)
    forgetOwnerWatch()
  }

  // Write rekeyed schedule entries and watches into stateDir().
  if (hasStagedSched) {
    if (existsSync(rekeySched)) {
      for (const name of readdirSync(rekeySched)) {
        if (!HEX6.test(name)) continue
        const bytes = readFileSync(join(rekeySched, name))
        let mode: number | undefined
        try {
          const parsed = JSON.parse(bytes.toString('utf8')) as { receipt?: unknown }
          if (parsed?.receipt) mode = PRIVATE_MODE
        } catch {}
        await writeStateBytes(`schedule/${name}`, bytes, mode)
      }
    }
    if (existsSync(rekeyWatches)) {
      for (const name of readdirSync(rekeyWatches)) {
        if (!HEX6.test(name)) continue
        await writeStateBytes(`schedule/watches/${name}`, readFileSync(join(rekeyWatches, name)))
      }
    }
  }

  // Write remaining files (access, team, calendar, tunnel, thread-files, nodes/*, backup/*).
  for (const idx of otherIndices) {
    const entry = manifest.files[idx]
    const body = bodies[idx]
    if (!entry || !body) continue
    if (entry.path === 'backup/backup-key.json' && opts.keepTargetBackupKey && existsSync(keyFile())) {
      continue
    }
    await writeStateBytes(entry.path, body, entry.mode)
  }

  // Install fresh device tokens and certificates (for old master + any re-paired nodes).
  const store = createDeviceStore()
  for (const cred of manifest.credentials) {
    store.setToken(cred.id, cred.token)
    appliedFiles.push(`nodes/${cred.id}/token`)
    if (cred.cert) {
      store.setCert(cred.id, cred.cert)
      appliedFiles.push(`nodes/${cred.id}/door-cert.pem`)
    }
  }

  recordAppliedFiles(id, appliedFiles)
  rmSync(rekeyRoot, { recursive: true, force: true })
  return { rekeyTotal, journalRekeyed, appliedFiles }
}

export interface TargetBackupCheck {
  ok: boolean
  target: 'folder' | 'server' | null
  detail: string
  hasKey: boolean
  selfConflict?: string
}

/**
 * Checks whether a board has a working backup target configured that does not point to itself.
 */
export function checkBackupReadiness(
  cfgRaw: Record<string, unknown> | null,
  selfNames: readonly string[],
): TargetBackupCheck {
  const c = backupConfig(cfgRaw?.backup)
  const status = readStatus().targets
  const hasKey = readKey() !== null

  if (c.folder) {
    const problem = folderProblem(c.folder)
    if (!problem) {
      // Probe writability with a small temp file inside the folder.
      const probe = join(c.folder, `.ab-handover-probe-${process.pid}-${Date.now()}`)
      try {
        writeFileSync(probe, 'ok')
        unlinkSync(probe)
        const s = status.folder
        if (s?.held) {
          return { ok: false, target: 'folder', detail: `folder backup is held: ${s.held}`, hasKey }
        }
        return { ok: true, target: 'folder', detail: `folder ${c.folder}`, hasKey }
      } catch (err) {
        return {
          ok: false,
          target: 'folder',
          detail: `backup folder is not writable (${err instanceof Error ? err.message : String(err)})`,
          hasKey,
        }
      }
    }
    if (!c.server?.set) {
      return { ok: false, target: 'folder', detail: `folder backup problem: ${problem}`, hasKey }
    }
  }

  if (c.server) {
    if (isBackupTargetSelf(c.server.host, selfNames)) {
      return {
        ok: false,
        target: 'server',
        detail: `backup server ${c.server.host} points to this device itself`,
        hasKey,
        selfConflict: c.server.host,
      }
    }
    if (!c.server.set) {
      return { ok: false, target: 'server', detail: `backup server ${c.server.host} is not set up yet`, hasKey }
    }
    if (!existsSync(dropKey())) {
      return { ok: false, target: 'server', detail: `backup server ${c.server.host} has no drop key`, hasKey }
    }
    const s = status.server
    if (s?.held) {
      return { ok: false, target: 'server', detail: `backup server ${c.server.host} is held: ${s.held}`, hasKey }
    }
    const where = targetWhere(c, 'server') ?? c.server.host
    return { ok: true, target: 'server', detail: `server ${where}`, hasKey }
  }

  // Also check if backup config has an invalid target key.
  const rawBackup = isRecord(cfgRaw?.backup) ? cfgRaw.backup : null
  if (rawBackup) {
    for (const k of Object.keys(rawBackup)) {
      if (isTarget(k)) return { ok: false, target: k, detail: `backup ${k} is incomplete`, hasKey }
    }
  }
  return { ok: false, target: null, detail: 'no backup target configured', hasKey }
}

/**
 * Ensures the target has a persistent BackupKey if it received one in the bundle, or returns
 * the parsed key for sealing/unsealing checks.
 */
export { isBackupKey, writeKey }
