// What the board can do to a session, shared by the terminal board and the web board. Each
// returns { ok: true } or { ok: false, error } with a message for the user.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { agentGet, type HerdrAgent, herdr, herdrText, paneTerminals, snapshot } from '../adapters/herdr.ts'
import { possibleProfilePanes, provenProfilePanes } from '../adapters/profile-panes.ts'
import { boardOnPath } from '../adapters/resume-report.ts'
import { peekPiSleepers, peekWakeSessions } from '../adapters/wake-files.ts'
import { cliWakeHerdr } from '../adapters/wake-herdr.ts'
import { inputDraft } from '../core/dialogs/input-box.ts'
import { piDraft } from '../core/dialogs/pi-dialogs.ts'
import { itemProfile } from '../core/item-profile.ts'
import { t } from '../core/lang.ts'
import { sameDir } from '../core/launch/names.ts'
import { isPiItem, piTurnOver } from '../core/pi.ts'
import {
  absoluteProfileDir,
  defaultProfileDir,
  mayWake,
  type ProfileSet,
  profileForDir,
  profileLabel,
} from '../core/profiles.ts'
import type { AgentStatus, Config, Item } from '../core/types.ts'
import { wakeConfig } from '../core/wake/config.ts'
import type { FreedPlace } from '../core/wake/freed.ts'
import { wakeOffByKey } from '../core/wake/mode.ts'
import { canWake, plainProfile } from '../core/wake/rules.ts'
import { herdrWakeAnswers, type SleepProvider } from '../integrations/herdr-wake.ts'
import { raiseTerminal } from '../integrations/terminal-window.ts'
import type { BoardWake } from '../integrations/wake.ts'
import type { Deps } from './deps.ts'
import { followFiles } from './wake/follow.ts'
import { PROFILE_NOT_PLAIN, type WakeOutcome, wakeInPane } from './wake/pane-ops.ts'
import { defaultPiOps, readPiTail, wakePi } from './wake/pi.ts'
import { defaultTabOps, openTab } from './wake/tabs.ts'

/**
 * `busy` (plus `dialog` or `draft`) says send refused because the session is occupied, not broken.
 * A wake refused because wake is slow to answer (it may be waking that very session: nothing was
 * typed) says `wakeBusy`; the board's own wake that failed on a herdr call says `herdrDown`. A
 * reminder waits for either without counting the wait (services/scheduler.ts).
 */
export type ActionResult =
  | { ok: true; pane?: string }
  | {
      ok: false
      error: string
      busy?: boolean
      dialog?: boolean
      draft?: boolean
      wakeBusy?: boolean
      herdrDown?: boolean
    }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The new wake (integrations/wake.ts), which says whether it answers; herdr-wake's provider does not. */
const isBoardWake = (w: SleepProvider): w is BoardWake => 'reach' in w

/**
 * The new wake while the board talks to it (call 4: on, and its start ran), else null: the old
 * path. With wake off nothing is looked at, so the old path asks nothing new.
 */
function newWake(deps: Pick<Deps, 'cfg' | 'wake'>): BoardWake | null {
  if (!wakeConfig(deps.cfg.wake).enabled) return null
  const w = deps.wake
  return isBoardWake(w) ? w : null
}

/** Whether the wake the board talks to puts pi sessions to sleep (#178): the board's own; the separate plugin does not. */
export const wakeSleepsPi = (deps: Pick<Deps, 'cfg' | 'wake'>): boolean => newWake(deps) !== null

/**
 * A sleeping pi session can be woken (#178): `board` on PATH, which the wake line runs, and its
 * session file still there.
 */
function canWakePi(item: Pick<Item, 'name'> & Partial<Pick<Item, 'session'>>): WakeGuard {
  if (!boardOnPath()) return { ok: false, refused: true, error: t('err.canWake.board', { name: item.name }) }
  if (!item.session || !existsSync(item.session))
    return { ok: false, refused: true, error: t('err.piFileGone', { name: item.name }) }
  return { ok: true }
}

