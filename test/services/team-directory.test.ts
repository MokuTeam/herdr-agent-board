// Addressing a peer's agent (#832) on one board against a socket the test plays the hub with: the
// directory each peer gets (every session in a lane shared with them, Agents on, by its handle; none
// archived), the peers' directories kept and shown, the handle on the addressed copy, and the router
// handing an addressed message to that session, or to the listener with a note. And that a board
// where no peer has Agents on sends, writes and routes exactly as before.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCard } from '../../src/adapters/cards.ts'
import { archiveDir, teamAgentsFile, teamDirectoryFile } from '../../src/adapters/paths.ts'
import {
  changeAgents,
  changeDirectoryState,
  changePins,
  readDirectoryState,
  readInbox,
  readThreads,
} from '../../src/adapters/team-store.ts'
import { ackBytes, type Envelope, generateKey, type KeyPair, type Message, sign } from '../../src/core/team.ts'
import { backoffMs } from '../../src/core/tunnel.ts'
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
    add: e =>
      void entries.push({ id: `e${++n}`, key: e.key, text: e.text, teamThread: e.teamThread, teamCount: e.teamCount }),
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
  { id: 'acme', title: 'Acme Corp', color: 'blue', paths: [] },
  { id: 'globex', title: 'Globex', color: 'red', paths: [] },
]

interface World {
  s: Setup
  ws: FakeWs
  me: string
  P: KeyPair
  Q: KeyPair
  schedule: ReturnType<typeof memSchedule>
  items: RouterItem[]
  router: ReturnType<typeof createTeamRouter>
}

/** A board online with anna (P) and ben (Q), both reading threads. */
async function world(): Promise<World> {
  let route: (e: Parameters<ReturnType<typeof createTeamRouter>['inbound']>[0]) => void = () => {}
  const cfg = { team: { hub: 'ws://127.0.0.1:7443', name: 'me' }, categories: LANES }
  const s = setup(cfg.team, { onInbound: e => route(e) })
  const [P, Q] = [await generateKey(), await generateKey()]
  s.svc.start()
  const roster = [
    { peer: P.pub, name: 'anna', caps: ['threads', 'replies'] },
    { peer: Q.pub, name: 'ben', caps: ['threads', 'replies'] },
  ]
  const { ws, me } = await handshake(s, roster)
  const schedule = memSchedule()
  const items: RouterItem[] = [
    { key: 'sess-acme', name: 'acme-work', category: 'acme' },
    { key: 'sess-globex', name: 'globex-work', category: 'globex' },
    { key: 'sess-listener', name: 'day', category: 'personal' },
  ]
  const router = createTeamRouter({
    team: s.svc,
    cfg: cfg as never,
    items: () => items,
    schedule,
    now: () => s.clock.now(),
  })
  route = e => router.inbound(e)
  return { s, ws, me, P, Q, schedule, items, router }
}

const sent = (ws: FakeWs): Message[] => ws.of('send').map(f => msgOf((f as { env: Envelope }).env))

async function deliver(w: World, from: KeyPair, body: Partial<Message['body']> & { text: string }, ts?: string) {
  const env = await question(
    from,
    w.me,
    body.text,
    { body: body as Message['body'] },
    ts ?? new Date(w.s.clock.now()).toISOString(),
  )
  const before = w.ws.of('ack').length
  w.ws.recv({ t: 'deliver', env })
  await until(() => w.ws.of('ack').length > before, 'an ack')
  return msgOf(env).id
}

/** Anna's agents on with these lanes shared (acme by default), and a listener: acme-work is hers to address. */
function shareWithAnna(w: World, lanes: string[] = ['acme']): void {
  changeAgents(x => {
    x.peers[w.P.pub] = { on: true, lanes }
    x.listener = { key: 'sess-listener', name: 'day' }
  })
}

/** A session put in the archive (or on its way there): its record in the archive folder. */
function archive(key: string, state = 'archived'): void {
  mkdirSync(archiveDir(), { recursive: true })
  writeFileSync(join(archiveDir(), `${key}.json`), JSON.stringify({ key, session: key, state, held: [] }))
}

