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
import { teamInbox, teamWatch } from '../../src/entrypoints/team-inbox-cli.ts'
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
