// The probe through the domain (now and then while connected) and Test connection, over the
// supervisor's fakes (test/support/fake-tunnel.ts).
import { expect, test } from 'bun:test'
import { fetchProbe, PROBE_TIMEOUT_MS } from '../../src/adapters/probe.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { type StepHint, type TestStep, TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { openProbeListener, PROBE_LISTENER_LIVES_MS } from '../../src/server/tunnel-probe.ts'
import { createProbes } from '../../src/services/tunnel.ts'
import { HEALTHY, planTo, SSH, success, world } from '../support/fake-tunnel.ts'

const DOMAIN = 'board.example.com'
const TIMED_OUT = 'ssh: connect to host ssh.example.com port 22: Connection timed out'
const REFUSED = `Error: remote port forwarding failed for listen path ${TUNNEL_SOCKET}`
const step = (id: TestStep['id'], ok: boolean | null, detail = '', hint: StepHint | null = null): TestStep => ({
  id,
  ok,
  detail,
  hint,
})
const sshOk = step('ssh', true, SSH)
const domainOk = step('domain', true, DOMAIN)
/** The forward and the domain when an earlier step failed: not run. */
const notRun = (id: TestStep['id']): TestStep => step(id, null)

/** Whether a promise has settled yet. */
function watch<T>(p: Promise<T>): { done: () => boolean } {
  let done = false
  void p.then(() => {
    done = true
  })
  return { done: () => done }
}

test('createProbes: 16 random bytes in hex, each answered for 60 s', () => {
  let now = 1000
  const probes = createProbes(() => now)
  const a = probes.issue()
  const b = probes.issue()
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(b).not.toBe(a)
  expect(probes.answers(a)).toBe(true)
  expect(probes.answers('0'.repeat(32))).toBe(false)
  expect(probes.answers(a.toUpperCase())).toBe(false)
  expect(probes.answers('')).toBe(false)
  now += 59_999
  expect(probes.answers(a)).toBe(true)
  now += 1
  expect(probes.answers(a)).toBe(false)
  expect(probes.answers(b)).toBe(false)
})

test('connected: a probe through the domain 3 s later with a nonce the board answers; a failure a warning, ssh left alone; again every 5 min', async () => {
  const w = world()
  await w.sup.sync()
  w.child().line(...HEALTHY, success())
  const since = w.time.now()
  w.probeWith = async () => ({ ok: false, kind: 'status', status: 502, detail: '502' })
  await w.time.advance(2999)
  expect(w.probed).toHaveLength(0)
  const changes = w.changes
  await w.time.advance(1)
  expect(w.probed).toHaveLength(1)
  expect(w.probes.answers(w.probed[0] ?? '')).toBe(true)
  expect(w.sup.status()).toEqual({ state: 'connected', since, probe: { ok: false, at: since + 3000, detail: '502' } })
  expect(w.changes).toBe(changes + 1)
  expect(w.spawns).toHaveLength(1)
  expect(w.child().kills).toBe(0)

  w.probeWith = async () => ({ ok: true })
  await w.time.advance(5 * 60_000 - 1)
  expect(w.probed).toHaveLength(1)
  await w.time.advance(1)
  expect(w.probed).toHaveLength(2)
  expect(w.probed[1]).not.toBe(w.probed[0])
  expect(w.probes.answers(w.probed[1] ?? '')).toBe(true)
  expect(w.sup.status()).toEqual({ state: 'connected', since, probe: { ok: true, at: w.time.now(), detail: '' } })
  await w.time.advance(5 * 60_000)
  expect(w.probed).toHaveLength(3)
  expect(w.spawns).toHaveLength(1)

  // Dropped: the warning goes with the connection, and no probe while not connected.
  w.child().line(TIMED_OUT)
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status().probe).toBeUndefined()
  await w.time.advance(30 * 60_000)
  expect(w.sup.status().state).toBe('connecting')
  expect(w.probed).toHaveLength(3)
})

test('a probe that answers after the connection dropped changes nothing; off leaves no probe timer', async () => {
  const w = world()
  await w.sup.sync()
  w.child().line(success())
  let answer: (r: { ok: true }) => void = () => {}
  w.probeWith = () =>
    new Promise(resolve => {
      answer = resolve
    })
  await w.time.advance(3000)
  expect(w.probed).toHaveLength(1)
  w.child().exit(255)
  await w.time.advance(0)
  const status = w.sup.status()
  expect(status.state).toBe('reconnecting')
  answer({ ok: true })
  await w.time.advance(0)
  expect(w.sup.status()).toEqual(status)

  await w.time.advance(1000)
  w.child().line(success())
  w.plan = null
  await w.sup.sync()
  expect(w.time.pending()).toBe(0)
})

