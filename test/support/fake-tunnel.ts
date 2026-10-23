// The tunnel supervisor's fakes (services/tunnel.ts): a clock that moves only when told, ssh
// children in memory, and a supervisor over them with a pid record in memory, a network signature
// to change, a probe through the domain, a key check and a probe-only listener, each to set.
import { join } from 'node:path'
import type { PidRecord, SshChild } from '../../src/adapters/ssh.ts'
import {
  forwardSpec,
  type ProbeResult,
  sshArgs,
  TUNNEL_SOCKET,
  type TunnelHint,
  tunnelConfig,
} from '../../src/core/tunnel.ts'
import { type Clock, createProbes, createSupervisor, type TunnelPlan } from '../../src/services/tunnel.ts'

/** Every promise that can go on now has gone on. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
}

interface Timer {
  at: number
  every: number | null
  fn: () => void
}

/**
 * A clock whose time moves only by advance(), which runs the timers due in order, or by jump(),
 * which runs none: the computer slept.
 */
export function fakeClock(start = 1_760_000_000_000) {
  let now = start
  let last = 0
  const timers = new Map<number, Timer>()
  const add = (fn: () => void, ms: number, every: number | null): number => {
    last += 1
    timers.set(last, { at: now + ms, every, fn })
    return last
  }
  const remove = (h: unknown): void => {
    timers.delete(h as number)
  }
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: remove,
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: remove,
  }
  return {
    clock,
    now: () => now,
    /** Timers and intervals set and not cleared. */
    pending: () => timers.size,
    jump(ms: number): void {
      now += ms
    },
    async advance(ms: number): Promise<void> {
      const end = now + ms
      for (;;) {
        await settle()
        let due: [number, Timer] | undefined
        for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry
        if (!due) break
        const [id, timer] = due
        now = Math.max(now, timer.at)
        if (timer.every === null) timers.delete(id)
        else timer.at = now + timer.every
        timer.fn()
      }
      now = Math.max(now, end)
      await settle()
    },
  }
}

export type FakeChild = SshChild & {
  /** ssh prints these lines. */
  line(...texts: string[]): void
  /** ssh exits by itself. */
  exit(code?: number | null): void
  kills: number
  nowKills: number
  /** kill() leaves it running until exit(): its tree takes a while to end. */
  slow: boolean
  gone(): boolean
}

/** An ssh in memory: `exited` resolves on exit(), or on kill() unless it is slow. */
export function fakeChild(pid: number, error: string | null): FakeChild {
  const listeners: ((line: string) => void)[] = []
  let done = false
  let resolve: (r: { code: number | null; error: string | null }) => void = () => {}
  const exited = new Promise<{ code: number | null; error: string | null }>(r => {
    resolve = r
  })
  const finish = (code: number | null, why: string | null): void => {
    if (done) return
    done = true
    resolve({ code, error: why })
  }
  const child: FakeChild = {
    pid,
    exited,
    onLine: fn => listeners.push(fn),
    line: (...texts) => {
      for (const text of texts) for (const fn of listeners) fn(text)
    },
    exit: (code = 255) => finish(code, null),
    kills: 0,
    nowKills: 0,
    slow: false,
    gone: () => done,
    kill() {
      child.kills += 1
      if (!child.slow) finish(null, null)
    },
    killNow() {
      child.nowKills += 1
    },
  }
  if (error) finish(null, error)
  return child
}

export const conf = tunnelConfig({
  on: true,
  host: 'ssh.example.com',
  user: 'boardtunnel',
  domain: 'board.example.com',
})
export const SSH = 'C:/Windows/System32/OpenSSH/ssh.exe'

export function planTo(target: number, bin = SSH, folder = 'C:/state/tunnel'): TunnelPlan {
  return {
    conf,
    bin,
    args: sshArgs({ conf, key: join(folder, 'id_ed25519'), knownHosts: join(folder, 'known_hosts'), target }),
    forward: forwardSpec(conf.socket, target),
  }
}

/** ssh -v's line once the server took the forward (the spike's). */
export const success = (target = 12424): string =>
  `debug1: remote forward success for: listen ${TUNNEL_SOCKET}:-2, connect 127.0.0.1:${target}`
