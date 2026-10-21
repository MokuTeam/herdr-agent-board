// Wake's control on the board (#119): its state line for the payload and the panel, the panel's
// settings, the switch, Start, Start again and Log, and starting wake once when it is on but not
// running (safeguard 3): once after the server is up, and when config.json turns it on. The board
// never waits on wake here: the payload takes the last state at once, asked again in the background
// at most every 2 s (wake's GET /alive, which never waits on herdr, unlike its /status), and with
// wake off and no wake file there is no state, no question and no start.
// Turned off, wake ends by itself (it reads config.json); its workspace is then closed when nothing
// but wake's leftovers (start.ts wakeLeftover) is in it, else only wake's own pane. Starting is
// wake's start's (entrypoints/wake-start.ts), spawned on its own, never while its record says a
// start is under way (herdr's startup entry may have started it a moment ago). "Switch over…"
// takes the separate herdr-wake plugin over (takeover.ts), then starts wake past its held record.
// The payload's state line carries the Telegram router's state while wake runs.
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type EditResult, editWake } from '../../adapters/config-file.ts'
import { asSnapshot, herdr as herdrCli } from '../../adapters/herdr.ts'
import { ROOT } from '../../adapters/paths.ts'
import { wakeAlive } from '../../adapters/wake-api.ts'
import {
  boardPaneNow,
  peekWakeSessions,
  readWakeStatus,
  wakeLog,
  wakeLogFile,
  wakeLogTail,
  wakeSessionsFile,
} from '../../adapters/wake-files.ts'
import { t } from '../../core/lang.ts'
import type { Config } from '../../core/types.ts'
import { telegramTarget, WAKE_SHIPPED, type WakeConfig, wakeConfig } from '../../core/wake/config.ts'
import { STARTING_MS, type WakeState, wakeState } from '../../core/wake/status.ts'
import type { SwitchResult, WakeHooksView, WakeSettingsView, WakeView } from '../../core/wake/view.ts'
import { type BoardPlace, closeOfPane, recordedPane, wakeLeftover, workspaceOf } from './start.ts'
import { switchOver as takeOver } from './takeover.ts'

type Herdr = <T = unknown>(args: string[], timeoutMs?: number) => Promise<T>

export interface WakeControl {
  /** The status file and whether wake answers, cached 2 s; the sleepers' count as it is now. */
  view(): Promise<WakeView>
  /** What the payload carries, at once: the last view, asked again in the background when older than 2 s; null while wake is not shown (off, not shipped, no sleeper in its file). */
  current(): WakeView | null
  /** GET /api/wake's settings. */
  settings(): Promise<WakeSettingsView>
  /** editWake; on → started unless it answers or is held; off → its workspace closes once it ended. */
  turn(on: boolean): Promise<EditResult>
  /** Wake's start, unless wake answers or is held. */
  start(): Promise<EditResult>
  /** Wake's start with --again: its pane made anew. */
  again(): Promise<EditResult>
  /** The last 200 lines of wake.log. */
  logTail(): string
  /**
   * "Switch over…": the separate herdr-wake plugin taken over and uninstalled, its hooks moved in
   * every profile, wake started past the held record (takeover.ts); one at a time, a second click
   * joins the first. What it did, or why it stopped.
   */
  switchOver(): Promise<SwitchResult>
  /** Safeguard 3: started when on, not held and not answering (not again within a minute of its last start). */
  ensure(): Promise<void>
  /** The config was read again: started at once when it turned wake on. */
  configChanged(): void
  /** No more background questions (the server closes). */
  stop(): void
}

