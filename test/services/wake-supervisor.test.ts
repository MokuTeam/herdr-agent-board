// Wake's supervisor (src/services/wake/supervisor.ts) with a fake child and a fake clock: it starts
// the wake process again after a crash (2 s, 10 s, 30 s), stops after five crashes in ten minutes
// with the last error on screen and in its status, ends a process whose API stops answering, ends
// with it when wake is turned off, and restarts it on a code change.
import { expect, test } from 'bun:test'
import type { WakeStatusFile } from '../../src/core/wake/status.ts'
import {
  createSupervisor,
  HEALTH_EVERY_MS,
  HEALTH_MISSES,
  RESTART_EXIT,
  type SupervisorDeps,
  UP_GRACE_MS,
  type WakeChild,
} from '../../src/services/wake/supervisor.ts'

const PANE = 'w9:p1'
const PID = 4242
const MINUTE = 60_000

/** Lets the promises the supervisor waits on settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

class FakeChild implements WakeChild {
  readonly sent: unknown[] = []
  killed = false
  private exits: ((code: number | null) => void)[] = []
  private messages: ((m: unknown) => void)[] = []
  private lines: ((line: string) => void)[] = []
  onExit(cb: (code: number | null) => void): void {
    this.exits.push(cb)
  }
  onMessage(cb: (m: unknown) => void): void {
    this.messages.push(cb)
  }
  onErrorLine(cb: (line: string) => void): void {
    this.lines.push(cb)
  }
  send(m: unknown): void {
    this.sent.push(m)
  }
  /** Killed, it ends as a killed process does: no exit code. */
  kill(): void {
    this.killed = true
    this.exit(null)
  }
  exit(code: number | null): void {
    for (const cb of this.exits) cb(code)
  }
  up(port: number): void {
    for (const cb of this.messages) cb({ up: port })
  }
  stderr(line: string): void {
    for (const cb of this.lines) cb(line)
  }
}

/** A supervisor over fake children, a fake clock and a health check the test answers. */
function supervised(health: () => boolean = () => true) {
  let now = 1_760_000_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const children: FakeChild[] = []
  const statuses: WakeStatusFile[] = []
  const printed: string[] = []
  const exits: number[] = []
  const deps: SupervisorDeps = {
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
    health: async () => health(),
    writeStatus: s => {
      statuses.push(s)
    },
    print: text => {
      printed.push(text)
    },
    log: () => {},
    now: () => now,
    setTimer: (fn, ms) => {
      seq++
      timers.set(seq, { at: now + ms, fn })
      return seq
    },
    clearTimer: t => {
      timers.delete(t as number)
    },
    exit: code => {
      exits.push(code)
    },
    pane: PANE,
    pid: PID,
  }
  const supervisor = createSupervisor(deps)
  /** The clock moved on by `ms`, the timers due on the way run in turn. */
  async function advance(ms: number): Promise<void> {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      const first = due[0]
      if (!first) break
      timers.delete(first[0])
      now = first[1].at
      first[1].fn()
      await settle()
    }
    now = end
    await settle()
  }
  const child = (n: number): FakeChild => {
    const c = children[n - 1]
    if (!c) throw new Error(`no child ${n}: ${children.length} started`)
    return c
  }
  return { supervisor, children, child, statuses, printed, exits, advance, now: () => now }
}

test('each start says starting with its pane and pid, and running once the process says it listens', async () => {
  const s = supervised()
  s.supervisor.start()
  expect(s.children).toHaveLength(1)
  expect(s.statuses).toEqual([{ state: 'starting', at: s.now(), pane: PANE, pid: PID }])
  s.child(1).up(40123)
  expect(s.statuses.at(-1)).toEqual({ state: 'running', at: s.now(), pane: PANE, pid: PID, port: 40123 })
})

test('a crash starts it again after 2 s, 10 s, 30 s', async () => {
  const s = supervised()
  s.supervisor.start()
  for (const [n, wait] of [
    [1, 2000],
    [2, 10_000],
    [3, 30_000],
    [4, 30_000],
  ] as const) {
    s.child(n).stderr(`error ${n}`)
    s.child(n).exit(1)
    expect(s.printed.at(-1)).toBe(`wake stopped (exit 1). It starts again in ${wait / 1000} s.`)
    expect(s.statuses.at(-1)).toMatchObject({ state: 'starting', pane: PANE, pid: PID, error: `error ${n}` })
    await s.advance(wait - 1)
    expect(s.children).toHaveLength(n)
    await s.advance(1)
    expect(s.children).toHaveLength(n + 1)
  }
  expect(s.exits).toEqual([])
})