/**
 * The board wakes a sleeping pi session itself, as wake does (services/wake/pi.ts), while wake
 * does not answer: from wake's pi file (read only), in its own pane or a new tab. Where it woke is
 * in the answer; wake's next round, once it answers, forgets the sleeper.
 */
async function wakePiHere(deps: Deps, item: Item): Promise<ActionResult> {
  const sleeper = item.session ? peekPiSleepers()[item.session] : undefined
  if (!sleeper) return { ok: false, error: t('err.wake', { name: item.name, why: t('err.sleep.unknownToWake') }) }
  const timeoutMs = wakeConfig(deps.cfg.wake).wakeTimeoutSec * 1000
  try {
    const outcome = await wakePi(defaultPiOps(cliWakeHerdr), sleeper, await snapshot(), {
      timeoutMs,
      log: text => deps.log(`wake: ${text}`),
    })
    if (!outcome.ok) return { ok: false, error: t('err.wake', { name: item.name, why: outcome.error }) }
    deps.log(`wake: woke ${item.name} (pi) in ${outcome.pane} from the board`)
    return { ok: true, pane: outcome.pane }
  } catch (err) {
    return { ok: false, herdrDown: true, error: t('err.wake', { name: item.name, why: messageOf(err) }) }
  }
}

/** A sleeper from wake's session file while wake is off: the board wakes it itself (call 28, H1). */
const offFileSleeper = (cfg: Config, item: Partial<Pick<Item, 'fromFile'>>): boolean =>
  item.fromFile === true && !wakeConfig(cfg.wake).enabled

/**
 * The folder and the `--profile` id the board's own wake, and its guard, take for a session: its
 * profile as the board knows it (core/item-profile.ts), else as wake's session file has it for its
 * pane (read only: the wake process is the file's one writer); an entry without a folder is the
 * default folder's, as the old plugin read only that one (services/wake/engine.ts). As the wake
 * process does, a default folder's id that is not a plain word stays off the line: `board resume`
 * then takes the folder from the session's card.
 */
function wakeTarget(
  item: Pick<Item, 'pane' | 'profile' | 'profileFolder'> & Partial<Pick<Item, 'session'>>,
  set: ProfileSet,
): { dir: string | null; profile: string | null } {
  const line = (dir: string, id: string | null) => ({
    dir,
    profile: id && !plainProfile(id) && sameDir(dir, defaultProfileDir(homedir())) ? null : id,
  })
  const own = itemProfile(item, set.list)
  if (own) return line(own.dir, own.id)
  if (item.profileFolder) return line(item.profileFolder, profileForDir(set.list, item.profileFolder)?.id ?? null)
  // One whose pane wake closed is under its session id (#204).
  const key = item.pane || item.session
  const entry = key ? peekWakeSessions()[key] : undefined
  if (!entry || entry.session !== item.session) return { dir: null, profile: null }
  const dir = entry.profileDir ?? defaultProfileDir(homedir())
  return line(dir, entry.profile ?? profileForDir(set.list, dir)?.id ?? null)
}

/**
 * Call 19 with the board's own or the new wake, which set the session's profile themselves: the
 * "can wake" rule (safeguard 10): `board` on PATH, the session's profile folder known, its
 * transcript in that folder; and a profile id the wake line can carry.
 */
function canWakeAgain(
  deps: Deps,
  item: Pick<Item, 'name' | 'pane' | 'profile' | 'profileFolder'> & Partial<Pick<Item, 'session' | 'cwd'>>,
  set: ProfileSet,
): WakeGuard {
  const { dir, profile } = wakeTarget(item, set)
  const folder = absoluteProfileDir(dir, homedir())
  let found: string | null = null
  try {
    if (folder && item.session) found = deps.homes.forDir(folder).transcriptPath(item.session, item.cwd ?? '')
  } catch {} // a folder Windows refuses to read (EPERM) has no transcript the wake could use
  const why = canWake({ boardOnPath: boardOnPath(), profileDir: folder, transcript: found })
  if (why) return { ok: false, refused: true, error: t(`err.canWake.${why}`, { name: item.name }) }
  if (profile !== null && !plainProfile(profile))
    return { ok: false, refused: true, error: t('err.wake', { name: item.name, why: PROFILE_NOT_PLAIN }) }
  return { ok: true }
}

