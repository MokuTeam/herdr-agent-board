// The calendar through the board's server (#328, server/routes/calendar.ts): nothing of it while
// it is off (no `calendar` in the payload, the routes 409, no copy fetched); on, the line in the
// payload, a window's events from every source, Sync, the board's own events as the owner, and
// Settings → Calendar on this computer only. Fakes of the test's own: an MCP server on a free port,
// a fake wake; events are invented.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { localOnly } from '../../src/core/remote.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { sandbox } from '../support/sandbox.ts'

/** Until an asked condition holds (the sandbox's `until` takes a plain one). */
async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>
const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Board': '1' },
    body: JSON.stringify(body),
  })

/** A fake calendar MCP server (the generic form): its events as JSON, how many calls it took. */
function calendarServer(events: unknown[]) {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { id?: number; method: string }
      if (body.id === undefined) return new Response(null, { status: 202 })
      if (body.method === 'tools/call') calls++
      const result =
        body.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } }
          : { content: [{ type: 'text', text: JSON.stringify({ events }) }] }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls: () => calls, stop: () => server.stop(true) }
}

test('calendar off: no calendar in the payload, the routes refuse, nothing is fetched or written', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  const fake = calendarServer([])
  try {
    // sources kept for later, the calendar itself off
    const { url } = await serveBoard(box, {
      language: 'en',
      wakeUrl: wake.url,
      calendar: { on: false, sources: [{ id: 'work', kind: 'mcp', url: fake.url, list: { tool: 'list' } }] },
    })
    const board = await json(await fetch(`${url}/api/board`))
    assert.equal('calendar' in board, false)
    assert.equal((await fetch(`${url}/api/calendar?from=0&to=1000`)).status, 409)
    assert.equal((await post(`${url}/api/calendar`, { op: 'sync' })).status, 409)
    await Bun.sleep(300)
    assert.equal(fake.calls(), 0)
    const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
    assert.equal(existsSync(join(state, 'calendar')), false)
    assert.equal(existsSync(join(state, 'board.db')), false)
  } finally {
    fake.stop()
    wake.down()
  }
})

test('calendar on: the line in the payload, a window from every source, Sync, the board’s own events', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  const now = Date.now()
  const iso = (at: number) => new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')
  const fake = calendarServer([
    {
      id: 'c1',
      title: 'Client call',
      start: iso(now + 20 * 60_000),
      end: iso(now + 50 * 60_000),
      join: 'https://meet.google.com/abc-defg-hij',
    },
    {
      id: 'c2',
      title: 'Declined one',
      start: iso(now + 5 * 60_000),
      end: iso(now + 15 * 60_000),
      response: 'declined',
    },
  ])
  try {
    const { url } = await serveBoard(box, {
      language: 'en',
      wakeUrl: wake.url,
      refreshSec: 1,
      calendar: {
        on: true,
        sources: [
          { id: 'work', kind: 'mcp', label: 'Work', url: fake.url, list: { tool: 'list', args: { from: '{from}' } } },
        ],
      },
    })
    // fetched on its own once the calendar is on
    await until(async () => fake.calls() > 0)
    let board: Record<string, unknown> = {}
    await until(async () => {
      board = await json(await fetch(`${url}/api/board`))
      return !!(board.calendar as { next?: unknown } | undefined)?.next
    })
    const line = board.calendar as { next: { title: string; join: string; label: string }; failing: number }
    // the next call not declined, with its join link and its source's label
    assert.equal(line.next.title, 'Client call')
    assert.equal(line.next.join, 'https://meet.google.com/abc-defg-hij')
    assert.equal(line.next.label, 'Work')
    assert.equal(line.failing, 0)

    const from = now - 3_600_000
    const to = now + 86_400_000
    const added = await json(
      await post(`${url}/api/calendar`, {
        op: 'add',
        title: 'Focus',
        start: iso(now + 2 * 3_600_000),
        end: iso(now + 3 * 3_600_000),
      }),
    )
    assert.equal(added.ok, true)
    const day = await json(await fetch(`${url}/api/calendar?from=${from}&to=${to}`))
    assert.deepEqual(
      (day.events as { source: string; title: string }[]).map(e => [e.source, e.title]),
      [
        ['work', 'Declined one'],
        ['work', 'Client call'],
        ['board', 'Focus'],
      ],
    )
    // a phone's view: each source's look and state, never its server's address
    const work = (day.sources as { id: string; url: unknown; account: unknown }[]).find(s => s.id === 'work')
    assert.equal(work?.url, null)
    const id = (added.event as { id: string; rev: number }).id
    const stale = await post(`${url}/api/calendar`, { op: 'edit', id, title: 'x', rev: 7 })
    assert.equal(stale.status, 409)
    assert.equal((await json(stale)).code, 'changed')
    assert.equal((await post(`${url}/api/calendar`, { op: 'remove', id })).status, 200)
    const calls = fake.calls()
    const synced = await json(await post(`${url}/api/calendar`, { op: 'sync' }))
    assert.deepEqual(synced.results, [{ source: 'work', ok: true, count: 2 }])
    assert.equal(fake.calls(), calls + 1)
    assert.equal((await fetch(`${url}/api/calendar?from=${from}&to=${from + 90 * 86_400_000}`)).status, 400)
    const settings = await json(await fetch(`${url}/api/calendar-settings`))
    assert.equal(settings.on, true)
    assert.ok(readdirSync(join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'calendar')).includes('work.json'))
  } finally {
    fake.stop()
    wake.down()
  }
})

test('Settings → Calendar is for this computer’s board only, as the other settings that hold secrets', () => {
  assert.equal(localOnly('/api/calendar-settings'), true)
  assert.equal(localOnly('/api/calendar'), false)
  assert.equal(localOnly('/api/time-settings'), true)
})