/** The hub's word on a message of ours; `acked` with the signed ack of `by` when given (none: unsigned). */
async function word(w: World, id: string | undefined, state: string, by?: KeyPair): Promise<void> {
  const ts = new Date(w.s.clock.now()).toISOString()
  const ack =
    state === 'acked' && by && id
      ? { by: by.pub, ts, sig: await sign(by.pkcs8, ackBytes({ by: by.pub, id, to: w.me, ts })) }
      : undefined
  w.ws.recv({ t: 'state', id, state, at: w.s.clock.now(), ...(ack && { ack }) })
}

describe('no peer with Agents on: as before #832', () => {
  test('no directory goes out, no file is written, the switches file is as it was', async () => {
    const w = await world()
    changeAgents(x => {
      x.peers[w.P.pub] = { on: false, lanes: ['acme'] }
    })
    const before = readFileSync(teamAgentsFile(), 'utf8')
    expect(await w.router.syncDirectory()).toBe(0)
    expect(sent(w.ws)).toEqual([])
    expect(existsSync(teamDirectoryFile())).toBe(false)
    expect(readFileSync(teamAgentsFile(), 'utf8')).toBe(before)
    expect(w.router.exposed([w.P.pub, w.Q.pub])).toEqual([])
  })

  test("the hub's word on any other message, or an error naming one, writes no directory file", async () => {
    const w = await world()
    await w.s.svc.post({ to: w.P.pub }, 'hello', { by: 'ui' })
    const [m] = sent(w.ws)
    await word(w, m?.id, 'queued')
    await word(w, crypto.randomUUID(), 'expired')
    w.ws.recv({ t: 'error', code: 'bad_frame', id: m?.id, message: 'x' })
    await Bun.sleep(30)
    expect(existsSync(teamDirectoryFile())).toBe(false)
  })

  test('a text that starts like a mention goes as plain words to a peer that sent no directory', async () => {
    const w = await world()
    const r = await w.s.svc.post({ to: w.P.pub }, '@anna.rev hi', { by: 'ui' })
    expect(r.ok).toBe(true)
    expect(sent(w.ws)[0]?.body).toEqual({ text: '@anna.rev hi' })
  })
})