/**
 * Call 28: the board wakes the session itself, as wake does (services/wake/pane-ops.ts): the
 * prompt line cleared by the pane's shell, `board resume <id> --profile <id>` run in it, the
 * development-channels warning confirmed, until Claude is ready; then its 💤 label cleared. The
 * board does not write wake's session file: `collect` leaves the sleeper out once its pane runs
 * Claude again, and wake's next round marks it awake. A second wake of it, waiting on the first
 * (withPane), finds it up: done, as the old router answers `already`. One whose pane wake closed
 * (#204) wakes in a new tab where it was (services/wake/tabs.ts), as wake would wake it; wake's
 * next round, once it answers, forgets it as asleep.
 */
async function wakeHere(deps: Deps, item: Item): Promise<ActionResult> {
  const freed = !item.pane && item.session ? peekWakeSessions()[item.session]?.freed : undefined
  if (!item.pane && !freed) return { ok: false, error: t('err.noPane') }
  if (!freed) return wakeHereIn(deps, item, null)
  // One new tab per session: a second wake while the first is on its way waits for it.
  const session = item.session ?? ''
  const under = opening.get(session)
  if (under) return under
  const run = wakeHereIn(deps, item, freed).finally(() => opening.delete(session))
  opening.set(session, run)
  return run
}

/** Sleepers whose pane wake closed that the board is waking in a new tab now, by session id. */
const opening = new Map<string, Promise<ActionResult>>()

/** wakeHere in the item's pane, or for one whose pane wake closed (`freed`) in a new tab. */
async function wakeHereIn(deps: Deps, item: Item, freed: FreedPlace | null): Promise<ActionResult> {
  const { profile } = wakeTarget(item, deps.profiles())
  const timeoutMs = wakeConfig(deps.cfg.wake).wakeTimeoutSec * 1000
  let outcome: WakeOutcome
  let pane = item.pane ?? ''
  try {
    if (freed) {
      const snap = await snapshot()
      // Up already (woken by hand, or by wake meanwhile): there.
      const up = snap.panes.find(p => p.agent === 'claude' && p.agent_session?.value === item.session)
      if (up) return { ok: true, pane: up.pane_id }
      pane = await openTab(
        defaultTabOps(path => existsSync(path)),
        {
          ...(freed.workspace !== undefined && { workspace: freed.workspace }),
          ...(freed.workspaceLabel !== undefined && { workspaceLabel: freed.workspaceLabel }),
          cwd: item.cwd,
          label: item.name,
          ...(freed.tabLabel !== undefined && { tabLabel: freed.tabLabel }),
        },
        snap,
      )
      deps.log(
        `wake: ${item.name} wakes in a new tab, ${pane}: its pane ${freed.pane} was closed when it went to sleep`,
      )
      followed(deps, () => followFiles.paneOpened(item.session ?? '', pane))
    }
    const target = { pane, session: item.session ?? '', profile }
    outcome = await wakeInPane(cliWakeHerdr, target, {
      timeoutMs,
      log: text => deps.log(`wake: ${text}`),
      ...(freed && { fresh: true }),
    })
    if (!outcome.ok && outcome.why === 'busy') {
      const now = await cliWakeHerdr.pane(pane)
      if (now?.agent === 'claude' && now.agent_session?.value === target.session) return { ok: true }
    }
  } catch (err) {
    return { ok: false, herdrDown: true, error: t('err.wake', { name: item.name, why: messageOf(err) }) }
  }
  if (!outcome.ok) return { ok: false, error: t('err.wake', { name: item.name, why: outcome.error }) }
  if (!freed) await cliWakeHerdr.rename(pane, null).catch(() => {})
  deps.log(`wake: woke ${item.name} in ${pane} from the board`)
  return freed ? { ok: true, pane } : { ok: true }
}

