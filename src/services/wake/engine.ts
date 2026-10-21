// The wake engine: what the wake process does, for every Claude profile (#150, #151). It looks at
// herdr and at the registries of every profile folder the board reads, keeps the last Claude
// session seen in each pane (the one writer of wake's session file), answers the old router's
// questions (/status, /sleeping, /awake), puts idle sessions to sleep on request or by the reaper,
// and wakes them through `board resume <id> --profile <id>`, in their own profile. A port of
// herdr-wake's router.mjs (remember, sleeping, awake, wakeTarget, sleepTarget, reapRound, plan),
// with the registry and the transcripts read in the session's own folder, and the "can wake" rule
// (call 9): a session is put to sleep only when the wake line could bring it back.
//
// A session's profile is its folder, the one whose registry has it; the listed profile's id only
// names it on the wake line. Wake acts on Claude panes and Claude session ids only: never on pi's
// panes, nor on a `pane-<id>` key.
import { homedir } from 'node:os'
import type { LiveSession } from '../../adapters/claude-home.ts'
import type { HerdrSnapshot } from '../../adapters/herdr.ts'
import type { LiveHit, ProfileHomes } from '../../adapters/profile-homes.ts'
import { readWakeSessions, saveWakeSessions } from '../../adapters/wake-files.ts'
import type { WakeHerdr } from '../../adapters/wake-herdr.ts'
import { sameDir } from '../../core/launch/names.ts'
import { absoluteProfileDir, defaultProfileDir, type ProfileSet, profileForDir } from '../../core/profiles.ts'
import { SESSION_ID } from '../../core/resume.ts'
import type { ReaperConfig, WakeConfig } from '../../core/wake/config.ts'
import { type ReapEntry, type Running, reapPlan } from '../../core/wake/reaper.ts'
import { CANNOT_WAKE, canWake, plainProfile, type WakeProfile } from '../../core/wake/rules.ts'
import {
  type AwakeAnswer,
  awakeOf,
  type Found,
  findSession,
  markAwake,
  rememberSeen,
  type Seen,
  type SeenSnapshot,
  type SleepingAnswer,
  sleepingOf,
  type WakeEntry,
  type WakeSessions,
} from '../../core/wake/sessions.ts'
import { putToSleep, type SleepMarks, type Timing, type WakeOutcome, wakeInPane } from './pane-ops.ts'

export interface WakeEngineDeps {
  herdr: WakeHerdr
  /** services/deps.ts defaultDeps(cfg).homes */
  homes: ProfileHomes
  /** defaultDeps(cfg).profiles */
  profiles(): ProfileSet
  /** Live: read again at each use. */
  settings(): WakeConfig
  sessionsFile: string
  /** adapters/resume-report.ts boardOnPath */
  boardOnPath(): boolean
  /** adapters/wake-transcripts.ts scheduledJobs */
  scheduled(path: string | null): Promise<boolean>
  log(text: string): void
  now?(): number
  platform?: string
  sleep?(ms: number): Promise<void>
}

export type TargetAnswer = { ok: true; pane: string; name: string; already?: true } | { ok: false; error: string }

export interface StatusAnswer {
  pid: number
  started: string
  lastPoll: string | null
  lastError: string | null
  reaper: ReaperConfig
  sleeping: SleepingAnswer[]
  sessions: WakeSessions
}

export interface WakeEngine {
  /** Looks at herdr and the registries, and keeps who runs where in the session file. */
  remember(): Promise<void>
  sleeping(): Promise<SleepingAnswer[]>
  awake(): Promise<AwakeAnswer[]>
  status(): Promise<StatusAnswer>
  wake(target: unknown): Promise<TargetAnswer>
  sleep(target: unknown): Promise<TargetAnswer>
  /** Puts the idle sessions due to sleep, at most maxPerRound, while the reaper is on. */
  reapRound(): Promise<void>
  /** The reaper's verdict for every Claude pane (--reap-dry). */
  plan(): Promise<ReapEntry[]>
  /** Wakes, sleeps and deliveries under way. */
  busy(): number
  /** For the Telegram router (Task 6.1): the pane's known session woken in it. */
  wakePane(pane: string): Promise<WakeOutcome>
  /** Written by the Telegram router (Task 6.1). */
  telegram: { lastPoll: string | null; lastError: string | null }
}

/** How long a woken session has to show in a registry before wake answers anyway. */
const REGISTER_WAIT_MS = 20_000
const REGISTER_POLL_MS = 1000
/** Why a session in a folder other than the default one cannot wake: the line would drop --profile. */
const NOT_PLAIN = 'its profile id is not a plain word'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What one look at herdr and the registries saw. */
interface Look {
  snap: SeenSnapshot
  /** Running sessions by id, each with the home (profile folder) whose registry has it. */
  hits: Map<string, LiveHit>
  set: ProfileSet
}

