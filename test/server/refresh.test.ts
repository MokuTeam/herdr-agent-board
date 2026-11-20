// The server's refresh as the tests and config reloads await it (server/board-state.ts): one asked
// for while another runs ends once a collect that started after it is done (#171, #131). Before,
// it came back at once, and a test read the board as the run before had left it.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

const snapshot = (session: string) => ({
  result: {
    snapshot: {
      panes: [{ pane_id: 'p', agent: 'claude', agent_session: { value: session }, agent_status: 'idle' }],
      tabs: [],
      workspaces: [],
    },
  },
})

test('a refresh asked for while the start’s one runs ends after a collect that started after it', async () => {
  const box = await sandbox()
  const gate = join(box.dir, 'go')
  // The start's collect waits at herdr's snapshot until the gate is there.
  box.state({ 'api snapshot': { ...snapshot('a'), waitFor: gate } })
  const { url, proc } = await serveBoard(box)
  await until(() => box.calls().some(a => a.join(' ') === 'api snapshot'), 10_000)
  const refreshed = (from: number) => proc.messages.slice(from).some(m => (m as { refreshed?: boolean }).refreshed)
  const n = proc.messages.length
  proc.send('refresh')
  await Bun.sleep(300)
  assert.equal(refreshed(n), false, 'came back while the start’s collect still waited')
  box.state({ 'api snapshot': snapshot('b') })
  writeFileSync(gate, '')
  await until(() => refreshed(n), 10_000)
  const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: { key: string }[] }
  assert.equal(board.stale, false)
  assert.deepEqual(
    board.items.map(i => i.key),
    ['b'],
  )
}, 30_000)

test('one asked for while the start’s one runs ends too when the collect after it fails', async () => {
  const box = await sandbox()
  const gate = join(box.dir, 'go')
  box.state({ 'api snapshot': { ...snapshot('a'), waitFor: gate } })
  const { url, proc } = await serveBoard(box)
  await until(() => box.calls().some(a => a.join(' ') === 'api snapshot'), 10_000)
  const n = proc.messages.length
  proc.send('refresh')
  box.state({ 'api snapshot': { error: 'offline' } })
  writeFileSync(gate, '')
  await until(() => proc.messages.slice(n).some(m => (m as { refreshed?: boolean }).refreshed), 10_000)
  assert.ok(proc.messages.some(m => String((m as { log?: string }).log).includes('offline')))
  const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }
  assert.equal(board.stale, true)
}, 30_000)
