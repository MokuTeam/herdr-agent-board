import { expect, setDefaultTimeout, test } from 'bun:test'
import { endStraySsh, type PidRecord, readPidRecord, spawnSsh, writePidRecord } from '../../src/adapters/ssh.ts'
import { forwardSpec, TUNNEL_SOCKET, type TunnelState } from '../../src/core/tunnel.ts'
import { createProbes, createSupervisor, networkSignature, realClock } from '../../src/services/tunnel.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'
import { HEALTHY, planTo, success, world } from '../support/fake-tunnel.ts'
import { until } from '../support/sandbox.ts'

// The last test runs the compiled fake ssh, and PowerShell reads a stray's command line.
setDefaultTimeout(60_000)

const TIMED_OUT = 'ssh: connect to host ssh.example.com port 22: Connection timed out'

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

const FORWARD = forwardSpec(TUNNEL_SOCKET, 12424)
/** The real endStraySsh on this test's own pid (alive), its command line made up, its kill a no-op. */
function endAs(line: string | null, kills: number[]): (r: PidRecord) => Promise<boolean> {
  return r => endStraySsh(r, { commandLine: async () => line, kill: pid => kills.push(pid), waitMs: 0 })
}

test('a stray recorded ssh is ended before the first start; once none of ours runs under its pid, ssh starts and the record is overwritten', async () => {
  // Gone (its kill took, or it had ended).
  const stray = { pid: 4242, forward: FORWARD, at: 1 }
  const gone = world()
  gone.record = stray
  await gone.sup.sync()
  expect(gone.ended).toEqual([{ record: stray, spawnsBefore: 0 }])
  expect(gone.spawns).toHaveLength(1)
  expect(gone.record).toEqual({ pid: gone.child().pid, forward: FORWARD, at: gone.time.now() })

  // Another program holds the pid now: left alone, ssh starts.
  const other = world()
  const kills: number[] = []
  const taken = { pid: process.pid, forward: FORWARD, at: 1 }
  other.record = taken
  other.strayEnd = endAs(`${process.execPath} other.js`, kills)
  await other.sup.sync()
  expect(other.ended).toEqual([{ record: taken, spawnsBefore: 0 }])
  expect(kills).toEqual([])
  expect(other.spawns).toHaveLength(1)
  expect(other.record).toEqual({ pid: other.child().pid, forward: FORWARD, at: other.time.now() })
  expect(other.sup.status().state).toBe('connecting')

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

test('our stray outliving its kill: no ssh starts, its record kept, reconnecting after a backoff; an attempt that finds it gone starts one', async () => {
  const w = world()
  const stray = { pid: process.pid, forward: FORWARD, at: 1 }
  w.record = stray
  const kills: number[] = []
  w.strayEnd = endAs(`C:/Windows/System32/OpenSSH/ssh.exe -v -N -R ${FORWARD} boardtunnel@ssh.example.com`, kills)
  await w.sup.sync()
  expect(kills).toEqual([process.pid])
  expect(w.spawns).toHaveLength(0)
  expect(w.sup.running()).toBe(false)
  expect(w.record).toEqual(stray)
  const start = w.time.now()
  expect(w.sup.status()).toMatchObject({
    state: 'reconnecting',
    since: start,
    attempt: 1,
    nextAt: start + 1000,
    hint: null,
  })
  expect(w.sup.status().error).toContain(`pid ${process.pid}`)

  // A sync with the same plan waits out the backoff; then it is tried again, still there.
  await w.sup.sync()
  await w.time.advance(999)
  expect(w.ended).toHaveLength(1)
  await w.time.advance(1)
  expect(w.ended).toHaveLength(2)
  expect(kills).toEqual([process.pid, process.pid])
  expect(w.spawns).toHaveLength(0)
  expect(w.record).toEqual(stray)
  expect(w.sup.status()).toMatchObject({ state: 'reconnecting', attempt: 2, nextAt: w.time.now() + 2000 })

  // Gone at the next attempt: one ssh starts, recorded in its place.
  w.strayEnd = async () => true
  await w.time.advance(2000)
  expect(w.ended).toHaveLength(3)
  expect(w.ended[2]?.spawnsBefore).toBe(0)
  expect(w.spawns).toHaveLength(1)
  expect(w.record).toEqual({ pid: w.child().pid, forward: FORWARD, at: w.time.now() })
  expect(w.sup.status().state).toBe('connecting')
  w.child().line(success())
  expect(w.sup.status().state).toBe('connected')
})

test('a recorded pid that runs but cannot be read (PowerShell failing), or an end that throws: no ssh starts, the record kept', async () => {
  const w = world()
  const stray = { pid: process.pid, forward: FORWARD, at: 1 }
  w.record = stray
  const kills: number[] = []
  w.strayEnd = endAs(null, kills)
  await w.sup.sync()
  expect(w.ended).toHaveLength(1)
  expect(kills).toEqual([])
  expect(w.spawns).toHaveLength(0)
  expect(w.record).toEqual(stray)
  expect(w.sup.status()).toMatchObject({ state: 'reconnecting', attempt: 1 })

  w.strayEnd = async () => {
    throw new Error('Get-CimInstance failed')
  }
  await w.time.advance(1000)
  expect(w.ended).toHaveLength(2)
  expect(w.spawns).toHaveLength(0)
  expect(w.record).toEqual(stray)
  expect(w.sup.status()).toMatchObject({ state: 'reconnecting', attempt: 2 })

  // Off: tried once more; nothing starts, nothing waits, the record kept for the next try.
  w.strayEnd = endAs(null, kills)
  w.plan = null
  await w.sup.sync()
  expect(w.ended).toHaveLength(3)
  expect(w.spawns).toHaveLength(0)
  expect(w.record).toEqual(stray)
  expect(w.sup.status().state).toBe('off')
  expect(w.time.pending()).toBe(0)
})

test('off: ssh ended with its tree and waited for, the record cleared, no timer left; killNow ends it at once; close', async () => {
  const w = world()
  expect(w.time.pending()).toBe(0)
  await w.sup.sync()
  w.child().line(success())
  // The sleep tick, the network poll and the first probe through the domain.
  expect(w.time.pending()).toBe(3)
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
    // Not this test's: the probe through the domain never answers, Test is not run.
    probes: createProbes(),
    probe: () => new Promise(() => {}),
    testPlan: () => null,
    checkKey: async () => ({ ok: true }),
    sshFound: () => fake.bin,
    openProbeListener: () => Promise.reject(new Error('no Test in this test')),
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
