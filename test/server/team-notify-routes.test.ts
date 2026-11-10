// The team's unread count and its routes on a running board (#355): a peer's message through the
// hub in this process raises the payload's teamUnread; GET /api/team/unread names its thread;
// POST /api/team/read takes it off (up to a time, when given); POST /api/team/focus tells the open
// pages (`team-open`). With no `team` none of it is there: no payload field, and every route goes on
// as if it were not there (404 for the GET, 405 for a POST), as routes/team.ts's do. The board runs in a sandbox
// whose PowerShell is missing, so no notification reaches this computer's desktop.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { type Harness, question, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
const payloadOf = async (url: string) => (await (await fetch(`${url}/api/board`)).json()) as { teamUnread?: number }

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 10_000
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out: ${what} (${JSON.stringify(v)})`)
    await Bun.sleep(50)
  }
}

describe('with team', () => {
  let hub: Harness
  beforeAll(async () => {
    hub = await startHarness()
  })
  afterAll(() => hub.stop())

  test('a message from a peer is unread until its thread is read; the click tells the pages', async () => {
    const box = await sandbox()
    const me = await generateKey()
    const anna = (await generateKey()) as KeyPair
    ;(await hub.join(me, 'me')).close()
    const annaClient = await hub.join(anna, 'anna')
    const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
    const { url } = await serveBoard(box, { language: 'en', team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' } })
    await waitFor(
      async () => (await (await fetch(`${url}/api/team`)).json()) as { state?: string },
      v => v.state === 'online',
      'the board online at the hub',
    )
    expect((await payloadOf(url)).teamUnread).toBe(0)
    annaClient.send({ t: 'send', env: await question(anna, me.pub, 'is the build green?') })
    await waitFor(
      () => payloadOf(url),
      p => p.teamUnread === 1,
      'one unread',
    )
    const thread = `${anna.pub}/general`
    expect(await (await fetch(`${url}/api/team/unread`)).json()).toEqual({ unread: 1, threads: { [thread]: 1 } })

    // A notification's click: the open pages are told which thread.
    const events = await fetch(`${url}/api/events`)
    const reader = (events.body as ReadableStream<Uint8Array>).getReader()
    expect((await post(url, '/api/team/focus', { thread })).status).toBe(200)
    let seen = ''
    const decoder = new TextDecoder()
    while (!seen.includes('event: team-open')) seen += decoder.decode((await reader.read()).value)
    expect(seen).toContain(JSON.stringify({ thread }))
    await reader.cancel()

    for (const bad of [{}, { thread: 'x' }, { thread: `${anna.pub}/../general` }, { thread, upTo: 'soon' }])
      expect((await post(url, '/api/team/read', bad)).status).toBe(400)
    // Read up to a time before it came: still unread.
    expect(await (await post(url, '/api/team/read', { thread, upTo: 1 })).json()).toEqual({ ok: true, unread: 1 })
    expect(await (await post(url, '/api/team/read', { thread })).json()).toEqual({ ok: true, unread: 0 })
    await waitFor(
      () => payloadOf(url),
      p => p.teamUnread === 0,
      'nothing unread',
    )
    annaClient.close()
  })
})

describe('without team', () => {
  test('no payload field, every route as if it were not there', async () => {
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en' })
    expect(await payloadOf(url)).not.toHaveProperty('teamUnread')
    expect((await fetch(`${url}/api/team/unread`)).status).toBe(404)
    const thread = `${'A'.repeat(43)}/general`
    expect((await post(url, '/api/team/read', { thread })).status).toBe(405)
    expect((await post(url, '/api/team/focus', { thread })).status).toBe(405)
  })
})
