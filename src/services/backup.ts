// Backups of the board's database (#233): the snapshot, its targets, when, and the way back.
//
// A snapshot is the whole file copied while writers go on (VACUUM INTO), checked whole (PRAGMA
// integrity_check), then sealed (core/backup-file.ts) and sent to every target that is due: the
// folder (adapters/backup-store.ts) and the owner's server (adapters/backup-ssh.ts). A damaged
// database, or a damaged copy, is never sent: it would only push a good snapshot out of the
// rotation. Each target's last good snapshot, last try and error go to status.json, which the
// panel, the board and `board doctor` read (core/backup.ts backupProblems).
//
// The web board runs the schedule (startBackups): every minute it looks at the journal's last seq
// and each target's state (core/backup.ts targetDue); a `board` command writes to the database
// without it, and the board backs up what changed the next time it looks. `board backup now`
// runs one by hand.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dropArgs, dropError, exchange } from '../adapters/backup-ssh.ts'
import {
  backupDir,
  dropKey,
  folderGet,
  folderList,
  folderProblem,
  folderPrune,
  folderPut,
  forgetTarget,
  readKey,
  readStatus,
  updateTarget,
  writeKey,
} from '../adapters/backup-store.ts'
import { type BoardDb, damageOf, dbFile, integrityOf, openDb, replaceContents } from '../adapters/db.ts'
import { hostKeyPinned, knownHostsReady, sshBin } from '../adapters/ssh.ts'
import {
  activeTargets,
  type BackupConfig,
  type BackupProblem,
  backedSeq,
  backupConfig,
  backupProblems,
  FUTURE_MS,
  passphraseProblem,
  problemSentence,
  SNAPSHOT_NAME,
  snapshotTime,
  TARGETS,
  type Target,
  type TargetState,
  targetDue,
} from '../core/backup.ts'
import { BackupFileError, type BackupKey, makeKey, seal, unseal } from '../core/backup-file.ts'
import { DROP_VERSION } from '../core/backup-server.ts'
import { t } from '../core/lang.ts'
import type { SetupCheck } from '../core/setup.ts'
import type { Config, Translator } from '../core/types.ts'
import { shortWhen } from '../core/when-format.ts'

export class BackupError extends Error {
  constructor(
    readonly key: string,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(t(key, vars))
    this.name = 'BackupError'
  }
}

const cfgOf = (cfg: Pick<Config, 'backup'>): BackupConfig => backupConfig(cfg.backup)

// ------------------------------------------------------------------ the snapshot

const TEMP = /^snapshot-\d+-[0-9a-f]{8}\.db(-wal|-shm|-journal)?$/

/**
 * The database's plain copies a run killed mid-way left in backup/ (a snapshot is the whole file,
 * unsealed, until it is sealed): gone at the start of the next run, ten minutes old or more.
 */
function sweepTemps(now: number): void {
  let names: string[] = []
  try {
    names = readdirSync(backupDir())
  } catch {
    return
  }
  for (const n of names) {
    if (!TEMP.test(n)) continue
    try {
      if (now - statSync(join(backupDir(), n)).mtimeMs > 10 * 60_000) rmSync(join(backupDir(), n), { force: true })
    } catch {}
  }
}

