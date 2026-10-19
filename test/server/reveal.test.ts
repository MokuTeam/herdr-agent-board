// POST /api/reveal (a notification clicked, entrypoints/web-open.ts): open pages are told, over
// their event stream, the session in a herdr pane; so is a page that connects right after.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REVEAL_MS, revealState } from '../../src/server/routes/reveal.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

/** A page of the board, listening: what its stream said so far. */
async function listen(url: string): Promise<{ heard: string; close(): void }> {
  const controller = new AbortController()
  const res = await fetch(`${url}/api/events`, { signal: controller.signal })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no stream')
  const page = { heard: '', close: () => controller.abort() }
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read())
        page.heard += decoder.decode(r.value, { stream: true })
    } catch {
      // The page left, or the board went with the sandbox: its stream breaks off then.
    }
  })()
  await until(() => page.heard.includes('data:'))
  return page
}

const reveals = (page: { heard: string }) => page.heard.split('event: reveal').length - 1

test('a notification clicked: open pages are told the session in that pane; no session there, no news', async () => {
  const box = await sandbox()
  const cwd = join(box.dir, 'work')
  mkdirSync(cwd)
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd }],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const { url, proc } = await serveBoard(box, { language: 'en' })
  let items: { key: string }[] = []
  for (let i = 0; i < 50 && !items.length; i++) {
    proc.send('refresh')
    await Bun.sleep(100)
    items = ((await (await fetch(`${url}/api/board`)).json()) as { items: { key: string }[] }).items
  }
  const key = items[0]?.key
  assert.ok(key)
  const post = async (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) => {
    const r = await fetch(`${url}/api/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }

  const pages = [await listen(url)]
  const [page] = pages
  if (!page) throw new Error('no page')
  try {
    assert.equal((await post({ pane: 'w1:p1' }, {})).status, 403)
    const r = await post({ pane: 'w1:p1' })
    assert.equal(r.status, 200)
    assert.deepEqual([r.body.ok, r.body.key, r.body.pages], [true, key, 1])
    await until(() => reveals(page))
    assert.ok(page.heard.includes(`event: reveal\ndata: ${JSON.stringify({ key })}\n\n`))

    // A page that connects right after (its window was minimized, and is raised now) hears it as
    // it comes; one that comes later on its own does not.
    const raised = await listen(url)
    pages.push(raised)
    await until(() => reveals(raised))
    assert.ok(raised.heard.includes(`event: reveal\ndata: ${JSON.stringify({ key })}\n\n`))
    const later = await listen(url)
    pages.push(later)

    // By its key too. A stream keeps its order, so once every page has heard this one, what each
    // was told before it has come too: `raised` was told once as it connected, `later` never.
    assert.equal((await post({ key })).status, 200)
    await until(() => reveals(page) >= 2 && reveals(raised) >= 2 && reveals(later) >= 1)
    assert.deepEqual([reveals(page), reveals(raised), reveals(later)], [2, 2, 1])

    // A pane the board has no session in: the caller goes to herdr instead.
    const missing = await post({ pane: 'w1:p2' })
    assert.deepEqual(
      [missing.status, missing.body],
      [404, { ok: false, error: 'The session is no longer on the board' }],
    )
    assert.equal((await post({})).status, 404)
    // Nothing went out for those: the next reveal is the page's third.
    assert.equal((await post({ key })).status, 200)
    await until(() => reveals(page) >= 3)
    assert.equal(reveals(page), 3)
  } finally {
    for (const p of pages) p.close()
  }
}, 15_000)

test('a page connecting is told the session asked for in the last 15 s, once', () => {
  let now = 1_000_000
  const state = revealState(() => now)
  expect(state.greet()).toBe('')
  state.asked('s1')
  now += REVEAL_MS - 1
  expect(state.greet()).toBe('event: reveal\ndata: {"key":"s1"}\n\n')
  expect(state.greet()).toBe('')
  state.asked('s2')
  now += REVEAL_MS
  expect(state.greet()).toBe('')
})
