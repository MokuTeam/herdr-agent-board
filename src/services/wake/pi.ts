// Putting a pi session to sleep in its pane, and waking it there or in a new tab (#178): what the
// wake process does for pi, and the board itself while wake does not answer, as pane-ops.ts does
// for Claude. To sleep, pi must be idle three ways (herdr says so, its input box is empty, its
// session file's last turn is over); what brings it back is kept first (`going`), then pi and every
// process it started are stopped, and the pane is left `💤 <name>` with `board resume --pi <id>`
// typed at its prompt. To wake, that line is run in the sleeper's own pane while it is a shell as
// it was left, else in a new tab of its workspace (a new workspace when that is gone too), until
// herdr shows pi back on that session, free.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { readTail } from '../../adapters/claude-home.ts'
import { tabCreateRoot, workspaceCreate } from '../../adapters/herdr.ts'
import {
  claudeConfigDirOf,
  type PiProcess,
  type ProcSys,
  piProcessIn,
  realProcSys,
  stopTree,
} from '../../adapters/pi-processes.ts'
import { cliWakeHerdr, type WakeHerdr } from '../../adapters/wake-herdr.ts'
import { piDraft } from '../../core/dialogs/pi-dialogs.ts'
import { piProvider, piTurnOver } from '../../core/pi.ts'
import {
  accountOf,
  type PiSleeper,
  type PiSnapshot,
  piResumeArgv,
  piSleeperPane,
  piWakeLine,
  sleepLabel,
} from '../../core/wake/pi.ts'
import { CANNOT_WAKE, clearKeyFor } from '../../core/wake/rules.ts'
import { atPrompt, type Timing, type WakeOutcome, withPane } from './pane-ops.ts'

/** What putting pi to sleep and waking it need besides herdr: its process, its session file, new tabs. */
export interface PiOps {
  herdr: WakeHerdr
  procs: ProcSys
  /** pi in the pane, from herdr's process-info; null when none runs in its foreground. */
  piProcess(pane: string): Promise<PiProcess | null>
  /** The CLAUDE_CONFIG_DIR a process runs with: '' none, null when it cannot be read. */
  configDir(pid: number): string | null
  /** The end of the session file, as lines; null when there is no file. */
  tail(file: string): string[] | null
  /** When the file was last written (ms); null when there is none. */
  writtenAt(file: string): number | null
  /** Whether the file or folder is there. */
  exists(path: string): boolean
  /** A new tab in the workspace, in `cwd`, labelled `label`: its pane. */
  newTab(workspace: string, cwd: string, label: string): Promise<string>
  /** A new workspace in `cwd`, labelled `label`: its pane. */
  newWorkspace(cwd: string, label: string): Promise<string>
  home: string
  platform?: string
}

/** What putPiToSleep tells its caller on the way, for wake's pi file. */
export interface PiSleepMarks {
  /** pi is about to be stopped: keep the sleeper. */
  going(sleeper: PiSleeper): void
  /** It stays up (pi did not stop, or herdr failed on the way): forget it. */
  stayed(): void
}

/** How long after its session file was last written pi counts as free. */
const QUIET_MS = 3000
/** How long the pane has to show its shell again once pi is stopped. */
const SHELL_WAIT_MS = 10_000
const SHELL_POLL_MS = 500
/** The 💤 label before the wake line is typed at the prompt. */
const TYPE_AFTER_RENAME_MS = 500
/** How often a waking pane is looked at. */
const READY_POLL_MS = 1000

const ERRORS = {
  timeout: 'it did not start in time',
  blocked: 'it waits for an answer in its terminal',
} as const

function clock(t: Timing = {}): Required<Timing> {
  return {
    sleep: ms => (t.sleep ? t.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms))),
    now: () => (t.now ? t.now() : Date.now()),
    log: text => t.log?.(text),
  }
}

export type PiSleepOutcome = { ok: true; sleeper: PiSleeper } | { ok: false; error: string }

/**
 * Puts the pi session in `target.pane` to sleep: only one herdr shows there on that session file,
 * idle or done, with nothing typed in its input box and its last turn over in its file (written to
 * at least QUIET_MS ago), whose pi process and command line can be read, and which the wake line
 * can bring back (`board` on PATH). The account kept is the CLAUDE_CONFIG_DIR pi runs with where it
 * can be read, else `target.account` (the card's). Holds the pane (withPane).
 */
