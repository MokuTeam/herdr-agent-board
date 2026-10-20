// The tunnel's ssh, kept up (spec, "The tunnel on the PC": Status, Coming back, Board restarts and
// overlap): started while there is a plan, ended when it goes; after an exit nobody asked for,
// started again with a backoff (lasting errors every 60 s); at once after the computer slept or
// its addresses changed. Its pid is recorded so that the next board can end it should this one
// die without doing so, and a recorded one is ended before a start. Never two at a time: a new
// ssh starts only once the one before has exited, and none while a recorded one may still run.
// While connected, the board's own probe through the domain now and then (a failure is a warning,
// never a restart); and Test connection, step by step, with an ssh of its own only while the
// tunnel is off (the same rules: one at a time with the tunnel's, recorded, never beside a stray).
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { PidRecord, SshChild } from '../adapters/ssh.ts'
import {
  backoffMs,
  forwardAccepted,
  isLasting,
  type ProbeResult,
  type StepHint,
  sshHint,
  type TestStep,
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

/** The nonces the board's probe answers (`GET /api/probe/<nonce>`): each one issued, for a while. */
export interface Probes {
  issue(): string
  answers(nonce: string): boolean
}

/** How long a nonce is answered. */
const NONCE_LIVES_MS = 60_000

/** Nonces of 16 random bytes in hex, each answered for 60 s. */
export function createProbes(now: () => number = Date.now): Probes {
  const issued = new Map<string, number>()
  const live = (at: number): boolean => now() - at < NONCE_LIVES_MS
  return {
    issue() {
      for (const [nonce, at] of issued) if (!live(at)) issued.delete(nonce)
      const nonce = randomBytes(16).toString('hex')
      issued.set(nonce, now())
      return nonce
    },
    answers(nonce) {
      const at = issued.get(nonce)
      return at !== undefined && live(at)
    },
  }
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
  /** The nonces the probe answers, shared with the tunnel listener. */
  probes: Probes
  /** The board's probe through the domain (adapters/probe.ts). */
  probe(nonce: string): Promise<ProbeResult>
  /** Test's line: the tunnel's, forwarded to `target`; null when the settings do not check out. */
  testPlan(target: number): TunnelPlan | null
  /** The key exists and ssh would take it (its rights, no passphrase). */
  checkKey(): Promise<{ ok: true } | { ok: false; error: string; hint: TunnelHint | null }>
  /** The ssh binary; null: none found. */
  sshFound(): string | null
  /** Test's probe-only listener (server/tunnel-probe.ts). */
  openProbeListener(nonce: string): Promise<{ port: number; close(): void }>
}

export interface Supervisor {
  sync(): Promise<void>
  status(): TunnelStatus
  /** ssh runs (held by the supervisor). */
  running(): boolean
  /** Test connection: ssh, the forward, the domain. One at a time: a second call gets the running one. */
  test(): Promise<TestStep[]>
  /** For an exit handler: the current ssh (and a running Test's) ended synchronously. */
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
/** The probe through the domain: this long after connecting, then this often while connected. */
const PROBE_FIRST_MS = 3000
const PROBE_EVERY_MS = 5 * 60_000
/** How long Test waits for the server to take its forward. */
const FORWARD_WAIT_MS = 25_000
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

/** Keeps the line in `lines` (oldest first, LINES_KEPT at most) if it may say what went wrong. */
function keep(lines: string[], line: string): void {
  if (!worthKeeping(line)) return
  lines.push(line)
  if (lines.length > LINES_KEPT) lines.shift()
}

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

type Exit = { code: number | null; error: string | null }

/** What an ssh's exit says: its last lines and their hint; noSsh when it could not start. */
function exitError(bin: string, lines: readonly string[], r: Exit): { error: string; hint: TunnelHint | null } {
  if (r.error) return { error: `${bin}: ${r.error}`, hint: 'noSsh' }
  const error = errorText(lines) || (r.code === null ? 'ssh was ended' : `ssh exited with code ${r.code}`)
  return { error, hint: sshHint(lines) }
}

const sameLine = (a: TunnelPlan, b: TunnelPlan): boolean =>
  a.bin === b.bin && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i])
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** One step of Test connection: ✓ (true), ✗ (false) or not run (null). */
const testStep = (id: TestStep['id'], ok: boolean | null, detail = '', hint: StepHint | null = null): TestStep => ({
  id,
  ok,
  detail,
  hint,
})
/** A step not run, an earlier one having failed. */
const notRun = (id: TestStep['id']): TestStep => testStep(id, null)

