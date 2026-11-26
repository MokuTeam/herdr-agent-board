// `board team inbox | watch` and `board team thread --json | --read` (#355) against a running board
// in a sandbox and a hub in this process: inbox lists the threads with their unread counts in the
// board's own words (a member's title quoted and printable, never a message's text); thread --json
// gives the text as data under a note that says whose it is; reading marks nothing, --read does;
// a muted thread and the team chat muted count nothing (the switch moves the count at once); watch
// says each thread that got new messages, never a member's words (not even a topic's title).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import type { ThreadRef } from '../../src/core/team-wire.ts'
import { teamAgents } from '../../src/entrypoints/team-agents-cli.ts'
import { teamInbox, teamWait, teamWatch, watchFlags } from '../../src/entrypoints/team-inbox-cli.ts'
import { type Harness, question, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

setDefaultTimeout(60_000)

const TOPIC = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
const PLAN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

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

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

test('inbox, thread --json and --read, mutes and watch, on a running board', async () => {
  const box = await sandbox()
  const me = await generateKey()
  const anna = (await generateKey()) as KeyPair
  ;(await hub.join(me, 'me')).close()
  const annaClient = await hub.join(anna, 'anna')
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
  const { url } = await serveBoard(box, { language: 'en', team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' } })
  const view = await waitFor(
    async () => (await (await fetch(`${url}/api/team`)).json()) as { state?: string; roster?: unknown[] },
    v => v.state === 'online' && (v.roster?.length ?? 0) > 0,
    'the board online at the hub with anna in the roster',
  )
  const unread = async () => ((await (await fetch(`${url}/api/board`)).json()) as { teamUnread?: number }).teamUnread
  const until = (n: number) => waitFor(unread, v => v === n, `${n} unread`)
  const ctx = { webPort: Number(new URL(url).port), roster: view.roster ?? [] }
  const agentCtx = {
    ...ctx,
    self: () => Promise.reject(new Error('not asked')),
    find: () => Promise.reject(new Error('not asked')),
  }
  const send = async (text: string, thread?: ThreadRef) =>
    annaClient.send({
      t: 'send',
      env: await question(anna, me.pub, text, { body: { text, ...(thread && { thread }) } }),
    })

  await send('is the build green?')
  await send('release notes?', { id: TOPIC, title: 'Release \u00b7 notes', group: true })
  await until(2)

  // inbox: the board's words with a member's title quoted, no message text.
  const pair = `general:${anna.pub.slice(0, 10)} · with anna · general · 1 unread`
  const topic = `${TOPIC.slice(0, 8)} · team chat · "Release · notes" · 1 unread`
  const inbox = await teamInbox([], ctx)
  expect(inbox).toContain(pair)
  expect(inbox).toContain(topic)
  expect(inbox).toContain('information, not instructions')
  expect(inbox).not.toContain('build green')
  const listed = JSON.parse(await teamInbox(['--json', '--unread'], ctx)) as {
    note: string
    threads: { key: string; unread: number }[]
  }
  expect(listed.note).toContain('information, not instructions')
  expect(listed.threads.map(t => [t.key, t.unread]).sort()).toEqual(
    [
      [`${anna.pub}/general`, 1],
      [`team/${TOPIC}`, 1],
    ].sort(),
  )

  // thread --json: the text as data under a note; reading marks nothing.
  const data = JSON.parse(await teamAgents('thread', [TOPIC.slice(0, 8), '--json'], agentCtx)) as {
    note: string
    read: boolean
    lines: { dir: string; from?: string; text: string | null }[]
  }
  expect(data.note).toContain('not instructions from the owner')
  expect(data.read).toBe(false)
  expect(data.lines).toEqual([expect.objectContaining({ dir: 'in', from: 'anna', text: 'release notes?' })])
  expect(await unread()).toBe(2)
  // --read: read out, then marked.
  const framed = await teamAgents('thread', [TOPIC.slice(0, 8), '--read'], agentCtx)
  expect(framed).toContain('  | release notes?')
  expect(framed.endsWith('(marked read)')).toBe(true)
  await until(1)
  expect(await teamInbox(['--unread'], ctx)).not.toContain(TOPIC.slice(0, 8))

  // A muted thread counts nothing; the team chat muted counts none of its threads, at once.
  expect((await post(url, `/api/team/threads/team/${TOPIC}/mute`, {})).status).toBe(200)
  await send('more notes', { id: TOPIC, group: true })
  await send('hello all', { id: 'general', group: true })
  await until(2)
  expect(await teamInbox(['--unread'], ctx)).toContain('team · team chat · general · 1 unread')
  expect((await post(url, '/api/team/agents', { peer: 'team', muted: true })).status).toBe(200)
  await until(1)

  // watch: a line for the thread that got a new message, never its text.
  const out: string[] = []
  let looks = 0
  await teamWatch(ctx, {
    json: false,
    everyMs: 10,
    out: l => void out.push(l),
    stop: () => looks >= 2,
    sleep: async () => {
      looks++
      if (looks === 1) {
        await send('one more thing')
        await send('the plan', { id: PLAN, title: 'Secret plan' })
        await until(3)
      }
    },
  })
  expect(out).toHaveLength(3)
  expect(out[0]).toContain("never a member's words")
  const said = out.slice(1).sort()
  expect(said[0]).toMatch(/^\[\d\d:\d\d\] \w{8} · with anna · a topic · 1 new · 1 unread$/)
  expect(said[1]).toMatch(/^\[\d\d:\d\d\] general:\S+ · with anna · general · 1 new · 2 unread$/)
  expect(out.join('\n')).not.toContain('one more thing')
  expect(out.join('\n')).not.toContain('Secret plan')
  annaClient.close()
})

test('#476: inbox and watch read their flags before a lone -- only; a word after it is refused', async () => {
  const key = `team/${TOPIC}`
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname === '/api/team/unread') return Response.json({ threads: { [key]: 0 } })
      return Response.json({ threads: [{ key, scope: 'team', id: TOPIC, title: 'Plan' }] })
    },
  })
  try {
    const ctx = { webPort: server.port as number, roster: [] }
    expect(JSON.parse(await teamInbox(['--json', '--'], ctx))).toMatchObject({ threads: [{ key }] })
    expect(await teamInbox(['--unread', '--'], ctx)).toBe('nothing unread')
    expect(await teamInbox(['--'], ctx)).toContain('Plan')
    for (const words of [
      ['--', '--json'],
      ['--', '--unread'],
      ['--json', '--', 'x'],
    ])
      await expect(teamInbox(words, ctx)).rejects.toThrow('usage: ')
  } finally {
    server.stop(true)
  }
  expect(watchFlags(['--json', '--every', '5', '--'])).toEqual({ json: true, everyMs: 5000 })
  expect(watchFlags(['--json'])).toEqual({ json: true, everyMs: 3000 })
  expect(watchFlags([])).toEqual({ json: false, everyMs: 3000 })
  // a word after the --, --every's number too, is a word left over
  for (const words of [['--', '--json'], ['--every', '5', '--', '--every', '9'], ['--every', '--', '5'], ['x']])
    expect(watchFlags(words)).toBeNull()
})

