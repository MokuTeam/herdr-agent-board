// Putting an Antigravity CLI (`agy`) session to sleep in its pane, and waking it there or in a new
// tab (#631, part of #127): what the wake process does for `agy`, and the board itself while wake
// does not answer. To sleep, `agy` must be idle (herdr says idle/done, no running subagent helpers,
// input box empty); what brings it back is kept first (`going`), then `/exit` is sent cleanly (with
// `Ctrl+D Ctrl+D` fallback if `/exit` does not take), and the pane is left `💤 <name>` with
// `board resume --agy <id>` typed at its prompt. To wake, that line is run in the sleeper's own
// pane while it is a shell as it was left, else in a new tab of its workspace (or a new workspace
// when that is gone too), until herdr shows `agy` back and idle; if herdr has not yet observed a
// `PreInvocation` hook for the resumed conversation, its session id is reported so the board and
// scheduler see the resumed UUID immediately.
import { existsSync } from 'node:fs'
import { type AgyHome, createAgyHome } from '../../adapters/agy-home.ts'
import { type AgyProcess, agyProcessIn } from '../../adapters/agy-processes.ts'
import { herdrText } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { cliWakeHerdr, type WakeHerdr } from '../../adapters/wake-herdr.ts'
import { AGY_AGENT } from '../../core/agy.ts'
import { agyDraft } from '../../core/dialogs/agy-dialogs.ts'
import { stillTyped } from '../../core/launch/spawn-args.ts'
import {
  type AgySleeper,
  type AgySnapshot,
  agyResumeArgv,
  agySleeperPane,
  agySleepLabel,
  agyWakeLine,
} from '../../core/wake/agy.ts'
import { CANNOT_WAKE, clearKeyFor } from '../../core/wake/rules.ts'
import { atPrompt, type Timing, type WakeOutcome, withPane } from './pane-ops.ts'
import { defaultTabOps, openTab, type TabOps } from './tabs.ts'

/** What putting `agy` to sleep and waking it need besides herdr. */
export interface AgyOps extends TabOps {
  herdr: WakeHerdr
  /** `agy` in the pane, from herdr's process-info; null when unavailable. */
  agyProcess(pane: string): Promise<AgyProcess | null>
  /** Whether the conversation exists on disk (transcript or SQLite DB). */
  hasConversation(session: string): boolean
  /** Whether any subagent child of this conversation is still running. */
  hasRunningHelpers(session: string): boolean
  /** Report the resumed conversation UUID to herdr when its PreInvocation hook has not run yet. */
  reportSession(pane: string, session: string): Promise<void>
  platform?: string
}

/** What putAgyToSleep tells its caller on the way, for wake's agy file. */
export interface AgySleepMarks {
  /** `agy` is about to exit: keep the sleeper. */
  going(sleeper: AgySleeper): void
  /** It stays up (`agy` did not exit, or herdr failed on the way): forget it. */
  stayed(): void
}

/** How long `agy` has to leave after `/exit` (and `Ctrl+D Ctrl+D` fallback). */
const EXIT_WAIT_MS = 15_000
const EXIT_POLL_MS = 500
/** If `/exit` did not exit by this mark while `agy` stays idle, try `Ctrl+D Ctrl+D`. */
const CTRL_D_AFTER_MS = 6000
const CTRL_D_GAP_MS = 400
/** The 💤 label before the wake line is typed at the prompt. */
const TYPE_AFTER_RENAME_MS = 500
/** How often a waking pane is looked at. */
const READY_POLL_MS = 1000

const ERRORS = {
  timeout: 'it did not start in time',
  blocked: 'it waits for an answer in its terminal',
} as const

const stalled = (err: unknown): boolean => isRecord(err) && /agent_prompt_stalled/.test(`${err.code} ${err.message}`)

function clock(t: Timing = {}): Required<Timing> {
  return {
    sleep: ms => (t.sleep ? t.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms))),
    now: () => (t.now ? t.now() : Date.now()),
    log: text => t.log?.(text),
  }
}

export type AgySleepOutcome = { ok: true; sleeper: AgySleeper } | { ok: false; error: string }