/** Step 3 from what the probe through the domain met. */
function domainStep(r: ProbeResult, domain: string): TestStep {
  if (r.ok) return testStep('domain', true, domain)
  const hint: StepHint | null = r.kind === 'status' ? (r.status === 502 ? 'caddy502' : null) : r.kind
  return testStep('domain', false, r.detail, hint)
}

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
  let probeTimer: unknown = null
  let closed = false
  let queue: Promise<void> = Promise.resolve()
  /** The Test that runs, and its own ssh while that runs. */
  let testing: Promise<TestStep[]> | null = null
  let testChild: SshChild | null = null

  const set = (next: TunnelStatus): void => {
    status = next
    d.onChange()
  }

  /** One at a time: a job waits for the one before; the next one runs whatever this one did. */
  function exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** One at a time, a failure logged, never thrown. */
  function serially(job: () => Promise<void>): Promise<void> {
    return exclusive(() => job().catch(err => d.log(`tunnel: ${messageOf(err)}`)))
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

  /** d.probe, a throw read as no answer. */
  async function probeDomain(nonce: string): Promise<ProbeResult> {
    try {
      return await d.probe(nonce)
    } catch (err) {
      return { ok: false, kind: 'network', detail: messageOf(err) }
    }
  }

  function probeOff(): void {
    if (probeTimer === null) return
    clock.clearTimeout(probeTimer)
    probeTimer = null
  }

  /** The probe through the domain in `ms`, while `h` holds the forward. */
  function probeIn(h: Held, ms: number): void {
    probeOff()
    probeTimer = clock.setTimeout(() => {
      probeTimer = null
      void probeNow(h)
    }, ms)
  }

  /**
   * A forward on the same path replaces this one (StreamLocalBindUnlink), so the domain may no
   * longer reach this board while ssh runs: a failure is a warning in the status, and ssh is never
   * restarted over it (a failure on the PC's own side would drop the tablet's streams each time).
   */
  async function probeNow(h: Held): Promise<void> {
    const r = await probeDomain(d.probes.issue())
    if (held !== h || h.asked || status.state !== 'connected') return
    if (!r.ok) d.log(`tunnel: the probe through the domain did not reach this board: ${r.detail}`)
    set({ ...status, probe: { ok: r.ok, at: clock.now(), detail: r.ok ? '' : r.detail } })
    probeIn(h, PROBE_EVERY_MS)
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

  const strayError = (r: PidRecord): string =>
    `an ssh a board before left (pid ${r.pid}) may still run; it must end first`

  /** Ends the held ssh with its tree and waits for its exit. */
  async function end(h: Held): Promise<void> {
    h.asked = true
    probeOff()
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
      return later(strayError(stray), null)
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
      probeIn(h, PROBE_FIRST_MS)
      return
    }
    keep(h.lines, line)
  }

  /** An exit nobody asked for: reconnecting after a backoff, or an error tried again in 60 s. */
  function exited(h: Held, r: Exit): void {
    if (h.asked || held !== h) return
    held = null
    probeOff()
    record(null)
    if (closed) return
    const now = clock.now()
    if (h.connectedAt !== null && now - h.connectedAt >= UP_RESETS_MS) attempt = 1
    const { error, hint } = exitError(h.plan.bin, h.lines, r)
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

  /** Step 1: ssh is found, and the key is there and would be taken. */
  async function sshStep(): Promise<TestStep> {
    const bin = d.sshFound()
    if (!bin) return testStep('ssh', false, 'ssh not found', 'noSsh')
    try {
      const key = await d.checkKey()
      return key.ok ? testStep('ssh', true, bin) : testStep('ssh', false, key.error, key.hint)
    } catch (err) {
      return testStep('ssh', false, messageOf(err))
    }
  }

  /** Steps 2 and 3 while the tunnel is on: its own state, and the probe only while connected. */
  async function tunnelSteps(): Promise<TestStep[]> {
    if (!held || status.state !== 'connected')
      return [
        testStep('forward', false, status.error ?? `the tunnel is ${status.state}`, status.hint ?? null),
        testStep('domain', null, '', 'notConnected'),
      ]
    const { plan } = held
    return [testStep('forward', true, plan.forward), domainStep(await probeDomain(d.probes.issue()), plan.conf.domain)]
  }

  /** The Test's own ssh until the server takes its forward (✓), it exits, or FORWARD_WAIT_MS pass. */
  function forwardStep(child: SshChild, plan: TunnelPlan): Promise<TestStep> {
    return new Promise(resolve => {
      const lines: string[] = []
      let done = false
      const finish = (s: TestStep): void => {
        if (done) return
        done = true
        clock.clearTimeout(timer)
        resolve(s)
      }
      const timer = clock.setTimeout(() => finish(testStep('forward', false, 'timed out', 'network')), FORWARD_WAIT_MS)
      child.onLine(line => {
        if (done) return
        if (forwardAccepted(line, plan.conf.socket)) finish(testStep('forward', true, plan.forward))
        else keep(lines, line)
      })
      void child.exited.then(r => {
        const { error, hint } = exitError(plan.bin, lines, r)
        finish(testStep('forward', false, error, hint))
      })
    })
  }

  /**
   * Steps 2 and 3 while the tunnel is off: an ssh of its own with the same line, forwarded to a
   * probe-only listener, up until the domain is probed through it. Both ended afterwards, whatever
   * happened. Run one at a time with the tunnel's own work (never two ssh on the socket); null
   * when the tunnel has an ssh after all, or the supervisor closed.
   */
  async function ownSteps(): Promise<TestStep[] | null> {
    if (closed || held || d.plan()) return null
    const nonce = d.probes.issue()
    const listener = await d.openProbeListener(nonce)
    try {
      const plan = d.testPlan(listener.port)
      if (!plan) return [testStep('forward', false, 'the settings do not check out'), notRun('domain')]
      const stray = await endStray()
      if (stray) return [testStep('forward', false, strayError(stray)), notRun('domain')]
      const child = d.spawn(plan.bin, plan.args)
      testChild = child
      if (child.pid > 0) record({ pid: child.pid, forward: plan.forward, at: clock.now() })
      d.log(`tunnel: Test connection: ssh started (pid ${child.pid})`)
      try {
        const forward = await forwardStep(child, plan)
        if (!forward.ok) return [forward, notRun('domain')]
        return [forward, domainStep(await probeDomain(nonce), plan.conf.domain)]
      } finally {
        child.kill()
        await child.exited
        testChild = null
        record(null)
      }
    } finally {
      listener.close()
    }
  }

  async function runTest(): Promise<TestStep[]> {
    const ssh = await sshStep()
    if (!ssh.ok) return [ssh, notRun('forward'), notRun('domain')]
    const own = d.plan()
      ? null
      : await exclusive(ownSteps).catch((err: unknown) => [
          testStep('forward', false, messageOf(err)),
          notRun('domain'),
        ])
    return [ssh, ...(own ?? (await tunnelSteps()))]
  }

  return {
    sync,
    status: () => ({ ...status }),
    running: () => held !== null,
    test() {
      testing ??= runTest().finally(() => {
        testing = null
      })
      return testing
    },
    killNow() {
      held?.child.killNow()
      testChild?.killNow()
    },
    close() {
      closed = true
      testChild?.kill()
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