export async function putPiToSleep(
  ops: PiOps,
  target: { pane: string; session: string; name: string; workspaceLabel?: string; account?: string },
  marks: PiSleepMarks,
  t: Timing & { boardOnPath: boolean },
): Promise<PiSleepOutcome> {
  const c = clock(t)
  const { pane, session, name } = target
  const no = (error: string): PiSleepOutcome => ({ ok: false, error })
  const line = piWakeLine(session)
  if (!line) return no(`${name} cannot be put to sleep: its session file's name has no id to wake it by`)
  if (!t.boardOnPath) return no(`${name} cannot be put to sleep: ${CANNOT_WAKE.board}`)
  return withPane(pane, async () => {
    const cur = await ops.herdr.pane(pane)
    if (cur?.agent !== 'pi' || cur.agent_session?.value !== session) return no(`no running session named ${pane}`)
    if (cur.agent_status !== 'idle' && cur.agent_status !== 'done') return no(`${name} is not idle`)
    const lines = ops.tail(session)
    if (!lines) return no(`${name} cannot be put to sleep: its session file is not there`)
    const written = ops.writtenAt(session)
    if (!piTurnOver(lines) || (written !== null && c.now() - written < QUIET_MS)) return no(`${name} is not idle`)
    if (piDraft(await ops.herdr.screen(pane)) !== '')
      return no(`${name} did not go to sleep (busy, or text in its input box)`)
    const proc = await ops.piProcess(pane)
    if (!proc) return no(`${name} cannot be put to sleep: pi's process is not in its pane`)
    const resume = piResumeArgv(proc.argv, session)
    if ('error' in resume) return no(`${name} cannot be put to sleep: ${resume.error}`)
    const account = accountOf(ops.configDir(proc.pid), ops.home, ops.platform) ?? target.account
    const provider = piProvider(lines)
    const sleeper: PiSleeper = {
      session,
      name,
      pane,
      ...(cur.workspace_id !== undefined && { workspace: cur.workspace_id }),
      ...(target.workspaceLabel && { workspaceLabel: target.workspaceLabel }),
      cwd: cur.cwd ?? '',
      argv: proc.argv,
      ...(account && { account }),
      ...(provider && { provider }),
      slept_at: c.now(),
    }
    marks.going(sleeper)
    let back = false
    try {
      const stop = await stopTree(ops.procs, proc.pid, c)
      for (const deadline = c.now() + SHELL_WAIT_MS; c.now() < deadline; await c.sleep(SHELL_POLL_MS)) {
        const p = await ops.herdr.pane(pane)
        if (!p) break
        if (!p.agent) {
          back = true
          break
        }
      }
      if (stop.left.includes(proc.pid)) back = false
      else if (stop.left.length) c.log(`${name} in ${pane}: still running after pi stopped: ${stop.left.join(', ')}`)
      if (!stop.table) c.log(`${name} in ${pane}: the process table could not be read, only pi was stopped`)
    } catch (err) {
      marks.stayed()
      throw err
    }
    if (!back) {
      marks.stayed()
      c.log(`${name} (pi) in ${pane} did not stop`)
      return no(`${name} did not go to sleep (pi did not stop)`)
    }
    await ops.herdr.rename(pane, sleepLabel(sleeper)).catch(() => {})
    await c.sleep(TYPE_AFTER_RENAME_MS)
    // Typed for the user to run, only at the shell's prompt (nothing else took the pane meanwhile).
    const prompt = await atPrompt(ops.herdr, pane).catch(() => null)
    if (prompt) await ops.herdr.sendText(pane, line).catch(() => {})
    c.log(`put ${name} (pi) to sleep in ${pane}${sleeper.account ? `, account ${sleeper.account}` : ''}`)
    return { ok: true, sleeper }
  })
}

/**
 * Waits until herdr shows pi on `file` in the pane, free: 'ready'; 'blocked' when it waits for an
 * answer there; 'timeout' when time is up or herdr no longer has the pane.
 */
export async function waitPiReady(
  io: WakeHerdr,
  pane: string,
  file: string,
  timeoutMs: number,
  t?: Timing,
): Promise<'ready' | 'blocked' | 'timeout'> {
  const { sleep, now } = clock(t)
  for (const deadline = now() + timeoutMs; now() < deadline; await sleep(READY_POLL_MS)) {
    const p = await io.pane(pane)
    if (!p) return 'timeout'
    if (p.agent !== 'pi' || p.agent_session?.value !== file) continue
    if (p.agent_status === 'idle' || p.agent_status === 'done') return 'ready'
    if (p.agent_status === 'blocked') return 'blocked'
  }
  return 'timeout'
}

