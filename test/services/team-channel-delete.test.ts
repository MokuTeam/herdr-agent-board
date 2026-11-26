// Channel delete and leave (#854) over the real hub (test/hub/harness.ts):
// - Creator deletes a channel: local channel, messages, reactions, drafts, switches and read mark
//   are purged; members receive one signed notice and move their copy to a read-only, recoverable
//   archive without erasing messages.
// - Member leaves a channel: local copy removed, active members receive a signed leave notice and
//   remove the leaver from membership; creator cannot leave.
// - Older boards ignore the notice (relayed by the hub, rejected as unknown body field).
// - Peers cannot delete a channel they did not start (local refusal and inbound auth drop).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { stateDir, teamAuditFile } from '../../src/adapters/paths.ts'
import { readReads } from '../../src/adapters/team-reads.ts'
import {
  changeAgents,
  changePins,
  keepJoinedKey,
  readAgents,
  readDrafts,
  readInbox,
  readOutbox,
  readReactions,
  readThreads,
} from '../../src/adapters/team-store.ts'
import { type Envelope, generateKey, type KeyPair, type Message, openEnvelope } from '../../src/core/team.ts'
import { createTeam, type InboundEvent, type TeamService } from '../../src/services/team-hub.ts'
import { createTeamNotify, type TeamNotify } from '../../src/services/team-notify.ts'
import { createTeamRouter, type NoticeSchedule, type RouterItem } from '../../src/services/team-router.ts'
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

const CAPS = ['threads', 'channels', 'replies', 'reactions']
const LANES = [{ id: 'acme', title: 'Acme', color: 'blue', paths: [] }]

async function nextMsg(c: Client): Promise<Message> {
  const f = await c.take('deliver', 4000)
  return msgOf((f as { env: Envelope }).env)
}

function readAudits(): Array<{ action: string; peer: string | null; [k: string]: unknown }> {
  return readFileSync(teamAuditFile(), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { action: string; peer: string | null; [k: string]: unknown })
}

async function setupBoards() {
  isolatedHome()
  const [A, B, C] = (await Promise.all([generateKey(), generateKey(), generateKey()])) as [KeyPair, KeyPair, KeyPair]
  const joined = await h.join(A, 'alice', undefined, CAPS)
  joined.close()
  await joined.closed
  await h.offline(A.pub)
  await keepJoinedKey(A)
  const b = await h.join(B, 'ben', undefined, CAPS)
  const c = await h.join(C, 'cara', undefined, CAPS)
  const cfg = { team: { hub: h.url.replace(/\/v1$/, ''), name: 'alice' }, categories: LANES }
  let route: (e: InboundEvent) => void = () => {}
  let notify: TeamNotify | null = null
  const notices: string[] = []
  const items: RouterItem[] = [{ key: 'sess-acme', name: 'acme-work', category: 'acme' }]
  svc = createTeam({
    cfg,
    log: () => {},
    onChange: () => {
      notify?.changed()
    },
    onInbound: e => {
      route(e)
      notify?.inbound(e)
    },
  })
  const team = svc
  notify = createTeamNotify({
    desktop: { show() {} },
    nameOf: p => team.nameOf(p),
  })
  const schedule: NoticeSchedule = {
    list: () => [],
    add: e => void notices.push(e.teamThread ?? e.key),
    update: () => false,
  }
  const router = createTeamRouter({ team, cfg: cfg as never, items: () => items, schedule })
  route = e => router.inbound(e)
  team.start()
  await until(() => team.view()?.state === 'online' && (team.view()?.roster.length ?? 0) === 2, 'alice online', 5000)
  // Initialize team-reads.json baseline before inbound messages arrive (as the board's payload does).
  notify.unread()
  await Bun.sleep(5)
  return { A, B, C, b, c, team, router, notify, notices }
}

