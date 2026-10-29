// The backup's files on this computer (#233), in the state folder's backup/: the key made from the
// owner's passphrase (the user's alone), what each target last did (status.json, a JSON file so it
// can be read when the database cannot), and the board's own ssh key for the server's drop. And
// the folder target: snapshots written through a temp file and a rename into the chosen folder's
// agent-board-backups, listed, read back and pruned by the rotation.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  freshTarget,
  rotationKeeps,
  SNAPSHOT_NAME,
  snapshotName,
  type Target,
  type TargetState,
} from '../core/backup.ts'
import { type BackupKey, isBackupKey } from '../core/backup-file.ts'
import { isRecord, readJson, renameWithRetry, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'
import { protectKey } from './ssh.ts'

export const backupDir = (): string => join(stateDir(), 'backup')
export const keyFile = (): string => join(backupDir(), 'backup-key.json')
export const statusFile = (): string => join(backupDir(), 'status.json')
/** The board's own ssh key for the server's drop (ssh-keygen makes it, as the tunnel's). */
export const dropKey = (): string => join(backupDir(), 'id_ed25519')
/** The folder target's own folder inside the one the owner chose. */
export const FOLDER_NAME = 'agent-board-backups'

export function readKey(): BackupKey | null {
  return readJson(keyFile(), isBackupKey)
}

/** The key, written for the user alone (0600; on Windows its rights set as the tunnel's key's). */
export async function writeKey(k: BackupKey): Promise<{ ok: true } | { ok: false; error: string }> {
  mkdirSync(backupDir(), { recursive: true })
  const tmp = `${keyFile()}.${process.pid}.tmp`
  // on disk before it takes its name: a power cut never leaves an empty key file as "no passphrase"
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(k))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const rights = await protectKey(tmp)
  if (!rights.ok) {
    rmSync(tmp, { force: true })
    return rights
  }
  renameWithRetry(tmp, keyFile())
  return { ok: true }
}

// ------------------------------------------------------------------ status

export interface BackupStatus {
  targets: Partial<Record<Target, TargetState>>
}

const isState = (v: unknown): v is TargetState =>
  isRecord(v) && typeof v.seq === 'number' && typeof v.failures === 'number'

const isStatus = (v: unknown): v is BackupStatus => isRecord(v) && isRecord(v.targets)

export function readStatus(): BackupStatus {
  const s = readJson(statusFile(), isStatus)
  const targets: BackupStatus['targets'] = {}
  for (const [k, v] of Object.entries(s?.targets ?? {}))
    if ((k === 'folder' || k === 'server') && isState(v)) targets[k] = v
  return { targets }
}

/** One target's state changed under the file's lock; the other's kept. */
export function updateTarget(target: Target, change: (s: TargetState) => TargetState): TargetState {
  mkdirSync(backupDir(), { recursive: true })
  let next = freshTarget()
  updateJson<BackupStatus>(
    statusFile(),
    cur => {
      const targets = { ...(cur?.targets ?? {}) }
      next = change(isState(targets[target]) ? (targets[target] as TargetState) : freshTarget())
      targets[target] = next
      return { targets }
    },
    isStatus,
  )
  return next
}

/** A target's state forgotten (the target was removed or set anew). */
export function forgetTarget(target: Target): void {
  if (!existsSync(statusFile())) return
  updateJson<BackupStatus>(
    statusFile(),
    cur => {
      const targets = { ...(cur?.targets ?? {}) }
      delete targets[target]
      return { targets }
    },
    isStatus,
  )
}

// ------------------------------------------------------------------ the folder target

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** Why a folder cannot be a target (a text key), or null: it must be there, absolute, and not the board's own state folder. */
export function folderProblem(folder: string): string | null {
  if (!folder || !isAbsolute(folder)) return 'backup.err.folderAbsolute'
  let isDir = false
  try {
    isDir = statSync(folder).isDirectory()
  } catch {}
  if (!isDir) return 'backup.err.folderMissing'
  const inside = relative(resolve(stateDir()), resolve(folder))
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return 'backup.err.folderInState'
  return null
}

const snapshotsIn = (folder: string): string => join(folder, FOLDER_NAME)

/** Writes the snapshot as <time>-<hash>.abk through a temp file and a rename; its name. */
export function folderPut(folder: string, bytes: Uint8Array, now: number = Date.now()): string {
  const dir = snapshotsIn(folder)
  mkdirSync(dir, { recursive: true })
  const name = snapshotName(now, sha256(bytes))
  const tmp = join(dir, `.${name}.${process.pid}.part`)
  try {
    // on disk before it takes its name: a sync client never uploads half a snapshot under it
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWithRetry(tmp, join(dir, name))
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return name
}

export function folderList(folder: string): { name: string; size: number }[] {
  let names: string[]
  try {
    names = readdirSync(snapshotsIn(folder))
  } catch {
    return []
  }
  return names
    .filter(n => SNAPSHOT_NAME.test(n))
    .sort()
    .map(name => ({ name, size: statSync(join(snapshotsIn(folder), name)).size }))
}

export function folderGet(folder: string, name: string): Buffer {
  if (!SNAPSHOT_NAME.test(name)) throw new Error(`not a snapshot's name: ${name}`)
  return readFileSync(join(snapshotsIn(folder), name))
}

/** Removes what the rotation does not keep (and temp files a crash left, an hour old); the names removed. */
export function folderPrune(folder: string, now: number = Date.now()): string[] {
  const dir = snapshotsIn(folder)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const keep = rotationKeeps(
    names.filter(n => SNAPSHOT_NAME.test(n)),
    now,
  )
  const gone: string[] = []
  for (const n of names) {
    // one file at a time: one a sync client or a scanner holds (EBUSY, EPERM), or one gone since
    // the listing (ENOENT), stays for the next prune and keeps none of the others
    try {
      const stale = n.endsWith('.part') && now - statSync(join(dir, n)).mtimeMs > 3_600_000
      if ((SNAPSHOT_NAME.test(n) && !keep.has(n)) || stale) {
        rmSync(join(dir, n), { force: true })
        gone.push(n)
      }
    } catch {}
  }
  return gone
}
