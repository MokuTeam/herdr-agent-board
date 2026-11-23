// The board updates itself from git (#617), switched on in Settings: config.json's `autoUpdate`, off
// while it is absent. When it is due (every hour, or once a day at a set time) or asked
// (`board update`, Settings' Check now), the web board fetches the branch its checkout is on and
// fast-forwards to its upstream, nothing else: it never switches branches, merges or resets. What is
// unusual (no checkout, a detached HEAD, no upstream, changes in tracked files, a failed fetch, a
// branch that went its own way, package.json or bun.lock added or removed) is skipped with a reason
// and tried again at the next check. A board that is a node follows its master's commit (#590)
// instead. This file holds the decisions; services/self-update.ts runs them.
import type { SetupCheck } from './setup.ts'
import type { Translator } from './types.ts'

export type Every = 'hour' | 'day'

export interface AutoUpdateConfig {
  on: boolean
  every: Every
  /** The time of day (local, HH:MM) of the daily check. */
  at: string
}

export const DEFAULT_AT = '04:00'
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
export const isTimeOfDay = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v)
export const isEvery = (v: unknown): v is Every => v === 'hour' || v === 'day'

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * config.json's `autoUpdate`: absent, false or `{ "on": false, … }` is off; `true` or an object
 * without `"on": false` is on (core/feature-switch.ts). `every` defaults to an hour, `at` to 04:00.
 */
export function autoUpdateConfig(raw: unknown): AutoUpdateConfig {
  const r = record(raw)
  const on = raw === true || (r !== null && r.on !== false)
  return { on, every: isEvery(r?.every) ? r.every : 'hour', at: isTimeOfDay(r?.at) ? r.at : DEFAULT_AT }
}

/** Why a check did not update: said in Settings and in board doctor, tried again at the next check. */
export type SkipReason =
  | 'node'
  | 'no-checkout'
  | 'detached'
  | 'no-upstream'
  | 'dirty'
  | 'fetch'
  | 'diverged'
  | 'lockfiles'
  | 'busy'
  | 'restart'
  | 'running'

/** Why an update that started did not end well. */
export type FailReason = 'install' | 'merge' | 'installer' | 'not-back' | 'wake'

export const SKIP_REASONS: readonly SkipReason[] = [
  'node',
  'no-checkout',
  'detached',
  'no-upstream',
  'dirty',
  'fetch',
  'diverged',
  'lockfiles',
  'busy',
  'restart',
  'running',
]
export const FAIL_REASONS: readonly FailReason[] = ['install', 'merge', 'installer', 'not-back', 'wake']

/** One check, as the state file keeps it. */
export interface UpdateRecord {
  at: number
  outcome: 'current' | 'updated' | 'skipped' | 'failed'
  reason?: SkipReason | FailReason
  /** The first lines of what git or the installer said. */
  detail?: string
  branch?: string
  /** The commit the checkout is on after the check. */
  commit?: string
  from?: string
  to?: string
  /** What came in: the titles of the commits on the branch's first-parent line (the merged pull requests). */
  came?: string[]
  /** Run by hand (board update, Check now), not by the schedule. */
  byHand?: boolean
}

/** An update merged, the board restarting on it: the new board finishes it (services/self-update.ts resume). */
export interface PendingUpdate {
  at: number
  from: string
  to: string
  branch: string
  installer: boolean
  came: string[]
  byHand: boolean
  /** Wake ran when the update began: it is expected back. */
  wake: boolean
}

export interface UpdateState {
  /** The last check, whatever came of it. */
  last?: UpdateRecord
  /** The last check that updated: what came in last time. */
  lastUpdate?: UpdateRecord
  pending?: PendingUpdate
  /**
   * An update that merged but did not end well (the installer or wake): kept, and said, until a
   * later check mends it (the installer runs again) or another update goes through.
   */
  failure?: UpdateRecord
  /**
   * The lock files taken from upstream for bun install, before the merge: a board that ended in
   * between finds them here and puts them back (with the dependencies) before anything else.
   */
  installing?: { at: number; files: string[] }
}

/** A pending update older than this is a board that did not come back. */
export const BACK_MS = 3 * 60_000
/** A check that waited on a launch in flight is tried again this soon. */
export const BUSY_RETRY_MS = 5 * 60_000
const HOUR = 60 * 60_000

