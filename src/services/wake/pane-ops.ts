// Waking a sleeping session in its pane and putting a running one to sleep there: what the wake
// process and the board's own wake both do, ported from herdr-wake's router.mjs (wake, waitReady,
// putToSleep, withPane). The one line typed is `board resume <id> --profile <id>`, which goes to
// the session's folder itself, so there is no `cd` (call 17); the prompt line is cleared first by
// the pane's shell, not by this process's OS (call 18). Nothing is typed into a pane whose
// foreground or input box cannot be read, and no session is woken where the line would lose its
// profile. A session put to sleep gives its pane back where it can (#204, core/wake/freed.ts): once
// Claude has left, the pane is closed, and its tab with it when only herdr-sidebar's panes are
// beside it; it wakes in a new tab then (services/wake/tabs.ts), the line run as the shell starts.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { WakeHerdr } from '../../adapters/wake-herdr.ts'
import { inputDraft } from '../../core/dialogs/input-box.ts'
import {
  type FreedPlace,
  type FreeRules,
  freePlan,
  promptIdle,
  promptRows,
  promptShows,
  tabFocused,
} from '../../core/wake/freed.ts'
import { clearKeyFor, plainProfile, wakeLine } from '../../core/wake/rules.ts'
import { isChannelsWarning, isExitTasksDialog, isTrustDialog } from '../../core/wake/screens.ts'

/** Woken, with the pane it woke in when that is another than the one asked for (a new tab, #204). */
export type WakeOutcome =
  | { ok: true; pane?: string }
  | { ok: false; why: 'busy' | 'timeout' | 'trust' | 'blocked' | 'line'; error: string }

/** The clock and the log, for tests; the real ones by default. */
export interface Timing {
  sleep?(ms: number): Promise<void>
  now?(): number
  log?(text: string): void
}

/** How often a waking pane is looked at. */
const READY_POLL_MS = 1500
/** The development-channels warning gets Enter at most this often, this far apart. */
const MAX_CONFIRMS = 3
const CONFIRM_GAP_MS = 5000
/** How long Claude has to leave after /exit, looked at each second. */
const EXIT_WAIT_MS = 30_000
const EXIT_POLL_MS = 1000
/** The 💤 label before the wake line is typed at the prompt. */
const TYPE_AFTER_RENAME_MS = 500
/** herdr may answer for a pane it has just closed: asked this many times more, this far apart. */
const GONE_CHECKS = 2
const GONE_WAIT_MS = 500

const ERRORS = {
  busy: 'its pane runs another program',
  timeout: 'it did not start in time',
  trust: 'it asks whether to trust the folder: answer in its terminal',
  blocked: 'it waits for an answer in its terminal',
} as const
const NOT_A_SESSION = 'it is not a Claude session that board resume can wake'
/** Why a session whose profile id the wake line cannot carry is not woken (and, in the engine, not put to sleep). */
export const PROFILE_NOT_PLAIN = 'its profile id is not a plain word'

function clock(t: Timing = {}): Required<Timing> {
  return {
    sleep: ms => (t.sleep ? t.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms))),
    now: () => (t.now ? t.now() : Date.now()),
    log: text => t.log?.(text),
  }
}

/**
 * The line that wakes the session, or why there is none: not a session id (pi's and Codex's
 * `pane-<id>` keys), or a profile id that `--profile` cannot carry: without it the session would
 * wake in its card's or the pane's shell's profile, not surely its own.
 */
export function lineFor(session: string, profile: string | null | undefined): { line: string } | { error: string } {
  const line = wakeLine(session, profile)
  if (line === null) return { error: NOT_A_SESSION }
  if (typeof profile === 'string' && !plainProfile(profile)) return { error: PROFILE_NOT_PLAIN }
  return { line }
}

/**
 * The pane is at its shell's prompt: herdr gives the shell's pid, and every foreground process it
 * lists, named or not, has that pid. An empty list passes, as in router.mjs: herdr then shows no
 * program in front of the shell. The shell's name, for its clear key, and its pid.
 */
export async function atPrompt(io: WakeHerdr, pane: string): Promise<{ shell: string | null; pid: number } | null> {
  const info = await io.processInfo(pane)
  if (info.shellPid === null || info.foreground.some(p => p.pid !== info.shellPid)) return null
  return { shell: info.shell, pid: info.shellPid }
}

