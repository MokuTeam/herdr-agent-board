// Wake's session file (`wake-sessions.json`): the last Claude session seen in each herdr pane, so
// one that has exited can be resumed there, with the profile folder whose registry had it. And
// what wake answers from it: the sleeping list, the awake list, a session found by name, pane or
// id. A port of herdr-wake's router.mjs remember, markAwake, sleeping, awake and findSession.
// Pure: the wake engine reads herdr and the registries, saves the file and renames the panes.
//
// A sleeper whose pane wake closed (#204, core/wake/freed.ts) is kept under its session id rather
// than that pane's: herdr gives a pane's id out again after it starts over, and the session runs in
// no pane until it wakes, in a new tab. It is asleep, listed and found without a pane.
import type { ReaperConfig } from './config.ts'
import { asFreedPlace, type FreedPlace } from './freed.ts'
import { exitedPanes, type ReapEntry, type ReapSnapshot } from './reaper.ts'
import type { WakeProfile } from './rules.ts'

/**
 * The last Claude session seen in a pane. `slept_at` marks it asleep: put to sleep, or `exited` by
 * the user. `profileDir` is the folder whose registry had it, `profile` that folder's listed id.
 * `freed`: put to sleep and its pane closed, where it comes back (#204). `terminal`: of a sleeper
 * kept in its pane, the terminal herdr showed there when wake last judged it (#243); herdr gives a
 * pane it restores after it starts over a new one.
 */
export interface WakeEntry {
  session: string
  name: string
  cwd?: string
  title?: string
  seen_at: number
  slept_at?: number
  exited?: boolean
  profileDir?: string
  profile?: string
  freed?: FreedPlace
  terminal?: string
  [extra: string]: unknown
}

/** Pane id → its last Claude session; a sleeper whose pane wake closed, by its session id (#204). */
export type WakeSessions = Record<string, WakeEntry>

/** A sleeper whose pane wake closed (#204): asleep, with where it comes back. */
export const isFreed = (e: WakeEntry | undefined): e is WakeEntry & { freed: FreedPlace; slept_at: number } =>
  !!e?.freed && e.slept_at !== undefined

/** Panes herdr has not shown for this long are forgotten. */
export const KEEP_GONE_MS = 7 * 86_400_000
/** A session seen again in its pane within this time, under the same name and profile, is not written again. */
const SEEN_AGAIN_MS = 60_000

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
/** A time a Date can hold (not NaN, not Infinity). */
const time = (v: unknown): v is number => typeof v === 'number' && Math.abs(v) <= 8.64e15
const iso = (t: number | undefined): string => (time(t) ? new Date(t).toISOString() : '')
const isString = (v: unknown): boolean => typeof v === 'string'
const filled = (v: unknown): boolean => typeof v === 'string' && v !== ''

// The entry's optional fields other than its profile; one of another type is left out.
const OPTIONAL: ReadonlyMap<string, (v: unknown) => boolean> = new Map([
  ['cwd', isString],
  ['title', isString],
  ['slept_at', time],
  ['exited', (v: unknown) => typeof v === 'boolean'],
  ['terminal', filled],
])

/**
 * The profile a wake resumes the entry in is whole: a folder, with its id or without, or neither
 * (the default profile). Only a missing profile means the default one, so a folder or id that is
 * there but broken, or an id without its folder, drops the entry rather than wake it elsewhere.
 */
const profileWhole = ({ profileDir: dir, profile: id }: Record<string, unknown>): boolean =>
  dir === undefined ? id === undefined : filled(dir) && (id === undefined || filled(id))

function asEntry(value: unknown): WakeEntry | null {
  const e = record(value)
  if (!e || typeof e.session !== 'string' || !time(e.seen_at) || !profileWhole(e)) return null
  const fields = Object.entries(e).filter(([key, v]) => key !== 'freed' && (OPTIONAL.get(key)?.(v) ?? true))
  const freed = e.freed === undefined ? null : asFreedPlace(e.freed)
  return {
    ...Object.fromEntries(fields),
    session: e.session,
    name: typeof e.name === 'string' ? e.name : '',
    seen_at: e.seen_at,
    ...(freed && { freed }),
  }
}

/** null for what is not an object; entries without a string `session` and a number `seen_at`, or with a broken profile, dropped; a `freed` that does not read as one left out; unknown fields kept. */
export function asWakeSessions(value: unknown): WakeSessions | null {
  const all = record(value)
  if (!all) return null
  const kept: [string, WakeEntry][] = []
  for (const [pane, v] of Object.entries(all)) {
    const entry = asEntry(v)
    if (entry) kept.push([pane, entry])
  }
  return Object.fromEntries(kept)
}

/** A `herdr api snapshot` with the time its request started, so a view older than a sleep is not mistaken for a wake. */
export interface SeenSnapshot extends ReapSnapshot {
  takenAt?: number
}

/** A running session as the registries show it: its name and the profile folder whose registry has it. */
export interface Seen {
  name?: string
  profileDir: string
  profile?: string
}