/** The schedule not following a session to its new pane is logged: the wake goes on. */
function followed(deps: Deps, what: () => void): void {
  try {
    what()
  } catch (err) {
    deps.log(`wake: could not update the schedule: ${messageOf(err)}`)
  }
}

/** Wake turned off in config.json, where today's path would refuse too (H1). */
const wakeIsOff = (): { ok: false; why: string; error: string } => ({ ok: false, why: 'off', error: t('err.wakeOff') })

/**
 * Whether the board may have herdr-wake wake a session, by core/profiles.ts mayWake: the board's
 * own profile, or a pane the board opened in the session's profile, as herdr shows it now; never a
 * pane the board opened in another one. `refused`: the profile guard said no (the reason in
 * `error`); without it herdr did not answer the question. `set`: the profiles with the board's own
 * (the CLI asks for a board in another process: its own env may be the session's, not the board's).
 * Where the new wake or the board itself does the waking (a sleeper from wake's file while wake is
 * off, or the new wake on), each sets the profile itself: the guard is the "can wake" rule then
 * (call 19), which needs the session's id and folder.
 */
export type WakeGuard = { ok: true } | { ok: false; error: string; refused: boolean }

export async function checkWake(
  deps: Deps,
  item: Pick<Item, 'name' | 'pane' | 'profile' | 'profileFolder'> &
    Partial<Pick<Item, 'session' | 'cwd' | 'fromFile' | 'agent' | 'sleeping'>>,
  set: ProfileSet = deps.profiles(),
): Promise<WakeGuard> {
  // A sleeping pi session wakes in the account it slept with, which wake kept (#178).
  if (item.sleeping && isPiItem(item)) return canWakePi(item)
  if (offFileSleeper(deps.cfg, item) || newWake(deps)) return canWakeAgain(deps, item, set)
  // The board's records first, without asking herdr: the board's own profile in a pane no record
  // puts in another one wakes with the same herdr calls as before profiles.
  let check = mayWake(item, set, new Map(), item.pane ? possibleProfilePanes(new Map([[item.pane, null]])) : new Map())
  // Not the board's own profile, or a record puts the pane in another one: herdr is asked which
  // terminal each pane holds, as a record vouches only for the terminal the board opened, and
  // stops blocking only once herdr shows the pane holds another one.
  if (!check.ok && item.pane) {
    try {
      const live = paneTerminals(await snapshot())
      check = mayWake(item, set, provenProfilePanes(live), possibleProfilePanes(live))
    } catch (err) {
      return { ok: false, refused: false, error: t('err.wake', { name: item.name, why: messageOf(err) }) }
    }
  }
  if (check.ok) return { ok: true }
  const error = check.pane
    ? t('err.wakePane', { profile: check.pane })
    : t('err.wakeProfile', { profile: check.profile })
  return { ok: false, refused: true, error }
}

/**
 * Wake a session herdr-wake put to sleep (takes 10 to 30 s), only where it resumes in the
 * session's own profile (checkWake). Focus, a message, a reminder and a restart wake through
 * here, so they are refused alike. On the old path herdr-wake at wakeUrl wakes it, as today; the
 * new wake wakes it while it answers. The board wakes it itself (call 28) when it is a sleeper
 * from wake's session file and wake is off, or when the new wake is on but nothing listens on its
 * port; never while the new wake took the question but is slow to answer: it may be waking that
 * very session, so nothing is typed (`wakeBusy`).
 */
export async function wake(deps: Deps, item: Item): Promise<ActionResult> {
  const check = await checkWake(deps, item)
  if (!check.ok) return { ok: false, error: check.error }
  if (isPiItem(item)) return wakePiItem(deps, item)
  if (offFileSleeper(deps.cfg, item)) return wakeHere(deps, item)
  const fresh = newWake(deps)
  if (!fresh) return deps.wake.wake(item)
  const reach = await fresh.reach()
  if (reach === 'slow') return { ok: false, wakeBusy: true, error: t('err.wakeBusy', { name: item.name }) }
  return reach === 'up' ? fresh.wake(item) : wakeHere(deps, item)
}

