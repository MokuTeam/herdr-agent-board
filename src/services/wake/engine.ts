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
// names it on the wake line. The reaper, the session file and the old router's answers are about
// Claude panes and Claude session ids only: never pi's panes, nor a `pane-<id>` key. A pi session
// is put to sleep and woken only when asked (#178), kept in a file of its own (`wake-pi.json`, by
// its session file) and listed by /sleeping?agents=all only (services/wake/pi.ts).
//
// A Claude session put to sleep gives its pane back where it can (#204, core/wake/freed.ts): its
// entry then goes under its session id, with where it comes back; a wake opens a new tab there and
// moves the entry to that pane before it wakes it as in its own. Sessions asleep in a pane kept
// before that get it closed once, at wake's first look with closePanes on (`tidy`, its marker
// `wake-tidy.json` beside the session file), by the same rule. One put in the archive meanwhile is
// forgotten.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { archivedFiles, getArchived, isArchived } from '../../adapters/archive-store.ts'
import { readCard } from '../../adapters/cards.ts'
import type { LiveSession } from '../../adapters/claude-home.ts'
import type { HerdrSnapshot } from '../../adapters/herdr.ts'
import type { LiveHit, ProfileHomes } from '../../adapters/profile-homes.ts'
import {
  peekPiSleepers,
  peekWakeSessions,
  readPiSleepers,
  readWakeSessions,
  savePiSleepers,
  saveWakeSessions,
} from '../../adapters/wake-files.ts'
import type { WakeHerdr } from '../../adapters/wake-herdr.ts'
import { sameDir } from '../../core/launch/names.ts'
import { isPiSessionFile, parsePiTail, piProvider, piSessionCwd, piSessionId } from '../../core/pi.ts'
import { absoluteProfileDir, defaultProfileDir, type ProfileSet, profileForDir } from '../../core/profiles.ts'
import { SESSION_ID } from '../../core/resume.ts'
import type { ReaperConfig, WakeConfig } from '../../core/wake/config.ts'
import type { FreedPlace } from '../../core/wake/freed.ts'
import {
  findPiSleeper,
  type PiSleeper,
  type PiSleepers,
  type PiSleepingAnswer,
  piSleeperPane,
  piSleepingOf,
  piWakeLine,
  piWoken,
  sleepLabel,
} from '../../core/wake/pi.ts'
import { type ReapEntry, type Running, reapPlan } from '../../core/wake/reaper.ts'
import { CANNOT_WAKE, canWake, clearKeyFor, plainProfile, type WakeProfile } from '../../core/wake/rules.ts'
import {
  type AwakeAnswer,
  awakeOf,
  type Found,
  findSession,
  isFreed,
  markAwake,
  rememberSeen,
  type Seen,
  type SeenSnapshot,
  type SleepingAnswer,
  sleepingOf,
  type WakeEntry,
  type WakeSessions,
} from '../../core/wake/sessions.ts'
import type { TelegramStatus } from '../../core/wake/status.ts'
import { type Follow, followFiles } from './follow.ts'
import {
  atPrompt,
  freePane,
  lineFor,
  PROFILE_NOT_PLAIN,
  putToSleep,
  type SleepMarks,
  type Timing,
  type WakeOutcome,
  wakeInPane,
  withPane,
} from './pane-ops.ts'
import { defaultPiOps, type PiOps, putPiToSleep, wakePi } from './pi.ts'
import { openTab, type TabOps } from './tabs.ts'

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
  /**
   * Not the wake process (--reap-dry, --deliver): the session file peeked at, never set aside nor
   * written, so the wake process stays its one writer.
   */
  readOnly?: boolean
  /** pi's sleepers (#178); default: `wake-pi.json` beside the session file. */
  piFile?: string
  /** What putting pi to sleep and waking it need (services/wake/pi.ts); default: the real ones over `herdr`. */
  pi?: PiOps
  /** A pi session's card: the name given on the board and the folder its bridge last reported; default: the card store. */
  piCard?(session: string): { name?: string; account?: string }
  /** New tabs for sleepers whose pane wake closed (#204); default: `pi`'s. */
  tabs?: TabOps
  /** The card and the schedule following a session to its new pane (#204); default: the board's files. */
  follow?: Follow
  /** Of these session ids, those in the board's archive; default: the archive's records. */
  archived?(sessions: readonly string[]): Set<string>
  /** The marker of the sleepers in kept panes given them back once (#204); default: `wake-tidy.json` beside the session file. */
  tidyFile?: string
}

