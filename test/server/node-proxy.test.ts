// The master proxies by key (#501, docs/design/nodes 5, 6.2, 10 item 2, 12) on running boards: a
// master and its node as sandbox boards (test/support/node-pair.ts), each with a fake herdr of its own.
// - A session action from the master reaches the node and acts on the node's fake herdr, never on the
//   master's; the key spelled `%40server-1%3A...` routes the same; the sheet's reads, a card edit, a
//   schedule edit and a reminder the master's scheduler holds for the node's card go there too.
// - Files: a chip's preview and stat, the raw bytes with the master's token outside and the node's
//   inside, an upload into the node's uploads whose path a message then carries.
// - Focusing a pane, opening a file or a link, revealing: 403 desktop for a node key, before the node.
// - The bulk routes split by device; the tunnel's refusals apply before the proxy; an offline node
//   answers 503 node-offline.
// - The terminal's stream carries the node's screen and ends when the node forgets the master; a
//   secret form's answer writes the node's sink and nothing of it is on the master.
// - Without `nodes`: the route table is the board's own, and a prefixed key is what it was there.
import { describe, expect, onTestFinished, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDeviceStore, createNodeStore } from '../../src/adapters/node-store.ts'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { Item } from '../../src/core/types.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type FakePane, nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { routeTable, seedAccess, stateFolder, viaCaddy } from '../support/tunnel-board.ts'

const K = '@server-1:pane-p'
/** A login cookie's token: 43 characters of base64url. */
const LOGIN = 'tUnNeLlOgInToKeNtUnNeLlOgInToKeNtUnNeLlOgIn'
const SID = '5e1f0c2e-5b7a-4c39-9e1d-2a6b8c0f4e22'

const codexPane = (box: Sandbox, id: string): FakePane => ({
  pane_id: id,
  agent: 'codex',
  agent_status: 'idle',
  cwd: box.dir,
})

/** A fake herdr whose panes take a prompt and show a screen. */
function herdrOf(box: Sandbox, panes: FakePane[]): void {
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    'agent get': { result: { agent: { agent_status: 'idle' } } },
    'agent prompt': { result: {} },
    'pane read': { text: 'PS> the node screen\n' },
  })
}

/** What the node's door was asked since `from`, without the link's own status and stream. */
const askedSince = (requests: string[], from: number): string[] =>
  requests.slice(from).filter(r => r !== 'GET /api/node/status' && r !== 'GET /api/events' && r !== 'GET /api/hello')

const prompts = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')

async function board(url: string): Promise<BoardPayload> {
  const res = await fetch(`${url}/api/board`)
  if (!res.ok) throw new Error(`GET /api/board: ${res.status}`)
  return (await res.json()) as BoardPayload
}

async function boardWhen(url: string, ok: (p: BoardPayload) => boolean, ms = 15_000): Promise<BoardPayload> {
  const deadline = Date.now() + ms
  for (;;) {
    const last = await board(url)
    if (ok(last)) return last
    if (Date.now() > deadline)
      throw new Error(`the payload never came to that: ${JSON.stringify(last.items.map(i => i.key))}`)
    await Bun.sleep(50)
  }
}

const keys = (p: BoardPayload): string[] => p.items.map(i => i.key)

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
    body: JSON.stringify(body),
  })
}

