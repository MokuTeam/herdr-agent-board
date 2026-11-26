// Addressing a peer's agent (#832) over the real hub (test/hub/harness.ts): this board (the real
// service and router, its own WebSocket) and two peers that speak the wire protocol with their own
// keys, so every message is signed, relayed and checked as between real boards. A shares a lane
// with B: B's directory lists the session in it by its handle, C (no lane shared) gets nothing;
// `at` from B reaches that session on A, and its answer goes back in the same topic; the handle
// from C goes to A's listener with a note. And the other way: B's directory kept on A, and
// A's `@ben.helper` copy names the agent while a code B did not list is refused.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { changeAgents, keepJoinedKey, readThreads } from '../../src/adapters/team-store.ts'
import { type Envelope, generateKey, type KeyPair, type Message } from '../../src/core/team.ts'
import { createTeam, type TeamService } from '../../src/services/team-hub.ts'
import {
  createTeamRouter,
  type NoticeEntry,
  type NoticeSchedule,
  type RouterItem,
} from '../../src/services/team-router.ts'
import { type Client, type Harness, msgOf, question, startHarness } from '../hub/harness.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/team-service.ts'

let h: Harness
let svc: TeamService | null = null
beforeEach(async () => {
  h = await startHarness()
})
afterEach(() => {
  svc?.stop()
  svc = null
  h.stop()
})

const LANES = [
  { id: 'personal', color: 'green', paths: [] },
  { id: 'acme', title: 'Acme Corp', color: 'blue', paths: [] },
]

function memSchedule(): NoticeSchedule & { entries: (NoticeEntry & { text: string })[] } {
  const entries: (NoticeEntry & { text: string })[] = []
  let n = 0
  return {
    entries,
    list: () => entries,
    add: e => void entries.push({ id: `e${++n}`, key: e.key, text: e.text, teamThread: e.teamThread }),
    update: () => false,
  }
}

/** The next message delivered to a peer's client, read (its signature was checked by the hub's relay and here by the board's rules). */
async function next(c: Client): Promise<Message> {
  const f = await c.take('deliver', 4000)
  return msgOf((f as { env: Envelope }).env)
}

async function boards() {
  isolatedHome()
  const [A, B, C] = (await Promise.all([generateKey(), generateKey(), generateKey()])) as [KeyPair, KeyPair, KeyPair]
  // A joins as the board would (`board team join`), then lets go: its own service connects next.
  const joined = await h.join(A, 'alice')
  joined.close()
  await joined.closed
  await h.offline(A.pub)
  await keepJoinedKey(A)
  const b = await h.join(B, 'ben', undefined, ['threads', 'replies'])
  const c = await h.join(C, 'cara', undefined, ['threads', 'replies'])
  const cfg = { team: { hub: h.url.replace(/\/v1$/, ''), name: 'alice' }, categories: LANES }
  const schedule = memSchedule()
  const items: RouterItem[] = [
    { key: 'sess-acme', name: 'acme-work', category: 'acme' },
    { key: 'sess-listener', name: 'day', category: 'personal' },
  ]
  let route: (e: Parameters<ReturnType<typeof createTeamRouter>['inbound']>[0]) => void = () => {}
  svc = createTeam({ cfg, log: () => {}, onChange: () => {}, onInbound: e => route(e) })
  const team = svc
  const router = createTeamRouter({ team, cfg: cfg as never, items: () => items, schedule })
  route = e => router.inbound(e)
  team.start()
  await until(() => team.view()?.state === 'online' && (team.view()?.roster.length ?? 0) === 2, 'A online', 5000)
  return { A, B, C, b, c, team, router, schedule }
}

test('A shares a lane with B: B gets the directory, C does not; @A.handle reaches the session and its answer comes back in the topic', async () => {
  const { A, B, C, b, c, router, schedule } = await boards()
  // Exposure follows the lanes shared: acme with B, nothing with C (Agents on for both).
  changeAgents(x => {
    x.peers[B.pub] = { on: true, lanes: ['acme'] }
    x.peers[C.pub] = { on: true, lanes: [] }
    x.listener = { key: 'sess-listener', name: 'day' }
  })
  expect(await router.syncDirectory()).toBe(1)
  const dir = await next(b)
  expect(dir.from).toBe(A.pub)
  expect(dir.body.agents).toEqual([{ code: 'acme-work' }])
  expect((await c.settle(150)).filter(f => f.t === 'deliver')).toEqual([])

  // B addresses it, in a topic of its own.
  const thread = { id: crypto.randomUUID(), title: '@acme-work: check the PR' }
  const text = '@alice.acme-work check the PR'
  const env = await question(
    B,
    A.pub,
    text,
    { body: { text, via: 'agent', thread, at: 'acme-work' } },
    new Date().toISOString(),
  )
  b.send({ t: 'send', env })
  const key = `${B.pub}/${thread.id}`
  await until(() => schedule.entries.length === 1, 'a notice')
  expect(schedule.entries[0]).toMatchObject({ key: 'sess-acme', teamThread: key })
  expect(schedule.entries[0]?.text).toContain("ben's agent wrote to you as @acme-work")
  expect(readThreads()[key]?.handler?.key).toBe('sess-acme')

  // The session answers there; B gets it in the same topic.
  const r = await router.agentPost({
    to: B.pub,
    thread: { id: thread.id },
    text: 'looked: fine',
    session: { key: 'sess-acme' },
  })
  expect(r).toMatchObject({ ok: true, sent: true, thread: key })
  const answer = await next(b)
  expect(answer.body).toMatchObject({ text: 'looked: fine', via: 'agent', thread: { id: thread.id } })

  // C addresses the same handle: no lane shared with C, so A's listener hears with a note, nobody handles it.
  const t2 = { id: crypto.randomUUID(), title: '@acme-work: me too' }
  const env2 = await question(
    C,
    A.pub,
    'me too',
    { body: { text: 'me too', thread: t2, at: 'acme-work' } },
    new Date().toISOString(),
  )
  c.send({ t: 'send', env: env2 })
  await until(() => schedule.entries.length === 2, 'the listener')
  expect(schedule.entries[1]).toMatchObject({ key: 'sess-listener', teamThread: `${C.pub}/${t2.id}` })
  expect(schedule.entries[1]?.text).toContain('which reaches no agent here now')
  expect(readThreads()[`${C.pub}/${t2.id}`]?.handler).toBeNull()
})

test("B's directory on A: listed for the composer and the CLI; A's @ben.helper names it on B's copy, an unlisted code is refused", async () => {
  const { A, B, b, team } = await boards()
  const env = await question(
    B,
    A.pub,
    'agent directory',
    { body: { text: 'agent directory', agents: [{ code: 'helper' }] } },
    new Date().toISOString(),
  )
  b.send({ t: 'send', env })
  await until(() => team.directories().length === 1, "B's directory")
  expect(team.directories()[0]).toMatchObject({ peer: B.pub, name: 'ben', agents: [{ code: 'helper' }] })
  const r = await team.post({ to: B.pub, thread: { title: '@helper: hi' } }, '@ben.helper hi', { by: 'ui' })
  expect(r.ok).toBe(true)
  const got = await next(b)
  expect(got.body).toMatchObject({ text: '@ben.helper hi', at: 'helper', thread: { title: '@helper: hi' } })
  expect(await team.post({ to: B.pub }, '@ben.other hi', { by: 'ui' })).toEqual({ ok: false, error: 'agent' })
})
