// Channels (#355): a team thread for some members only, on #216's group sending. A channel's post
// goes to its members alone (one signed copy each, the member list in the thread); a member whose
// board does not read channels gets it in their pair's general with the title in front, so an
// answer reaches this board alone; a copy that does not name this board, or would land a channel's
// words in a thread the whole team shares (or the other way round), is acked and dropped. Only the
// creator's posts move the member list, and only the creator adds members. A channel has its own
// agent switches (the router reads them by its key), and the team chat's mute is not a channel's.
import { afterEach, describe, expect, test } from 'bun:test'
import { changeAgents, changeThreads, readInbox, readThreads } from '../../src/adapters/team-store.ts'
import { type Envelope, generateKey, type KeyPair, type Message } from '../../src/core/team.ts'
import { type InboundEvent, MAX_THREADS_PER_SCOPE } from '../../src/services/team-hub.ts'
import { storeMutes } from '../../src/services/team-notify.ts'
import { createTeamRouter, type NoticeSchedule, switchesKey } from '../../src/services/team-router.ts'
import { msgOf, question } from '../hub/harness.ts'
import { type FakeWs, handshake, type Setup, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

const LANES = [{ id: 'acme', title: 'Acme Corp', color: 'blue', paths: [] }]

interface World {
  s: Setup
  ws: FakeWs
  me: string
  /** Ana and Ben read channels; Cleo's board reads threads only. */
  A: KeyPair
  B: KeyPair
  C: KeyPair
  inbound: InboundEvent[]
  notices: string[]
}

async function world(): Promise<World> {
  const inbound: InboundEvent[] = []
  const notices: string[] = []
  let route: (e: InboundEvent) => void = () => {}
  const cfg = { team: { hub: 'ws://127.0.0.1:7443', name: 'me' }, categories: LANES }
  const s = setup(cfg.team, {
    onInbound: e => {
      inbound.push(e)
      route(e)
    },
  })
  const [A, B, C] = [await generateKey(), await generateKey(), await generateKey()]
  s.svc.start()
  const { ws, me } = await handshake(s, [
    { peer: A.pub, name: 'ana', caps: ['threads', 'channels'] },
    { peer: B.pub, name: 'ben', caps: ['threads', 'channels'] },
    { peer: C.pub, name: 'cleo', caps: ['threads'] },
  ])
  const schedule: NoticeSchedule = {
    list: () => [],
    add: e => void notices.push(e.teamThread ?? e.key),
    update: () => false,
  }
  const router = createTeamRouter({
    team: s.svc,
    cfg: cfg as never,
    items: () => [{ key: 'sess-listener', name: 'day', category: 'acme' }],
    schedule,
    now: () => s.clock.now(),
  })
  route = e => router.inbound(e)
  return { s, ws, me, A, B, C, inbound, notices }
}

const sent = (ws: FakeWs): Message[] => ws.of('send').map(f => msgOf((f as { env: Envelope }).env))

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
  return msgOf(env).id
}

const TOPIC = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'

