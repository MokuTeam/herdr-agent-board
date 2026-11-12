// Shared threads on the wire (#394, docs/design/threads 11.1, core/team.ts readWork, services/
// team-hub.ts): a board with shared threads on says `work` in its hello, after the caps it said
// before; off, its hello is what it was. A post that carries an entry sends `work` only to a board
// that says `work`; any other gets the same message without the field, the text in it. What comes
// in with `work` is kept only while this board keeps shared threads and the message fits a thread
// it shares with the sender, and goes to the threads with the event; without the hooks the event is
// as it was. The hub passes the field on as signed.
import { afterEach, describe, expect, test } from 'bun:test'
import { readAllInbox } from '../../src/adapters/team-store.ts'
import {
  checkMessage,
  type Envelope,
  generateKey,
  type KeyPair,
  type Message,
  OUR_CAPS,
  ourCaps,
  readWork,
  type WorkBody,
} from '../../src/core/team.ts'
import { msgOf, question } from '../hub/harness.ts'
import { type FakeWs, handshake, type Setup, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

const RICH = ['threads', 'channels', 'replies']
const TID = '00000000-0000-4000-8000-0000000000a1'
const WORK: WorkBody = {
  n: 3,
  type: 'note',
  set: { status: 'done', summary: '217 rows mapped' },
  head: { key: 'atlas-13', title: 'Map the 2019 price columns', status: 'done', summary: '217 rows mapped', rev: 3 },
  auto: true,
}

describe('the field', () => {
  test('readWork takes a well formed entry and nothing else', () => {
    expect(readWork(WORK)).toEqual(WORK)
    const bad: unknown[] = [
      { ...WORK, extra: 1 },
      { ...WORK, n: 0 },
      { ...WORK, n: 1.5 },
      { ...WORK, type: 'chat' },
      { ...WORK, auto: false },
      { ...WORK, set: { status: 'finished' } },
      { ...WORK, set: { summary: 'x'.repeat(161) } },
      { ...WORK, set: { summary: 'right‮left' } },
      { ...WORK, set: { assignee: { peer: 'nobody' } } },
      { ...WORK, set: { assignee: { peer: `A${'a'.repeat(42)}`, agent: ' spaced ' } } },
      { ...WORK, set: { lane: 'other' } },
      { ...WORK, head: { ...WORK.head, rev: 2 } },
      { ...WORK, head: { ...WORK.head, key: 'Atlas 13' } },
      { ...WORK, head: { ...WORK.head, extra: 1 } },
    ]
    for (const b of bad) expect(readWork(b)).toBeNull()
    expect(readWork({ ...WORK, set: { assignee: null } })?.set).toEqual({ assignee: null })
  })

  test('a board reads work only in a topic; the hub relays it as signed', async () => {
    const A = await generateKey()
    const to = (await generateKey()).pub
    const thread = { id: TID, title: 'Map the 2019 price columns' }
    const ok = await question(A, to, 'done: 217 rows mapped', {
      body: { text: 'done: 217 rows mapped', thread, work: WORK },
    })
    expect(checkMessage(ok.payload, A.pub)).toMatchObject({ ok: true, msg: { body: { work: WORK } } })
    for (const body of [
      { text: 'x', work: WORK },
      { text: 'x', thread: { id: 'general' }, work: WORK },
      { text: 'x', thread, work: { ...WORK, n: -1 } },
    ]) {
      const env = await question(A, to, 'x', { body: body as Message['body'] })
      expect(checkMessage(env.payload, A.pub)).toMatchObject({ ok: false, code: 'bad_frame' })
      expect(checkMessage(env.payload, A.pub, 'relay').ok).toBe(true)
    }
  })

  test('the caps: off, what this board said before; on, `work` after them', () => {
    expect(ourCaps({ files: true, work: false })).toEqual(OUR_CAPS)
    expect(ourCaps({ files: false, work: false })).toEqual(OUR_CAPS.filter(c => c !== 'files'))
    expect(ourCaps({ files: true, work: true })).toEqual([...OUR_CAPS, 'work'])
  })
})

interface World {
  s: Setup
  ws: FakeWs
  me: string
  /** anna and ben keep shared threads; cleo's board is older. */
  A: KeyPair
  B: KeyPair
  C: KeyPair
  taken: { from: string; topic: string }[]
}

async function world(on: boolean | null, take = true): Promise<World> {
  const taken: World['taken'] = []
  const s = setup(
    { hub: 'ws://127.0.0.1:7443', name: 'me' },
    on === null
      ? {}
      : {
          work: {
            on: () => on,
            mayTake: m => {
              taken.push({ from: m.from, topic: m.topic })
              return take
            },
          },
        },
  )
  const [A, B, C] = [await generateKey(), await generateKey(), await generateKey()]
  s.svc.start()
  const { ws, me } = await handshake(s, [
    { peer: A.pub, name: 'anna', caps: [...RICH, 'work'] },
    { peer: B.pub, name: 'ben', caps: [...RICH, 'work'] },
    { peer: C.pub, name: 'cleo', caps: RICH },
  ])
  return { s, ws, me, A, B, C, taken }
}

const sent = (ws: FakeWs): Message[] => ws.of('send').map(f => msgOf((f as { env: Envelope }).env))

async function deliver(w: World, from: KeyPair, body: Message['body']): Promise<string> {
  const env = await question(from, w.me, body.text, { body }, new Date(w.s.clock.now()).toISOString())
  const before = w.ws.of('ack').length
  w.ws.recv({ t: 'deliver', env })
  await until(() => w.ws.of('ack').length > before, 'an ack')
  w.s.clock.skew(1000)
  return msgOf(env).id
}

describe('the hello', () => {
  test('without the hooks, or with shared threads off, the caps are what they were; on, `work` is said', async () => {
    for (const [on, has] of [
      [null, false],
      [false, false],
      [true, true],
    ] as const) {
      const w = await world(on)
      const caps = w.ws.of('hello')[0]?.caps ?? []
      expect(caps.includes('work')).toBe(has)
      expect(caps).toEqual(has ? [...OUR_CAPS, 'work'] : OUR_CAPS)
      stopAll()
    }
  })
})

describe('out', () => {
  test('a team post with an entry: `work` to the boards that keep shared threads, the text to every one, one id', async () => {
    const w = await world(true)
    const id = '00000000-0000-4000-8000-0000000000e1'
    const r = await w.s.svc.post(
      { to: 'team', thread: { id: TID, title: 'Map the 2019 price columns' } },
      'done: 217 rows mapped',
      { by: 'ui' },
      undefined,
      { id, body: WORK, open: true },
    )
    expect(r).toMatchObject({ ok: true, id, thread: `team/${TID}` })
    const copies = sent(w.ws)
    const of = (k: KeyPair) => copies.find(m => m.to === k.pub)?.body
    expect(of(w.A)?.work).toEqual(WORK)
    expect(of(w.B)?.work).toEqual(WORK)
    expect(of(w.C)?.work).toBeUndefined()
    expect(of(w.C)?.text).toBe('done: 217 rows mapped')
    expect(of(w.C)?.thread).toMatchObject({ id: TID, group: true })
    expect(copies[0]?.id).toBe(id)
    // The next entry goes in the topic the first one opened.
    const r2 = await w.s.svc.post({ to: w.A.pub, thread: { id: TID } }, 'x', { by: 'ui' }, undefined, {
      id: '00000000-0000-4000-8000-0000000000e2',
      body: { ...WORK, n: 4, head: { ...WORK.head, rev: 4 } },
    })
    // A pair's topic is not the team's: without `open` it must exist in that pair.
    expect(r2).toEqual({ ok: false, error: 'thread' })
  })

  test('a post without an entry is what it was', async () => {
    const w = await world(true)
    await w.s.svc.post({ to: w.A.pub, thread: { title: 'Lunch' } }, 'noon?', { by: 'ui' })
    expect(sent(w.ws)[0]?.body.work).toBeUndefined()
  })
})

describe('in', () => {
  const ref = { id: TID, title: 'Map the 2019 price columns' }

  test('shared threads on and the entry fits: kept, and the event carries it for the threads', async () => {
    const w = await world(true)
    const id = await deliver(w, w.A, { text: 'done: 217 rows mapped', thread: ref, work: WORK })
    expect(w.taken).toEqual([{ from: w.A.pub, topic: `${w.A.pub}/${TID}` }])
    expect((readAllInbox()[w.A.pub] ?? []).map(i => i.id)).toEqual([id])
    const e = w.s.inbound.at(-1)
    expect(e?.work).toMatchObject({ id, text: 'done: 217 rows mapped', ref, body: WORK })
    // A plain topic message comes with its words for the threads too, and no `work`.
    await deliver(w, w.C, { text: 'thanks', thread: ref })
    expect(w.s.inbound.at(-1)?.work).toMatchObject({ text: 'thanks', ref })
    expect(w.s.inbound.at(-1)?.work?.body).toBeUndefined()
  })

  test('an entry that does not fit, or any while shared threads are off: dropped and acked, never kept', async () => {
    for (const [on, take] of [
      [true, false],
      [false, true],
      [null, true],
    ] as const) {
      const w = await world(on, take)
      await deliver(w, w.A, { text: 'done', thread: ref, work: WORK })
      expect(readAllInbox()[w.A.pub] ?? []).toEqual([])
      expect(w.s.inbound).toEqual([])
      stopAll()
    }
  })

  test('without the hooks a topic message comes as it did: no `work` in the event', async () => {
    const w = await world(null)
    await deliver(w, w.A, { text: 'hello', thread: ref })
    const e = w.s.inbound.at(-1)
    expect(e && Object.keys(e).sort()).toEqual(['fresh', 'from', 'held', 'id', 'thread'])
  })
})