/** The sessions after a look, whether they changed (to save), the pane renames for herdr (null: clear), the panes exited by hand. */
export interface Remembered {
  sessions: WakeSessions
  changed: boolean
  renames: { pane: string; label: string | null }[]
  exited: string[]
}

/** The entry awake again: no `slept_at`, no `exited`, no `terminal` judged asleep; null when it was not asleep. */
function awakeEntry(e: WakeEntry | undefined): WakeEntry | null {
  if (!e?.slept_at) return null
  const { slept_at: _slept, exited: _exited, terminal: _terminal, ...rest } = e
  return rest
}

/**
 * router.mjs markAwake, pure: the sessions with the pane's entry awake again; null when it was not
 * asleep, so there is nothing to save and no rename to clear.
 */
export function markAwake(sessions: WakeSessions, pane: string): WakeSessions | null {
  const entry = awakeEntry(sessions[pane])
  return entry ? { ...sessions, [pane]: entry } : null
}

/**
 * router.mjs remember(), pure: who runs where, who was exited by hand (renamed `💤 <name>`), who
 * is awake again (rename cleared), what is gone for 7 days. `live` maps a session id to where the
 * registries show it running; `going`: panes between /exit and the shell prompt. `prev` is not
 * changed.
 */
export function rememberSeen(
  snap: SeenSnapshot,
  prev: WakeSessions,
  live: ReadonlyMap<string, Seen>,
  now: number,
  going: ReadonlySet<string> = new Set(),
): Remembered {
  const sessions: WakeSessions = { ...prev }
  const renames: Remembered['renames'] = []
  const exited: string[] = []
  let changed = false
  const wake = (pane: string) => {
    const entry = awakeEntry(sessions[pane])
    if (!entry) return
    sessions[pane] = entry
    renames.push({ pane, label: null })
    changed = true
  }

  for (const p of snap.panes) {
    const id = p.agent === 'claude' ? p.agent_session?.value : undefined
    if (!id) continue
    const pane = p.pane_id
    // Claude back in a sleeping pane: woken by hand or by herdr. Only a view taken after the
    // sleep counts; an older one still shows the session that was just put to sleep.
    const before = sessions[pane]
    if (before?.slept_at && !going.has(pane) && (snap.takenAt ?? 0) > before.slept_at) wake(pane)
    const cur = sessions[pane]
    const seen = live.get(id)
    const same = cur?.session === id ? cur : undefined
    const name = seen?.name || same?.name || ''
    // Out of the registries for a moment, the same session keeps the folder it had. An id only
    // with its folder.
    const where = seen ?? same
    const profileDir = where?.profileDir || undefined
    const profile = (profileDir && where?.profile) || undefined
    // Seen again within the minute as written: nothing to write. A profile the registries show only
    // now (late at the first look) is written, or the exit would sleep it in the default profile.
    const unchanged = same && same.name === name && same.profileDir === profileDir && same.profile === profile
    if (unchanged && now - same.seen_at < SEEN_AGAIN_MS) continue
    sessions[pane] = {
      session: id,
      name,
      ...(p.cwd === undefined ? {} : { cwd: p.cwd }),
      title: p.terminal_title_stripped || cur?.title || '',
      seen_at: now,
      ...(going.has(pane) && cur?.slept_at ? { slept_at: cur.slept_at } : {}),
      ...(profileDir ? { profileDir } : {}),
      ...(profile ? { profile } : {}),
    }
    changed = true
  }

  // Exited by the user: asleep from the last time it was seen running, without the wake line
  // typed in (the user is likely at that prompt).
  for (const pane of exitedPanes(snap, sessions, live, now)) {
    const s = sessions[pane]
    if (!s || going.has(pane)) continue
    sessions[pane] = { ...s, slept_at: s.seen_at, exited: true }
    renames.push({ pane, label: `💤 ${s.name || s.title || ''}` })
    exited.push(pane)
    changed = true
  }

  // A running session is awake wherever it runs, e.g. resumed by hand in another pane. One whose
  // pane wake closed (#204) is forgotten then: its new pane has an entry of its own. Only once herdr
  // shows it in a pane in a view taken after its pane was closed, or a registry still has it a
  // minute after (an older view, or a registry slow to drop it, still has it before it went).
  const inPanes = new Set(snap.panes.flatMap(p => (p.agent === 'claude' && p.agent_session?.value) || []))
  for (const [pane, s] of Object.entries(sessions)) {
    if (isFreed(s)) {
      const after = (snap.takenAt ?? 0) > s.freed.at
      if ((inPanes.has(s.session) && after) || (live.has(s.session) && now - s.freed.at > SEEN_AGAIN_MS)) {
        delete sessions[pane]
        changed = true
      }
    } else if (s.slept_at && live.has(s.session) && !going.has(pane)) wake(pane)
  }

  // Gone for 7 days: forgotten, but for a sleeper whose pane wake closed, which has none.
  const panes = new Set(snap.panes.map(p => p.pane_id))
  for (const [pane, s] of Object.entries(sessions)) {
    if (!panes.has(pane) && !isFreed(s) && now - s.seen_at > KEEP_GONE_MS) {
      delete sessions[pane]
      changed = true
    }
  }
  return { sessions, changed, renames, exited }
}