test('Test while the tunnel is on and connected: no ssh and no listener of its own, three ✓', async () => {
  const w = world()
  await w.sup.sync()
  w.child().line(success())
  const steps = await w.sup.test()
  expect(steps).toEqual([sshOk, step('forward', true, planTo(12424).forward), domainOk])
  expect(w.spawns).toHaveLength(1)
  expect(w.listeners).toHaveLength(0)
  expect(w.keyChecks).toBe(1)
  expect(w.probed).toHaveLength(1)
  expect(w.probes.answers(w.probed[0] ?? '')).toBe(true)
  expect(w.sup.status().state).toBe('connected')
})

test('Test while on and not connected: the forward ✗ with the status’s error and hint, the domain not run (notConnected)', async () => {
  const w = world()
  await w.sup.sync()
  // Connecting: no error yet.
  expect(await w.sup.test()).toEqual([
    sshOk,
    step('forward', false, 'the tunnel is connecting'),
    step('domain', null, '', 'notConnected'),
  ])
  // Reconnecting, between two attempts.
  w.child().line(TIMED_OUT)
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status().state).toBe('reconnecting')
  expect(await w.sup.test()).toEqual([
    sshOk,
    step('forward', false, TIMED_OUT, 'network'),
    step('domain', null, '', 'notConnected'),
  ])
  // A lasting error.
  await w.time.advance(1000)
  w.child().line(REFUSED)
  w.child().exit(255)
  await w.time.advance(0)
  expect(w.sup.status().state).toBe('error')
  expect(await w.sup.test()).toEqual([
    sshOk,
    step('forward', false, REFUSED, 'listenPath'),
    step('domain', null, '', 'notConnected'),
  ])
  expect(w.spawns).toHaveLength(2)
  expect(w.listeners).toHaveLength(0)
  expect(w.probed).toHaveLength(0)
})

test('Test while off: a probe-only listener, one ssh forwarding to it, its pid recorded; the success line, the probe, three ✓; then both ended', async () => {
  const w = world()
  w.plan = null
  await w.sup.sync()
  const changes = w.changes
  const run = w.sup.test()
  await w.time.advance(0)
  expect(w.listeners).toHaveLength(1)
  const l = w.listeners[0]
  if (!l) throw new Error('no listener')
  expect(w.probes.answers(l.nonce)).toBe(true)
  const plan = planTo(l.port)
  expect(w.spawns.map(s => [s.bin, s.args])).toEqual([[plan.bin, plan.args]])
  const child = w.child()
  expect(w.record).toEqual({ pid: child.pid, forward: plan.forward, at: w.time.now() })

  // The forward and the listener are up while the domain is probed.
  let upAtProbe = false
  w.probeWith = async () => {
    upAtProbe = !child.gone() && l.closed === 0
    return { ok: true }
  }
  child.line(...HEALTHY, success(l.port))
  expect(await run).toEqual([sshOk, step('forward', true, plan.forward), domainOk])
  expect(w.probed).toEqual([l.nonce])
  expect(upAtProbe).toBe(true)
  expect(child.kills).toBe(1)
  expect(child.gone()).toBe(true)
  expect(l.closed).toBe(1)
  expect(w.record).toBeNull()
  // The tunnel's own status is not the Test's.
  expect(w.sup.status().state).toBe('off')
  expect(w.sup.running()).toBe(false)
  expect(w.changes).toBe(changes)
  expect(w.time.pending()).toBe(0)
})

test('Test while off, ssh refused the socket: the forward ✗ with ssh’s words and listenPath, the domain not run, both ended', async () => {
  const w = world()
  w.plan = null
  const run = w.sup.test()
  await w.time.advance(0)
  w.child().line(...HEALTHY, 'debug1: Remote: port forwarding refused', REFUSED)
  w.child().exit(255)
  expect(await run).toEqual([sshOk, step('forward', false, REFUSED, 'listenPath'), notRun('domain')])
  expect(w.child().gone()).toBe(true)
  expect(w.listeners[0]?.closed).toBe(1)
  expect(w.record).toBeNull()
  expect(w.probed).toHaveLength(0)
  expect(w.time.pending()).toBe(0)
})