/** A pane held by a withPane call, until its `fn` has ended. */
interface Hold {
  readonly pane: string
  over: boolean
}
/** The holds of the withPane calls the current async context runs inside. */
const holding = new AsyncLocalStorage<readonly Hold[]>()
/** Pane → the end of its last queued operation. */
const locks = new Map<string, Promise<void>>()

/**
 * One operation per pane at a time, in this process: `fn` starts once the pane's earlier ones
 * have ended, whether they failed or not. A call inside an operation that holds the pane already
 * (wakeInPane or putToSleep inside the caller's own withPane) runs `fn` at once, as part of it;
 * work that operation leaves running after it ends queues like any other.
 */
export function withPane<T>(pane: string, fn: () => Promise<T>): Promise<T> {
  const outer = holding.getStore()?.filter(h => !h.over) ?? []
  if (outer.some(h => h.pane === pane)) return fn()
  const hold: Hold = { pane, over: false }
  const next = (locks.get(pane) ?? Promise.resolve())
    .then(() => holding.run([...outer, hold], fn))
    .finally(() => {
      hold.over = true
    })
  const ended = next.then(
    () => {},
    () => {},
  )
  locks.set(pane, ended)
  void ended.then(() => {
    if (locks.get(pane) === ended) locks.delete(pane)
  })
  return next
}

/**
 * Waits until the pane's Claude is ready for input: 'ready', 'trust', 'blocked' or 'timeout'
 * ('timeout' at once when herdr no longer has the pane: it will not start there).
 * Sessions started with development channels first ask for a confirmation; that one dialog gets
 * Enter here. The folder trust question, and any other, is left to the user.
 */
export async function waitReady(
  io: WakeHerdr,
  pane: string,
  timeoutMs: number,
  t?: Timing,
): Promise<'ready' | 'trust' | 'blocked' | 'timeout'> {
  const { sleep, now, log } = clock(t)
  let confirms = 0
  let lastConfirm: number | null = null
  for (const deadline = now() + timeoutMs; now() < deadline; await sleep(READY_POLL_MS)) {
    const p = await io.pane(pane)
    if (!p) return 'timeout'
    if (p.agent !== 'claude') continue
    if (p.agent_status === 'idle' || p.agent_status === 'done') return 'ready'
    if (p.agent_status !== 'blocked' || (lastConfirm !== null && now() - lastConfirm < CONFIRM_GAP_MS)) continue
    const screen = await io.screen(pane)
    if (isTrustDialog(screen)) return 'trust'
    if (confirms >= MAX_CONFIRMS || !isChannelsWarning(screen)) return 'blocked'
    log(`confirming the development channels warning in ${pane}`)
    await io.sendKeys(pane, 'enter')
    confirms++
    lastConfirm = now()
  }
  return 'timeout'
}

/**
 * Resumes the pane's sleeping session with `board resume` in its profile and waits until Claude
 * is ready for input. Only into a pane at its shell's prompt: the line is cleared by that shell's
 * key, then the one line run; herdr's errors are thrown. A pane just opened for it (`fresh`, a new
 * tab, #204) gets the line as it is, its shell maybe still starting. Holds the pane (withPane)
 * itself; a caller that does more in the pane right after (the Telegram router types its message)
 * runs both inside its own withPane, which this joins.
 */
export async function wakeInPane(
  io: WakeHerdr,
  target: { pane: string; session: string; profile?: string | null },
  o: Timing & { timeoutMs: number; platform?: string; fresh?: boolean },
): Promise<WakeOutcome> {
  const found = lineFor(target.session, target.profile)
  if ('error' in found) return { ok: false, why: 'line', error: found.error }
  return withPane(target.pane, async () => {
    const prompt = o.fresh ? null : await atPrompt(io, target.pane)
    if (!o.fresh && !prompt) return { ok: false, why: 'busy', error: ERRORS.busy }
    clock(o).log(`waking ${target.session} in ${target.pane}`)
    if (prompt) await io.sendKeys(target.pane, clearKeyFor(prompt.shell, o.platform))
    await io.run(target.pane, found.line)
    const state = await waitReady(io, target.pane, o.timeoutMs, o)
    return state === 'ready' ? { ok: true } : { ok: false, why: state, error: ERRORS[state] }
  })
}

