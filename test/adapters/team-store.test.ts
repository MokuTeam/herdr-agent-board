// What the peer network keeps in the state folder (#231): the key (0600), the inbox written by
// id, the outbox and its states, the pins, the log without bodies; and joinTeam/leaveTeam in
// config.json. Nothing is created by reading.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, joinTeam, leaveTeam, loadConfig } from '../../src/adapters/config-file.ts'
import {
  stateDir,
  teamAuditFile,
  teamDraftsFile,
  teamInboxFile,
  teamOutboxFile,
  teamReactionsFile,
} from '../../src/adapters/paths.ts'
import { dropRead, markRead, peekReads } from '../../src/adapters/team-reads.ts'
import {
  AUDIT_MAX_BYTES,
  addChannelNotices,
  addDraft,
  addInbox,
  addOutbox,
  applyReaction,
  audit,
  changePins,
  changeThreads,
  dropThreadDrafts,
  dropThreadInbox,
  dropThreadOutbox,
  dropThreadReactions,
  ensureKey,
  type InboxItem,
  KEEP_PER_PEER,
  keepDraftFile,
  keepJoinedKey,
  markAcked,
  readChannelNotices,
  readDrafts,
  readInbox,
  readKey,
  readOutbox,
  readPins,
  readReactions,
  readThreads,
  refuseChannelNotice,
  releaseHeld,
  setChannelNoticeState,
  setOutState,
  takeDraft,
} from '../../src/adapters/team-store.ts'
import { generateKey, teamConfig } from '../../src/core/team.ts'
import { msgOf, question } from '../hub/harness.ts'
import { isolatedHome } from '../support/env.ts'

const A = 'A'.repeat(43)
const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  from: A,
  ts: '2026-01-02T03:04:05.000Z',
  text: 'hello',
  receivedAt: 1,
  held: false,
  ackedAt: null,
  ...over,
})
const teamFiles = (): string[] =>
  existsSync(stateDir()) ? readdirSync(stateDir()).filter(f => f.startsWith('team-')) : []

test('reading creates nothing', () => {
  isolatedHome()
  expect(readKey()).toBeNull()
  expect(readInbox(A)).toEqual([])
  expect(readOutbox(A)).toEqual([])
  expect(readPins()).toEqual({})
  expect(teamFiles()).toEqual([])
})

test('the key is made once, 0600 where the platform has modes, and kept', async () => {
  isolatedHome()
  const first = await ensureKey()
  expect(first.pub).toHaveLength(43)
  expect(await ensureKey()).toEqual(first)
  expect(readKey()).toEqual(first)
  if (process.platform !== 'win32') expect(statSync(`${stateDir()}/team-key.json`).mode & 0o777).toBe(0o600)
})

test('two writers racing for the key end with one', async () => {
  isolatedHome()
  const [a, b] = await Promise.all([ensureKey(), ensureKey()])
  expect(a).toEqual(b)
  expect(readKey()).toEqual(a)
})

test('the inbox is written by id: a redelivery changes nothing; held ones are released', () => {
  isolatedHome()
  expect(addInbox(item('m1', { held: true }))).toBe(true)
  expect(addInbox(item('m1', { text: 'other' }))).toBe(false)
  expect(readInbox(A).map(i => [i.id, i.text])).toEqual([['m1', 'hello']])
  markAcked(A, 'm1', 9)
  expect(readInbox(A)[0]?.ackedAt).toBe(9)
  expect(releaseHeld(A)).toBe(1)
  expect(readInbox(A)[0]?.held).toBe(false)
  expect(releaseHeld(A)).toBe(0)
  if (process.platform !== 'win32') expect(statSync(`${stateDir()}/team-inbox.json`).mode & 0o777).toBe(0o600)
})

test('the outbox keeps states forward only, and the ack that came with acked', async () => {
  isolatedHome()
  const me = await ensureKey()
  const env = await question(me, A, 'q?')
  const msg = msgOf(env)
  addOutbox({ env, msg, state: 'queued', at: 1 })
  addOutbox({ env, msg, state: 'queued', at: 2 })
  expect(readOutbox(A)).toHaveLength(1)
  // What is kept to send again is the envelope as it was signed.
  expect(readOutbox(A)[0]?.env).toEqual(env)
  setOutState(msg.id, 'delivered', 3)
  setOutState(msg.id, 'queued', 4)
  expect(readOutbox(A)[0]).toMatchObject({ state: 'delivered', at: 3 })
  setOutState(msg.id, 'acked', 5, { by: A, ts: 't', sig: 's' })
  setOutState(msg.id, 'expired', 6)
  expect(readOutbox(A)[0]).toMatchObject({ state: 'acked', at: 5, ack: { by: A } })
})

