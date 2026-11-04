// The calendar's sources at work (#328, services/calendar.ts): an ICS address and MCP servers
// fetched by the board itself, on fakes of the test's own (Bun.serve on a free port), the copy a
// failure keeps, the backoff, the board's own events in its database with the journal, the
// built-in secret sink, and `board cal` as an agent runs it. Events are invented.
import { afterEach, onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readCopy, readIcsAddress, writeIcsAddress } from '../../src/adapters/calendar-cache.ts'
import { McpClient } from '../../src/adapters/calendar-fetch.ts'
import {
  addBoardEvent,
  CalError,
  editBoardEvent,
  listBoardEvents,
  removeBoardEvent,
} from '../../src/adapters/calendar-store.ts'
import { openDb } from '../../src/adapters/db.ts'
import { calendarConfig } from '../../src/core/calendar.ts'
import type { Config } from '../../src/core/types.ts'
import { calCmd } from '../../src/entrypoints/cal-cli.ts'
import { createCalendarSync, dueAt, readEvents, syncSource } from '../../src/services/calendar.ts'
import { calendarSettingsView, editCalendarSettings, idFor } from '../../src/services/calendar-settings.ts'
import { secretsOf } from '../../src/services/secrets.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-04T15:00:00Z')
const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:dentist',
  'DTSTART:20261104T180000Z',
  'DTEND:20261104T190000Z',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly',
  'DTSTART:20261102T170000Z',
  'DTEND:20261102T173000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Run club',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** An ICS server: its address with a secret token, and how many times it was asked. */
function icsServer(answer: () => Response) {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      hits++
      if (!new URL(req.url).pathname.endsWith('/secret-token/basic.ics')) return new Response('no', { status: 404 })
      return answer()
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}/cal/secret-token/basic.ics`, hits: () => hits }
}

const GOOGLE_PAGE_1 = [
  "Successfully retrieved 1 events from calendar 'primary' for me@example.com:",
  '- "Kickoff" (Starts: 2026-11-05T10:00:00-05:00 [America/New_York; weekday: Thursday; ISO weekday: 4], Ends: 2026-11-05T11:00:00-05:00 [America/New_York; weekday: Thursday; ISO weekday: 4])',
  '  Description: Agenda',
  '  Location: No Location',
  '  Meeting Link: https://meet.google.com/abc-defg-hij',
  '  Attendees: a@example.com, me@example.com',
  '  Attendee Details: a@example.com: accepted (organizer)',
  '    me@example.com: accepted',
  '  ID: k1 | Link: https://www.google.com/calendar/event?eid=K1',
  '',
  'Next page token: P2',
  'Pagination time_min: 2026-10-01T00:00:00Z',
].join('\n')
const GOOGLE_PAGE_2 = [
  "Successfully retrieved 1 events from calendar 'primary' for me@example.com:",
  '- "Retro" (Starts: 2026-11-06T15:00:00-05:00 [America/New_York; weekday: Friday; ISO weekday: 5], Ends: 2026-11-06T15:30:00-05:00 [America/New_York; weekday: Friday; ISO weekday: 5])',
  '  ID: r1 | Link: https://www.google.com/calendar/event?eid=R1',
].join('\n')

interface Call {
  method: string
  name?: string | undefined
  args?: Record<string, unknown> | undefined
  session: string | null
  version?: string | null
}

/**
 * A fake MCP server over Streamable HTTP: JSON answers, or an event stream (`sse`), with a session
 * id or stateless. `tools` answers a call by name.
 */
function mcpServer(
  tools: Record<string, (args: Record<string, unknown>) => unknown>,
  o: { sse?: boolean; session?: boolean; version?: string } = {},
) {
  const calls: Call[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const session = req.headers.get('mcp-session-id')
      if (req.method === 'DELETE') {
        calls.push({ method: 'DELETE', session })
        return new Response(null, { status: 200 })
      }
      const body = (await req.json()) as {
        id?: number
        method: string
        params?: { name?: string; arguments?: Record<string, unknown> }
      }
      calls.push({
        method: body.method,
        name: body.params?.name,
        args: body.params?.arguments,
        session,
        version: req.headers.get('mcp-protocol-version'),
      })
      if (body.id === undefined) return new Response(null, { status: 202 })
      let result: unknown
      if (body.method === 'initialize')
        result = {
          protocolVersion: o.version ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '0' },
        }
      else if (body.method === 'tools/call') {
        const tool = tools[body.params?.name ?? '']
        if (!tool)
          return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool' } })
        result = tool(body.params?.arguments ?? {})
      }
      const msg = { jsonrpc: '2.0', id: body.id, result }
      const headers: Record<string, string> =
        o.session && body.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {}
      if (o.sse)
        return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, {
          headers: { ...headers, 'content-type': 'text/event-stream' },
        })
      return Response.json(msg, { headers })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}/google/mcp`, calls }
}

