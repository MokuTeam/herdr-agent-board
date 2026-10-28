// Backups of the board's database (#233): config.json's `backup` section, a snapshot's name, which
// snapshots the rotation keeps, when the next snapshot is due, and what is wrong with the backup as
// the panel, the board and `board doctor` say it. Pure, with no node: import: the page uses it too.
//
// A snapshot is the whole database (VACUUM INTO), gzipped and encrypted (core/backup-file.ts), sent
// to each target: a folder a sync client takes off the computer, and the owner's server over ssh
// (core/backup-server.ts). Nothing stays on this computer only.

/** The two kinds of target. */
export const TARGETS = ['folder', 'server'] as const
export type Target = (typeof TARGETS)[number]
export const isTarget = (v: unknown): v is Target => TARGETS.includes(v as Target)

/** The server's side: where, and as whom the owner sets it up. */
export interface ServerTarget {
  host: string
  port: number
  /** The owner's login for Look, Apply and Undo (as the tunnel's `admin`): a user, and a key ('' for ssh's own). */
  admin: { user: string; key: string }
  /** When Apply, or the owner's own setup and a Test, made the server take snapshots; absent: not yet, or undone. */
  set?: string
}

export interface BackupConfig {
  /** A folder that syncs elsewhere (OneDrive, Google Drive, Dropbox): the board writes its snapshots in its agent-board-backups. */
  folder: string | null
  server: ServerTarget | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** config.json's `backup`, whatever it holds: anything else is no target. */
export function backupConfig(raw: unknown): BackupConfig {
  const b = isObject(raw) ? raw : {}
  const folder = text(b.folder) || null
  let server: ServerTarget | null = null
  if (isObject(b.server) && text(b.server.host)) {
    const s = b.server
    const port = Number(s.port)
    const admin = isObject(s.admin) ? s.admin : {}
    server = {
      host: text(s.host),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
      admin: { user: text(admin.user), key: text(admin.key) },
      ...(text(s.set) && { set: text(s.set) }),
    }
  }
  return { folder, server }
}

/** The targets snapshots go to: the folder when named, the server once it was set up. */
export function activeTargets(c: BackupConfig): Target[] {
  const out: Target[] = []
  if (c.folder) out.push('folder')
  if (c.server?.set) out.push('server')
  return out
}

// ------------------------------------------------------------------ names

/** A snapshot's file name: when it was made (UTC, to the second) and the start of its sha256. */
export const SNAPSHOT_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([0-9a-f]{8})\.abk$/

/** The name of a snapshot made at `at` with this hash. */
export function snapshotName(at: number, sha256hex: string): string {
  const d = new Date(at)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return `${stamp}-${sha256hex.slice(0, 8).toLowerCase()}.abk`
}

/** When a snapshot was made, from its name; null for a name that is not a snapshot's. */
export function snapshotTime(name: string): number | null {
  const m = SNAPSHOT_NAME.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  const at = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(at)
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : null
}

// ------------------------------------------------------------------ rotation

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Every snapshot of the last 48 hours. */
export const KEEP_ALL_MS = 48 * HOUR
/** The first of each day (UTC) for 60 days. */
export const KEEP_DAILY_MS = 60 * DAY
/** The first of each month (UTC) for two years. */
export const KEEP_MONTHLY_MS = 730 * DAY

/**
 * The names the rotation keeps, of `names` (any order; names that are not a snapshot's are left
 * alone and kept): every one of the last 48 hours, one made later than now too (a clock put back),
 * the first of each day for 60 days, the first of each month for two years. The server's drop
 * script prunes by the same rule (core/backup-server.ts), the tests hold the two together.
 */
export function rotationKeeps(names: readonly string[], now: number): Set<string> {
  const keep = new Set<string>()
  const dated = names
    .map(name => ({ name, at: snapshotTime(name) }))
    .filter((x): x is { name: string; at: number } => {
      if (x.at === null) keep.add(x.name)
      return x.at !== null
    })
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1))
  const days = new Set<string>()
  const months = new Set<string>()
  for (const { name, at } of dated) {
    const age = now - at
    const day = name.slice(0, 8)
    const month = name.slice(0, 6)
    const firstOfDay = !days.has(day)
    const firstOfMonth = !months.has(month)
    days.add(day)
    months.add(month)
    if (age < KEEP_ALL_MS || (firstOfDay && age < KEEP_DAILY_MS) || (firstOfMonth && age < KEEP_MONTHLY_MS))
      keep.add(name)
  }
  return keep
}

// ------------------------------------------------------------------ when

/** A snapshot waits this long after the last change, so a burst of edits makes one. */
export const QUIET_MS = 10 * 60_000
/** And never longer than this after the first change it has not taken. */
export const MOST_WAIT_MS = 60 * 60_000
/** The daily snapshot's local hour, made even without changes so "last good backup" stays fresh. */
export const DAILY_HOUR = 3
/** A target that failed is tried again after these waits, the last one from then on. */
export const RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const
/** A last good backup older than this is a problem. */
export const STALE_MS = 24 * HOUR