export type TargetAnswer = { ok: true; pane: string; name: string; already?: true } | { ok: false; error: string }

/** A sleeper as `GET /sleeping?agents=all` lists it: Claude's as /sleeping does, then pi's (#178). */
export type AnySleepingAnswer = SleepingAnswer | PiSleepingAnswer

export interface StatusAnswer {
  pid: number
  started: string
  lastPoll: string | null
  lastError: string | null
  reaper: ReaperConfig
  sleeping: SleepingAnswer[]
  sessions: WakeSessions
  /** The Telegram router's state: the one field more than the old router's /status. */
  telegram: TelegramStatus
}

/** What the Telegram router picks a pane from: herdr's snapshot just taken, and the Claude sessions last seen in each pane. */
export interface DeliveryLook {
  snap: HerdrSnapshot
  sessions: WakeSessions
}

/** The Telegram router's state (Task 6.1): written by the router, answered by /status. */
export interface TelegramNow {
  /** When tg-mcp last answered a poll (ISO), as the old router's /status says. */
  lastPoll: string | null
  /** Why the last poll failed, while it fails. */
  lastError: string | null
  status: TelegramStatus
}

export interface WakeEngine {
  /** Looks at herdr and the registries, and keeps who runs where in the session file. */
  remember(): Promise<void>
  sleeping(): Promise<SleepingAnswer[]>
  /** Claude's sleepers, then pi's (#178): what the board shows. */
  sleepingAll(): Promise<AnySleepingAnswer[]>
  /**
   * A pane at its shell where pi was stopped by hand taken as that pi session asleep there (#178):
   * kept, labelled and given the wake line, as if wake had put it to sleep.
   */
  adoptPi(pane: unknown, session: unknown): Promise<TargetAnswer>
  awake(): Promise<AwakeAnswer[]>
  status(): Promise<StatusAnswer>
  wake(target: unknown): Promise<TargetAnswer>
  sleep(target: unknown): Promise<TargetAnswer>
  /** Puts the idle sessions due to sleep, at most maxPerRound, while wake and its reaper are on. */
  reapRound(): Promise<void>
  /** The reaper's verdict for every Claude pane (--reap-dry). */
  plan(): Promise<ReapEntry[]>
  /** Wakes, sleeps and deliveries under way. */
  busy(): number
  /** For the Telegram router (Task 6.1): the pane's known session woken in it. */
  wakePane(pane: string): Promise<WakeOutcome>
  /** For the Telegram router (Task 6.1): a look at herdr that keeps who runs where, as remember does, and what it saw. */
  seen(): Promise<DeliveryLook>
  /**
   * A Telegram delivery (Task 6.1, and --deliver): `fn` counted under way (busy) until it ends, so a
   * code change or wake turned off waits for it, its acks included.
   */
  deliver<T>(fn: () => Promise<T>): Promise<T>
  /** Written by the Telegram router (Task 6.1). */
  telegram: TelegramNow
}

/** How long a woken session has to show in a registry before wake answers anyway. */
const REGISTER_WAIT_MS = 20_000
const REGISTER_POLL_MS = 1000
/** Why a session whose transcript lookup threw (a stat Windows refuses: EPERM) stays up. */
const TRANSCRIPT_UNREADABLE = 'its transcript cannot be read'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What one look at herdr and the registries saw. */
interface Look {
  snap: HerdrSnapshot & SeenSnapshot
  /** Running sessions by id, each with the home (profile folder) whose registry has it. */
  hits: Map<string, LiveHit>
  set: ProfileSet
}

/**
 * herdr's snapshot as wake reads it, with the time its request started. A Claude pane whose
 * session is not a Claude session id (a `pane-<id>` key) shows none: wake neither records nor
 * reaps it.
 */
