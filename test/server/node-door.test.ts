// The master door on a node (server/node-listener.ts, docs/design/nodes 6.1 to 6.3): a sandbox
// board with `node` in its config, a door port of its own, and masters seeded in its own state
// folder. Every route of the board's table is classified for the door; refusals in both spellings
// of a path; the Host, an Origin, tokens and their rate; a master forgotten ends its streams and
// only its. A board with both `node` and `nodes` serves its door. Without `node` nothing listens,
// the board's route table is the same, and the local hello is byte for byte main's.
import { beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createNodeStore } from '../../src/adapters/node-store.ts'
import { doorRefusal, NODE_API } from '../../src/core/node-door.ts'
import { NODE_PORT } from '../../src/core/nodes.ts'
import { REMOTE_API } from '../../src/core/remote.ts'
import { logged, serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { routeTable, stateFolder, type TableRoute } from '../support/tunnel-board.ts'

const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)
const ID_A = 'aaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbb'
const PACE = { BOARD_TEST_PACE: '0.02' }
const VERSION = String((await Bun.file(join(import.meta.dir, '..', '..', 'package.json')).json()).version)

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const nodeFolder = (box: Sandbox): string => join(stateFolder(box), 'node')

/** masters.json in the sandbox's state folder, as `board node token` leaves it. */
function seedMasters(box: Sandbox, masters: { id: string; token: string }[]): void {
  mkdirSync(nodeFolder(box), { recursive: true })
  const list = masters.map(m => ({
    id: m.id,
    name: `master ${m.id.slice(0, 1)}`,
    tokenHash: sha(m.token),
    pairedAt: 1795000000000,
    seenAt: null,
    via: 'hand',
  }))
  writeFileSync(join(nodeFolder(box), 'masters.json'), JSON.stringify(list, null, 2), { mode: 0o600 })
}

/** The pane `s1` in the sandbox's fake herdr. */
function oneSession(box: Sandbox): void {
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
}

/** Requests to the door as a master's link sends them: its own Host, a token, X-Board on writes. */
function viaDoor(port: number, token?: string) {
  const headersOf = (more: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries({
        host: `127.0.0.1:${port}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...more,
      }).filter(([, v]) => v !== ''),
    )
  const base = `http://127.0.0.1:${port}`
  return {
    get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers: headersOf(headers) }),
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: headersOf({ 'content-type': 'application/json', 'x-board': '1', ...headers }),
        body: JSON.stringify(body),
      }),
  }
}

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** A response's status and text; an event stream's content type instead of its text, the stream cancelled. */
async function said(res: Response | Promise<Response>): Promise<[number, string]> {
  const r = await res
  const type = r.headers.get('content-type') ?? ''
  if (!type.startsWith('text/event-stream')) return [r.status, await r.text()]
  await r.body?.cancel()
  return [r.status, type]
}

/** The status line's code of a GET /api/board sent as written, with `Host: <host>` (an empty one too). */
function rawStatus(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(
        `GET /api/board HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${TOKEN_A}\r\nConnection: close\r\n\r\n`,
      ),
    )
    let said = ''
    socket.on('data', chunk => {
      said += chunk.toString('latin1')
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(said)?.[1] ?? 0)))
  })
}

/** Whether anything accepts a connection on 127.0.0.1:`port`. */
async function listens(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(1500) })
    await res.body?.cancel()
    return true
  } catch {
    return false
  }
}

/** What a stream carries from here until it ends; it must end within `ms`. */
async function rest(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 5000): Promise<string> {
  const decoder = new TextDecoder()
  let seen = ''
  const timeout = Bun.sleep(ms).then(() => null)
  for (;;) {
    const next = await Promise.race([reader.read(), timeout])
    if (next === null) throw new Error(`The stream did not end: ${seen}`)
    if (next.done) return seen
    seen += decoder.decode(next.value)
  }
}

/** Whether the stream is still open after `ms`: no end and no `unpaired` in that time. */
async function stillOpen(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<boolean> {
  const decoder = new TextDecoder()
  const deadline = Date.now() + ms
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return true
    const next = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)])
    if (next === null) return true
    if (next.done || decoder.decode(next.value).includes('unpaired')) return false
  }
}

/** main's hello on the local board, byte for byte (server/remote.ts hello, the remote mode off, no Tailscale names). */
const mainHello = (): string =>
  JSON.stringify({
    board: 'agent-board',
    api: REMOTE_API,
    version: VERSION,
    host: hostname(),
    name: null,
    dnsName: null,
    platform: process.platform,
    remote: false,
  })