/**
 * A sleeping pi session woken (#178): by the board's wake while it answers, else by the board
 * itself (wakePiHere); never while wake took the question but is slow to answer. Where it woke is
 * in the answer: a new tab when its pane was not as it was left.
 */
async function wakePiItem(deps: Deps, item: Item): Promise<ActionResult> {
  const fresh = newWake(deps)
  if (fresh) {
    const reach = await fresh.reach()
    if (reach === 'slow') return { ok: false, wakeBusy: true, error: t('err.wakeBusy', { name: item.name }) }
    if (reach === 'up') return fresh.wake(item)
  }
  return wakePiHere(deps, item)
}

/**
 * Whether the wake that puts sessions to sleep answers, which a sleep and a restart need: { ok }
 * or { ok: false, why, error }, error a message for the user. The new wake while the board talks
 * to it: why 'down' or 'slow'. Else herdr-wake at wakeUrl, as today: why the reason as it came
 * (empty when wakeUrl is not set); but 'off' when config.json's own `wake` key turns wake off (H1).
 */
export async function wakeAnswers(
  deps: Pick<Deps, 'cfg' | 'wake'>,
): Promise<{ ok: true } | { ok: false; why: string; error: string }> {
  const fresh = newWake(deps)
  if (fresh) {
    const reach = await fresh.reach()
    if (reach === 'up') return { ok: true }
    return { ok: false, why: reach, error: t('err.wakeNoAnswer', { port: wakeConfig(deps.cfg.wake).port }) }
  }
  const url = deps.cfg.wakeUrl
  if (!url) return wakeOffByKey(deps.cfg) ? wakeIsOff() : { ok: false, why: '', error: t('err.restart.noWake') }
  const r = await herdrWakeAnswers(String(url))
  if (r.ok) return r
  return wakeOffByKey(deps.cfg)
    ? wakeIsOff()
    : { ok: false, why: r.why, error: t('err.restart.wakeDown', { url, why: r.why }) }
}

/**
 * Whether a session can be put to sleep now, for a restart: { ok, status } (herdr's status as just
 * read) or { ok: false, why }, why being 'gone' (another session in its pane), 'busy' (herdr or
 * Claude says it works), 'dialog', 'draft' (the user's unsent text in its input box), 'tasks' (its
 * turn is over but a background command or a Monitor still runs: Claude's own registry says
 * `shell`, and herdr-wake keeps such a session up), or herdr's error. The registry is the one of
 * the session's own profile (its Claude home, deps.homes), the folder it reported when no profile
 * has it; a session whose profile is not known at all is not put to sleep (checkWake refuses it),
 * which `profile` says (the archive tells that refusal apart, services/archive.ts).
 */
export async function readyToSleep(
  deps: Deps,
  item: Pick<Item, 'pane' | 'session' | 'profile' | 'profileFolder'>,
): Promise<{ ok: true; status: AgentStatus } | { ok: false; why: string; profile?: true }> {
  if (isPiItem(item)) return readyPiToSleep(item)
  const set = deps.profiles()
  const dir = itemProfile(item, set.list)?.dir ?? item.profileFolder
  if (!dir) return { ok: false, why: t('err.wakeProfile', { profile: profileLabel(item, set) }), profile: true }
  try {
    const agent = item.pane ? await agentGet(item.pane) : null
    if (!agent || agent.session !== (item.session ?? null)) return { ok: false, why: 'gone' }
    if (agent.status === 'blocked') return { ok: false, why: 'dialog' }
    if (agent.status === 'working') return { ok: false, why: 'busy' }
    const reg = item.session ? deps.homes.forDir(dir).liveSessions().get(item.session)?.status : undefined
    if (reg === 'busy') return { ok: false, why: 'busy' }
    if (reg === 'shell') return { ok: false, why: 'tasks' }
    const draft = inputDraft(
      await herdrText(['agent', 'read', item.pane ?? '', '--source', 'recent', '--lines', '40', '--ansi'], 10_000),
    )
    if (draft === null) return { ok: false, why: 'dialog' }
    return draft === '' ? { ok: true, status: agent.status } : { ok: false, why: 'draft' }
  } catch (err) {
    return { ok: false, why: t('err.restart.herdr', { why: messageOf(err) }) }
  }
}