test('Test while off, ssh silent for 25 s: the forward ✗ timed out (network), ssh killed', async () => {
  const w = world()
  w.plan = null
  const run = w.sup.test()
  const state = watch(run)
  await w.time.advance(24_999)
  expect(state.done()).toBe(false)
  expect(w.child().kills).toBe(0)
  await w.time.advance(1)
  expect(await run).toEqual([sshOk, step('forward', false, 'timed out', 'network'), notRun('domain')])
  expect(w.child().kills).toBe(1)
  expect(w.listeners[0]?.closed).toBe(1)
  expect(w.record).toBeNull()
})

test('Test while off: an ssh that cannot start is noSsh; settings that do not check out start none', async () => {
  const w = world()
  w.plan = null
  w.spawnError = 'ENOENT'
  const failed = await w.sup.test()
  expect(failed[1]).toMatchObject({ id: 'forward', ok: false, hint: 'noSsh' })
  expect(failed[1]?.detail).toContain('ENOENT')
  expect(failed[2]).toEqual(notRun('domain'))
  expect(w.listeners[0]?.closed).toBe(1)

  w.spawnError = null
  w.settingsBroken = true
  expect(await w.sup.test()).toEqual([sshOk, step('forward', false, 'the settings do not check out'), notRun('domain')])
  expect(w.spawns).toHaveLength(1)
  expect(w.listeners).toHaveLength(2)
  expect(w.listeners[1]?.closed).toBe(1)
})

test('Test while off with a recorded ssh of ours that may still run: no ssh and no listener of its own, the record kept', async () => {
  const w = world()
  w.plan = null
  const stray = { pid: 4242, forward: planTo(12424).forward, at: 1 }
  w.record = stray
  w.strayEnd = async () => false
  await w.sup.sync()
  const steps = await w.sup.test()
  expect(steps[1]).toMatchObject({ id: 'forward', ok: false, hint: null })
  expect(steps[1]?.detail).toContain('pid 4242')
  expect(steps[2]).toEqual(notRun('domain'))
  expect(w.spawns).toHaveLength(0)
  expect(w.record).toEqual(stray)
  expect(w.listeners).toHaveLength(0)

  // Gone by the next Test: its record cleared, the Test's ssh runs.
  w.strayEnd = async () => true
  const run = w.sup.test()
  await w.time.advance(0)
  expect(w.spawns).toHaveLength(1)
  w.child().line(success(w.listeners[0]?.port))
  expect((await run).map(s => s.ok)).toEqual([true, true, true])
  expect(w.record).toBeNull()
})

test('Test while off, the forward taken at the last moment and the probe as slow as it may be: the probe-only listener is still up for it, a stray’s end not counted', async () => {
  // 0: no record. 8000: a record whose ssh takes 8 s to end (PowerShell), before the listener opens.
  for (const strayMs of [0, 8000]) {
    const w = world()
    w.plan = null
    if (strayMs) {
      w.record = { pid: 4242, forward: planTo(12424).forward, at: 1 }
      w.strayEnd = () => new Promise(resolve => w.time.clock.setTimeout(() => resolve(true), strayMs))
    }
    // As the real one: it closes itself PROBE_LISTENER_LIVES_MS after it opened (here on the fake clock).
    let up = false
    let opened = 0
    w.listen = async () => {
      up = true
      opened += 1
      const timer = w.time.clock.setTimeout(() => {
        up = false
      }, PROBE_LISTENER_LIVES_MS)
      return {
        port: 40_001,
        close: () => {
          up = false
          w.time.clock.clearTimeout(timer)
        },
      }
    }
    // The probe answers at the end of its timeout, through the listener if that is still up.
    w.probeWith = () =>
      new Promise(resolve =>
        w.time.clock.setTimeout(
          () => resolve(up ? { ok: true } : { ok: false, kind: 'status', status: 502, detail: '502' }),
          PROBE_TIMEOUT_MS,
        ),
      )
    const run = w.sup.test()
    await w.time.advance(strayMs)
    expect(w.spawns).toHaveLength(1)
    expect(opened).toBe(1)
    // The forward wait is 25 s: taken 1 ms before it runs out.
    await w.time.advance(24_999)
    w.child().line(success(40_001))
    await w.time.advance(PROBE_TIMEOUT_MS)
    expect(await run).toEqual([sshOk, step('forward', true, planTo(40_001).forward), domainOk])
    expect(up).toBe(false)
    expect(w.child().gone()).toBe(true)
    expect(w.time.pending()).toBe(0)
  }
})