/** Sends `/exit` to an idle `agy` pane (retrying Enter if completion held it, then `Ctrl+D Ctrl+D`), waiting for `!p.agent`. */
async function exitAgy(io: WakeHerdr, pane: string, c: Required<Timing>): Promise<boolean> {
  try {
    await io.prompt(pane, '/exit')
  } catch (err) {
    // `/exit` runs locally without a model turn: herdr can report agent_prompt_stalled.
    if (!stalled(err)) throw err
  }
  const start = c.now()
  let retriedEnter = false
  let sentCtrlD = false
  for (const deadline = start + EXIT_WAIT_MS; c.now() < deadline; await c.sleep(EXIT_POLL_MS)) {
    const p = await io.pane(pane)
    if (!p) return false
    if (!p.agent) return true
    if (p.agent !== AGY_AGENT) return false
    const elapsed = c.now() - start
    if (!retriedEnter && elapsed >= EXIT_POLL_MS) {
      retriedEnter = true
      const screen = await io.screen(pane).catch(() => '')
      if (stillTyped(screen, '/exit')) await io.sendKeys(pane, 'enter').catch(() => {})
    }
    if (!sentCtrlD && elapsed >= CTRL_D_AFTER_MS && (p.agent_status === 'idle' || p.agent_status === 'done')) {
      sentCtrlD = true
      await io.sendKeys(pane, 'ctrl+d').catch(() => {})
      await c.sleep(CTRL_D_GAP_MS)
      await io.sendKeys(pane, 'ctrl+d').catch(() => {})
    }
  }
  const last = await io.pane(pane)
  return !!last && !last.agent
}

/**
 * Puts the Antigravity session in `target.pane` to sleep: only one herdr shows there on that
 * conversation UUID, idle or done, with no running subagents and an empty input box, whose
 * conversation exists on disk and which `board resume --agy <id>` can bring back (`board` on PATH).
 * Holds the pane (`withPane`).
 */
export async function putAgyToSleep(
  ops: AgyOps,
  target: { pane: string; session: string; name: string; workspaceLabel?: string },
  marks: AgySleepMarks,
  t: Timing & { boardOnPath: boolean },
): Promise<AgySleepOutcome> {
  const c = clock(t)
  const { pane, session, name } = target
  const no = (error: string): AgySleepOutcome => ({ ok: false, error })
  const line = agyWakeLine(session)
  if (!line) return no(`${name} cannot be put to sleep: it has no Antigravity conversation id`)
  if (!t.boardOnPath) return no(`${name} cannot be put to sleep: ${CANNOT_WAKE.board}`)
  if (!ops.hasConversation(session)) return no(`${name} cannot be put to sleep: ${CANNOT_WAKE.transcript}`)
  return withPane(pane, async () => {
    const cur = await ops.herdr.pane(pane)
    if (cur?.agent !== AGY_AGENT || cur.agent_session?.value !== session) return no(`no running session named ${pane}`)
    if (cur.agent_status !== 'idle' && cur.agent_status !== 'done') return no(`${name} is not idle`)
    if (ops.hasRunningHelpers(session)) return no(`${name} is not idle (subagents are still running)`)
    if (agyDraft(await ops.herdr.inputBox(pane)) !== '')
      return no(`${name} did not go to sleep (busy, or text in its input box)`)
    const proc = await ops.agyProcess(pane).catch(() => null)
    const argv = proc?.argv ?? []
    if (argv.length) {
      const resume = agyResumeArgv(argv, session)
      if ('error' in resume) return no(`${name} cannot be put to sleep: ${resume.error}`)
    }
    const sleeper: AgySleeper = {
      session,
      name,
      pane,
      ...(cur.workspace_id !== undefined && { workspace: cur.workspace_id }),
      ...(target.workspaceLabel && { workspaceLabel: target.workspaceLabel }),
      cwd: cur.cwd ?? '',
      argv,
      slept_at: c.now(),
    }
    marks.going(sleeper)
    let back = false
    try {
      back = await exitAgy(ops.herdr, pane, c)
    } catch (err) {
      marks.stayed()
      throw err
    }
    if (!back) {
      marks.stayed()
      c.log(`${name} (agy) in ${pane} did not exit`)
      return no(`${name} did not go to sleep (Antigravity did not exit)`)
    }
    await ops.herdr.rename(pane, agySleepLabel(sleeper)).catch(() => {})
    await c.sleep(TYPE_AFTER_RENAME_MS)
    const prompt = await atPrompt(ops.herdr, pane).catch(() => null)
    if (prompt) await ops.herdr.sendText(pane, line).catch(() => {})
    c.log(`put ${name} (agy) to sleep in ${pane}`)
    return { ok: true, sleeper }
  })
}

/**
 * Waits until herdr shows `agy` in the pane, free: 'ready'; 'blocked' when it waits for an answer
 * there; 'timeout' when time is up or herdr no longer has the pane. Because herdr's own `agy`
 * integration reports `agent_session` only on `PreInvocation`, an idle `agy` pane with no
 * `agent_session` yet gets `reportSession(pane, session)` so herdr associates it immediately.
 */