/** The latest daily mark at or before `now`: DAILY_HOUR o'clock local, today's or yesterday's. */
export function lastDailyMark(now: number): number {
  const d = new Date(now)
  const mark = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAILY_HOUR, 0, 0, 0).getTime()
  if (mark <= now) return mark
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, DAILY_HOUR, 0, 0, 0)
  return y.getTime()
}

/** One target's state, as backup-status.json keeps it. */
export interface TargetState {
  /** When its last snapshot went through, and which. */
  lastOk: number | null
  name: string | null
  /** The journal's seq that snapshot holds. */
  seq: number
  /** The last attempt, and its error (null: it went through). */
  lastTry: number | null
  error: string | null
  /** Failures in a row, for the wait before the next try. */
  failures: number
}

export const freshTarget = (): TargetState => ({
  lastOk: null,
  name: null,
  seq: -1,
  lastTry: null,
  error: null,
  failures: 0,
})

/**
 * Why a target wants a snapshot now, or null: it holds an older seq than the database and the
 * changes have been quiet for QUIET_MS (or wait past MOST_WAIT_MS), or it has nothing since today's
 * daily mark; a target that failed waits RETRY_MS first.
 */
export function targetDue(
  s: TargetState,
  db: { seq: number; lastAt: number; firstUnsavedAt: number | null },
  now: number,
): 'changes' | 'daily' | 'retry' | null {
  if (s.error !== null && s.lastTry !== null) {
    const wait = RETRY_MS[Math.min(Math.max(s.failures, 1), RETRY_MS.length) - 1] ?? RETRY_MS[0]
    if (now - s.lastTry < wait) return null
  }
  const behind = db.seq > s.seq
  if (behind) {
    const quiet = now - db.lastAt >= QUIET_MS
    const waited = db.firstUnsavedAt !== null && now - db.firstUnsavedAt >= MOST_WAIT_MS
    if (quiet || waited || s.seq < 0) return s.error !== null ? 'retry' : 'changes'
  }
  if (s.lastOk === null || s.lastOk < lastDailyMark(now)) return s.error !== null ? 'retry' : 'daily'
  return null
}

// ------------------------------------------------------------------ what is wrong

export type BackupProblem =
  | { kind: 'noTarget' }
  | { kind: 'noKey' }
  | { kind: 'damaged'; detail: string }
  | { kind: 'never'; target: Target }
  | { kind: 'stale'; target: Target; lastOk: number; hours: number }
  | { kind: 'failing'; target: Target; error: string }

/**
 * What is wrong, most important first: only once there is something to back up (`needed`: the
 * database is there). No target; no key; the database damaged; per target, nothing ever went
 * through, the last good one older than STALE_MS, or the last try failed.
 */
export function backupProblems(o: {
  needed: boolean
  cfg: BackupConfig
  keySet: boolean
  damaged: string | null
  states: Partial<Record<Target, TargetState>>
  now: number
}): BackupProblem[] {
  if (!o.needed) return []
  const out: BackupProblem[] = []
  if (o.damaged !== null) out.push({ kind: 'damaged', detail: o.damaged })
  const targets = activeTargets(o.cfg)
  if (!targets.length) out.push({ kind: 'noTarget' })
  if (!o.keySet) out.push({ kind: 'noKey' })
  for (const target of targets) {
    const s = o.states[target] ?? freshTarget()
    if (s.lastOk === null) out.push({ kind: 'never', target })
    else if (o.now - s.lastOk > STALE_MS)
      out.push({ kind: 'stale', target, lastOk: s.lastOk, hours: Math.floor((o.now - s.lastOk) / HOUR) })
    if (s.error !== null) out.push({ kind: 'failing', target, error: s.error })
  }
  return out
}

/** What the board's payload carries: the newest good backup over all targets, and the first problem's text key and values. */
export interface BackupLine {
  last: number | null
  problem: BackupProblem | null
}

export function backupLine(
  problems: readonly BackupProblem[],
  states: Partial<Record<Target, TargetState>>,
): BackupLine {
  let last: number | null = null
  for (const s of Object.values(states)) if (s?.lastOk && (last === null || s.lastOk > last)) last = s.lastOk
  return { last, problem: problems[0] ?? null }
}

/** A problem in the board's words (core/i18n/backup-strings.ts), for the page, `board doctor` and the command. */
export function problemSentence(
  p: BackupProblem,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (p.kind) {
    case 'noTarget':
    case 'noKey':
      return t(`backup.problem.${p.kind}`)
    case 'damaged':
      return t('backup.problem.damaged', { detail: p.detail })
    case 'never':
      return t('backup.problem.never', { target: t(`backup.target.${p.target}`) })
    case 'stale':
      return t('backup.problem.stale', { target: t(`backup.target.${p.target}`), hours: p.hours })
    case 'failing':
      return t('backup.problem.failing', { target: t(`backup.target.${p.target}`), error: p.error })
  }
}

/** The shortest passphrase taken. */
export const PASSPHRASE_MIN = 10

/** Why a passphrase is refused (a text key), or null. */
export function passphraseProblem(p: string): string | null {
  if (p.length < PASSPHRASE_MIN) return 'backup.err.passphraseShort'
  if (p.trim() !== p) return 'backup.err.passphraseSpaces'
  return null
}
