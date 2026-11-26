// The owner's confirmation on the page (#224): ownerPost opens the board's window on localhost when
// the board answers 428, takes its answer only from that origin and for that id, keeps a send's
// unlock in memory for 30 minutes, and says when the window was closed or blocked. The window
// itself is found by its address, tells only the board's own origins, and words each action from
// the board's description.
import { beforeEach, expect, test } from 'bun:test'
import type { Translator } from '../../src/core/types.ts'
import { ApiError } from '../../web/src/api/client.ts'
import { confirmLines } from '../../web/src/components/team/ConfirmScreen.tsx'
import {
  CONFIRMED,
  type ConfirmDeps,
  confirmed,
  confirmPage,
  confirmPath,
  confirmScope,
  confirmWaiting,
  forgetUnlock,
  ownerPost,
} from '../../web/src/models/team-confirm.ts'

const LOCAL = 'http://localhost:12422'
const ID = 'AAAAAAAAAAAAAAAAAAAAAA'

interface Fake {
  deps: ConfirmDeps
  calls: { url: string; headers: Record<string, string>; body: unknown }[]
  opened: string[]
  message(origin: string, data: unknown): void
  win: { closed: boolean }
  tick(ms: number): void
  poll(): void
}

/** A page whose board answers with `answers`, in turn, and whose window can be answered or closed. */
function fake(answers: [number, Record<string, unknown>][], o: { blocked?: boolean } = {}): Fake {
  const calls: Fake['calls'] = []
  const opened: string[] = []
  const listeners = new Set<(e: { origin: string; data: unknown }) => void>()
  const polls = new Set<() => void>()
  const win = { closed: false }
  let clock = 1_000_000
  return {
    calls,
    opened,
    win,
    tick: ms => {
      clock += ms
    },
    message: (origin, data) => {
      for (const l of [...listeners]) l({ origin, data })
    },
    poll: () => {
      for (const p of [...polls]) p()
    },
    deps: {
      async fetch(url, init) {
        calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
        const [status, body] = answers.shift() ?? [500, {}]
        return new Response(JSON.stringify(body), { status })
      },
      open(url) {
        opened.push(url)
        return o.blocked ? null : win
      },
      listen(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      now: () => clock,
      windowOrigin: () => LOCAL,
      poll(fn) {
        polls.add(fn)
        return () => polls.delete(fn)
      },
    },
  }
}

const held = { ok: false, error: 'confirm', id: ID, confirm: `${LOCAL}/?confirm=${ID}` }
const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => forgetUnlock())

test('an answer at once is the answer: no window', async () => {
  const f = fake([[200, { ok: true, id: 'm1' }]])
  expect(await ownerPost('/api/team/send', { to: 'p', text: 'hi' }, f.deps)).toEqual({ ok: true, id: 'm1' })
  expect(f.opened).toEqual([])
  expect(f.calls[0]).toEqual({
    url: '/api/team/send',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: { to: 'p', text: 'hi' },
  })
})

test('a 428 opens the window; only its origin and id answer; the unlock goes with the next sends for 30 minutes', async () => {
  const f = fake([
    [428, held],
    [200, { ok: true, id: 'm2' }],
    [428, held],
  ])
  const asked = ownerPost('/api/team/send', { to: 'p', text: 'hi' }, f.deps)
  await settle()
  expect(f.opened).toEqual([`${LOCAL}/?confirm=${ID}`])
  // Another site, another id, or a message of another shape: not the answer.
  f.message('http://evil.example', { type: CONFIRMED, id: ID, status: 200, reply: { ok: true }, unlock: 'stolen' })
  f.message(LOCAL, { type: CONFIRMED, id: 'B'.repeat(22), status: 200, reply: { ok: true } })
  f.message(LOCAL, { type: 'other', id: ID })
  f.message(LOCAL, { type: CONFIRMED, id: ID, status: 200, reply: { ok: true, id: 'm1', done: true }, unlock: 'tok' })
  expect(await asked).toEqual({ ok: true, id: 'm1', done: true })
  await ownerPost('/api/team/send', { to: 'p', text: 'again' }, f.deps)
  expect(f.calls[1]?.headers['x-board-unlock']).toBe('tok')
  f.tick(30 * 60_000)
  const late = ownerPost('/api/team/send', { to: 'p', text: 'late' }, f.deps)
  await settle()
  expect(f.calls[2]?.headers['x-board-unlock']).toBeUndefined()
  f.win.closed = true
  f.poll()
  await expect(late).rejects.toBeInstanceOf(ApiError)
})