export async function waitAgyReady(
  ops: Pick<AgyOps, 'herdr' | 'reportSession'>,
  pane: string,
  session: string,
  timeoutMs: number,
  t?: Timing,
): Promise<'ready' | 'blocked' | 'timeout'> {
  const { sleep, now } = clock(t)
  const want = session.toLowerCase()
  for (const deadline = now() + timeoutMs; now() < deadline; await sleep(READY_POLL_MS)) {
    const p = await ops.herdr.pane(pane)
    if (!p) return 'timeout'
    if (p.agent !== AGY_AGENT) continue
    const got = p.agent_session?.value
    if (got && got.toLowerCase() !== want) continue
    if (p.agent_status === 'idle' || p.agent_status === 'done') {
      if (!got) await ops.reportSession(pane, session).catch(() => {})
      return 'ready'
    }
    if (p.agent_status === 'blocked') return 'blocked'
  }
  return 'timeout'
}

export type AgyWakeOutcome = { ok: true; pane: string } | Exclude<WakeOutcome, { ok: true }>

/**
 * Wakes the sleeper with `board resume --agy <id>`: in its own pane while it is a shell as it was
 * left, at its prompt (the line cleared first by that shell's key); else in a new tab of its
 * workspace, in its folder (the home folder when that is gone). Then waits until `agy` is back and
 * idle (`waitAgyReady`). Where it woke is in the answer.
 */
export async function wakeAgy(
  ops: AgyOps,
  sleeper: AgySleeper,
  snap: AgySnapshot,
  o: Timing & { timeoutMs: number },
): Promise<AgyWakeOutcome> {
  const c = clock(o)
  const line = agyWakeLine(sleeper.session)
  if (!line) return { ok: false, why: 'line', error: 'it has no Antigravity conversation id to wake it by' }
  if (!ops.hasConversation(sleeper.session)) return { ok: false, why: 'line', error: 'its conversation is gone' }
  const label = sleeper.name || AGY_AGENT
  const own = agySleeperPane(snap, sleeper)
  let pane: string | null = null
  if (own) {
    pane = await withPane(own.pane_id, async () => {
      const prompt = await atPrompt(ops.herdr, own.pane_id)
      if (!prompt) return null
      c.log(`waking ${label} (agy) in ${own.pane_id}`)
      await ops.herdr.sendKeys(own.pane_id, clearKeyFor(prompt.shell, ops.platform))
      await ops.herdr.run(own.pane_id, line)
      return own.pane_id
    })
  }
  if (!pane) {
    const fresh = await openTab(
      ops,
      {
        ...(sleeper.workspace !== undefined && { workspace: sleeper.workspace }),
        ...(sleeper.workspaceLabel !== undefined && { workspaceLabel: sleeper.workspaceLabel }),
        cwd: sleeper.cwd,
        label,
      },
      snap,
    )
    c.log(`waking ${label} (agy) in a new tab, ${fresh}: its pane ${sleeper.pane} is not as it was left`)
    await withPane(fresh, () => ops.herdr.run(fresh, line))
    pane = fresh
  }
  const state = await waitAgyReady(ops, pane, sleeper.session, o.timeoutMs, o)
  if (state !== 'ready') return { ok: false, why: state, error: ERRORS[state] }
  return { ok: true, pane }
}

/** Report an `agy` conversation id to herdr with a nanosecond seq matching `herdr-agent-state.sh`. */
export async function reportAgySession(pane: string, session: string, transcriptPath?: string | null): Promise<void> {
  const seq = String(Date.now() * 1_000_000)
  const args = [
    'pane',
    'report-agent-session',
    pane,
    '--source',
    'herdr:antigravity_cli',
    '--agent',
    AGY_AGENT,
    '--seq',
    seq,
    '--agent-session-id',
    session,
    ...(transcriptPath ? ['--agent-session-path', transcriptPath] : []),
  ]
  await herdrText(args, 5000)
}

/** AgyOps for real: herdr's CLI, `agy`'s home on disk, and new tabs. */
export function defaultAgyOps(herdr: WakeHerdr = cliWakeHerdr, agy: AgyHome = createAgyHome()): AgyOps {
  return {
    ...defaultTabOps(path => existsSync(path)),
    herdr,
    agyProcess: pane => agyProcessIn(pane),
    hasConversation: session => agy.hasConversation(session),
    hasRunningHelpers: session => agy.sessionHelpers(session).helpers.some(h => h.status === 'running'),
    reportSession: (pane, session) => reportAgySession(pane, session, agy.transcriptPath(session)),
  }
}