test(`only the last ${KEEP_PER_PEER} per peer are kept`, () => {
  isolatedHome()
  // Most of the list is written as the file it would be: KEEP_PER_PEER locked writes one by one take
  // longer than a test may on Windows. The last ones go through addInbox, which trims.
  mkdirSync(stateDir(), { recursive: true })
  const seeded = Array.from({ length: KEEP_PER_PEER }, (_, i) => item(`m${i}`))
  writeFileSync(teamInboxFile(), JSON.stringify({ v: 1, peers: { [A]: seeded } }))
  for (let i = KEEP_PER_PEER; i < KEEP_PER_PEER + 3; i++) addInbox(item(`m${i}`))
  addInbox(item('other', { from: 'B'.repeat(43) }))
  const list = readInbox(A)
  expect(list).toHaveLength(KEEP_PER_PEER)
  expect(list[0]?.id).toBe('m3')
  expect(readInbox('B'.repeat(43))).toHaveLength(1)
})

test('pins are edited under their lock; the log is lines without a body', () => {
  isolatedHome()
  changePins(p => {
    p[A] = { name: 'anna', status: 'trusted', at: 1 }
  })
  expect(readPins()[A]).toEqual({ name: 'anna', status: 'trusted', at: 1 })
  audit('deliver', A, { id: 'm1', ok: true })
  audit('drop', null, { why: 'bad_sig' })
  const lines = readFileSync(teamAuditFile(), 'utf8').trim().split('\n')
  expect(lines.map(l => JSON.parse(l).action)).toEqual(['deliver', 'drop'])
})

test('joinTeam writes `team` and keeps the rest; leaveTeam takes it out, key and messages stay', async () => {
  isolatedHome()
  loadConfig() // writes the defaults
  const before = JSON.parse(readFileSync(configFile(), 'utf8'))
  expect(joinTeam({ hub: 'ws://100.64.0.7:7443', name: 'anna' })).toEqual({ ok: true })
  const after = JSON.parse(readFileSync(configFile(), 'utf8'))
  expect(after.team).toEqual({ hub: 'ws://100.64.0.7:7443', name: 'anna' })
  expect({ ...after, team: undefined }).toEqual({ ...before, team: undefined })
  expect(teamConfig(loadConfig().team)).toEqual({ hub: 'ws://100.64.0.7:7443', name: 'anna' })
  await ensureKey()
  expect(leaveTeam()).toEqual({ ok: true })
  expect('team' in JSON.parse(readFileSync(configFile(), 'utf8'))).toBe(false)
  expect(readKey()).not.toBeNull()
  expect(leaveTeam()).toEqual({ ok: true })
})

test('the log is rotated at 1 MiB, keeping one previous file (#231)', () => {
  isolatedHome()
  audit('first', A)
  const file = teamAuditFile()
  writeFileSync(file, `${'x'.repeat(AUDIT_MAX_BYTES)}\n`)
  audit('after', A)
  expect(readFileSync(`${file}.1`, 'utf8').length).toBeGreaterThan(AUDIT_MAX_BYTES)
  expect(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l).action),
  ).toEqual(['after'])
  // A second rotation replaces the previous file; nothing older is kept.
  writeFileSync(file, `${'y'.repeat(AUDIT_MAX_BYTES)}\n`)
  audit('again', A)
  expect(readFileSync(`${file}.1`, 'utf8').startsWith('y')).toBe(true)
  expect(readdirSync(stateDir()).filter(f => f.startsWith('team-audit'))).toEqual([
    'team-audit.jsonl',
    'team-audit.jsonl.1',
  ])
  for (let i = 0; i < 20; i++) audit('small', A)
  expect(existsSync(`${file}.2`)).toBe(false)
  expect(statSync(file).size).toBeLessThan(AUDIT_MAX_BYTES)
})

test('keepJoinedKey: the joined key is saved; another key saved meanwhile stays and the join fails (#231)', async () => {
  isolatedHome()
  const mine = await generateKey()
  await keepJoinedKey(mine)
  expect(readKey()).toEqual(mine)
  await keepJoinedKey(mine) // the same key again is fine
  const other = await generateKey()
  await expect(keepJoinedKey(other)).rejects.toThrow(/another key was saved/)
  expect(readKey()).toEqual(mine)
})

test('drafts: kept by id, oldest first, refused at the cap without writing, taken once; a file with __proto__ keys pollutes nothing (#231)', () => {
  isolatedHome()
  expect(readDrafts()).toEqual([])
  expect(existsSync(teamDraftsFile())).toBe(false)
  const d = (id: string, createdAt: number) => ({ id, to: A, text: id, createdAt })
  expect(addDraft(d('b', 2), 2)).toBe(true)
  expect(addDraft(d('a', 1), 2)).toBe(true)
  const before = readFileSync(teamDraftsFile(), 'utf8')
  expect(addDraft(d('c', 3), 2)).toBe(false)
  expect(readFileSync(teamDraftsFile(), 'utf8')).toBe(before)
  expect(readDrafts().map(x => x.id)).toEqual(['a', 'b'])
  if (process.platform !== 'win32') expect(statSync(teamDraftsFile()).mode & 0o777).toBe(0o600)
  expect(takeDraft('a')).toEqual(d('a', 1))
  expect(takeDraft('a')).toBeNull()
  for (const id of ['__proto__', 'constructor', 'toString']) expect(takeDraft(id)).toBeNull()
  writeFileSync(
    teamDraftsFile(),
    '{"v":1,"drafts":{"__proto__":{"id":"__proto__","to":"x","text":"t","createdAt":1,"polluted":true}}}',
  )
  expect(readDrafts().map(x => x.id)).toEqual(['__proto__'])
  expect(takeDraft('__proto__')?.id).toBe('__proto__')
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(({} as Record<string, unknown>).text).toBeUndefined()
})

