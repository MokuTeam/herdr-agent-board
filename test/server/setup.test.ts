import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { isBoardPayload } from '../../web/src/api/client.ts'
import { isSetupReply, isSetupSummary } from '../../web/src/models/setup.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

type SetupReply = { checks: { id: string; level: string }[]; todo: number; sig: string }

type Board = { setup?: unknown }
const boardOf = async (url: string): Promise<Board> => (await (await fetch(`${url}/api/board`)).json()) as Board

test('before its first check ends the board goes out with setup: null, which the page takes for no note', async () => {
  // A herdr-wake in this test that holds its /status answer: the first check cannot end before
  // the test lets it (or the probe gives up, 1.5 s on).
  let asked = false
  let answer: (res: Response) => void = () => {}
  const wake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: req => {
      if (new URL(req.url).pathname !== '/status') return new Response('', { status: 404 })
      asked = true
      return new Promise<Response>(resolve => {
        answer = resolve
      })
    },
  })
  try {
    const box = await sandbox()
    box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
    const { url } = await serveBoard(box, { language: 'en', wakeUrl: `http://127.0.0.1:${wake.port}` })
    await until(() => asked)
    const before = await boardOf(url)
    assert.ok('setup' in before)
    assert.equal(before.setup, null)
    assert.equal(isBoardPayload(before), true)
    assert.equal(isSetupSummary(before.setup), false)
    assert.equal(isSetupSummary({ todo: '1', sig: '' }), false)
    // The check ends: the board goes out with its summary.
    answer(Response.json({ ok: true }))
    let after = before
    const deadline = Date.now() + 5000
    while (!isSetupSummary(after.setup) && Date.now() < deadline) {
      await Bun.sleep(20)
      after = await boardOf(url)
    }
    assert.equal(isSetupSummary(after.setup), true)
  } finally {
    await wake.stop(true)
  }
}, 20_000)

test('the setup check: a summary with the board, the whole list on request', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const { url } = await serveBoard(box, { language: 'en' })
  // A fresh home: no board command, no hooks, so the board says something is missing.
  const res = await fetch(`${url}/api/setup`)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const r = (await res.json()) as SetupReply
  assert.ok(r.checks.some(c => c.id === 'hooks' && c.level === 'error'))
  assert.ok(r.todo >= 2)
  assert.match(r.sig, /hooks:error:/)
  assert.equal(r.checks.find(c => c.id === 'wake')?.level, 'off') // optional: not counted
  // The check published the board before it answered.
  const board = (await (await fetch(`${url}/api/board`)).json()) as { setup?: unknown }
  assert.deepEqual(board.setup, { todo: r.todo, sig: r.sig })
  // The page's guards take what the server really sends: the list, the board and its summary.
  assert.equal(isSetupReply(r), true)
  assert.equal(isBoardPayload(board), true)
  assert.equal(isSetupSummary(board.setup), true)
  // Nothing of the computer's own files reaches the page beyond the checks.
  assert.equal('settings' in r || 'facts' in r, false)
}, 20_000)