test('creator deletes a channel: purges local state and sends a signed notice over the hub', async () => {
  const { A, B, C, b, c, team, notify } = await setupBoards()
  const created = await team.post({ to: 'team', thread: { title: 'Deals', members: [B.pub, C.pub] } }, 'kickoff', {
    by: 'ui',
  })
  if (!created.ok) throw new Error(created.error)
  const key = created.thread
  const id = key.split('/')[1] as string
  const firstB = await nextMsg(b)
  const firstC = await nextMsg(c)
  expect(firstB.body.thread?.members).toEqual([A.pub, B.pub, C.pub].sort())
  expect(firstC.body.thread?.members).toEqual([A.pub, B.pub, C.pub].sort())

  // Populate inbox, reaction, draft, switches and read mark for this channel.
  const replyEnv = await question(B, A.pub, 'on it', {
    body: {
      text: 'on it',
      thread: { id, title: 'Deals', group: true, members: [A.pub, B.pub, C.pub].sort() },
    },
  })
  b.send({ t: 'send', env: replyEnv })
  await until(() => team.threadLines(key).length === 2, 'reply arrives', 4000)
  await team.react(key, created.id, '👍', 'add')
  expect(await nextMsg(b)).toMatchObject({ body: { react: { emoji: '👍', op: 'add' } } })
  expect(await nextMsg(c)).toMatchObject({ body: { react: { emoji: '👍', op: 'add' } } })
  expect(team.draft('team', 'held draft', { thread: { id }, reason: 'off' }).ok).toBe(true)
  changeAgents(s => {
    s.peers[key] = { on: true, lanes: ['acme'] }
  })
  notify.read(key)
  expect(readReads(Date.now()).threads[key]).toBeDefined()

  const del = await team.deleteChannel(key)
  expect(del).toEqual({ ok: true, copies: 2, skipped: [] })
  expect(readThreads()[key]).toBeUndefined()
  expect(readInbox(B.pub).some(i => i.thread === key)).toBe(false)
  expect(readOutbox(B.pub).some(o => o.thread === key)).toBe(false)
  expect(readOutbox(C.pub).some(o => o.thread === key)).toBe(false)
  expect(readReactions().some(r => r.thread === key)).toBe(false)
  expect(readDrafts().some(d => d.thread?.id === id)).toBe(false)
  expect(readAgents().peers[key]).toBeUndefined()
  expect(readReads(Date.now()).threads[key]).toBeUndefined()
  expect(readAudits().some(a => a.action === 'channel_delete')).toBe(true)

  const delB = await nextMsg(b)
  const delC = await nextMsg(c)
  expect(delB.body).toEqual({ text: 'channel notice', channel: { id, op: 'delete' } })
  expect(delC.body).toEqual({ text: 'channel notice', channel: { id, op: 'delete' } })
})

test('member copy moves to read-only archive on creator delete notice, preserves messages, and can be restored or removed', async () => {
  const { A, B, C, b, c, team, router, notify } = await setupBoards()
  const id = crypto.randomUUID()
  const key = `team/${id}`
  const members = [A.pub, B.pub, C.pub].sort()
  const startEnv = await question(
    B,
    A.pub,
    'welcome to deals',
    { body: { text: 'welcome to deals', thread: { id, title: 'Deals', group: true, members } } },
    new Date().toISOString(),
  )
  b.send({ t: 'send', env: startEnv })
  await until(() => team.threadLines(key).length === 1, 'channel created from ben', 4000)
  expect(notify.unreadByThread()[key]).toBe(1)

  // Ben deletes the channel over the hub.
  const delEnv = await question(B, A.pub, 'channel notice', {
    body: { text: 'channel notice', channel: { id, op: 'delete' } },
  })
  b.send({ t: 'send', env: delEnv })
  await until(() => !!readThreads()[key]?.archived, 'channel archived', 4000)

  const rec = readThreads()[key]
  expect(rec?.archived).toMatchObject({ by: B.pub })
  expect(rec?.archived?.restored).toBeUndefined()
  expect(team.threadLines(key).map(l => l.text)).toEqual(['welcome to deals'])
  expect(notify.unreadByThread()[key]).toBeUndefined()
  expect(notify.unread()).toBe(0)
  expect(readAudits().some(a => a.action === 'channel_archived')).toBe(true)

  // Read-only: posting, reacting, drafting, agent posting, assigning all refused.
  expect(await team.post({ to: 'team', thread: { id } }, 'hello?', { by: 'ui' })).toEqual({
    ok: false,
    error: 'archived',
  })
  expect(await team.react(key, msgOf(startEnv).id, '👍', 'add')).toEqual({ ok: false, error: 'archived' })
  expect(team.draft('team', 'x', { thread: { id } })).toEqual({ ok: false, error: 'archived' })
  expect(await router.agentPost({ to: 'team', thread: { id }, text: 'x', session: { key: 'sess-acme' } })).toEqual({
    ok: false,
    error: 'archived',
  })
  expect(
    await router.agentReact({
      thread: key,
      message: msgOf(startEnv).id,
      emoji: '👍',
      op: 'add',
      session: { key: 'sess-acme' },
    }),
  ).toEqual({
    ok: false,
    error: 'archived',
  })
  expect(router.assign(key, { key: 'sess-acme' })).toEqual({ ok: false, error: 'archived' })

  // A late message from C to the archived channel is dropped.
  const lateEnv = await question(C, A.pub, 'late', {
    body: { text: 'late', thread: { id, title: 'Deals', group: true, members } },
  })
  c.send({ t: 'send', env: lateEnv })
  await until(() => readAudits().some(a => a.action === 'drop' && a.why === 'channel'), 'late message dropped', 4000)
  expect(team.threadLines(key)).toHaveLength(1)

  // Restore marks restored: true, still read-only.
  expect(team.restoreChannel(key)).toEqual({ ok: true })
  expect(readThreads()[key]?.archived?.restored).toBe(true)
  expect(await team.post({ to: 'team', thread: { id } }, 'still read-only?', { by: 'ui' })).toEqual({
    ok: false,
    error: 'archived',
  })

  // Removing the archived copy purges locally and sends no wire traffic.
  expect(await team.leaveChannel(key)).toEqual({ ok: true, copies: 0, skipped: [] })
  expect(readThreads()[key]).toBeUndefined()
  expect((await b.settle(120)).filter(f => f.t === 'deliver')).toEqual([])
})

