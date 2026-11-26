// The owner's service agents (#819): a program with no pane that writes in Team as one of the
// owner's agents. config.json's `team.services` names it (core/team-services.ts); the board gives it
// a card in the lane the owner chose, so the router's agent lane check works for it as for any
// session (services/team-router.ts): in a lane shared with the peer its post goes out under the
// card's name ("anna's agent Juno" on the other side), outside it the post is held. What comes in
// on a thread it handles reaches no schedule: it has no pane, and asks through the MCP instead.
import { afterEach, describe, expect, test } from 'bun:test'
import { changeAgents, readDrafts, readThreads } from '../../src/adapters/team-store.ts'
import { type Envelope, generateKey, type KeyPair, type Message } from '../../src/core/team.ts'
import { changeServices, serviceAgents, serviceKeyFor } from '../../src/core/team-services.ts'
import {
  createTeamRouter,
  type NoticeEntry,
  type NoticeSchedule,
  type RouterItem,
} from '../../src/services/team-router.ts'
import { msgOf, question } from '../hub/harness.ts'
import { type FakeWs, handshake, type Setup, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

function memSchedule(): NoticeSchedule & { entries: (NoticeEntry & { text: string })[] } {
  const entries: (NoticeEntry & { text: string })[] = []
  let n = 0
  return {
    entries,
    list: () => entries,
    add: e => void entries.push({ id: `e${++n}`, key: e.key, text: e.text, teamThread: e.teamThread, teamCount: 1 }),
    update: (id, text, count) => {
      const e = entries.find(x => x.id === id)
      if (!e) return false
      e.text = text
      e.teamCount = count
      return true
    },
  }
}

const LANES = [
  { id: 'personal', color: 'green', paths: [] },
  { id: 'home', title: 'Home', color: 'blue', paths: [] },
  { id: 'acme', title: 'Acme Corp', color: 'red', paths: [] },
]

interface World {
  s: Setup
  ws: FakeWs
  me: string
  P: KeyPair
  schedule: ReturnType<typeof memSchedule>
  items: RouterItem[]
  router: ReturnType<typeof createTeamRouter>
}

/** A board online with one peer (anna), a listener, a Claude session in acme and the service Juno in home. */
async function world(): Promise<World> {
  let route: (e: Parameters<ReturnType<typeof createTeamRouter>['inbound']>[0]) => void = () => {}
  const cfg = { team: { hub: 'ws://127.0.0.1:7443', name: 'me' }, categories: LANES }
  const s = setup(cfg.team, { onInbound: e => route(e) })
  const P = await generateKey()
  s.svc.start()
  const { ws, me } = await handshake(s, [{ peer: P.pub, name: 'anna', caps: ['threads'] }])
  const schedule = memSchedule()
  // As the board's items give them: the service's card is in its lane, with its name, marked a service.
  const items: RouterItem[] = [
    { key: 'sess-acme', name: 'acme-work', category: 'acme' },
    { key: 'sess-listener', name: 'day', category: 'personal' },
    { key: 'service-juno', name: 'Juno', category: 'home', service: true },
  ]
  const router = createTeamRouter({
    team: s.svc,
    cfg: cfg as never,
    items: () => items,
    schedule,
    now: () => s.clock.now(),
  })
  route = e => router.inbound(e)
  changeAgents(x => {
    x.peers[P.pub] = { on: true, lanes: ['home'] }
    x.listener = { key: 'sess-listener', name: 'day' }
  })
  return { s, ws, me, P, schedule, items, router }
}

const sent = (ws: FakeWs): Message[] => ws.of('send').map(f => msgOf((f as { env: Envelope }).env))

async function deliver(w: World, text: string, body: Partial<Message['body']> = {}): Promise<void> {
  const env = await question(
    w.P,
    w.me,
    text,
    { body: { text, ...body } as Message['body'] },
    new Date(w.s.clock.now()).toISOString(),
  )
  const before = w.ws.of('ack').length
  w.ws.recv({ t: 'deliver', env })
  await until(() => w.ws.of('ack').length > before, 'an ack')
}

describe('a service agent in Team (#819)', () => {
  test('in a lane shared with the peer: its post goes out under its card name, and it handles the new thread', async () => {
    const w = await world()
    // The MCP's call names only the key (X-Board-Session); the name is the board's.
    const r = await w.router.agentPost({
      to: w.P.pub,
      thread: { title: 'Groceries' },
      text: 'Milk is out, shall I order?',
      session: { key: 'service-juno' },
    })
    expect(r).toMatchObject({ ok: true, sent: true })
    expect(sent(w.ws)[0]?.body).toMatchObject({ via: 'agent', agent: 'Juno', text: 'Milk is out, shall I order?' })
    expect(r.ok && r.sent && readThreads()[r.thread]?.handler).toEqual({ key: 'service-juno', name: 'Juno' })
  })

  test('a name its call claims is not the one that goes out', async () => {
    const w = await world()
    const r = await w.router.agentPost({
      to: w.P.pub,
      text: 'hi',
      session: { key: 'service-juno', name: 'the owner' },
    })
    expect(r).toMatchObject({ ok: true, sent: true })
    expect(sent(w.ws)[0]?.body).toMatchObject({ agent: 'Juno' })
  })

  test('outside its lane: held as a draft for the owner, nothing sent', async () => {
    const w = await world()
    w.items[2] = { key: 'service-juno', name: 'Juno', category: 'acme', service: true }
    const r = await w.router.agentPost({ to: w.P.pub, text: 'plain words', session: { key: 'service-juno' } })
    expect(r).toMatchObject({ ok: true, sent: false, reason: 'lane' })
    expect(sent(w.ws)).toEqual([])
    expect(readDrafts()[0]).toMatchObject({ reason: 'lane', text: 'plain words' })
  })

  test('what comes in on its thread puts nothing in the schedule; a Claude session handling one is told as before', async () => {
    const w = await world()
    const r = await w.router.agentPost({
      to: w.P.pub,
      thread: { title: 'Groceries' },
      text: 'q',
      session: { key: 'service-juno' },
    })
    const id = r.ok && r.sent ? r.thread.split('/')[1] : ''
    await deliver(w, 'yes, order', { thread: { id: id as string, title: 'Groceries' } })
    expect(w.schedule.entries).toEqual([])
    // The same for a session with a pane: it is told.
    changeAgents(x => {
      x.peers[w.P.pub] = { on: true, lanes: ['home', 'acme'] }
    })
    const r2 = await w.router.agentPost({
      to: w.P.pub,
      thread: { title: 'Invoice' },
      text: 'q',
      session: { key: 'sess-acme' },
    })
    const id2 = r2.ok && r2.sent ? r2.thread.split('/')[1] : ''
    await deliver(w, 'paid', { thread: { id: id2 as string, title: 'Invoice' } })
    expect(w.schedule.entries.map(e => e.key)).toEqual(['sess-acme'])
  })

  test('its reaction goes as its post does: in its lane, under its card name', async () => {
    const w = await world()
    await deliver(w, 'hello from anna')
    const [line] = w.s.svc.threadLines(`${w.P.pub}/general`).filter(l => l.dir === 'in')
    const r = await w.router.agentReact({
      thread: `${w.P.pub}/general`,
      message: String(line?.id),
      emoji: '👍',
      op: 'add',
      session: { key: 'service-juno' },
    })
    expect(r).toMatchObject({ ok: true })
  })
})

describe('the service list in config.json (#819)', () => {
  test('only well-formed entries count; a board without services has none', () => {
    expect(serviceAgents(undefined)).toEqual([])
    expect(serviceAgents({ hub: 'ws://x' })).toEqual([])
    expect(
      serviceAgents({
        services: [
          { key: 'service-juno', name: 'Juno', lane: 'home' },
          { key: 'not-a-service', name: 'X', lane: 'home' },
          { key: 'service-juno', name: 'Again', lane: 'home' },
          { key: 'service-bad-name', name: ' padded ', lane: 'home' },
          { key: 'service-bad-lane', name: 'Y', lane: '../x' },
        ],
      }),
    ).toEqual([{ key: 'service-juno', name: 'Juno', lane: 'home' }])
  })

  test('a key from its name: Latin words, another alphabet, taken ones', () => {
    expect(serviceKeyFor('Juno', [])).toBe('service-juno')
    expect(serviceKeyFor('Home Bot 2', [])).toBe('service-home-bot-2')
    expect(serviceKeyFor('Juno', ['service-juno'])).toBe('service-juno-2')
    const cyr = serviceKeyFor('Юнона ☃', [])
    expect(cyr).toMatch(/^service-[a-z0-9]+$/)
    expect(serviceKeyFor('Юнона ☃', [])).toBe(cyr)
  })

  test('add and remove from the panel: a lane there is, a name not used yet', () => {
    const lanes = ['home', 'acme']
    const a = changeServices([], { add: { name: 'Juno', lane: 'home' } }, lanes)
    expect(a).toEqual({
      ok: true,
      services: [{ key: 'service-juno', name: 'Juno', lane: 'home' }],
      added: { key: 'service-juno', name: 'Juno', lane: 'home' },
    })
    const now = a.ok ? a.services : []
    expect(changeServices(now, { add: { name: 'juno', lane: 'acme' } }, lanes)).toEqual({ ok: false, error: 'taken' })
    expect(changeServices(now, { add: { name: 'Bot', lane: 'nowhere' } }, lanes)).toEqual({ ok: false, error: 'lane' })
    expect(changeServices(now, { add: { name: '', lane: 'home' } }, lanes)).toEqual({ ok: false, error: 'name' })
    expect(changeServices(now, { remove: 'service-other' }, lanes)).toEqual({ ok: false, error: 'service' })
    expect(changeServices(now, { remove: 'service-juno' }, lanes)).toEqual({ ok: true, services: [] })
  })
})
