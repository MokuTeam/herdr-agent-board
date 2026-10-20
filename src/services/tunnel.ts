// The tunnel's ssh, kept up (spec, "The tunnel on the PC": Status, Coming back, Board restarts and
// overlap): started while there is a plan, ended when it goes; after an exit nobody asked for,
// started again with a backoff (lasting errors every 60 s); at once after the computer slept or
// its addresses changed. Its pid is recorded so that the next board can end it should this one
// die without doing so, and a recorded one is ended before a start. Never two at a time: a new
// ssh starts only once the one before has exited, and none while a recorded one may still run.
import { networkInterfaces } from 'node:os'
import type { PidRecord, SshChild } from '../adapters/ssh.ts'
import {
  backoffMs,
  forwardAccepted,
  isLasting,
  sshHint,
  type TunnelConfig,
  type TunnelHint,
  type TunnelStatus,
} from '../core/tunnel.ts'

/** What to run: the settings, the ssh binary, its whole argument list, and `-R`'s value. */
export interface TunnelPlan {
  conf: TunnelConfig
  bin: string
  args: string[]
  forward: string
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(h: unknown): void
}

type Handle = ReturnType<typeof setTimeout>

/** The computer's clock; its timers keep no process alive. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: h => clearTimeout(h as Handle),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: h => clearInterval(h as Handle),
}

export interface SupervisorDeps {
  /** What to run now; null: no tunnel (off, a problem, no login set up, the listener not listening). */
  plan(): TunnelPlan | null
  spawn(bin: string, args: string[]): SshChild
  /**
   * The pid record (adapters/ssh.ts), and ending the ssh it names. `end`: true once no ssh of ours
   * runs under its pid (gone, or another program's); false while ours may still run (it outlived
   * its kill, or what runs under the pid could not be read).
   */
  stray: { read(): PidRecord | null; write(r: PidRecord | null): void; end(r: PidRecord): Promise<boolean> }
  clock: Clock
  /** A signature of this computer's addresses (os.networkInterfaces(), non-internal, sorted). */
  network(): string
  random?: () => number
  onChange(): void
  log(text: string): void
}

export interface Supervisor {
  sync(): Promise<void>
  status(): TunnelStatus
  /** ssh runs (held by the supervisor). */
  running(): boolean
  /** For an exit handler: the current ssh ended synchronously. */
  killNow(): void
  close(): Promise<void>
}

/** Up this long, counted from the server taking the forward: the backoff starts over. */
const UP_RESETS_MS = 60_000
/** A lasting error (isLasting) is tried again this often. */
const LASTING_RETRY_MS = 60_000
/** The sleep watch: a tick this often; a gap longer than SLEPT_MS means the computer slept. */
const TICK_MS = 5000
const SLEPT_MS = 30_000
const NETWORK_POLL_MS = 10_000
/** ssh's last lines kept for the error text, and how long that text may be. */
const LINES_KEPT = 20
const ERROR_CHARS = 400

/**
 * What a good connection prints without `debug1:` (the spike, in the spec's "Checked by the
 * spike"): the version banner, the known-hosts warning on the first connection, `Authenticated to …`.
 */
const HEALTHY = [
  /^OpenSSH_/,
  /^Warning: Permanently added .* to the list of known hosts\.$/,
  /^Authenticated to .* using "[^"]*"\.$/,
]
/** A line that may say what went wrong: not ssh -v's own, nor a good connection's. */
const worthKeeping = (line: string): boolean => !line.startsWith('debug') && !HEALTHY.some(re => re.test(line))

/** As many of the last lines as fit in ERROR_CHARS, whole; else the last one, cut. */
function errorText(lines: readonly string[]): string {
  let text = ''
  for (const line of [...lines].reverse()) {
    const longer = text ? `${line}\n${text}` : line
    if (longer.length > ERROR_CHARS) return text || longer.slice(0, ERROR_CHARS)
    text = longer
  }
  return text
}

