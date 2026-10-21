// Which idle Claude sessions wake puts to sleep, and which panes count as asleep after the user
// exited Claude by hand. Pure: the wake process reads herdr, the registries and the transcripts.
// Ported from herdr-wake's reaper.mjs (and claude.mjs hasSchedules, on the transcript's text).

/** A pane as `herdr api snapshot` describes it (only what the reaper reads). */
export interface ReapPane {
  pane_id: string
  workspace_id?: string
  agent?: string | null
  agent_status?: string
  agent_session?: { value?: string | null } | null
  terminal_title_stripped?: string
  focused?: boolean
  cwd?: string
}

export interface ReapSnapshot {
  workspaces: { workspace_id: string; label?: string }[]
  panes: ReapPane[]
}

/** A running session as Claude's registry records it (sessions/<pid>.json; more fields may exist). */
export interface Running {
  sessionId: string
  name?: string
  status?: string
  statusUpdatedAt?: number
  cwd?: string
  [extra: string]: unknown
}

/**
 * One Claude pane in the reaper's plan: `sleep: true` to put it to sleep, otherwise `reason` says
 * why it stays up. Registered sessions also carry `status`, `since` (when Claude last changed it)
 * and `idleMin`; `waiting: true` marks the ones that only need more idle time.
 */
export interface ReapEntry {
  pane: string
  name: string
  workspace: string
  sleep: boolean
  reason: string
  status?: string
  since?: number
  idleMin?: number
  waiting?: true
  session?: string
  cwd?: string
}

const WEEK_MS = 7 * 86_400_000
const EXITED_WINDOW_MS = 10 * 60_000

/** A pattern as a case-insensitive regex when written "/…/", null when it is a name; never throws. */
function patternRegex(pattern: string): RegExp | false | null {
  const re = /^\/(.+)\/$/.exec(pattern)
  if (!re?.[1]) return null
  try {
    return new RegExp(re[1], 'i')
  } catch {
    return false // not a regex: matches nothing
  }
}

/** Exact (case-insensitive) names, or "/regex/" patterns. A "/regex/" that does not compile never matches. */
export function matchesAny(patterns: readonly string[], values: readonly (string | null | undefined)[]): boolean {
  return patterns.some(pat => {
    const re = patternRegex(pat)
    if (re === false) return false
    return values.some(v => !!v && (re ? re.test(v) : v.toLowerCase() === pat.toLowerCase()))
  })
}

/**
 * Panes whose Claude session the user exited (/exit, Ctrl+C): wake saw the session there within
 * `windowMs`, the pane has no agent any more and Claude's registry no longer lists the session
 * as running. From then on they count as asleep, so SendMessage and Telegram wake them like the
 * reaper's. The window keeps panes whose Claude ended long ago, now plain shells, out of it.
 * `known` is wake's session file, `live` the running sessions by id.
 */
export function exitedPanes(
  snap: { panes: readonly ReapPane[] },
  known: Readonly<Record<string, { session?: string; seen_at?: number; slept_at?: number }>>,
  live: ReadonlyMap<string, unknown>,
  now: number = Date.now(),
  windowMs: number = EXITED_WINDOW_MS,
): string[] {
  return snap.panes
    .filter(p => {
      const k = known[p.pane_id]
      return (
        !!k?.session &&
        !k.slept_at &&
        !p.agent &&
        !live.has(k.session) &&
        typeof k.seen_at === 'number' &&
        now - k.seen_at < windowMs
      )
    })
    .map(p => p.pane_id)
}

/**
 * One entry per Claude pane: `sleep: true` for those to put to sleep, otherwise the reason it
 * stays up. `live` maps session id -> Claude's registry entry. A session sleeps only when Claude
 * itself reports it idle (not busy, not running a background shell) for `idleMinutes`, herdr
 * agrees, the pane is not focused, it is not excluded, it has no scheduled jobs that would die
 * with it, and `cannotWake` gives no reason the board could not wake it again (such a session
 * stays up with that reason and never counts down). A session whose idle time Claude did not
 * record stays up too.
 */