/** What putToSleep tells its caller on the way, for the session file. */
export interface SleepMarks {
  /** /exit is about to be typed. */
  going(now: number): void
  /** Claude left the pane: asleep. */
  slept(now: number): void
  /** It stays up (background tasks, did not exit in time, herdr failed on the way). */
  stayed(): void
  /** Its pane is about to be closed (#204): keep it as asleep there, by its session id. */
  freeing?(place: FreedPlace): void
  /** Its pane is still there after the close: back under its pane. */
  kept?(): void
}

/** What freePane tells its caller: the record moved before the close, and back if the pane stays. */
export type FreeMarks = Required<Pick<SleepMarks, 'freeing' | 'kept'>>

/**
 * Closes a sleeper's pane, or its tab when only herdr-sidebar's panes are beside it, where
 * core/wake/freed.ts freePlan allows on a snapshot taken right before the close: only while the
 * pane is at its shell's prompt with nothing started in it, and its screen shows an empty prompt or
 * the session's wake line (promptIdle). `freeing` comes before the close, so a wake that stops
 * meanwhile keeps the sleeper; a close that fails may have closed all the same, so herdr is asked
 * after it, and again a moment later while it still shows the pane (an answer from before the close
 * took effect): the pane there each time, `kept` follows and null comes back; gone, or herdr not
 * saying, where it comes back.
 */
export async function freePane(
  io: WakeHerdr,
  target: { pane: string; session: string },
  marks: FreeMarks,
  o: FreeOptions,
): Promise<FreedPlace | null> {
  const { pane } = target
  if (!(await atPrompt(io, pane)) || !promptIdle(await io.screen(pane), target.session)) return null
  return closeFreed(io, pane, marks, o)
}

type FreeOptions = FreeRules & { now: number; log(text: string): void; sleep(ms: number): Promise<void> }