const text = (s: string) => ({ content: [{ type: 'text', text: s }] })

function cfgWith(sources: unknown[], extra: Record<string, unknown> = {}): Config {
  return { language: 'en', categories: [], calendar: { on: true, sources, ...extra } } as unknown as Config
}

test('MCP client: initialize, initialized, the call; JSON or an event stream; a session kept and ended', async () => {
  isolatedHome()
  const json = mcpServer({ echo: a => text(`got ${String(a.x)}`) })
  const c1 = new McpClient(json.url)
  assert.deepEqual(await c1.call('echo', { x: 1 }), { text: 'got 1', structured: null, isError: false })
  await c1.close()
  assert.deepEqual(
    json.calls.map(c => c.method),
    ['initialize', 'notifications/initialized', 'tools/call'],
  )
  const sse = mcpServer(
    { echo: () => ({ ...text('x'), structuredContent: { events: [] }, isError: true }) },
    { sse: true, session: true },
  )
  const c2 = new McpClient(sse.url)
  assert.deepEqual(await c2.call('echo', {}), { text: 'x', structured: { events: [] }, isError: true })
  await c2.close()
  assert.deepEqual(
    sse.calls.map(c => [c.method, c.session]),
    [
      ['initialize', null],
      ['notifications/initialized', 'sess-1'],
      ['tools/call', 'sess-1'],
      ['DELETE', 'sess-1'],
    ],
  )
  await assert.rejects(new McpClient(json.url).call('nope', {}), /server error: Unknown tool/)
})

test('google-workspace preset: get_events paged by its token, the owner’s account, the copy written', async () => {
  isolatedHome()
  const fake = mcpServer({
    get_events: a => text(a.page_token === 'P2' ? GOOGLE_PAGE_2 : GOOGLE_PAGE_1),
  })
  const cfg = cfgWith([
    { id: 'work', kind: 'mcp', label: 'Work', url: fake.url, preset: 'google-workspace', account: 'me@example.com' },
  ])
  const c = calendarConfig(cfg.calendar)
  assert.ok(c)
  const r = await syncSource(c, c.sources[1] as never, NOW, 'America/New_York')
  assert.deepEqual(r, { source: 'work', ok: true, count: 2 })
  const calls = fake.calls.filter(x => x.method === 'tools/call')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.args?.user_google_email, 'me@example.com')
  assert.equal(calls[0]?.args?.detailed, true)
  assert.equal(calls[1]?.args?.page_token, 'P2')
  // the next page asks from the time_min the answer named
  assert.equal(calls[1]?.args?.time_min, '2026-10-01T00:00:00Z')
  const copy = readCopy('work')
  assert.deepEqual(
    copy?.events.map(e => [e.id, e.title, e.join ?? null, e.response ?? null]),
    [
      ['k1', 'Kickoff', 'https://meet.google.com/abc-defg-hij', 'accepted'],
      ['r1', 'Retro', null, null],
    ],
  )
  assert.equal(copy?.lastOk, NOW)
  assert.equal(copy?.error, null)
})

