// The bridge end to end (#386): the real hub in this process (test/hub/harness.ts), the bridge on
// its own fake clock, and a fake NanoClaw module on the bridge's unix socket. The socket path is
// short and under the system temp: Windows refuses AF_UNIX paths past about 100 characters.
import { afterEach, describe, expect, test } from 'bun:test'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Bridge, createBridge } from '../../assistant-bridge/src/bridge.ts'
import { type BridgeConfig, parseConfig } from '../../assistant-bridge/src/config.ts'
import {
  type BridgeFrame,
  encodeFrame,
  type ModuleFrame,
  parseBridgeFrame,
  takeLines,
} from '../../assistant-bridge/src/protocol.ts'
import { openStore, type Store } from '../../assistant-bridge/src/store.ts'
import type { KeyPair, Message } from '../../src/core/team.ts'
import { type Client, fakeClock, type Harness, keys, msgOf, question, startHarness } from '../hub/harness.ts'

const INBOX_ID = 'telegram:100:7'
const TRAVEL_ID = 'telegram:100:9'
const TOPICS = [
  { id: INBOX_ID, name: 'hub' },
  { id: TRAVEL_ID, name: 'travel' },
]
const BOARD_CAPS = ['threads', 'channels', 'replies']

class FakeModule {
  frames: BridgeFrame[] = []
  private sock: Socket
  private rest = ''
  private waiters: Array<() => void> = []
  ready: Promise<void>
  constructor(path: string) {
    this.sock = connect(path)
    this.sock.setEncoding('utf8')
    this.ready = new Promise((res, rej) => {
      this.sock.once('connect', () => res())
      this.sock.once('error', rej)
    })
    this.sock.on('data', (chunk: string) => {
      const got = takeLines(this.rest, chunk)
      if (!got) return
      this.rest = got.rest
      for (const l of got.lines) {
        const f = parseBridgeFrame(l)
        if (f) this.frames.push(f)
      }
      for (const w of this.waiters.splice(0)) w()
    })
  }
  send(f: ModuleFrame): void {
    this.sock.write(encodeFrame(f))
  }
  async take<T extends BridgeFrame['t']>(t: T, ms = 3000): Promise<Extract<BridgeFrame, { t: T }>> {
    const deadline = Date.now() + ms
    for (;;) {
      const i = this.frames.findIndex(f => f.t === t)
      if (i >= 0) return this.frames.splice(i, 1)[0] as Extract<BridgeFrame, { t: T }>
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ${t} frame; have ${this.frames.map(f => f.t).join(',') || 'none'}`)
      await new Promise<void>(res => {
        this.waiters.push(res)
        setTimeout(res, left)
      })
    }
  }
  /** Lets what is in flight arrive, then gives the frames of a type not yet taken. */
  async none<T extends BridgeFrame['t']>(t: T, ms = 150): Promise<Extract<BridgeFrame, { t: T }>[]> {
    await new Promise(r => setTimeout(r, ms))
    return this.frames.filter(f => f.t === t) as Extract<BridgeFrame, { t: T }>[]
  }
  async hello(topics = TOPICS): Promise<void> {
    await this.ready
    this.send({ t: 'hello', v: 1, topics })
    await this.take('welcome')
  }
  async call(
    from: string,
    op: 'send' | 'inbox',
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    const req = crypto.randomUUID()
    this.send({ t: 'call', req, from, op, args } as ModuleFrame)
    for (;;) {
      const r = await this.take('result')
      if (r.req === req) return { ok: r.ok, text: r.text }
    }
  }
  close(): void {
    this.sock.destroy()
  }
}

interface World {
  h: Harness
  anna: Client
  ben: Client
  annaKey: KeyPair
  benKey: KeyPair
  bridgeKey: KeyPair
  bridge: Bridge
  store: Store
  clock: ReturnType<typeof fakeClock>
  mod: FakeModule
  socketPath: string
  logs: string[]
}

let world: World | null = null
afterEach(async () => {
  if (!world) return
  world.mod.close()
  await world.bridge.stop()
  world.store.close()
  world.h.stop()
  world = null
})

const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

async function setup(over: Record<string, unknown> = {}): Promise<World> {
  const h = await startHarness()
  const [annaKey, benKey, bridgeKey] = (await keys(3)) as [KeyPair, KeyPair, KeyPair]
  const anna = await h.join(annaKey, 'anna', undefined, BOARD_CAPS)
  const ben = await h.join(benKey, 'ben', undefined, BOARD_CAPS)
  const first = await h.join(bridgeKey, 'anna-assistant')
  first.close()
  await h.offline(bridgeKey.pub)
  const socketPath = join(tmpdir(), `ab-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`)
  const parsed = parseConfig(
    {
      hub: h.url,
      name: 'anna-assistant',
      socket: socketPath,
      allow: [{ name: 'anna', role: 'owner' }],
      inbox: { topic: 'hub' },
      publish: [{ alias: 'travel', at: 'host:travel', about: 'trips' }],
      wake: { gapSec: 0 },
      ...over,
    },
    tmpdir(),
  )
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const cfg: BridgeConfig = parsed.cfg
  const store = openStore(':memory:')
  const clock = fakeClock(Date.parse('2026-11-12T10:00:00Z'))
  const logs: string[] = []
  const bridge = createBridge({ cfg, store, key: bridgeKey, clock, log: l => logs.push(l) })
  await bridge.start()
  await until(() => bridge.status().link === 'online' && store.pins().length > 0)
  const mod = new FakeModule(socketPath)
  await mod.hello()
  world = { h, anna, ben, annaKey, benKey, bridgeKey, bridge, store, clock, mod, socketPath, logs }
  return world
}

let n = 0
const id = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`
const TOPIC = 'aaaaaaaa-1111-4111-8111-111111111111'

/** Sends a question from `who` to the bridge; `body` is the body's fields besides the text. */
async function say(w: World, who: 'anna' | 'ben', text: string, body: Partial<Message['body']> = {}): Promise<string> {
  const key = who === 'anna' ? w.annaKey : w.benKey
  const msgId = id()
  const env = await question(key, w.bridgeKey.pub, text, { id: msgId, body: { text, ...body } })
  ;(who === 'anna' ? w.anna : w.ben).send({ t: 'send', env })
  return msgId
}

describe('an inbox topic that is not there yet', () => {
  test('what is for the inbox waits until the module lists the topic, then goes there', async () => {
    const w = await setup({ inbox: { topic: 'Inbox' } })
    await say(w, 'anna', 'are you there?')
    await say(w, 'anna', 'new topic', { thread: { id: TOPIC, title: 'Plans' } })
    expect(await w.mod.none('deliver', 200)).toEqual([])
    expect(await w.mod.none('notice')).toEqual([])
    // The owner makes the topic and writes in it; the bot records it; the module says hello again.
    w.mod.close()
    await until(() => !w.bridge.status().module)
    w.mod = new FakeModule(w.socketPath)
    await w.mod.hello([...TOPICS, { id: 'telegram:100:11', name: 'inbox' }])
    const first = await w.mod.take('deliver')
    expect(first.at).toBe('host:telegram:100:11')
    expect(first.text).toEndWith('are you there?')
    expect((await w.mod.take('notice')).at).toBe('host:telegram:100:11')
    expect((await w.mod.take('deliver')).at).toBe('host:telegram:100:11')
  })

  test('a thread id with a colon is taken as it is', async () => {
    const w = await setup({ inbox: { topic: 'telegram:100:12' } })
    await say(w, 'anna', 'by id')
    expect((await w.mod.take('deliver')).at).toBe('host:telegram:100:12')
  })
})

describe('from the board to the assistant', () => {
  test('a pair message wakes the inbox topic, under the bridge header, and is acked', async () => {
    const w = await setup()
    const msgId = await say(w, 'anna', 'Can you check the hotel prices?')
    const d = await w.mod.take('deliver')
    expect(d.at).toBe(`host:${INBOX_ID}`)
    expect(d.trigger).toBe(1)
    expect(d.text).toBe(
      `[hub · anna (owner) · thread general:anna · msg ${msgId.slice(0, 8)}]\nCan you check the hotel prices?`,
    )
    w.mod.send({ t: 'confirm', id: d.id })
    const st = await w.anna.take('state')
    expect(st.id).toBe(msgId)
    await until(() => w.store.openJobs().length === 0)
  })

  test('a new topic tells the owner its title in the inbox topic, never its text', async () => {
    const w = await setup()
    await say(w, 'anna', 'secret plan details', {
      via: 'agent',
      agent: 'planner',
      thread: { id: TOPIC, title: 'Hotel options' },
    })
    const note = await w.mod.take('notice')
    expect(note.at).toBe(`host:${INBOX_ID}`)
    expect(note.text).toBe('hub: new topic from anna: "Hotel options"')
    const d = await w.mod.take('deliver')
    expect(d.text).toStartWith('[hub · anna (owner) · agent planner · thread aaaaaaaa "Hotel options"')
  })

  test('team traffic waits for the scheduled read and hub_inbox gives it once', async () => {
    const w = await setup()
    await say(w, 'anna', 'standup notes for everyone', { thread: { id: 'general', group: true } })
    const s = await w.mod.take('schedule')
    expect(s.at).toBe(`host:${INBOX_ID}`)
    expect(s.when).toBe('2026-11-12T18:00:00.000Z')
    expect(s.text).not.toContain('standup')
    expect(await w.mod.none('deliver')).toEqual([])
    // A second team message does not schedule a second read.
    await say(w, 'anna', 'more notes', { thread: { id: 'general', group: true } })
    expect(await w.mod.none('schedule')).toEqual([])
    const r = await w.mod.call(`host:${INBOX_ID}`, 'inbox', {})
    expect(r.ok).toBe(true)
    expect(r.text).toContain('[hub · team · anna (owner) · thread team')
    expect(r.text).toContain('standup notes for everyone')
    expect(r.text).toContain('more notes')
    expect((await w.mod.call(`host:${INBOX_ID}`, 'inbox', {})).text).toBe('nothing waits in the hub inbox')
  })

  test('a mention in team traffic wakes', async () => {
    const w = await setup()
    await say(w, 'anna', 'what do you think, @anna-assistant?', { thread: { id: 'general', group: true } })
    const d = await w.mod.take('deliver')
    expect(d.trigger).toBe(1)
  })

  test('a peer not on the allow list reaches nothing and gets one line, once', async () => {
    const w = await setup()
    await say(w, 'ben', 'hi assistant, do my taxes')
    const back = await w.ben.take('deliver')
    const m = msgOf(back.env)
    expect(m.body.text).toBe("This assistant takes messages from anna's board only.")
    expect(m.body.via).toBe('agent')
    expect(m.body.agent).toBe('bridge')
    await say(w, 'ben', 'hello?')
    expect(await w.mod.none('deliver')).toEqual([])
    expect(await w.mod.none('notice')).toEqual([])
    await new Promise(r => setTimeout(r, 100))
    expect(w.ben.frames.filter(f => f.t === 'deliver')).toEqual([])
  })

  test('an allowed name pinned to another key in the config does not let that name in', async () => {
    const w = await setup({ allow: [{ name: 'anna', role: 'owner', peer: 'B'.repeat(43) }] })
    await say(w, 'anna', 'it is me')
    expect(await w.mod.none('deliver', 200)).toEqual([])
  })

  test('the loop pause batches the thread and tells the owner once', async () => {
    const w = await setup({ loop: 2 })
    const agentBody = { via: 'agent' as const, agent: 'planner', thread: { id: TOPIC, title: 'Ping pong' } }
    await say(w, 'anna', 'one', agentBody)
    await w.mod.take('notice')
    expect((await w.mod.take('deliver')).trigger).toBe(1)
    await say(w, 'anna', 'two', agentBody)
    const pause = await w.mod.take('notice')
    expect(pause.text).toStartWith('hub: loop pause in thread aaaaaaaa after 2 agent messages')
    expect(await w.mod.none('deliver')).toEqual([])
    await say(w, 'anna', 'three', agentBody)
    expect(await w.mod.none('notice')).toEqual([])
    // A person writes: the run ends and the thread wakes again.
    await say(w, 'anna', 'I am here', { thread: { id: TOPIC, title: 'Ping pong' } })
    expect((await w.mod.take('deliver')).trigger).toBe(1)
  })

  test('close messages share one wake: the second waits out the gap', async () => {
    const w = await setup({ wake: { gapSec: 60 } })
    await say(w, 'anna', 'first')
    expect((await w.mod.take('deliver')).text).toEndWith('first')
    await say(w, 'anna', 'second')
    expect(await w.mod.none('deliver')).toEqual([])
    w.clock.tick(60_000)
    expect((await w.mod.take('deliver')).text).toEndWith('second')
  })

  test('what came while the module was away is delivered when it says hello again', async () => {
    const w = await setup()
    w.mod.close()
    await until(() => !w.bridge.status().module)
    const msgId = await say(w, 'anna', 'while you were out')
    await until(() => w.store.hasMessage(msgId))
    w.mod = new FakeModule(w.socketPath)
    await w.mod.hello()
    const d = await w.mod.take('deliver')
    expect(d.text).toEndWith('while you were out')
    // Not confirmed: the next hello brings it again.
    w.mod.close()
    await until(() => !w.bridge.status().module)
    w.mod = new FakeModule(w.socketPath)
    await w.mod.hello()
    const again = await w.mod.take('deliver')
    expect(again.id).toBe(d.id)
  })
})

describe('from the assistant back to the board', () => {
  test('hub_send from a topic opens a topic with the owner, and the answer comes back to that topic', async () => {
    const w = await setup()
    const r = await w.mod.call(`host:${TRAVEL_ID}`, 'send', {
      to: 'anna',
      title: 'Hotel options',
      text: 'Three options, details inside.',
    })
    expect(r.ok).toBe(true)
    const got = msgOf((await w.anna.take('deliver')).env)
    expect(got.body.text).toBe('Three options, details inside.')
    expect(got.body.via).toBe('agent')
    expect(got.body.agent).toBe('travel')
    expect(got.body.thread?.title).toBe('Hotel options')
    const topic = got.body.thread?.id ?? ''
    expect(r.text).toBe(`ok · sent to anna in thread ${topic.slice(0, 8)}`)
    // anna's board answers in that topic: it goes to the travel topic, not the inbox.
    await say(w, 'anna', 'Take the second one', { thread: { id: topic, title: 'Hotel options' }, replyTo: got.id })
    const d = await w.mod.take('deliver')
    expect(d.at).toBe(`host:${TRAVEL_ID}`)
    expect(d.text).toContain(`(answers ${got.id.slice(0, 8)})`)
    expect(await w.mod.none('notice')).toEqual([])
  })

  test('hub_send without a thread answers the thread that brought the newest message', async () => {
    const w = await setup()
    await say(w, 'anna', 'question in a topic', { thread: { id: TOPIC, title: 'Budget' } })
    await w.mod.take('deliver')
    const r = await w.mod.call(`host:${INBOX_ID}`, 'send', { text: 'answer' })
    expect(r).toEqual({ ok: true, text: 'ok · sent to anna in thread aaaaaaaa' })
    const got = msgOf((await w.anna.take('deliver')).env)
    expect(got.body.thread?.id).toBe(TOPIC)
    expect(got.body.agent).toBe('host')
  })

  test('hub_send refuses secrets, the team chat, peers off the list and an empty inbox topic', async () => {
    const w = await setup()
    const from = `host:${INBOX_ID}`
    expect(
      (await w.mod.call(from, 'send', { to: 'anna', text: 'key sk-abcdefghijklmnopqrstuvwxyz' })).text,
    ).toStartWith('not sent: it looks like it carries an API key')
    expect((await w.mod.call(from, 'send', { to: 'team', text: 'hi all' })).ok).toBe(false)
    expect((await w.mod.call(from, 'send', { to: 'ben', text: 'hi' })).text).toBe(
      "not sent: ben is not on the bridge's allow list",
    )
    expect((await w.mod.call(from, 'send', { text: 'to whom?' })).ok).toBe(false)
    expect((await w.mod.call(from, 'send', { to: 'anna', title: '', text: 'x' })).ok).toBe(false)
    await new Promise(r => setTimeout(r, 100))
    expect(w.anna.frames.filter(f => f.t === 'deliver')).toEqual([])
  })

  test('the same text twice in a thread within minutes is refused', async () => {
    const w = await setup()
    const from = `host:${INBOX_ID}`
    expect((await w.mod.call(from, 'send', { to: 'anna', text: 'done: the report is ready' })).ok).toBe(true)
    expect((await w.mod.call(from, 'send', { to: 'anna', text: 'done: the report is ready' })).text).toBe(
      'not sent: the same text went to that thread a few minutes ago',
    )
  })
})