/** The checkout as it is before the fetch. */
export interface CheckoutLook {
  node: boolean
  checkout: boolean
  /** null: a detached HEAD. */
  branch: string | null
  /** The upstream, as git names it (origin/main); null: none set. */
  upstream: string | null
  /** Changes in tracked files, staged or not (untracked files are left alone: a fast-forward never overwrites one). */
  dirty: boolean
  /** Something starts the board again when it ends (run.ts). */
  canRestart: boolean
  /** A pending update not yet finished, recent. */
  pending: boolean
}

/** Why the checkout is not updated before anything is fetched, or null. */
export function skipBefore(look: CheckoutLook): SkipReason | null {
  if (look.node) return 'node'
  if (look.pending) return 'running'
  if (!look.checkout) return 'no-checkout'
  if (look.branch === null) return 'detached'
  if (look.upstream === null) return 'no-upstream'
  if (look.dirty) return 'dirty'
  if (!look.canRestart) return 'restart'
  return null
}

/** After the fetch, by `git rev-list --left-right --count HEAD...@{u}`. */
export function afterFetch(ahead: number, behind: number): 'current' | 'diverged' | 'behind' {
  if (behind === 0) return 'current'
  return ahead > 0 ? 'diverged' : 'behind'
}

/** `git rev-list --left-right --count`'s "<ahead>\t<behind>", or null. */
export function parseCounts(text: string): { ahead: number; behind: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text)
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null
}

/** The dependencies' inputs: a change in one runs bun install. */
export const LOCK_FILES = ['package.json', 'bun.lock'] as const
/** What the installer (entrypoints/install.ts) writes from: a change in one runs it again. */
export const INSTALLER_INPUTS = [
  'src/entrypoints/install.ts',
  'src/core/install-plan.ts',
  'src/adapters/hook-settings.ts',
  'src/adapters/agents-skill.ts',
  'src/adapters/launchers.ts',
  'src/core/wake/launchers.ts',
]

export interface UpdatePlan {
  /** bun install, before the merge. */
  install: boolean
  /** The installer, once the board runs the new code. */
  installer: boolean
  /** The board and wake restart (their code, the page or the dependencies changed). */
  restart: boolean
}

/** What a pull of these files (`git diff --name-only HEAD @{u}`) needs after it. */
export function planFor(changed: readonly string[]): UpdatePlan {
  const install = changed.some(f => (LOCK_FILES as readonly string[]).includes(f) || f.startsWith('packages/'))
  const installer = changed.some(f => f.startsWith('skills/') || INSTALLER_INPUTS.includes(f))
  const restart = install || changed.some(f => f.startsWith('src/') || f.startsWith('web/'))
  return { install, installer, restart }
}

/**
 * `git diff --name-status HEAD @{u} -- package.json bun.lock`: the lock files changed in place, which
 * bun install takes before the merge, or 'lockfiles' when one is added, removed or renamed.
 */
export function lockChanges(nameStatus: string): string[] | 'lockfiles' {
  const files: string[] = []
  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const [status = '', file = ''] = line.split('\t')
    if (status !== 'M') return 'lockfiles'
    files.push(file)
  }
  return files
}

const FIELD = '\x1f'
const ENTRY = '\x1e'
/** The format `parseTitles` reads: subject and body of each commit. */
export const TITLES_FORMAT = `%s${FIELD}%b${ENTRY}`
const MAX_TITLES = 30

/**
 * The titles of what came in, newest first, from `git log --first-parent --format=TITLES_FORMAT`: a
 * squashed pull request's subject as it is, a merge commit's ("Merge pull request #12 from …") the
 * first line of its body with the number.
 */
