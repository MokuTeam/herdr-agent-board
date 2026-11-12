// The NanoClaw half of the assistant bridge (#384, phase 1 #386): core.ts against a fake bridge on
// a real unix socket and a fake NanoClaw. The socket's path is kept short: Windows refuses AF_UNIX
// paths past about 100 characters.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type HubCore,
  type HubHost,
  type HubRow,
  startHubCore,
  type WriteOutcome,
} from '../../assistant-bridge/nanoclaw/src/modules/hub/core.ts'
import {
  type BridgeFrame,
  encodeFrame,
  type Location,
  type ModuleFrame,
  parseModuleFrame,
  takeLines,
} from '../../assistant-bridge/nanoclaw/src/modules/hub/protocol.ts'

let counter = 0
const shortPath = (): string => join(tmpdir(), `nch-${process.pid}-${++counter}.sock`)

interface FakeBridge {
  path: string
  frames: ModuleFrame[]
  hellos: number
  send(f: BridgeFrame): void
  take<T extends ModuleFrame['t']>(t: T, ms?: number): Promise<Extract<ModuleFrame, { t: T }>>
  /** Drops the module's connection, as a bridge restart does. */
  kick(): void
  close(): Promise<void>
}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function fakeBridge(opts: { welcome?: boolean } = {}): Promise<FakeBridge> {
  const path = shortPath()
  rmSync(path, { force: true })
  let conn: Socket | null = null
  const waiters = new Set<() => void>()
  const b: FakeBridge = {
    path,
    frames: [],
    hellos: 0,
    send: f => conn?.write(encodeFrame(f)),
    take: async (t, ms = 2000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const i = b.frames.findIndex(f => f.t === t)
        if (i >= 0) return b.frames.splice(i, 1)[0] as never
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`no ${t} frame; have ${b.frames.map(f => f.t).join(',') || 'none'}`)
        await new Promise<void>(res => {
          waiters.add(res)
          setTimeout(res, left)
        })
      }
    },
    kick: () => conn?.destroy(),
    close: () =>
      new Promise<void>(res => {
        conn?.destroy()
        server.close(() => {
          rmSync(path, { force: true })
          res()
        })
      }),
  }
  const server = createServer(s => {
    conn = s
    let buf = ''
    s.setEncoding('utf8')
    s.on('error', () => {})
    s.on('data', (chunk: string) => {
      const split = takeLines(buf, chunk)
      if (!split) return
      buf = split.rest
      for (const line of split.lines) {
        const f = parseModuleFrame(line)
        if (!f) continue
        if (f.t === 'hello') {
          b.hellos++
          if (opts.welcome !== false) s.write(encodeFrame({ t: 'welcome', v: 1 }))
        }
        b.frames.push(f)
        for (const w of waiters) w()
        waiters.clear()
      }
    })
  })
  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(path, () => res())
  })
  cleanups.push(() => b.close())
  return b
}

function fakeHost(over: Partial<HubHost> = {}) {
  const rows = new Map<string, HubRow & { at: Location }>()
  const wakes: Location[] = []
  const notices: { at: Location; text: string }[] = []
  const logs: string[] = []
  const host: HubHost = {
    topics: () => [{ id: 'telegram:1' }, { id: 'telegram:1:7', name: 'hub' }],
    write: (at, row): WriteOutcome => {
      if (at === 'host:nowhere') return 'unknown'
      if (rows.has(row.id)) return 'exists'
      rows.set(row.id, { ...row, at })
      return 'written'
    },
    wake: at => {
      wakes.push(at)
    },
    notify: async (at, text) => {
      notices.push({ at, text })
    },
    log: (level, msg) => {
      logs.push(`${level} ${msg}`)
    },
    ...over,
  }
  return { host, rows, wakes, notices, logs }
}

