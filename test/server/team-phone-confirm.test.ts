// A send from the owner's phone through a real listener (#377): the tunnel's, which checks the
// Host (the domain) as the remote one checks the Tailscale name, so the board tells it from the
// computer by the URL Bun builds from that Host. With the passkey switch on the send waits for the
// owner at the computer: the 428 says so, the payload's teamWaiting lights the head's Team button,
// GET /api/team/confirm lists it, and the window on localhost sends it, after which the count is
// gone. A send on the computer, and one with the switch off, leave the payload as it was.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey } from '../../src/core/team.ts'
import { type Harness, startHarness } from '../hub/harness.ts'
import { sharedSandbox } from '../support/board-server.ts'
import { softAuthenticator } from '../support/soft-authenticator.ts'
import { seedAccess, startTunnelBoard, stateFolder, viaCaddy } from '../support/tunnel-board.ts'

setDefaultTimeout(60_000)

const sandbox = sharedSandbox()
let hub: Harness
afterAll(() => hub?.stop())

test('a send from the phone waits on the computer, lights the Team button, and goes once the window confirms it', async () => {
  hub = await startHarness()
  const me = await generateKey()
  const anna = await generateKey()
  ;(await hub.join(me, 'atlas')).close()
  const annaClient = await hub.join(anna, 'anna')
  const box = await sandbox()
  mkdirSync(stateFolder(box), { recursive: true })
  writeFileSync(join(stateFolder(box), 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
  const token = 'Q'.repeat(43)
  await seedAccess(box, { logins: [{ token }] })
  const { url, tunnel } = await startTunnelBoard(box, { team: { hub: hub.url.replace(/\/v1$/, ''), name: 'atlas' } })
  const win = `http://localhost:${new URL(url).port}`
  const key = await softAuthenticator(-7)
  let counter = 0
  const get = async (path: string) => (await (await fetch(url + path)).json()) as Record<string, unknown>
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    })
    return [r.status, (await r.json()) as Record<string, unknown>] as const
  }
  const windowAnswers = async (id: string) => {
    const v = (await get(`/api/team/confirm/${id}`)) as { step: string; options: { challenge: string } }
    const at = { challenge: v.options.challenge, origin: win, rpId: 'localhost', counter: ++counter }
    const cred = v.step === 'create' ? key.register(at) : key.assert(at)
    return post(`/api/team/confirm/${id}`, { ...cred, type: 'public-key' }, { origin: win })
  }
  const until = async (ok: () => Promise<boolean>, what: string) => {
    const end = Date.now() + 10_000
    while (!(await ok())) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`)
      await Bun.sleep(50)
    }
  }
  await until(async () => {
    const v = (await get('/api/team')) as { state?: string; roster?: { name: string }[] }
    return v.state === 'online' && !!v.roster?.some(p => p.name === 'anna')
  }, 'team online with anna')
  const phone = viaCaddy(tunnel, `__Host-board-login=${token}`)
  const fromPhone = async (text: string) => {
    const r = await phone.post('/api/team/send', { to: anna.pub, text })
    return [r.status, (await r.json()) as Record<string, unknown>] as const
  }

  // The switch off: the phone's send goes at once, as before, and the payload says nothing new.
  expect((await fromPhone('switch off'))[0]).toBe(200)
  expect(await get('/api/board')).not.toHaveProperty('teamWaiting')

  for (const op of ['add', 'on']) {
    const [status, held] = await post('/api/team/passkeys', { op })
    expect(status).toBe(428)
    expect((await windowAnswers(held.id as string))[0]).toBe(200)
  }

  // On the computer: its own window, nothing kept for the panel.
  const [local, localHeld] = await post('/api/team/send', { to: anna.pub, text: 'on the computer' })
  expect(local).toBe(428)
  expect(localHeld.where).toBeUndefined()
  expect(await get('/api/board')).not.toHaveProperty('teamWaiting')
  expect(await get('/api/team/confirm')).toEqual({ waiting: [] })

  // From the phone: it waits on the computer.
  const [status, held] = await fromPhone('hello from the phone')
  expect(status).toBe(428)
  expect(held).toMatchObject({ error: 'confirm', where: 'computer', confirm: `${win}/?confirm=${held.id}` })
  await until(async () => (await get('/api/board')).teamWaiting === 1, 'the payload counts it')
  const listed = (await get('/api/team/confirm')).waiting as { id: string; action: Record<string, unknown> }[]
  expect(listed.map(w => ({ id: w.id, action: w.action }))).toEqual([
    { id: held.id as string, action: { kind: 'send', who: 'anna', text: 'hello from the phone' } },
  ])
  // The phone cannot read that list.
  expect((await phone.get('/api/team/confirm')).status).toBe(403)

  const [done, reply] = await windowAnswers(held.id as string)
  expect(done).toBe(200)
  expect(reply).toMatchObject({ ok: true, done: true })
  await until(async () => {
    const t = (await get(`/api/team/threads/${anna.pub}/general`)) as { lines?: { text: string }[] }
    return !!t.lines?.some(l => l.text === 'hello from the phone')
  }, 'the send in the thread')
  await until(async () => !('teamWaiting' in (await get('/api/board'))), 'the count gone')
  expect(await get('/api/team/confirm')).toEqual({ waiting: [] })
  annaClient.close()
})