/** What a good connection prints without `debug1:` (the spike's): no error. */
export const HEALTHY = [
  'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2',
  "Warning: Permanently added 'ssh.example.com' (ED25519) to the list of known hosts.",
  'Authenticated to ssh.example.com ([203.0.113.5]:22) using "publickey".',
]

/** The probe-only listener as a Test opened it. */
export interface FakeListener {
  nonce: string
  port: number
  /** close() calls. */
  closed: number
}

type KeyCheck = { ok: true } | { ok: false; error: string; hint: TunnelHint | null }

/** A supervisor over a fake clock and fake ssh children, every other dep in `w` to set. */
export function world() {
  const time = fakeClock()
  const w = {
    time,
    plan: planTo(12424) as TunnelPlan | null,
    record: null as PidRecord | null,
    /** stray.end: true once no ssh of ours runs under the recorded pid. */
    strayEnd: (async () => true) as (r: PidRecord) => Promise<boolean>,
    net: 'eth0 192.168.1.20',
    /** The next spawn fails so (pid 0). */
    spawnError: null as string | null,
    changes: 0,
    spawns: [] as { bin: string; args: string[]; child: FakeChild }[],
    /** stray.end's calls, with how many ssh had started by then. */
    ended: [] as { record: PidRecord; spawnsBefore: number }[],
    probes: createProbes(time.now),
    /** The probe through the domain: each nonce asked, and the answer. */
    probed: [] as string[],
    probeWith: (async () => ({ ok: true })) as (nonce: string, port?: number) => Promise<ProbeResult>,
    /** How many arguments each probe was given, and the port when there was one. */
    probeArgs: [] as unknown[][],
    /** sshFound(). */
    sshPath: SSH as string | null,
    keyCheck: { ok: true } as KeyCheck,
    keyChecks: 0,
    /** testPlan() answers null: the settings do not check out. */
    settingsBroken: false,
    /** The probe-only listeners opened, in order. */
    listeners: [] as FakeListener[],
    listen: null as ((nonce: string) => Promise<{ port: number; close(): void }>) | null,
  }
  let pid = 5000
  const sup = createSupervisor({
    plan: () => w.plan,
    spawn: (bin, args) => {
      const child = fakeChild(w.spawnError ? 0 : ++pid, w.spawnError)
      w.spawns.push({ bin, args, child })
      return child
    },
    stray: {
      read: () => w.record,
      write: r => {
        w.record = r
      },
      end: r => {
        w.ended.push({ record: r, spawnsBefore: w.spawns.length })
        return w.strayEnd(r)
      },
    },
    clock: time.clock,
    network: () => w.net,
    random: () => 0.5,
    onChange: () => {
      w.changes += 1
    },
    log: () => {},
    probes: w.probes,
    probe: (...args: [string, number?]) => {
      w.probed.push(args[0])
      w.probeArgs.push(args)
      return w.probeWith(...args)
    },
    testPlan: target => (w.settingsBroken ? null : planTo(target)),
    checkKey: async () => {
      w.keyChecks += 1
      return w.keyCheck
    },
    sshFound: () => w.sshPath,
    openProbeListener: async nonce => {
      if (w.listen) return w.listen(nonce)
      const l: FakeListener = { nonce, port: 40_001 + w.listeners.length, closed: 0 }
      w.listeners.push(l)
      return {
        port: l.port,
        close: () => {
          l.closed += 1
        },
      }
    },
  })
  /** The ssh started last. */
  const child = (): FakeChild => {
    const last = w.spawns.at(-1)
    if (!last) throw new Error('no ssh started')
    return last.child
  }
  /** The current ssh exits by itself: the wait before the next one, which is then waited out. */
  const failAndWait = async (...lines: string[]): Promise<number> => {
    child().line(...lines)
    child().exit(255)
    await time.advance(0)
    const wait = (sup.status().nextAt ?? Number.NaN) - time.now()
    await time.advance(wait)
    return wait
  }
  return Object.assign(w, { sup, child, failAndWait })
}