test('5 crashes in 10 minutes stop it, the last error on screen and in the status file', async () => {
  const s = supervised()
  s.supervisor.start()
  for (let n = 1; n <= 5; n++) {
    s.child(n).up(40123)
    s.child(n).stderr(`TypeError: broken ${n}`)
    s.child(n).stderr('')
    s.child(n).exit(1)
    await s.advance(30_000)
  }
  await s.advance(10 * MINUTE)
  expect(s.children).toHaveLength(5)
  const last = s.statuses.at(-1)
  expect(last).toMatchObject({ state: 'crashed', pane: PANE, pid: PID, error: 'TypeError: broken 5' })
  expect(last?.crashes).toHaveLength(5)
  expect(s.printed.at(-1)).toContain('TypeError: broken 5')
  expect(s.exits).toEqual([])
})

test('crashes further apart than 10 minutes never stop it', async () => {
  const s = supervised()
  s.supervisor.start()
  for (let n = 1; n <= 8; n++) {
    s.child(n).exit(1)
    await s.advance(3 * MINUTE)
  }
  expect(s.children).toHaveLength(9)
})

test('a hung API is ended after three missed health checks and counts as a crash', async () => {
  let answers = true
  const s = supervised(() => answers)
  s.supervisor.start()
  s.child(1).up(40123)
  // Two misses, then an answer: the count starts over.
  answers = false
  await s.advance(2 * HEALTH_EVERY_MS)
  answers = true
  await s.advance(HEALTH_EVERY_MS)
  answers = false
  await s.advance((HEALTH_MISSES - 1) * HEALTH_EVERY_MS)
  expect(s.child(1).killed).toBe(false)
  await s.advance(HEALTH_EVERY_MS)
  expect(s.child(1).killed).toBe(true)
  expect(s.statuses.at(-1)).toMatchObject({ state: 'starting', error: expect.stringContaining('health check') })
  expect(s.printed.at(-1)).toBe('wake stopped (exit killed). It starts again in 2 s.')
  await s.advance(2000)
  expect(s.children).toHaveLength(2)
})

test('a process that never says it listens is checked from 30 s after its start', async () => {
  const s = supervised(() => false)
  s.supervisor.start()
  await s.advance(UP_GRACE_MS + (HEALTH_MISSES - 1) * HEALTH_EVERY_MS - 1)
  expect(s.child(1).killed).toBe(false)
  await s.advance(1)
  expect(s.child(1).killed).toBe(true)
})

test('turned off: the child ends with 0 and so does the supervisor, status stopped', async () => {
  const s = supervised(() => false)
  s.supervisor.start()
  s.child(1).up(40123)
  s.child(1).exit(0)
  await s.advance(0)
  expect(s.statuses.at(-1)).toEqual({ state: 'stopped', at: s.now(), pane: PANE, pid: PID })
  expect(s.exits).toEqual([0])
  await s.advance(10 * MINUTE)
  expect(s.children).toHaveLength(1)
})

test('a second wake that ends with 0 because another one answers on the port leaves the status to that one', async () => {
  const s = supervised(() => true)
  s.supervisor.start()
  s.child(1).exit(0)
  await s.advance(0)
  expect(s.statuses.map(x => x.state)).toEqual(['starting'])
  expect(s.exits).toEqual([0])
})

test('a code change asks the child to restart, which it does at once with 75; crashes start over', async () => {
  const s = supervised()
  s.supervisor.start()
  s.child(1).exit(1)
  await s.advance(2000)
  s.child(2).exit(1)
  await s.advance(10_000)
  s.child(3).up(40123)
  s.supervisor.codeChanged()
  expect(s.child(3).sent).toEqual(['restart'])
  s.child(3).exit(RESTART_EXIT)
  expect(s.children).toHaveLength(4)
  s.child(4).exit(1)
  expect(s.printed.at(-1)).toBe('wake stopped (exit 1). It starts again in 2 s.')
})

test('a code change starts a crashed wake at once, and one waiting to start again', async () => {
  const s = supervised()
  s.supervisor.start()
  for (let n = 1; n <= 5; n++) {
    s.child(n).exit(1)
    await s.advance(30_000)
  }
  expect(s.statuses.at(-1)?.state).toBe('crashed')
  s.supervisor.codeChanged()
  expect(s.children).toHaveLength(6)
  s.child(6).exit(1)
  s.supervisor.codeChanged()
  expect(s.children).toHaveLength(7)
  // The start it was waiting for does not come on top.
  await s.advance(MINUTE)
  expect(s.children).toHaveLength(7)
})