async function answer(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** A schedule entry written as the store writes one; the board's folder watch sees it. */
function entry(box: Sandbox, e: Record<string, unknown>): string {
  const dir = join(stateFolder(box), 'schedule')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${e.id}.json`)
  writeFileSync(file, JSON.stringify({ created: Date.now(), ...e }))
  return file
}

/** Every file under `dir` holding `text`. */
function holding(dir: string, text: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, name)
    try {
      if (readFileSync(path).includes(text)) out.push(path)
    } catch {}
  }
  return out
}

describe('a node card through the master', () => {
  test('actions, the sheet, files, uploads, schedule edits and reminders reach the node; desktop routes do not', async () => {
    const tunnelPort = await unusedPort()
    const masterWake = await fakeWake()
    const nodeWake = await fakeWake()
    const pair = await nodePair({
      panes: (_id, box) => [codexPane(box, 'p')],
      masterPanes: box => [codexPane(box, 'm')],
      nodeCfg: () => ({ wakeUrl: nodeWake.url }),
      deviceCfg: () => ({ profiles: { work: 'nodework' } }),
      masterCfg: {
        wakeUrl: masterWake.url,
        scheduleTickSec: 0.2,
        tunnel: {
          on: true,
          host: 'ssh.example.com',
          user: 'boardtunnel',
          domain: 'board.example.com',
          port: tunnelPort,
        },
      },
      masterSetup: box => seedAccess(box, { logins: [{ token: LOGIN }] }),
      env: { TEST_ROUTE_TABLE: '1' },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const master = pair.master
    herdrOf(node.box, [codexPane(node.box, 'p')])
    herdrOf(master.box, [codexPane(master.box, 'm')])
    await boardWhen(master.url, b => keys(b).includes(K) && keys(b).includes('pane-m'))
    const at = (path: string): string => `${master.url}${path}`

    // A message, by the key encoded and as it is: typed into the node's pane, nothing into the master's.
    const encoded = await answer(
      await post(at(`/api/session/${encodeURIComponent(K)}/message`), { text: 'hello node', session: null }),
    )
    expect(encoded.status, JSON.stringify(encoded.body)).toBe(200)
    const plain = await answer(await post(at(`/api/session/${K}/message`), { text: 'plain key', session: null }))
    expect(plain.status, JSON.stringify(plain.body)).toBe(200)
    expect(prompts(node.box).map(c => c.slice(2))).toEqual([
      ['p', 'hello node'],
      ['p', 'plain key'],
    ])
    expect(prompts(master.box)).toEqual([])

    // The sheet's reads are the node's, by its own key.
    const detail = await answer(await fetch(at(`/api/session/${encodeURIComponent(K)}`)))
    expect(detail.status).toBe(200)
    expect((detail.body.item as Item).key).toBe('pane-p')
    expect((await fetch(at(`/api/session/${encodeURIComponent(K)}/history`))).status).toBe(200)
    // A card edit lands on the node's card.
    expect((await post(at(`/api/session/${encodeURIComponent(K)}/card`), { doing: 'on the node' })).status).toBe(200)
    expect(JSON.parse(readFileSync(join(node.box.cards, 'pane-p.json'), 'utf8')).doing).toBe('on the node')
    expect(holding(master.box.cards, 'on the node')).toEqual([])

    // Focusing herdr there, opening a file or a link, revealing: refused here, the node never asked.
    const before = node.proxy.requests.length
    const file = join(node.box.dir, 'notes.txt')
    writeFileSync(file, 'anna on the node')
    for (const [path, body] of [
      [`/api/session/${encodeURIComponent(K)}/focus`, {}],
      [`/api/term/${encodeURIComponent(K)}/shell/focus`, {}],
      ['/api/fs/open', { key: K, path: file }],
      ['/api/open-url', { key: K, url: 'https://example.com/' }],
      ['/api/reveal', { key: K }],
    ] as const) {
      const r = await answer(await post(at(path), body))
      expect([path, r.status, r.body.error]).toEqual([path, 403, 'desktop'])
    }
    expect(askedSince(node.proxy.requests, before)).toEqual([])

    // The caller's cookie, Authorization and Origin stay here: the node hears the link's own token.
    const leaked = await post(
      at(`/api/session/${encodeURIComponent(K)}/card`),
      { doing: 'headers' },
      { cookie: 'session=callers-cookie', authorization: 'Bearer callers-own-token-0123456789', origin: master.url },
    )
    expect(leaked.status).toBe(200)
    const sentCard = node.proxy.received.filter(r => r.request === 'POST /api/session/pane-p/card').at(-1)
    expect(sentCard?.headers.cookie).toBeUndefined()
    expect(sentCard?.headers.origin).toBeUndefined()
    expect(sentCard?.headers.authorization).toBe(`Bearer ${node.token}`)
    // A terminal's GET other than its stream is no request of the terminal's, as on this board.
    expect((await fetch(at(`/api/term/${encodeURIComponent(K)}/shell/open`))).status).toBe(405)
    // The node board's own files are none of the master's, as the master's are none of the tunnel's.
    const ownFile = join(stateFolder(node.box), 'node', 'masters.json')
    expect(existsSync(ownFile)).toBe(true)
    expect((await post(at('/api/fs/preview'), { key: K, path: ownFile })).status).toBe(403)

    // A file chip: its stat and preview are the node's.
    const preview = await answer(await post(at('/api/fs/preview'), { key: K, path: file }))
    expect(preview.status).toBe(200)
    expect(JSON.stringify(preview.body)).toContain('anna on the node')
    const stat = await answer(await post(at('/api/fs/stat'), { key: K, paths: [file] }))
    expect((stat.body.items as { exists: boolean }[])[0]?.exists).toBe(true)
    const relStat = await answer(await post(at('/api/fs/stat'), { key: K, cwd: node.box.dir, paths: ['notes.txt'] }))
    expect((relStat.body.items as { exists: boolean; path: string }[])[0]).toMatchObject({
      exists: true,
      path: file,
    })
    expect(node.proxy.requests).toContain('POST /api/fs/preview')
    expect(node.proxy.requests).toContain('POST /api/fs/stat')

    // Raw bytes: the master's token outside, the node's inside; the node's own token is no way in here.
    const pic = join(node.box.dir, 'pic.png')
    writeFileSync(pic, 'png bytes of the node')
    const outside = (await board(master.url)).fsToken
    const inside = (await board(node.url)).fsToken
    expect(outside).not.toBe(inside)
    const raw = (t: string): Promise<Response> =>
      fetch(at(`/api/fs/raw?key=${encodeURIComponent(K)}&path=${encodeURIComponent(pic)}&t=${t}`))
    const got = await raw(outside)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('png bytes of the node')
    const asked = node.proxy.requests.length
    expect((await raw(inside)).status).toBe(403)
    expect((await raw('')).status).toBe(403)
    expect(askedSince(node.proxy.requests, asked)).toEqual([])
    const download = await fetch(
      at(`/api/fs/download?key=${encodeURIComponent(K)}&path=${encodeURIComponent(pic)}&t=${outside}`),
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('pic.png')
    await download.body?.cancel()

    // An upload lands in the node's uploads; the message carries the node's path.
    const name = 'заметки 100%.txt'
    const up = await answer(
      await fetch(at(`/api/upload?key=${encodeURIComponent(K)}`), {
        method: 'POST',
        headers: { 'x-board': '1', 'x-filename': encodeURIComponent(name) },
        body: 'uploaded for the node',
      }),
    )
    expect(up.status, JSON.stringify(up.body)).toBe(200)
    const upPath = String(up.body.path)
    expect(upPath.startsWith(join(stateFolder(node.box), 'uploads'))).toBe(true)
    expect(readFileSync(upPath, 'utf8')).toBe('uploaded for the node')
    expect(existsSync(join(stateFolder(master.box), 'uploads'))).toBe(false)
    expect(String(up.body.url).endsWith(`?key=${encodeURIComponent(K)}`)).toBe(true)
    const fetched = await fetch(at(String(up.body.url)))
    expect(fetched.status).toBe(200)
    expect(await fetched.text()).toBe('uploaded for the node')
    const withFile = await answer(
      await post(at(`/api/session/${encodeURIComponent(K)}/message`), { text: 'see', session: null, files: [upPath] }),
    )
    expect(withFile.status, JSON.stringify(withFile.body)).toBe(200)
    expect(prompts(node.box).at(-1)?.[3]).toBe(`see\n\nFile:\n${upPath}`)

    // A schedule entry of the node's session, cancelled from the master: gone on the node.
    const nodeEntry = entry(node.box, { id: 'a1b2c3', key: 'pane-p', text: 'later', next: Date.now() + 3_600_000 })
    await boardWhen(master.url, b => b.schedules.some(e => e.id === '@server-1:a1b2c3'))
    const cancelled = await answer(await post(at('/api/schedule'), { id: '@server-1:a1b2c3', op: 'cancel' }))
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(existsSync(nodeEntry)).toBe(false)

    // A reminder the master holds for the node's card goes through the node into its pane.
    const held = entry(master.box, { id: 'd1d2d3', key: K, text: 'from the master', next: Date.now() - 1000 })
    await until(() => prompts(node.box).some(c => c[3]?.includes('from the master')), 10_000)
    await until(() => !existsSync(held), 5000)
    expect(prompts(master.box)).toEqual([])

    // The tunnel: its refusals first, the node never asked; what it lets through reaches the node.
    const caddy = viaCaddy(`http://127.0.0.1:${tunnelPort}`, `${LOGIN_COOKIE}=${LOGIN}`)
    await until(async () => (await caddy.get('/api/hello').catch(() => null))?.status === 200, 10_000)
    const seen = node.proxy.requests.length
    for (const [path, body] of [
      [`/api/term/${encodeURIComponent(K)}/shell/focus`, {}],
      ['/api/fs/open', { key: K, path: file }],
      ['/api/reveal', { key: K }],
    ] as const) {
      const r = await caddy.post(path, body)
      expect([path, r.status, ((await r.json()) as { error?: string }).error]).toEqual([path, 403, 'desktop'])
    }
    expect(askedSince(node.proxy.requests, seen)).toEqual([])
    const away = await caddy.post(`/api/session/${encodeURIComponent(K)}/message`, {
      text: 'from the phone',
      session: null,
    })
    expect(away.status, await away.clone().text()).toBe(200)
    expect(prompts(node.box).at(-1)?.slice(2)).toEqual(['p', 'from the phone'])

    const route = routeTable(master.proc)
    expect(route[0]).toEqual({ method: 'ANY', path: '^\\/' })
    const plainBox = await sandbox()
    const plainBoard = await serveBoard(plainBox, { language: 'en' }, { ...PAIR_ENV, TEST_ROUTE_TABLE: '1' })
    // Without `nodes`: the board's own table, which the master's is with the proxy put first.
    expect(routeTable(plainBoard.proc)).toEqual(route.slice(1))
    plainBoard.proc.kill()

    // The bulk routes: this computer's sessions here, the node's there, in the order asked.
    // Sleep: each side answers for its own targets, in the order asked, the node's under the keys asked.
    const slept = await answer(await post(at('/api/sleep'), { targets: [K, 'pane-m', '@server-1:nobody'] }))
    expect(slept.status, JSON.stringify(slept.body)).toBe(200)
    const outcomes = slept.body.results as { target: string; key?: string; result: string; why?: string }[]
    expect(outcomes.map(o => [o.target, o.key ?? null, o.result, o.why ?? null])).toEqual([
      [K, K, 'kept', 'notClaude'],
      ['pane-m', 'pane-m', 'kept', 'notClaude'],
      ['@server-1:nobody', null, 'kept', 'unknown'],
    ])
    const sentSleep = node.proxy.received.filter(r => r.request === 'POST /api/sleep')
    expect(sentSleep.map(r => JSON.parse(r.body).targets)).toEqual([['pane-p', 'nobody']])
    // Move: the node is sent its own keys and the profile by its own id (nodes.devices.<id>.profiles).
    const moved = await answer(await post(at('/api/move'), { targets: [K, 'pane-m'], profile: 'work' }))
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect((moved.body.results as { target: string; result: string }[]).map(o => [o.target, o.result])).toEqual([
      [K, 'refused'],
      ['pane-m', 'refused'],
    ])
    const sentMove = node.proxy.received.filter(r => r.request === 'POST /api/move')
    expect(sentMove.map(r => JSON.parse(r.body))).toEqual([{ targets: ['pane-p'], profile: 'nodework' }])

    // Each side answers for its own (both refuse a session that is not Claude's, and say so), the
    // node's outcome under the key the master asked for.
    const bulkSeen = node.proxy.requests.length
    const archived = await answer(await post(at('/api/archive'), { op: 'archive', keys: [K, 'pane-m'] }))
    expect(archived.status, JSON.stringify(archived.body)).toBe(409)
    expect(
      (archived.body.failed as { key: string; name: string; why: string }[]).map(f => [f.key, f.name, f.why]),
    ).toEqual([
      [K, 'p', 'archive.why.notClaude'],
      ['pane-m', 'm', 'archive.why.notClaude'],
    ])
    expect(askedSince(node.proxy.requests, bulkSeen)).toEqual(['POST /api/archive'])

    // Offline: 503 node-offline, naming the device.
    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state !== 'online', 10_000)
    const off = await answer(
      await post(at(`/api/session/${encodeURIComponent(K)}/message`), { text: 'gone?', session: null }),
    )
    expect([off.status, off.body]).toEqual([503, { error: 'node-offline', device: 'server-1' }])
  }, 90_000)

  test('a secret form writes the node sink; the terminal carries the node screen and ends when the node forgets the master', async () => {
    const value = 'node-Secret-9Qx!"y'
    const sinks = {
      wss: {
        kind: 'file',
        title: 'Web services login',
        path: '~/.wss_netrc',
        format: 'netrc',
        template: 'machine ws.example.com login me password {{token}}\n',
      },
    }
    const claudePane = (box: Sandbox): FakePane => ({
      pane_id: 'c',
      agent: 'claude',
      agent_session: { value: SID },
      agent_status: 'working',
      cwd: box.dir,
    })
    const pair = await nodePair({
      panes: (_id, box) => [codexPane(box, 'p'), claudePane(box)],
      nodeCfg: () => ({ secrets: { sinks } }),
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const master = pair.master
    herdrOf(node.box, [codexPane(node.box, 'p'), claudePane(node.box)])
    const remoteSid = `@server-1:${SID}`
    await boardWhen(master.url, b => keys(b).includes(remoteSid) && keys(b).includes(K))

    // The session on the node asks, as `board secret request` there does (it reads config.json there).
    const confDir = join(node.box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
    mkdirSync(confDir, { recursive: true })
    writeFileSync(join(confDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, secrets: { sinks } }))
    const asked = await node.box.run('cli', {
      args: ['secret', 'request', '--title', 'Node login', '--sink', 'wss', '--field', 'token', '--no-wait'],
      env: { CLAUDE_CODE_SESSION_ID: SID },
    }).exited
    expect(asked.code, `${asked.stdout}${asked.stderr}`).toBe(2)
    const id = /pending · ([0-9a-f]{12}) · wss/.exec(`${asked.stdout}`)?.[1] ?? ''
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    const shown = await boardWhen(master.url, b => !!b.items.find(i => i.key === remoteSid)?.secrets)
    const secrets = shown.items.find(i => i.key === remoteSid)?.secrets as
      | { id: string; fingerprint: string }[]
      | undefined
    const view = secrets?.[0]
    expect(view?.id).toBe(id)
    // The owner answers on the master: the node's board writes its own sink.
    const wrote = await answer(
      await post(`${master.url}/api/secret/${id}`, {
        op: 'submit',
        values: { token: value },
        fingerprint: view?.fingerprint,
      }),
    )
    const nodeHome = node.box.env.HOME as string
    expect([wrote.status, wrote.body]).toEqual([200, { ok: true, target: join(nodeHome, '.wss_netrc') }])
    expect(readFileSync(join(nodeHome, '.wss_netrc'), 'utf8')).toBe(
      `machine ws.example.com login me password ${value}\n`,
    )
    // Nothing of the value on the master: no file, no log line.
    expect(holding(master.box.dir, value)).toEqual([])
    expect(master.proc.messages.map(m => JSON.stringify(m)).join('\n')).not.toContain(value)

    // The terminal: the master's token outside, the node's screen inside.
    const outside = (await board(master.url)).fsToken
    const inside = (await board(node.url)).fsToken
    const streamAt = (t: string): string => `${master.url}/api/term/${encodeURIComponent(K)}/agent/stream?t=${t}`
    expect((await fetch(streamAt(inside))).status).toBe(403)
    const stream = await fetch(streamAt(outside))
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toBe('text/event-stream')
    const reader = stream.body?.getReader()
    if (!reader) throw new Error('no stream')
    const decoder = new TextDecoder()
    let seen = ''
    while (!seen.includes('the node screen')) {
      const next = await reader.read()
      if (next.done) throw new Error(`the stream ended: ${seen}`)
      seen += decoder.decode(next.value, { stream: true })
    }
    expect(node.proxy.requests.some(r => r.startsWith(`GET /api/term/pane-p/agent/stream`))).toBe(true)
    // The node forgets the master, as `board node forget` does: the stream ends.
    const store = createNodeStore({ dir: join(stateFolder(node.box), 'node') })
    const [held] = store.list()
    expect(store.forget(held?.id ?? '')).toBe(true)
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
          if (next.done) return true
        }
      })(),
      Bun.sleep(5000).then(() => false),
    ])
    expect(ended).toBe(true)
    await pair.waitDevice('server-1', d => d.link?.state === 'refused', 10_000)
    const refused = await answer(
      await post(`${master.url}/api/session/${encodeURIComponent(K)}/message`, { text: 'x', session: null }),
    )
    expect([refused.status, refused.body]).toEqual([503, { error: 'node-offline', device: 'server-1' }])
  }, 90_000)

  test('a node whose link is refused for its version answers 503 node-api', async () => {
    // A door that says it is server-1 but speaks another version of the link.
    const asked: string[] = []
    const door = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        asked.push(`${req.method} ${path}`)
        return path === '/api/hello'
          ? Response.json({ board: 'agent-board', node: { api: 99, id: 'server-1' } })
          : Response.json({ error: 'not found' }, { status: 404 })
      },
    })
    onTestFinished(() => void door.stop(true))
    const box = await sandbox()
    createDeviceStore({ dir: join(stateFolder(box), 'nodes') }).setToken('server-1', LOGIN)
    const link = { kind: 'direct', url: `http://127.0.0.1:${door.port}` }
    const { url } = await serveBoard(
      box,
      { language: 'en', nodes: { id: 'laptop', devices: { 'server-1': { link } } } },
      PAIR_ENV,
    )
    await until(async () => {
      const res = await fetch(`${url}/api/nodes`)
      const devices = ((await res.json()) as { devices: { id: string; link: { reason?: string } | null }[] }).devices
      return devices.find(d => d.id === 'server-1')?.link?.reason === 'api'
    }, 10_000)
    const r = await answer(
      await post(`${url}/api/session/${encodeURIComponent('@server-1:s1')}/message`, { text: 'x', session: null }),
    )
    expect([r.status, r.body]).toEqual([503, { error: 'node-api', device: 'server-1' }])
    expect(asked.filter(a => !a.endsWith('/api/hello'))).toEqual([])
  }, 30_000)
})

describe('without nodes', () => {
  test('a key with a device prefix is a session the board does not have, as before', async () => {
    const box = await sandbox()
    herdrOf(box, [codexPane(box, 'm')])
    const { url } = await serveBoard(box, { language: 'en', scheduleTickSec: 0.2 }, PAIR_ENV)
    const r = await answer(
      await post(`${url}/api/session/${encodeURIComponent(K)}/message`, { text: 'x', session: null }),
    )
    expect(r.status).toBe(404)
    expect((await post(`${url}/api/fs/open`, { key: K, path: box.dir })).status).not.toBe(403)
    const due = entry(box, { id: 'e1e2e3', key: K, text: 'nobody', next: Date.now() - 1000 })
    const written = readFileSync(due, 'utf8')
    await until(() => readFileSync(due, 'utf8') !== written, 10_000)
    expect(JSON.parse(readFileSync(due, 'utf8')).why).toBe('gone')
    expect(prompts(box)).toEqual([])
  }, 30_000)
})