/**
 * herdr's snapshot as wake reads it, with the time its request started. A Claude pane whose
 * session is not a Claude session id (a `pane-<id>` key) shows none: wake neither records nor
 * reaps it.
 */
function seenSnapshot(snap: HerdrSnapshot, takenAt: number): SeenSnapshot {
  const panes = snap.panes.map(p => {
    const id = p.agent_session?.value
    return p.agent === 'claude' && id && !SESSION_ID.test(id) ? { ...p, agent_session: null } : p
  })
  return { ...snap, panes, takenAt }
}

/** A registry entry as the reaper reads it: name, status and cwd only when strings, the idle time only when a number. */
function asRunning(s: LiveSession): Running {
  const { name, status, cwd, statusUpdatedAt, ...rest } = s
  return {
    ...rest,
    ...(typeof name === 'string' && { name }),
    ...(typeof status === 'string' && { status }),
    ...(typeof cwd === 'string' && { cwd }),
    ...(typeof statusUpdatedAt === 'number' && { statusUpdatedAt }),
  }
}

const cwdOf = (s: LiveSession): string => (typeof s.cwd === 'string' ? s.cwd : '')

/** The id of the listed profile that has the folder, if one has it. */
const listedId = (set: ProfileSet, dir: string | undefined): string | undefined =>
  dir ? profileForDir(set.list, dir)?.id : undefined