test('member leaves a channel: local removal, creator membership updated, creator cannot leave', async () => {
  const { A, B, C, b, c, team } = await setupBoards()
  // Case 1: Ben starts a channel, Alice leaves it.
  const id1 = crypto.randomUUID()
  const key1 = `team/${id1}`
  const members1 = [A.pub, B.pub, C.pub].sort()
  b.send({
    t: 'send',
    env: await question(B, A.pub, 'hi', {
      body: { text: 'hi', thread: { id: id1, title: 'Sub', group: true, members: members1 } },
    }),
  })
  await until(() => !!readThreads()[key1], 'peer channel arrived', 4000)

  const left = await team.leaveChannel(key1)
  expect(left).toEqual({ ok: true, copies: 2, skipped: [] })
  expect(readThreads()[key1]).toBeUndefined()
  expect(readAudits().some(a => a.action === 'channel_leave')).toBe(true)
  expect((await nextMsg(b)).body).toEqual({ text: 'channel notice', channel: { id: id1, op: 'leave' } })
  expect((await nextMsg(c)).body).toEqual({ text: 'channel notice', channel: { id: id1, op: 'leave' } })

  // Case 2: Alice starts a 3-member channel, Ben leaves -> creator membership shrinks, next post skips Ben.
  const created = await team.post({ to: 'team', thread: { title: 'Core', members: [B.pub, C.pub] } }, 'start', {
    by: 'ui',
  })
  if (!created.ok) throw new Error(created.error)
  const key2 = created.thread
  const id2 = key2.split('/')[1] as string
  await nextMsg(b)
  await nextMsg(c)

  // Creator cannot leave their own channel.
  expect(await team.leaveChannel(key2)).toEqual({ ok: false, error: 'creator' })

  b.send({
    t: 'send',
    env: await question(B, A.pub, 'channel notice', {
      body: { text: 'channel notice', channel: { id: id2, op: 'leave' } },
    }),
  })
  await until(() => readThreads()[key2]?.members?.length === 2, 'membership shrank', 4000)
  expect(readThreads()[key2]?.members).toEqual([A.pub, C.pub].sort())
  expect(readAudits().some(a => a.action === 'channel_left')).toBe(true)

  const nextPost = await team.post({ to: 'team', thread: { id: id2 } }, 'after ben left', { by: 'ui' })
  expect(nextPost).toMatchObject({ ok: true, copies: 1 })
  expect((await nextMsg(c)).body.text).toBe('after ben left')
  expect((await b.settle(120)).filter(f => f.t === 'deliver')).toEqual([])

  // Ben cannot post to the channel after leaving.
  b.send({
    t: 'send',
    env: await question(B, A.pub, 'sneak in', {
      body: {
        text: 'sneak in',
        thread: { id: id2, title: 'Core', group: true, members: [A.pub, B.pub, C.pub].sort() },
      },
    }),
  })
  await until(
    () => readAudits().some(a => a.action === 'drop' && a.why === 'channel'),
    'post after leave dropped',
    4000,
  )

  // Case 3: 2-member channel shrinks to [A.pub] when Ben leaves, and Alice can still delete it cleanly.
  const two = await team.post({ to: 'team', thread: { title: 'Pair', members: [B.pub] } }, 'hello', { by: 'ui' })
  if (!two.ok) throw new Error(two.error)
  const key3 = two.thread
  const id3 = key3.split('/')[1] as string
  await nextMsg(b)
  b.send({
    t: 'send',
    env: await question(B, A.pub, 'channel notice', {
      body: { text: 'channel notice', channel: { id: id3, op: 'leave' } },
    }),
  })
  await until(() => readThreads()[key3]?.members?.length === 1, '2-member shrank to creator', 4000)
  expect(readThreads()[key3]?.members).toEqual([A.pub])
  expect(await team.deleteChannel(key3)).toEqual({ ok: true, copies: 0, skipped: [] })
  expect(readThreads()[key3]).toBeUndefined()
})