/**
 * Each route of the board's table (method, and a RegExp route's source), with the paths that stand
 * for it (`x1` is no session, so no action acts) and what the door does with each: door (on the
 * allowlist) or refused (404 there). A route
 * the board gains without an entry here fails the classification test, so it is never reachable
 * through the door, or refused, by accident.
 */
const CLASSIFIED: Record<string, [method: string, raw: string, door: 'door' | 'refused'][]> = {
  'GET /api/setup': [['GET', '/api/setup', 'refused']],
  'GET /api/process': [['GET', '/api/process', 'refused']],
  'GET /api/hello': [['GET', '/api/hello', 'door']],
  'GET /api/remote': [['GET', '/api/remote', 'refused']],
  'POST /api/remote': [['POST', '/api/remote', 'refused']],
  'GET /api/board': [['GET', '/api/board', 'door']],
  'GET /api/events': [['GET', '/api/events', 'door']],
  'POST /api/fs/dirs': [['POST', '/api/fs/dirs', 'door']],
  'POST /api/fs/stat': [['POST', '/api/fs/stat', 'door']],
  'POST /api/fs/preview': [['POST', '/api/fs/preview', 'door']],
  'POST /api/fs/open': [['POST', '/api/fs/open', 'refused']],
  'POST ^\\/api\\/fs\\/': [
    ['POST', '/api/fs/list', 'refused'],
    ['POST', '/api/fs/%6Fpen', 'refused'],
  ],
  'POST /api/open-url': [['POST', '/api/open-url', 'refused']],
  'GET /api/fs/raw': [['GET', '/api/fs/raw', 'door']],
  'GET /api/fs/download': [['GET', '/api/fs/download', 'door']],
  'POST /api/upload': [['POST', '/api/upload', 'door']],
  'GET ^\\/uploads\\/(\\d{4}-\\d{2}-\\d{2})\\/([^/]+)$': [['GET', '/uploads/2026-11-21/a.png', 'door']],
  'POST /api/reveal': [['POST', '/api/reveal', 'refused']],
  'POST /api/settings': [['POST', '/api/settings', 'refused']],
  'POST /api/schedule': [['POST', '/api/schedule', 'door']],
  'POST /api/sleep': [['POST', '/api/sleep', 'door']],
  'POST /api/move': [['POST', '/api/move', 'door']],
  'GET /api/archive': [['GET', '/api/archive', 'refused']],
  'POST /api/archive': [['POST', '/api/archive', 'door']],
  // The archive panel's parked entries (#295): not in 6.2.
  'POST /api/archive/held': [['POST', '/api/archive/held', 'refused']],
  'POST /api/todos': [['POST', '/api/todos', 'door']],
  'POST ^\\/api\\/secret\\/([0-9a-f]{12})$': [['POST', '/api/secret/0123456789ab', 'door']],
  'GET /api/launch/options': [['GET', '/api/launch/options', 'door']],
  'POST /api/launch': [['POST', '/api/launch', 'refused']],
  'POST ^\\/api\\/launch\\/([\\w-]+)\\/dismiss$': [['POST', '/api/launch/l1/dismiss', 'door']],
  'POST ^\\/api\\/launch\\/([\\w-]+)\\/(focus|trust|close)$': [
    ['POST', '/api/launch/l1/trust', 'door'],
    ['POST', '/api/launch/l1/focus', 'refused'],
    ['POST', '/api/launch/l1/close', 'refused'],
  ],
  'POST ^\\/api\\/launch': [['POST', '/api/launch/l1', 'refused']],
  'ANY ^\\/api\\/term\\/': [
    ['GET', '/api/term/x1/agent/stream', 'door'],
    ['GET', '/api/term/x1/shell/stream', 'door'],
    ['POST', '/api/term/x1/agent/input', 'door'],
    ['POST', '/api/term/x1/shell/open', 'door'],
    ['POST', '/api/term/x1/shell/close', 'door'],
    ['POST', '/api/term/x1/shell/focus', 'refused'],
    ['POST', '/api/term/x1/agent/focus', 'refused'],
    ['POST', '/api/term/x1/agent/stream', 'refused'],
  ],
  'ANY ^\\/api\\/session\\/([^/]+)(?:\\/(\\w+))?$': [
    ['GET', '/api/session/x1', 'door'],
    ['POST', '/api/session/x1/wake', 'door'],
    ['POST', '/api/session/x1', 'refused'],
    ['GET', '/api/session/x1/wake', 'refused'],
  ],
  'GET ^\\/api\\/session\\/([^/]+)\\/changes$': [['GET', '/api/session/x1/changes', 'door']],
  'GET ^\\/api\\/session\\/([^/]+)\\/history$': [['GET', '/api/session/x1/history', 'door']],
  'GET ^\\/api\\/session\\/([^/]+)\\/meter$': [['GET', '/api/session/x1/meter', 'door']],
  // Card chat's slash commands (#191): not in 6.2 yet.
  'GET ^\\/api\\/session\\/([^/]+)\\/commands$': [['GET', '/api/session/x1/commands', 'refused']],
  'GET ^\\/api\\/session\\/([^/]+)$': [['GET', '/api/session/x1', 'door']],
  'GET ^\\/api\\/session\\/([^/]+)\\/helper\\/([A-Za-z0-9-]{1,120})$': [
    ['GET', '/api/session/x1/helper/h1', 'refused'],
  ],
  'POST ^\\/api\\/session\\/([^/]+)\\/(answer|permit|archive|workspace|fork|stop|sendnow)$': [
    ['POST', '/api/session/x1/answer', 'door'],
    ['POST', '/api/session/x1/permit', 'door'],
    ['POST', '/api/session/x1/archive', 'door'],
    ['POST', '/api/session/x1/workspace', 'door'],
    ['POST', '/api/session/x1/fork', 'door'],
    ['POST', '/api/session/x1/stop', 'door'],
    ['POST', '/api/session/x1/sendnow', 'door'],
  ],
  'POST ^\\/api\\/session\\/([^/]+)\\/(mokupilot)$': [['POST', '/api/session/x1/mokupilot', 'refused']],
  'POST ^\\/api\\/session\\/([^/]+)\\/aside$': [['POST', '/api/session/x1/aside', 'door']],
  'POST ^\\/api\\/session\\/([^/]+)\\/(focus|wake|sleep|restart|message)$': [
    ['POST', '/api/session/x1/focus', 'refused'],
    ['POST', '/api/session/x1/wake', 'door'],
    ['POST', '/api/session/x1/sleep', 'door'],
    ['POST', '/api/session/x1/restart', 'door'],
    ['POST', '/api/session/x1/message', 'door'],
  ],
  'POST ^\\/api\\/session\\/([^/]+)\\/(\\w+)$': [
    ['POST', '/api/session/x1/rename', 'door'],
    ['POST', '/api/session/x1/card', 'door'],
    ['POST', '/api/session/x1/other', 'refused'],
  ],
  // For the board on this computer only (core/remote.ts localOnly), and the rest of the board's
  // settings and its other features: none is on the allowlist.
  'GET /api/access': [['GET', '/api/access', 'refused']],
  'GET /api/access/server-command': [['GET', '/api/access/server-command', 'refused']],
  'POST /api/access': [['POST', '/api/access', 'refused']],
  'GET /api/links/log': [['GET', '/api/links/log', 'refused']],
  'GET /api/mokupilot': [['GET', '/api/mokupilot', 'refused']],
  'POST /api/mokupilot': [['POST', '/api/mokupilot', 'refused']],
  'GET /api/presence': [['GET', '/api/presence', 'refused']],
  'POST /api/presence': [['POST', '/api/presence', 'refused']],
  'GET /api/team': [['GET', '/api/team', 'refused']],
  'GET ^\\/api\\/team\\/thread\\/([^/]+)$': [['GET', '/api/team/thread/p1', 'refused']],
  'POST /api/team/send': [['POST', '/api/team/send', 'refused']],
  'GET /api/team/threads': [['GET', '/api/team/threads', 'refused']],
  'GET ^\\/api\\/team\\/threads\\/([^/]+)\\/([^/]+)$': [['GET', '/api/team/threads/team/general', 'refused']],
  'POST /api/team/post': [['POST', '/api/team/post', 'refused']],
  'POST ^\\/api\\/team\\/threads\\/([^/]+)\\/([^/]+)\\/(assign|release|mute|unmute)$': [
    ['POST', '/api/team/threads/team/general/mute', 'refused'],
  ],
  'POST /api/team/listen': [['POST', '/api/team/listen', 'refused']],
  'GET /api/team/agents': [['GET', '/api/team/agents', 'refused']],
  'POST /api/team/agents': [['POST', '/api/team/agents', 'refused']],
  'POST /api/team/draft': [['POST', '/api/team/draft', 'refused']],
  'POST ^\\/api\\/team\\/draft\\/([^/]+)\\/(send|discard)$': [['POST', '/api/team/draft/d1/send', 'refused']],
  'POST /api/team/trust': [['POST', '/api/team/trust', 'refused']],
  'POST ^\\/api\\/team\\/threads\\/team\\/([^/]+)\\/members$': [
    ['POST', '/api/team/threads/team/general/members', 'refused'],
  ],
  'GET /api/team/welcome': [['GET', '/api/team/welcome', 'refused']],
  'POST /api/team/welcome': [['POST', '/api/team/welcome', 'refused']],
  'GET /api/team/passkeys': [['GET', '/api/team/passkeys', 'refused']],
  'POST /api/team/passkeys': [['POST', '/api/team/passkeys', 'refused']],
  'GET /api/team/confirm': [['GET', '/api/team/confirm', 'refused']],
  'GET ^\\/api\\/team\\/confirm\\/([^/]+)$': [['GET', '/api/team/confirm/AAAAAAAAAAAAAAAAAAAAAA', 'refused']],
  'POST ^\\/api\\/team\\/confirm\\/([^/]+)$': [['POST', '/api/team/confirm/AAAAAAAAAAAAAAAAAAAAAA', 'refused']],
  'GET /api/team/unread': [['GET', '/api/team/unread', 'refused']],
  'POST /api/team/read': [['POST', '/api/team/read', 'refused']],
  'POST /api/team/focus': [['POST', '/api/team/focus', 'refused']],
  'POST /api/threads-settings': [['POST', '/api/threads-settings', 'refused']],
  'GET /api/threads': [['GET', '/api/threads', 'refused']],
  'GET /api/threads/events': [['GET', '/api/threads/events', 'refused']],
  'GET ^\\/api\\/threads\\/([^/]+)$': [['GET', '/api/threads/atlas-1', 'refused']],
  'POST /api/threads': [['POST', '/api/threads', 'refused']],
  'POST ^\\/api\\/threads\\/([^/]+)$': [['POST', '/api/threads/atlas-1', 'refused']],
  'GET /api/time': [['GET', '/api/time', 'refused']],
  'POST /api/time': [['POST', '/api/time', 'refused']],
  'GET /api/time-settings': [['GET', '/api/time-settings', 'refused']],
  'POST /api/time-settings': [['POST', '/api/time-settings', 'refused']],
  'POST /api/calendar-reminders': [['POST', '/api/calendar-reminders', 'refused']],
  'GET /api/calendar': [['GET', '/api/calendar', 'refused']],
  'POST /api/calendar': [['POST', '/api/calendar', 'refused']],
  'GET /api/calendar-settings': [['GET', '/api/calendar-settings', 'refused']],
  'POST /api/calendar-settings': [['POST', '/api/calendar-settings', 'refused']],
  'GET /api/backup': [['GET', '/api/backup', 'refused']],
  'POST /api/backup': [['POST', '/api/backup', 'refused']],
  'POST /api/log': [['POST', '/api/log', 'refused']],
  'GET /api/wake': [['GET', '/api/wake', 'refused']],
  'POST /api/wake': [['POST', '/api/wake', 'refused']],
  'POST /api/categories': [['POST', '/api/categories', 'refused']],
  'POST /api/profiles': [['POST', '/api/profiles', 'refused']],
  'GET /omarchy-theme.css': [['GET', '/omarchy-theme.css', 'refused']],
  'GET ^': [
    ['GET', '/', 'refused'],
    ['GET', '/app.js', 'refused'],
  ],
}