test('a failed fetch keeps the last good copy, says why without the address, and waits longer each time', async () => {
  isolatedHome()
  let up = true
  const ics = icsServer(() =>
    up ? new Response(ICS, { headers: { 'content-type': 'text/calendar' } }) : new Response('down', { status: 503 }),
  )
  writeIcsAddress('home', ics.url)
  assert.equal(readIcsAddress('home'), ics.url)
  if (process.platform !== 'win32')
    assert.equal(
      statSync(
        join(process.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'calendar', 'secret', 'home.json'),
      ).mode & 0o777,
      0o600,
    )
  const cfg = cfgWith([{ id: 'home', kind: 'ics', label: 'Home', everyMin: 5 }])
  const c = calendarConfig(cfg.calendar)
  assert.ok(c)
  const home = c.sources[1] as never
  assert.equal((await syncSource(c, home, NOW, 'UTC')).count, 4)
  up = false
  const failed = await syncSource(c, home, NOW + 60_000, 'UTC')
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'HTTP 503')
  const copy = readCopy('home')
  assert.equal(copy?.events.length, 4)
  assert.equal(copy?.lastOk, NOW)
  assert.equal(copy?.fails, 1)
  assert.ok(!JSON.stringify(copy).includes('secret-token'))
  // 5 min, then 10, 20, 40, then an hour at most
  assert.equal(dueAt(copy, { everyMin: 5 }), NOW + 60_000 + 10 * 60_000)
  assert.equal(dueAt({ ...copy, fails: 5 } as never, { everyMin: 5 }), NOW + 60_000 + 60 * 60_000)
  assert.equal(dueAt(null, { everyMin: 5 }), 0)
  // no address: said, nothing fetched
  const none = await syncSource(
    calendarConfig(cfgWith([{ id: 'other', kind: 'ics' }]).calendar) as never,
    { ...(home as object), id: 'other' } as never,
    NOW,
    'UTC',
  )
  assert.match(none.error ?? '', /No iCal address for other/)
  // no address yet is no failure: looked at again on its interval, not an hour later
  assert.equal(readCopy('other')?.fails, 0)
  assert.equal(dueAt(readCopy('other'), { everyMin: 5 }), NOW + 5 * 60_000)
})

test('an answer read far short of what it says it has keeps the last good copy (the provider’s form changed)', async () => {
  isolatedHome()
  let changed = false
  const fake = mcpServer({
    get_events: () =>
      text(
        changed
          ? "Successfully retrieved 2 events from calendar 'primary' for me@example.com:\n* Kickoff at 10:00\n* Retro at 15:00"
          : GOOGLE_PAGE_2,
      ),
  })
  const cfg = cfgWith([
    { id: 'work', kind: 'mcp', url: fake.url, preset: 'google-workspace', account: 'me@example.com' },
  ])
  const c = calendarConfig(cfg.calendar)
  assert.ok(c)
  assert.equal((await syncSource(c, c.sources[1] as never, NOW, 'UTC')).count, 1)
  changed = true
  const r = await syncSource(c, c.sources[1] as never, NOW + 60_000, 'UTC')
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /has 2 events and the board read 0/)
  assert.deepEqual(
    readCopy('work')?.events.map(e => e.id),
    ['r1'],
  )
})

test('the MCP client says the protocol revision the server answered with, after initialize', async () => {
  isolatedHome()
  const old = mcpServer({ echo: () => text('ok') }, { version: '2025-03-26' })
  const client = new McpClient(old.url)
  await client.call('echo', {})
  await client.close()
  assert.deepEqual(
    old.calls.map(c => [c.method, c.version]),
    [
      ['initialize', null],
      ['notifications/initialized', '2025-03-26'],
      ['tools/call', '2025-03-26'],
    ],
  )
})

test('readEvents: the board’s own and every copy merged in order; cancelled left out unless asked', async () => {
  isolatedHome()
  const fake = mcpServer({
    list: a => ({
      ...text(''),
      structuredContent: {
        events: [
          {
            id: 'p1',
            title: 'Pushed by server',
            start: '2026-11-05T08:00:00Z',
            end: '2026-11-05T08:30:00Z',
            from: a.from,
          },
          { id: 'p2', title: 'Gone', start: '2026-11-05T12:00:00Z', end: '2026-11-05T12:30:00Z', status: 'cancelled' },
          { title: 'no id' },
        ],
      },
    }),
  })
  const cfg = cfgWith([
    { id: 'gen', kind: 'mcp', url: fake.url, list: { tool: 'list', args: { from: '{from}', to: '{to}' } } },
  ])
  const c = calendarConfig(cfg.calendar)
  assert.ok(c)
  const r = await syncSource(c, c.sources[1] as never, NOW, 'UTC')
  assert.equal(r.count, 2)
  const call = fake.calls.find(x => x.method === 'tools/call')
  assert.match(String(call?.args?.from), /^2026-09-30T00:00:00Z$/)
  const db = openDb()
  assert.ok(db)
  try {
    addBoardEvent(
      db,
      { key: 's1', name: 'Agent' },
      { title: 'Focus block', start: Date.parse('2026-11-05T07:00:00Z'), end: Date.parse('2026-11-05T07:45:00Z') },
    )
    addBoardEvent(db, 'user', { title: 'Trip', start: '2026-11-05', end: '2026-11-07' })
    const day = { from: Date.parse('2026-11-05T00:00:00Z'), to: Date.parse('2026-11-06T00:00:00Z') }
    assert.deepEqual(
      readEvents(c, db, day.from, day.to, 'UTC').map(e => [e.source, e.title]),
      [
        ['board', 'Trip'],
        ['board', 'Focus block'],
        ['gen', 'Pushed by server'],
      ],
    )
    assert.equal(readEvents(c, db, day.from, day.to, 'UTC', { cancelled: true }).length, 4)
    assert.deepEqual(
      readEvents(c, db, day.from, day.to, 'UTC', { sources: ['gen'] }).map(e => e.id),
      ['p1'],
    )
  } finally {
    db.close()
  }
})

