// The peer network on the board's local API (#231). Off (D10): with no valid `team` in config.json
// the routes are not there (404 for a GET, 405 for a POST, as before), the payload has no teamRev,
// no team file appears and herdr is asked nothing more. On: a board against a hub in this process
// (test/hub/harness.ts) answers GET /api/team, guards its POSTs, and a sent question reaches the
// peer and comes back acked.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envelopeBytes, generateKey, type KeyPair, verify } from '../../src/core/team.ts'
import { ackOf, type Client, type Harness, msgOf, question, startHarness } from '../hub/harness.ts'
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

/**
 * The board's own start-up calls to herdr are done: its first snapshot was asked for, and no call
 * came for 300 ms. A call kind counted before then could still be the board's own, landing late.
 */
async function startupSettled(box: Sandbox): Promise<void> {
  const deadline = Date.now() + 15_000
  let count = -1
  let quietSince = Date.now()
  for (;;) {
    const calls = box.calls()
    if (calls.length !== count) {
      count = calls.length
      quietSince = Date.now()
    }
    const snapshot = calls.some(c => c[0] === 'api' && c[1] === 'snapshot')
    if (snapshot && Date.now() - quietSince >= 300) return
    if (Date.now() > deadline) throw new Error(`the board's start-up calls did not settle: ${calls.length} so far`)
    await new Promise(r => setTimeout(r, 20))
  }
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
    // The board's own refresh may poll herdr meanwhile: what counts is that asking adds no new kind of call.
    // Counted once the board's start-up calls are in, so none of them lands among the added ones.
    await startupSettled(box)
    const kind = (c: string[]): string => c.slice(0, 2).join(' ')
    const before = box.calls().length
    const seen = new Set(box.calls().map(kind))
    expect(await answer(fetch(`${url}/api/team`))).toEqual([404, { error: 'not found' }])
    expect(await answer(fetch(`${url}/api/team/thread/x`))).toEqual([404, { error: 'not found' }])
    expect(await answer(fetch(`${url}/api/team/thread/${'A'.repeat(43)}`))).toEqual([404, { error: 'not found' }])
    // #216's routes are not there either.
    for (const path of ['/api/team/threads', `/api/team/threads/team/general`, '/api/team/agents'])
      expect(await answer(fetch(url + path))).toEqual([404, { error: 'not found' }])
    for (const path of [
      '/api/team/post',
      '/api/team/listen',
      '/api/team/agents',
      '/api/team/threads/team/general/assign',
      '/api/team/threads/team/general/mute',
      '/api/team/send',
      '/api/team/trust',
      '/api/team/draft',
      '/api/team/draft/11111111-1111-4111-8111-111111111111/send',
      '/api/team/draft/11111111-1111-4111-8111-111111111111/discard',
      '/api/team/draft/__proto__/send',
    ]) {
      // With the header and without: the POST guards are not asked while the routes are not there.
      expect(await answer(post(url, path, { to: 'x', text: 'hi', peer: 'x' }))).toEqual([405, { error: 'method' }])
      expect(await answer(post(url, path, {}, {}))).toEqual([405, { error: 'method' }])
      expect(await answer(post(url, path, {}, { origin: 'http://evil.example' }))).toEqual([405, { error: 'method' }])
    }
    expect(teamFilesOf(box)).toEqual([])
    const added = box.calls().slice(before).map(kind)
    expect(added.filter(k => !seen.has(k))).toEqual([])
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
    expect(delivered.env.from).toBe(me.pub)
    expect(msgOf(delivered.env)).toMatchObject({ id: sent.id, from: me.pub, body: { text: 'did the build pass?' } })
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

  const draftBody = (text: string) => ({ to: anna.pub, text })
  const thread = async () =>
    (await (await fetch(`${url}/api/team/thread/${anna.pub}`)).json()) as {
      messages: { id: string; dir: string; state?: string; text: string; via?: string }[]
    }
  const drafts = async () => (await thread()).messages.filter(m => m.dir === 'draft')

  test('a draft is kept, shown in the thread and counted on the roster, and nothing reaches the peer until Send', async () => {
    const outBefore = (await thread()).messages.filter(m => m.dir === 'out').length
    const made = (await (await post(url, '/api/team/draft', draftBody('  can you review #231?  '))).json()) as {
      ok: boolean
      id: string
    }
    expect(made.ok).toBe(true)
    expect(await drafts()).toEqual([
      expect.objectContaining({ id: made.id, dir: 'draft', text: 'can you review #231?' }),
    ])
    const v = (await (await fetch(`${url}/api/team`)).json()) as { roster: { drafts: number }[] }
    expect(v.roster[0]?.drafts).toBe(1)
    expect(existsSync(join(stateOf(box), 'team-drafts.json'))).toBe(true)
    // Not sent: the peer's connection has nothing, and the outbox is empty.
    await Bun.sleep(150)
    expect((await thread()).messages.filter(m => m.dir === 'out')).toHaveLength(outBefore)
    expect(await answer(post(url, `/api/team/draft/${made.id}/discard`, {}))).toEqual([200, { ok: true }])
    expect(await drafts()).toEqual([])
    expect(await answer(post(url, `/api/team/draft/${made.id}/discard`, {}))).toEqual([
      404,
      { ok: false, error: 'draft' },
    ])
    expect(await answer(post(url, `/api/team/draft/${made.id}/send`, {}))).toEqual([404, { ok: false, error: 'draft' }])
  })

  test('Send on a draft sends it once with via "agent" in the signed body, the peer gets it unchanged', async () => {
    const made = (await (await post(url, '/api/team/draft', draftBody('agent asks: green?'))).json()) as { id: string }
    const sent = (await (await post(url, `/api/team/draft/${made.id}/send`, {})).json()) as { ok: boolean; id: string }
    expect(sent.ok).toBe(true)
    const delivered = await annaClient.take('deliver')
    expect(msgOf(delivered.env)).toMatchObject({ id: sent.id, body: { text: 'agent asks: green?', via: 'agent' } })
    expect(await verify(me.pub, envelopeBytes(delivered.env.payload), delivered.env.sig)).toBe(true)
    annaClient.send(await ackOf(anna, delivered.env))
    expect(await drafts()).toEqual([])
    expect((await thread()).messages.find(m => m.id === sent.id)).toMatchObject({ dir: 'out', via: 'agent' })
    // A second press finds no draft, and sends nothing more.
    expect(await answer(post(url, `/api/team/draft/${made.id}/send`, {}))).toEqual([404, { ok: false, error: 'draft' }])
    // A message typed in the panel goes with no via.
    const typed = (await (await post(url, '/api/team/send', draftBody('by hand'))).json()) as { id: string }
    const d2 = await annaClient.take('deliver')
    expect(msgOf(d2.env).id).toBe(typed.id)
    expect(msgOf(d2.env).body).toEqual({ text: 'by hand' })
    annaClient.send(await ackOf(anna, d2.env))
  })

  test('the draft routes need the board header and origin, valid peer ids and draft ids; nothing is made from junk', async () => {
    const body = draftBody('x')
    expect(await answer(post(url, '/api/team/draft', body, {}))).toEqual([403, { error: 'header' }])
    expect(await answer(post(url, '/api/team/draft', body, { 'x-board': '1', origin: 'http://evil.example' }))).toEqual(
      [403, { error: 'origin' }],
    )
    const id = '11111111-1111-4111-8111-111111111111'
    for (const action of ['send', 'discard']) {
      expect(await answer(post(url, `/api/team/draft/${id}/${action}`, {}, {}))).toEqual([403, { error: 'header' }])
      for (const bad of ['__proto__', 'constructor', 'nope', `${id}x`])
        expect(await answer(post(url, `/api/team/draft/${bad}/${action}`, {}))).toEqual([
          400,
          { ok: false, error: 'draft' },
        ])
    }
    for (const to of ['__proto__', 'constructor', 'nobody', 7, `${'Q'.repeat(43)}`])
      expect((await post(url, '/api/team/draft', { to, text: 'x' })).status).toBe(400)
    expect((await post(url, '/api/team/draft', { to: anna.pub, text: ' ' })).status).toBe(400)
    expect((await post(url, '/api/team/draft', { to: anna.pub, text: 'x'.repeat(4001) })).status).toBe(400)
    expect((await post(url, '/api/team/draft', { to: anna.pub })).status).toBe(400)
    expect(await drafts()).toEqual([])
    expect(({} as Record<string, unknown>).drafts).toBeUndefined()
  })

  test('at 20 waiting drafts the next is refused as full, and discarding one makes room', async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const r = (await (await post(url, '/api/team/draft', draftBody(`d${i}`))).json()) as { id: string }
      ids.push(r.id)
    }
    expect(await answer(post(url, '/api/team/draft', draftBody('one too many')))).toEqual([
      400,
      { ok: false, error: 'full' },
    ])
    expect(await drafts()).toHaveLength(20)
    await post(url, `/api/team/draft/${ids[0]}/discard`, {})
    expect((await post(url, '/api/team/draft', draftBody('fits now'))).status).toBe(200)
    for (const m of await drafts()) await post(url, `/api/team/draft/${m.id}/discard`, {})
    expect(await drafts()).toEqual([])
  })

  test("a session's post is an agent's whatever its body claims; off by default it is held, on it goes marked (#216, #224)", async () => {
    const session = { key: 'sess-1', name: 'worker' }
    const claim = { to: anna.pub, text: 'from a session', session, by: 'ui', via: 'human', source: 'human' }
    const held = (await (await post(url, '/api/team/post', claim)).json()) as Record<string, unknown>
    expect(held).toMatchObject({ ok: true, sent: false, reason: 'off' })
    const general = (await (await fetch(`${url}/api/team/threads/${anna.pub}/general`)).json()) as { lines: unknown[] }
    expect(general.lines.at(-1)).toMatchObject({
      dir: 'draft',
      text: 'from a session',
      via: 'agent',
      agent: 'worker',
      reason: 'off',
    })
    for (const m of await drafts()) await post(url, `/api/team/draft/${m.id}/discard`, {})
    // The owner turns agents on for anna (no lane shared) and makes the session the listener.
    expect(await answer(post(url, '/api/team/agents', { peer: anna.pub, on: true, lanes: ['no-such-lane'] }))).toEqual([
      400,
      { ok: false, error: 'lanes' },
    ])
    expect(await answer(post(url, '/api/team/agents', { peer: anna.pub, on: true }))).toEqual([200, { ok: true }])
    expect(await answer(post(url, '/api/team/listen', { session }))).toEqual([200, { ok: true }])
    const agents = (await (await fetch(`${url}/api/team/agents`)).json()) as Record<string, unknown>
    expect(agents).toMatchObject({ off: false, listener: session, peers: { [anna.pub]: { on: true, lanes: [] } } })
    const r = (await (await post(url, '/api/team/post', { ...claim, thread: { title: 'Routes' } })).json()) as {
      sent: boolean
      thread: string
    }
    expect(r.sent).toBe(true)
    const d = await annaClient.take('deliver')
    // anna's client said no caps: the plain body, with the title in front, and the agent mark.
    expect(msgOf(d.env).body).toEqual({ text: '[Routes] from a session', via: 'agent' })
    annaClient.send(await ackOf(anna, d.env))
    const threads = (await (await fetch(`${url}/api/team/threads`)).json()) as {
      threads: { key: string; title: string }[]
    }
    expect(threads.threads.find(t => t.key === r.thread)).toMatchObject({ title: 'Routes' })
    const [scope, id] = r.thread.split('/')
    const one = (await (await fetch(`${url}/api/team/threads/${scope}/${id}`)).json()) as { lines: unknown[] }
    expect(one.lines[0]).toMatchObject({ dir: 'out', via: 'agent', agent: 'worker', text: '[Routes] from a session' })
    // The switches and the session's routes keep the panel's guards.
    for (const path of ['/api/team/post', '/api/team/listen', '/api/team/agents'])
      expect(await answer(post(url, path, claim, {}))).toEqual([403, { error: 'header' }])
    expect(await answer(post(url, '/api/team/post', { to: anna.pub, text: 'x' }))).toEqual([
      400,
      { ok: false, error: 'body' },
    ])
    await post(url, '/api/team/agents', { peer: anna.pub, on: false })
    await post(url, '/api/team/listen', { session: null })
  })

  test("#360: a peer's loop pause is set and cleared on POST /api/team/agents, shown with the default; out of range is refused", async () => {
    for (const loop of [0, 101, 2.5, '5'])
      expect(await answer(post(url, '/api/team/agents', { peer: anna.pub, loop }))).toEqual([
        400,
        { ok: false, error: 'loop' },
      ])
    expect(await answer(post(url, '/api/team/agents', { peer: anna.pub, loop: 5 }))).toEqual([200, { ok: true }])
    expect(await answer(post(url, '/api/team/agents', { peer: 'team', loop: 30 }))).toEqual([200, { ok: true }])
    const agents = async () =>
      (await (await fetch(`${url}/api/team/agents`)).json()) as {
        loopDefault: number
        peers: Record<string, { loop?: number }>
      }
    expect((await agents()).loopDefault).toBe(20)
    expect((await agents()).peers[anna.pub]?.loop).toBe(5)
    expect((await agents()).peers.team?.loop).toBe(30)
    expect(await answer(post(url, '/api/team/agents', { peer: anna.pub, loop: null }))).toEqual([200, { ok: true }])
    expect((await agents()).peers[anna.pub]).not.toHaveProperty('loop')
  })
})
