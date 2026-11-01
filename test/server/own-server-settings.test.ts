// Settings → Backup… and Settings → Time tracking… on the board's own server (server/streams.ts
// remoteRefusal's `ownServer`): through the domain's login that page is the owner's own, so their
// routes answer there, writes too, as the secrets do; Remote access, the remote mode, wake and the
// edge log stay the PC's. A PC's tunnel, signed in, and a phone through Tailscale refuse them as
// before, in every spelling, and change nothing.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { sharedSandbox } from '../support/board-server.ts'
import { configPath, startOwnServer, viaSocket, writeConfig } from '../support/own-server.ts'
import type { Sandbox } from '../support/sandbox.ts'
import { seedAccess, startTunnelBoard, viaCaddy } from '../support/tunnel-board.ts'

const TOKEN = 'e'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`
const PASSPHRASE = 'correct horse battery'
const TIME = { zone: 'America/New_York', clients: { 'client-a': { projects: ['Support'] } } }
const CATEGORIES = [
  { id: 'client-a', title: 'Client A', color: 'blue' },
  { id: 'other', title: 'Other', color: 'gray' },
]

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}
const refusedAs = (res: Response | null) => (res ? res.status : null)
const fileOf = (box: Sandbox): Record<string, unknown> =>
  existsSync(configPath(box)) ? (JSON.parse(readFileSync(configPath(box), 'utf8')) as Record<string, unknown>) : {}

/** Backup… and Time tracking…'s routes, in the spellings a caller could send (raw, decoded). */
const SPELLINGS: [string, string][] = [
  ['/api/backup', '/api/backup'],
  ['/api/%62ackup', '/api/backup'],
  ['/api/time-settings', '/api/time-settings'],
  ['/api/time-%73ettings', '/api/time-settings'],
]
/** What stays for the board on a PC, its own server too: Remote access, the remote mode, wake, the edge log. */
const PC_ONLY: [string, string][] = [
  ['/api/access', '/api/access'],
  ['/api/%61ccess', '/api/access'],
  ['/api/remote', '/api/remote'],
  ['/api/wake', '/api/wake'],
  ['/api/links/log', '/api/links/log'],
  ['/api/backup/..%2Faccess', '/api/backup/../access'],
  ['/api/backup%2F..%2Faccess', '/api/backup/../access'],
]

describe('remoteRefusal', () => {
  test("the board's own server's login: Backup… and Time tracking… by, in either spelling; what is a PC's still refused", () => {
    for (const [raw, path] of SPELLINGS)
      expect([raw, remoteRefusal(raw, path, { ownServer: true })]).toEqual([raw, null])
    for (const [raw, path] of PC_ONLY)
      expect([raw, refusedAs(remoteRefusal(raw, path, { ownServer: true }))]).toEqual([raw, 403])
    // The secrets as before on the board's own server, and its screen stays its own.
    expect(remoteRefusal('/api/secrets', '/api/secrets', { ownServer: true })).toBeNull()
    expect(refusedAs(remoteRefusal('/api/fs/open', '/api/fs/open', { ownServer: true }))).toBe(403)
  })

  test("a phone, a desk, a PC's tunnel: Backup…, Time tracking… and the secrets refused as on main", async () => {
    for (const options of [undefined, {}, { desk: true }, { desk: false, ownServer: false }])
      for (const [raw, path] of [...SPELLINGS, ['/api/secrets', '/api/secrets'] as [string, string]]) {
        const res = remoteRefusal(raw, path, options)
        expect([raw, options, res?.status, await res?.json()]).toEqual([raw, options, 403, { error: 'local' }])
      }
  })
})

describe("the board's own server: Backup… and Time tracking… through the domain's login", () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let me: ReturnType<typeof viaSocket>
  let stranger: ReturnType<typeof viaSocket>

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    let socket = ''
    ;({ socket } = await startOwnServer(box, { categories: CATEGORIES, time: TIME }))
    me = viaSocket(socket, COOKIE)
    stranger = viaSocket(socket)
  }, 30_000)

  test('without a login: 401, nothing changed', async () => {
    for (const path of ['/api/backup', '/api/time-settings']) {
      expect([path, ...(await answer(stranger.get(path)))]).toEqual([path, 401, { error: 'login' }])
      expect((await stranger.post(path, { op: 'zone', zone: 'Europe/Berlin' })).status).toBe(401)
    }
    expect(
      (await stranger.post('/api/backup', { op: 'passphrase', passphrase: PASSPHRASE, again: PASSPHRASE })).status,
    ).toBe(401)
    expect(fileOf(box).backup).toBeUndefined()
    expect((fileOf(box).time as { zone: string }).zone).toBe('America/New_York')
  })

  test('signed in: the backup’s view, its passphrase and a folder on the server; in either spelling', async () => {
    const [status, view] = await answer(me.get('/api/backup'))
    expect(status).toBe(200)
    expect(view).toMatchObject({ problems: [] })
    expect((await me.get('/api/%62ackup')).status).toBe(200)
    const set = await answer(me.post('/api/backup', { op: 'passphrase', passphrase: PASSPHRASE, again: PASSPHRASE }))
    expect(set[0]).toBe(200)
    expect(set[1]).toMatchObject({ ok: true })
    const folder = join(box.dir, 'backups')
    mkdirSync(folder)
    const [code, done] = await answer(me.post('/api/backup', { op: 'folder', folder }))
    expect([code, (done as { view: { config: { folder: string } } }).view.config.folder]).toEqual([200, folder])
    expect(fileOf(box).backup).toMatchObject({ folder })
    // a folder that is not there is refused with its reason, as on the local page
    const [missing, why] = await answer(me.post('/api/backup', { op: 'folder', folder: join(box.dir, 'nowhere') }))
    expect([missing, (why as { error: string }).error]).toEqual([400, expect.stringContaining('There is no folder')])
  })

  test('signed in: Time tracking’s view and a change written to config.json', async () => {
    const [status, view] = await answer(me.get('/api/time-settings'))
    expect(status).toBe(200)
    expect(view).toMatchObject({ on: true, zone: 'America/New_York' })
    expect((await me.get('/api/time-%73ettings')).status).toBe(200)
    const [code, done] = await answer(me.post('/api/time-settings', { op: 'zone', zone: 'Europe/Berlin' }))
    expect([
      code,
      (done as { ok: boolean; view: { zone: string } }).ok,
      (done as { view: { zone: string } }).view.zone,
    ]).toEqual([200, true, 'Europe/Berlin'])
    expect((fileOf(box).time as { zone: string }).zone).toBe('Europe/Berlin')
  })

  test("a POST without the domain's Origin or the board's header is refused", async () => {
    for (const path of ['/api/backup', '/api/time-settings']) {
      const body = { op: 'zone', zone: 'Asia/Tokyo' }
      expect((await me.post(path, body, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await me.post(path, body, { 'x-board': '' })).status).toBe(403)
    }
    expect((fileOf(box).time as { zone: string }).zone).not.toBe('Asia/Tokyo')
  })

  test('Remote access, the remote mode, wake and the edge log stay the PC’s', async () => {
    for (const path of ['/api/access', '/api/%61ccess', '/api/remote', '/api/wake', '/api/links/log'])
      expect([path, ...(await answer(me.get(path)))]).toEqual([path, 403, { error: 'local' }])
  })
})

describe('a board on a PC: through its tunnel, signed in, as on main', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let tunnel = ''

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    // config.json as the board has it: what the panels read and change
    writeConfig(box, { categories: CATEGORIES, time: TIME })
    ;({ url, tunnel } = await startTunnelBoard(box, { categories: CATEGORIES, time: TIME }))
  }, 30_000)

  test('Backup… and Time tracking… refused in every spelling, reading and changing; nothing changed', async () => {
    const mine = viaCaddy(tunnel, COOKIE)
    expect((await mine.get('/api/board')).status).toBe(200)
    const folder = join(box.dir, 'backups')
    mkdirSync(folder)
    for (const path of [
      '/api/backup',
      '/api/%62ackup',
      '/api/backup/',
      '/api/./backup',
      '/api/time-settings',
      '/api/time-%73ettings',
      '/api/time-settings/',
    ]) {
      expect([path, ...(await answer(mine.get(path)))]).toEqual([path, 403, { error: 'local' }])
      for (const body of [
        { op: 'passphrase', passphrase: PASSPHRASE, again: PASSPHRASE },
        { op: 'folder', folder },
        { op: 'zone', zone: 'Europe/Berlin' },
      ])
        expect([path, ...(await answer(mine.post(path, body)))]).toEqual([path, 403, { error: 'local' }])
    }
    // The local page as before: its own view, nothing set through the tunnel.
    const view = (await (await fetch(`${url}/api/backup`)).json()) as { key: unknown; config: { folder: unknown } }
    expect([view.key ?? null, view.config.folder ?? null]).toEqual([null, null])
    expect(fileOf(box).backup).toBeUndefined()
    const time = (await (await fetch(`${url}/api/time-settings`)).json()) as { zone: string }
    expect(time.zone).toBe('America/New_York')
  })
})