export interface WakeControlOptions {
  cfg: Config
  /** Wake's start; tests hand in a recorder. */
  starter: (args?: string[]) => void
  /** Wake's GET /status answer within 2 s, or null, for the panel's last Telegram error only (it waits on herdr); by default asked on 127.0.0.1 at the wake section's port. */
  status?: () => Promise<unknown>
  /**
   * Whether wake answers now; by default its GET /alive within 2 s on 127.0.0.1 at the wake
   * section's port (never waits on herdr; the old plugin's router has no /alive).
   */
  answers?: () => Promise<boolean>
  /** herdr, for closing wake's workspace once it is turned off (adapters/herdr.ts by default). */
  herdr?: Herdr
  now?: () => number
  /** Sessions asleep on the board (its last collected items); by default the session file's. */
  asleep?: () => number
  /** Wake's hooks in each shown profile, for the panel. */
  hooks?: () => WakeHooksView[]
  /** ~/.claude.json, where tg-mcp's url and token are by default. */
  claudeJson?: () => unknown
  /** The view changed: the board publishes it. */
  onChange?: () => void
  /** Wake's state changed from the last view's, or a Switch over ended: the board checks its setup again. */
  onState?: () => void
  log?: (text: string) => void
  /** How often a wake turned off is asked whether it ended (tests: a few ms). */
  pollMs?: number
  /** The pane board.json names, which closing wake's workspace never touches (adapters/wake-files.ts by default). */
  boardPane?: () => string | null
}

/** How long a view holds. */
const VIEW_MS = 2000
/** How long wake has to answer GET /alive or GET /status. */
const ANSWER_MS = 2000
const LOG_LINES = 200
const POLL_MS = 1000

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** GET /status on wake's port within 2 s, with what wake takes (Host 127.0.0.1:<port>, no Origin): its answer, or null. */
async function askWake(port: number): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(ANSWER_MS) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** ~/.claude.json, or null when there is none or it does not parse. */
function readClaudeJson(): unknown {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/** The real start: `bun src/entrypoints/wake-start.ts [...args]` on its own, never waited for. */
export function startWakeStart(args: string[] = []): void {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'entrypoints', 'wake-start.ts'), ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}

/**
 * Once wake ended: closes wake's workspace (its label: the section's `workspace`) when every pane in
 * it is wake's leftover (start.ts wakeLeftover: herdr-sidebar's, or no agent in the plugin's
 * folder), never the board's own (its label, board.json's pane, or this process's pane). Otherwise
 * only wake's recorded pane, while it is still wake's (start.ts recordedPane), with its tab when
 * nothing but sidebar panes is beside it; or nothing. What it closed.
 */
export async function closeWakeWorkspace(
  herdr: Herdr,
  settings: Pick<WakeConfig, 'workspace'>,
  place: { board: BoardPlace; root: string; wakePane: string | null },
): Promise<'workspace' | 'tab' | 'pane' | null> {
  const label = settings.workspace
  const boardsLabel = label === place.board.label
  if (boardsLabel && place.wakePane === null) return null
  const snap = asSnapshot(await herdr(['api', 'snapshot']))
  const ws = snap.workspaces.find(w => w.label === label)
  if (!ws) return null
  const own = process.env.HERDR_PANE_ID
  const boards = (id: string): boolean => id === place.board.pane || (!!own && id === own)
  const panes = snap.panes.filter(p => workspaceOf(snap, p) === ws.workspace_id)
  if (!boardsLabel && !panes.some(p => boards(p.pane_id)) && panes.every(p => wakeLeftover(p, place.root))) {
    await herdr(['workspace', 'close', ws.workspace_id])
    return 'workspace'
  }
  const wakes = recordedPane(snap, place.wakePane ?? undefined, label, place.board)
  if (!wakes || boards(wakes.pane_id)) return null
  const close = closeOfPane(snap, wakes)
  await herdr(close)
  return close[0] === 'tab' ? 'tab' : 'pane'
}