/**
 * readyToSleep for a pi session (#178), as wake checks it before it stops pi: herdr shows it in its
 * pane on its session file and not at work nor in a dialog, its last turn is over in its file, and
 * nothing is typed in its input box. Its account is wake's to keep, so its profile is not asked.
 */
async function readyPiToSleep(
  item: Pick<Item, 'pane' | 'session'>,
): Promise<{ ok: true; status: AgentStatus } | { ok: false; why: string }> {
  try {
    const agent = item.pane ? await agentGet(item.pane) : null
    if (!agent || agent.session !== (item.session ?? null)) return { ok: false, why: 'gone' }
    if (agent.status === 'blocked') return { ok: false, why: 'dialog' }
    if (agent.status === 'working') return { ok: false, why: 'busy' }
    const lines = item.session ? readPiTail(item.session) : null
    if (!lines || !piTurnOver(lines)) return { ok: false, why: 'busy' }
    const draft = piDraft(await herdrText(['pane', 'read', item.pane ?? '', '--source', 'visible'], 10_000))
    if (draft === null) return { ok: false, why: 'dialog' }
    return draft === '' ? { ok: true, status: agent.status } : { ok: false, why: 'draft' }
  } catch (err) {
    return { ok: false, why: t('err.restart.herdr', { why: messageOf(err) }) }
  }
}

/**
 * Put a session to sleep through herdr-wake, as its reaper does after an idle hour: Claude exits,
 * the pane stays as "💤 <name>". Only an idle session; herdr-wake refuses one that works, has
 * background tasks or text in its input box. Refused as wake being off when config.json turns it
 * off and herdr-wake does not answer at wakeUrl (H1; wakeAnswers).
 */
export async function sleepSession(deps: Deps, item: Item): Promise<ActionResult> {
  if (item.sleeping) return { ok: true }
  if (!item.session || !item.pane) return { ok: false, error: t('err.notClaude', { name: item.name }) }
  if (item.status === 'working' || item.status === 'blocked') {
    return {
      ok: false,
      error: t(item.status === 'working' ? 'err.sleepWorking' : 'err.sleepBlocked', { name: item.name }),
    }
  }
  if (wakeOffByKey(deps.cfg)) {
    const up = await wakeAnswers(deps)
    if (!up.ok) return { ok: false, error: up.error }
  }
  return deps.wake.sleep(item)
}

/** How often a message to a session just woken asks whether herdr names it yet. */
export const NAMED_POLL_MS = 500
const NAMED_WAIT_MS = 15_000

/**
 * How long a message to a session just woken waits for herdr to name it in its pane:
 * BOARD_NAMED_WAIT_MS (tests only, unset in production) when a whole number of ms, else 15 s.
 */
export function namedWaitMs(): number {
  const ms = Number(process.env.BOARD_NAMED_WAIT_MS)
  return Number.isInteger(ms) && ms >= 0 ? ms : NAMED_WAIT_MS
}

/**
 * herdr's agent in the pane a wake just brought the session back to (#267). herdr names the
 * session there only once its own SessionStart hook reported it (a PowerShell script on Windows),
 * which can come seconds after Claude is up and idle, all a wake waits for: while the pane's agent
 * has no session, it is asked again. No agent, another session, or none by the deadline is
 * answered as it is.
 */
async function namedAgent(pane: string, session: string | null): Promise<HerdrAgent | null> {
  for (const deadline = Date.now() + namedWaitMs(); ; await Bun.sleep(NAMED_POLL_MS)) {
    const agent = await agentGet(pane)
    if (!agent || agent.session || !session || Date.now() >= deadline) return agent
  }
}

