import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { isBoardPayload } from '../../web/src/api/client.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

/** herdr as the board sees it: one Claude session in w1:p1; a tab create gives w1:p9 in w1:t9. */
function herdrState(cwd: string, { session = 's1', snapshot = true } = {}) {
  return {
    'api snapshot': snapshot
      ? {
          result: {
            snapshot: {
              panes: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd }],
              tabs: [],
              workspaces: [],
            },
          },
        }
      : { error: 'offline' },
    'pane get w1:p1': { result: { pane: { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1' } } },
    'pane get w1:p9': { result: { pane: { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t9' } } },
    'tab create': { result: { root_pane: { pane_id: 'w1:p9', tab_id: 'w1:t9' }, tab: { tab_id: 'w1:t9' } } },
    'pane list': { result: { panes: [{ pane_id: 'w1:p9', tab_id: 'w1:t9' }] } },
    'pane send-text': { result: null },
    'pane send-keys': { result: null },
    'pane read': { text: 'PS> \n' },
    'pane layout': { result: { layout: { panes: [{ pane_id: 'w1:p9', rect: { width: 82, height: 30 } }] } } },
    'agent get': { result: { agent: { agent_session: { value: session } } } },
    'pane close': { result: null },
    'tab close': { result: null },
    'tab focus': { result: null },
  }
}

interface Payload {
  terminal: boolean
  shells: string[]
  fsToken: string
  stale: boolean
  items: unknown[]
}

type Reply = { status: number; body: { error?: string; pane?: string; [key: string]: unknown } }

async function board(box: Sandbox, cfg: Record<string, unknown> = {}) {
  const cwd = join(box.dir, 'work')
  mkdirSync(cwd, { recursive: true })
  box.state(herdrState(cwd))
  const { url, proc } = await serveBoard(box, { language: 'en', raiseTerminal: false, ...cfg })
  const payload = async (): Promise<Payload> => (await (await fetch(`${url}/api/board`)).json()) as Payload
  // The session on the board (the first refresh may still be under way).
  for (let i = 0; i < 50 && !(await payload()).items.length; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = { 'x-board': '1' }) => {
    const r = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: (await r.json()) as Reply['body'] }
  }
  const typed = () =>
    box
      .calls()
      .filter(a => a[0] === 'pane' && /^send-/.test(a[1] ?? ''))
      .map(a => a.slice(1))
  return { proc, cwd, url, post, payload, typed }
}

/** A POST whose body goes in two writes, the first ending in the middle of a character. */
function postSplit(url: string, body: unknown): Promise<number | undefined> {
  const bytes = Buffer.from(JSON.stringify(body))
  const cut = bytes.indexOf(Buffer.from('я')) + 1
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1', 'content-length': bytes.length },
      },
      res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.write(bytes.subarray(0, cut))
    setTimeout(() => req.end(bytes.subarray(cut)), 50)
  })
}

/** The first event of a terminal stream. */
async function firstEvent(url: string): Promise<unknown> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  const reader = res.body?.getReader()
  if (!reader) return null
  let text = ''
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      text += decoder.decode(value, { stream: true })
      const m = /data: (.*)\n\n/.exec(text)
      if (m?.[1]) return JSON.parse(m[1])
    }
  } finally {
    controller.abort()
  }
}

