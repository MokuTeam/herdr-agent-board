import { expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import {
  endStraySsh,
  type PidRecord,
  readPidRecord,
  type SshChild,
  spawnSsh,
  writePidRecord,
} from '../../src/adapters/ssh.ts'
import { forwardSpec, sshArgs, TUNNEL_SOCKET, type TunnelState, tunnelConfig } from '../../src/core/tunnel.ts'
import {
  type Clock,
  createSupervisor,
  networkSignature,
  realClock,
  type TunnelPlan,
} from '../../src/services/tunnel.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'
import { until } from '../support/sandbox.ts'

// The last test runs the compiled fake ssh, and PowerShell reads a stray's command line.
setDefaultTimeout(60_000)

/** Every promise that can go on now has gone on. */
async function settle(): Promise<void> {
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
function fakeClock(start = 1_760_000_000_000) {
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

type FakeChild = SshChild & {
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
function fakeChild(pid: number, error: string | null): FakeChild {
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

const conf = tunnelConfig({ on: true, host: 'ssh.example.com', user: 'boardtunnel', domain: 'board.example.com' })

function planTo(target: number, bin = 'C:/Windows/System32/OpenSSH/ssh.exe', folder = 'C:/state/tunnel'): TunnelPlan {
  return {
    conf,
    bin,
    args: sshArgs({ conf, key: join(folder, 'id_ed25519'), knownHosts: join(folder, 'known_hosts'), target }),
    forward: forwardSpec(conf.socket, target),
  }
}

/** ssh -v's line once the server took the forward (the spike's). */
const success = (target = 12424): string =>
  `debug1: remote forward success for: listen ${TUNNEL_SOCKET}:-2, connect 127.0.0.1:${target}`
/** What a good connection prints without `debug1:` (the spike's): no error. */
const HEALTHY = [
  'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2',
  "Warning: Permanently added 'ssh.example.com' (ED25519) to the list of known hosts.",
  'Authenticated to ssh.example.com ([203.0.113.5]:22) using "publickey".',
]
const TIMED_OUT = 'ssh: connect to host ssh.example.com port 22: Connection timed out'

/** A supervisor over a fake clock, fake ssh children, a record in memory and a network signature to change. */
function world() {
  const time = fakeClock()
  const w = {
    time,
    plan: planTo(12424) as TunnelPlan | null,
    record: null as PidRecord | null,
    /** What stray.end answers. */
    strayEnded: true,
    net: 'eth0 192.168.1.20',
    /** The next spawn fails so (pid 0). */
    spawnError: null as string | null,
    changes: 0,
    spawns: [] as { bin: string; args: string[]; child: FakeChild }[],
    /** stray.end's calls, with how many ssh had started by then. */
    ended: [] as { record: PidRecord; spawnsBefore: number }[],
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
      end: async r => {
        w.ended.push({ record: r, spawnsBefore: w.spawns.length })
        return w.strayEnded
      },
    },
    clock: time.clock,
    network: () => w.net,
    random: () => 0.5,
    onChange: () => {
      w.changes += 1
    },
    log: () => {},
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

test('connect: one ssh with the plan’s line, connecting, then connected on the success line; its pid recorded', async () => {
  const w = world()
  const start = w.time.now()
  await w.sup.sync()
  const plan = planTo(12424)
  expect(w.spawns.map(s => [s.bin, s.args])).toEqual([[plan.bin, plan.args]])
  expect(w.sup.status()).toEqual({ state: 'connecting', since: start })
  expect(w.sup.running()).toBe(true)
  expect(w.record).toEqual({ pid: w.child().pid, forward: plan.forward, at: start })
  const changes = w.changes
  expect(changes).toBeGreaterThan(0)

  await w.time.advance(1500)
  // Another socket's forward is not this one's.
  w.child().line(...HEALTHY, success().replace(TUNNEL_SOCKET, `${TUNNEL_SOCKET}2`))
  expect(w.sup.status().state).toBe('connecting')
  w.child().line(success(), 'debug1: forwarding_success: all expected forwarding replies received')
  expect(w.sup.status()).toEqual({ state: 'connected', since: start + 1500 })
  expect(w.changes).toBe(changes + 1)
  expect(w.spawns).toHaveLength(1)
})

test('an ssh that keeps exiting starts again after 1, 2, 4 … 60 s: reconnecting with the attempt, the next try and the error', async () => {
  const w = world()
  await w.sup.sync()
  const waits: number[] = []
  for (let attempt = 1; attempt <= 8; attempt++) {
    w.child().line(...HEALTHY.slice(0, 1), TIMED_OUT)
    w.child().exit(255)
    await w.time.advance(0)
    const at = w.time.now()
    const status = w.sup.status()
    expect(status).toEqual({
      state: 'reconnecting',
      since: at,
      attempt,
      nextAt: status.nextAt ?? Number.NaN,
      error: TIMED_OUT,
      hint: 'network',
    })
    expect(w.sup.running()).toBe(false)
    expect(w.record).toBeNull()
    const wait = (status.nextAt ?? Number.NaN) - at
    const started = w.spawns.length
    await w.time.advance(wait - 1)
    expect(w.spawns).toHaveLength(started)
    await w.time.advance(1)
    expect(w.spawns).toHaveLength(started + 1)
    expect(w.sup.status()).toEqual({ state: 'connecting', since: w.time.now() })
    waits.push(wait)
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
})

test('the backoff starts over after a connection that stayed up 60 s, counted from when it connected', async () => {
  const w = world()
  await w.sup.sync()
  expect(await w.failAndWait()).toBe(1000)
  expect(await w.failAndWait()).toBe(2000)
  w.child().line(success())
  await w.time.advance(61_000)
  expect(await w.failAndWait()).toBe(1000)
  expect(await w.failAndWait()).toBe(2000)
  // 50 s before the server took the forward, then 20 s up: 70 s since it started, not a minute up.
  await w.time.advance(50_000)
  w.child().line(success())
  await w.time.advance(20_000)
  expect(await w.failAndWait()).toBe(4000)
})

test('a socket forward the server refuses: error with ssh’s own words and the listenPath hint, tried again 60 s later', async () => {
  const w = world()
  await w.sup.sync()
  const refused = `Error: remote port forwarding failed for listen path ${TUNNEL_SOCKET}`
  w.child().line(
    ...HEALTHY,
    'debug1: Remote: port forwarding refused',
    `debug1: remote forward failure for: listen ${TUNNEL_SOCKET}:-2, connect 127.0.0.1:12424`,
    refused,
  )
  w.child().exit(255)
  await w.time.advance(0)
  const at = w.time.now()
  expect(w.sup.status()).toEqual({ state: 'error', since: at, error: refused, hint: 'listenPath', nextAt: at + 60_000 })
  await w.time.advance(59_999)
  expect(w.spawns).toHaveLength(1)
  await w.time.advance(1)
  expect(w.spawns).toHaveLength(2)
  expect(w.sup.status().state).toBe('connecting')
  w.child().line(...HEALTHY, success())
  expect(w.sup.status()).toEqual({ state: 'connected', since: at + 60_000 })
})

test('a refused key is an error retried every 60 s; an ssh that cannot start is noSsh; the error is the last lines, 400 characters at most', async () => {
  const w = world()
  await w.sup.sync()
  const denied = 'boardtunnel@ssh.example.com: Permission denied (publickey).'
  for (let i = 0; i < 3; i++) {
    w.child().line(HEALTHY[0] ?? '', denied)
    w.child().exit(255)
    await w.time.advance(0)
    const at = w.time.now()
    expect(w.sup.status()).toEqual({ state: 'error', since: at, error: denied, hint: 'publickey', nextAt: at + 60_000 })
    await w.time.advance(60_000)
    expect(w.spawns).toHaveLength(i + 2)
  }

  // As many of the last lines as fit in 400 characters, whole.
  const long = (c: string): string => c.repeat(200)
  w.child().line(long('a'), long('b'), denied)
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status().error).toBe(`${long('b')}\n${denied}`)

  w.spawnError = 'ENOENT'
  await w.time.advance(60_000)
  expect(w.spawns).toHaveLength(5)
  const at = w.time.now()
  const status = w.sup.status()
  expect(status).toMatchObject({ state: 'error', since: at, hint: 'noSsh', nextAt: at + 60_000 })
  expect(status.error).toContain('ENOENT')
  expect(w.record).toBeNull()
  expect(w.sup.running()).toBe(false)
})

test('a sync with the same line waits out the backoff; a changed line starts at once, from attempt 1', async () => {
  const w = world()
  await w.sup.sync()
  expect(await w.failAndWait()).toBe(1000)
  expect(await w.failAndWait()).toBe(2000)
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status()).toMatchObject({ state: 'reconnecting', attempt: 3 })
  await w.sup.sync()
  expect(w.spawns).toHaveLength(3)
  w.plan = planTo(12500)
  await w.sup.sync()
  expect(w.spawns).toHaveLength(4)
  expect(w.child().pid).toBe(w.record?.pid ?? Number.NaN)
  expect(await w.failAndWait()).toBe(1000)
})

test('after the computer slept (the clock jumped), ssh starts again at the next tick, without waiting, once the old one is gone', async () => {
  const w = world()
  await w.sup.sync()
  w.child().line(success())
  await w.time.advance(12_000)
  const first = w.child()
  first.slow = true
  w.time.jump(10 * 60_000)
  const woke = w.time.now()
  await w.time.advance(5000)
  expect(first.kills).toBe(1)
  // Never two: the next one waits for the first to exit.
  expect(w.spawns).toHaveLength(1)
  first.exit(null)
  await w.time.advance(0)
  expect(w.spawns).toHaveLength(2)
  expect(w.sup.status()).toEqual({ state: 'connecting', since: woke + 5000 })
  w.child().line(success())
  expect(w.sup.status().state).toBe('connected')
  // Ticks 5 s apart are no sleep.
  await w.time.advance(120_000)
  expect(w.spawns).toHaveLength(2)
})

test('a change in this computer’s addresses starts ssh again at the next poll, also while waiting out a backoff', async () => {
  const w = world()
  await w.sup.sync()
  w.child().line(success())
  await w.time.advance(30_000)
  expect(w.spawns).toHaveLength(1)
  w.net = 'wlan0 10.0.0.7'
  await w.time.advance(10_000)
  expect(w.spawns[0]?.child.kills).toBe(1)
  expect(w.spawns).toHaveLength(2)
  expect(w.sup.status().state).toBe('connecting')

  for (let i = 0; i < 5; i++) await w.failAndWait(TIMED_OUT)
  w.child().line(TIMED_OUT)
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status()).toMatchObject({ state: 'reconnecting', attempt: 6 })
  const started = w.spawns.length
  w.net = 'eth0 192.168.1.20'
  await w.time.advance(10_000)
  expect(w.spawns).toHaveLength(started + 1)
  expect(await w.failAndWait()).toBe(1000)
})

test('a stray recorded ssh is ended before the first start; one that is not ours any more is left, the record overwritten', async () => {
  const stray = { pid: 4242, forward: forwardSpec(TUNNEL_SOCKET, 12424), at: 1 }
  for (const ends of [true, false]) {
    const w = world()
    w.record = stray
    w.strayEnded = ends
    await w.sup.sync()
    expect(w.ended).toEqual([{ record: stray, spawnsBefore: 0 }])
    expect(w.spawns).toHaveLength(1)
    expect(w.record).toEqual({ pid: w.child().pid, forward: stray.forward, at: w.time.now() })
  }

  // Off: a stray is still ended, and nothing starts.
  const w = world()
  w.plan = null
  w.record = stray
  await w.sup.sync()
  expect(w.ended).toEqual([{ record: stray, spawnsBefore: 0 }])
  expect(w.record).toBeNull()
  expect(w.spawns).toHaveLength(0)
  expect(w.sup.status().state).toBe('off')
})

test('off: ssh ended with its tree and waited for, the record cleared, no timer left; killNow ends it at once; close', async () => {
  const w = world()
  expect(w.time.pending()).toBe(0)
  await w.sup.sync()
  w.child().line(success())
  // The sleep tick and the network poll.
  expect(w.time.pending()).toBe(2)
  const changes = w.changes
  w.plan = null
  await w.sup.sync()
  expect(w.child().kills).toBe(1)
  expect(w.child().gone()).toBe(true)
  expect(w.sup.status()).toEqual({ state: 'off', since: w.time.now() })
  expect(w.changes).toBe(changes + 1)
  expect(w.record).toBeNull()
  expect(w.sup.running()).toBe(false)
  expect(w.time.pending()).toBe(0)
  await w.sup.sync()
  expect(w.changes).toBe(changes + 1)

  // Off while waiting out an error: the retry is dropped too.
  w.plan = planTo(12424)
  await w.sup.sync()
  w.child().line('boardtunnel@ssh.example.com: Permission denied (publickey).')
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status().state).toBe('error')
  w.plan = null
  await w.sup.sync()
  expect(w.time.pending()).toBe(0)
  await w.time.advance(120_000)
  expect(w.spawns).toHaveLength(2)

  // For an exit handler: the ssh alone, at once; its record kept for the next board.
  w.plan = planTo(12424)
  await w.sup.sync()
  w.sup.killNow()
  expect(w.child().nowKills).toBe(1)
  expect(w.record?.pid).toBe(w.child().pid)

  await w.sup.close()
  expect(w.child().kills).toBe(1)
  expect(w.sup.status().state).toBe('off')
  expect(w.record).toBeNull()
  expect(w.time.pending()).toBe(0)
  w.plan = planTo(12424)
  await w.sup.sync()
  expect(w.spawns).toHaveLength(3)
})

test('never two: two syncs at once start one ssh; a changed line starts the new one only after the old one exited', async () => {
  const w = world()
  await Promise.all([w.sup.sync(), w.sup.sync()])
  expect(w.spawns).toHaveLength(1)
  const first = w.child()
  first.line(success())
  first.slow = true
  w.plan = planTo(12500)
  const moved = w.sup.sync()
  await w.time.advance(0)
  expect(first.kills).toBe(1)
  expect(w.spawns).toHaveLength(1)
  expect(w.sup.running()).toBe(true)
  first.exit(null)
  await moved
  expect(w.spawns).toHaveLength(2)
  expect(w.spawns[1]?.args).toEqual(planTo(12500).args)
  // The old one's exit was asked for: no backoff, no error.
  expect(w.sup.status()).toEqual({ state: 'connecting', since: w.time.now() })
  expect(w.record).toEqual({ pid: w.child().pid, forward: forwardSpec(TUNNEL_SOCKET, 12500), at: w.time.now() })
})

test("networkSignature: this computer's own addresses, the same twice, none internal", () => {
  const signature = networkSignature()
  expect(networkSignature()).toBe(signature)
  expect(signature).not.toContain('127.0.0.1')
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('with the real adapters and the fake ssh: a stray ended, the forward held and recorded, back after a drop, ended when off', async () => {
  const fake = await useFakeSsh()
  // The stray (the first call) hangs silent; the supervisor's own hold the forward for 3 s each.
  fake.state({ ssh: { seq: ['hang', 'forward'], exitAfterMs: 3000 } })
  const plan = planTo(12999, fake.bin, fake.dir)
  const stray = spawnSsh(fake.bin, plan.args)
  writePidRecord({ pid: stray.pid, forward: plan.forward, at: Date.now() })
  let on = true
  const ends: boolean[] = []
  const states: TunnelState[] = []
  const sup = createSupervisor({
    plan: () => (on ? plan : null),
    spawn: spawnSsh,
    stray: {
      read: readPidRecord,
      write: writePidRecord,
      end: async r => {
        const ended = await endStraySsh(r)
        ends.push(ended)
        return ended
      },
    },
    clock: realClock,
    network: () => 'eth0 192.168.1.20',
    random: () => 0.5,
    onChange: () => states.push(sup.status().state),
    log: () => {},
  })
  try {
    await sup.sync()
    expect(ends).toEqual([true])
    expect(alive(stray.pid)).toBe(false)
    await until(() => sup.status().state === 'connected', 20_000)
    const first = readPidRecord()
    if (!first) throw new Error('no ssh recorded')
    expect(first.forward).toBe(plan.forward)
    expect(first.pid).not.toBe(stray.pid)

    await until(() => sup.status().state === 'reconnecting', 20_000)
    expect(sup.status()).toMatchObject({
      attempt: 1,
      error: 'Connection to ssh.example.com closed by remote host.',
      hint: null,
    })
    await until(() => sup.status().state === 'connected', 20_000)
    const second = readPidRecord()
    if (!second) throw new Error('no ssh recorded')
    expect(second.pid).not.toBe(first.pid)
    expect(alive(first.pid)).toBe(false)

    on = false
    await sup.sync()
    expect(sup.status().state).toBe('off')
    expect(readPidRecord()).toBeNull()
    expect(alive(second.pid)).toBe(false)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected', 'off'])
    expect(fake.calls().filter(args => args.includes('-R'))).toHaveLength(3)
  } finally {
    await sup.close()
    stray.killNow()
  }
})