export function createWakeEngine(deps: WakeEngineDeps): WakeEngine {
  const now = (): number => deps.now?.() ?? Date.now()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const platform = deps.platform ?? process.platform
  const timing: Timing = { sleep, now, log: text => deps.log(text) }
  const started = new Date(now()).toISOString()
  const telegram: WakeEngine['telegram'] = { lastPoll: null, lastError: null }
  /** Panes between /exit and the shell's prompt. */
  const going = new Set<string>()
  let underWay = 0

  // The one writer of the session file: read once here, saved after each change. readWakeSessions
  // tells its log only when it set the file, or the entries it left out, aside: saved at once then,
  // so the next start does not set the same entries aside again.
  let setAside = false
  let sessions: WakeSessions = readWakeSessions(deps.sessionsFile, text => {
    setAside = true
    deps.log(text)
  })
  if (setAside) save()

  /** A failed save is logged: what wake holds stays, and the next change saves it again. */
  function save(): void {
    try {
      saveWakeSessions(sessions, deps.sessionsFile)
    } catch (err) {
      deps.log(`could not save ${deps.sessionsFile}: ${messageOf(err)}`)
    }
  }

  function put(pane: string, entry: WakeEntry): void {
    sessions = { ...sessions, [pane]: entry }
    save()
  }

  async function during<T>(fn: () => Promise<T>): Promise<T> {
    underWay++
    try {
      return await fn()
    } finally {
      underWay--
    }
  }

  /** Running sessions in every folder the board reads: its own and every listed profile's. */
  const liveIn = (set: ProfileSet): Map<string, LiveHit> =>
    deps.homes.liveSessions([set.inheritedDir, ...set.list.map(p => p.dir)])

  async function snapshotNow(): Promise<SeenSnapshot> {
    const takenAt = now()
    return seenSnapshot(await deps.herdr.snapshot(), takenAt)
  }

  async function view(): Promise<Look> {
    const snap = await snapshotNow()
    const set = deps.profiles()
    return { snap, hits: liveIn(set), set }
  }

  /** A look that also keeps who runs where (router.mjs remember): saved, panes renamed, exits logged. */
  async function look(): Promise<Look> {
    const seen = await view()
    const live = new Map<string, Seen>()
    for (const [id, { session, home }] of seen.hits) {
      const profile = listedId(seen.set, home.root)
      live.set(id, {
        ...(typeof session.name === 'string' && { name: session.name }),
        profileDir: home.root,
        ...(profile !== undefined && { profile }),
      })
    }
    const r = rememberSeen(seen.snap, sessions, live, now(), going)
    if (r.changed) {
      sessions = r.sessions
      save()
    }
    for (const pane of r.exited) {
      const s = sessions[pane]
      deps.log(`${s?.name || s?.title || ''} in ${pane} was exited, wakeable from now on`)
    }
    for (const { pane, label } of r.renames) await deps.herdr.rename(pane, label).catch(() => {})
    return seen
  }

  /**
   * A session of wake's in a pane herdr still has, by name, pane or session id: a Claude session id
   * (never a `pane-<id>` key), in a pane at a shell or running Claude (never another agent's).
   */
  function find(target: unknown, snap: SeenSnapshot): Found | undefined {
    const panes = snap.panes.filter(p => !p.agent || p.agent === 'claude')
    const claude = Object.fromEntries(Object.entries(sessions).filter(([, s]) => SESSION_ID.test(s.session)))
    return findSession(target, { ...snap, panes }, claude)
  }

  const isDefault = (dir: string): boolean => sameDir(dir, defaultProfileDir(homedir(), platform))

  /**
   * The id `board resume --profile` gets for a session in `dir`: the listed profile's. None for a
   * folder no listed profile has, and none for the default folder when its id is not a plain word:
   * without --profile, `board resume` takes the folder from the session's card, else the shell's
   * profile, the default one. In another folder such an id is kept, and refused by pane-ops (and by
   * the "can wake" rule before it): without --profile it would wake in the default profile.
   */
  function lineProfile(set: ProfileSet, dir: string | undefined): string | null {
    const id = listedId(set, dir)
    if (!id || !dir) return null
    return plainProfile(id) || !isDefault(dir) ? id : null
  }

  /** Why the session could not be woken again once asleep (call 9), or null. */
  function cannotWake(hit: LiveHit, set: ProfileSet, onPath: boolean, transcript: string | null): string | null {
    const dir = absoluteProfileDir(hit.home.root, homedir(), platform)
    const why = canWake({ boardOnPath: onPath, profileDir: dir, transcript })
    if (why) return CANNOT_WAKE[why]
    const id = lineProfile(set, hit.home.root)
    return id !== null && !plainProfile(id) ? NOT_PLAIN : null
  }

  /** The reaper's plan: the scheduled jobs of each idle session read first, from its own folder. */
  async function planOf({ snap, hits, set }: Look): Promise<ReapEntry[]> {
    const { reaper } = deps.settings()
    const live = new Map<string, Running>()
    for (const [id, hit] of hits) if (SESSION_ID.test(id)) live.set(id, asRunning(hit.session))
    const transcripts = new Map<string, string | null>()
    const transcriptOf = (id: string): string | null => {
      if (!transcripts.has(id)) {
        const hit = hits.get(id)
        transcripts.set(id, hit ? hit.home.transcriptPath(id, cwdOf(hit.session)) : null)
      }
      return transcripts.get(id) ?? null
    }
    const scheduled = new Set<string>()
    for (const p of snap.panes) {
      const id = p.agent === 'claude' ? p.agent_session?.value : undefined
      if (!id || live.get(id)?.status !== 'idle' || scheduled.has(id)) continue
      if (await deps.scheduled(transcriptOf(id)).catch(() => true)) scheduled.add(id)
    }
    const onPath = deps.boardOnPath()
    return reapPlan(snap, live, {
      idleMinutes: reaper.idleMinutes,
      exclude: reaper.exclude,
      now: now(),
      scheduled: s => scheduled.has(s.sessionId),
      cannotWake: s => {
        const hit = hits.get(s.sessionId)
        const why = hit ? cannotWake(hit, set, onPath, transcriptOf(s.sessionId)) : CANNOT_WAKE.profile
        return why === null ? null : `cannot wake: ${why}`
      },
    })
  }

  /**
   * /exit the session in its pane and leave the wake line typed at the prompt (pane-ops putToSleep),
   * the entry marked asleep with the folder whose registry has it and that folder's listed id.
   */
  async function putDown(
    pane: string,
    s: { session: string; name: string; cwd: string | undefined; dir: string },
    set: ProfileSet,
  ): Promise<boolean> {
    const listed = listedId(set, s.dir)
    const marks: SleepMarks = {
      going: at => {
        going.add(pane)
        const before: Partial<WakeEntry> = sessions[pane] ?? {}
        const { slept_at: _slept, exited: _exited, profileDir: _dir, profile: _profile, ...rest } = before
        put(pane, {
          ...rest,
          session: s.session,
          name: s.name,
          ...(s.cwd !== undefined && { cwd: s.cwd }),
          seen_at: at,
          slept_at: at,
          profileDir: s.dir,
          ...(listed !== undefined && { profile: listed }),
        })
      },
      // Views taken before this still show Claude in the pane.
      slept: at => {
        const entry = sessions[pane]
        if (entry) put(pane, { ...entry, slept_at: at })
      },
      stayed: () => {
        const entry = sessions[pane]
        if (!entry) return
        const { slept_at: _slept, ...awake } = entry
        put(pane, awake)
      },
    }
    try {
      const profile = lineProfile(set, s.dir)
      return await putToSleep(deps.herdr, { pane, session: s.session, name: s.name, profile }, marks, timing)
    } finally {
      going.delete(pane)
    }
  }

  /** The entry marked awake again, saved, and its pane's 💤 label cleared. */
  async function awaken(pane: string): Promise<void> {
    const next = markAwake(sessions, pane)
    if (!next) return
    sessions = next
    save()
    await deps.herdr.rename(pane, null).catch(() => {})
  }

  /** Wakes the entry's session in its pane (pane-ops wakeInPane), in its folder's profile. */
  async function wakeIn(pane: string, entry: WakeEntry, set: ProfileSet): Promise<WakeOutcome> {
    const target = { pane, session: entry.session, profile: lineProfile(set, entry.profileDir) }
    const timeoutMs = deps.settings().wakeTimeoutSec * 1000
    const outcome = await wakeInPane(deps.herdr, target, { ...timing, timeoutMs, platform })
    if (outcome.ok) await awaken(pane)
    return outcome
  }

  async function sleeping(): Promise<SleepingAnswer[]> {
    return sleepingOf(await snapshotNow(), sessions).filter(s => SESSION_ID.test(s.session))
  }

  /** Running Claude sessions by pane: the folder whose registry has each, and its listed id. */
  function profilesByPane({ snap, hits, set }: Look): Map<string, WakeProfile> {
    const byPane = new Map<string, WakeProfile>()
    for (const p of snap.panes) {
      const id = p.agent === 'claude' ? p.agent_session?.value : undefined
      const hit = id ? hits.get(id) : undefined
      if (!hit) continue
      const listed = listedId(set, hit.home.root)
      byPane.set(p.pane_id, { dir: hit.home.root, ...(listed !== undefined && { id: listed }) })
    }
    return byPane
  }

  return {
    telegram,

    async remember() {
      await look()
    },

    sleeping,

    async awake() {
      const seen = await view()
      return awakeOf(await planOf(seen), deps.settings().reaper, profilesByPane(seen))
    },

    async status() {
      const list = await sleeping()
      return {
        pid: process.pid,
        started,
        lastPoll: telegram.lastPoll,
        lastError: telegram.lastError,
        reaper: deps.settings().reaper,
        sleeping: list,
        sessions,
      }
    },

    wake: target =>
      during(async (): Promise<TargetAnswer> => {
        const seen = await look()
        const s = find(target, seen.snap)
        if (!s) return { ok: false, error: `no session named ${String(target)} in herdr` }
        if (s.live) return { ok: true, pane: s.pane, name: s.name, already: true }
        const outcome = await wakeIn(s.pane, s, seen.set)
        if (!outcome.ok) return { ok: false, error: outcome.error }
        // Reachable for SendMessage once it has registered itself again, in whichever profile.
        for (const deadline = now() + REGISTER_WAIT_MS; now() < deadline; await sleep(REGISTER_POLL_MS))
          if (liveIn(deps.profiles()).has(s.session)) break
        deps.log(`woke ${s.name} in ${s.pane} on request`)
        return { ok: true, pane: s.pane, name: s.name }
      }),

    sleep: target =>
      during(async (): Promise<TargetAnswer> => {
        const seen = await look()
        const s = find(target, seen.snap)
        if (!s?.live) return { ok: false, error: `no running session named ${String(target)}` }
        // Idle in its own profile's registry (#150).
        const hit = seen.hits.get(s.session)
        if (hit?.session.status !== 'idle') return { ok: false, error: `${s.name} is not idle` }
        const cwd = typeof hit.session.cwd === 'string' ? hit.session.cwd : undefined
        const transcript = hit.home.transcriptPath(s.session, cwd ?? '')
        const why = cannotWake(hit, seen.set, deps.boardOnPath(), transcript)
        if (why) return { ok: false, error: `${s.name} cannot be put to sleep: ${why}` }
        const slept = await putDown(s.pane, { session: s.session, name: s.name, cwd, dir: hit.home.root }, seen.set)
        return slept
          ? { ok: true, pane: s.pane, name: s.name }
          : { ok: false, error: `${s.name} did not go to sleep (busy, or text in its input box)` }
      }),

    async reapRound() {
      if (!deps.settings().reaper.enabled) return
      const seen = await look()
      const due = (await planOf(seen)).filter(p => p.sleep).slice(0, deps.settings().reaper.maxPerRound)
      for (const p of due) {
        if (!deps.settings().reaper.enabled) break
        const hit = p.session ? seen.hits.get(p.session) : undefined
        if (!p.session || !hit) continue
        const s = { session: p.session, name: p.name, cwd: p.cwd, dir: hit.home.root }
        await during(() => putDown(p.pane, s, seen.set)).catch(err =>
          deps.log(`sleeping ${p.name} failed: ${messageOf(err)}`),
        )
      }
    },

    async plan() {
      return planOf(await view())
    },

    busy: () => underWay,

    wakePane: pane =>
      during(async (): Promise<WakeOutcome> => {
        const entry = sessions[pane]
        if (!entry || !SESSION_ID.test(entry.session))
          return { ok: false, why: 'line', error: `no Claude session is known in ${pane}` }
        return wakeIn(pane, entry, deps.profiles())
      }),
  }
}