function start(path: string, host: HubHost, callTimeoutMs = 2000): HubCore {
  const core = startHubCore({ socketPath: path, host, backoffMs: () => 20, callTimeoutMs })
  if (!core) throw new Error('the core did not start')
  cleanups.push(() => core.stop())
  return core
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

const INBOX: Location = 'host:telegram:1:7'

describe('the NanoClaw hub module', () => {
  test('without a socket path nothing starts', () => {
    let dialed = 0
    const { host } = fakeHost()
    const dial = (): never => {
      dialed++
      throw new Error('no')
    }
    expect(startHubCore({ socketPath: undefined, host, dial })).toBeNull()
    expect(startHubCore({ socketPath: '', host, dial })).toBeNull()
    expect(dialed).toBe(0)
  })

  test('the hello carries the topics, and the welcome connects it', async () => {
    const b = await fakeBridge()
    const { host } = fakeHost()
    const core = start(b.path, host)
    const hello = await b.take('hello')
    expect(hello.v).toBe(1)
    expect(hello.topics).toEqual([{ id: 'telegram:1' }, { id: 'telegram:1:7', name: 'hub' }])
    await until(() => core.connected())
  })

  test('a deliver writes the row, wakes only for trigger 1, then confirms', async () => {
    const b = await fakeBridge()
    const h = fakeHost()
    const core = start(b.path, h.host)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: '[hub · anna (owner)] hi' })
    expect((await b.take('confirm')).id).toBe('m1')
    expect(h.rows.get('m1')).toEqual({ id: 'm1', text: '[hub · anna (owner)] hi', trigger: 1, at: INBOX })
    expect(h.wakes).toEqual([INBOX])

    b.send({ t: 'deliver', id: 'm2', at: INBOX, trigger: 0, text: 'context' })
    expect((await b.take('confirm')).id).toBe('m2')
    expect(h.rows.get('m2')?.trigger).toBe(0)
    expect(h.wakes).toEqual([INBOX])
  })

  test('a deliver sent again confirms without a second row or a second wake', async () => {
    const b = await fakeBridge()
    const h = fakeHost()
    const core = start(b.path, h.host)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: 'hi' })
    await b.take('confirm')
    let writes = 0
    const write = h.host.write
    h.host.write = (at, row) => {
      writes++
      return write(at, row)
    }
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: 'hi' })
    expect((await b.take('confirm')).id).toBe('m1')
    expect(writes).toBe(1)
    expect(h.rows.size).toBe(1)
    expect(h.wakes).toEqual([INBOX])
  })

  test('a deliver for a place NanoClaw does not have is confirmed and dropped', async () => {
    const b = await fakeBridge()
    const h = fakeHost()
    const core = start(b.path, h.host)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm9', at: 'host:nowhere', trigger: 1, text: 'hi' })
    expect((await b.take('confirm')).id).toBe('m9')
    expect(h.wakes).toEqual([])
    expect(h.logs.some(l => l.startsWith('warn hub: no session'))).toBe(true)
  })

  test('a schedule writes a row due at its time and wakes nothing now', async () => {
    const b = await fakeBridge()
    const h = fakeHost()
    const core = start(b.path, h.host)
    await until(() => core.connected())
    const when = '2026-11-13T09:00:00.000Z'
    b.send({ t: 'schedule', id: 's1', at: INBOX, when, text: '[hub] messages wait. Read: hub_inbox' })
    expect((await b.take('confirm')).id).toBe('s1')
    expect(h.rows.get('s1')).toEqual({
      id: 's1',
      text: '[hub] messages wait. Read: hub_inbox',
      trigger: 1,
      processAfter: when,
      at: INBOX,
    })
    expect(h.wakes).toEqual([])
  })

  test('a notice goes to the topic once, also when the bridge sends it again', async () => {
    const b = await fakeBridge()
    const h = fakeHost()
    const core = start(b.path, h.host)
    await until(() => core.connected())
    b.send({ t: 'notice', id: 'n1', at: INBOX, text: 'new hub topic from anna: "Trip"' })
    expect((await b.take('confirm')).id).toBe('n1')
    b.send({ t: 'notice', id: 'n1', at: INBOX, text: 'new hub topic from anna: "Trip"' })
    expect((await b.take('confirm')).id).toBe('n1')
    expect(h.notices).toEqual([{ at: INBOX, text: 'new hub topic from anna: "Trip"' }])
  })

  test('a tool call goes to the bridge with its place and comes back with the answer', async () => {
    const b = await fakeBridge()
    const { host } = fakeHost()
    const core = start(b.path, host)
    const answer = core.call('host:telegram:1:9', 'send', { to: 'anna', title: 'Trip', text: 'hello' })
    const call = await b.take('call')
    expect(call).toMatchObject({
      from: 'host:telegram:1:9',
      op: 'send',
      args: { to: 'anna', title: 'Trip', text: 'hello' },
    })
    b.send({ t: 'result', req: call.req, ok: true, text: 'ok · sent to anna in thread 1a2b3c4d' })
    expect(await answer).toEqual({ ok: true, text: 'ok · sent to anna in thread 1a2b3c4d' })

    const inbox = core.call(INBOX, 'inbox', { full: true })
    const call2 = await b.take('call')
    expect(call2).toMatchObject({ op: 'inbox', args: { full: true } })
    b.send({ t: 'result', req: call2.req, ok: true, text: 'nothing waits' })
    expect((await inbox).text).toBe('nothing waits')
  })

  test('arguments the tools do not take are refused without asking the bridge', async () => {
    const b = await fakeBridge()
    const { host } = fakeHost()
    const core = start(b.path, host)
    await until(() => core.connected())
    const bad = await core.call(INBOX, 'send', { text: 5 } as unknown as { text: string })
    expect(bad.ok).toBe(false)
    expect(b.frames.filter(f => f.t === 'call')).toEqual([])
  })

  test('a bridge that does not answer a call gives a line, not a hang', async () => {
    const b = await fakeBridge()
    const { host } = fakeHost()
    const core = start(b.path, host, 150)
    const answer = await core.call(INBOX, 'inbox', {})
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('no answer from the hub bridge')
    expect(b.frames.some(f => f.t === 'call')).toBe(true)
  })

  test('with no bridge to talk to, a call says it is not connected', async () => {
    const { host } = fakeHost()
    const core = start(shortPath(), host, 150)
    const answer = await core.call(INBOX, 'inbox', {})
    expect(answer).toEqual({ ok: false, text: 'not sent: the hub bridge is not connected' })
  })

  test('after the bridge restarts it reconnects, and what the bridge sends again lands once', async () => {
    const b = await fakeBridge()
    const h = fakeHost()
    const core = start(b.path, h.host)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: 'hi' })
    await b.take('confirm')
    b.kick()
    await until(() => b.hellos === 2)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: 'hi' })
    expect((await b.take('confirm')).id).toBe('m1')
    expect(h.rows.size).toBe(1)
    expect(h.wakes).toEqual([INBOX])
  })

  test('a write that fails is not confirmed: the connection drops and the frame sent again is written', async () => {
    const b = await fakeBridge()
    let fail = true
    const h = fakeHost()
    const write = h.host.write
    h.host.write = (at, row) => {
      if (fail) {
        fail = false
        throw new Error('database is locked')
      }
      return write(at, row)
    }
    const core = start(b.path, h.host)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: 'hi' })
    await until(() => b.hellos === 2)
    expect(b.frames.some(f => f.t === 'confirm')).toBe(false)
    await until(() => core.connected())
    b.send({ t: 'deliver', id: 'm1', at: INBOX, trigger: 1, text: 'hi' })
    expect((await b.take('confirm')).id).toBe('m1')
    expect(h.rows.get('m1')?.text).toBe('hi')
    expect(h.logs.some(l => l.startsWith('error hub: a frame from the bridge failed'))).toBe(true)
  })

  test('stop ends it: no reconnect, and a call is answered at once', async () => {
    const b = await fakeBridge()
    const { host } = fakeHost()
    const core = start(b.path, host)
    await until(() => core.connected())
    core.stop()
    expect(core.connected()).toBe(false)
    await new Promise(r => setTimeout(r, 80))
    expect(b.hellos).toBe(1)
    expect((await core.call(INBOX, 'inbox', {})).ok).toBe(false)
  })
})

test("the module's protocol.ts is the bridge's, byte for byte", () => {
  const bridge = readFileSync(join(import.meta.dir, '../../assistant-bridge/src/protocol.ts'))
  const module = readFileSync(join(import.meta.dir, '../../assistant-bridge/nanoclaw/src/modules/hub/protocol.ts'))
  expect(module.equals(bridge)).toBe(true)
})
