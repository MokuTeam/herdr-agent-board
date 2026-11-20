// A send from the owner's phone with the passkey switch on (#377): the phone cannot open the
// confirmation window, which lives on http://localhost:<port>, so the board keeps the send for the
// owner at the computer. The 428 says where it waits, GET /api/team/confirm lists it for the Team
// panel there, and the window the panel opens sends it. A send asked on the computer goes as before:
// its own window, nothing listed, no `where`. The routes run as a listener dispatches them, with the
// URL Bun builds from the Host each listener checks.
import { expect, test } from 'bun:test'
import { dispatch } from '../../src/server/http.ts'
import { teamRoutes } from '../../src/server/routes/team.ts'
import { createTeamConfirm, type TeamConfirm } from '../../src/services/team-confirm.ts'
import type { TeamService } from '../../src/services/team-hub.ts'
import { isolatedHome } from '../support/env.ts'
import { type SoftAuthenticator, softAuthenticator } from '../support/soft-authenticator.ts'

const PORT = 12470
const BEN = 'B'.repeat(43)
const COMPUTER = `http://127.0.0.1:${PORT}`
const WINDOW = `http://localhost:${PORT}`
const PHONE = `http://100.64.0.7:${PORT}`
const DOMAIN = 'https://board.example.com'

async function world() {
  isolatedHome()
  const sent: { to: string; text: string }[] = []
  let told = 0
  const team = {
    view: () => ({
      state: 'online',
      me: { peer: 'M'.repeat(43), fingerprint: 'x', name: 'atlas' },
      hub: '',
      roster: [],
    }),
    threads: () => [],
    nameOf: (peer: string) => (peer === BEN ? 'ben' : peer),
    async send(to: string, text: string) {
      sent.push({ to, text })
      return { ok: true, thread: `${to}/general` }
    },
  } as unknown as TeamService
  const confirm = createTeamConfirm({
    port: () => PORT,
    changed: () => {
      told++
    },
    later: () => {},
  })
  const key = await softAuthenticator(-7)
  const routes = teamRoutes(team, undefined, { categories: [] }, undefined, confirm)
  const call = async (
    base: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const req = new Request(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const res = await dispatch(routes, req, new URL(req.url), path, { port: PORT, token: 't', stale: () => false })
    return [res.status, (await res.json()) as Record<string, unknown>] as const
  }
  /** The window on localhost: reads the action, signs, answers from its own origin. */
  async function windowAnswers(id: string, counter: number) {
    const [, v] = await call(WINDOW, 'GET', `/api/team/confirm/${id}`)
    const options = v.options as { challenge: string }
    const at = { challenge: options.challenge, origin: WINDOW, rpId: 'localhost', counter }
    const cred = v.step === 'create' ? key.register(at) : key.assert(at)
    return call(WINDOW, 'POST', `/api/team/confirm/${id}`, { ...cred, type: 'public-key' }, { origin: WINDOW })
  }
  await switchOn(confirm, key)
  return { call, windowAnswers, sent, told: () => told }
}

/** The owner's first passkey, and the switch on, as Team, Passkeys does it. */
async function switchOn(c: TeamConfirm, key: SoftAuthenticator) {
  const add = c.pend({ kind: 'passkey-add' })
  const v = c.view(add)
  if (!v || v === 'passkey') throw new Error('no view')
  c.answer(
    add,
    {
      ...key.register({ challenge: v.options.challenge as string, origin: WINDOW, rpId: 'localhost' }),
      type: 'public-key',
    },
    null,
  )
  const on = c.pend({ kind: 'passkey-on' })
  const w = c.view(on)
  if (!w || w === 'passkey') throw new Error('no view')
  c.answer(
    on,
    {
      ...key.assert({ challenge: w.options.challenge as string, origin: WINDOW, rpId: 'localhost', counter: 1 }),
      type: 'public-key',
    },
    null,
  )
  if (!c.required()) throw new Error('the switch is not on')
}

test('a send from the phone waits for the owner at the computer: listed there, and sent by the window the panel opens', async () => {
  const w = await world()
  const [status, reply] = await w.call(PHONE, 'POST', '/api/team/send', { to: BEN, text: 'hello from the phone' })
  expect(status).toBe(428)
  expect(reply).toMatchObject({ ok: false, error: 'confirm', where: 'computer' })
  expect(w.sent).toEqual([])
  expect(w.told()).toBe(1)

  const [listed, list] = await w.call(COMPUTER, 'GET', '/api/team/confirm')
  expect(listed).toBe(200)
  const waiting = list.waiting as { id: string; at: number; confirm: string; action: Record<string, unknown> }[]
  expect(waiting.map(x => ({ id: x.id, confirm: x.confirm, action: x.action }))).toEqual([
    {
      id: reply.id as string,
      confirm: `${WINDOW}/?confirm=${reply.id}`,
      action: { kind: 'send', who: 'ben', text: 'hello from the phone' },
    },
  ])

  const [done, answer] = await w.windowAnswers(reply.id as string, 2)
  expect(done).toBe(200)
  expect(answer).toMatchObject({ ok: true, done: true })
  expect(w.sent).toEqual([{ to: BEN, text: 'hello from the phone' }])
  expect((await w.call(COMPUTER, 'GET', '/api/team/confirm'))[1]).toEqual({ waiting: [] })
  expect(w.told()).toBe(2)
})

test('through the domain it waits at the computer as well', async () => {
  const w = await world()
  const [status, reply] = await w.call(DOMAIN, 'POST', '/api/team/send', { to: BEN, text: 'hi' })
  expect(status).toBe(428)
  expect(reply.where).toBe('computer')
  expect(((await w.call(COMPUTER, 'GET', '/api/team/confirm'))[1].waiting as unknown[]).length).toBe(1)
})

test('a send on the computer goes as before: its own window, nothing listed, no where, nothing told', async () => {
  const w = await world()
  for (const base of [COMPUTER, WINDOW]) {
    const [status, reply] = await w.call(base, 'POST', '/api/team/send', { to: BEN, text: 'hi' })
    expect(status).toBe(428)
    expect(Object.keys(reply).sort()).toEqual(['confirm', 'error', 'id', 'ok'])
    expect(reply.confirm).toBe(`${WINDOW}/?confirm=${reply.id}`)
  }
  expect((await w.call(COMPUTER, 'GET', '/api/team/confirm'))[1]).toEqual({ waiting: [] })
  expect(w.told()).toBe(0)
})
