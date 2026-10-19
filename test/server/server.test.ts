import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logged, serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

type Board = {
  stale: boolean
  lastSuccessfulRefreshAt: number | null
  items: { session: string | null }[]
  categories: unknown[]
  columns: unknown[]
}

test('GET and SSE expose initial, failed, successful, stale and recovered snapshots', async () => {
  const box = await sandbox()
  const gate = join(box.dir, 'first-refresh')
  box.state({ 'api snapshot': { error: 'offline', waitFor: gate } })
  const { url, proc } = await serveBoard(box)
  const get = async (): Promise<Board> => {
    const response = await fetch(`${url}/api/board`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return (await response.json()) as Board
  }
  const initial = await get()
  assert.equal(initial.stale, true)
  assert.equal(initial.lastSuccessfulRefreshAt, null)
  assert.deepEqual(initial.items, [])
  assert.ok(initial.categories.length)
  assert.equal(initial.columns.length, 5)

  const controller = new AbortController()
  const stream = await fetch(`${url}/api/events`, { signal: controller.signal })
  if (!stream.body) throw new Error('no event stream')
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  const events: Board[] = []
  let text = ''
  let readingError: unknown
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
        for (let end = text.indexOf('\n\n'); end !== -1; end = text.indexOf('\n\n')) {
          const event = text.slice(0, end)
          text = text.slice(end + 2)
          const line = event.split('\n').find(line => line.startsWith('data: '))
          if (line) events.push(JSON.parse(line.slice(6)) as Board)
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) readingError = err
    }
  })()
  onTestFinished(async () => {
    controller.abort()
    await reading
  })
  await until(() => events.length > 0)
  assert.deepEqual(events[0], initial)
  writeFileSync(gate, '')
  // First failure must never make the initial empty snapshot look live.
  await until(() => logged(proc, 'offline'))
  assert.equal((await get()).lastSuccessfulRefreshAt, null)

  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle' }],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
  proc.send('refresh')
  await until(() => events.some(e => !e.stale))
  const successful = await get()
  assert.equal(successful.stale, false)
  assert.equal(typeof successful.lastSuccessfulRefreshAt, 'number')
  assert.equal(successful.items[0]?.session, 's1')

  box.state({ 'api snapshot': { error: 'offline' } })
  const beforeFailure = events.length
  proc.send('refresh')
  await until(() => events.slice(beforeFailure).some(e => e.stale))
  const stale = await get()
  assert.equal(stale.stale, true)
  assert.equal(stale.lastSuccessfulRefreshAt, successful.lastSuccessfulRefreshAt)
  assert.deepEqual(stale.items, successful.items)
  await until(() => events.some(e => e.stale && e.lastSuccessfulRefreshAt === successful.lastSuccessfulRefreshAt))

  box.state({ 'api snapshot': { result: { snapshot } } })
  const beforeRecovery = events.length
  proc.send('refresh')
  await until(() => events.slice(beforeRecovery).some(e => !e.stale))
  const recovered = await get()
  assert.equal(recovered.stale, false)
  assert.ok((recovered.lastSuccessfulRefreshAt ?? 0) >= (stale.lastSuccessfulRefreshAt ?? 0))
  assert.deepEqual(recovered.items, stale.items)
  await until(() => events.some(e => !e.stale && e.lastSuccessfulRefreshAt === recovered.lastSuccessfulRefreshAt))
  assert.equal(readingError, undefined)
  controller.abort()
  await reading
}, 20_000)