export function parseTitles(text: string): string[] {
  const out: string[] = []
  for (const entry of text.split(ENTRY)) {
    const [subject = '', body = ''] = entry.replace(/^\s+/, '').split(FIELD)
    if (!subject.trim()) continue
    const merge = /^Merge pull request (#\d+) from /.exec(subject)
    const first = body.split(/\r?\n/).find(l => l.trim())
    out.push(merge && first ? `${first.trim()} (${merge[1]})` : subject.trim())
  }
  return out.length > MAX_TITLES ? [...out.slice(0, MAX_TITLES), `+${out.length - MAX_TITLES}`] : out
}

/** The latest moment at the time of day `at` that is not after `now` (local time). */
export function lastSlot(at: string, now: number): number {
  const [h = 0, m = 0] = at.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() > now) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/**
 * Whether the schedule asks for a check now. Every hour: an hour after the last check (at once when
 * there is none). Once a day: the day's time passed since the last check, or, with none, since the
 * board started (a board started after the time waits for the next day's). A check that waited on a
 * launch in flight is tried again five minutes later.
 */
export function due(cfg: AutoUpdateConfig, last: UpdateRecord | undefined, now: number, startedAt: number): boolean {
  if (!cfg.on) return false
  if (last?.outcome === 'skipped' && last.reason === 'busy' && !last.byHand) return now - last.at >= BUSY_RETRY_MS
  if (cfg.every === 'hour') return !last || now - last.at >= HOUR
  return lastSlot(cfg.at, now) > (last?.at ?? startedAt)
}

/** The first lines of a program's output, for a record. */
export function firstLines(text: string, n = 6): string {
  return text
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(Boolean)
    .slice(0, n)
    .join('\n')
    .slice(0, 800)
}

/** A short commit for messages. */
export const shortSha = (sha: string | undefined): string => (sha ?? '').slice(0, 8)

export type UpdateLevel = 'ok' | 'warn' | 'error'

/** How the updates stand, for Settings and board doctor: the worst first. */
export interface UpdateStanding {
  level: UpdateLevel
  /** The problem's or the state's key (selfUpdate.<key>), its values. */
  key: string
  values: Record<string, string | number>
}

/** A pending update past BACK_MS: the board did not come back on it. */
export const stalePending = (s: UpdateState, now: number): boolean => !!s.pending && now - s.pending.at > BACK_MS

/** One sentence on how the updates stand, or null when they are off and nothing was ever done. */
export function standing(cfg: AutoUpdateConfig, s: UpdateState, now: number): UpdateStanding | null {
  const p = s.pending
  if (p && stalePending(s, now))
    return { level: 'error', key: 'notBack', values: { to: shortSha(p.to), from: shortSha(p.from) } }
  if (p) return { level: 'ok', key: 'restarting', values: { to: shortSha(p.to) } }
  const last = s.last?.outcome === 'failed' ? s.last : (s.failure ?? s.last)
  if (!last) return cfg.on ? { level: 'ok', key: 'notYet', values: {} } : null
  if (last.outcome === 'failed')
    return {
      level: 'error',
      key: `failed.${last.reason ?? 'install'}`,
      values: { from: shortSha(last.from), to: shortSha(last.to), detail: last.detail ?? '' },
    }
  if (last.outcome === 'skipped')
    return {
      level: last.reason === 'node' || last.reason === 'busy' || last.reason === 'running' ? 'ok' : 'warn',
      key: `skipped.${last.reason ?? 'fetch'}`,
      values: { branch: last.branch ?? '', detail: last.detail ?? '' },
    }
  if (!cfg.on) return null
  return {
    level: 'ok',
    key: last.outcome === 'updated' ? 'updated' : 'current',
    values: { commit: shortSha(last.commit) },
  }
}

/** The standing as one line in the board's language. */
export function standingText(st: UpdateStanding, t: Translator): string {
  return t(`selfUpdate.${st.key}`, st.values)
}

/**
 * board doctor's line (#617): none while the updates are off and nothing was ever done; else how they
 * stand, an error for a board that did not come back or an update that failed, a warning for a skip
 * that needs the owner.
 */
export function selfUpdateCheck(raw: unknown, s: UpdateState, now: number, t: Translator): SetupCheck | null {
  const cfg = autoUpdateConfig(raw)
  const st = standing(cfg, s, now)
  if (!st) return null
  const level = st.level === 'ok' && !cfg.on ? 'off' : st.level
  const when = cfg.every === 'hour' ? t('selfUpdate.every.hour') : `${t('selfUpdate.every.day')} ${cfg.at}`
  return {
    id: 'self-update',
    level,
    title: t('selfUpdate.doctor'),
    detail: `${standingText(st, t)}${cfg.on ? ` (${when})` : ` ${t('selfUpdate.doctor.off')}`}`,
    // a board that is down cannot take board update: the pane says why, a pull by hand brings the fix
    fix:
      st.level === 'ok'
        ? ''
        : t(
            st.key === 'notBack'
              ? 'selfUpdate.doctor.fixBack'
              : st.key === 'failed.installer'
                ? 'selfUpdate.doctor.fixInstaller'
                : 'selfUpdate.doctor.fix',
          ),
    code: '',
  }
}
