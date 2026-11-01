// Settings → Backup…, Settings → Time tracking… and Settings → Sleep and wake… on the board's own
// server (server/streams.ts remoteRefusal's `ownServer`): through the domain's login that page is
// the owner's own, so their routes answer there, writes too, as the secrets do; Remote access, the
// remote mode and the edge log stay the PC's. A PC's tunnel, signed in, and a phone through
// Tailscale refuse them as before, in every spelling, and change nothing.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { type BoardMessage, sharedSandbox, unusedPort } from '../support/board-server.ts'
import { configPath, startOwnServer, viaSocket, writeConfig } from '../support/own-server.ts'
import type { Child, Sandbox } from '../support/sandbox.ts'
import { seedAccess, startTunnelBoard, viaCaddy } from '../support/tunnel-board.ts'

const TOKEN = 'e'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`
const PASSPHRASE = 'correct horse battery'
/** tg-mcp's url and token in config.json's wake section. */
const TG_URL = 'http://127.0.0.1:8787'
const TG_TOKEN = 'Bearer tg-secret-0123456789'
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
/** Each wake's start the board asked for (the runner's recorder: no real wake starts). */
const starts = (proc: Child): unknown[] =>
  proc.messages.flatMap(m => {
    const started = (m as BoardMessage & { wakeStarted?: unknown }).wakeStarted
    return started ? [started] : []
  })

/** Backup…, Time tracking… and Sleep and wake…'s routes, in the spellings a caller could send (raw, decoded). */
const SPELLINGS: [string, string][] = [
  ['/api/backup', '/api/backup'],
  ['/api/%62ackup', '/api/backup'],
  ['/api/time-settings', '/api/time-settings'],
  ['/api/time-%73ettings', '/api/time-settings'],
  ['/api/wake', '/api/wake'],
  ['/api/wak%65', '/api/wake'],
  ['/api/%77ake', '/api/wake'],
]
/** What stays for the board on a PC, its own server too: Remote access, the remote mode, the edge log; no path under wake's. */
const PC_ONLY: [string, string][] = [
  ['/api/access', '/api/access'],
  ['/api/%61ccess', '/api/access'],
  ['/api/remote', '/api/remote'],
  ['/api/links/log', '/api/links/log'],
  ['/api/backup/..%2Faccess', '/api/backup/../access'],
  ['/api/backup%2F..%2Faccess', '/api/backup/../access'],
  ['/api/wake/x', '/api/wake/x'],
  ['/api/wake/', '/api/wake/'],
  ['/api/wake/..%2Faccess', '/api/wake/../access'],
  ['/api/wake%2F..%2Fremote', '/api/wake/../remote'],
]

describe('remoteRefusal', () => {
  test("the board's own server's login: Backup…, Time tracking… and Sleep and wake… by, in every spelling; what is a PC's still refused", () => {
    for (const [raw, path] of SPELLINGS)
      expect([raw, remoteRefusal(raw, path, { ownServer: true })]).toEqual([raw, null])
    for (const [raw, path] of PC_ONLY)
      expect([raw, refusedAs(remoteRefusal(raw, path, { ownServer: true }))]).toEqual([raw, 403])
    // The secrets as before on the board's own server, and its screen stays its own.
    expect(remoteRefusal('/api/secrets', '/api/secrets', { ownServer: true })).toBeNull()
    expect(refusedAs(remoteRefusal('/api/fs/open', '/api/fs/open', { ownServer: true }))).toBe(403)
  })

  test("a phone, a desk, a PC's tunnel: Backup…, Time tracking…, Sleep and wake… and the secrets refused as on main", async () => {
    for (const options of [undefined, {}, { desk: true }, { desk: false, ownServer: false }])
      for (const [raw, path] of [...SPELLINGS, ['/api/secrets', '/api/secrets'] as [string, string]]) {
        const res = remoteRefusal(raw, path, options)
        expect([raw, options, res?.status, await res?.json()]).toEqual([raw, options, 403, { error: 'local' }])
      }
  })
})

describe("the board's own server: Backup…, Time tracking… and Sleep and wake… through the domain's login", () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let proc: Child
  let me: ReturnType<typeof viaSocket>
  let stranger: ReturnType<typeof viaSocket>
  /** config.json's wake section as the server starts: on, Telegram on Auto with tg-mcp's url and token. */
  let wake: Record<string, unknown> = {}

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    wake = { enabled: true, port: await unusedPort(), telegram: 'auto', url: TG_URL, authorization: TG_TOKEN }
    let socket = ''
    ;({ socket, proc } = await startOwnServer(box, { categories: CATEGORIES, time: TIME, wake }))
    me = viaSocket(socket, COOKIE)
    stranger = viaSocket(socket)
  }, 30_000)

  test('without a login: 401, nothing changed', async () => {
    for (const path of ['/api/backup', '/api/time-settings', '/api/wake']) {
      expect([path, ...(await answer(stranger.get(path)))]).toEqual([path, 401, { error: 'login' }])
      expect((await stranger.post(path, { op: 'zone', zone: 'Europe/Berlin' })).status).toBe(401)
    }
    expect(
      (await stranger.post('/api/backup', { op: 'passphrase', passphrase: PASSPHRASE, again: PASSPHRASE })).status,
    ).toBe(401)
    const started = starts(proc).length
    for (const body of [{ op: 'off' }, { op: 'reaper', enabled: true }, { op: 'again' }, { op: 'log' }])
      expect((await stranger.post('/api/wake', body)).status).toBe(401)
    expect(fileOf(box).backup).toBeUndefined()
    expect((fileOf(box).time as { zone: string }).zone).toBe('America/New_York')
    expect(fileOf(box).wake).toEqual(wake)
    expect(starts(proc).length).toBe(started)
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

  test('signed in: Sleep and wake… as on the PC: its settings, the reaper, Telegram, Start again and Log; in every spelling', async () => {
    const [status, panel] = await answer(me.get('/api/wake'))
    expect(status).toBe(200)
    expect(panel).toMatchObject({
      view: { on: true, port: wake.port },
      settings: {
        reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 },
        telegram: 'auto',
        found: { host: '127.0.0.1:8787' },
      },
    })
    // Telegram's token is never sent to the page: its host only.
    expect(JSON.stringify(panel)).not.toContain('tg-secret')
    for (const path of ['/api/wak%65', '/api/%77ake']) expect([path, (await me.get(path)).status]).toEqual([path, 200])
    // The reaper and Telegram go to config.json's wake section, as the PC's panel writes them.
    const reaper = { op: 'reaper', enabled: true, idleMinutes: 30, exclude: ['build', 'Проект x 50%'] }
    expect(await answer(me.post('/api/wake', reaper))).toEqual([200, { ok: true }])
    expect(await answer(me.post('/api/wake', { op: 'telegram', mode: 'off' }))).toEqual([200, { ok: true }])
    expect(await answer(me.post('/api/wak%65', { op: 'telegram', mode: 'sometimes' }))).toEqual([
      409,
      { ok: false, error: 'Telegram messages (tg-mcp): auto or off' },
    ])
    expect(fileOf(box).wake).toEqual({
      ...wake,
      reaper: { enabled: true, idleMinutes: 30, exclude: ['build', 'Проект x 50%'] },
      telegram: 'off',
    })
    // Start again: wake's start with its pane made anew (the runner's recorder); Start answers.
    const started = starts(proc).length
    expect(await answer(me.post('/api/wake', { op: 'again' }))).toEqual([200, { ok: true }])
    expect(starts(proc).slice(started)).toEqual([['--again']])
    expect((await me.post('/api/wake', { op: 'start' })).status).toBe(200)
    // Log: wake.log's end (none written here).
    expect(await answer(me.post('/api/wake', { op: 'log' }))).toEqual([200, { ok: true, text: '' }])
  })

  test("a POST without the domain's Origin or the board's header is refused", async () => {
    for (const path of ['/api/backup', '/api/time-settings']) {
      const body = { op: 'zone', zone: 'Asia/Tokyo' }
      expect((await me.post(path, body, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await me.post(path, body, { 'x-board': '' })).status).toBe(403)
    }
    expect((fileOf(box).time as { zone: string }).zone).not.toBe('Asia/Tokyo')
    const before = fileOf(box).wake
    const started = starts(proc).length
    for (const body of [{ op: 'reaper', idleMinutes: 5 }, { op: 'off' }, { op: 'again' }]) {
      expect((await me.post('/api/wake', body, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await me.post('/api/wake', body, { 'x-board': '' })).status).toBe(403)
    }
    expect(fileOf(box).wake).toEqual(before)
    expect(starts(proc).length).toBe(started)
  })

  test('Remote access, the remote mode and the edge log stay the PC’s; no path under wake’s', async () => {
    for (const path of ['/api/access', '/api/%61ccess', '/api/remote', '/api/links/log', '/api/wake/x', '/api/wake/'])
      expect([path, ...(await answer(me.get(path)))]).toEqual([path, 403, { error: 'local' }])
  })
})

describe('a board on a PC: through its tunnel, signed in, as on main', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let proc: Child
  let url = ''
  let tunnel = ''

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    // config.json as the board has it: what the panels read and change
    writeConfig(box, { categories: CATEGORIES, time: TIME })
    ;({ url, tunnel, proc } = await startTunnelBoard(box, { categories: CATEGORIES, time: TIME }))
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

  test('Sleep and wake… refused in every spelling, reading, changing, Start and Log; nothing changed, nothing started', async () => {
    const mine = viaCaddy(tunnel, COOKIE)
    const before = fileOf(box).wake
    const started = starts(proc).length
    for (const path of ['/api/wake', '/api/wak%65', '/api/%77ake', '/api/wake/', '/api/./wake', '/api/wake/x']) {
      expect([path, ...(await answer(mine.get(path)))]).toEqual([path, 403, { error: 'local' }])
      for (const body of [
        { op: 'on' },
        { op: 'reaper', enabled: true, idleMinutes: 5 },
        { op: 'telegram', mode: 'auto' },
        { op: 'start' },
        { op: 'again' },
        { op: 'log' },
      ])
        expect([path, body.op, ...(await answer(mine.post(path, body)))]).toEqual([
          path,
          body.op,
          403,
          { error: 'local' },
        ])
    }
    expect(fileOf(box).wake).toEqual(before)
    expect(starts(proc).length).toBe(started)
    // The local page as before.
    expect((await fetch(`${url}/api/wake`)).status).toBe(200)
  })
})
