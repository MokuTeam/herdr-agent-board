// Replies to a message (#370): a board whose caps say `replies` gets the answered message's id in
// the signed body (`replyTo`), and every copy of a team post the post's id (`post`), so a reply to
// a team post names one message on every member's board; a board without the cap gets the plain
// body. A thread's lines name what each answers as a line of that thread, this board's copy of a
// team post among them; a copy cannot take over the name of a message that came before it. The
// list gets each thread's latest message. The hub relays the new fields as signed.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  checkMessage,
  type Envelope,
  GENERAL,
  generateKey,
  type KeyPair,
  type Message,
  OUR_CAPS,
} from '../../src/core/team.ts'
import { LAST_CHARS } from '../../src/services/team-hub.ts'
import { msgOf, question } from '../hub/harness.ts'
import { type FakeWs, handshake, type Setup, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

const RICH = ['threads', 'channels', 'replies']
const TEAM_GENERAL = { id: GENERAL, group: true as const }

interface World {
  s: Setup
  ws: FakeWs
  me: string
  /** anna and ben read replies; cleo's board is older: threads and channels only. */
  A: KeyPair
  B: KeyPair
  C: KeyPair
}

async function world(): Promise<World> {
  const s = setup({ hub: 'ws://127.0.0.1:7443', name: 'me' })
  const [A, B, C] = [await generateKey(), await generateKey(), await generateKey()]
  s.svc.start()
  const { ws, me } = await handshake(s, [
    { peer: A.pub, name: 'anna', caps: RICH },
    { peer: B.pub, name: 'ben', caps: RICH },
    { peer: C.pub, name: 'cleo', caps: ['threads', 'channels'] },
  ])
  return { s, ws, me, A, B, C }
}

const sent = (ws: FakeWs): Message[] => ws.of('send').map(f => msgOf((f as { env: Envelope }).env))

/** A message from a peer, delivered and acked; its id. */
async function deliver(w: World, from: KeyPair, text: string, body: Partial<Message['body']> = {}): Promise<string> {
  const env = await question(
    from,
    w.me,
    text,
    { body: { text, ...body } as Message['body'] },
    new Date(w.s.clock.now()).toISOString(),
  )
  const before = w.ws.of('ack').length
  w.ws.recv({ t: 'deliver', env })
  await until(() => w.ws.of('ack').length > before, 'an ack')
  w.s.clock.skew(1000)
  return msgOf(env).id
}

const lineOf = (w: World, key: string, text: string) => w.s.svc.threadLines(key).find(l => l.text === text)

describe('the cap', () => {
  test('this board says replies in its hello, beside threads and channels', () => {
    expect(OUR_CAPS).toEqual(['threads', 'channels', 'replies'])
  })

  test('a board reads replyTo and post as message ids, and refuses anything else; the hub relays them as signed', async () => {
    const A = await generateKey()
    const to = (await generateKey()).pub
    const id = '00000000-0000-4000-8000-0000000000aa'
    const ok = await question(A, to, 'yes', { body: { text: 'yes', replyTo: id, post: id } })
    expect(checkMessage(ok.payload, A.pub)).toMatchObject({ ok: true, msg: { body: { replyTo: id, post: id } } })
    for (const bad of [{ replyTo: 'nope' }, { post: 'x' }, { replyTo: 7 }]) {
      const env = await question(A, to, 'yes', { body: { text: 'yes', ...bad } as never })
      expect(checkMessage(env.payload, A.pub)).toMatchObject({ ok: false, code: 'bad_frame' })
      expect(checkMessage(env.payload, A.pub, 'relay').ok).toBe(true)
    }
  })
})

describe('a reply over the wire', () => {
  test('in a pair: replyTo in the signed body to a board with the cap; the line names what it answers', async () => {
    const w = await world()
    const q = await deliver(w, w.A, 'which branch?')
    const r = await w.s.svc.send(w.A.pub, 'main', undefined, q)
    expect(r.ok).toBe(true)
    const [msg] = sent(w.ws)
    expect(msg?.body).toEqual({ text: 'main', replyTo: q })
    expect(lineOf(w, `${w.A.pub}/general`, 'main')?.replyTo).toBe(q)
  })

  test('to a board without the cap: the plain body, while this board still shows what it answers', async () => {
    const w = await world()
    const q = await deliver(w, w.C, 'which branch?')
    expect((await w.s.svc.send(w.C.pub, 'main', undefined, q)).ok).toBe(true)
    const [msg] = sent(w.ws)
    expect(msg?.body).toEqual({ text: 'main' })
    expect(lineOf(w, `${w.C.pub}/general`, 'main')?.replyTo).toBe(q)
  })

  test('a team post: each copy to a board with the cap carries the post id (its first copy’s); the older board’s none', async () => {
    const w = await world()
    const r = await w.s.svc.send('team', 'standup in 5')
    if (!r.ok) throw new Error('not sent')
    const copies = sent(w.ws)
    expect(copies.map(m => m.to).sort()).toEqual([w.A.pub, w.B.pub, w.C.pub].sort())
    expect(copies[0]?.id).toBe(r.id)
    const post = (to: string) => copies.find(m => m.to === to)?.body.post
    expect([post(w.A.pub), post(w.B.pub), post(w.C.pub)]).toEqual([r.id, r.id, undefined])
    // The copies are distinct messages all the same.
    expect(new Set(copies.map(m => m.id)).size).toBe(3)
  })

  test('a reply to a member’s team post names the post, on every copy to a board that reads it', async () => {
    const w = await world()
    // anna's post: her first copy went to ben (P), this board's copy has an id of its own.
    const P = '00000000-0000-4000-8000-00000000f001'
    const mine = await deliver(w, w.A, 'ship today?', { thread: TEAM_GENERAL, post: P })
    expect(mine).not.toBe(P)
    expect((await w.s.svc.send('team', 'yes', { id: GENERAL }, mine)).ok).toBe(true)
    const copies = sent(w.ws)
    const reply = (to: string) => copies.find(m => m.to === to)?.body.replyTo
    expect([reply(w.A.pub), reply(w.B.pub), reply(w.C.pub)]).toEqual([P, P, undefined])
    expect(lineOf(w, 'team/general', 'yes')?.replyTo).toBe(mine)
  })

  test('a third board finds the original of a reply to a team post by the post id its own copy carries', async () => {
    const w = await world()
    const P = '00000000-0000-4000-8000-00000000f002'
    const mine = await deliver(w, w.A, 'ship today?', { thread: TEAM_GENERAL, post: P })
    await deliver(w, w.B, 'after lunch', { thread: TEAM_GENERAL, replyTo: P })
    expect(lineOf(w, 'team/general', 'after lunch')?.replyTo).toBe(mine)
  })

  test('a reply to this board’s own team post names its line; one to a message it does not have keeps the id', async () => {
    const w = await world()
    const r = await w.s.svc.send('team', 'release notes are up')
    if (!r.ok) throw new Error('not sent')
    await deliver(w, w.A, 'thanks', { thread: TEAM_GENERAL, replyTo: r.id })
    expect(lineOf(w, 'team/general', 'thanks')?.replyTo).toBe(r.id)
    const lost = '00000000-0000-4000-8000-00000000dead'
    await deliver(w, w.B, 'what notes?', { thread: TEAM_GENERAL, replyTo: lost })
    expect(lineOf(w, 'team/general', 'what notes?')?.replyTo).toBe(lost)
  })

  test('a copy cannot take over the name of a message that came before it', async () => {
    const w = await world()
    const first = await deliver(w, w.A, 'first', { thread: TEAM_GENERAL })
    // ben claims anna's message id as his post id.
    await deliver(w, w.B, 'second', { thread: TEAM_GENERAL, post: first })
    await deliver(w, w.C, 'third', { thread: TEAM_GENERAL, replyTo: first })
    expect(lineOf(w, 'team/general', 'third')?.replyTo).toBe(first)
  })

  test('a reply to what is not a line of that thread is refused and nothing is sent; so is one to a held line', async () => {
    const w = await world()
    const q = await deliver(w, w.A, 'in the pair')
    for (const target of ['00000000-0000-4000-8000-00000000beef', 'not-an-id']) {
      expect(await w.s.svc.send(w.A.pub, 'x', undefined, target)).toEqual({ ok: false, error: 'reply' })
    }
    // anna's pair message is not a line of the team chat.
    expect(await w.s.svc.send('team', 'x', undefined, q)).toEqual({ ok: false, error: 'reply' })
    expect(sent(w.ws)).toEqual([])
  })
})

describe('the list’s latest message', () => {
  test('each thread’s latest line: which way, who by this board’s name, a line of its text, when', async () => {
    const w = await world()
    await deliver(w, w.A, 'hello there')
    await deliver(w, w.B, 'x'.repeat(LAST_CHARS + 40), { thread: TEAM_GENERAL })
    await w.s.svc.send(w.C.pub, 'hi cleo')
    const lasts = w.s.svc.lasts?.() ?? {}
    expect(lasts[`${w.A.pub}/general`]).toMatchObject({ dir: 'in', who: 'anna', text: 'hello there' })
    expect(lasts['team/general']).toMatchObject({ dir: 'in', who: 'ben', text: 'x'.repeat(LAST_CHARS) })
    expect(lasts[`${w.C.pub}/general`]).toMatchObject({ dir: 'out', text: 'hi cleo' })
    expect(lasts[`${w.C.pub}/general`]).not.toHaveProperty('who')
  })
})
