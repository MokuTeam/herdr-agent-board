// The "web" action with a pane (a notification clicked): the running board is asked to show that
// session, and its window comes up or a new one opens on it; it never starts the board. Windows
// are fakes here; the board is a stand-in answering /api/reveal.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { openWeb } from '../../src/entrypoints/web-open.ts'
import type { BoardWindow } from '../../src/integrations/edge-window.ts'
import { unusedPort } from '../support/board-server.ts'
import { root, sandbox } from '../support/sandbox.ts'

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

test('open pages show the session: the window only comes up', async () => {
  const board = standIn(200, { ok: true, key: 's1', pages: 1 })
  stops.push(board.stop)
  const { win, did } = fakeWindow(true)
  const url = `http://127.0.0.1:${board.cfg.port}/`
  expect(await openWeb(board.cfg, { pane: 'w1:p1', window: win })).toEqual({ ok: true, url, key: 's1' })
  expect(did).toEqual(['raise'])
  expect(board.asked).toHaveLength(1)
  expect(board.asked[0]?.body).toEqual({ pane: 'w1:p1' })
  expect(board.asked[0]?.headers['x-board']).toBe('1')
})

test('no open page, or no window to raise: a new window opens on the session', async () => {
  const none = standIn(200, { ok: true, key: 'a b', pages: 0 })
  stops.push(none.stop)
  const first = fakeWindow(true)
  const url = `http://127.0.0.1:${none.cfg.port}/`
  expect(await openWeb(none.cfg, { pane: 'p', window: first.win })).toEqual({ ok: true, url })
  expect(first.did).toEqual([`launch ${url}#session=a%20b`])

  const hidden = standIn(200, { ok: true, key: 's1', pages: 2 })
  stops.push(hidden.stop)
  const second = fakeWindow(false)
  const at = `http://127.0.0.1:${hidden.cfg.port}/`
  expect(await openWeb(hidden.cfg, { pane: 'p', window: second.win })).toEqual({ ok: true, url: at })
  expect(second.did).toEqual(['raise', `launch ${at}#session=s1`])
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

test('the command: --pane with no board running exits with code 3 and says why', async () => {
  const box = await sandbox()
  const port = await unusedPort()
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port }))
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'web-open.ts'), '--pane', 'w1:p9'], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(3)
  expect(stderr).toBe('')
  expect(stdout.trim()).toBe('The board is not running: open it once with Ctrl+B, A')
}, 15_000)