test('peers cannot delete a channel they did not start; changed-key notices are dropped', async () => {
  const { A, B, C, b, c, team } = await setupBoards()
  // Alice creates a channel; Cara (non-creator) tries to send a delete notice.
  const created = await team.post({ to: 'team', thread: { title: 'Owned', members: [B.pub, C.pub] } }, 'hi', {
    by: 'ui',
  })
  if (!created.ok) throw new Error(created.error)
  const key = created.thread
  const id = key.split('/')[1] as string
  await nextMsg(b)
  await nextMsg(c)

  c.send({
    t: 'send',
    env: await question(C, A.pub, 'channel notice', {
      body: { text: 'channel notice', channel: { id, op: 'delete' } },
    }),
  })
  await until(
    () => readAudits().some(a => a.action === 'drop' && a.why === 'channel_auth'),
    'spoofed delete dropped',
    4000,
  )
  expect(readThreads()[key]?.archived).toBeUndefined()
  expect((await team.post({ to: 'team', thread: { id } }, 'still open', { by: 'ui' })).ok).toBe(true)
  await nextMsg(b)
  await nextMsg(c)

  // Ben starts another channel; Alice cannot call deleteChannel on it, and Cara cannot spoof delete on it either.
  const id2 = crypto.randomUUID()
  const key2 = `team/${id2}`
  const members2 = [A.pub, B.pub, C.pub].sort()
  b.send({
    t: 'send',
    env: await question(B, A.pub, 'ben channel', {
      body: { text: 'ben channel', thread: { id: id2, title: 'Bens', group: true, members: members2 } },
    }),
  })
  await until(() => !!readThreads()[key2], 'ben channel present', 4000)
  expect(await team.deleteChannel(key2)).toEqual({ ok: false, error: 'not_creator' })
  c.send({
    t: 'send',
    env: await question(C, A.pub, 'channel notice', {
      body: { text: 'channel notice', channel: { id: id2, op: 'delete' } },
    }),
  })
  await until(
    () => readAudits().filter(a => a.action === 'drop' && a.why === 'channel_auth').length === 2,
    'second spoofed delete dropped',
    4000,
  )
  expect(readThreads()[key2]?.archived).toBeUndefined()

  // A delete notice from a peer whose key changed is dropped without archiving.
  changePins(pins => {
    const pin = pins[B.pub]
    if (pin) pin.status = 'changed'
  })
  b.send({
    t: 'send',
    env: await question(B, A.pub, 'channel notice', {
      body: { text: 'channel notice', channel: { id: id2, op: 'delete' } },
    }),
  })
  await until(
    () => readAudits().some(a => a.action === 'drop' && a.why === 'channel_held'),
    'changed-key notice dropped',
    4000,
  )
  expect(readThreads()[key2]?.archived).toBeUndefined()
  expect(stateDir()).toBeTruthy()
})

test('older boards ignore the channel notice: hub relays it, and a message with an unknown body field is dropped', async () => {
  const { A, B, b, team } = await setupBoards()
  const created = await team.post({ to: 'team', thread: { title: 'OldPeer', members: [B.pub] } }, 'hi', { by: 'ui' })
  if (!created.ok) throw new Error(created.error)
  const key = created.thread
  const id = key.split('/')[1] as string
  await nextMsg(b)

  await team.deleteChannel(key)
  const delivered = await b.take('deliver', 4000)
  // Hub relayed the signed envelope in relay mode; a board without 'channel' support rejects unknown body fields.
  expect((await openEnvelope(delivered.env, A.pub, 'relay')).ok).toBe(true)
  expect((await openEnvelope(delivered.env, A.pub, 'board')).ok).toBe(true)
  // Simulate an older board's body-field whitelist by checking a message with an unknown field on current board too:
  const unknown = await question(B, A.pub, 'channel notice', {
    body: { text: 'channel notice', futureNotice: { id, op: 'delete' } } as never,
  })
  b.send({ t: 'send', env: unknown })
  await until(() => readAudits().some(a => a.action === 'drop' && a.why === 'bad_frame'), 'unknown field dropped', 4000)
  expect(readInbox(B.pub)).toEqual([])
})