/** freePane once its shell is judged: the close where freePlan allows it, on a snapshot taken now. */
async function closeFreed(io: WakeHerdr, pane: string, marks: FreeMarks, o: FreeOptions): Promise<FreedPlace | null> {
  const plan = freePlan(await io.snapshot(), pane, o.now, o)
  if (!plan) return null
  marks.freeing(plan.place)
  try {
    if ('tab' in plan.close) await io.closeTab(plan.close.tab)
    else await io.closePane(plan.close.pane)
  } catch (err) {
    o.log(`closing ${pane}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const there = (): Promise<boolean> =>
    io.pane(pane).then(
      p => p !== null,
      () => false,
    )
  let still = await there()
  for (let i = 0; still && i < GONE_CHECKS; i++) {
    await o.sleep(GONE_WAIT_MS)
    still = await there()
  }
  if (!still) return plan.place
  marks.kept()
  return null
}

/**
 * What lookAgain made of a kept sleeper's pane: given back; kept with its wake line at its prompt
 * (a later look may give it back), or with the line typed again there; kept for good (nothing about
 * this shell changes that by itself); no answer yet (a shell still starting: ask again); left alone
 * while the user looks at its tab.
 */
export type LookedAt = 'freed' | 'line' | 'typed' | 'kept' | 'later' | 'focused'

/**
 * A sleeper kept in its pane, looked at again (#243): its pane given back as freePane gives it, now
 * that what kept it may have gone (its tab no longer looked at, the tabs before it closed, nobody
 * else coming back to its workspace). Only while its shell is as a sleep left it: its last prompt
 * holds its wake line, nothing run there since.
 *
 * In a pane herdr gave a new terminal (`restored`) an empty prompt will do too, but only in a shell
 * that has just started: another shell process than the one noted in that pane (`shellPid`; herdr's
 * live handoff gives a pane a new terminal and keeps its shell), one prompt row on its screen
 * (anything run there shows more, its commands, a remote shell's or a REPL's prompt, unless the
 * screen was cleared since), and, where herdr does not list a program the shell started (Windows),
 * nothing started under it in the process table (`alone`: null when that cannot be read, 'later').
 * A pane that stays then gets its wake line typed again (`line`, none for a session the user
 * exited) as a sleep leaves it ('typed'), but never while the user looks at its tab ('focused', on
 * a snapshot taken right before the typing). The screen is read first: a restored shell that shows
 * no prompt yet is still starting ('later').
 */
export async function lookAgain(
  io: WakeHerdr,
  target: { pane: string; session: string; line: string | null; shellPid?: number },
  marks: FreeMarks,
  o: FreeOptions & { restored: boolean; alone?: (shellPid: number) => boolean | null },
): Promise<LookedAt> {
  const { pane, session, line } = target
  const screen = await io.screen(pane)
  const shows = promptShows(screen, session)
  if (shows === 'none') return o.restored ? 'later' : 'kept'
  if (shows === 'other') return 'kept'
  const prompt = await atPrompt(io, pane)
  if (!prompt) return 'kept'
  if (shows === 'empty') {
    if (!o.restored || prompt.pid === target.shellPid || promptRows(screen) !== 1) return 'kept'
    const alone = o.alone ? o.alone(prompt.pid) : true
    if (alone === null) return 'later'
    if (!alone) return 'kept'
  }
  if (await closeFreed(io, pane, marks, o)) return 'freed'
  if (shows === 'line') return 'line'
  if (line === null || !(await atPrompt(io, pane))) return 'kept'
  if (tabFocused(await io.snapshot(), pane)) return 'focused'
  await io.sendText(pane, line)
  return 'typed'
}

/** Types /exit and waits for Claude to leave: 'slept', 'tasks' (Esc pressed on that dialog) or 'up'. */
async function exitClaude(
  io: WakeHerdr,
  pane: string,
  { sleep, now }: Required<Timing>,
): Promise<'slept' | 'tasks' | 'up'> {
  await io.prompt(pane, '/exit')
  for (const deadline = now() + EXIT_WAIT_MS; now() < deadline; await sleep(EXIT_POLL_MS)) {
    const after = await io.pane(pane)
    if (!after) return 'up'
    // "The following will stop when you exit": it runs background work after all. Stay.
    if (after.agent === 'claude' && after.agent_status === 'blocked' && isExitTasksDialog(await io.screen(pane))) {
      await io.sendKeys(pane, 'esc')
      return 'tasks'
    }
    if (!after.agent) return 'slept'
  }
  return 'up'
}

/**
 * /exit an idle session, then give its pane back (`free`, freePane: `freeing` follows, and `kept`
 * when the pane stays), or leave it marked `💤 <name>` with the wake line typed at its prompt, not
 * run. Holds the pane (withPane)
 * itself, or joins its caller's hold of it. Refuses (false, no /exit) unless the session could be
 * woken by that line, and the pane holds Claude with this session, idle or done, with an empty
 * input box it can read. After `going`, `slept` or `stayed` follows, even when herdr fails.
 */
export async function putToSleep(
  io: WakeHerdr,
  target: { pane: string; session: string; name: string; profile?: string | null },
  marks: SleepMarks,
  t?: Timing & { free?: FreeRules | false },
): Promise<boolean> {
  const found = lineFor(target.session, target.profile)
  if ('error' in found) return false
  const c = clock(t)
  const { pane, name } = target
  return withPane(pane, async () => {
    const cur = await io.pane(pane)
    if (cur?.agent !== 'claude' || cur.agent_session?.value !== target.session) return false
    if (cur.agent_status !== 'idle' && cur.agent_status !== 'done') return false
    if (inputDraft(await io.inputBox(pane)) !== '') return false
    marks.going(c.now())
    let end: 'slept' | 'tasks' | 'up'
    try {
      end = await exitClaude(io, pane, c)
    } catch (err) {
      marks.stayed()
      throw err
    }
    if (end !== 'slept') {
      marks.stayed()
      c.log(
        end === 'tasks'
          ? `${name} in ${pane} has background tasks, left it running`
          : `${name} in ${pane} did not exit`,
      )
      return false
    }
    marks.slept(c.now())
    if (t?.free) {
      const free = { freeing: marks.freeing ?? (() => {}), kept: marks.kept ?? (() => {}) }
      const place = await freePane(io, { pane, session: target.session }, free, {
        ...t.free,
        now: c.now(),
        log: c.log,
        sleep: c.sleep,
      }).catch(err => {
        c.log(`${name}: its pane ${pane} could not be closed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      if (place) {
        c.log(`put ${name} to sleep, its pane ${pane} closed`)
        return true
      }
    }
    await io.rename(pane, `💤 ${name}`).catch(() => {})
    await c.sleep(TYPE_AFTER_RENAME_MS)
    // Typed for the user to run, only at the shell's prompt (nothing else took the pane meanwhile).
    const prompt = await atPrompt(io, pane).catch(() => null)
    if (prompt) await io.sendText(pane, found.line).catch(() => {})
    c.log(`put ${name} to sleep in ${pane}`)
    return true
  })
}