describe('the directory this board sends: what the lanes shared reach', () => {
  test("every session in a lane shared with her, by its handle, to her only; the owner's panel shows it", async () => {
    const w = await world()
    shareWithAnna(w)
    expect(await w.router.syncDirectory()).toBe(1)
    const [d] = sent(w.ws)
    expect(d?.to).toBe(w.P.pub)
    expect(d?.ttl_s).toBe(86_400)
    expect(d?.body).toEqual({ text: 'agent directory', agents: [{ code: 'acme-work' }] })
    expect(readDirectoryState().handles).toEqual({ 'sess-acme': 'acme-work' })
    expect(w.router.exposed([w.P.pub, w.Q.pub])).toEqual([
      { code: 'acme-work', session: { key: 'sess-acme', name: 'acme-work' }, lane: 'acme', reaches: [w.P.pub] },
    ])
  })

  test('aliases travel only to peers who reach the session, in signed directory text with the original entry shape', async () => {
    const w = await world()
    shareWithAnna(w)
    changeDirectoryState(d => {
      Object.assign(d, { aliases: { 'sess-acme': 'Reports', 'sess-globex': 'Private' } })
    })
    expect(await w.router.syncDirectory()).toBe(1)
    const [d] = sent(w.ws)
    expect(d?.to).toBe(w.P.pub)
    expect(d?.body).toEqual({
      text: 'agent directory aliases/1 ["Reports"]',
      agents: [{ code: 'acme-work' }],
    })
    archive('sess-acme')
    await word(w, d?.id, 'acked', w.P)
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'acked', 'acked')
    expect(await w.router.syncDirectory()).toBe(1)
    expect(sent(w.ws)[1]?.body).toEqual({ text: 'agent directory', agents: [] })
  })

  test('masters-only filters shared lanes, keeps old handles and leaves hand-offs available', async () => {
    const w = await world()
    const worker = { key: 'pane-test-2', name: 'Сборка 100%', category: 'acme', service: true as const }
    w.items.push(worker)
    writeCard('sess-acme', { teamMaster: true })
    writeCard('sess-globex', { teamMaster: true })
    shareWithAnna(w)
    changeDirectoryState(d => {
      d.aliases[worker.key] = 'build-worker'
    })
    await w.router.syncDirectory()
    const first = sent(w.ws)[0]
    expect(first?.body.text).toContain('build-worker')
    expect(first?.body.agents).toEqual([{ code: 'acme-work' }, { code: 'sborka-100' }])
    await word(w, first?.id, 'acked', w.P)
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'acked', 'initial directory acked')

    changeAgents(s => {
      s.mastersOnly = true
    })
    expect(await w.router.syncDirectory()).toBe(1)
    expect(sent(w.ws)[1]?.body).toEqual({ text: 'agent directory', agents: [{ code: 'acme-work' }] })
    expect(w.router.exposed([w.P.pub, w.Q.pub]).map(x => x.code)).toEqual(['acme-work'])
    expect(readDirectoryState().handles[worker.key]).toBe('sborka-100')

    const thread = { id: crypto.randomUUID(), title: 'Direct message' }
    const key = `${w.P.pub}/${thread.id}`
    await deliver(w, w.P, { text: 'using a cached directory', thread, at: 'sborka-100' })
    expect(w.schedule.entries.map(e => e.key)).toEqual(['sess-listener'])
    expect(w.schedule.entries[0]?.text).toContain('@sborka-100, which reaches no agent here now')
    expect(readThreads()[key]?.handler).toBeNull()

    await deliver(w, w.P, { text: 'to the master', thread, at: 'acme-work' })
    expect(readThreads()[key]?.handler?.key).toBe('sess-acme')
    expect(w.router.assign(key, { key: worker.key })).toEqual({ ok: true })
    expect(readThreads()[key]?.handler?.key).toBe(worker.key)

    writeCard('sess-acme', { teamMaster: '' })
    expect(w.router.directoryFor(w.P.pub)).toEqual([])
    changeAgents(s => {
      delete s.mastersOnly
    })
    expect(w.router.directoryFor(w.P.pub)).toEqual([
      { code: 'acme-work' },
      { code: 'sborka-100', alias: 'build-worker' },
    ])
  })

  test('one at a time: the next change goes once her board acked the last; unchanged, nothing goes', async () => {
    const w = await world()
    shareWithAnna(w)
    expect(await w.router.syncDirectory()).toBe(1)
    const [d] = sent(w.ws)
    expect(await w.router.syncDirectory()).toBe(0)
    await word(w, d?.id, 'queued')
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'queued', 'queued')
    // globex shared too: a new list, held while the last is unread.
    shareWithAnna(w, ['acme', 'globex'])
    expect(await w.router.syncDirectory()).toBe(0)
    await word(w, d?.id, 'acked', w.P)
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'acked', 'acked')
    expect(await w.router.syncDirectory()).toBe(1)
    expect(sent(w.ws)[1]?.body.agents).toEqual([{ code: 'acme-work' }, { code: 'globex-work' }])
    await word(w, sent(w.ws)[1]?.id, 'acked', w.P)
    await until(() => readDirectoryState().sent[w.P.pub]?.mark.includes('globex') === true, 'settled')
    expect(await w.router.syncDirectory()).toBe(0)
    // The lane no longer shared: an empty list takes it back.
    changeAgents(x => {
      x.peers[w.P.pub] = { on: true, lanes: [] }
    })
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'acked', 'acked again')
    expect(await w.router.syncDirectory()).toBe(1)
    expect(sent(w.ws)[2]?.body).toEqual({ text: 'agent directory', agents: [] })
  })

  test('an older board never acks: once expired it goes again after a day, then two; her own list resets that', async () => {
    const w = await world()
    shareWithAnna(w)
    await w.router.syncDirectory()
    await word(w, sent(w.ws)[0]?.id, 'expired')
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'expired', 'expired')
    expect(await w.router.syncDirectory()).toBe(0)
    w.s.clock.skew(86_400_000)
    expect(await w.router.syncDirectory()).toBe(1)
    await word(w, sent(w.ws)[1]?.id, 'expired')
    await until(() => readDirectoryState().sent[w.P.pub]?.misses === 2, 'two misses')
    w.s.clock.skew(86_400_000)
    expect(await w.router.syncDirectory()).toBe(0)
    // Her board sends a list of its own: it reads them, so ours goes now.
    await deliver(w, w.P, { text: 'agent directory', agents: [{ code: 'helper' }] })
    expect(await w.router.syncDirectory()).toBe(1)
  })

  test('an ack without her signature settles nothing; a stuck one counts as expired after its day at the hub', async () => {
    const w = await world()
    shareWithAnna(w)
    await w.router.syncDirectory()
    const [d] = sent(w.ws)
    await word(w, d?.id, 'acked')
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'queued', 'queued, not acked')
    await word(w, d?.id, 'acked', w.Q)
    await Bun.sleep(20)
    expect(readDirectoryState().sent[w.P.pub]?.state).toBe('queued')
    shareWithAnna(w, ['acme', 'globex'])
    expect(await w.router.syncDirectory()).toBe(0)
    // The final word never came: a day and a minute later it goes again.
    w.s.clock.skew(86_400_000 + 61_000)
    expect(await w.router.syncDirectory()).toBe(1)
  })

  test('a session in a lane shared with nobody now keeps its handle; another of that name gets -2', async () => {
    const w = await world()
    w.items.push({ key: 'sess-acme-2', name: 'acme-work', category: 'globex' })
    shareWithAnna(w)
    await w.router.syncDirectory()
    expect(readDirectoryState().handles).toEqual({ 'sess-acme': 'acme-work' })
    // acme no longer shared, globex shared: the other acme-work asks for the name.
    shareWithAnna(w, ['globex'])
    await w.router.syncDirectory()
    expect(readDirectoryState().handles).toEqual({
      'sess-acme': 'acme-work',
      'sess-acme-2': 'acme-work-2',
      'sess-globex': 'globex-work',
    })
  })

  test('at most 64 in one list, the first by handle', async () => {
    const w = await world()
    for (let i = 0; i < 70; i++)
      w.items.push({ key: `s${i}`, name: `agent ${String(i).padStart(2, '0')}`, category: 'acme' })
    shareWithAnna(w)
    expect(await w.router.syncDirectory()).toBe(1)
    const list = sent(w.ws)[0]?.body.agents ?? []
    expect(list).toHaveLength(64)
    expect(list[0]).toEqual({ code: 'acme-work' })
  })

  test('one the hub never answered goes again after a reconnect', async () => {
    const w = await world()
    shareWithAnna(w)
    expect(await w.router.syncDirectory()).toBe(1)
    w.ws.hangUp(1006)
    w.s.clock.tick(backoffMs(1, () => 0.5))
    await handshake(
      w.s,
      [
        { peer: w.P.pub, name: 'anna', caps: ['threads'] },
        { peer: w.Q.pub, name: 'ben', caps: ['threads'] },
      ],
      2,
    )
    const ws2 = w.s.sockets[1] as FakeWs
    expect(await w.router.syncDirectory()).toBe(1)
    expect(sent(ws2).filter(m => m.body.agents)).toHaveLength(1)
  })

  test('an empty board (its first look not done yet) shrinks no list', async () => {
    const w = await world()
    shareWithAnna(w)
    await w.router.syncDirectory()
    await word(w, sent(w.ws)[0]?.id, 'acked', w.P)
    await until(() => readDirectoryState().sent[w.P.pub]?.state === 'acked', 'acked')
    w.items.length = 0
    expect(await w.router.syncDirectory()).toBe(0)
    expect(sent(w.ws)).toHaveLength(1)
  })

  test('an archived session, or one being archived, is never listed', async () => {
    const w = await world()
    shareWithAnna(w)
    archive('sess-acme', 'closing')
    expect(w.router.directoryFor(w.P.pub)).toEqual([])
    expect(await w.router.syncDirectory()).toBe(0)
  })
})

