// The board's own files through the tunnel (server/tunnel.ts, adapters/own-files.ts): with a login,
// the routes that read by a path the request names refuse the state folder, the config folder and
// the tunnel key's folder, but for the state folder's uploads; the web board on 127.0.0.1 reads them
// as before. Files planted there hold a marker, and no route in the table gives it away.
import { beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopOnly } from '../../src/core/remote.ts'
import { sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'
import {
  CALLER,
  DOMAIN,
  ORIGIN,
  routeTable,
  SAMPLES,
  seedAccess,
  startTunnelBoard,
  stateFolder,
  viaCaddy,
} from '../support/tunnel-board.ts'

const COOKIE = '__Host-board-login'
const SEEDED = 'S'.repeat(43)
const OWN = 'This file is the board’s own: it is not shown through the domain'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** A route's raw path from the table: the page's for `^`, its sample for another RegExp. */
const rawOf = (path: string): string => (path.startsWith('^') ? (path === '^' ? '/' : (SAMPLES[path] as string)) : path)

/** An answer's headers and body as text; an event stream is read for at most `ms`. */
async function textOf(res: Response, ms = 1000): Promise<string> {
  let text = [...res.headers].map(([name, value]) => `${name}: ${value}\n`).join('')
  if (!res.body) return text
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Bun.sleep(ms).then(() => null)
  for (;;) {
    const next = await Promise.race([reader.read(), deadline])
    if (next === null) {
      await reader.cancel()
      return text
    }
    if (next.done) return text + decoder.decode()
    text += decoder.decode(next.value, { stream: true })
  }
}

type Send = (method: string, path: string, body?: unknown) => Promise<Response>

describe('the board’s own files through the tunnel', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let tunnel = ''
  let state = ''
  let proc: Awaited<ReturnType<typeof startTunnelBoard>>['proc']
  let me: ReturnType<typeof viaCaddy>
  let fsToken = ''
  // In no path the board names: only the planted files hold it.
  const MARKER = `MARKER-${randomBytes(12).toString('hex')}`
  /** The planted files: the state folder's (a text and a picture), the config folder's, the key folder's. */
  const marked: string[] = []
  /** A file of the owner's, outside the board's folders. */
  let note = ''

  /** On the web board on 127.0.0.1, as its page sends them. */
  const local: Send = (method, path, body) =>
    fetch(
      url + path,
      method === 'GET'
        ? {}
        : { method, headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) },
    )
  /** Through the tunnel with a login. */
  const remote: Send = (method, path, body) => (method === 'GET' ? me.get(path) : me.post(path, body))
  const raw = (send: Send, path: string) => send('GET', `/api/fs/raw?path=${encodeURIComponent(path)}&t=${fsToken}`)

  /**
   * Every route in the table, each method, once per planted file: its path as `path` and `paths`
   * and the state folder as `cwd`, in the query and, for a POST, in the body. What acts on this
   * computer's screen is left out (the tunnel refuses it; here it would open the file on the
   * desktop). The requests made, and those whose answer holds the marker.
   */
  async function sweep(send: Send): Promise<{ count: number; holding: string[] }> {
    let count = 0
    const holding: string[] = []
    for (const r of routeTable(proc)) {
      const path = rawOf(r.path)
      if (desktopOnly(path)) continue
      for (const method of r.method === 'ANY' ? ['GET', 'POST'] : [r.method])
        for (const m of marked) {
          const query = `?path=${encodeURIComponent(m)}&paths=${encodeURIComponent(m)}&cwd=${encodeURIComponent(state)}&t=${fsToken}`
          const res = await send(method, path + query, { path: m, paths: [m], cwd: state, url: m })
          count++
          if ((await textOf(res)).includes(MARKER)) holding.push(`${method} ${path} ${m}`)
        }
    }
    return { count, holding }
  }

  beforeAll(async () => {
    box = await shared()
    state = stateFolder(box)
    const config = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
    const keys = join(box.env.HOME as string, 'keys')
    for (const dir of [state, config, keys]) mkdirSync(dir, { recursive: true })
    marked.push(
      join(state, 'marker.txt'),
      join(state, 'marker.png'),
      join(config, 'marker.txt'),
      join(keys, 'marker.txt'),
    )
    for (const file of marked) writeFileSync(file, file.endsWith('.png') ? Buffer.from(MARKER) : `${MARKER}\n`)
    note = join(box.dir, 'note.txt')
    writeFileSync(note, 'hello')
    // s1 works in the state folder, s2 in a folder of the owner's.
    const pane = (id: string, cwd: string) => ({
      pane_id: `p-${id}`,
      agent: 'claude',
      agent_session: { value: id },
      agent_status: 'idle',
      cwd,
    })
    const panes = [pane('s1', state), pane('s2', box.dir)]
    box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
    await seedAccess(box, { logins: [{ token: SEEDED }] })
    ;({ url, tunnel, proc } = await startTunnelBoard(
      box,
      { tunnel: { key: join(keys, 'k') } },
      { TEST_ROUTE_TABLE: '1' },
    ))
    me = viaCaddy(tunnel, `${COOKIE}=${SEEDED}`)
    const board = await me.get('/api/board')
    expect(board.status).toBe(200)
    fsToken = ((await board.json()) as { fsToken: string }).fsToken
    expect(fsToken).toBeTruthy()
  }, 30_000)

  test('previews, quick looks and folder listings refuse the state, config and key folders, in any spelling', async () => {
    for (const m of marked)
      expect([m, ...(await answer(remote('POST', '/api/fs/preview', { path: m })))]).toEqual([m, 403, { error: OWN }])
    // A path relative to a folder of the board's own.
    expect(await answer(remote('POST', '/api/fs/preview', { path: 'marker.txt', cwd: state }))).toEqual([
      403,
      { error: OWN },
    ])
    for (const path of ['/api/fs/%70review', '/api/fs/pr%65view'])
      expect([path, ...(await answer(remote('POST', path, { path: marked[0] })))]).toEqual([path, 403, { error: OWN }])
    for (const path of ['/api/fs/raw', '/api/fs/%72aw', '/api/fs/download', '/api/fs/d%6Fwnload']) {
      const res = await remote('GET', `${path}?path=${encodeURIComponent(marked[1] as string)}&t=${fsToken}`)
      expect([path, ...(await answer(res))]).toEqual([path, 403, { error: OWN }])
    }
    for (const path of ['/api/fs/dirs', '/api/fs/%64irs']) {
      expect([path, ...(await answer(remote('POST', path, { path: state })))]).toEqual([path, 403, { error: OWN }])
      expect([path, ...(await answer(remote('POST', path, { path: join(state, 'cards') })))]).toEqual([
        path,
        403,
        { error: OWN },
      ])
    }
    // What is not the board's own reads as before.
    const preview = await remote('POST', '/api/fs/preview', { path: note })
    expect(await preview.json()).toMatchObject({ text: 'hello' })
    expect((await remote('POST', '/api/fs/dirs', { path: box.dir })).status).toBe(200)
    expect((await remote('POST', '/api/fs/dirs', { path: '' })).status).toBe(200)
  })

  test('stat describes them as missing; the changes of a card working in them are refused', async () => {
    for (const path of ['/api/fs/stat', '/api/fs/%73tat']) {
      const res = await remote('POST', path, { paths: [marked[0], 'marker.png', note], cwd: state })
      expect([path, res.status]).toEqual([path, 200])
      expect(await res.json()).toEqual({
        items: [
          { raw: marked[0], line: null, path: marked[0], name: 'marker.txt', exists: false },
          { raw: 'marker.png', line: null, path: marked[1], name: 'marker.png', exists: false },
          expect.objectContaining({ raw: note, path: note, exists: true }),
        ],
      })
    }
    expect(await answer(remote('GET', '/api/session/s1/changes'))).toEqual([403, { error: OWN }])
    // Spelled another way it is no route of the session's.
    expect((await remote('GET', '/api/session/s1/%63hanges')).status).toBe(404)
    expect(await answer(remote('GET', '/api/session/s2/changes'))).toEqual([200, { available: false }])
  })

  test('an upload stays readable: its URL, its quick look and its preview', async () => {
    const up = await fetch(`${tunnel}/api/upload`, {
      method: 'POST',
      headers: {
        host: DOMAIN,
        'x-forwarded-proto': 'https',
        'x-forwarded-for': CALLER,
        cookie: `${COOKIE}=${SEEDED}`,
        'x-board': '1',
        origin: ORIGIN,
        'x-filename': 'pic.png',
      },
      body: PNG,
    })
    expect(up.status).toBe(200)
    const sent = (await up.json()) as { path: string; url: string }
    expect(sent.path.startsWith(join(state, 'uploads'))).toBe(true)
    const file = await remote('GET', sent.url)
    expect(file.status).toBe(200)
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG)
    const bytes = await raw(remote, sent.path)
    expect(bytes.status).toBe(200)
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(PNG)
    const preview = await remote('POST', '/api/fs/preview', { path: sent.path })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ path: sent.path, exists: true, kind: 'image' })
  })

  test('the web board on 127.0.0.1 shows them as before: the check is the tunnel’s only', async () => {
    for (const m of marked) {
      const res = await local('POST', '/api/fs/preview', { path: m })
      expect([m, res.status]).toEqual([m, 200])
      if (!m.endsWith('.png')) expect(((await res.json()) as { text: string }).text).toContain(MARKER)
      else await res.body?.cancel()
    }
    const bytes = await raw(local, marked[1] as string)
    expect(bytes.status).toBe(200)
    expect(await bytes.text()).toBe(MARKER)
    const stat = await local('POST', '/api/fs/stat', { paths: [marked[0]] })
    expect(await stat.json()).toMatchObject({ items: [{ path: marked[0], exists: true }] })
    expect((await local('POST', '/api/fs/dirs', { path: state })).status).toBe(200)
  })

  test('no route gives the board’s own files away', async () => {
    // The same requests on the web board first: there the marker comes back, so the sweep can see it.
    const before = await sweep(local)
    expect(before.holding).toEqual(
      expect.arrayContaining([`POST /api/fs/preview ${marked[0]}`, `GET /api/fs/raw ${marked[1]}`]),
    )
    const after = await sweep(remote)
    expect(after.count).toBe(before.count)
    expect(after.holding).toEqual([])
    // The sessions were there all along: a card's routes were the card's.
    expect(await answer(remote('GET', '/api/session/s1/changes'))).toEqual([403, { error: OWN }])
  }, 120_000)
})
