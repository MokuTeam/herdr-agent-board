// Addressing a peer's agent (#832) on the board's local API, against a hub in this process: the
// switches as before while nothing is reachable; a peer's directory in GET /api/team/directory and as `agents` on its roster row; a send that
// starts with `@name.code` opens a topic with that peer and names the agent on the signed copy, a
// code not in their directory is refused, and a session's post goes the same way into the router.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { type Client, type Harness, msgOf, question, startHarness } from '../hub/harness.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}
const get = async <T>(url: string, path: string): Promise<T> => (await (await fetch(url + path)).json()) as T

describe('team on, against a hub in this process (#832)', () => {
  const sandbox = sharedSandbox()
  let box: Sandbox
  let url = ''
  let hub: Harness
  let me: KeyPair
  let anna: KeyPair
  let annaClient: Client
  const until = async (cond: () => Promise<boolean>, what: string) => {
    const end = Date.now() + 8000
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`)
      await Bun.sleep(25)
    }
  }

  beforeAll(async () => {
    hub = await startHarness()
    me = await generateKey()
    anna = await generateKey()
    ;(await hub.join(me, 'me')).close()
    annaClient = await hub.join(anna, 'anna', undefined, ['threads', 'replies'])
    box = await sandbox()
    mkdirSync(stateOf(box), { recursive: true })
    writeFileSync(join(stateOf(box), 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
    ;({ url } = await serveBoard(box, { language: 'en', team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' } }))
    await until(
      async () =>
        (await get<{ roster: { name: string; online: boolean }[] }>(url, '/api/team')).roster.some(p => p.online),
      'the roster',
    )
  })
  afterAll(() => hub.stop())

  test('the switches answer as before: no exposed list while no session reaches anyone', async () => {
    const agents = await get<Record<string, unknown>>(url, '/api/team/agents')
    expect(agents).not.toHaveProperty('exposed')
    // The old way of exposing one by hand is no body the switches take.
    expect((await post(url, '/api/team/agents', { expose: { code: 'rev' } })).status).toBe(400)
  })

  test("anna's directory: listed, marked on her roster row; @anna.helper opens a topic with her, a code she did not list is refused", async () => {
    const view0 = await get<{ roster: Record<string, unknown>[] }>(url, '/api/team')
    expect(view0.roster[0]).not.toHaveProperty('agents')
    const env = await question(
      anna,
      me.pub,
      'agent directory',
      { body: { text: 'agent directory', agents: [{ code: 'helper' }] } },
      new Date().toISOString(),
    )
    annaClient.send({ t: 'send', env })
    await until(
      async () => (await get<{ peers: unknown[] }>(url, '/api/team/directory')).peers.length === 1,
      'the directory',
    )
    expect((await get<{ peers: unknown[] }>(url, '/api/team/directory')).peers).toEqual([
      { peer: anna.pub, name: 'anna', agents: [{ code: 'helper' }], ts: msgOf(env).ts },
    ])
    expect((await get<{ roster: Record<string, unknown>[] }>(url, '/api/team')).roster[0]).toMatchObject({
      agents: true,
    })

    // From the team chat's general: a topic of its own with anna, the agent named on her copy.
    const [status, sent] = (await answer(
      post(url, '/api/team/send', { to: 'team', text: '@anna.helper look at this' }),
    )) as [number, { ok: boolean; thread: string }]
    expect(status).toBe(200)
    expect(sent.thread.startsWith(`${anna.pub}/`)).toBe(true)
    const d = msgOf((await annaClient.take('deliver')).env)
    expect(d.body).toMatchObject({
      text: '@anna.helper look at this',
      at: 'helper',
      thread: { title: '@helper: look at this' },
    })
    expect(await answer(post(url, '/api/team/send', { to: anna.pub, text: '@anna.nope x' }))).toEqual([
      400,
      { ok: false, error: 'agent' },
    ])

    // A session's post goes the same way into the router: Agents are off for anna, so it is held, in the new topic.
    const r = (await (
      await post(url, '/api/team/post', {
        to: 'team',
        text: '@anna.helper from a session',
        session: { key: 'sess-1', name: 'worker' },
      })
    ).json()) as Record<string, unknown>
    expect(r).toMatchObject({ ok: true, sent: false, reason: 'off' })
    const drafts = (await get<{ drafts: { to: string; thread: string; text: string }[] }>(url, '/api/team/threads'))
      .drafts
    expect(drafts.at(-1)).toMatchObject({ to: anna.pub, text: '@anna.helper from a session' })
    expect(
      await answer(post(url, '/api/team/post', { to: anna.pub, text: '@anna.nope x', session: { key: 'sess-1' } })),
    ).toEqual([400, { ok: false, error: 'agent' }])
  })
})