describe("the peers' directories", () => {
  test('kept, newest only, never in the inbox; shown while their key is trusted', async () => {
    const w = await world()
    await deliver(
      w,
      w.P,
      { text: 'agent directory', agents: [{ code: 'helper', about: 'Answers' }] },
      '2026-11-26T10:00:00.000Z',
    )
    expect(w.s.svc.directories()).toEqual([
      { peer: w.P.pub, name: 'anna', agents: [{ code: 'helper', about: 'Answers' }], ts: '2026-11-26T10:00:00.000Z' },
    ])
    expect(w.s.svc.view()?.roster.find(p => p.peer === w.P.pub)).toMatchObject({ agents: true })
    expect(w.s.svc.view()?.roster.find(p => p.peer === w.Q.pub)).not.toHaveProperty('agents')
    await deliver(w, w.P, { text: 'agent directory', agents: [{ code: 'old' }] }, '2026-11-26T09:00:00.000Z')
    expect(w.s.svc.directories()[0]?.agents).toEqual([{ code: 'helper', about: 'Answers' }])
    expect(readInbox(w.P.pub)).toEqual([])
    changePins(p => {
      const pin = p[w.P.pub]
      if (pin) pin.status = 'changed'
    })
    expect(w.s.svc.directories()).toEqual([])
  })

  test('an empty directory marks a board that reads them (#842): directory, not agents; none sent: neither; a changed key: neither', async () => {
    const w = await world()
    const of = (peer: string) => w.s.svc.view()?.roster.find(p => p.peer === peer)
    expect(of(w.P.pub)).not.toHaveProperty('directory')
    await deliver(w, w.P, { text: 'agent directory', agents: [] }, '2026-11-26T10:00:00.000Z')
    expect(of(w.P.pub)).toMatchObject({ directory: true })
    expect(of(w.P.pub)).not.toHaveProperty('agents')
    expect(of(w.Q.pub)).not.toHaveProperty('directory')
    expect(w.s.svc.directories()).toEqual([])
    await deliver(w, w.P, { text: 'agent directory', agents: [{ code: 'helper' }] }, '2026-11-26T11:00:00.000Z')
    expect(of(w.P.pub)).toMatchObject({ directory: true, agents: true })
    changePins(p => {
      const pin = p[w.P.pub]
      if (pin) pin.status = 'changed'
    })
    expect(of(w.P.pub)).not.toHaveProperty('directory')
    expect(of(w.P.pub)).not.toHaveProperty('agents')
  })

  test('a post to her that starts with @Name.handle names the agent; a team post names none; one not listed is refused', async () => {
    const w = await world()
    await deliver(w, w.P, { text: 'agent directory', agents: [{ code: 'helper' }] })
    const r = await w.s.svc.post({ to: w.P.pub, thread: { title: '@helper: look' } }, '@anna.helper can you look', {
      by: 'ui',
    })
    expect(r.ok).toBe(true)
    expect(sent(w.ws)[0]?.body.at).toBe('helper')
    const t = await w.s.svc.post({ to: 'team', thread: { title: 'Weekly' } }, '@anna.helper in the team', { by: 'ui' })
    expect(t.ok).toBe(true)
    expect(
      sent(w.ws)
        .slice(1)
        .every(c => c.body.at === undefined),
    ).toBe(true)
    expect(await w.s.svc.post({ to: w.P.pub }, '@anna.nope hi', { by: 'ui' })).toEqual({ ok: false, error: 'agent' })
    expect(await w.s.svc.post({ to: w.P.pub, at: { peer: w.P.pub, code: 'nope' } }, 'hi', { by: 'ui' })).toEqual({
      ok: false,
      error: 'agent',
    })
  })
})

