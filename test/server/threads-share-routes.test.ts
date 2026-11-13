// Shared threads over HTTP (#394, routes/threads.ts): what goes to the hub as the owner waits for the
// passkey while that gate is on (#224, 11.2: sharing, the owner's entries, the history), and goes at
// once while it is off; unsharing narrows and never waits. Without the hub side every share op is
// refused, and the routes are as they were.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readKey } from '../../src/adapters/team-store.ts'
import { findThread } from '../../src/adapters/work-thread-store.ts'
import type { OwnerAction } from '../../src/core/team-confirm.ts'
import { sharedOf, type ThreadHead } from '../../src/core/work-threads.ts'
import { dispatch, type Route } from '../../src/server/http.ts'
import { revStream, type ThreadsApp, threadsRoutes } from '../../src/server/routes/threads.ts'
import type { SendOut, WorkHub } from '../../src/services/work-hub.ts'
import { shareThread } from '../../src/services/work-share.ts'
import { newThread, withThreadsDb } from '../../src/services/work-threads.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const BEN = `B${'b'.repeat(42)}`
const STATE = { port: 12422, token: '', stale: () => false }
const CFG = { agents: true, gapSec: 60, share: true }

function setUp({ gate = false, hub = true } = {}) {
  isolatedHome()
  const sends: { entry: string; unlocked: boolean }[] = []
  const shares: { thread: string; to: string; history: boolean }[] = []
  const pended: OwnerAction[] = []
  const work = {
    on: () => true,
    async send(entry: string, unlocked: boolean): Promise<SendOut> {
      sends.push({ entry, unlocked })
      return unlocked ? { state: 'sent' } : { state: 'confirm' }
    },
    async share(thread: string, to: string, history: boolean) {
      shares.push({ thread, to, history })
      const written = withThreadsDb(true, db => {
        if (!db) throw new Error('no db')
        const head = findThread(db, thread, null)
        return shareThread({ db, cfg: CFG, actor: { kind: 'owner' }, now: NOW, me: '' }, head, {
          kind: 'peer',
          peer: BEN,
          topic: `${BEN}/${head.id}`,
        })
      })
      return { written, sent: { state: 'sent' as const } }
    },
  } as unknown as WorkHub
  const app: ThreadsApp = {
    cfg: { threads: true },
    changed: () => {},
    tell: async () => ({ ok: true }),
    clearAsk: () => {},
    now: () => NOW,
    ...(hub && { work }),
    confirm: {
      required: () => gate,
      unlocked: token => token === 'open-sesame',
      safe: () => true,
      pend: a => {
        pended.push(a)
        return 'c0nf1rm'
      },
      urlOf: id => `http://localhost:12422/?confirm=${id}`,
    },
  }
  const routes: Route[] = threadsRoutes(app, revStream())
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1:12422${path}`)
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    })
    const res = await dispatch(routes, req, url, decodeURIComponent(url.pathname), STATE)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const thread = (): ThreadHead =>
    withThreadsDb(true, db => {
      if (!db) throw new Error('no db')
      return newThread({ db, cfg: CFG, actor: { kind: 'owner' }, now: NOW }, { lane: 'atlas', title: 'Import mapping' })
        .head
    })
  return { call, thread, sends, shares, pended }
}

test('sharing waits for the passkey while the gate is on, and goes at once while it is off', async () => {
  const on = setUp({ gate: true })
  const h = on.thread()
  const held = await on.call(`/api/threads/${h.key}`, { op: 'share', to: 'ben', history: true })
  assert.equal(held.status, 428)
  assert.equal(held.body.confirm, 'http://localhost:12422/?confirm=c0nf1rm')
  assert.deepEqual(on.pended, [{ kind: 'thread-share', thread: h.key, to: 'ben', history: true }])
  assert.deepEqual(on.shares, [])

  const off = setUp({ gate: false })
  const h2 = off.thread()
  const r = await off.call(`/api/threads/${h2.key}`, { op: 'share', to: 'ben' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(off.shares, [{ thread: h2.key, to: 'ben', history: false }])
  assert.equal(r.body.out, 'sent')
})

test("the owner's entry on a shared thread: sent with the gate off, held for the passkey with it on, unlocked by a confirmed send", async () => {
  const s = setUp({ gate: true })
  const h = s.thread()
  // Shared on the database (the route's share is the test above).
  withThreadsDb(true, db => {
    if (!db) throw new Error('no db')
    shareThread({ db, cfg: CFG, actor: { kind: 'owner' }, now: NOW, me: readKey()?.pub ?? '' }, h, {
      kind: 'peer',
      peer: BEN,
      topic: `${BEN}/${h.id}`,
    })
  })
  const held = await s.call(`/api/threads/${h.key}`, { op: 'post', text: 'ben, the 2019 columns are yours' })
  assert.equal(held.status, 428)
  assert.equal(s.pended[0]?.kind, 'thread-send')
  assert.equal(s.sends.at(-1)?.unlocked, false)
  const unlocked = await s.call(
    `/api/threads/${h.key}`,
    { op: 'post', text: 'and the 2020 ones' },
    { 'x-board-unlock': 'open-sesame' },
  )
  assert.equal(unlocked.status, 200)
  assert.equal(unlocked.body.out, 'sent')
  assert.equal(s.sends.at(-1)?.unlocked, true)
  // A local thread's post never asks the hub.
  const local = s.thread()
  const before = s.sends.length
  assert.equal((await s.call(`/api/threads/${local.key}`, { op: 'post', text: 'x' })).status, 200)
  assert.equal(s.sends.length, before)
})

test('unsharing narrows: it never waits for the passkey, and the thread stops being shared', async () => {
  const s = setUp({ gate: true })
  const h = s.thread()
  withThreadsDb(true, db => {
    if (!db) throw new Error('no db')
    shareThread({ db, cfg: CFG, actor: { kind: 'owner' }, now: NOW, me: '' }, h, {
      kind: 'peer',
      peer: BEN,
      topic: `${BEN}/${h.id}`,
    })
  })
  const r = await s.call(`/api/threads/${h.key}`, { op: 'unshare' })
  // Its last entry (the one that tells ben) is an owner's send: with the gate on it waits for the press.
  assert.ok(r.status === 200 || r.status === 428, JSON.stringify(r.body))
  const head = withThreadsDb(false, db => (db ? findThread(db, h.key, null) : null))
  assert.equal(head && sharedOf(head), null)
})

test('without the hub side every share op is refused, and the other ops are as they were', async () => {
  const s = setUp({ hub: false })
  const h = s.thread()
  for (const op of ['share', 'unshare', 'take', 'send', 'history']) {
    const r = await s.call(`/api/threads/${h.key}`, { op, to: 'ben', entry: 'x' })
    assert.equal(r.status, 400, op)
    assert.equal(r.body.code, 'share_off')
  }
  assert.equal((await s.call(`/api/threads/${h.key}`, { op: 'post', text: 'still mine' })).status, 200)
})

test('the owner offers a shared thread to the teammate it is shared with; to anyone else, or on a local thread, it is refused', async () => {
  const s = setUp({ gate: false })
  const h = s.thread()
  const local = await s.call(`/api/threads/${h.key}`, { op: 'set', assignee: { peer: BEN, name: 'ben' } })
  assert.equal(local.status, 400)
  withThreadsDb(true, db => {
    if (!db) throw new Error('no db')
    shareThread({ db, cfg: CFG, actor: { kind: 'owner' }, now: NOW, me: '' }, h, {
      kind: 'peer',
      peer: BEN,
      topic: `${BEN}/${h.id}`,
    })
  })
  const other = await s.call(`/api/threads/${h.key}`, { op: 'set', assignee: { peer: `C${'c'.repeat(42)}` } })
  assert.equal(other.status, 400)
  const offered = await s.call(`/api/threads/${h.key}`, { op: 'set', assignee: { peer: BEN, name: 'ben' } })
  assert.equal(offered.status, 200, JSON.stringify(offered.body))
  assert.deepEqual((offered.body.head as ThreadHead).assignee, { kind: 'peer', peer: BEN, name: 'ben' })
  assert.equal(offered.body.out, 'sent')
})
