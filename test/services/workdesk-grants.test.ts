import { expect, onTestFinished, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import { entriesOf } from '../../src/adapters/work-thread-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import { bearerDigest, type GrantRound, type RecipientChannel } from '../../src/services/workdesk-grants.ts'
import { createWorkdeskWatcher } from '../../src/services/workdesk-watcher.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

const SID = '0b7f3c1e-2d4a-4e8b-9f10-6a5c4d3b2a19'
const OTHER = '5e6d7c8b-9a0f-4e1d-8c2b-3a4f5e6d7c8b'
const ASSIGNMENT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function master(session: string, key = session, name = 'Board-codex-master', device?: string): Item {
  return {
    name,
    key,
    agent: 'codex',
    category: 'board',
    categorySet: true,
    autoName: '',
    session,
    pane: 'p1',
    workspace: null,
    cwd: '',
    status: 'idle',
    column: 'idle',
    attention: '',
    ...(device && { device }),
  }
}

const card = (revision = 1, extra: object = {}) => ({ ...task(7), assignment_id: ASSIGNMENT, revision, ...extra })

function recipient(attest = true) {
  const delivered: { round: GrantRound; bearer: string }[] = []
  const revoked: GrantRound[] = []
  const attested: GrantRound[] = []
  const channel: RecipientChannel = {
    attest: round => {
      attested.push(round)
      return attest
    },
    deliver: (round, bearer) => {
      delivered.push({ round, bearer })
      return true
    },
    revoke: round => {
      revoked.push(round)
    },
  }
  return { channel, delivered, revoked, attested }
}

function start(fake: ReturnType<typeof mcp>, items: () => Item[], channel?: RecipientChannel) {
  const logs: string[] = []
  const cfg = normalizeConfig({ threads: true, workdesk: fake.config })
  const watcher = createWorkdeskWatcher({
    cfg,
    items,
    onChange: () => {},
    log: line => logs.push(line),
    ...(channel && { recipient: channel }),
  })
  onTestFinished(() => watcher.stop())
  watcher.configChanged()
  return { watcher, logs, poll: () => watcher.reconcile(new AbortController().signal) }
}

const grantCalls = (fake: ReturnType<typeof mcp>) =>
  fake.calls('grant_task_workflow').map(call => call.params.arguments as Record<string, unknown>)

const setBindingRevision = (revision: number) => {
  const db = openDb()
  if (!db) throw new Error('missing db')
  try {
    db.db.query('UPDATE workdesk_dialog_bindings SET revision = ? WHERE task_id = 7').run(revision)
  } finally {
    db.close()
  }
}

test('without a recipient channel the watcher sends Workdesk exactly what it sent before, even when Workdesk grants', async () => {
  const run = async (grant: boolean) => {
    const fake = mcp(isolatedHome())
    fake.write({ tasks: [card()], ...(grant && { grant: {} }) })
    const { watcher } = start(fake, () => [master(SID)])
    await until(() => watcher.view()?.polledAt !== null && watcher.view()?.polledAt !== undefined)
    await watcher.stop()
    expect(rows()).toHaveLength(1)
    return fake.calls().map(call => [call.method, call.params?.name, JSON.stringify(call.params?.arguments ?? null)])
  }
  const before = await run(false)
  const after = await run(true)
  expect(after).toEqual(before)
  expect(after.some(([, name]) => name === 'grant_task_workflow')).toBe(false)
})

test('a claimed round is granted by digest and its bearer goes only to the attested session; a retry reuses the digest', async () => {
  const fake = mcp(isolatedHome())
  fake.write({ tasks: [card()], grant: { fail: 1 } })
  const r = recipient()
  const { watcher, logs, poll } = start(fake, () => [master(SID)], r.channel)
  await until(() => grantCalls(fake).length === 1)
  await until(() => logs.includes('Workdesk grant 7: grant'))
  expect(r.delivered).toEqual([])
  await poll()
  const calls = grantCalls(fake)
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0] as Record<string, unknown>)
  expect(calls[0]).toEqual({
    task_id: 7,
    assignment_id: ASSIGNMENT,
    revision: 1,
    executor: 'Board-codex-master',
    token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(r.delivered).toHaveLength(1)
  const { round, bearer } = r.delivered[0] as { round: GrantRound; bearer: string }
  expect(bearer).toMatch(/^wdplan_[A-Za-z0-9_-]{43}$/)
  expect(bearerDigest(bearer)).toBe(calls[0]?.token_hash as string)
  expect(round).toEqual({
    taskId: 7,
    assignmentId: ASSIGNMENT,
    revision: 1,
    executor: 'Board-codex-master',
    sessionKey: SID,
    sid: SID,
  })
  // Delivered once: a later poll neither grants nor delivers again.
  await poll()
  expect(grantCalls(fake)).toHaveLength(2)
  expect(r.delivered).toHaveLength(1)
  // The bearer is nowhere but in the channel: not in what Workdesk saw, the database, the thread or the log.
  await watcher.stop()
  const rpc = fake.calls()
  expect(JSON.stringify(rpc)).not.toContain(bearer)
  expect(readFileSync(dbFile()).includes(Buffer.from(bearer))).toBe(false)
  const db = openDb()
  if (!db) throw new Error('missing db')
  try {
    const thread = rows()[0]
    expect(JSON.stringify(entriesOf(db, thread?.id ?? ''))).not.toContain(bearer)
  } finally {
    db.close()
  }
  expect(logs.join('\n')).not.toContain(bearer)
  expect(r.revoked).toHaveLength(1)
})

test('a wrong SID, a session on another device or an unattested channel gets no grant at all', async () => {
  // Each case: what the board sees at the claim, then what it sees when it would grant.
  for (const [atClaim, atGrant, attest, mark] of [
    // Another session holds the SID the claim bound.
    [[master(SID)], [master(SID), master(SID, OTHER, 'Someone else')], true, 'unverified'],
    // The same key now carries another SID.
    [[master(SID)], [master(OTHER, SID)], true, 'unverified'],
    // The master's card is now a node's.
    [[master(SID)], [master(SID, SID, 'Board-codex-master', 'win-laptop')], true, 'unverified'],
    // A pane key without a SID never binds a round.
    [[master('', 'pane-p1')], [master('', 'pane-p1')], true, 'unverified'],
    [[master(SID)], [master(SID)], false, 'unattested'],
  ] as const) {
    const fake = mcp(isolatedHome())
    fake.write({ tasks: [card()], grant: {} })
    const r = recipient(attest)
    let seen = 0
    const items = () =>
      [...(seen++ === 0 ? atClaim : atGrant)].map(item => (item.session ? item : { ...item, session: null }))
    const { logs } = start(fake, items as () => Item[], r.channel)
    await until(() => logs.includes(`Workdesk grant 7: ${mark}`))
    expect(rows()).toHaveLength(1)
    expect(grantCalls(fake)).toEqual([])
    expect(r.delivered).toEqual([])
  }
})

test('rework and close revoke the round; a new round gets a fresh digest only once the board binds it', async () => {
  const fake = mcp(isolatedHome())
  fake.write({ tasks: [card()], grant: {} })
  const r = recipient()
  const { logs, poll } = start(fake, () => [master(SID)], r.channel)
  await until(() => r.delivered.length === 1)
  const first = grantCalls(fake)[0]?.token_hash

  // Rework: Workdesk starts revision 2 on the same assignment.
  fake.write({ tasks: [card(2, { status: 'doing', executor: 'Board-codex-master' })], grant: {} })
  await poll()
  expect(r.revoked.map(round => round.revision)).toEqual([1])
  expect(grantCalls(fake)).toHaveLength(1)
  expect(logs).toContain('Workdesk grant 7: unverified')
  setBindingRevision(2)
  await poll()
  expect(r.delivered.map(d => d.round.revision)).toEqual([1, 2])
  const second = grantCalls(fake)[1]
  expect(second).toMatchObject({ revision: 2 })
  expect(second?.token_hash).not.toBe(first)

  // Closed: the card leaves the list and its round is revoked.
  fake.write({ tasks: [], grant: {} })
  await poll()
  expect(r.revoked.map(round => round.revision)).toEqual([1, 2])
  expect(grantCalls(fake)).toHaveLength(2)
})

test('a round handed to another executor is revoked and never granted again by this board', async () => {
  const fake = mcp(isolatedHome())
  fake.write({ tasks: [card()], grant: {} })
  const r = recipient()
  const { poll } = start(fake, () => [master(SID)], r.channel)
  await until(() => r.delivered.length === 1)
  fake.write({ tasks: [card(1, { status: 'doing', executor: 'Other master' })], grant: {} })
  await poll()
  expect(r.revoked).toHaveLength(1)
  await poll()
  expect(grantCalls(fake)).toHaveLength(1)
  expect(r.delivered).toHaveLength(1)
})

test('a partial list revokes nothing and grants nothing', async () => {
  const fake = mcp(isolatedHome())
  fake.write({ tasks: [card()], grant: {} })
  const r = recipient()
  const { watcher, poll } = start(fake, () => [master(SID)], r.channel)
  await until(() => r.delivered.length === 1)
  fake.write({ tasks: [card(2, { status: 'doing', executor: 'Board-codex-master' }), { id: 'broken' }], grant: {} })
  await expect(poll()).rejects.toThrow('list')
  expect(watcher.view()?.problem).toBe('list')
  expect(r.revoked).toEqual([])
  expect(grantCalls(fake)).toHaveLength(1)
})
