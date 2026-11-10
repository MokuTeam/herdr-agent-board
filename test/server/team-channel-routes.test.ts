// Channels and a new member's welcome on a running board (#355), with a hub in this process: the
// panel's send starts a channel for some members (only they get a copy), a channel has switches of
// its own, the creator adds a member, and a member who joins after the board began keeping
// welcomes is offered one screen whose body is checked whole before anything changes. The board
// runs in a sandbox whose PowerShell is missing, so no notification reaches this computer's desktop.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair, type Message } from '../../src/core/team.ts'
import { teamInbox } from '../../src/entrypoints/team-inbox-cli.ts'
import { type Harness, msgOf, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

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
  const rosterHas = (n: number) =>
    waitFor(
      () => get('/api/team'),
      v => v.state === 'online' && Array.isArray(v.roster) && v.roster.length === n,
      `${n} in the roster`,
    )
  await rosterHas(2)
  // The board begins keeping welcomes now: who is here already is not offered one.
  expect(await get('/api/team/welcome')).toEqual({ pending: [] })

  // A channel with Ana only: Ben gets nothing.
  const [status, sent] = await post('/api/team/send', {
    to: 'team',
    text: 'the deal closes friday',
    thread: { title: 'Deals', members: [ana.pub] },
  })
  expect(status).toBe(200)
  const key = String(sent.thread)
  const id = key.split('/')[1] as string
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
  expect((await post('/api/team/agents', { peer: key, on: true, lanes: ['other'] }))[0]).toBe(200)
  expect((await post('/api/team/agents', { peer: key, muted: true }))[0]).toBe(400)
  expect((await post('/api/team/agents', { peer: 'team/general', on: true }))[0]).toBe(400)
  const agents = (await get('/api/team/agents')) as { peers: Record<string, { on: boolean; lanes: string[] }> }
  expect(agents.peers[key]).toEqual({ on: true, lanes: ['other'] })

  // The creator adds Ben; a thread that is no channel takes no members.
  expect(await post(`/api/team/threads/team/${id}/members`, { add: [ben.pub] })).toEqual([200, { ok: true }])
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
    { peer: cleo.pub, on: true, lanes: ['nope'], channels: [key] },
    { peer: cleo.pub, on: true, lanes: ['other'], channels: ['team/general'] },
    { peer: (await generateKey()).pub, on: true },
    { peer: cleo.pub, on: 'yes' },
  ])
    expect((await post('/api/team/welcome', bad))[0]).toBe(400)
  const untouched = (await get('/api/team/agents')) as { peers: Record<string, unknown> }
  expect(untouched.peers[cleo.pub]).toBeUndefined()
  expect(await post('/api/team/welcome', { peer: cleo.pub, on: true, lanes: ['other'], channels: [key] })).toEqual([
    200,
    { ok: true },
  ])
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
  for (const c of [anaClient, benClient, cleoClient]) c.close()
})
