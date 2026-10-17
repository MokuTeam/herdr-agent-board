import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { isBoardPayload } from '../../web/src/api/client.ts'
import { isSetupReply, isSetupSummary } from '../../web/src/models/setup.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'

type SetupReply = { checks: { id: string; level: string }[]; todo: number; sig: string }

test('before its first check the board says no summary, which the page takes for none', () => {
  assert.equal(isSetupSummary(null), false)
  assert.equal(isSetupSummary({ todo: '1', sig: '' }), false)
})

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