const sameLine = (a: TunnelPlan, b: TunnelPlan): boolean =>
  a.bin === b.bin && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i])
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The ssh the supervisor holds. */
interface Held {
  child: SshChild
  plan: TunnelPlan
  /** When the server took the forward; null before. */
  connectedAt: number | null
  /** Its last lines worth keeping, oldest first. */
  lines: string[]
  /** The supervisor ended it: its exit is no failure. */
  asked: boolean
}

export function createSupervisor(d: SupervisorDeps): Supervisor {
  const { clock } = d
  let status: TunnelStatus = { state: 'off', since: clock.now() }
  let held: Held | null = null
  /** The plan last started: a retry waits out its backoff unless the line changed since. */
  let lastPlan: TunnelPlan | null = null
  let attempt = 1
  let retry: unknown = null
  let watch: { tick: unknown; poll: unknown } | null = null
  let lastTick = 0
  let lastNetwork = ''
  let closed = false
  let queue: Promise<void> = Promise.resolve()

  const set = (next: TunnelStatus): void => {
    status = next
    d.onChange()
  }

  /** One at a time: a job waits for the one before. A failure is logged, never thrown. */
  function serially(job: () => Promise<void>): Promise<void> {
    const next = queue.then(() => job().catch(err => d.log(`tunnel: ${messageOf(err)}`)))
    queue = next
    return next
  }

  function record(r: PidRecord | null): void {
    try {
      d.stray.write(r)
    } catch (err) {
      d.log(`tunnel: the pid record: ${messageOf(err)}`)
    }
  }

  function cancelRetry(): void {
    if (retry === null) return
    clock.clearTimeout(retry)
    retry = null
  }

  function retryIn(ms: number): void {
    cancelRetry()
    retry = clock.setTimeout(() => {
      retry = null
      void sync()
    }, ms)
  }

  /** ssh again at once, whatever runs or waits now. */
  function restart(why: string): void {
    d.log(`tunnel: ${why}: starting ssh again`)
    void serially(() => step(true))
  }

  /** The sleep tick and the network poll, while there is a plan. */
  function watchOn(): void {
    if (watch) return
    lastTick = clock.now()
    lastNetwork = d.network()
    watch = {
      tick: clock.setInterval(() => {
        const now = clock.now()
        const gap = now - lastTick
        lastTick = now
        if (gap > SLEPT_MS) restart(`${Math.round(gap / 1000)} s between two ticks (the computer slept)`)
      }, TICK_MS),
      poll: clock.setInterval(() => {
        const now = d.network()
        if (now === lastNetwork) return
        lastNetwork = now
        restart("this computer's addresses changed")
      }, NETWORK_POLL_MS),
    }
  }

  function watchOff(): void {
    if (!watch) return
    clock.clearInterval(watch.tick)
    clock.clearInterval(watch.poll)
    watch = null
  }

  /**
   * An ssh a board before this one left (the record), ended if it still runs. Null once none of
   * ours runs under the recorded pid: the record cleared. The record, kept to be tried again, when
   * ours may still run (it outlived its kill, or what runs under the pid could not be read).
   */
  async function endStray(): Promise<PidRecord | null> {
    const r = d.stray.read()
    if (!r) return null
    const gone = await d.stray.end(r).catch((err: unknown) => {
      d.log(`tunnel: ending the recorded pid ${r.pid}: ${messageOf(err)}`)
      return false
    })
    if (!gone) {
      d.log(`tunnel: the ssh a board before left (pid ${r.pid}) may still run: its record kept`)
      return r
    }
    d.log(`tunnel: no ssh a board before left runs any more (pid ${r.pid})`)
    record(null)
    return null
  }

  /** Ends the held ssh with its tree and waits for its exit. */
  async function end(h: Held): Promise<void> {
    h.asked = true
    h.child.kill()
    await h.child.exited
    if (held === h) held = null
    record(null)
  }

  async function start(plan: TunnelPlan): Promise<void> {
    lastPlan = plan
    const stray = await endStray()
    if (stray) {
      // Never two: no ssh while that one may still run; tried again after the backoff.
      d.log('tunnel: no ssh started')
      return later(`an ssh a board before left (pid ${stray.pid}) may still run; it must end first`, null)
    }
    const child = d.spawn(plan.bin, plan.args)
    const h: Held = { child, plan, connectedAt: null, lines: [], asked: false }
    held = h
    const now = clock.now()
    if (child.pid > 0) record({ pid: child.pid, forward: plan.forward, at: now })
    d.log(`tunnel: ssh started (pid ${child.pid})`)
    set({ state: 'connecting', since: now })
    child.onLine(line => heard(h, line))
    void child.exited.then(r => exited(h, r))
  }

  function heard(h: Held, line: string): void {
    if (h.asked || held !== h) return
    if (h.connectedAt === null && forwardAccepted(line, h.plan.conf.socket)) {
      h.connectedAt = clock.now()
      d.log('tunnel: connected')
      set({ state: 'connected', since: h.connectedAt })
      return
    }
    if (!worthKeeping(line)) return
    h.lines.push(line)
    if (h.lines.length > LINES_KEPT) h.lines.shift()
  }

  /** An exit nobody asked for: reconnecting after a backoff, or an error tried again in 60 s. */
  function exited(h: Held, r: { code: number | null; error: string | null }): void {
    if (h.asked || held !== h) return
    held = null
    record(null)
    if (closed) return
    const now = clock.now()
    if (h.connectedAt !== null && now - h.connectedAt >= UP_RESETS_MS) attempt = 1
    const hint: TunnelHint | null = r.error ? 'noSsh' : sshHint(h.lines)
    const error = r.error
      ? `${h.plan.bin}: ${r.error}`
      : errorText(h.lines) || (r.code === null ? 'ssh was ended' : `ssh exited with code ${r.code}`)
    d.log(`tunnel: ssh exited (${r.error ?? `code ${String(r.code)}`}): ${error.split('\n').at(-1)}`)
    later(error, hint)
  }

  /** Tried again: in 60 s for a lasting error (`error`), else after the backoff (`reconnecting`). */
  function later(error: string, hint: TunnelHint | null): void {
    const now = clock.now()
    if (isLasting(hint)) {
      set({ state: 'error', since: now, error, hint, nextAt: now + LASTING_RETRY_MS })
      retryIn(LASTING_RETRY_MS)
      return
    }
    const wait = backoffMs(attempt, d.random)
    set({ state: 'reconnecting', since: now, attempt, nextAt: now + wait, error, hint })
    attempt += 1
    retryIn(wait)
  }

  /** No plan: no ssh, no retry, no watch, no record; off. */
  async function stopAll(): Promise<void> {
    watchOff()
    cancelRetry()
    attempt = 1
    lastPlan = null
    if (held) await end(held)
    else await endStray()
    if (status.state !== 'off') set({ state: 'off', since: clock.now() })
  }

  /**
   * Brings ssh in line with the plan. `force` (sleep, network change): started again at once,
   * whatever runs or waits now.
   */
  async function step(force: boolean): Promise<void> {
    const plan = closed ? null : d.plan()
    if (!plan) return stopAll()
    watchOn()
    const same = lastPlan !== null && sameLine(lastPlan, plan)
    if (!force && same && (held || retry !== null)) return
    cancelRetry()
    if (force || !same) attempt = 1
    if (held) await end(held)
    await start(plan)
  }

  function sync(): Promise<void> {
    return serially(() => step(false))
  }

  return {
    sync,
    status: () => ({ ...status }),
    running: () => held !== null,
    killNow() {
      held?.child.killNow()
    },
    close() {
      closed = true
      return sync()
    },
  }
}

/** The production network(): this computer's own addresses (not loopback), sorted; '' if unreadable. */
export function networkSignature(): string {
  try {
    const found: string[] = []
    for (const [name, addresses] of Object.entries(networkInterfaces()))
      for (const a of addresses ?? []) if (!a.internal) found.push(`${name} ${a.address}`)
    return found.sort().join(', ')
  } catch {
    return ''
  }
}
