// The "web" action with a pane (a notification clicked): the running board is asked to show that
// session, and its window comes up or a new one opens on it; it never starts the board. Windows
// are fakes here; the board is a stand-in answering /api/reveal.
import { afterEach, expect, test } from 'bun:test'
import { useLanguage } from '../../src/core/lang.ts'
import type { BoardWindow } from '../../src/integrations/edge-window.ts'
import { openWeb, reminderClick } from '../../src/services/web-open.ts'
import { unusedPort } from '../support/board-server.ts'

function fakeWindow(raised: boolean) {
  const did: string[] = []
  const win: BoardWindow = {
    async open(url) {
      did.push(`open ${url}`)
    },
    async raise() {
      did.push('raise')
      return raised
    },
    launch(url) {
      did.push(`launch ${url}`)
    },
  }
  return { win, did }
}

/** A board that answers /api/reveal with `status` and `body`, and records what it was asked. */
function standIn(status: number, body: unknown) {
  const asked: { headers: Record<string, string>; body: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/reveal') return new Response('', { status: 404 })
      asked.push({ headers: Object.fromEntries(req.headers), body: await req.json() })
      return Response.json(body, { status })
    },
  })
  return { cfg: { port: server.port }, asked, stop: () => server.stop(true) }
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

test('the board’s window comes up and shows the session, a page in it open or asleep', async () => {
  for (const pages of [1, 0]) {
    const board = standIn(200, { ok: true, key: 's1', pages })
    stops.push(board.stop)
    const { win, did } = fakeWindow(true)
    const url = `http://127.0.0.1:${board.cfg.port}/`
    expect(await openWeb(board.cfg, { pane: 'w1:p1', window: win })).toEqual({ ok: true, url, key: 's1' })
    expect(did).toEqual(['raise'])
    expect(board.asked).toHaveLength(1)
    expect(board.asked[0]?.body).toEqual({ pane: 'w1:p1' })
    expect(board.asked[0]?.headers['x-board']).toBe('1')
  }
})

test('no board window to raise: a new window opens on the session', async () => {
  const board = standIn(200, { ok: true, key: 'a b', pages: 0 })
  stops.push(board.stop)
  const { win, did } = fakeWindow(false)
  const url = `http://127.0.0.1:${board.cfg.port}/`
  expect(await openWeb(board.cfg, { pane: 'p', window: win })).toEqual({ ok: true, url })
  expect(did).toEqual(['raise', `launch ${url}#session=a%20b`])
})

test('no session in that pane, or no board: nothing opens, and the caller is told (missing)', async () => {
  useLanguage('en')
  const board = standIn(404, { ok: false, error: 'The session is no longer on the board' })
  stops.push(board.stop)
  const { win, did } = fakeWindow(true)
  expect(await openWeb(board.cfg, { pane: 'w1:p2', window: win })).toEqual({
    ok: false,
    missing: true,
    error: 'The session is no longer on the board',
  })
  const port = await unusedPort()
  expect(await openWeb({ port }, { pane: 'w1:p2', window: win })).toEqual({
    ok: false,
    missing: true,
    error: 'The board is not running: open it once with Ctrl+B, A',
  })
  expect(did).toEqual([])
})

/** A board that answers /api/calendar-reminders with `status` and `body` (#335). */
function reminderStandIn(status: number, body: unknown) {
  const asked: { headers: Record<string, string>; body: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/calendar-reminders')
        return new Response('', { status: 404 })
      asked.push({ headers: Object.fromEntries(req.headers), body: await req.json() })
      return Response.json(body, { status })
    },
  })
  return { cfg: { port: server.port }, asked, stop: () => server.stop(true) }
}

test('a reminder’s button on the desktop: the board is told, from the desktop; Open brings its window up, a snooze does not', async () => {
  const board = reminderStandIn(200, { ok: true, event: { source: 'work', id: 'e1', start: 'x' } })
  try {
    const snooze = fakeWindow(true)
    expect(await reminderClick('snooze', 'AbCdEfGhIjKlMn_-', board.cfg, { window: snooze.win })).toEqual({
      ok: true,
      url: `http://127.0.0.1:${board.cfg.port}/`,
    })
    expect(snooze.did).toEqual([])
    expect(board.asked[0]?.body).toEqual({ id: 'AbCdEfGhIjKlMn_-', act: 'snooze', desktop: true })
    expect(board.asked[0]?.headers['x-board']).toBe('1')
    const raised = fakeWindow(true)
    await reminderClick('open', 'AbCdEfGhIjKlMn_-', board.cfg, { window: raised.win })
    expect(raised.did).toEqual(['raise'])
    const closed = fakeWindow(false)
    await reminderClick('open', 'AbCdEfGhIjKlMn_-', board.cfg, { window: closed.win })
    expect(closed.did).toEqual(['raise', `launch http://127.0.0.1:${board.cfg.port}/`])
  } finally {
    board.stop()
  }
})

test('a reminder’s button: nothing asked for an act or id that is not one; a board that refuses or is not there says so', async () => {
  useLanguage('en')
  const board = reminderStandIn(404, { ok: false, error: 'That reminder is gone' })
  try {
    for (const [act, id] of [
      ['delete', 'AbCdEfGhIjKlMn_-'],
      ['snooze', 'short'],
      ['snooze', 'AbCdEfGhIjKlMn_-;x'],
    ] as const)
      expect((await reminderClick(act, id, board.cfg, { window: fakeWindow(true).win })).ok).toBe(false)
    expect(board.asked).toEqual([])
    const win = fakeWindow(true)
    expect(await reminderClick('open', 'AbCdEfGhIjKlMn_-', board.cfg, { window: win.win })).toEqual({
      ok: false,
      error: 'That reminder is gone',
    })
    expect(win.did).toEqual([])
  } finally {
    board.stop()
  }
  const gone = await reminderClick('snooze', 'AbCdEfGhIjKlMn_-', { port: await unusedPort() })
  expect(gone).toMatchObject({ ok: false, missing: true })
})