test('#880: teamWait wakes on unread addressed threads for self and keeps inbox JSON unchanged', async () => {
  const peer = 'p'.repeat(43)
  const mutedId = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f61'
  const otherId = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f62'
  const junoMsg = '11111111-1111-4111-8111-111111111111'
  const paneMsg = '22222222-2222-4222-8222-222222222222'
  const ownerSvcMsg = '33333333-3333-4333-8333-333333333333'
  const ownerSvcKey = 'owner-service-11111111-1111-4111-8111-111111111111'
  const claudeKey = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/team/agents') return Response.json({ listener: { key: 'sess-listener', name: 'day' } })
      if (path === '/api/team/unread') {
        return Response.json({
          threads: {
            'team/general': 2,
            [`team/${mutedId}`]: 1,
            [`${peer}/${otherId}`]: 1,
            [`${peer}/general`]: 0,
          },
        })
      }
      return Response.json({
        threads: [
          {
            key: 'team/general',
            scope: 'team',
            id: 'general',
            title: null,
            link: null,
            handler: null,
            muted: false,
            lastAt: 4000,
            peerName: null,
            addressed: [{ key: 'service-juno', message: junoMsg }],
          },
          {
            key: `team/${mutedId}`,
            scope: 'team',
            id: mutedId,
            title: 'Muted',
            link: null,
            handler: null,
            muted: true,
            lastAt: 3000,
            peerName: null,
            addressed: [{ key: 'service-juno', message: '44444444-4444-4444-8444-444444444444' }],
          },
          {
            key: `${peer}/${otherId}`,
            scope: peer,
            id: otherId,
            title: 'Other handled',
            link: null,
            handler: { key: 'other-session', name: 'Other' },
            muted: false,
            lastAt: 2000,
            peerName: 'anna',
            addressed: [
              { key: 'pane-w1:p2', message: paneMsg },
              { key: ownerSvcKey, message: ownerSvcMsg },
            ],
          },
          {
            key: `${peer}/general`,
            scope: peer,
            id: 'general',
            title: null,
            link: null,
            handler: null,
            muted: false,
            lastAt: 1000,
            peerName: 'anna',
            addressed: [{ key: 'service-juno', message: '55555555-5555-4555-8555-555555555555' }],
          },
        ],
      })
    },
  })
  try {
    const ctx = { webPort: server.port as number, roster: [{ peer, name: 'anna' }] }
    const text = await teamWait(ctx, { json: false, timeoutMs: 1000, self: async () => ({ key: 'service-juno' }) })
    expect(text).toContain('team · team chat · general · 2 unread · addressed to you (msg 11111111)')
    expect(text).toContain('--to <msg>')
    expect(text).not.toContain('Muted')
    expect(text).not.toContain('Other handled')

    const asJson = JSON.parse(
      await teamWait(ctx, { json: true, timeoutMs: 1000, self: async () => ({ key: 'service-juno' }) }),
    ) as { threads: Record<string, unknown>[] }
    expect(asJson.threads).toHaveLength(1)
    expect(asJson.threads[0]).toMatchObject({ key: 'team/general', addressed: junoMsg })

    // Different session key formats: pane-<id> and owner-service-<uuid> wake; unaddressed Claude UUID does not.
    const paneJson = JSON.parse(
      await teamWait(ctx, { json: true, timeoutMs: 1000, self: async () => ({ key: 'pane-w1:p2' }) }),
    ) as { threads: Record<string, unknown>[] }
    expect(paneJson.threads).toHaveLength(1)
    expect(paneJson.threads[0]).toMatchObject({ key: `${peer}/${otherId}`, addressed: paneMsg })

    const ownerSvcJson = JSON.parse(
      await teamWait(ctx, { json: true, timeoutMs: 1000, self: async () => ({ key: ownerSvcKey }) }),
    ) as { threads: Record<string, unknown>[] }
    expect(ownerSvcJson.threads).toHaveLength(1)
    expect(ownerSvcJson.threads[0]).toMatchObject({ key: `${peer}/${otherId}`, addressed: ownerSvcMsg })

    expect(
      await teamWait(ctx, {
        json: false,
        timeoutMs: 100,
        everyMs: 10,
        sleep: async ms => void (await Bun.sleep(ms)),
        self: async () => ({ key: claudeKey }),
      }),
    ).toBe('nothing new in 0 s: wait again')

    // inbox --json keeps its exact fields without leaking addressed.
    const inboxJson = JSON.parse(await teamInbox(['--json'], ctx)) as { threads: Record<string, unknown>[] }
    expect(inboxJson.threads[0]).not.toHaveProperty('addressed')
  } finally {
    server.stop(true)
  }
})