test('board events: add, edit with the revision read, remove; every change in the journal with who and what', () => {
  isolatedHome()
  const db = openDb()
  assert.ok(db)
  try {
    const agent = { key: 's1', name: 'Agent' }
    const e = addBoardEvent(db, agent, {
      title: 'Prep',
      start: Date.parse('2026-11-05T09:00:00Z'),
      end: Date.parse('2026-11-05T09:30:00Z'),
      join: 'https://meet.google.com/abc-defg-hij',
    })
    assert.equal(e.rev, 1)
    assert.equal(e.by, 'Agent')
    assert.throws(
      () => addBoardEvent(db, agent, { title: ' ', start: 1, end: 2 }),
      (err: unknown) => err instanceof CalError && err.code === 'noTitle',
    )
    assert.throws(
      () => addBoardEvent(db, agent, { title: 'x', start: 5, end: 2 }),
      (err: unknown) => err instanceof CalError && err.code === 'endBeforeStart',
    )
    assert.throws(
      () => addBoardEvent(db, agent, { title: 'x', start: 1, end: 2, join: 'ftp://x' }),
      (err: unknown) => err instanceof CalError && err.code === 'join',
    )
    // a start alone keeps the length
    const moved = editBoardEvent(db, 'user', e.id, { start: Date.parse('2026-11-05T13:00:00Z') }, { expect: 1 })
    assert.equal(moved.start, '2026-11-05T13:00:00Z')
    assert.equal(moved.end, '2026-11-05T13:30:00Z')
    assert.equal(moved.rev, 2)
    assert.throws(
      () => editBoardEvent(db, 'user', e.id, { title: 'Late' }, { expect: 1 }),
      (err: unknown) => err instanceof CalError && err.code === 'changed',
    )
    assert.throws(
      () => editBoardEvent(db, 'user', e.id, { start: '2026-11-06' }),
      (err: unknown) => err instanceof CalError && err.code === 'bothTimes',
    )
    const allDay = editBoardEvent(db, 'user', e.id, { start: '2026-11-06', end: '2026-11-07', join: null })
    assert.deepEqual(
      [allDay.allDay, allDay.start, allDay.end, allDay.join],
      [true, '2026-11-06', '2026-11-07', undefined],
    )
    removeBoardEvent(db, agent, e.id)
    assert.deepEqual(listBoardEvents(db, 0, Date.parse('2027-01-01T00:00:00Z'), 'UTC'), [])
    const journal = db.db.query("SELECT by, op, ref FROM journal WHERE store = 'calendar' ORDER BY seq").all() as {
      by: string
      op: string
      ref: string
    }[]
    assert.deepEqual(
      journal.map(j => [j.op, j.ref, j.by]),
      [
        ['add', e.id, JSON.stringify(agent)],
        ['edit', e.id, 'user'],
        ['edit', e.id, 'user'],
        ['remove', e.id, JSON.stringify(agent)],
      ],
    )
  } finally {
    db.close()
  }
})