/** The board's route table, kept from the node board for the board without `node`. */
let nodeTable: TableRoute[] = []

const listening = (proc: Child, port: number): boolean =>
  logged(proc, `node door: listening on 127.0.0.1:${port} as server-1`)

describe('the master door', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let doorPort = 0
  let proc: Child
  let master: ReturnType<typeof viaDoor>

  beforeAll(async () => {
    box = await shared()
    oneSession(box)
    seedMasters(box, [
      { id: ID_A, token: TOKEN_A },
      { id: ID_B, token: TOKEN_B },
    ])
    doorPort = await unusedPort()
    ;({ url, proc } = await serveBoard(
      box,
      { language: 'en', node: { id: 'server-1', port: doorPort, workRoot: box.dir } },
      { TEST_ROUTE_TABLE: '1', ...PACE },
    ))
    nodeTable = routeTable(proc)
    master = viaDoor(doorPort, TOKEN_A)
    await until(() => listening(proc, doorPort))
  }, 30_000)

  test("hello before the token: the board's own hello and node, the local one as it was", async () => {
    const local = await (await fetch(`${url}/api/hello`)).text()
    expect(local).toBe(mainHello())
    const [status, body] = await answer(viaDoor(doorPort).get('/api/hello'))
    expect(status).toBe(200)
    expect(body).toEqual({ ...JSON.parse(local), node: { api: NODE_API, id: 'server-1', claimed: true } })
  })

  test('every route of the board’s table is classified for the door, and the door does what the class says', async () => {
    const keyOf = (r: TableRoute): string => `${r.method} ${r.path}`
    const missing = nodeTable.map(keyOf).filter(k => !(k in CLASSIFIED))
    expect(missing).toEqual([])
    const stale = Object.keys(CLASSIFIED).filter(k => !nodeTable.some(r => keyOf(r) === k))
    expect(stale).toEqual([])
    const NOT_FOUND = JSON.stringify({ error: 'not found' })
    for (const r of nodeTable) {
      for (const [method, raw, door] of CLASSIFIED[keyOf(r)] ?? []) {
        if (r.path.startsWith('^')) expect([raw, new RegExp(r.path).test(raw)]).toEqual([raw, true])
        const refused = doorRefusal(method, raw, decodeURIComponent(raw))
        expect([method, raw, refused === null ? 'door' : 'refused']).toEqual([method, raw, door])
        // Through the door: a refused one is the door's 404. An allowed one reaches the board: a GET
        // answers as the web board answers it (hello aside, which has its own test), a POST is not
        // the door's 404.
        const [status, text] = await said(method === 'GET' ? master.get(raw) : master.post(raw, {}))
        if (door === 'refused') expect([method, raw, status, text]).toEqual([method, raw, 404, NOT_FOUND])
        else if (method === 'POST')
          expect([method, raw, status === 404 && text === NOT_FOUND]).toEqual([method, raw, false])
        else if (raw !== '/api/hello')
          expect([method, raw, status, text]).toEqual([method, raw, ...(await said(fetch(url + raw)))])
      }
    }
  }, 60_000)

  test('through the door: the payload and the card; the refused ones in any spelling', async () => {
    // The node's own payload, its session in it, once the board has read herdr.
    const keys = async (): Promise<string[]> => {
      const res = await master.get('/api/board')
      expect(res.status).toBe(200)
      return ((await res.json()) as { items: { key: string }[] }).items.map(i => i.key)
    }
    let seen: string[] = []
    const deadline = Date.now() + 10_000
    for (;;) {
      seen = await keys()
      if (seen.includes('s1') || Date.now() > deadline) break
      await Bun.sleep(50)
    }
    expect(seen).toContain('s1')
    expect((await master.get('/api/session/s1')).status).toBe(200)
    for (const [method, raw] of [
      ['POST', '/api/fs/%6Fpen'],
      ['GET', '/api/%72emote'],
      ['POST', '/api/fs/open'],
      ['GET', '/api/process'],
      ['POST', '/api/session/s1/focus'],
      ['GET', '/api/access'],
    ] as const) {
      const res = method === 'GET' ? master.get(raw) : master.post(raw, { path: box.dir })
      expect([method, raw, ...(await answer(res))]).toEqual([method, raw, 404, { error: 'not found' }])
    }
    // A path that does not decode.
    expect(await answer(master.get('/api/session/%E0%A4%A/changes'))).toEqual([400, { error: 'path' }])
    // A write without X-Board.
    expect(await answer(master.post('/api/sleep', { keys: [] }, { 'x-board': '' }))).toEqual([403, { error: 'header' }])
  })

  test("GET /api/node/status on the door: the node's facts; the web board has no such route", async () => {
    const [status, body] = await answer(master.get('/api/node/status'))
    expect(status).toBe(200)
    expect(body).toMatchObject({
      api: 1,
      id: 'server-1',
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      sessions: { awake: 1, working: 0, asleep: 0 },
      launches: 0,
      profiles: expect.any(Array),
      agents: expect.any(Array),
    })
    const s = body as { cpus: number; memTotalMb: number; workRootFreeMb: number | null; commit: string; at: number }
    expect(s.cpus).toBeGreaterThan(0)
    expect(s.memTotalMb).toBeGreaterThan(0)
    expect(typeof s.workRootFreeMb).toBe('number')
    expect(typeof s.commit).toBe('string')
    expect(Math.abs(s.at - Date.now())).toBeLessThan(60_000)
    // The web board answers it as any path it has no route for.
    const none = await answer(fetch(`${url}/api/no-such-route`))
    expect(await answer(fetch(`${url}/api/node/status`))).toEqual(none)
  })

  test('the Host must name loopback, any port; a request with an Origin is refused, before the token', async () => {
    // A forward lands on whatever local port is free: a loopback name passes with any port, or none.
    for (const host of [
      `localhost:${doorPort}`,
      `127.0.0.1:${doorPort + 1}`,
      'localhost:50123',
      '127.0.0.1',
      `[::1]:${doorPort}`,
      'LOCALHOST:7',
    ])
      expect([host, (await master.get('/api/board', { host })).status]).toEqual([host, 200])
    // Another name, one that only starts like loopback, or none: a page of another site.
    for (const host of [
      `board.example.com:${doorPort}`,
      `evil.example:${doorPort}`,
      `127.0.0.1.evil.example:${doorPort}`,
      `localhost.evil.example:${doorPort}`,
      `[::2]:${doorPort}`,
    ])
      expect([host, ...(await answer(master.get('/api/board', { host })))]).toEqual([host, 403, { error: 'host' }])
    expect(await rawStatus(doorPort, '')).toBe(403)
    for (const origin of [`http://127.0.0.1:${doorPort}`, 'https://evil.example', 'null']) {
      expect([origin, ...(await answer(master.get('/api/hello', { origin })))]).toEqual([
        origin,
        403,
        { error: 'origin' },
      ])
      expect([origin, ...(await answer(master.get('/api/board', { origin })))]).toEqual([
        origin,
        403,
        { error: 'origin' },
      ])
    }
  })

  test('two masters with a token each both get in; forgetting one ends only its streams, within the paced poll', async () => {
    const a = await master.get('/api/events')
    const b = await viaDoor(doorPort, TOKEN_B).get('/api/events')
    expect([a.status, b.status]).toEqual([200, 200])
    const readA = a.body?.getReader()
    const readB = b.body?.getReader()
    if (!readA || !readB) throw new Error('no stream')
    // Their first payload.
    await readA.read()
    await readB.read()
    // Forgotten as `board node forget` does it, from another process than the board's.
    const at = Date.now()
    expect(createNodeStore({ dir: nodeFolder(box) }).forget(ID_A)).toBe(true)
    const seen = await rest(readA, 3000)
    expect(seen).toContain('event: unpaired')
    expect(Date.now() - at).toBeLessThan(3000)
    expect(await stillOpen(readB, 500)).toBe(true)
    await readB.cancel()
    expect(await answer(master.get('/api/board'))).toEqual([401, { error: 'token' }])
    expect((await viaDoor(doorPort, TOKEN_B).get('/api/board')).status).toBe(200)
    // B is still there: the node is still claimed.
    expect(((await (await viaDoor(doorPort).get('/api/hello')).json()) as { node: unknown }).node).toEqual({
      api: 1,
      id: 'server-1',
      claimed: true,
    })
  })
})