test('close while a Test waits on a stray’s end: the Test starts no ssh after, and close does not wait on one', async () => {
  const w = world()
  w.plan = null
  w.record = { pid: 4242, forward: planTo(12424).forward, at: 1 }
  let strayGone: (gone: boolean) => void = () => {}
  w.strayEnd = () =>
    new Promise(resolve => {
      strayGone = resolve
    })
  const run = w.sup.test()
  await w.time.advance(0)
  expect(w.ended).toHaveLength(1)
  const closing = watch(w.sup.close())
  strayGone(true)
  await w.time.advance(0)
  expect(closing.done()).toBe(true)
  expect(await run).toEqual([sshOk, step('forward', false, 'the board is shutting down'), notRun('domain')])
  expect(w.spawns).toHaveLength(0)
  expect(w.listeners.every(l => l.closed === 1)).toBe(true)
  expect(w.record).toBeNull()
  expect(w.time.pending()).toBe(0)
})

test('no ssh found, or a key refused: the ssh step ✗ with its hint, the rest not run, nothing spawned or opened', async () => {
  for (const on of [true, false]) {
    const w = world()
    if (!on) w.plan = null
    await w.sup.sync()
    const spawned = w.spawns.length
    w.sshPath = null
    expect(await w.sup.test()).toEqual([
      step('ssh', false, 'ssh not found', 'noSsh'),
      notRun('forward'),
      notRun('domain'),
    ])
    expect(w.keyChecks).toBe(0)

    w.sshPath = SSH
    const error = "Permissions for 'C:/state/tunnel/id_ed25519' are too open.\nUNPROTECTED PRIVATE KEY FILE!"
    w.keyCheck = { ok: false, error, hint: 'keyPermissions' }
    expect(await w.sup.test()).toEqual([
      step('ssh', false, error, 'keyPermissions'),
      notRun('forward'),
      notRun('domain'),
    ])
    expect(w.spawns).toHaveLength(spawned)
    expect(w.listeners).toHaveLength(0)
    expect(w.probed).toHaveLength(0)
  }
})

test('what the domain answered: a 502 is caddy502, then tls, answer, network; another status has no hint', async () => {
  const w = world()
  await w.sup.sync()
  w.child().line(success())
  const answers: [Awaited<ReturnType<typeof w.probeWith>>, StepHint | null][] = [
    [{ ok: false, kind: 'status', status: 502, detail: '502' }, 'caddy502'],
    [{ ok: false, kind: 'tls', detail: 'EPROTO: The TLS handshake failed' }, 'tls'],
    [{ ok: false, kind: 'answer', detail: '<!DOCTYPE html>' }, 'answer'],
    [{ ok: false, kind: 'network', detail: 'The operation timed out.' }, 'network'],
    [{ ok: false, kind: 'status', status: 404, detail: '404' }, null],
  ]
  for (const [answer, hint] of answers) {
    w.probeWith = async () => answer
    const steps = await w.sup.test()
    expect(steps[2]).toEqual(step('domain', false, answer.ok ? '' : answer.detail, hint))
  }

  // The same through the Test's own ssh.
  const off = world()
  off.plan = null
  off.probeWith = async () => ({ ok: false, kind: 'status', status: 502, detail: '502' })
  const run = off.sup.test()
  await off.time.advance(0)
  off.child().line(success(off.listeners[0]?.port))
  expect((await run)[2]).toEqual(step('domain', false, '502', 'caddy502'))
  expect(off.child().gone()).toBe(true)
  expect(off.listeners[0]?.closed).toBe(1)
})

test('two Tests at once are one run; the next one runs again', async () => {
  const w = world()
  w.plan = null
  const a = w.sup.test()
  const b = w.sup.test()
  expect(b).toBe(a)
  await w.time.advance(0)
  w.child().line(success(w.listeners[0]?.port))
  expect((await a).map(s => s.ok)).toEqual([true, true, true])
  expect(w.keyChecks).toBe(1)
  expect(w.listeners).toHaveLength(1)
  expect(w.spawns).toHaveLength(1)

  const c = w.sup.test()
  expect(c).not.toBe(a)
  await w.time.advance(0)
  w.child().line(success(w.listeners[1]?.port))
  await c
  expect(w.spawns).toHaveLength(2)
})