describe('sending in a channel', () => {
  test('a new channel goes to its members only, the list in each copy; a board without channels gets it in its general', async () => {
    const w = await world()
    const r = await w.s.svc.send('team', 'release on friday?', { title: 'Release', members: [w.A.pub, w.C.pub] })
    if (!r.ok) throw new Error(r.error)
    const key = r.thread as string
    expect(key.startsWith('team/')).toBe(true)
    const copies = sent(w.ws)
    expect(copies.map(m => m.to).sort()).toEqual([w.A.pub, w.C.pub].sort())
    const toAna = copies.find(m => m.to === w.A.pub) as Message
    const members = [w.me, w.A.pub, w.C.pub].sort()
    expect(toAna.body).toMatchObject({ text: 'release on friday?', thread: { title: 'Release', group: true, members } })
    // Cleo's board reads threads but not channels: no thread (her answer goes to this board alone).
    const toCleo = copies.find(m => m.to === w.C.pub) as Message
    expect(toCleo.body.thread).toBeUndefined()
    expect(toCleo.body.text).toContain('Release')
    expect(readThreads()[key]).toMatchObject({ scope: 'team', title: 'Release', by: 'me', members })
    // The next post in it goes the same way, its list from the record.
    const again = await w.s.svc.send('team', 'and the notes', { id: key.split('/')[1] as string })
    expect(again.ok).toBe(true)
    expect(
      sent(w.ws)
        .slice(2)
        .map(m => m.to)
        .sort(),
    ).toEqual([w.A.pub, w.C.pub].sort())
  })

  test('a channel needs members of the roster, not this board, and the team as the target', async () => {
    const w = await world()
    const outsider = (await generateKey()).pub
    for (const members of [[], [w.me], [outsider], [w.A.pub, w.A.pub]]) {
      const r = await w.s.svc.send('team', 'x', { title: 'T', members })
      expect([JSON.stringify(members).length, r.ok]).toEqual([JSON.stringify(members).length, false])
    }
    expect((await w.s.svc.send(w.A.pub, 'x', { title: 'T', members: [w.B.pub] })).ok).toBe(false)
    expect(sent(w.ws)).toEqual([])
  })

  test('the creator adds a member: the next post carries the list; nobody else may', async () => {
    const w = await world()
    const r = await w.s.svc.send('team', 'start', { title: 'Release', members: [w.A.pub] })
    const key = (r.ok && r.thread) as string
    expect(w.s.svc.addMembers(key, [w.B.pub])).toEqual({ ok: true })
    expect(w.s.svc.addMembers(key, [(await generateKey()).pub])).toEqual({ ok: false, error: 'peer' })
    await w.s.svc.send('team', 'welcome ben', { id: key.split('/')[1] as string })
    const last = sent(w.ws).slice(1)
    expect(last.map(m => m.to).sort()).toEqual([w.A.pub, w.B.pub].sort())
    expect(last[0]?.body.thread?.members).toEqual([w.me, w.A.pub, w.B.pub].sort())
    // A channel another board started is not this board's to grow.
    await deliver(w, w.A, 'theirs', {
      thread: { id: TOPIC, title: 'Theirs', group: true, members: [w.me, w.A.pub].sort() },
    })
    expect(w.s.svc.addMembers(`team/${TOPIC}`, [w.B.pub])).toEqual({ ok: false, error: 'thread' })
  })
})

describe('what comes in', () => {
  test('a channel copy naming this board is kept as a channel; one that does not is acked and dropped', async () => {
    const w = await world()
    const members = [w.me, w.A.pub].sort()
    await deliver(w, w.A, 'in the channel', { thread: { id: TOPIC, title: 'Deals', group: true, members } })
    expect(readThreads()[`team/${TOPIC}`]).toMatchObject({ title: 'Deals', by: w.A.pub, members })
    expect(w.inbound.map(e => e.thread)).toEqual([`team/${TOPIC}`])
    const other = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    // Not naming this board, or not naming its sender: dropped, acked all the same.
    await deliver(w, w.A, 'not for me', {
      thread: { id: other, title: 'Theirs', group: true, members: [w.A.pub, w.B.pub].sort() },
    })
    await deliver(w, w.B, 'forged list', { thread: { id: other, title: 'X', group: true, members } })
    expect(readInbox(w.A.pub).map(i => i.text)).toEqual(['in the channel'])
    expect(readInbox(w.B.pub)).toEqual([])
    expect(readThreads()[`team/${other}`]).toBeUndefined()
  })

  test('a channel and a team topic never mix: a plain team copy in a channel, or a channel copy in a team topic, is dropped', async () => {
    const w = await world()
    const members = [w.me, w.A.pub].sort()
    await deliver(w, w.A, 'channel', { thread: { id: TOPIC, title: 'Deals', group: true, members } })
    await deliver(w, w.A, 'plain', { thread: { id: TOPIC, title: 'Deals', group: true } })
    const topic = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    await deliver(w, w.B, 'team topic', { thread: { id: topic, title: 'All', group: true } })
    await deliver(w, w.A, 'channel over it', {
      thread: { id: topic, title: 'All', group: true, members: [w.me, w.A.pub].sort() },
    })
    expect(readInbox(w.A.pub).map(i => i.text)).toEqual(['channel'])
    expect(readThreads()[`team/${topic}`]?.members).toBeUndefined()
  })

  test('the member list moves on with the creator’s posts only', async () => {
    const w = await world()
    const two = [w.me, w.A.pub].sort()
    const three = [w.me, w.A.pub, w.B.pub].sort()
    await deliver(w, w.A, 'start', { thread: { id: TOPIC, title: 'Deals', group: true, members: two } })
    await deliver(w, w.B, 'ben widens', { thread: { id: TOPIC, title: 'Deals', group: true, members: three } })
    expect(readThreads()[`team/${TOPIC}`]?.members).toEqual(two)
    await deliver(w, w.A, 'ana adds ben', { thread: { id: TOPIC, title: 'Deals', group: true, members: three } })
    expect(readThreads()[`team/${TOPIC}`]?.members).toEqual(three)
  })
})

