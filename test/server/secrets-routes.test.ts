// Settings → Secrets… on the board's server (server/routes/secrets.ts): the list never has a value,
// a set seals it, a refusal says why without it; on the local page of a PC, and on the board's own
// server through its domain's login; refused through a PC's tunnel in every spelling. No value in
// an answer, a log line or a file of the board but the sealed store.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import { board, startOwnServer, viaSocket } from '../support/own-server.ts'
import type { Child, Sandbox } from '../support/sandbox.ts'
import { seedAccess, startTunnelBoard, stateFolder, viaCaddy } from '../support/tunnel-board.ts'

const TOKEN = 'd'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`
const MARKER = 's3cr3t-MARKER-значение'
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}
const logLines = (proc: Child): string =>
  proc.messages
    .flatMap(m => (m && typeof m === 'object' && 'log' in m ? [String((m as { log: unknown }).log)] : []))
    .join('\n')
function filesText(dir: string): string {
  if (!existsSync(dir)) return ''
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => readFileSync(join(e.parentPath, e.name), 'utf8'))
    .join('\n')
}

describe("the board's own server: the secrets through the domain's login", () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let proc: Child
  let me: ReturnType<typeof viaSocket>
  let stranger: ReturnType<typeof viaSocket>

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    let socket = ''
    ;({ socket, proc } = await startOwnServer(box, {
      profiles: [{ id: 'work', title: 'Work', dir: join(box.env.HOME as string, '.claude-work'), color: 'pink' }],
    }))
    me = viaSocket(socket, COOKIE)
    stranger = viaSocket(socket)
  }, 30_000)

  test('without a login: 401, nothing set', async () => {
    expect(await answer(stranger.get('/api/secrets'))).toEqual([401, { error: 'login' }])
    expect((await stranger.post('/api/secrets', { op: 'set', name: 'A', scope: 'global', value: MARKER })).status).toBe(
      401,
    )
    expect(existsSync(join(stateFolder(box), 'secrets'))).toBe(false)
  })

  test('set, list, replace, remove: never a value back; refusals say why without it', async () => {
    expect(await answer(me.get('/api/secrets'))).toEqual([200, { secrets: [] }])
    const set = await me.post('/api/secrets', {
      op: 'set',
      name: 'TOGGL_API_TOKEN',
      scope: 'global',
      target: null,
      value: MARKER,
    })
    const [status, body] = await answer(set)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, secret: { id: 'global::TOGGL_API_TOKEN', scope: 'global', target: null } })
    expect(JSON.stringify(body)).not.toContain(MARKER)
    const forSession = await me.post('/api/secrets', {
      op: 'set',
      name: 'SLACK_BOT_TOKEN',
      scope: 'session',
      target: SID,
      targetName: 'Slack bot',
      value: `${MARKER}-2`,
    })
    expect(forSession.status).toBe(200)
    const list = await answer(me.get('/api/secrets'))
    expect(list).toEqual([
      200,
      {
        secrets: [
          {
            id: `session:${SID}:SLACK_BOT_TOKEN`,
            name: 'SLACK_BOT_TOKEN',
            scope: 'session',
            target: SID,
            targetName: 'Slack bot',
            setAt: expect.any(Number),
          },
          {
            id: 'global::TOGGL_API_TOKEN',
            name: 'TOGGL_API_TOKEN',
            scope: 'global',
            target: null,
            setAt: expect.any(Number),
          },
        ],
      },
    ])
    for (const bad of [
      { op: 'set', name: '1BAD', scope: 'global', value: MARKER },
      { op: 'set', name: 'PATH', scope: 'global', value: MARKER },
      { op: 'set', name: 'A', scope: 'global', value: '' },
      { op: 'set', name: 'A', scope: 'profile', target: 'nope', value: MARKER },
      { op: 'set', name: 'A', scope: 'session', target: 'not-a-session', value: MARKER },
      { op: 'rm', id: 'global::NOPE' },
      { op: 'what' },
    ]) {
      const [code, refused] = await answer(me.post('/api/secrets', bad))
      expect([bad, code]).toEqual([bad, 409])
      expect(refused).toEqual({ ok: false, error: expect.any(String) })
      expect(JSON.stringify(refused)).not.toContain(MARKER)
    }
    expect(
      (await me.post('/api/secrets', { op: 'set', name: 'W', scope: 'profile', target: 'work', value: 'w' })).status,
    ).toBe(200)
    expect(await answer(me.post('/api/secrets', { op: 'rm', id: 'profile:work:W' }))).toEqual([200, { ok: true }])
    // The board command lists them too, without a value.
    const listed = await board(box, ['secret', 'list'])
    expect(listed.stdout).toContain('TOGGL_API_TOKEN · global · set ')
    expect(listed.stdout).toContain('SLACK_BOT_TOKEN · session Slack bot · set ')
    expect(listed.stdout).not.toContain(MARKER)
    // In no log line, in no file but sealed.
    expect(logLines(proc)).not.toContain(MARKER)
    expect(filesText(stateFolder(box))).not.toContain(MARKER)
    expect(filesText(box.env.APPDATA as string)).not.toContain(MARKER)
  })

  test("a POST without the domain's Origin or the header is refused", async () => {
    const body = { op: 'set', name: 'B', scope: 'global', value: MARKER }
    expect((await me.post('/api/secrets', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await me.post('/api/secrets', body, { 'x-board': '' })).status).toBe(403)
  })
})

describe('a board on a PC: the local page only', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let tunnel = ''
  let proc: Child

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    ;({ url, tunnel, proc } = await startTunnelBoard(box))
  }, 30_000)

  test('the local page sets and lists; a POST without the header or from another site is refused', async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/api/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
        body: JSON.stringify(body),
      })
    const body = { op: 'set', name: 'A', scope: 'global', value: MARKER }
    expect((await post(body, { 'x-board': '' })).status).toBe(403)
    expect((await post(body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(body)).status).toBe(200)
    const list = await (await fetch(`${url}/api/secrets`)).text()
    expect(list).toContain('"global::A"')
    expect(list).not.toContain(MARKER)
    expect(logLines(proc)).not.toContain(MARKER)
  })

  test("through the PC's tunnel, signed in: refused in every spelling", async () => {
    const mine = viaCaddy(tunnel, COOKIE)
    expect((await mine.get('/api/board')).status).toBe(200)
    for (const path of ['/api/secrets', '/api/%73ecrets', '/api/secrets/', '/api/./secrets']) {
      expect([path, ...(await answer(mine.get(path)))]).toEqual([path, 403, { error: 'local' }])
      expect([path, ...(await answer(mine.post(path, { op: 'rm', id: 'global::A' })))]).toEqual([
        path,
        403,
        { error: 'local' },
      ])
    }
    // Still there: nothing went through.
    expect(await (await fetch(`${url}/api/secrets`)).text()).toContain('"global::A"')
  })
})

describe('a board with no secret set', () => {
  const shared = sharedSandbox()
  test('the list is empty and nothing is made by asking', async () => {
    const box = await shared()
    const { url } = await serveBoard(box, { language: 'en' })
    expect(await answer(fetch(`${url}/api/secrets`))).toEqual([200, { secrets: [] }])
    expect(existsSync(join(stateFolder(box), 'secrets'))).toBe(false)
  })
})
