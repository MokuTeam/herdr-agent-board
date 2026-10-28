// What the peer network keeps in the state folder (#231): the key (0600), the inbox written by
// id, the outbox and its states, the pins, the log without bodies; and joinTeam/leaveTeam in
// config.json. Nothing is created by reading.
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { configFile, joinTeam, leaveTeam, loadConfig } from '../../src/adapters/config-file.ts'
import { stateDir, teamAuditFile } from '../../src/adapters/paths.ts'
import {
  AUDIT_MAX_BYTES,
  addInbox,
  addOutbox,
  audit,
  changePins,
  ensureKey,
  type InboxItem,
  KEEP_PER_PEER,
  keepJoinedKey,
  markAcked,
  readInbox,
  readKey,
  readOutbox,
  readPins,
  releaseHeld,
  setOutState,
} from '../../src/adapters/team-store.ts'
import { generateKey, teamConfig } from '../../src/core/team.ts'
import { question } from '../hub/harness.ts'
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
  addOutbox({ env, state: 'queued', at: 1 })
  addOutbox({ env, state: 'queued', at: 2 })
  expect(readOutbox(A)).toHaveLength(1)
  setOutState(env.id, 'delivered', 3)
  setOutState(env.id, 'queued', 4)
  expect(readOutbox(A)[0]).toMatchObject({ state: 'delivered', at: 3 })
  setOutState(env.id, 'acked', 5, { by: A, ts: 't', sig: 's' })
  setOutState(env.id, 'expired', 6)
  expect(readOutbox(A)[0]).toMatchObject({ state: 'acked', at: 5, ack: { by: A } })
})

test(`only the last ${KEEP_PER_PEER} per peer are kept`, () => {
  isolatedHome()
  for (let i = 0; i < KEEP_PER_PEER + 3; i++) addInbox(item(`m${i}`))
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