/** A temp file in backup/ for a copy of the database, gone after `fn` (its WAL files with it). */
async function withTemp<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  mkdirSync(backupDir(), { recursive: true })
  const path = join(backupDir(), `snapshot-${process.pid}-${randomBytes(4).toString('hex')}.db`)
  try {
    return await fn(path)
  } finally {
    for (const end of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${end}`, { force: true })
  }
}

export interface Snapshot {
  /** Sealed, as it leaves the computer. */
  sealed: Buffer
  /** The database's bytes (for Test's comparison). */
  plain: Buffer
  /** The journal's seq the copy holds at least. */
  seq: number
}

/** A sealed copy of the open database; throws BackupError when the copy is not whole. */
export async function snapshotOf(db: BoardDb, key: BackupKey): Promise<Snapshot> {
  // read before the copy: a change committed in between is in the copy too, and only makes the
  // next snapshot come sooner than it had to
  const seq = db.lastChange().seq
  return withTemp(path => {
    db.copyTo(path)
    const whole = integrityOf(path)
    if (!whole.ok) throw new BackupError('backup.err.copyDamaged', { detail: whole.detail })
    const plain = readFileSync(path)
    return { sealed: seal(plain, key), plain, seq }
  })
}

// ------------------------------------------------------------------ the targets

/** ssh, the drop key and the board's known_hosts, or why not. */
function dropWay(): { bin: string; key: string; knownHosts: string } {
  const bin = sshBin()
  if (!bin) throw new BackupError('backup.err.noSsh')
  if (!existsSync(dropKey())) throw new BackupError('backup.err.noDropKey')
  return { bin, key: dropKey(), knownHosts: knownHostsReady() }
}

/**
 * How a call to the drop logs in: always with the board's drop key and the server's key as the
 * board's known_hosts pins it; with `pin`, the one explicit call that may pin it first (a Test
 * after "Do it myself", with no Look before it). Scheduled backups never pin.
 */
export interface DropCall {
  pin?: boolean
}

async function drop(c: BackupConfig, command: string, input: Uint8Array | null, o: DropCall = {}) {
  if (!c.server) throw new BackupError('backup.err.noServer')
  const way = dropWay()
  const x = await exchange(
    way.bin,
    dropArgs({ server: c.server, key: way.key, knownHosts: way.knownHosts, command, ...(o.pin && { pin: true }) }),
    input,
  )
  if (x.code !== 0)
    throw new BackupError(refused(x.err) ? 'backup.err.refused' : 'backup.err.drop', { detail: dropError(x) })
  return x
}

/**
 * ssh's words for a login the server refused, or a server key that is not the one pinned: trying
 * again every hour changes nothing and may get the laptop's address banned (fail2ban), the tunnel's
 * too. Such a target is held until a Test or an Apply goes through.
 */
const REFUSED =
  /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Too many authentication failures/
export const refused = (said: string): boolean => REFUSED.test(said)

/** Sends a sealed snapshot to the target; the name it is kept under there. */
export async function sendTo(
  target: Target,
  c: BackupConfig,
  sealed: Buffer,
  now: number = Date.now(),
  o: DropCall = {},
): Promise<string> {
  if (target === 'folder') {
    if (!c.folder) throw new BackupError('backup.err.noFolder')
    const problem = folderProblem(c.folder)
    if (problem) throw new BackupError(problem, { folder: c.folder })
    const name = folderPut(c.folder, sealed, now)
    // a file a sync client or a scanner holds stays for the next time: the snapshot went through
    try {
      folderPrune(c.folder, now)
    } catch {}
    return name
  }
  // the size first: the drop keeps nothing that came cut short, and says the size it kept
  const x = await drop(c, `put ${sealed.length}`, sealed, o)
  const m = /^@@put (\S+) (\d+)$/m.exec(x.out.toString('utf8'))
  if (!m?.[1]) throw new BackupError('backup.err.drop', { detail: dropError(x) })
  if (Number(m[2]) !== sealed.length)
    throw new BackupError('backup.err.cutShort', { kept: m[2] ?? '?', sent: sealed.length })
  // the name ends with the start of the kept file's sha256: what went there is what was sent
  if (!m[1].endsWith(`-${createHash('sha256').update(sealed).digest('hex').slice(0, 8)}.abk`))
    throw new BackupError('backup.err.cutShort', { kept: m[2] ?? '?', sent: sealed.length })
  return m[1]
}

/** The snapshots a target holds, oldest first. */
export async function listAt(
  target: Target,
  c: BackupConfig,
  o: DropCall = {},
): Promise<{ name: string; size: number }[]> {
  if (target === 'folder') {
    if (!c.folder) throw new BackupError('backup.err.noFolder')
    return folderList(c.folder)
  }
  const x = await drop(c, 'list', null, o)
  return x.out
    .toString('utf8')
    .split('\n')
    .map(l => l.trim().split(' '))
    .filter(([name, size]) => name && SNAPSHOT_NAME.test(name) && /^\d+$/.test(size ?? ''))
    .map(([name, size]) => ({ name: name as string, size: Number(size) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** One snapshot's sealed bytes from a target. */
export async function fetchFrom(target: Target, c: BackupConfig, name: string, o: DropCall = {}): Promise<Buffer> {
  if (!SNAPSHOT_NAME.test(name)) throw new BackupError('backup.err.badName', { name })
  if (target === 'folder') {
    if (!c.folder) throw new BackupError('backup.err.noFolder')
    try {
      return folderGet(c.folder, name)
    } catch {
      throw new BackupError('backup.err.noSnapshot', { name })
    }
  }
  return (await drop(c, `get ${name}`, null, o)).out
}

/** The drop script's version on the server (`check`), so a Test can say an older one is there. */
async function dropVersion(c: BackupConfig, o: DropCall = {}): Promise<number> {
  const x = await drop(c, 'check', null, o)
  return Number(/^@@ok (\d+)/m.exec(x.out.toString('utf8'))?.[1] ?? 0)
}

// ------------------------------------------------------------------ a run

export interface RunReport {
  /** No database yet: nothing to back up. */
  nothing?: true
  /** The database holds fewer changes than a backup of it: nothing sent but by hand. */
  reset?: true
  sent: { target: Target; name: string }[]
  failed: { target: Target; error: string }[]
  skipped: Target[]
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * One backup: a snapshot sent to every active target that is due (all of them with `force`).
 * Nothing when there is no database. A damaged database, no key, or a copy that is not whole is
 * every due target's error, and nothing is sent.
 */
export async function backupNow(o: {
  cfg: Pick<Config, 'backup'>
  force?: boolean
  now?: () => number
}): Promise<RunReport> {
  const now = o.now ?? Date.now
  const c = cfgOf(o.cfg)
  const report: RunReport = { sent: [], failed: [], skipped: [] }
  sweepTemps(now())
  const db = openDb({ create: false })
  if (!db) return { ...report, nothing: true }
  try {
    const last = db.lastChange()
    const states = readStatus().targets
    // fewer changes than a backup of it had: emptied, or put back from an older copy. The backups
    // hold the better one; nothing scheduled replaces it (`reset`, shown) until one is sent by hand.
    if (!o.force && last.seq < backedSeq(states)) return { ...report, reset: true, skipped: activeTargets(c) }
    const due: Target[] = []
    for (const target of activeTargets(c)) {
      const s = states[target]
      const firstUnsaved = db.firstChangeAfter(s?.seq ?? -1)
      const why = s ? targetDue(s, { seq: last.seq, lastAt: last.at, firstUnsavedAt: firstUnsaved }, now()) : 'changes'
      if (o.force || why) due.push(target)
      else report.skipped.push(target)
    }
    if (!due.length) return report
    const fail = (error: string): RunReport => {
      for (const target of due) {
        record(target, now(), { error })
        report.failed.push({ target, error })
      }
      return report
    }
    const checked = db.check()
    if (!checked.ok) return fail(t('backup.problem.damaged', { detail: checked.detail }))
    const key = readKey()
    if (!key) return fail(t('backup.problem.noKey'))
    let snap: Snapshot
    try {
      snap = await snapshotOf(db, key)
    } catch (err) {
      return fail(message(err))
    }
    for (const target of due) {
      try {
        const name = await sendTo(target, c, snap.sealed, now())
        record(target, now(), { name, seq: snap.seq })
        report.sent.push({ target, name })
      } catch (err) {
        record(target, now(), failureOf(err))
        report.failed.push({ target, error: message(err) })
      }
    }
    // the WAL back into the file now that a copy is out (it stays small; a reader elsewhere may keep part of it)
    try {
      db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {}
    return report
  } finally {
    db.close()
  }
}

/** A target's attempt into status.json: what went through, or its error and the failures in a row. */
function record(
  target: Target,
  at: number,
  r: { name: string; seq: number } | { error: string; held?: boolean },
): TargetState {
  return updateTarget(target, s =>
    'error' in r
      ? { ...s, lastTry: at, error: r.error, failures: s.failures + 1, held: r.held ? r.error : (s.held ?? null) }
      : { ...s, lastTry: at, lastOk: at, name: r.name, seq: r.seq, error: null, failures: 0, held: null },
  )
}

/** A failure as status.json keeps it: a refused login holds the target (no hourly retries). */
const failureOf = (err: unknown): { error: string; held: boolean } => ({
  error: message(err),
  held: err instanceof BackupError && err.key === 'backup.err.refused',
})

// ------------------------------------------------------------------ the schedule

export interface Backups {
  /** Runs a backup now, unless one runs (its report then). */
  now(force?: boolean): Promise<RunReport>
  stop(): void
}

/** How often the web board looks whether a target is due. */
export const TICK_MS = 60_000

/**
 * The web board's schedule: every TICK_MS, once the database is there, a backup when a target is
 * due (backupNow decides); one at a time. The first look a little after the board starts. And a
 * quick check of the database at the start, so a damaged file is marked before anybody writes.
 */
export function startBackups(o: {
  cfg: () => Pick<Config, 'backup'>
  onChange: () => void
  tickMs?: number
  firstMs?: number
}): Backups {
  let running: Promise<RunReport> | null = null
  let stopped = false
  const run = (force = false): Promise<RunReport> => {
    if (running) return running
    running = backupNow({ cfg: o.cfg(), force })
      // what failed per target is in status.json already; a database that would not open is marked
      .catch((): RunReport => ({ sent: [], failed: [], skipped: [] }))
      .finally(() => {
        running = null
        o.onChange()
      })
    return running
  }
  const tick = (): void => {
    if (stopped || !existsSync(dbFile()) || !activeTargets(cfgOf(o.cfg())).length) return
    void run()
  }
  const first = setTimeout(() => {
    if (stopped || !existsSync(dbFile())) return
    try {
      const db = openDb({ create: false })
      if (db) {
        const checked = db.check()
        db.close()
        if (!checked.ok) o.onChange()
      }
    } catch {
      o.onChange()
    }
    tick()
  }, o.firstMs ?? 30_000)
  const timer = setInterval(tick, o.tickMs ?? TICK_MS)
  first.unref?.()
  timer.unref?.()
  return {
    now: (force = true) => run(force),
    stop: () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
    },
  }
}

// ------------------------------------------------------------------ the passphrase and Test

/** A passphrase, typed twice, made into the key the board keeps. Changing it leaves older snapshots to the old passphrase. */
export async function setPassphrase(
  passphrase: string,
  again: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (passphrase !== again) return { ok: false, error: t('backup.err.passphraseDiffers') }
  const problem = passphraseProblem(passphrase)
  if (problem) return { ok: false, error: t(problem) }
  const written = await writeKey(makeKey(passphrase))
  return written.ok ? { ok: true } : { ok: false, error: t('backup.err.keyWrite', { detail: written.error }) }
}

export interface TestReport {
  ok: boolean
  /** The snapshot Test sent and read back. */
  name?: string
  error?: string
  /** The server's drop script is older than this board's: Apply again. */
  oldDrop?: boolean
}

/**
 * A target tried for real: a snapshot (of the database, or of an empty one while there is none)
 * sent, read back, opened with the board's key and compared byte for byte. A database snapshot
 * that went through counts as that target's backup.
 */
export async function testTarget(
  target: Target,
  cfg: Pick<Config, 'backup'>,
  now: () => number = Date.now,
): Promise<TestReport> {
  const c = cfgOf(cfg)
  const key = readKey()
  if (!key) return { ok: false, error: t('backup.problem.noKey') }
  try {
    // this explicit call may pin the server's key when none is pinned yet ("Do it myself" with no
    // Look before it); the version check is its first login, every later one is strict
    const pin = target === 'server' && !!c.server && !(await hostKeyPinned(c.server.host, c.server.port))
    if (target === 'server' && (await dropVersion(c, { pin })) < DROP_VERSION)
      return { ok: false, oldDrop: true, error: t('backup.err.oldDrop') }
    const live = openDb({ create: false })
    let snap: Snapshot
    try {
      snap = live
        ? await snapshotOf(live, key)
        : await withTemp(async path => {
            const empty = openDb({ path })
            try {
              return { ...(await snapshotOf(empty as BoardDb, key)), seq: -1 }
            } finally {
              empty?.close()
            }
          })
    } finally {
      live?.close()
    }
    const name = await sendTo(target, c, snap.sealed, now())
    const back = await fetchFrom(target, c, name)
    const opened = unseal(back, key)
    if (!opened.equals(snap.plain)) return { ok: false, name, error: t('backup.err.notSame') }
    if (snap.seq >= 0) record(target, now(), { name, seq: snap.seq })
    else updateTarget(target, s => ({ ...s, held: null, error: null, failures: 0 }))
    return { ok: true, name }
  } catch (err) {
    const error = err instanceof BackupFileError ? t(err.message) : message(err)
    return { ok: false, error }
  }
}

// ------------------------------------------------------------------ restore

/** Where a restore takes its snapshot from: a file, or a target's snapshot by name (the newest when none is named). */
export type RestoreFrom = { file: string } | { target: Target; name?: string }

export interface RestoreReport {
  /** What was restored: the file, or target/name. */
  from: string
  /** The copy of the database as it was before, beside it (null: it could not be copied). */
  before: string | null
  /** The rows were put into the live file (false: the file itself was replaced, the board stopped). */
  inPlace: boolean
  /** Where the damaged file went when the file was replaced. */
  aside?: string
  /** Newer snapshots passed over because they did not open whole (the newest is taken when none is named). */
  skipped: string[]
}

const stamp = (at: number): string =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
/** Copies of the database kept before a restore. */
const BEFORE_KEPT = 3

function keepFewest(path: string, prefix: string): void {
  const dir = dirname(path)
  const copies = readdirSync(dir)
    .filter(f => f.startsWith(prefix))
    .map(f => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const old of copies.slice(BEFORE_KEPT)) rmSync(join(dir, old.f), { force: true })
}

/**
 * The database back as a snapshot has it. The snapshot is opened (the board's key, else the
 * passphrase), unpacked and checked whole; the database as it is now is copied beside it first
 * (board.db.before-restore-<time>), so a restore can be undone by another; then its rows are
 * replaced in place (db.ts replaceContents) while the board runs. A database too damaged for that
 * is replaced as a file with `replaceFile`, only while the web board is stopped (`boardRunning`
 * says), its files moved aside to damaged-<time>/.
 */
export async function restore(o: {
  from: RestoreFrom
  cfg: Pick<Config, 'backup'>
  passphrase?: string | null
  by: string
  replaceFile?: boolean
  boardRunning?: () => Promise<boolean>
  now?: () => number
}): Promise<RestoreReport> {
  const now = o.now ?? Date.now
  const c = cfgOf(o.cfg)
  const key = readKey()
  /** One sealed file opened and written to `path`, checked whole; or why not. */
  const openTo = async (sealed: Buffer, path: string): Promise<BackupError | null> => {
    let plain: Buffer
    try {
      plain = unseal(sealed, key, o.passphrase ?? null)
    } catch (err) {
      if (err instanceof BackupFileError) return new BackupError(err.message)
      throw err
    }
    await Bun.write(path, plain)
    const whole = integrityOf(path)
    return whole.ok ? null : new BackupError('backup.err.copyDamaged', { detail: whole.detail })
  }
  return withTemp(async path => {
    let from: string
    let skipped: string[] = []
    if ('file' in o.from) {
      from = o.from.file
      let sealed: Buffer
      try {
        sealed = readFileSync(o.from.file)
      } catch {
        throw new BackupError('backup.err.noFile', { file: o.from.file })
      }
      const why = await openTo(sealed, path)
      if (why) throw why
    } else if (o.from.name) {
      from = `${o.from.target}/${o.from.name}`
      const why = await openTo(await fetchFrom(o.from.target, c, o.from.name), path)
      if (why) throw why
    } else {
      // the newest that opens whole: a newest one cut short or altered does not stand in the way;
      // one that wants another passphrase stops the search (they all will)
      const target = o.from.target
      // a name dated more than a day ahead is no snapshot of this board's clock (a planted one)
      const list = (await listAt(target, c)).filter(x => (snapshotTime(x.name) ?? 0) <= now() + FUTURE_MS)
      if (!list.length) throw new BackupError('backup.err.noneThere', { target })
      let found: string | null = null
      let last: BackupError | null = null
      for (const { name } of [...list].reverse()) {
        const why = await openTo(await fetchFrom(target, c, name), path)
        if (!why) {
          found = name
          break
        }
        if (why.key === 'backup.file.needPassphrase') throw why
        last = why
        skipped = [...skipped, name]
      }
      if (!found) throw last ?? new BackupError('backup.err.noneThere', { target })
      from = `${target}/${found}`
    }
    const live = dbFile()
    const beforePath = `${live}.before-restore-${stamp(now())}`
    if (o.replaceFile) {
      if (await (o.boardRunning ?? (async () => false))()) throw new BackupError('backup.err.boardRunning')
      const aside = join(dirname(live), `damaged-${stamp(now())}`)
      const { renameSync, copyFileSync } = await import('node:fs')
      const moved: string[] = []
      try {
        for (const end of ['', '-wal', '-shm', '.damaged.json']) {
          if (!existsSync(`${live}${end}`)) continue
          mkdirSync(aside, { recursive: true })
          renameSync(`${live}${end}`, join(aside, `board.db${end}`))
          moved.push(end)
        }
      } catch (err) {
        // another process holds the file (Windows refuses the rename): what moved goes back
        for (const end of moved) renameSync(join(aside, `board.db${end}`), `${live}${end}`)
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new BackupError('backup.err.boardRunning')
        throw err
      }
      copyFileSync(path, live)
      // the targets' seq was the old file's: the next backup takes this one
      for (const target of TARGETS) if (readStatus().targets[target]) updateTarget(target, s => ({ ...s, seq: -1 }))
      return { from, before: null, inPlace: false, ...(moved.length && { aside }), skipped }
    }
    const db = openDb({ create: true })
    if (!db) throw new BackupError('backup.err.noDb')
    try {
      try {
        // the copy of the database as it was is written inside the restore's own transaction
        replaceContents(db, path, o.by, from, beforePath)
      } catch (err) {
        throw new BackupError('backup.err.inPlace', { detail: message(err) })
      }
      keepFewest(live, `${live.slice(dirname(live).length + 1)}.before-restore-`)
      return { from, before: beforePath, inPlace: true, skipped }
    } finally {
      db.close()
    }
  })
}

// ------------------------------------------------------------------ the view

export interface BackupView {
  /** There is a database to back up. */
  needed: boolean
  config: BackupConfig
  key: { made: number } | null
  states: Partial<Record<Target, TargetState>>
  problems: BackupProblem[]
  /** The database's damage mark's detail, null when it has none. */
  damaged: string | null
  /** The drop key's public half is there (the server target can be set up). */
  dropKey: boolean
}

/** The database's change counter, read at most every SEQ_MS (the payload asks every refresh); null when it cannot be read. */
const SEQ_MS = 10_000
let seqRead: { at: number; path: string; seq: number | null } | null = null
function dbSeq(now: number): number | null {
  const path = dbFile()
  if (seqRead && seqRead.path === path && now - seqRead.at < SEQ_MS) return seqRead.seq
  let seq: number | null = null
  try {
    const db = openDb({ create: false })
    if (db) {
      seq = db.lastChange().seq
      db.close()
    }
  } catch {}
  seqRead = { at: now, path, seq }
  return seq
}

export function backupView(cfg: Pick<Config, 'backup'>, now: number = Date.now()): BackupView {
  const config = cfgOf(cfg)
  const needed = existsSync(dbFile())
  const key = readKey()
  const states = readStatus().targets
  const damaged = needed ? damageOf() : null
  const seq = needed ? dbSeq(now) : null
  return {
    needed,
    config,
    key: key ? { made: key.made } : null,
    states,
    problems: backupProblems({ needed, cfg: config, keySet: !!key, damaged, states, now, seq }),
    damaged,
    dropKey: existsSync(`${dropKey()}.pub`),
  }
}

/** A target removed or set anew: its old state means nothing now. */
export const resetTarget = (target: Target): void => forgetTarget(target)

// ------------------------------------------------------------------ `board doctor`

/** A path a sync client watches: the database must not live there (it copies the file mid-write, and WAL's shared memory is local). */
const SYNCED = /\/(OneDrive[^/]*|Dropbox|Google Drive|My Drive|iCloud Drive|iCloudDrive)(\/|$)/i
/** Whether a path is in a folder a sync client watches; a Windows path's backslashes read as slashes. */
export const syncedPath = (path: string): boolean => SYNCED.test(path.replaceAll('\\', '/'))

/**
 * `board doctor`'s lines for the database and its backup (#233): none while there is neither a
 * database nor a target. The database: SQLite's version, where the file lives, whether it opens.
 * The backup: each problem as an error, else the last good backup.
 */
export function backupChecks(cfg: Pick<Config, 'backup'>, tr: Translator): SetupCheck[] {
  const v = backupView(cfg)
  if (!v.needed && !cfg.backup) return []
  const check = (c: Partial<SetupCheck> & Pick<SetupCheck, 'id' | 'level' | 'title'>): SetupCheck => ({
    detail: '',
    fix: '',
    code: '',
    ...c,
  })
  const out: SetupCheck[] = []
  if (v.needed) {
    const file = dbFile()
    let opened: string | null = null
    try {
      const db = openDb({ create: false })
      const version = (db?.db.query('SELECT sqlite_version() AS v').get() as { v: string } | null)?.v ?? ''
      db?.close()
      opened = version
    } catch (err) {
      out.push(
        check({
          id: 'db',
          level: 'error',
          title: tr('db.check.title'),
          detail: message(err),
          code: tr('backup.check.restore'),
        }),
      )
    }
    if (opened !== null)
      out.push(
        syncedPath(file)
          ? check({ id: 'db', level: 'warn', title: tr('db.check.synced'), detail: file })
          : check({ id: 'db', level: 'ok', title: tr('db.check.ok', { version: opened }), detail: file }),
      )
  }
  if (v.problems.length)
    for (const p of v.problems)
      out.push(
        check({
          id: `backup-${p.kind}`,
          level: 'error',
          title: tr('backup.check.title'),
          detail: problemSentence(p, tr),
          fix: tr('backup.check.fix'),
        }),
      )
  else {
    let last: number | null = null
    for (const s of Object.values(v.states)) if (s?.lastOk && (last === null || s.lastOk > last)) last = s.lastOk
    out.push(
      check({
        id: 'backup',
        level: 'ok',
        title: tr('backup.check.title'),
        detail: last ? tr('backup.check.ok', { when: shortWhen(last, tr) }) : tr('backup.nothing'),
      }),
    )
  }
  return out
}
