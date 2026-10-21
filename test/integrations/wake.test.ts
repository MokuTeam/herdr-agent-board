// The board's side of the new wake (#119, call 10, safeguard 14): sleepers() never waits on wake.
// It gives the last list at once and asks again in the background; while wake does not answer, or
// is off, the list is wake's session file's, read only, each entry marked fromFile.
import { expect, onTestFinished, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Item } from '../../src/core/types.ts'
import type { SleepingSession, SleepProvider } from '../../src/integrations/herdr-wake.ts'
import { createBoardWake, sharedBoardWake, withFileSleepers } from '../../src/integrations/wake.ts'

const URL = 'http://127.0.0.1:23456'
const WORK = 'C:\\Users\\Иван Петров\\.claude-work 100%'

/** wake-sessions.json in a folder of the test's own, removed after it. */
function sessionsFile(sessions: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-wake-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'wake-sessions.json')
  writeFileSync(file, JSON.stringify(sessions))
  return file
}
const FILE = {
  'w1:p2': {
    session: 's-bill',
    name: 'Billing',
    cwd: 'C:\\Work\\Проект x 50%',
    seen_at: 1000,
    slept_at: Date.UTC(2026, 9, 21, 8),
    profileDir: WORK,
    profile: 'work',
  },
  'w1:p3': { session: 's-run', name: 'Running', seen_at: 1000 },
  'w1:p4': { session: 's-exit', name: '', title: 'Notes', seen_at: 900, slept_at: 900, exited: true },
}
const BILLING: SleepingSession = {
  name: 'Billing',
  pane: 'w1:p2',
  session: 's-bill',
  workspace: '',
  slept_at: '2026-10-21T08:00:00.000Z',
  exited: false,
  profile: { dir: WORK, id: 'work' },
  fromFile: true,
}
const NOTES: SleepingSession = {
  name: 'Notes',
  pane: 'w1:p4',
  session: 's-exit',
  workspace: '',
  slept_at: '1970-01-01T00:00:00.900Z',
  exited: true,
  fromFile: true,
}
const FROM_FILE = [BILLING, NOTES]
const ANSWER = [{ name: 'Billing', pane: 'w1:p2', session: 's-bill', workspace: 'Work', slept_at: 'x', exited: false }]

/** A fetch whose answers the test hands out: each call waits for `answer` or `fail`. */
function fakeFetch() {
  const calls: { url: string; signal: AbortSignal | null }[] = []
  const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = []
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? null })
    return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))
  }) as typeof fetch
  return {
    fn,
    calls,
    answer(body: unknown, status = 200) {
      pending.shift()?.resolve(new Response(JSON.stringify(body), { status }))
    },
    fail(err: unknown) {
      pending.shift()?.reject(err)
    },
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const refused = () => Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })

test("the first call gives the file's list at once and asks; the next gives the answer", async () => {
  const f = fakeFetch()
  let now = 1_000_000
  const w = createBoardWake({ url: URL, sessionsFile: sessionsFile(FILE), fetch: f.fn, now: () => now })
  expect(w.mode).toBe('new')
  expect(await w.sleepers()).toEqual(FROM_FILE)
  expect(f.calls.map(c => c.url)).toEqual([`${URL}/sleeping`])
  expect(f.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  f.answer(ANSWER)
  await settle()
  expect(await w.sleepers()).toEqual(ANSWER)
  // Asked again only after 5 s, in the background: the last answer meanwhile.
  now += 4999
  expect(await w.sleepers()).toEqual(ANSWER)
  expect(f.calls).toHaveLength(1)
  now += 1
  expect(await w.sleepers()).toEqual(ANSWER)
  expect(f.calls).toHaveLength(2)
  f.answer([...ANSWER, { ...ANSWER[0], name: 'Two', session: 's-two' }])
  await settle()
  expect((await w.sleepers()).map(s => s.name)).toEqual(['Billing', 'Two'])
  // After a wake or a sleep the next call asks at once.
  w.forget()
  await w.sleepers()
  expect(f.calls).toHaveLength(3)
})

test('a wake that hangs never holds sleepers() up', async () => {
  const f = fakeFetch()
  let now = 1_000_000
  const w = createBoardWake({ url: URL, sessionsFile: sessionsFile(FILE), fetch: f.fn, now: () => now })
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    expect(await w.sleepers()).toEqual(FROM_FILE)
    expect(performance.now() - started).toBeLessThan(10)
    now += 6000
  }
  // One question at a time: the one that hangs is not asked again on top of itself.
  expect(f.calls).toHaveLength(1)
})