function seenSnapshot(snap: HerdrSnapshot, takenAt: number): HerdrSnapshot & SeenSnapshot {
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

/** A session's transcript as found in its folder; `unreadable` when the lookup threw, with why. */
interface Transcript {
  path: string | null
  unreadable?: string
}

/** The session's transcript in the folder whose registry has it; a lookup that throws keeps the session up. */
function transcriptIn(hit: LiveHit, id: string): Transcript {
  try {
    return { path: hit.home.transcriptPath(id, cwdOf(hit.session)) }
  } catch (err) {
    return { path: null, unreadable: `${TRANSCRIPT_UNREADABLE}: ${messageOf(err)}` }
  }
}

/** The id of the listed profile that has the folder, if one has it. */
const listedId = (set: ProfileSet, dir: string | undefined): string | undefined =>
  dir ? profileForDir(set.list, dir)?.id : undefined

export function createWakeEngine(deps: WakeEngineDeps): WakeEngine {
  const now = (): number => deps.now?.() ?? Date.now()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const platform = deps.platform ?? process.platform
  const timing: Timing = { sleep, now, log: text => deps.log(text) }
  const started = new Date(now()).toISOString()
  const telegram: TelegramNow = { lastPoll: null, lastError: null, status: { state: 'off' } }
  /** Panes between /exit and the shell's prompt. */
  const going = new Set<string>()
  let underWay = 0

  // The one writer of the session file: read once here, saved after each change. readWakeSessions
  // tells its log only when it set the file, or the entries it left out, aside: saved at once then,
  // so the next start does not set the same entries aside again.
  let setAside = false
  let sessions: WakeSessions = deps.readOnly
    ? peekWakeSessions(deps.sessionsFile)
    : readWakeSessions(deps.sessionsFile, text => {
        setAside = true
        deps.log(text)
      })
  if (setAside) save()

  // pi's sleepers (#178): the same one writer, in a file of their own.
  const piFile = deps.piFile ?? join(dirname(deps.sessionsFile), 'wake-pi.json')
  const piOps = deps.pi ?? defaultPiOps(deps.herdr)
  let pis: PiSleepers = deps.readOnly ? peekPiSleepers(piFile) : readPiSleepers(piFile, text => deps.log(text))
  /** pi sessions between their record and their pane's shell: still running, not woken. */
  const piGoing = new Set<string>()
  const tabOps: TabOps = deps.tabs ?? piOps
  const follow: Follow = deps.follow ?? followFiles
  /** Sessions asleep in a pane kept before #204 are given it back once (tidy), then this file says so. */
  const tidyFile = deps.tidyFile ?? join(dirname(deps.sessionsFile), 'wake-tidy.json')
  let tidied = existsSync(tidyFile)

  const archived = (ids: readonly string[]): Set<string> => {
    if (deps.archived) return deps.archived(ids)
    const files = archivedFiles()
    return new Set(ids.filter(id => isArchived(files, id) && getArchived(id)?.state === 'archived'))
  }

  /** The card or the schedule not following is logged: the sleep or the wake goes on. */
  function followed(what: () => void): void {
    try {
      what()
    } catch (err) {
      deps.log(`could not update the card or the schedule: ${messageOf(err)}`)
    }
  }

  function savePis(): void {
    if (deps.readOnly) return
    try {
      savePiSleepers(pis, piFile)
    } catch (err) {
      deps.log(`could not save ${piFile}: ${messageOf(err)}`)
    }
  }

  const piCard = (session: string): { name?: string; account?: string } => {
    if (deps.piCard) return deps.piCard(session)
    try {
      const card = readCard(session)
      const account = absoluteProfileDir(card?.profileDir, homedir(), platform) ?? undefined
      return { ...(card?.name && { name: card.name }), ...(account && { account }) }
    } catch {
      return {}
    }
  }

  /** A failed save is logged: what wake holds stays, and the next change saves it again. Read only, nothing is saved. */
  function save(): void {
    if (deps.readOnly) return
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

  /** Whether the reaper may put a session to sleep now: it counts as off whenever wake is. */
  const reaping = (): boolean => {
    const s = deps.settings()
    return s.enabled && s.reaper.enabled
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

  async function snapshotNow(): Promise<HerdrSnapshot & SeenSnapshot> {
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
    forgetArchived()
    await rememberPi(seen.snap)
    return seen
  }

  /** Sleepers whose pane wake closed and whose session went to the archive since: forgotten (#204). */
  function forgetArchived(): void {
    const freed = Object.entries(sessions).filter(([, s]) => isFreed(s))
    if (!freed.length) return
    const gone = archived(freed.map(([, s]) => s.session))
    if (!gone.size) return
    sessions = Object.fromEntries(Object.entries(sessions).filter(([, s]) => !(isFreed(s) && gone.has(s.session))))
    save()
    for (const id of gone) deps.log(`${id} is in the archive: no longer asleep`)
  }

  /**
   * The pane's sleeper about to be given its pane back (#204): its entry under its session id, with
   * where it comes back, saved before the close; `unfreed` puts it back under its pane when the pane
   * stays after all.
   */
  function freed(pane: string, place: FreedPlace): void {
    const entry = sessions[pane]
    if (!entry) return
    const { [pane]: _gone, ...rest } = sessions
    sessions = { ...rest, [entry.session]: { ...entry, freed: place } }
    save()
    followed(() => follow.paneClosed(entry.session, pane))
  }

  function unfreed(pane: string, session: string): void {
    const entry = sessions[session]
    if (!isFreed(entry)) return
    const { [session]: _gone, ...rest } = sessions
    const { freed: _place, ...kept } = entry
    sessions = { ...rest, [pane]: kept }
    save()
  }

  /** Marks that move the pane's sleeper under its session id before the close, and back if the pane stays. */
  const freeMarks = (pane: string, session: string) => ({
    freeing: (place: FreedPlace) => freed(pane, place),
    kept: () => unfreed(pane, session),
  })

  /**
   * What freeing a pane goes by besides the snapshot: a workspace another sleeper whose pane was
   * closed comes back to is not closed with its last tab (core/wake/freed.ts).
   */
  const held = (ws: { workspace_id: string; label?: string }): boolean =>
    Object.values(sessions).some(
      e => isFreed(e) && (e.freed.workspace === ws.workspace_id || (!!ws.label && e.freed.workspaceLabel === ws.label)),
    )

  /**
   * Sessions asleep in a pane wake left them in before #204 (put to sleep, not exited by the user):
   * that pane closed, as a sleep closes it now, while it is as wake left it (labelled `💤 <name>`, at
   * its shell's prompt, nothing typed there but its wake line) and core/wake/freed.ts allows it.
   * Once, at the first look with closePanes on: then its marker is written, and no wake start or
   * switch does it again. Counted under way (busy) while it runs, so a code change waits for it.
   */
  async function tidy(snap: HerdrSnapshot): Promise<void> {
    if (tidied || deps.readOnly || !deps.settings().closePanes) return
    tidied = true
    await during(async () => {
      for (const [pane, s] of Object.entries(sessions)) {
        if (!s.slept_at || s.exited || isFreed(s) || !SESSION_ID.test(s.session)) continue
        const p = snap.panes.find(x => x.pane_id === pane)
        const label = `💤 ${s.name}`
        if (!p || p.agent || p.label !== label) continue
        const rules = { label, held, now: now(), log: deps.log }
        const place = await withPane(pane, () =>
          freePane(deps.herdr, { pane, session: s.session }, freeMarks(pane, s.session), rules),
        ).catch(err => {
          deps.log(`${s.name}: the pane ${pane} it slept in could not be closed: ${messageOf(err)}`)
          return null
        })
        if (place) deps.log(`${s.name}: closed the pane ${pane} it slept in`)
      }
    })
    try {
      writeFileSync(tidyFile, `${JSON.stringify({ at: now() })}\n`)
    } catch (err) {
      deps.log(`could not save ${tidyFile}: ${messageOf(err)}`)
    }
  }

  /**
   * pi's sleepers after a look (#178): one whose session runs in a pane again is awake (its own
   * pane's 💤 label cleared), one whose session file is gone is forgotten. Nothing is asked of
   * herdr while there are none.
   */
  async function rememberPi(snap: HerdrSnapshot): Promise<void> {
    if (!Object.keys(pis).length) return
    const woken = piWoken(snap, pis).filter(file => !piGoing.has(file))
    for (const file of woken) {
      const s = pis[file]
      if (s) await forgetPi(s, snap, 'is awake again')
    }
    for (const s of Object.values(pis))
      if (!piGoing.has(s.session) && !piOps.exists(s.session)) await forgetPi(s, snap, 'has no session file any more')
  }

  /** The sleeper forgotten, saved, and its own pane's 💤 label cleared while it still has it. */
  async function forgetPi(s: PiSleeper, snap: HerdrSnapshot | null, why: string): Promise<void> {
    if (!pis[s.session]) return
    const { [s.session]: _gone, ...rest } = pis
    pis = rest
    savePis()
    deps.log(`${s.name || s.session} (pi) ${why}: no longer asleep in ${s.pane}`)
    const pane = snap?.panes.find(p => p.pane_id === s.pane)
    if (!snap || pane?.label === sleepLabel(s)) await deps.herdr.rename(s.pane, null).catch(() => {})
  }

  /**
   * A pane herdr shows running pi on a session file, by its pane id, that file or the file's id; a
   * pi pane whose session herdr does not name by its file (a `pane-<id>` key) is none.
   */
  function piPane(target: unknown, snap: HerdrSnapshot): HerdrSnapshot['panes'][number] | undefined {
    const t = String(target ?? '').trim()
    if (!t) return undefined
    return snap.panes.find(p => {
      const file = p.agent === 'pi' ? p.agent_session?.value : undefined
      return isPiSessionFile(file) && (p.pane_id === t || file === t || piSessionId(file) === t)
    })
  }

  /**
   * The name a pi session is put to sleep under: its card's, else its own (/name, --name: at the end
   * of its file, else anywhere in it), else pi's title in its pane. A pane taken over is a shell,
   * whose title is the shell's: `π - <folder>` then, as pi's own title reads without a name.
   */
  function piName(file: string, pane: HerdrSnapshot['panes'][number], lines: string[] | null, shell = false): string {
    const own = piCard(file).name || (lines ? parsePiTail(lines).name : '') || piOps.sessionName(file)
    if (own) return own
    if (shell) return `π - ${(pane.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''}`.trim()
    return pane.terminal_title_stripped || pane.label || pane.pane_id
  }

  const workspaceLabel = (snap: HerdrSnapshot, id: string | undefined): string | undefined =>
    id === undefined ? undefined : (snap.workspaces.find(w => w.workspace_id === id)?.label ?? undefined)

  /** putPiToSleep for the pi pane, its sleeper kept from `going` on (#178). */
  async function sleepPi(pane: HerdrSnapshot['panes'][number], snap: HerdrSnapshot): Promise<TargetAnswer> {
    const file = pane.agent_session?.value ?? ''
    const name = piName(file, pane, piOps.tail(file))
    const label = workspaceLabel(snap, pane.workspace_id)
    const account = piCard(file).account
    const marks = {
      going(s: PiSleeper) {
        piGoing.add(file)
        pis = { ...pis, [file]: s }
        savePis()
      },
      stayed() {
        const { [file]: _gone, ...rest } = pis
        pis = rest
        savePis()
      },
    }
    try {
      const r = await putPiToSleep(
        piOps,
        {
          pane: pane.pane_id,
          session: file,
          name,
          ...(label && { workspaceLabel: label }),
          ...(account && { account }),
        },
        marks,
        { ...timing, boardOnPath: deps.boardOnPath() },
      )
      return r.ok ? { ok: true, pane: pane.pane_id, name } : { ok: false, error: r.error }
    } finally {
      piGoing.delete(file)
    }
  }

  /** wakePi for the sleeper, forgotten once it is up (#178). */
  async function wakePiNow(s: PiSleeper, snap: HerdrSnapshot): Promise<TargetAnswer> {
    const timeoutMs = deps.settings().wakeTimeoutSec * 1000
    const outcome = await wakePi(piOps, s, snap, { ...timing, timeoutMs })
    if (!outcome.ok) return { ok: false, error: outcome.error }
    // Its old pane, when it woke elsewhere, keeps its label only while it is still a shell there.
    await forgetPi(s, outcome.pane === s.pane ? null : await snapshotNow().catch(() => null), 'woke')
    deps.log(`woke ${s.name} (pi) in ${outcome.pane} on request`)
    return { ok: true, pane: outcome.pane, name: s.name }
  }

  /** Wake's entries whose session is a Claude session id (never a `pane-<id>` key). */
  const claudeSessions = (): WakeSessions =>
    Object.fromEntries(Object.entries(sessions).filter(([, s]) => SESSION_ID.test(s.session)))

  /**
   * A session of wake's in a pane herdr still has, by name, pane or session id: a Claude session id
   * (never a `pane-<id>` key), in a pane at a shell or running Claude (never another agent's).
   */
  function find(target: unknown, snap: SeenSnapshot): Found | undefined {
    const panes = snap.panes.filter(p => !p.agent || p.agent === 'claude')
    return findSession(target, { ...snap, panes }, claudeSessions())
  }

  const isDefault = (dir: string): boolean => sameDir(dir, defaultProfileDir(homedir(), platform))

  /**
   * The id `board resume --profile` gets for a session in `dir`: the listed profile's. None for a
   * folder no listed profile has, and none for the default folder when its id is not a plain word:
   * without --profile, `board resume` takes the folder from the session's card, else the pane's
   * shell's profile, which can be any (#151). In another folder such an id is kept, and refused by
   * pane-ops (and by the "can wake" rule before it): without --profile it would not wake in its own.
   */
  function lineProfile(set: ProfileSet, dir: string | undefined): string | null {
    const id = listedId(set, dir)
    if (!id || !dir) return null
    return plainProfile(id) || !isDefault(dir) ? id : null
  }

  /** Why the session could not be woken again once asleep (call 9), or null. */
  function cannotWake(hit: LiveHit, set: ProfileSet, onPath: boolean, transcript: Transcript): string | null {
    const dir = absoluteProfileDir(hit.home.root, homedir(), platform)
    const why = canWake({ boardOnPath: onPath, profileDir: dir, transcript: transcript.path })
    if (why) return why === 'transcript' && transcript.unreadable ? transcript.unreadable : CANNOT_WAKE[why]
    const id = lineProfile(set, hit.home.root)
    return id !== null && !plainProfile(id) ? PROFILE_NOT_PLAIN : null
  }

  /** The reaper's plan: the scheduled jobs of each idle session read first, from its own folder. */
  async function planOf({ snap, hits, set }: Look): Promise<ReapEntry[]> {
    const { reaper } = deps.settings()
    const live = new Map<string, Running>()
    for (const [id, hit] of hits) if (SESSION_ID.test(id)) live.set(id, asRunning(hit.session))
    const transcripts = new Map<string, Transcript>()
    const transcriptOf = (id: string): Transcript => {
      let found = transcripts.get(id)
      if (!found) {
        const hit = hits.get(id)
        found = hit ? transcriptIn(hit, id) : { path: null }
        transcripts.set(id, found)
      }
      return found
    }
    const scheduled = new Set<string>()
    for (const p of snap.panes) {
      const id = p.agent === 'claude' ? p.agent_session?.value : undefined
      if (!id || live.get(id)?.status !== 'idle' || scheduled.has(id)) continue
      if (await deps.scheduled(transcriptOf(id).path).catch(() => true)) scheduled.add(id)
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
      ...freeMarks(pane, s.session),
      stayed: () => {
        const entry = sessions[pane]
        if (!entry) return
        const { slept_at: _slept, ...awake } = entry
        put(pane, awake)
      },
    }
    try {
      const profile = lineProfile(set, s.dir)
      return await putToSleep(deps.herdr, { pane, session: s.session, name: s.name, profile }, marks, {
        ...timing,
        free: deps.settings().closePanes && { held },
      })
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

  /**
   * Wakes the entry's session in its pane (pane-ops wakeInPane), in its folder's profile. An entry
   * without a folder is the old plugin's, which read only the default folder: woken in that one's
   * profile, so it comes back there even without a card, whatever the pane's shell's profile.
   */
  async function wakeIn(pane: string, entry: WakeEntry, set: ProfileSet, fresh = false): Promise<WakeOutcome> {
    const dir = entry.profileDir ?? defaultProfileDir(homedir(), platform)
    const target = { pane, session: entry.session, profile: lineProfile(set, dir) }
    const timeoutMs = deps.settings().wakeTimeoutSec * 1000
    const outcome = await wakeInPane(deps.herdr, target, { ...timing, timeoutMs, platform, fresh })
    if (outcome.ok) await awaken(pane)
    return outcome
  }

  /**
   * The sleeper under `key` (its session id) whose pane wake closed (#204): a new tab where it was
   * (services/wake/tabs.ts), its entry moved to that pane as a sleeper there, then woken there as in
   * its own (wakeIn), its shell maybe still starting. Woken or not, that pane is its own from then
   * on: one that did not come up waits there, `💤 <name>`, for the next wake. Where it woke is in
   * the answer. One wake at a time per sleeper (withPane on its key): a second that waited on the
   * first finds it in its new pane, up (done) or still asleep there (woken there).
   */
  function wakeFreed(key: string, set: ProfileSet): Promise<WakeOutcome> {
    return withPane(key, async () => {
      if (isFreed(sessions[key])) return openAndWake(key, set)
      const moved = Object.entries(sessions).find(([, e]) => e.session === key)
      if (!moved) return { ok: false, why: 'line', error: `no session asleep under ${key}` }
      const [pane, entry] = moved
      if (!entry.slept_at) return { ok: true, pane }
      const outcome = await wakeIn(pane, entry, set)
      return outcome.ok ? { ok: true, pane } : outcome
    })
  }

  async function openAndWake(key: string, set: ProfileSet): Promise<WakeOutcome> {
    const entry = sessions[key]
    if (!isFreed(entry)) return { ok: false, why: 'line', error: `no session asleep under ${key}` }
    const dir = entry.profileDir ?? defaultProfileDir(homedir(), platform)
    const found = lineFor(entry.session, lineProfile(set, dir))
    if ('error' in found) return { ok: false, why: 'line', error: found.error }
    const name = entry.name || entry.title || ''
    const { freed: was, ...asleep } = entry
    const pane = await openTab(
      tabOps,
      {
        ...(was.workspace !== undefined && { workspace: was.workspace }),
        ...(was.workspaceLabel !== undefined && { workspaceLabel: was.workspaceLabel }),
        cwd: entry.cwd ?? '',
        label: name || 'claude',
        ...(was.tabLabel !== undefined && { tabLabel: was.tabLabel }),
      },
      await snapshotNow(),
    )
    const { [key]: _gone, ...rest } = sessions
    sessions = { ...rest, [pane]: asleep }
    save()
    deps.log(`${name} wakes in a new tab, ${pane}: its pane ${was.pane} was closed when it went to sleep`)
    followed(() => follow.paneOpened(entry.session, pane))
    const outcome = await wakeIn(pane, asleep, set, true)
    if (!outcome.ok) await deps.herdr.rename(pane, `💤 ${name}`).catch(() => {})
    return outcome.ok ? { ok: true, pane } : outcome
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
      await tidy((await look()).snap)
    },

    sleeping,

    async sleepingAll() {
      const snap = await snapshotNow()
      const claude = sleepingOf(snap, sessions).filter(s => SESSION_ID.test(s.session))
      return [...claude, ...piSleepingOf(snap, pis)]
    },

    adoptPi: (target, session) =>
      during(async (): Promise<TargetAnswer> => {
        const seen = await look()
        const paneId = String(target ?? '').trim()
        const file = String(session ?? '').trim()
        const pane = seen.snap.panes.find(p => p.pane_id === paneId)
        if (!pane) return { ok: false, error: `herdr has no pane ${paneId}` }
        if (!isPiSessionFile(file) || !piOps.exists(file)) return { ok: false, error: `no pi session file ${file}` }
        const running = piPane(file, seen.snap)
        if (running) return { ok: false, error: `${file} runs in ${running.pane_id}: it is not asleep` }
        const known = pis[file]
        if (known) return { ok: true, pane: known.pane, name: known.name, already: true }
        if (pane.agent) return { ok: false, error: `${paneId} runs ${pane.agent}, not a shell` }
        const line = piWakeLine(file)
        if (!line) return { ok: false, error: `${file}'s name has no id to wake it by` }
        if (!deps.boardOnPath()) return { ok: false, error: `it cannot be woken: ${CANNOT_WAKE.board}` }
        const lines = piOps.tail(file)
        const card = piCard(file)
        const name = piName(file, pane, lines, true)
        const label = workspaceLabel(seen.snap, pane.workspace_id)
        const provider = lines ? piProvider(lines) : ''
        let started = ''
        try {
          started = piSessionCwd(readFileSync(file, 'utf8').split('\n', 1)[0] ?? '')
        } catch {}
        const sleeper: PiSleeper = {
          session: file,
          name,
          pane: paneId,
          ...(pane.workspace_id !== undefined && { workspace: pane.workspace_id }),
          ...(label && { workspaceLabel: label }),
          cwd: pane.cwd || started,
          argv: [],
          ...(card.account && { account: card.account }),
          ...(provider && { provider }),
          slept_at: now(),
          adopted: true,
        }
        pis = { ...pis, [file]: sleeper }
        savePis()
        await deps.herdr.rename(paneId, sleepLabel(sleeper)).catch(() => {})
        const prompt = await atPrompt(deps.herdr, paneId).catch(() => null)
        if (prompt) {
          await deps.herdr.sendKeys(paneId, clearKeyFor(prompt.shell, platform)).catch(() => {})
          await deps.herdr.sendText(paneId, line).catch(() => {})
        }
        deps.log(`took ${name} (pi) as asleep in ${paneId}${card.account ? `, account ${card.account}` : ''}`)
        return { ok: true, pane: paneId, name }
      }),

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
        telegram: telegram.status,
      }
    },

    wake: target =>
      during(async (): Promise<TargetAnswer> => {
        const seen = await look()
        const s = find(target, seen.snap)
        if (!s) {
          const p = findPiSleeper(target, pis)
          if (p) return wakePiNow(p, seen.snap)
          // Its session runs already (woken by hand, or the list the caller read was older).
          const up = piPane(target, seen.snap)
          if (up) return { ok: true, pane: up.pane_id, name: up.terminal_title_stripped ?? '', already: true }
          return { ok: false, error: `no session named ${String(target)} in herdr` }
        }
        if (s.live) return { ok: true, pane: s.pane, name: s.name, already: true }
        // Its pane closed when it went to sleep (#204): it wakes in a new tab.
        const outcome = isFreed(s) ? await wakeFreed(s.pane, seen.set) : await wakeIn(s.pane, s, seen.set)
        if (!outcome.ok) return { ok: false, error: outcome.error }
        const pane = outcome.pane ?? s.pane
        // Reachable for SendMessage once it has registered itself again, in whichever profile.
        for (const deadline = now() + REGISTER_WAIT_MS; now() < deadline; await sleep(REGISTER_POLL_MS))
          if (liveIn(deps.profiles()).has(s.session)) break
        deps.log(`woke ${s.name} in ${pane} on request`)
        return { ok: true, pane, name: s.name }
      }),

    sleep: target =>
      during(async (): Promise<TargetAnswer> => {
        const seen = await look()
        const s = find(target, seen.snap)
        if (!s) {
          const pi = piPane(target, seen.snap)
          if (pi) return sleepPi(pi, seen.snap)
        }
        if (!s?.live) return { ok: false, error: `no running session named ${String(target)}` }
        // Idle in its own profile's registry (#150).
        const hit = seen.hits.get(s.session)
        if (hit?.session.status !== 'idle') return { ok: false, error: `${s.name} is not idle` }
        const cwd = typeof hit.session.cwd === 'string' ? hit.session.cwd : undefined
        const why = cannotWake(hit, seen.set, deps.boardOnPath(), transcriptIn(hit, s.session))
        if (why) return { ok: false, error: `${s.name} cannot be put to sleep: ${why}` }
        const slept = await putDown(s.pane, { session: s.session, name: s.name, cwd, dir: hit.home.root }, seen.set)
        return slept
          ? { ok: true, pane: s.pane, name: s.name }
          : { ok: false, error: `${s.name} did not go to sleep (busy, or text in its input box)` }
      }),

    async reapRound() {
      if (!reaping()) return
      const seen = await look()
      const due = (await planOf(seen)).filter(p => p.sleep).slice(0, deps.settings().reaper.maxPerRound)
      // Wake or its reaper turned off meanwhile: the sleep under way finishes, no other starts.
      for (const p of due) {
        if (!reaping()) break
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
        // A sleeper whose pane wake closed (#204), under its session id: it wakes in a new tab.
        if (isFreed(entry)) return wakeFreed(pane, deps.profiles())
        if (!entry || !SESSION_ID.test(entry.session)) {
          // A pi sleeper whose own pane it is (#178): the Telegram router types its message there.
          const snap = await snapshotNow()
          const p = Object.values(pis).find(s => piSleeperPane(snap, s)?.pane_id === pane)
          if (!p) return { ok: false, why: 'line', error: `no Claude session is known in ${pane}` }
          const r = await wakePiNow(p, snap)
          return r.ok ? { ok: true } : { ok: false, why: 'line', error: r.error }
        }
        return wakeIn(pane, entry, deps.profiles())
      }),

    async seen() {
      const { snap } = await look()
      // pi's sleepers in their own panes too (#178): the router wakes one like a Claude session.
      const asleep: WakeSessions = {}
      for (const s of Object.values(pis)) {
        const own = piSleeperPane(snap, s)
        if (own) asleep[own.pane_id] = { session: s.session, name: s.name, title: s.name, seen_at: s.slept_at }
      }
      return { snap, sessions: { ...asleep, ...claudeSessions() } }
    },

    deliver: fn => during(fn),
  }
}
