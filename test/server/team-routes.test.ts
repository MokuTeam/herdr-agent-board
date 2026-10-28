// The peer network on the board's local API (#231). Off (D10): with no valid `team` in config.json
// the routes are not there (404 for a GET, 405 for a POST, as before), the payload has no teamRev,
// no team file appears and herdr is asked nothing more. On: a board against a hub in this process
// (test/hub/harness.ts) answers GET /api/team, guards its POSTs, and a sent question reaches the
// peer and comes back acked.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { ackOf, type Client, type Harness, question, startHarness } from '../hub/harness.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const teamFilesOf = (box: Sandbox): string[] =>
  existsSync(stateOf(box)) ? readdirSync(stateOf(box)).filter(f => f.startsWith('team-')) : []

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
  fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** The first payload the event stream pushes. */
async function firstEvent(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/api/events`)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  let text = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('the stream ended')
    text += new TextDecoder().decode(chunk.value)
    const line = text.split('\n').find(l => l.startsWith('data: '))
    if (line && text.includes('\n\n')) {
      await reader.cancel()
      return JSON.parse(line.slice('data: '.length))
    }
  }
}

describe.each([
  ['absent', undefined],
  ['false', false],
  ['a string', 'x'],
  ['an empty object', {}],
  ['a hub that is not ws', { hub: 'http://127.0.0.1:1' }],
])('team %s', (_name, team) => {
  const sandbox = sharedSandbox()
  let box: Sandbox
  let url = ''

  beforeAll(async () => {
    box = await sandbox()
    ;({ url } = await serveBoard(box, { language: 'en', ...(team !== undefined && { team }) }))
  })

  test('the routes are not there, as on main; no teamRev; no file; herdr asked nothing more', async () => {
    const payload = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect(payload).not.toHaveProperty('teamRev')
    expect(await firstEvent(url)).not.toHaveProperty('teamRev')
    const before = box.calls().length
    expect(await answer(fetch(`${url}/api/team`))).toEqual([404, { error: 'not found' }])
    expect(await answer(fetch(`${url}/api/team/thread/x`))).toEqual([404, { error: 'not found' }])
    expect(await answer(fetch(`${url}/api/team/thread/${'A'.repeat(43)}`))).toEqual([404, { error: 'not found' }])
    for (const path of ['/api/team/send', '/api/team/trust']) {
      // With the header and without: the POST guards are not asked while the routes are not there.
      expect(await answer(post(url, path, { to: 'x', text: 'hi', peer: 'x' }))).toEqual([405, { error: 'method' }])
      expect(await answer(post(url, path, {}, {}))).toEqual([405, { error: 'method' }])
      expect(await answer(post(url, path, {}, { origin: 'http://evil.example' }))).toEqual([405, { error: 'method' }])
    }
    expect(teamFilesOf(box)).toEqual([])
    expect(box.calls().length).toBe(before)
  })
})

describe('team on, against a hub in this process', () => {
  const sandbox = sharedSandbox()
  let box: Sandbox
  let url = ''
  let hub: Harness
  let me: KeyPair
  let anna: KeyPair
  let annaClient: Client

  const view = async () =>
    (await (await fetch(`${url}/api/team`)).json()) as {
      state: string
      me: { peer: string; name: string }
      roster: { peer: string; name: string; online: boolean; pin: string }[]
    }
  const rev = async () => ((await (await fetch(`${url}/api/board`)).json()) as { teamRev?: number }).teamRev
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
    // The board's own key is the one the hub knows: it is put where the board keeps it.
    ;(await hub.join(me, 'me')).close()
    annaClient = await hub.join(anna, 'anna')
    box = await sandbox()
    mkdirSync(stateOf(box), { recursive: true })
    writeFileSync(join(stateOf(box), 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
    ;({ url } = await serveBoard(box, {
      language: 'en',
      team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' },
    }))
    await until(async () => (await view()).roster.some(p => p.name === 'anna' && p.online), 'the roster')
  })
  afterAll(() => hub.stop())

  test('GET /api/team: online, who I am, the roster with pins and fingerprints; teamRev in the payload', async () => {
    const v = await view()
    expect(v).toMatchObject({ state: 'online', me: { peer: me.pub, name: 'me' } })
    expect(v.roster).toEqual([
      expect.objectContaining({
        peer: anna.pub,
        name: 'anna',
        online: true,
        pin: 'trusted',
        fingerprint: expect.any(String),
      }),
    ])
    expect(typeof (await rev())).toBe('number')
    expect(await firstEvent(url)).toHaveProperty('teamRev')
  })

  test('the POSTs need the board header and the board origin', async () => {
    const body = { to: anna.pub, text: 'hi' }
    expect(await answer(post(url, '/api/team/send', body, {}))).toEqual([403, { error: 'header' }])
    expect(await answer(post(url, '/api/team/send', body, { 'x-board': '1', origin: 'http://evil.example' }))).toEqual([
      403,
      { error: 'origin' },
    ])
    expect(await answer(post(url, '/api/team/trust', { peer: anna.pub }, {}))).toEqual([403, { error: 'header' }])
    expect((await post(url, '/api/team/send', { to: 'nobody', text: 'hi' })).status).toBe(400)
    expect((await post(url, '/api/team/send', { to: anna.pub, text: ' ' })).status).toBe(400)
    expect((await post(url, '/api/team/trust', { peer: 'nobody' })).status).toBe(404)
    expect((await fetch(`${url}/api/team/thread/short`)).status).toBe(400)
  })

  test('"__proto__" and other names that are no key are refused and pollute nothing (#231)', async () => {
    for (const peer of ['__proto__', 'constructor', 'toString', `${'x'.repeat(43)}/`, 7]) {
      expect(await answer(post(url, '/api/team/trust', { peer }))).toEqual([404, { ok: false, error: 'peer' }])
    }
    expect(await answer(post(url, '/api/team/send', { to: '__proto__', text: 'hi' }))).toEqual([
      400,
      { ok: false, error: 'peer' },
    ])
    expect((await fetch(`${url}/api/team/thread/__proto__`)).status).toBe(400)
    expect(({} as Record<string, unknown>).status).toBeUndefined()
    expect(({} as Record<string, unknown>).name).toBeUndefined()
  })

  test('a question sent reaches the peer and comes back acked; one from the peer lands in the thread', async () => {
    const before = await rev()
    const sent = (await (await post(url, '/api/team/send', { to: anna.pub, text: 'did the build pass?' })).json()) as {
      ok: boolean
      id: string
    }
    expect(sent.ok).toBe(true)
    const delivered = await annaClient.take('deliver')
    expect(delivered.env).toMatchObject({ id: sent.id, from: me.pub, body: { text: 'did the build pass?' } })
    annaClient.send(await ackOf(anna, delivered.env))
    const thread = async () =>
      (await (await fetch(`${url}/api/team/thread/${anna.pub}`)).json()) as {
        messages: { id: string; dir: string; state?: string; text: string }[]
      }
    await until(async () => (await thread()).messages.find(m => m.id === sent.id)?.state === 'acked', 'acked')
    expect(((await rev()) ?? 0) > (before ?? 0)).toBe(true)

    const asked = await question(anna, me.pub, 'yes, green')
    annaClient.send({ t: 'send', env: asked })
    await until(async () => (await thread()).messages.some(m => m.dir === 'in' && m.text === 'yes, green'), 'the inbox')
    expect((await thread()).messages.map(m => m.dir).sort()).toEqual(['in', 'out'])
  })
})