test('channel purge helpers and notice outbox (#854): remove only target thread, create nothing on no-op', async () => {
  isolatedHome()
  const cid = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
  const chKey = `team/${cid}`
  const keepKey = `team/general`
  // No-op calls create no state files.
  expect(dropThreadInbox(chKey)).toBe(0)
  expect(dropThreadOutbox(chKey)).toBe(0)
  expect(dropThreadReactions(chKey)).toBe(0)
  expect(dropThreadDrafts(chKey)).toBe(0)
  dropRead(chKey)
  expect(existsSync(teamInboxFile())).toBe(false)
  expect(existsSync(teamOutboxFile())).toBe(false)
  expect(existsSync(teamReactionsFile())).toBe(false)
  expect(existsSync(teamDraftsFile())).toBe(false)
  expect(peekReads()).toBeNull()

  const me = await ensureKey()
  addInbox(item('m1', { thread: chKey }))
  addInbox(item('m2', { thread: keepKey }))
  const e1 = await question(me, A, 'in ch')
  const e2 = await question(me, A, 'in keep')
  addOutbox({ env: e1, msg: msgOf(e1), state: 'queued', at: 1, thread: chKey })
  addOutbox({ env: e2, msg: msgOf(e2), state: 'queued', at: 2, thread: keepKey })
  applyReaction({
    thread: chKey,
    target: 'm1',
    by: 'me',
    emoji: '👍',
    op: 'add',
    ts: '2026-01-02T03:04:05.000Z',
    id: 'r1',
  })
  applyReaction({
    thread: keepKey,
    target: 'm2',
    by: 'me',
    emoji: '👍',
    op: 'add',
    ts: '2026-01-02T03:04:05.000Z',
    id: 'r2',
  })
  const srcFile = join(stateDir(), 'src.txt')
  writeFileSync(srcFile, 'secret draft')
  const draftPath = keepDraftFile('11111111-2222-4333-8444-555555555555', srcFile)
  addDraft(
    {
      id: '11111111-2222-4333-8444-555555555555',
      to: 'team',
      text: 'draft in ch',
      createdAt: 1,
      thread: { id: cid },
      file: { path: draftPath, name: 'src.txt', size: 12 },
    },
    10,
  )
  addDraft({ id: '22222222-2222-4333-8444-555555555555', to: 'team', text: 'draft keep', createdAt: 2 }, 10)
  markRead(chKey, 100)
  markRead(keepKey, 200)

  expect(dropThreadInbox(chKey)).toBe(1)
  expect(readInbox(A).map(i => i.id)).toEqual(['m2'])
  expect(dropThreadOutbox(chKey)).toBe(1)
  expect(readOutbox(A).map(o => o.thread)).toEqual([keepKey])
  expect(dropThreadReactions(chKey)).toBe(1)
  expect(readReactions().map(r => r.thread)).toEqual([keepKey])
  expect(dropThreadDrafts(chKey)).toBe(1)
  expect(existsSync(draftPath)).toBe(false)
  expect(readDrafts().map(d => d.text)).toEqual(['draft keep'])
  dropRead(chKey)
  expect(peekReads()?.threads).toEqual({ [keepKey]: 200 })

  // Channel notice outbox persists alongside threads and stays forward-only.
  changeThreads(t => {
    t[keepKey] = {
      scope: 'team',
      id: 'general',
      title: null,
      link: null,
      handler: null,
      muted: false,
      by: 'me',
      createdAt: 1,
      lastAt: 1,
    }
  })
  const nEnv = await question(me, A, 'channel notice')
  addChannelNotices([{ env: nEnv, id: msgOf(nEnv).id, to: A, state: 'queued', at: 1 }])
  expect(readChannelNotices()).toHaveLength(1)
  expect(setChannelNoticeState(msgOf(nEnv).id, 'acked', 5)).toBe(true)
  expect(setChannelNoticeState(msgOf(nEnv).id, 'delivered', 6)).toBe(false)
  expect(readChannelNotices()[0]?.state).toBe('acked')
  expect(refuseChannelNotice(msgOf(nEnv).id, 'not_member', 7)).toBe(false)
  expect(readThreads()[keepKey]?.id).toBe('general')
})