test("down or off: the file's sleepers, marked fromFile", async () => {
  const f = fakeFetch()
  let now = 1_000_000
  const file = sessionsFile(FILE)
  const w = createBoardWake({ url: URL, sessionsFile: file, fetch: f.fn, now: () => now })
  await w.sleepers()
  f.answer(ANSWER)
  await settle()
  expect(await w.sleepers()).toEqual(ANSWER)
  // Down: nothing listens.
  now += 5000
  await w.sleepers()
  f.fail(refused())
  await settle()
  expect(await w.sleepers()).toEqual(FROM_FILE)
  // Off: wake answers that it is stopping; another program on its port; neither is a list.
  for (const [body, status] of [
    [{ ok: false, error: 'wake is stopping' }, 503],
    [{ hello: 'world' }, 200],
  ] as const) {
    now += 5000
    await w.sleepers()
    f.answer(body, status)
    await settle()
    expect(await w.sleepers()).toEqual(FROM_FILE)
  }
  // The file as it is now, never written by the board.
  writeFileSync(file, JSON.stringify({ 'w1:p2': FILE['w1:p2'] }))
  expect(await w.sleepers()).toEqual([BILLING])
  expect(readdirSync(join(file, '..'))).toEqual(['wake-sessions.json'])
  // A broken file or none: nothing from it, and it stays as it was.
  writeFileSync(file, '{"w1:p2": ')
  expect(await w.sleepers()).toEqual([])
  expect(readdirSync(join(file, '..'))).toEqual(['wake-sessions.json'])
  rmSync(file)
  expect(await w.sleepers()).toEqual([])
})

test('reach: up, down (ECONNREFUSED), slow (timeout)', async () => {
  const f = fakeFetch()
  const w = createBoardWake({ url: URL, sessionsFile: sessionsFile({}), fetch: f.fn })
  const reach = async (settleWith: () => void) => {
    const r = w.reach()
    await settle()
    settleWith()
    return r
  }
  expect(await reach(() => f.answer({ pid: 4242, started: 'x', sessions: {}, telegram: { state: 'off' } }))).toBe('up')
  expect(f.calls.at(-1)?.url).toBe(`${URL}/status`)
  // The separate herdr-wake plugin's router, still on the port after it was uninstalled: no wake of
  // the board's (its /status has no Telegram state), so the board wakes the session itself.
  expect(await reach(() => f.answer({ pid: 4242, started: 'x', sessions: {} }))).toBe('down')
  expect(f.calls.at(-1)?.signal).toBeInstanceOf(AbortSignal)
  expect(await reach(() => f.fail(refused()))).toBe('down')
  expect(await reach(() => f.fail(new DOMException('The operation timed out.', 'TimeoutError')))).toBe('slow')
  // Another program on the port, or wake stopping: not wake answering.
  expect(await reach(() => f.answer({ hello: 'world' }))).toBe('down')
  expect(await reach(() => f.answer({ ok: false }, 503))).toBe('down')
  expect(await reach(() => f.answer({ pid: '1', sessions: {} }))).toBe('down')
})

test('Put to sleep goes to the board’s wake only: never to the separate plugin’s router left on the port', async () => {
  const f = fakeFetch()
  const w = createBoardWake({ url: URL, sessionsFile: sessionsFile({}), fetch: f.fn })
  const item = { name: 'Billing', pane: 'w1:p2', session: 's-bill' } as Item
  // The old router answers /status: refused, nothing posted.
  const refusedNow = w.sleep(item)
  await settle()
  f.answer({ pid: 4242, sessions: {} })
  expect(await refusedNow).toEqual({ ok: false, error: 'Sleep and wake is on but does not answer on port 23456' })
  expect(f.calls.map(c => c.url)).toEqual([`${URL}/status`])
  // The board's wake: its /status, then the sleep.
  const slept = w.sleep(item)
  await settle()
  f.answer({ pid: 4242, sessions: {}, telegram: { state: 'off' } })
  await settle()
  f.answer({ ok: true })
  expect(await slept).toEqual({ ok: true })
  expect(f.calls.map(c => c.url)).toEqual([`${URL}/status`, `${URL}/status`, `${URL}/sleep`])
})

test('one provider per url and file, so a forget() reaches the list the server and the scheduler share', () => {
  const file = sessionsFile({})
  expect(sharedBoardWake(URL, file)).toBe(sharedBoardWake(URL, file))
  expect(sharedBoardWake(URL, file)).not.toBe(sharedBoardWake('http://127.0.0.1:23457', file))
})

test("wake off: the old provider's list, completed by the file's sleepers it does not have", async () => {
  const asked: string[] = []
  const old: SleepProvider = {
    sleepers: async () => [{ name: 'Billing', pane: 'w1:p2', session: 's-bill', workspace: 'Work' }],
    forget: () => asked.push('forget'),
    wake: async item => {
      asked.push(`wake ${item.pane}`)
      return { ok: true }
    },
    sleep: async item => {
      asked.push(`sleep ${item.pane}`)
      return { ok: true }
    },
  }
  const w = withFileSleepers(old, sessionsFile(FILE))
  expect(await w.sleepers()).toEqual([{ name: 'Billing', pane: 'w1:p2', session: 's-bill', workspace: 'Work' }, NOTES])
  w.forget()
  const item = { pane: 'w1:p4', name: 'Notes' } as Parameters<SleepProvider['wake']>[0]
  expect(await w.wake(item)).toEqual({ ok: true })
  expect(await w.sleep(item)).toEqual({ ok: true })
  expect(asked).toEqual(['forget', 'wake w1:p4', 'sleep w1:p4'])
})