describe('what cannot move a channel', () => {
  test('a member who is not in the list as kept cannot write in it, whatever list the copy carries', async () => {
    const w = await world()
    const two = [w.me, w.A.pub].sort()
    await deliver(w, w.A, 'start', { thread: { id: TOPIC, title: 'Deals', group: true, members: two } })
    await deliver(w, w.B, 'let me in', {
      thread: { id: TOPIC, title: 'Deals', group: true, members: [w.me, w.B.pub].sort() },
    })
    expect(readInbox(w.B.pub)).toEqual([])
    expect(readThreads()[`team/${TOPIC}`]?.members).toEqual(two)
  })

  test('a flood of team topics never drops a channel, nor lets a plain copy take its place; a full scope takes no new channel', async () => {
    const w = await world()
    const members = [w.me, w.A.pub].sort()
    await deliver(w, w.A, 'start', { thread: { id: TOPIC, title: 'Deals', group: true, members } })
    // The channel is the quietest of a full team scope.
    changeThreads(all => {
      const own = all[`team/${TOPIC}`]
      if (own) own.lastAt = 0
      for (let i = 0; i < MAX_THREADS_PER_SCOPE; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        all[`team/${id}`] = {
          scope: 'team',
          id,
          title: 't',
          link: null,
          handler: null,
          muted: false,
          by: w.B.pub,
          createdAt: 1,
          lastAt: 1 + i,
        }
      }
    })
    await deliver(w, w.B, 'one more topic', {
      thread: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', title: 'More', group: true },
    })
    expect(readThreads()[`team/${TOPIC}`]?.members).toEqual(members)
    await deliver(w, w.B, 'plain over it', { thread: { id: TOPIC, title: 'Deals', group: true } })
    expect(readInbox(w.B.pub).map(i => i.text)).toEqual(['one more topic'])
    const fresh = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
    await deliver(w, w.A, 'a new channel', {
      thread: { id: fresh, title: 'New', group: true, members },
    })
    expect(readThreads()[`team/${fresh}`]).toBeUndefined()
  })

  test('only the panel starts a channel: an agent’s post naming members is refused', async () => {
    const w = await world()
    const r = await w.s.svc.post({ to: 'team', thread: { title: 'T', members: [w.A.pub] } }, 'x', {
      by: 'agent',
      session: { key: 's1' },
    })
    expect(r).toEqual({ ok: false, error: 'thread' })
    expect(sent(w.ws)).toEqual([])
  })
})

describe('a channel’s switches and mute', () => {
  test('the router reads a channel’s own switches, not the team chat’s; the team chat’s mute is not a channel’s', async () => {
    const w = await world()
    const members = [w.me, w.A.pub].sort()
    changeAgents(x => {
      x.peers.team = { on: true, lanes: ['acme'], muted: true }
      x.listener = { key: 'sess-listener', name: 'day' }
    })
    await deliver(w, w.A, 'one', { thread: { id: TOPIC, title: 'Deals', group: true, members } })
    const key = `team/${TOPIC}`
    expect(switchesKey('team', key)).toBe(key)
    expect(switchesKey('team', 'team/general')).toBe('team')
    expect(switchesKey(w.A.pub, `${w.A.pub}/general`)).toBe(w.A.pub)
    // The team's switch is on, the channel's is not: no notice.
    expect(w.notices).toEqual([])
    changeAgents(x => {
      x.peers[key] = { on: true, lanes: ['acme'] }
    })
    await deliver(w, w.A, 'two', { thread: { id: TOPIC, title: 'Deals', group: true, members } })
    // The team chat is muted, the channel is not: it is heard.
    expect(w.notices).toEqual([key])
    const muted = storeMutes()
    expect(muted(key)).toBe(false)
    expect(muted('team/general')).toBe(true)
  })
})