/** The profile wake's answers carry for an entry: its folder, and its id when listed; none for an entry without a folder. */
function profileOf(e: WakeEntry): WakeProfile | undefined {
  return e.profileDir ? { dir: e.profileDir, ...(e.profile ? { id: e.profile } : {}) } : undefined
}

/**
 * A sleeping session as `GET /sleeping` lists it: the old router's fields, then its profile. One
 * whose pane wake closed (#204) has `pane` '' (it wakes in a new tab) and its folder in `cwd`.
 */
export interface SleepingAnswer {
  name: string
  pane: string
  session: string
  workspace: string
  slept_at: string
  exited: boolean
  profile?: WakeProfile
  cwd?: string
}

/**
 * Sessions put to sleep by the reaper or exited by the user whose pane is still there at a shell
 * prompt, and those put to sleep whose pane wake closed (#204), their workspace's label as herdr
 * has it now, else as it was.
 */
export function sleepingOf(snap: SeenSnapshot, sessions: WakeSessions): SleepingAnswer[] {
  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const list: SleepingAnswer[] = []
  for (const [pane, s] of Object.entries(sessions)) {
    if (isFreed(s)) {
      const profile = profileOf(s)
      list.push({
        name: s.name || s.title || '',
        pane: '',
        session: s.session,
        workspace:
          (s.freed.workspace === undefined ? undefined : labels.get(s.freed.workspace)) ?? s.freed.workspaceLabel ?? '',
        slept_at: iso(s.slept_at),
        exited: false,
        ...(profile ? { profile } : {}),
        cwd: s.cwd ?? '',
      })
      continue
    }
    const p = panes.get(pane)
    if (!s.slept_at || !p || p.agent) continue
    const profile = profileOf(s)
    list.push({
      name: s.name || s.title || '',
      pane,
      session: s.session,
      workspace: (p.workspace_id === undefined ? undefined : labels.get(p.workspace_id)) ?? '',
      slept_at: iso(s.slept_at),
      exited: !!s.exited,
      ...(profile ? { profile } : {}),
    })
  }
  return list
}

/**
 * A running session as `GET /awake` lists it: since when it is idle or busy (`''` when Claude did
 * not record it), the minutes until the reaper puts it to sleep (null when it will not, `kept` says
 * why), then its profile.
 */
export interface AwakeAnswer {
  name: string
  pane: string
  workspace: string
  status: string
  since: string
  sleeps_in_min: number | null
  kept: string | null
  profile?: WakeProfile
}

/** Running Claude sessions in herdr, from the reaper's plan; `profiles` by pane id. */
export function awakeOf(
  plan: readonly ReapEntry[],
  reaper: Pick<ReaperConfig, 'enabled' | 'idleMinutes'>,
  profiles: ReadonlyMap<string, WakeProfile>,
): AwakeAnswer[] {
  const on = reaper.enabled
  return plan
    .filter(p => p.status)
    .map(p => {
      const profile = profiles.get(p.pane)
      const waiting = p.waiting && p.idleMin !== undefined ? reaper.idleMinutes - p.idleMin : null
      return {
        name: p.name,
        pane: p.pane,
        workspace: p.workspace,
        status: p.status ?? '',
        since: iso(p.since),
        sleeps_in_min: !on ? null : p.sleep ? 0 : waiting,
        kept: !on ? 'reaper off' : p.sleep || p.waiting ? null : p.reason,
        ...(profile ? { profile } : {}),
      }
    })
}

/**
 * A session found in the file: its entry, its pane, and whether Claude runs there now. For a
 * sleeper whose pane wake closed (#204), `pane` is its entry's key, its session id.
 */
export interface Found extends WakeEntry {
  pane: string
  live: boolean
}

/**
 * By name (a trailing " [hex]" dropped), pane id or session id, any case, among panes herdr still
 * has; else a sleeper whose pane wake closed (#204), by name or session id (its old pane's id may
 * be another pane's after herdr starts over).
 */
export function findSession(target: unknown, snap: SeenSnapshot, sessions: WakeSessions): Found | undefined {
  const t = String(target ?? '')
    .replace(/\s*\[[0-9a-f]+\]\s*$/i, '')
    .trim()
    .toLowerCase()
  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  for (const [pane, s] of Object.entries(sessions)) {
    const p = panes.get(pane)
    if (p && !isFreed(s) && [s.name, pane, s.session].some(v => v && v.toLowerCase() === t))
      return { ...s, pane, live: p.agent === 'claude' }
  }
  for (const [key, s] of Object.entries(sessions)) {
    if (isFreed(s) && [s.name, s.session].some(v => v && v.toLowerCase() === t)) return { ...s, pane: key, live: false }
  }
  return undefined
}