export function createWakeControl(o: WakeControlOptions): WakeControl {
  const now = o.now ?? Date.now
  const herdr = o.herdr ?? herdrCli
  const log = o.log ?? (() => {})
  const pollMs = o.pollMs ?? POLL_MS
  const settingsNow = (): WakeConfig => wakeConfig(o.cfg.wake)
  const status = o.status ?? (() => askWake(settingsNow().port))
  const answers = o.answers ?? (() => wakeAlive(settingsNow().port, ANSWER_MS))
  const answering = (): Promise<boolean> => answers().catch(() => false)
  const asleep =
    o.asleep ?? ((): number => Object.values(peekWakeSessions()).filter(s => s.slept_at !== undefined).length)

  /** The last view but for its sleepers' count, which follows the board's items at once. */
  let cache: { at: number; view: Omit<WakeView, 'asleep'> } | null = null
  /** The last view's state, kept when the cache is dropped: a change of it is told (onState). */
  let lastState: WakeState | null = null
  let computing: Promise<WakeView> | null = null
  let downSince: number | null = null
  let startedAt = Number.NEGATIVE_INFINITY
  let ensuring: Promise<void> | null = null
  let wasOn = settingsNow().enabled
  /** Each turn of the switch: a later one ends what an earlier one waits for. */
  let turns = 0
  /** Turned off, its workspace not closed yet. */
  let offPending = false
  let stopped = false
  let fileSeen: { file: string; mtimeMs: number; has: boolean } | null = null
  /** A Switch over under way. */
  let switching: Promise<SwitchResult> | null = null

  /** Whether wake's session file has a sleeper; read again only when it changed. */
  function fileHasSleepers(): boolean {
    const file = wakeSessionsFile()
    let mtimeMs: number | undefined
    try {
      mtimeMs = statSync(file, { throwIfNoEntry: false })?.mtimeMs
    } catch {}
    if (mtimeMs === undefined) return false
    if (fileSeen?.file !== file || fileSeen.mtimeMs !== mtimeMs)
      fileSeen = { file, mtimeMs, has: Object.values(peekWakeSessions(file)).some(s => s.slept_at !== undefined) }
    return fileSeen.has
  }
  const withAsleep = (view: Omit<WakeView, 'asleep'>): WakeView => ({ ...view, asleep: asleep() })
  /** The payload carries wake once it ships, while it is on, or while its file has sleepers. */
  const shown = (): boolean => WAKE_SHIPPED || settingsNow().enabled || fileHasSleepers()

  async function compute(): Promise<WakeView> {
    const s = settingsNow()
    const file = readWakeStatus()
    const up = s.enabled && file?.state !== 'held' ? await answering() : false
    const at = now()
    const state = wakeState({ on: s.enabled, status: file, answers: up, now: at })
    const down = state !== 'running' && state !== 'off' && state !== 'held'
    downSince = down ? (downSince ?? at) : null
    const error = down ? file?.error : undefined
    // The router's state as the wake process last wrote it: said only while that process answers.
    const telegram = state === 'running' ? file?.telegram : undefined
    const view: Omit<WakeView, 'asleep'> = {
      on: s.enabled,
      state,
      since: state === 'running' && file?.state === 'running' ? file.at : null,
      port: s.port,
      ...(error !== undefined && { error }),
      ...(state === 'crashed' && { crashes: file?.crashes?.length ?? 0 }),
      downSince,
      ...(telegram && { telegram }),
    }
    const before = cache ? JSON.stringify(cache.view) : null
    const moved = lastState !== null && lastState !== state
    cache = { at, view }
    lastState = state
    if (before !== JSON.stringify(view)) o.onChange?.()
    if (moved) o.onState?.()
    return withAsleep(view)
  }

  function view(): Promise<WakeView> {
    const at = now()
    if (cache && at - cache.at < VIEW_MS && at >= cache.at) return Promise.resolve(withAsleep(cache.view))
    computing ??= compute().finally(() => {
      computing = null
    })
    return computing
  }

  const refused = (): EditResult => ({ ok: false, error: t('err.wakeOff') })

  function starts(args?: string[]): EditResult {
    startedAt = now()
    cache = null
    try {
      o.starter(args)
      return { ok: true }
    } catch (err) {
      log(`wake's start: ${messageOf(err)}`)
      return { ok: false, error: messageOf(err) }
    }
  }

  /**
   * Wake's start unless it is held, a start is under way (its record says starting, for at most a
   * minute: herdr's startup entry, or an earlier Start), or it answers. Start again goes past this.
   */
  async function launch(): Promise<EditResult> {
    const file = readWakeStatus()
    if (file?.state === 'held') return { ok: false, error: t('wake.state.held') }
    if (wakeState({ on: true, status: file, answers: false, now: now() }) === 'starting') return { ok: true }
    if (await answering()) return { ok: true }
    return starts()
  }

  const pause = (ms: number): Promise<void> =>
    new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    })

  /** Once wake no longer answers (it drains first, up to its grace), `then`; unless the switch turns again meanwhile. */
  async function whenEnded(turn: number, then: () => Promise<unknown>): Promise<void> {
    const s = settingsNow()
    const deadline = now() + Math.max(180_000, s.wakeTimeoutSec * 1000 + 30_000) + 10_000
    while (!stopped && turn === turns) {
      if (!(await answering())) {
        if (!stopped && turn === turns) await then()
        return
      }
      if (now() > deadline) return
      await pause(pollMs)
    }
  }

  /** One at a time; not again within a minute of the last start (it may still be under way). */
  function ensure(): Promise<void> {
    ensuring ??= (async () => {
      if (!settingsNow().enabled || now() - startedAt < STARTING_MS) return
      await launch()
    })().finally(() => {
      ensuring = null
    })
    return ensuring
  }

  return {
    view,
    current() {
      if (!shown()) return null
      if (!cache || now() - cache.at >= VIEW_MS) view().catch(err => log(`wake's state: ${messageOf(err)}`))
      return cache ? withAsleep(cache.view) : null
    },
    async settings() {
      const s = settingsNow()
      const target = telegramTarget(s, (o.claudeJson ?? readClaudeJson)())
      const answer = s.enabled ? record(await status().catch(() => null)) : null
      return {
        reaper: s.reaper,
        telegram: s.telegram,
        found: target ? { host: target.host } : null,
        lastError: typeof answer?.lastError === 'string' ? answer.lastError : null,
        log: wakeLogFile(),
        hooks: o.hooks?.() ?? [],
      }
    },
    async turn(on) {
      const r = editWake({ on })
      if (!r.ok) return r
      const turn = ++turns
      cache = null
      wasOn = on
      if (on) {
        if (!offPending) return launch()
        // Turned on again while the last wake still drains: started once it has ended.
        offPending = false
        void whenEnded(turn, launch)
        return r
      }
      offPending = true
      const settings = settingsNow()
      void whenEnded(turn, async () => {
        offPending = false
        try {
          await closeWakeWorkspace(herdr, settings, {
            board: { label: o.cfg.workspace, pane: (o.boardPane ?? boardPaneNow)() },
            root: ROOT,
            wakePane: readWakeStatus()?.pane ?? null,
          })
        } catch (err) {
          log(`closing wake's workspace: ${messageOf(err)}`)
        }
      })
      return r
    },
    async start() {
      return settingsNow().enabled ? launch() : refused()
    },
    async again() {
      return settingsNow().enabled ? starts(['--again']) : refused()
    },
    logTail: () => wakeLogTail(LOG_LINES),
    switchOver() {
      switching ??= takeOver({
        uninstall: true,
        herdr,
        home: homedir(),
        env: process.env,
        log: text => {
          wakeLog(`switch over: ${text}`)
          log(text)
        },
        // Its record says held until wake's start reads the plugin list again: started past it.
        start: () => starts(),
      })
        .catch((err): SwitchResult => ({ ok: false, error: messageOf(err) }))
        .finally(() => {
          switching = null
          cache = null
          o.onChange?.()
          o.onState?.()
        })
      return switching
    },
    ensure,
    configChanged() {
      const on = settingsNow().enabled
      // A view taken with the switch as it was (a refresh between the panel's On and the board
      // reading config.json again) is asked again, not kept until it ages.
      if (on !== wasOn || (cache && cache.view.on !== on)) cache = null
      const turnedOn = on && !wasOn
      wasOn = on
      if (turnedOn) void ensure()
    },
    stop() {
      stopped = true
    },
  }
}