/** Focus the session's pane in herdr, waking it first; `raise` also brings the terminal window up. */
export async function focus(
  deps: Deps,
  item: Item,
  { raise = false }: { raise?: boolean } = {},
): Promise<ActionResult> {
  // A sleeping session whose pane is gone wakes in a new tab: pi's (#178), Claude's that wake closed (#204).
  if (!item?.pane && !item?.sleeping) return { ok: false, error: t('err.noPane') }
  let pane = item.pane
  if (item.sleeping) {
    const r = await wake(deps, item)
    if (!r.ok) return r
    pane = r.pane ?? pane
  }
  if (!pane) return { ok: false, error: t('err.noPane') }
  try {
    await herdr(['agent', 'focus', pane])
  } catch (err) {
    return { ok: false, error: t('err.focus', { name: item.name, why: messageOf(err) }) }
  }
  if (raise) raiseTerminal(deps.cfg)
  return { ok: true }
}

/**
 * Type a message into the session's prompt, waking it first. Refused while it waits for a
 * decision or Claude's visible screen has no recognizable input box, even if herdr says idle.
 * With `free`, also while it works (instead of queueing into its turn); with `draft`, also while
 * the user has unsent text in its input box (the scheduler's guards). Those refusals say `busy`,
 * plus `dialog` or `draft` for those two. `woken`: the caller woke the session itself just now
 * (the scheduler), so herdr may not name it in its pane yet.
 */
export async function send(
  deps: Deps,
  item: Item,
  message: string,
  { free = false, draft: guardDraft = false, woken = false }: { free?: boolean; draft?: boolean; woken?: boolean } = {},
): Promise<ActionResult> {
  const text = String(message ?? '').trim()
  if (!text) return { ok: false, error: t('err.emptyMessage') }
  // A sleeping session whose pane is gone wakes in a new tab: pi's (#178), Claude's that wake closed (#204).
  if (!item?.pane && !item?.sleeping) return { ok: false, error: t('err.noPane') }
  const expectedSession = item.session ?? null
  const refused = (agent: HerdrAgent | null): ActionResult | null => {
    if (!agent || agent.session !== expectedSession)
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    if (agent.status === 'blocked')
      return { ok: false, busy: true, dialog: true, error: t('err.blocked', { name: item.name }) }
    if (free && agent.status === 'working')
      return { ok: false, busy: true, error: t('err.working', { name: item.name }) }
    return null
  }
  let pane = item.pane
  if (item.sleeping) {
    const r = await wake(deps, item)
    if (!r.ok) return r
    pane = r.pane ?? pane
  }
  if (!pane) return { ok: false, error: t('err.noPane') }
  try {
    // Only a Claude session just woken waits for its name; pi's names its session file at once.
    const named = (item.sleeping || woken) && !isPiItem(item)
    const agent = named ? await namedAgent(pane, expectedSession) : await agentGet(pane)
    // Recheck after wake too: the pane may now host a different session.
    const before = refused(agent)
    if (before) return before
    if (agent?.kind === 'claude' || item.agent === 'claude') {
      // Herdr can miss a dialog (e.g. Teach auto mode). Require the visible prompt for every
      // send; recent scrollback could still contain an old input box. Only scheduled messages
      // also refuse a draft: Enter would send both it and the reminder.
      const draft = inputDraft(await herdrText(['agent', 'read', pane, '--source', 'visible', '--ansi'], 10_000))
      if (draft === null || (guardDraft && draft !== '')) {
        return {
          ok: false,
          busy: true,
          draft: draft !== null,
          dialog: draft === null,
          error: t(draft === null ? 'err.blocked' : 'err.draft', { name: item.name }),
        }
      }
      // The screen read can take time. Do not send to a replacement session, or one herdr now
      // knows is blocked (or working, for an idle-only reminder).
      const fresh = await agentGet(pane)
      const after = refused(fresh)
      if (after) return after
      if (fresh?.kind !== agent?.kind) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    }
    // This read and prompt are separate CLI calls, not an atomic identity check and send.
    // A leading dash would be read as an option by the herdr CLI.
    await herdr(['agent', 'prompt', pane, /^-/.test(text) ? ` ${text}` : text])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: t('err.send', { name: item.name, why: messageOf(err) }) }
  }
}