test('never two on the socket: the tunnel turned on during a Test starts its ssh once the Test’s has exited', async () => {
  const w = world()
  w.plan = null
  await w.sup.sync()
  const run = w.sup.test()
  await w.time.advance(0)
  const testChild = w.child()
  testChild.slow = true
  w.plan = planTo(12424)
  const synced = w.sup.sync()
  testChild.line(success(w.listeners[0]?.port))
  await w.time.advance(0)
  expect(testChild.kills).toBe(1)
  expect(w.spawns).toHaveLength(1)
  expect(w.sup.running()).toBe(false)
  testChild.exit(null)
  expect((await run).map(s => s.ok)).toEqual([true, true, true])
  await synced
  expect(w.spawns).toHaveLength(2)
  expect(w.spawns[1]?.args).toEqual(planTo(12424).args)
  expect(w.record).toEqual({ pid: w.child().pid, forward: planTo(12424).forward, at: w.time.now() })
  expect(w.sup.status().state).toBe('connecting')
})

test('never two on the socket: a Test just after the tunnel went off starts its ssh once the tunnel’s has exited', async () => {
  const w = world()
  await w.sup.sync()
  const tunnel = w.child()
  tunnel.line(success())
  tunnel.slow = true
  w.plan = null
  const synced = w.sup.sync()
  const run = w.sup.test()
  await w.time.advance(0)
  expect(tunnel.kills).toBe(1)
  expect(w.spawns).toHaveLength(1)
  tunnel.exit(null)
  await synced
  await w.time.advance(0)
  expect(w.spawns).toHaveLength(2)
  expect(w.spawns[1]?.args).toEqual(planTo(w.listeners[0]?.port ?? 0).args)
  w.child().line(success(w.listeners[0]?.port))
  expect((await run).map(s => s.ok)).toEqual([true, true, true])
})

test('killNow ends a running Test’s ssh at once, its record kept; close ends the Test', async () => {
  const w = world()
  w.plan = null
  const run = w.sup.test()
  await w.time.advance(0)
  const child = w.child()
  w.sup.killNow()
  expect(child.nowKills).toBe(1)
  expect(w.record?.pid).toBe(child.pid)

  await w.sup.close()
  expect(child.kills).toBeGreaterThan(0)
  expect(child.gone()).toBe(true)
  expect((await run)[1]).toMatchObject({ id: 'forward', ok: false })
  expect(w.listeners[0]?.closed).toBe(1)
  expect(w.record).toBeNull()
  expect(w.time.pending()).toBe(0)
})

test('with the real probe-only listener and fetchProbe, the domain reaching it: three ✓, the listener closed after', async () => {
  const w = world()
  w.plan = null
  let port = 0
  w.listen = async nonce => {
    const l = await openProbeListener(nonce)
    port = l.port
    return l
  }
  // As if the domain reached the listener through the forward.
  w.probeWith = nonce => fetchProbe(`http://127.0.0.1:${port}`, nonce)
  const run = w.sup.test()
  await w.time.advance(0)
  expect(port).toBeGreaterThan(0)
  w.child().line(success(port))
  expect(await run).toEqual([sshOk, step('forward', true, planTo(port).forward), domainOk])
  expect(await fetchProbe(`http://127.0.0.1:${port}`, w.probed[0] ?? '', 2000)).toMatchObject({
    ok: false,
    kind: 'network',
  })
})

test('every hint has its text in English and Russian; the English as given', () => {
  const en = translator('en')
  const ru = translator('ru')
  const hints: StepHint[] = [
    'publickey',
    'listenPath',
    'keyPermissions',
    'hostKey',
    'network',
    'noSsh',
    'passphrase',
    'caddy502',
    'tls',
    'answer',
    'notConnected',
  ]
  for (const hint of hints) {
    const key = `tunnel.hint.${hint}`
    expect(en(key)).not.toBe(key)
    expect(ru(key)).not.toBe(key)
    expect(ru(key)).not.toBe(en(key))
  }
  expect(en('tunnel.hint.publickey')).toBe(
    'The server refused the key: put the authorized_keys line in the keys file on the server, and the sshd Match block in sshd_config.',
  )
  expect(en('tunnel.hint.caddy502')).toBe(
    "Caddy answered 502: its socket path and the board's differ, or Caddy cannot open the socket (the folder's group or setgid bit, StreamLocalBindMask).",
  )
  expect(en('tunnel.hint.notConnected')).toBe('The tunnel is not connected now.')
  // The spike: sshd refuses a socket forward unless AllowTcpForwarding lets remote forwards through.
  expect(en('tunnel.hint.listenPath')).toContain('AllowStreamLocalForwarding')
  expect(en('tunnel.hint.listenPath')).toContain('AllowTcpForwarding remote')
  expect(en('tunnel.hint.listenPath')).not.toContain('AllowTcpForwarding no')
})