test('a window closed, blocked, or pointing anywhere but localhost is a refusal with its reason', async () => {
  const closed = fake([[428, held]])
  const asked = ownerPost('/api/team/trust', { peer: 'p' }, closed.deps)
  await settle()
  closed.win.closed = true
  closed.poll()
  await expect(asked).rejects.toMatchObject({ status: 0, reply: { error: 'cancelled' } })

  const blocked = fake([[428, held]], { blocked: true })
  await expect(ownerPost('/api/team/trust', { peer: 'p' }, blocked.deps)).rejects.toMatchObject({
    reply: { error: 'blocked' },
  })

  const elsewhere = fake([[428, { ...held, confirm: `http://evil.example/?confirm=${ID}` }]])
  await expect(ownerPost('/api/team/trust', { peer: 'p' }, elsewhere.deps)).rejects.toMatchObject({ status: 428 })
  expect(elsewhere.opened).toEqual([])

  const none = fake([[403, { ok: false, error: 'passkey' }]])
  await expect(ownerPost('/api/team/send', {}, none.deps)).rejects.toMatchObject({
    status: 403,
    reply: { error: 'passkey' },
  })
})

test('the window is found by its address on localhost only, and tells only the board’s own origins', () => {
  expect(confirmPage({ hostname: 'localhost', search: `?confirm=${ID}` })).toBe(ID)
  expect(confirmPage({ hostname: '127.0.0.1', search: `?confirm=${ID}` })).toBeNull()
  expect(confirmPage({ hostname: 'localhost', search: '?confirm=short' })).toBeNull()
  expect(confirmPage({ hostname: 'localhost', search: '' })).toBeNull()
  const told: [unknown, string][] = []
  const opener = { postMessage: (data: unknown, origin: string) => told.push([data, origin]) } as unknown as Window
  confirmed({ id: ID, status: 200, reply: { ok: true }, unlock: 'tok' }, '12422', opener)
  expect(told.map(([, origin]) => origin)).toEqual(['http://127.0.0.1:12422', 'http://localhost:12422'])
  expect(told[0]?.[0]).toEqual({ type: CONFIRMED, id: ID, status: 200, reply: { ok: true }, unlock: 'tok' })
  confirmed({ id: ID, status: 200, reply: {} }, '12422', null)
})