describe('wrong tokens', () => {
  test('no token and wrong tokens: 401, past five a minute 429; the right token still opens', async () => {
    const box = await sandbox()
    seedMasters(box, [{ id: ID_A, token: TOKEN_A }])
    const doorPort = await unusedPort()
    const { proc } = await serveBoard(box, { language: 'en', node: { id: 'server-1', port: doorPort } }, PACE)
    await until(() => listening(proc, doorPort))
    const tries = [
      () => viaDoor(doorPort).get('/api/board'),
      () => viaDoor(doorPort, 'W'.repeat(43)).get('/api/board'),
      () => viaDoor(doorPort).get('/api/board', { authorization: 'Bearer short' }),
      () => viaDoor(doorPort).get('/api/board', { authorization: `Basic ${TOKEN_A}` }),
      () => viaDoor(doorPort, TOKEN_B).get('/api/events'),
    ]
    for (const send of tries) expect(await answer(send())).toEqual([401, { error: 'token' }])
    const limited = await viaDoor(doorPort, 'X'.repeat(43)).get('/api/board')
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'limited' }])
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await viaDoor(doorPort, TOKEN_A).get('/api/board')).status).toBe(200)
    // hello needs no token: it answers whatever the count.
    expect((await viaDoor(doorPort).get('/api/hello')).status).toBe(200)

    // masters.json that does not parse: no master is turned away as a wrong token, and nothing of
    // the file is told before a token checks out.
    writeFileSync(join(nodeFolder(box), 'masters.json'), '{ half')
    expect(await answer(viaDoor(doorPort, TOKEN_A).get('/api/board'))).toEqual([500, { error: 'server' }])
    expect(await answer(viaDoor(doorPort).get('/api/hello'))).toEqual([500, { error: 'server' }])
  }, 30_000)
})