/** The workspace a new tab goes to: the sleeper's own by id and label, else by label, else by id; none: a new one. */
function workspaceFor(snap: PiSnapshot, s: PiSleeper): string | null {
  const byId = snap.workspaces.find(w => w.workspace_id === s.workspace)
  const byLabel = s.workspaceLabel ? snap.workspaces.find(w => w.label === s.workspaceLabel) : undefined
  if (byId && (!s.workspaceLabel || byId.label === s.workspaceLabel)) return byId.workspace_id
  return (byLabel ?? byId)?.workspace_id ?? null
}

export type PiWakeOutcome = { ok: true; pane: string } | Exclude<WakeOutcome, { ok: true }>

/**
 * Wakes the sleeper with `board resume --pi <id>`: in its own pane while it is a shell as it was
 * left, at its prompt (the line cleared first by that shell's key); else in a new tab of its
 * workspace, in its folder (the home folder when that is gone). Then waits until pi is back on its
 * session file, free (waitPiReady). Where it woke is in the answer.
 */
export async function wakePi(
  ops: PiOps,
  sleeper: PiSleeper,
  snap: PiSnapshot,
  o: Timing & { timeoutMs: number },
): Promise<PiWakeOutcome> {
  const c = clock(o)
  const line = piWakeLine(sleeper.session)
  if (!line) return { ok: false, why: 'line', error: "its session file's name has no id to wake it by" }
  if (!ops.exists(sleeper.session)) return { ok: false, why: 'line', error: 'its session file is gone' }
  const label = sleeper.name || 'pi'
  const own = piSleeperPane(snap, sleeper)
  let pane: string | null = null
  if (own) {
    pane = await withPane(own.pane_id, async () => {
      const prompt = await atPrompt(ops.herdr, own.pane_id)
      if (!prompt) return null
      c.log(`waking ${label} (pi) in ${own.pane_id}`)
      await ops.herdr.sendKeys(own.pane_id, clearKeyFor(prompt.shell, ops.platform))
      await ops.herdr.run(own.pane_id, line)
      return own.pane_id
    })
  }
  if (!pane) {
    const cwd = sleeper.cwd && ops.exists(sleeper.cwd) ? sleeper.cwd : ops.home
    const workspace = workspaceFor(snap, sleeper)
    const fresh = workspace
      ? await ops.newTab(workspace, cwd, label)
      : await ops.newWorkspace(cwd, sleeper.workspaceLabel || label)
    c.log(`waking ${label} (pi) in a new tab, ${fresh}: its pane ${sleeper.pane} is not as it was left`)
    await withPane(fresh, () => ops.herdr.run(fresh, line))
    pane = fresh
  }
  const state = await waitPiReady(ops.herdr, pane, sleeper.session, o.timeoutMs, o)
  if (state !== 'ready') return { ok: false, why: state, error: ERRORS[state] }
  return { ok: true, pane }
}

/** How much of the end of a session file is read for its last turn. */
const TAIL_BYTES = 1 << 20

/** The end of a pi session file, as lines; null when there is none or it cannot be read. */
export function readPiTail(file: string): string[] | null {
  try {
    const st = statSync(file, { throwIfNoEntry: false })
    return st?.isFile() ? readTail(file, st.size, TAIL_BYTES).split('\n') : null
  } catch {
    return null
  }
}

/** PiOps for real: herdr's CLI, the OS's processes, the files. */
export function defaultPiOps(herdr: WakeHerdr = cliWakeHerdr): PiOps {
  return {
    herdr,
    procs: realProcSys,
    piProcess: pane => piProcessIn(pane),
    configDir: pid => claudeConfigDirOf(pid),
    tail: file => readPiTail(file),
    writtenAt(file) {
      try {
        return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null
      } catch {
        return null
      }
    },
    exists: path => existsSync(path),
    newTab: async (workspace, cwd, label) => (await tabCreateRoot(workspace, cwd, label)).pane,
    async newWorkspace(cwd, label) {
      const ws = await workspaceCreate(cwd, label)
      if (!ws.pane) throw new Error('herdr workspace create: no pane in its answer')
      return ws.pane
    },
    home: homedir(),
  }
}