describe('the router and an addressed message', () => {
  const topic = (): { id: string; title: string } => ({ id: crypto.randomUUID(), title: '@acme-work: look' })

  /** Anna can reach acme-work: her lane shared and its handle given (the first sync gives it). */
  async function ready(w: World): Promise<void> {
    shareWithAnna(w)
    await w.router.syncDirectory()
  }

  test('a handle she reaches: the session handles the topic and hears of it by its handle; its answer goes back there', async () => {
    const w = await world()
    await ready(w)
    const t = topic()
    await deliver(w, w.P, { text: '@me.acme-work look', via: 'agent', thread: t, at: 'acme-work' })
    const key = `${w.P.pub}/${t.id}`
    expect(readThreads()[key]?.handler).toEqual({ key: 'sess-acme', name: 'acme-work' })
    expect(w.schedule.entries).toHaveLength(1)
    expect(w.schedule.entries[0]).toMatchObject({ key: 'sess-acme', teamThread: key })
    expect(w.schedule.entries[0]?.text).toBe(
      `anna's agent wrote to you as @acme-work in thread ${t.id.slice(0, 8)}. Read it: board team thread ${t.id.slice(0, 8)}; answer with board team reply ${t.id.slice(0, 8)} "...".`,
    )
    const r = await w.router.agentPost({
      to: w.P.pub,
      thread: { id: t.id },
      text: 'looked',
      session: { key: 'sess-acme' },
    })
    expect(r).toMatchObject({ ok: true, sent: true, thread: key })
    expect(sent(w.ws).at(-1)?.body.thread?.id).toBe(t.id)
  })

  test.each([
    ['a handle nobody has', 'nobody', (_w: World) => {}],
    ['one in a lane not shared with her', 'globex-work', (_w: World) => {}],
    ['one whose session left the board', 'acme-work', (w: World) => void w.items.splice(0, 1)],
    ['one being archived', 'acme-work', (_w: World) => archive('sess-acme', 'closing')],
    ['one archived', 'acme-work', (_w: World) => archive('sess-acme')],
  ])('%s: the listener hears, with a note; nobody handles it; the session hears nothing', async (_n, code, change) => {
    const w = await world()
    shareWithAnna(w, ['acme', 'globex'])
    await w.router.syncDirectory()
    shareWithAnna(w)
    change(w)
    const t = topic()
    await deliver(w, w.P, { text: 'look', thread: t, at: code })
    const key = `${w.P.pub}/${t.id}`
    expect(readThreads()[key]?.handler).toBeNull()
    expect(w.schedule.entries.map(e => e.key)).toEqual(['sess-listener'])
    expect(w.schedule.entries[0]?.text).toContain(`to @${code}, which reaches no agent here now`)
  })

  test('a topic another session handles stays with it; the addressed session hears of the message', async () => {
    const w = await world()
    await ready(w)
    const t = topic()
    const key = `${w.P.pub}/${t.id}`
    await deliver(w, w.P, { text: 'first', thread: t })
    w.s.svc.setThread(key, { handler: { key: 'sess-globex', name: 'globex-work' } })
    await deliver(w, w.P, { text: '@me.acme-work you too', thread: t, at: 'acme-work' })
    expect(readThreads()[key]?.handler?.key).toBe('sess-globex')
    expect(w.schedule.entries.at(-1)?.key).toBe('sess-acme')
  })

  test('a handle in a team thread is no address: the message is routed as any other there', async () => {
    const w = await world()
    await ready(w)
    changeAgents(x => {
      x.peers.team = { on: true, lanes: [] }
    })
    await deliver(w, w.P, {
      text: '@me.acme-work hi',
      thread: { id: crypto.randomUUID(), title: 'T', group: true },
      at: 'acme-work',
    })
    expect(w.schedule.entries.map(e => e.key)).toEqual(['sess-listener'])
    expect(w.schedule.entries[0]?.text).not.toContain('acme-work')
  })

  test("in a pair's general thread the session hears of it, and the thread stays the listener's", async () => {
    const w = await world()
    await ready(w)
    await deliver(w, w.P, { text: '@me.acme-work quick one', via: 'agent', at: 'acme-work' })
    expect(readThreads()[`${w.P.pub}/general`]?.handler).toBeNull()
    expect(w.schedule.entries.map(e => e.key)).toEqual(['sess-acme'])
  })

  test('an empty board proves nothing: the message goes to the listener as any other, with no "gone" note', async () => {
    const w = await world()
    await ready(w)
    w.items.length = 0
    await deliver(w, w.P, { text: 'look', thread: topic(), at: 'acme-work' })
    expect(w.schedule.entries.map(e => e.key)).toEqual(['sess-listener'])
    expect(w.schedule.entries[0]?.text).not.toContain('reaches no agent')
  })

  test('Agents off for the sender: nothing reaches a session, as for any message', async () => {
    const w = await world()
    await ready(w)
    changeAgents(x => {
      x.peers[w.P.pub] = { on: false, lanes: ['acme'] }
    })
    await deliver(w, w.P, { text: 'look', thread: topic(), at: 'acme-work' })
    expect(w.schedule.entries).toEqual([])
  })
})
