import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logged, serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

test('stale herdr data: herdr actions wait, the board’s own edits and previews go on', async () => {
  const box = await sandbox()
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ pane_id: 'p', agent: 'claude', agent_session: { value: 'a' }, agent_status: 'idle' }],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const { url, proc } = await serveBoard(box)
  const deadline = Date.now() + 5000
  while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
    if (Date.now() > deadline) throw Error('not fresh')
    await new Promise(r => setTimeout(r, 10))
  }
  box.state({ 'api snapshot': { error: 'offline' } })
  proc.send('refresh')
  await until(() => logged(proc, 'offline'))
  const post = (path: string, body: unknown) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
  assert.equal((await post('/api/session/a/focus', {})).status, 409)
  assert.equal((await post('/api/session/a/message', { text: 'must not send' })).status, 409)
  // What the board does itself goes on without herdr: settings, card edits, opening files and links
  // (checked here by the answers they give, without opening anything).
  assert.equal((await post('/api/settings', { language: 'ru' })).status, 200)
  assert.equal((await post('/api/session/a/card', { doing: 'still editable' })).status, 200)
  assert.equal((await post('/api/open-url', { url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post('/api/fs/open', { path: join(box.dir, 'missing.txt') })).status, 404)
  const file = join(box.dir, 'preview.txt')
  writeFileSync(file, 'synthetic')
  assert.equal((await post('/api/fs/preview', { path: file })).status, 200)
  assert.equal(
    box.calls().some(args => args[0] === 'agent'),
    false,
  )
}, 15000)