test('the web board’s sync: no timer and nothing read while off; on, each source on its own interval', async () => {
  isolatedHome()
  let hits = 0
  const ics = icsServer(() => {
    hits++
    return new Response(ICS)
  })
  writeIcsAddress('home', ics.url)
  const cfg = { language: 'en', categories: [] } as unknown as Config
  let changes = 0
  let clock = NOW
  const sync = createCalendarSync({
    cfg,
    log: () => {},
    onChange: () => changes++,
    now: () => clock,
    tickMs: 20,
    zone: () => 'UTC',
  })
  onTestFinished(() => sync.stop())
  sync.configChanged()
  assert.equal(sync.line(), null)
  await Bun.sleep(80)
  assert.equal(hits, 0)
  assert.equal(changes, 0)
  cfg.calendar = { on: true, sources: [{ id: 'home', kind: 'ics', everyMin: 5 }] }
  sync.configChanged()
  for (let i = 0; i < 50 && !readCopy('home')?.lastOk; i++) await Bun.sleep(20)
  assert.equal(readCopy('home')?.events.length, 4)
  await Bun.sleep(80)
  assert.equal(hits, 1, 'not due again within its interval')
  clock += 5 * 60_000 + 1
  for (let i = 0; i < 50 && hits < 2; i++) await Bun.sleep(20)
  assert.equal(hits, 2)
  const line = sync.line()
  assert.ok(line)
  assert.equal(line.failing, 0)
  assert.equal(line.next?.title, 'Dentist')
  cfg.calendar = { on: false, sources: [{ id: 'home', kind: 'ics' }] }
  sync.configChanged()
  clock += 60 * 60_000
  await Bun.sleep(80)
  assert.equal(hits, 2)
  assert.equal(sync.line(), null)
  sync.stop()
})

