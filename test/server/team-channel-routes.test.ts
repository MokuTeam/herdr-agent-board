// Channels and a new member's welcome on a running board (#355), with a hub in this process: the
// panel's send starts a channel for some members (only they get a copy), a channel has switches of
// its own, the creator adds a member, and a member who joins after the board began keeping
// welcomes is offered one screen whose body is checked whole before anything changes. What widens
// (a send, Agents on, a lane, a channel's members, a welcome) waits for the owner's passkey (#224):
// a soft authenticator answers the confirmation window here. The board runs in a sandbox whose
// PowerShell is missing, so no notification reaches this computer's desktop.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair, type Message } from '../../src/core/team.ts'
import { teamInbox } from '../../src/entrypoints/team-inbox-cli.ts'
import { type Harness, msgOf, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'
import { softAuthenticator } from '../support/soft-authenticator.ts'

setDefaultTimeout(60_000)

const CAPS = ['threads', 'channels']

let hub: Harness
beforeAll(async () => {
  hub = await startHarness()
})
afterAll(() => hub.stop())

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 10_000
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out: ${what} (${JSON.stringify(v)})`)
    await Bun.sleep(50)
  }
}

test('a channel for some members, its switches, a member added, and a newcomer welcomed in one go', async () => {
  const box = await sandbox()
  const me = await generateKey()
  const [ana, ben, cleo] = [await generateKey(), await generateKey(), await generateKey()] as [
    KeyPair,
    KeyPair,
    KeyPair,
  ]
  ;(await hub.join(me, 'me')).close()
  const anaClient = await hub.join(ana, 'ana', undefined, CAPS)
  const benClient = await hub.join(ben, 'ben', undefined, CAPS)
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
  const { url } = await serveBoard(box, { language: 'en', team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' } })
  const get = async (path: string) => (await fetch(`${url}${path}`)).json() as Promise<Record<string, unknown>>
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return [r.status, await r.json()] as [number, Record<string, unknown>]
  }
  // The owner's passkey (#224): its window is on http://localhost:<port>, answered by a soft key.
  const key = await softAuthenticator(-7)
  const local = `http://localhost:${new URL(url).port}`
  const confirmed = async (id: string): Promise<[number, Record<string, unknown>]> => {
    const v = (await (await fetch(`${url}/api/team/confirm/${id}`)).json()) as {
      step: string
      options: { challenge: string }
    }
    const at = { challenge: v.options.challenge, origin: local, rpId: 'localhost' }
    const cred = v.step === 'create' ? key.register(at) : key.assert(at)
    const r = await fetch(`${url}/api/team/confirm/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', origin: local },
      body: JSON.stringify({ ...cred, type: 'public-key' }),
    })
    return [r.status, await r.json()] as [number, Record<string, unknown>]
  }
  /** As the panel does it: asked, then confirmed in the window when the board says so. */
  const owner = async (path: string, body: unknown): Promise<[number, Record<string, unknown>]> => {
    const [status, reply] = await post(path, body)
    return status === 428 ? confirmed(String(reply.id)) : [status, reply]
  }
  const rosterHas = (n: number) =>
    waitFor(
      () => get('/api/team'),
      v => v.state === 'online' && Array.isArray(v.roster) && v.roster.length === n,
      `${n} in the roster`,
    )
  await rosterHas(2)
  // The board begins keeping welcomes now: who is here already is not offered one.
  expect(await get('/api/team/welcome')).toEqual({ pending: [] })
  // No passkey yet: the switch "Confirm with a passkey" (#367) cannot go on; the owner adds one and
  // turns it on, so what widens waits for the passkey from here.
  expect(await post('/api/team/passkeys', { op: 'on' })).toEqual([403, { ok: false, error: 'passkey' }])
  expect((await owner('/api/team/passkeys', { op: 'add' }))[0]).toBe(200)
  expect((await owner('/api/team/passkeys', { op: 'on' }))[0]).toBe(200)
  expect(await get('/api/team/passkeys')).toMatchObject({ required: true })

  // A channel with Ana only: Ben gets nothing.
  const [status, sent] = await owner('/api/team/send', {
    to: 'team',
    text: 'the deal closes friday',
    thread: { title: 'Deals', members: [ana.pub] },
  })
  expect(status).toBe(200)
  const channel = String(sent.thread)
  const id = channel.split('/')[1] as string
  const delivered = await anaClient.take('deliver', 5000)
  const msg: Message = msgOf(delivered.env)
  expect(msg.body.thread).toEqual({ id, title: 'Deals', group: true, members: [me.pub, ana.pub].sort() })
  await Bun.sleep(300)
  expect(benClient.frames.some(f => f.t === 'deliver')).toBe(false)
  // An agent's post may not start one: only the panel's send takes members.
  expect(
    (
      await post('/api/team/post', {
        to: 'team',
        text: 'x',
        session: { key: 's1' },
        thread: { title: 'T', members: [] },
      })
    )[0],
  ).toBe(400)

  // Its own switches, by its key; a mute is the thread's, not the switches'.
  expect((await owner('/api/team/agents', { peer: channel, on: true, lanes: ['other'] }))[0]).toBe(200)
  expect((await post('/api/team/agents', { peer: channel, muted: true }))[0]).toBe(400)
  expect((await post('/api/team/agents', { peer: 'team/general', on: true }))[0]).toBe(400)
  const agents = (await get('/api/team/agents')) as { peers: Record<string, { on: boolean; lanes: string[] }> }
  expect(agents.peers[channel]).toEqual({ on: true, lanes: ['other'] })

  // The creator adds Ben; a thread that is no channel takes no members.
  // Adding a member widens who reads it: the window says which channel and whom.
  const [asked, ask] = await post(`/api/team/threads/team/${id}/members`, { add: [ben.pub] })
  expect(asked).toBe(428)
  const shownAsk = (await (await fetch(`${url}/api/team/confirm/${ask.id}`)).json()) as { action: unknown }
  expect(shownAsk.action).toEqual({ kind: 'members', channel: 'Deals', members: ['ben'] })
  expect(await confirmed(String(ask.id))).toEqual([200, { ok: true, done: true }])
  expect((await post('/api/team/threads/team/general/members', { add: [ben.pub] }))[0]).toBe(400)
  const shown = (await get(`/api/team/threads/team/${id}`)) as { thread: { members: string[] } }
  expect(shown.thread.members).toEqual([me.pub, ana.pub, ben.pub].sort())

  // Cleo joins later: offered a welcome. A body with anything wrong changes nothing.
  await Bun.sleep(5)
  const cleoClient = await hub.join(cleo, 'cleo', undefined, CAPS)
  await rosterHas(3)
  expect(await get('/api/team/welcome')).toEqual({ pending: [cleo.pub] })
  // A key that changed is not welcomed, nor offered: it may be someone else's until it is trusted.
  const pinsFile = join(state, 'team-pins.json')
  const pins = readFileSync(pinsFile, 'utf8')
  const parsed = JSON.parse(pins) as { pins: Record<string, { status: string }> }
  const own = parsed.pins[cleo.pub]
  if (own) own.status = 'changed'
  writeFileSync(pinsFile, JSON.stringify(parsed))
  expect(await get('/api/team/welcome')).toEqual({ pending: [] })
  expect(await post('/api/team/welcome', { peer: cleo.pub, on: true })).toEqual([400, { ok: false, error: 'changed' }])
  writeFileSync(pinsFile, pins)
  for (const bad of [
    { peer: cleo.pub, on: true, lanes: ['nope'], channels: [channel] },
    { peer: cleo.pub, on: true, lanes: ['other'], channels: ['team/general'] },
    { peer: (await generateKey()).pub, on: true },
    { peer: cleo.pub, on: 'yes' },
    { peer: cleo.pub, allLanes: 'yes' },
  ])
    expect((await post('/api/team/welcome', bad))[0]).toBe(400)
  const untouched = (await get('/api/team/agents')) as { peers: Record<string, unknown> }
  expect(untouched.peers[cleo.pub]).toBeUndefined()
  // A welcome that widens waits for the passkey; the window lists all of it.
  const [waits, pending] = await post('/api/team/welcome', {
    peer: cleo.pub,
    on: true,
    lanes: ['other'],
    channels: [channel],
  })
  expect(waits).toBe(428)
  const shownWelcome = (await (await fetch(`${url}/api/team/confirm/${pending.id}`)).json()) as { action: unknown }
  expect(shownWelcome.action).toEqual({ kind: 'welcome', who: 'cleo', on: true, lanes: ['Other'], channels: ['Deals'] })
  expect(await confirmed(String(pending.id))).toEqual([200, { ok: true, done: true }])
  const after = (await get('/api/team/agents')) as { peers: Record<string, unknown> }
  expect(after.peers[cleo.pub]).toEqual({ on: true, lanes: ['other'] })
  const joined = (await get(`/api/team/threads/team/${id}`)) as { thread: { members: string[] } }
  expect(joined.thread.members).toContain(cleo.pub)
  expect(await get('/api/team/welcome')).toEqual({ pending: [] })
  // board team inbox names a channel by its members, this board's names for them.
  const roster = ((await get('/api/team')).roster ?? []) as unknown[]
  const inbox = await teamInbox([], { webPort: Number(new URL(url).port), roster })
  const line = inbox.split('\n').find(l => l.startsWith(id.slice(0, 8))) ?? ''
  expect(line).toContain('channel with ')
  for (const name of ['ana', 'ben', 'cleo']) expect(line).toContain(name)
  // #386: an assistant's bridge welcomed with every lane: it widens, the window says so, and it is kept.
  const dan = await generateKey()
  await Bun.sleep(5)
  const danClient = await hub.join(dan, 'dan-assistant', undefined, [...CAPS, 'assistant'])
  await rosterHas(4)
  const danView = ((await get('/api/team')).roster as { peer: string; assistant?: boolean }[]).find(
    p => p.peer === dan.pub,
  )
  expect(danView?.assistant).toBe(true)
  const [danWaits, danPending] = await post('/api/team/welcome', { peer: dan.pub, allLanes: true, channels: [] })
  expect(danWaits).toBe(428)
  const shownDan = (await (await fetch(`${url}/api/team/confirm/${danPending.id}`)).json()) as { action: unknown }
  expect(shownDan.action).toEqual({ kind: 'welcome', who: 'dan-assistant', allLanes: true, channels: [] })
  expect(await confirmed(String(danPending.id))).toEqual([200, { ok: true, done: true }])
  const withDan = (await get('/api/team/agents')) as { peers: Record<string, unknown> }
  expect(withDan.peers[dan.pub]).toEqual({ on: false, lanes: [], allLanes: true })
  for (const c of [anaClient, benClient, cleoClient, danClient]) c.close()
})