test('the window words each action from the board’s description', () => {
  const t = Object.assign(
    (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    {
      lang: 'en' as const,
    },
  ) as unknown as Translator
  expect(
    confirmLines({ kind: 'send', who: 'anna', text: 'hi', thread: 'Hub', link: 'https://example.com/1' }, t),
  ).toEqual({
    title: 'team.confirm.send {"who":"anna"}',
    text: 'hi',
    items: ['team.confirm.thread {"title":"Hub"}', 'team.confirm.link {"link":"https://example.com/1"}'],
    note: 'team.confirm.unlocks',
  })
  expect(confirmLines({ kind: 'send', who: null, text: 'all' }, t).title).toBe('team.confirm.sendTeam')
  expect(confirmLines({ kind: 'trust', who: 'anna', fingerprint: 'ab:cd' }, t)).toEqual({
    title: 'team.confirm.trust {"who":"anna"}',
    note: 'team.fingerprint {"fingerprint":"ab:cd"}',
  })
  // Every field of a change is a line: nothing it does stays off the window.
  expect(confirmLines({ kind: 'agents', who: 'anna', on: true, lanes: ['Acme', 'Zeta'], loop: 100 }, t)).toEqual({
    title: 'team.confirm.agentsFor {"who":"anna"}',
    items: [
      'team.confirm.item.on',
      'team.confirm.item.lanes {"lanes":"Acme, Zeta"}',
      'team.confirm.item.loop {"n":100}',
    ],
  })
  expect(confirmLines({ kind: 'agents', team: true, lanes: ['Acme'] }, t)).toEqual({
    title: 'team.confirm.agentsTeam',
    items: ['team.confirm.item.lanes {"lanes":"Acme"}'],
  })
  expect(confirmLines({ kind: 'agents', listener: 'day', allOn: true }, t)).toEqual({
    title: 'team.confirm.agentsBoard',
    items: ['team.confirm.item.allOn', 'team.confirm.item.listener {"session":"day"}'],
  })
  expect(confirmLines({ kind: 'agents', who: 'anna', loop: null, lanes: [] }, t).items).toEqual([
    'team.confirm.item.noLanes',
    'team.confirm.item.loopDefault',
  ])
  expect(confirmLines({ kind: 'passkey-remove', label: 'Edge on Windows' }, t).title).toBe(
    'team.confirm.remove {"label":"Edge on Windows"}',
  )
  expect(confirmLines({ kind: 'what' }, t).title).toBe('team.confirm.unknown')
})

test('the window words a channel, a welcome and a channel’s new members (#355)', () => {
  const t = Object.assign(
    (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    { lang: 'en' as const },
  ) as unknown as Translator
  expect(
    confirmLines({ kind: 'send', who: null, text: 'hi', thread: 'Deals', members: ['ana', 'ben'] }, t).items,
  ).toEqual(['team.confirm.thread {"title":"Deals"}', 'team.confirm.channelFor {"names":"ana, ben"}'])
  expect(confirmLines({ kind: 'agents', channel: 'Deals', on: true }, t).title).toBe(
    'team.confirm.agentsChannel {"channel":"Deals"}',
  )
  expect(confirmLines({ kind: 'welcome', who: 'cleo', on: true, lanes: ['Acme'], channels: ['Deals'] }, t)).toEqual({
    title: 'team.confirm.welcome {"who":"cleo"}',
    items: [
      'team.confirm.item.on',
      'team.confirm.item.lanes {"lanes":"Acme"}',
      'team.confirm.item.channels {"channels":"Deals"}',
    ],
  })
  expect(confirmLines({ kind: 'members', channel: 'Deals', members: ['ben'] }, t)).toEqual({
    title: 'team.confirm.members {"channel":"Deals"}',
    items: ['ben'],
  })
  expect(confirmLines({ kind: 'channel-delete', channel: 'Deals', members: ['ana', 'ben'] }, t)).toEqual({
    title: 'team.confirm.channelDelete {"channel":"Deals"}',
    items: ['team.confirm.channelDeleteMembers {"names":"ana, ben"}'],
    note: 'team.confirm.channelDeleteNote',
  })
  expect(confirmLines({ kind: 'channel-leave', channel: 'Theirs', members: ['ana'] }, t)).toEqual({
    title: 'team.confirm.channelLeave {"channel":"Theirs"}',
    note: 'team.confirm.channelLeaveNote',
  })
})

test('#377 Confirm in the panel opens the window of what the phone asked, and gives back what the action answered', async () => {
  const f = fake([])
  const done = confirmWaiting(`${LOCAL}/?confirm=${ID}`, ID, f.deps)
  await settle()
  expect(f.opened).toEqual([`${LOCAL}/?confirm=${ID}`])
  expect(f.calls).toEqual([])
  f.message(LOCAL, { type: CONFIRMED, id: ID, status: 200, reply: { ok: true, done: true } })
  expect(await done).toEqual({ ok: true, done: true })
})

test('#377 a window closed first is cancelled, a blocked one blocked, and an address off this board’s localhost is never opened', async () => {
  const closed = fake([])
  const asked = confirmWaiting(`${LOCAL}/?confirm=${ID}`, ID, closed.deps)
  await settle()
  closed.win.closed = true
  closed.poll()
  await expect(asked).rejects.toMatchObject({ reply: { error: 'cancelled' } })

  const blocked = fake([], { blocked: true })
  await expect(confirmWaiting(`${LOCAL}/?confirm=${ID}`, ID, blocked.deps)).rejects.toMatchObject({
    reply: { error: 'blocked' },
  })

  const elsewhere = fake([])
  await expect(confirmWaiting(`http://evil.example/?confirm=${ID}`, ID, elsewhere.deps)).rejects.toMatchObject({
    reply: { error: 'blocked' },
  })
  expect(elsewhere.opened).toEqual([])
})

test('#377 a 428 held from away opens no window, whatever its address, and is thrown as confirm', async () => {
  const f = fake([[428, { ...held, where: 'computer' }]])
  await expect(ownerPost('/api/team/send', { to: 'x', text: 'hi' }, f.deps)).rejects.toMatchObject({
    status: 428,
    reply: { error: 'confirm', where: 'computer' },
  })
  expect(f.opened).toEqual([])
})

test("the master's action for a node's page (#887): the window opens on this page's own localhost, scoped to the master", async () => {
  const f = fake([[428, { ok: false, error: 'confirm', id: ID, scope: 'master' }]])
  const asked = ownerPost('/api/master/owner-services', { op: 'passkey' }, f.deps)
  await settle()
  expect(f.opened).toEqual([`${LOCAL}/?confirm=${ID}&scope=master`])
  f.message(LOCAL, { type: CONFIRMED, id: ID, status: 200, reply: { ok: true, done: true } })
  expect(await asked).toEqual({ ok: true, done: true })
  // An id of another shape opens nothing.
  const odd = fake([[428, { ok: false, error: 'confirm', id: '../x', scope: 'master' }]])
  await expect(ownerPost('/api/master/owner-services', { op: 'passkey' }, odd.deps)).rejects.toBeInstanceOf(ApiError)
  expect(odd.opened).toEqual([])
  // The window reads and answers through the relay; this board's own as before.
  expect(confirmScope({ search: `?confirm=${ID}&scope=master` })).toBe('master')
  expect(confirmScope({ search: `?confirm=${ID}` })).toBeNull()
  expect(confirmPath(ID, 'master')).toBe(`/api/master/team/confirm/${ID}`)
  expect(confirmPath(ID)).toBe(`/api/team/confirm/${ID}`)
})