test('Settings → Calendar: a source added with its address kept apart from config.json, changed, tried, removed', async () => {
  const dir = isolatedHome()
  const ics = icsServer(() => new Response(ICS))
  assert.equal(editCalendarSettings({ op: 'on', on: true }).ok, true)
  const bad = editCalendarSettings({ op: 'add', kind: 'ics', source: { label: 'Home' }, address: 'not a url' })
  assert.equal(bad.ok, false)
  const added = editCalendarSettings({
    op: 'add',
    kind: 'ics',
    source: { label: 'Home', color: '#336699', lane: 'personal' },
    address: ics.url.replace('http://', 'webcal://'),
  })
  // webcal is https; the fake answers http, so the test sets the address it serves
  assert.deepEqual(added, { ok: true, id: 'home' })
  writeIcsAddress('home', ics.url)
  const file = readFileSync(join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json'), 'utf8')
  assert.ok(!file.includes('secret-token'))
  assert.deepEqual(JSON.parse(file).calendar, {
    on: true,
    sources: [{ id: 'home', kind: 'ics', label: 'Home', color: '#336699', lane: 'personal' }],
  })
  const view = calendarSettingsView((_c, fn) => fn(null))
  assert.equal(view.on, true)
  assert.deepEqual(
    view.sources.map(s => [s.id, s.address]),
    [
      ['board', null],
      ['home', true],
    ],
  )
  assert.ok(!JSON.stringify(view).includes('secret-token'))
  assert.equal(editCalendarSettings({ op: 'edit', id: 'home', source: { color: 'red' } }).ok, false)
  assert.equal(editCalendarSettings({ op: 'edit', id: 'home', source: { label: 'Family', color: null } }).ok, true)
  assert.equal(editCalendarSettings({ op: 'edit', id: 'board', source: { label: 'Agents' } }).ok, true)
  assert.equal(editCalendarSettings({ op: 'remove', id: 'board' }).ok, false)
  assert.equal(idFor('Home', 'ics', new Set(['home'])), 'home-2')
  assert.equal(idFor('Личный', 'ics', new Set()), 'ics')
  assert.equal(editCalendarSettings({ op: 'remove', id: 'home' }).ok, true)
  assert.equal(readIcsAddress('home'), null)
  assert.ok(!existsSync(join(dir, 'state', 'herdr', 'plugins', 'agent-board', 'calendar', 'home.json')))
})

test('the calendar sink: only while the calendar is on with an ICS source; the owner’s own sinks as they are', () => {
  isolatedHome()
  const owner = { sinks: { demo: { kind: 'env', vars: ['X'] } } }
  const off = secretsOf({ secrets: owner })
  assert.deepEqual([...off.sinks.keys()], ['demo'])
  assert.deepEqual([...secretsOf({ secrets: owner, calendar: { on: true } }).sinks.keys()], ['demo'])
  const on = secretsOf({ secrets: owner, calendar: { on: true, sources: [{ id: 'home', kind: 'ics' }] } })
  assert.deepEqual([...on.sinks.keys()], ['demo', 'calendar'])
  const sink = on.sinks.get('calendar')
  assert.equal(sink?.problems.length, 0)
  assert.deepEqual(sink?.fields, ['url'])
  assert.deepEqual(Object.keys(sink?.params ?? {}), ['source'])
  // no `secrets` at all: the calendar's alone
  assert.deepEqual([...secretsOf({ calendar: { sources: [{ id: 'home', kind: 'ics' }] } }).sinks.keys()], ['calendar'])
  // the owner's `calendar` wins
  const mine = { sinks: { calendar: { kind: 'env', vars: ['Y'] } } }
  assert.equal(
    secretsOf({ secrets: mine, calendar: { sources: [{ id: 'home', kind: 'ics' }] } }).sinks.get('calendar')?.kind,
    'env',
  )
})

// ------------------------------------------------------------------ board cal

async function cal(
  cfg: Config,
  args: string[],
  actor: { key: string; name: string } | 'user' = { key: 's1', name: 'Agent' },
) {
  const out: string[] = []
  const err: string[] = []
  const code = await calCmd(args, {
    cfg,
    actor,
    now: NOW,
    zone: 'UTC',
    out: l => out.push(l),
    err: l => err.push(l),
    stdin: async () => '[]',
  })
  return { code, out, err }
}

test('board cal: off says how to turn it on; list, add, edit, rm on the board’s own as this session', async () => {
  isolatedHome()
  const off = await cal({ language: 'en', categories: [] } as unknown as Config, ['list', '--json'])
  assert.equal(off.code, 1)
  assert.equal(JSON.parse(off.out[0] as string).error, 'off')
  const cfg = cfgWith([])
  const added = await cal(cfg, [
    'add',
    '--title',
    'Review',
    '--start',
    '2026-11-04T16:00:00Z',
    '--minutes',
    '45',
    '--join',
    'https://meet.google.com/abc-defg-hij',
    '--json',
  ])
  assert.equal(added.code, 0)
  const e = JSON.parse(added.out[0] as string).event
  assert.equal(e.end, '2026-11-04T16:45:00Z')
  const list = await cal(cfg, ['list'])
  assert.equal(list.out[0], 'Wed 2026-11-04')
  assert.match(
    list.out[1] as string,
    / · Review · \[board\] · join https:\/\/meet\.google\.com\/abc-defg-hij · rev 1 · board\//,
  )
  const json = JSON.parse((await cal(cfg, ['list', '--day', 'today', '--json'])).out[0] as string)
  assert.deepEqual(
    json.events.map((x: { title: string; label: string }) => [x.title, x.label]),
    [['Review', 'board']],
  )
  assert.equal((await cal(cfg, ['edit', `board/${e.id}`, '--title', 'Code review', '--expect', '1'])).code, 0)
  const stale = await cal(cfg, ['edit', e.id, '--title', 'x', '--expect', '1', '--json'])
  assert.equal(JSON.parse(stale.out[0] as string).error, 'changed')
  const allDay = await cal(cfg, [
    'add',
    '--title',
    'Conference',
    '--all-day',
    '--start',
    'tomorrow',
    '--end',
    '2026-11-06',
    '--json',
  ])
  assert.deepEqual(
    [JSON.parse(allDay.out[0] as string).event.start, JSON.parse(allDay.out[0] as string).event.end],
    ['2026-11-05', '2026-11-07'],
  )
  const longer = JSON.parse((await cal(cfg, ['edit', e.id, '--minutes', '60', '--json'])).out[0] as string)
  assert.deepEqual([longer.event.start, longer.event.end], ['2026-11-04T16:00:00Z', '2026-11-04T17:00:00Z'])
  const nothing = await cal(cfg, ['edit', e.id])
  assert.equal(nothing.code, 1)
  assert.match(nothing.err.join('\n'), /nothing to change/)
  assert.equal((await cal(cfg, ['rm', e.id])).code, 0)
  const usage = await cal(cfg, ['add', '--title', 'x'])
  assert.equal(usage.code, 1)
  assert.match(usage.err.join('\n'), /--start is needed/)
})

test('board cal: a provider’s calendar only through a source that writes, with the owner’s words, journaled', async () => {
  isolatedHome()
  const fake = mcpServer({
    get_events: () => text("Successfully retrieved 0 events from calendar 'primary' for me@example.com:"),
    manage_event: a => text(`Successfully ${String(a.action)}d event. ID: new123`),
  })
  const base = { id: 'work', kind: 'mcp', url: fake.url, preset: 'google-workspace', account: 'me@example.com' }
  const readOnly = await cal(cfgWith([base]), [
    'add',
    '--source',
    'work',
    '--title',
    'Call',
    '--start',
    '2026-11-05 10:00',
    '--minutes',
    '30',
    '--asked',
    'x',
    '--json',
  ])
  assert.equal(JSON.parse(readOnly.out[0] as string).error, 'readOnly')
  const cfg = cfgWith([{ ...base, write: true }])
  const unasked = await cal(cfg, [
    'add',
    '--source',
    'work',
    '--title',
    'Call',
    '--start',
    '2026-11-05 10:00',
    '--minutes',
    '30',
    '--json',
  ])
  assert.equal(JSON.parse(unasked.out[0] as string).error, 'asked')
  assert.equal(fake.calls.filter(c => c.name === 'manage_event').length, 0)
  const ok = await cal(cfg, [
    'add',
    '--source',
    'work',
    '--title',
    'Call',
    '--start',
    '2026-11-05T10:00:00Z',
    '--minutes',
    '30',
    '--asked',
    'put a call with Ann tomorrow at 10',
    '--json',
  ])
  assert.equal(ok.code, 0)
  assert.equal(JSON.parse(ok.out[0] as string).id, 'new123')
  const write = fake.calls.find(c => c.name === 'manage_event')
  assert.deepEqual(write?.args, {
    user_google_email: 'me@example.com',
    action: 'create',
    calendar_id: 'primary',
    summary: 'Call',
    start_time: '2026-11-05T10:00:00.000Z',
    end_time: '2026-11-05T10:30:00.000Z',
  })
  const db = openDb({ create: false })
  assert.ok(db)
  try {
    const rows = db.db.query("SELECT by, op, ref, after FROM journal WHERE store = 'calendar' ORDER BY seq").all() as {
      by: string
      op: string
      ref: string
      after: string
    }[]
    // who asked for what, before the provider is called; then what it gave
    assert.deepEqual(
      rows.map(r => [r.op, r.ref, JSON.parse(r.after).phase, JSON.parse(r.after).asked]),
      [
        ['provider-create', 'work/new', 'asked', 'put a call with Ann tomorrow at 10'],
        ['provider-create', 'work/new123', 'done', 'put a call with Ann tomorrow at 10'],
      ],
    )
    assert.equal(rows[0]?.by, JSON.stringify({ key: 's1', name: 'Agent' }))
  } finally {
    db.close()
  }
})

test('board cal push and sources: a push source’s events taken from a file; each source with its sync', async () => {
  const dir = isolatedHome()
  const cfg = cfgWith([
    { id: 'laptop', kind: 'push', label: 'Laptop' },
    { id: 'home', kind: 'ics' },
  ])
  const file = join(dir, 'events.json')
  await Bun.write(
    file,
    JSON.stringify({
      events: [{ id: 'a', title: 'Pushed', start: '2026-11-04T18:00:00Z', end: '2026-11-04T19:00:00Z' }, { nope: 1 }],
    }),
  )
  const pushed = await cal(cfg, ['push', '--source', 'laptop', '--file', file])
  assert.deepEqual(pushed.out, ['ok · 1 events taken, 1 not read · 1 in laptop'])
  assert.equal(
    JSON.parse((await cal(cfg, ['push', '--source', 'home', '--file', file, '--json'])).out[0] as string).error,
    'notPush',
  )
  const list = await cal(cfg, ['list'])
  assert.match(list.out.join('\n'), /Pushed · \[Laptop\]/)
  assert.match(list.out.at(-1) as string, /^sources: laptop synced just now; home synced never$/)
  const sources = await cal(cfg, ['sources'])
  assert.match(sources.out[2] as string, /^home · ics · home · read only · no address yet · 0 events, synced never$/)
})