test('the terminal: only the page’s own requests, its own shell, the same session, fresh data; nothing typed in the log', async () => {
  const box = await sandbox()
  const { proc, cwd, url, post, payload, typed } = await board(box)
  const before = await payload()
  assert.equal(before.terminal, true)
  assert.deepEqual(before.shells, [])

  // Without the header, from another site: nothing reaches herdr.
  assert.equal((await post('/api/term/s1/shell/open', {}, {})).status, 403)
  assert.equal(
    (await post('/api/term/s1/shell/open', {}, { 'x-board': '1', origin: 'http://evil.example' })).status,
    403,
  )
  assert.equal(
    (
      await post(
        '/api/term/s1/shell/input',
        { session: 's1', steps: [{ text: 'x' }] },
        { 'x-board': '1', origin: 'http://evil.example' },
      )
    ).status,
    403,
  )
  assert.ok(!box.calls().some(a => a[1] === 'create'))
  // The stream needs the page's token; the session must be on the board; there is no shell yet.
  assert.equal((await fetch(`${url}/api/term/s1/shell/stream`)).status, 403)
  assert.equal((await fetch(`${url}/api/term/s1/shell/stream?t=${before.fsToken}`)).status, 404)
  assert.equal((await post('/api/term/nobody/shell/open')).status, 404)
  const none = await post('/api/term/s1/shell/input', { session: 's1', steps: [{ text: 'echo hi' }] })
  assert.equal(none.status, 409)
  assert.match(none.body.error ?? '', /no shell open/)

  // The shell: a tab in the session's workspace and folder.
  const opened = await post('/api/term/s1/shell/open')
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  assert.equal(opened.body.pane, 'w1:p9')
  const create = box.calls().find(a => a[0] === 'tab' && a[1] === 'create')
  assert.deepEqual(create?.slice(2), ['--workspace', 'w1', '--cwd', cwd, '--label', 'w1:p1 · shell', '--no-focus'])
  const withShell = await payload()
  assert.deepEqual(withShell.shells, ['s1'])
  // The page takes the board as the server sends it, the terminal's fields included.
  assert.ok(isBoardPayload(before) && isBoardPayload(withShell))
  const first = await firstEvent(`${url}/api/term/s1/shell/stream?t=${before.fsToken}`)
  assert.deepEqual(first, { t: 'frame', drop: 0, keep: 0, lines: ['PS> '], cols: 80 })

  // Typing: the text as typed, then the key; a key the board does not send stops the whole request.
  const ok = await post('/api/term/s1/shell/input', {
    session: 's1',
    steps: [{ text: 'echo secret-typed' }, { key: 'enter' }],
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(typed(), [
    ['send-text', 'w1:p9', 'echo secret-typed'],
    ['send-keys', 'w1:p9', 'enter'],
  ])
  const bad = await post('/api/term/s1/shell/input', { session: 's1', steps: [{ text: 'ls' }, { key: 'enter; rm' }] })
  assert.equal(bad.status, 409)
  for (const key of ['constructor', '__proto__', 'ctrl+toString'])
    assert.equal((await post('/api/term/s1/shell/input', { session: 's1', steps: [{ key }] })).status, 409, key)
  assert.equal((await post('/api/term/s1/shell/stream')).status, 409) // a POST is not the stream, nor anything else
  assert.equal(typed().length, 2)

  // Text in other scripts arrives whole, even when the request's bytes come split in a character.
  const wide = 'я'.repeat(9000) + '漢'.repeat(4000)
  assert.equal(await postSplit(`${url}/api/term/s1/shell/input`, { session: 's1', steps: [{ text: wide }] }), 200)
  assert.deepEqual(typed().at(-1), ['send-text', 'w1:p9', wide])

  // The session's own pane: only while the same session runs there.
  const other = await post('/api/term/s1/agent/input', { session: 's2', steps: [{ key: 'esc' }] })
  assert.equal(other.status, 409)
  assert.match(other.body.error ?? '', /another session/)
  box.state({ ...herdrState(cwd, { session: 's9' }) })
  const swapped = await post('/api/term/s1/agent/input', { session: 's1', steps: [{ key: 'esc' }] })
  assert.equal(swapped.status, 409)
  assert.equal(typed().length, 3)
  box.state(herdrState(cwd))
  const agent = await post('/api/term/s1/agent/input', { session: 's1', steps: [{ text: '/login' }, { key: 'enter' }] })
  assert.equal(agent.status, 200, JSON.stringify(agent.body))
  assert.deepEqual(typed().slice(3), [
    ['send-text', 'w1:p1', '/login'],
    ['send-keys', 'w1:p1', 'enter'],
  ])

  // "Open in herdr": the shell's own tab.
  assert.equal((await post('/api/term/s1/shell/focus')).status, 200)
  assert.ok(box.calls().some(a => a[0] === 'tab' && a[1] === 'focus' && a[2] === 'w1:t9'))

  // Closing: its pane, then its tab, where nothing else is left.
  box.state({ ...herdrState(cwd), 'pane list': { result: { panes: [] } } })
  const closed = await post('/api/term/s1/shell/close')
  assert.equal(closed.status, 200)
  assert.ok(box.calls().some(a => a[0] === 'pane' && a[1] === 'close' && a[2] === 'w1:p9'))
  assert.ok(box.calls().some(a => a[0] === 'tab' && a[1] === 'close' && a[2] === 'w1:t9'))
  assert.deepEqual((await payload()).shells, [])

  // No fresh herdr data: read only.
  box.state(herdrState(cwd, { snapshot: false }))
  for (let i = 0; i < 50 && !(await payload()).stale; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const stale = await post('/api/term/s1/agent/input', { session: 's1', steps: [{ key: 'enter' }] })
  assert.equal(stale.status, 409)
  assert.match(stale.body.error ?? '', /No fresh data/)
  assert.equal(typed().length, 5)

  // Nothing typed or read went to the log.
  assert.ok(!JSON.stringify(proc.messages).includes('secret-typed'))
  assert.ok(!JSON.stringify(proc.messages).includes('/login'))
}, 60_000)

test('terminal: false in config.json turns the terminal off', async () => {
  const box = await sandbox()
  const { url, post, payload } = await board(box, { terminal: false })
  const data = await payload()
  assert.equal(data.terminal, false)
  assert.deepEqual(data.shells, [])
  assert.ok(isBoardPayload(data))
  assert.equal((await post('/api/term/s1/shell/open')).status, 404)
  assert.equal((await post('/api/term/s1/agent/input', { session: 's1', steps: [{ key: 'enter' }] })).status, 404)
  assert.equal((await fetch(`${url}/api/term/s1/agent/stream?t=${data.fsToken}`)).status, 404)
  assert.ok(!box.calls().some(a => a[0] !== 'api'))
}, 30_000)

test('terminal is on only when the setting is missing or true', async () => {
  for (const value of ['false', 0, null, 'no']) {
    const box = await sandbox()
    const { url, post, payload } = await board(box, { terminal: value })
    const data = await payload()
    assert.equal(data.terminal, false, String(value))
    assert.equal((await post('/api/term/s1/shell/open')).status, 404)
    assert.equal((await fetch(`${url}/api/term/s1/agent/stream?t=${data.fsToken}`)).status, 404)
  }
}, 60_000)