export function reapPlan(
  snap: ReapSnapshot,
  live: ReadonlyMap<string, Running>,
  o: {
    idleMinutes: number
    exclude?: readonly string[]
    now?: number
    scheduled?: (s: Running) => boolean
    cannotWake?: (s: Running, pane: ReapPane) => string | null
  },
): ReapEntry[] {
  const { idleMinutes, exclude = [], now = Date.now(), scheduled = () => false, cannotWake = () => null } = o
  const wsLabel = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const plan: ReapEntry[] = []
  for (const p of snap.panes) {
    if (p.agent !== 'claude') continue
    const id = p.agent_session?.value
    const s = id ? live.get(id) : undefined
    const name = s?.name || p.terminal_title_stripped || p.pane_id
    const workspace = (p.workspace_id === undefined ? undefined : wsLabel.get(p.workspace_id)) ?? ''
    if (!id || !s) {
      plan.push({ pane: p.pane_id, name, workspace, sleep: false, reason: 'not in the session registry' })
      continue
    }
    const since = typeof s.statusUpdatedAt === 'number' ? s.statusUpdatedAt : undefined
    const idleMin = since === undefined ? undefined : Math.round((now - since) / 60_000)
    const base = {
      pane: p.pane_id,
      name,
      workspace,
      ...(s.status === undefined ? {} : { status: s.status }),
      ...(since === undefined ? {} : { since }),
      ...(idleMin === undefined ? {} : { idleMin }),
    }
    // The checks in herdr-wake's order; each runs only when the ones before it passed.
    const up = ((): { reason: string; waiting?: true } | null => {
      if (matchesAny(exclude, [s.name, workspace, p.terminal_title_stripped])) return { reason: 'excluded' }
      if (s.status !== 'idle') return { reason: `status ${s.status ?? 'unknown'}` }
      if (p.agent_status !== 'idle' && p.agent_status !== 'done')
        return { reason: `herdr says ${p.agent_status ?? 'unknown'}` }
      if (scheduled(s)) return { reason: 'has scheduled jobs' }
      const why = cannotWake(s, p)
      if (why) return { reason: why }
      if (idleMin === undefined) return { reason: 'idle time unknown' }
      if (idleMin < idleMinutes) return { reason: `idle ${idleMin} min`, waiting: true }
      if (p.focused) return { reason: 'focused' }
      return null
    })()
    if (up) plan.push({ ...base, sleep: false, ...up })
    else
      plan.push({
        ...base,
        sleep: true,
        session: id,
        ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
        reason: `idle ${idleMin} min`,
      })
  }
  return plan
}

const SCHEDULE_CALL = /"type":"tool_use","id":"[^"]+","name":"(CronCreate|ScheduleWakeup)"/

/**
 * The time (ms) of the newest CronCreate or ScheduleWakeup call in a transcript's text, from its
 * line's `timestamp`; null when it has none. A line whose time does not parse is left out.
 */
export function lastScheduledAt(text: string): number | null {
  let last: number | null = null
  for (const line of text.split('\n')) {
    if (!SCHEDULE_CALL.test(line)) continue
    try {
      const row: unknown = JSON.parse(line)
      const ts = typeof row === 'object' && row !== null && 'timestamp' in row ? row.timestamp : undefined
      const at = typeof ts === 'string' ? Date.parse(ts) : Number.NaN
      if (!Number.isNaN(at) && (last === null || at > last)) last = at
    } catch {}
  }
  return last
}

/**
 * Jobs scheduled at `at` may still be alive at `now`. Such jobs live only in the session's memory
 * and die with it, so the session must stay up. Recurring cron jobs expire after 7 days, hence the
 * window.
 */
export const scheduleLive = (at: number | null, now: number): boolean => at !== null && now - at < WEEK_MS

/**
 * A transcript's text calls CronCreate or ScheduleWakeup within 7 days of `now` (herdr-wake's
 * hasSchedules on the text).
 */
export function scheduledIn(text: string, now: number): boolean {
  return scheduleLive(lastScheduledAt(text), now)
}