describe('a board with both node and nodes', () => {
  test('starts, serves its door, and its own board as before (21.3)', async () => {
    const box = await sandbox()
    seedMasters(box, [{ id: ID_A, token: TOKEN_A }])
    const doorPort = await unusedPort()
    const { url, proc } = await serveBoard(
      box,
      { language: 'en', nodes: { id: 'laptop' }, node: { id: 'server-1', port: doorPort } },
      PACE,
    )
    await until(() => listening(proc, doorPort))
    expect((await answer(viaDoor(doorPort, TOKEN_A).get('/api/node/status')))[1]).toMatchObject({ id: 'server-1' })
    expect((await fetch(`${url}/api/board`)).status).toBe(200)
    expect(await (await fetch(`${url}/api/hello`)).text()).toBe(mainHello())
  }, 30_000)
})

describe('without node', () => {
  test('nothing listens, nothing is logged, the route table and the local hello are main’s; config.json’s node turns the door on and off live', async () => {
    const box = await sandbox()
    const webPort = await unusedPort()
    let doorPort = await unusedPort()
    while (doorPort === webPort) doorPort = await unusedPort()
    const defaultFree = !(await listens(NODE_PORT))
    const cfg = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      port: webPort,
    }
    // The sandbox's own config.json, never this computer's.
    const configPath = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(configPath, '..'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))
    const { proc } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1', TEST_ROUTE_TABLE: '1', ...PACE })
    const url = `http://127.0.0.1:${webPort}`
    const reloads = (): number => proc.messages.filter(m => (m as { reloaded?: boolean }).reloaded).length

    // The same table, in the same order, as the board with `node`: the door adds no route to it.
    expect(routeTable(proc)).toEqual(nodeTable)
    expect(await (await fetch(`${url}/api/hello`)).text()).toBe(mainHello())
    expect(await listens(doorPort)).toBe(false)
    if (defaultFree) expect(await listens(NODE_PORT)).toBe(false)
    expect(proc.messages.some(m => (m as { log?: string }).log?.includes('node door'))).toBe(false)
    expect(existsSync(nodeFolder(box))).toBe(false)

    // `node` added by hand: the door opens on its port; the local hello stays as it was.
    let before = reloads()
    writeFileSync(configPath, JSON.stringify({ ...cfg, node: { id: 'server-1', port: doorPort } }, null, 2))
    await until(() => reloads() > before)
    await until(() => listening(proc, doorPort))
    expect((await answer(viaDoor(doorPort).get('/api/hello')))[1]).toMatchObject({
      node: { api: 1, id: 'server-1', claimed: false },
    })
    expect(await (await fetch(`${url}/api/hello`)).text()).toBe(mainHello())

    // Another port: the door moves, the old one is free.
    let moved = await unusedPort()
    while (moved === webPort || moved === doorPort) moved = await unusedPort()
    before = reloads()
    writeFileSync(configPath, JSON.stringify({ ...cfg, node: { id: 'server-1', port: moved } }, null, 2))
    await until(() => reloads() > before)
    await until(() => listening(proc, moved))
    expect(await listens(doorPort)).toBe(false)
    expect((await answer(viaDoor(moved).get('/api/hello')))[0]).toBe(200)
    doorPort = moved

    // Taken out again: the port is free.
    before = reloads()
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))
    await until(() => reloads() > before)
    await until(() => logged(proc, 'node door: closed'))
    expect(await listens(doorPort)).toBe(false)
  }, 30_000)
})
