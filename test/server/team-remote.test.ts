// The peer network through the remote mode (#231, #355). Without `team` every /api/team route is
// refused on the tailnet listener and on the one `tailscale serve` forwards to, in both spellings.
// With it the owner's own phone (paired from the computer's own Tailscale login) reads the team,
// sends, marks read; what changes who may act (trust, agents, an agent's draft, a click's focus),
// an encoded spelling and a Tailscale user `remote.allow` lets in stay refused. /api/peers is not
// touched. One board per case with both listeners, a phone paired on the tailnet, a browser paired
// through serve, and a friend's browser through serve (as wake-remote.test.ts).
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

const NAME = 'box.tail0.ts.net'
const ORIGIN = `https://${NAME}`
const PHONE_IP = '100.78.86.80'
const FRIEND_IP = '100.78.86.81'

function tailscaleState(box: Sandbox, pwaPort: number): void {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: `${NAME}.`, OS: 'windows', UserID: 1, TailscaleIPs: ['127.0.0.1'], Online: true },
    Peer: {},
    User: { '1': { LoginName: 'me@example.com' } },
    CertDomains: [NAME],
  }
  const whois = {
    Node: { StableID: 'nPhone', ComputedName: 'xiaomi-17', Hostinfo: { OS: 'android' } },
    UserProfile: { LoginName: 'me@example.com' },
  }
  const serving = {
    TCP: { '443': { HTTPS: true } },
    Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${pwaPort}` } } } },
  }
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'status --json': { text: JSON.stringify(status) },
    'whois --json 127.0.0.1': { text: JSON.stringify(whois) },
    [`whois --json ${PHONE_IP}`]: { text: JSON.stringify(whois) },
    [`whois --json ${FRIEND_IP}`]: {
      text: JSON.stringify({
        ...whois,
        Node: { ...whois.Node, StableID: 'nFriend' },
        UserProfile: { LoginName: 'friend@example.com' },
      }),
    },
    'serve status --json': { text: JSON.stringify(serving) },
  })
}

describe.each([
  ['without team', undefined],
  ['with team', { hub: 'ws://127.0.0.1:9' }],
] as const)('the peer network from a phone, %s', (_label, team) => {
  const sandbox = sharedSandbox()
  let box: Sandbox
  let url = ''
  let tailnet = ''
  let web = ''
  let token = ''
  let cookie = ''
  let friendCookie = ''
  const local = (op: string, id: string) =>
    fetch(`${url}/api/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op, id }),
    })
  /** A paired phone on the tailnet listener. */
  const phone = (path: string, init: RequestInit = {}) =>
    fetch(tailnet + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-board': '1', authorization: `Bearer ${token}` },
    })
  /** A paired browser through serve's listener, as serve forwards it. */
  const browser = (path: string, init: RequestInit = {}) =>
    fetch(web + path, {
      ...init,
      headers: {
        host: NAME,
        'x-forwarded-for': PHONE_IP,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': 'me@example.com',
        'content-type': 'application/json',
        'x-board': '1',
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
    })
  /** A browser of a Tailscale user `remote.allow` lets in, through serve: paired, not the owner. */
  const friend = (path: string, init: RequestInit = {}) =>
    fetch(web + path, {
      ...init,
      headers: {
        host: NAME,
        'x-forwarded-for': FRIEND_IP,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': 'friend@example.com',
        'content-type': 'application/json',
        'x-board': '1',
        origin: ORIGIN,
        ...(friendCookie ? { cookie: friendCookie } : {}),
      },
    })
  const teamFiles = (): string[] =>
    readdirSync(box.dir, { recursive: true })
      .map(String)
      .filter(f => f.includes('team-'))
      .sort()
  /** config.json as it is (null: none; this board was handed its config). */
  const configText = (): string | null => {
    const file = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }

  beforeAll(async () => {
    box = await sandbox()
    const remotePort = await unusedPort()
    const pwaPort = await unusedPort()
    tailscaleState(box, pwaPort)
    ;({ url } = await serveBoard(
      box,
      {
        language: 'en',
        remote: { on: true, port: remotePort, pwa: { on: true, port: pwaPort }, allow: ['friend@example.com'] },
        ...(team && { team }),
      },
      { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string },
    ))
    tailnet = `http://127.0.0.1:${remotePort}`
    web = `http://127.0.0.1:${pwaPort}`
    const deadline = Date.now() + 8000
    for (;;) {
      const view = (await (await fetch(`${url}/api/remote`)).json()) as {
        url?: string | null
        pwa?: { url?: string | null }
      }
      const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }
      if (view.url && view.pwa?.url && !board.stale) break
      if (Date.now() > deadline) throw new Error(`remote did not start: ${JSON.stringify(view)}`)
      await Bun.sleep(25)
    }
    // The phone pairs on the tailnet: its token.
    const asked = (await (
      await fetch(`${tailnet}/api/remote/pair`, { method: 'POST', body: JSON.stringify({ name: 'Agent board app' }) })
    ).json()) as { id: string }
    expect((await local('approve', asked.id)).status).toBe(200)
    token = ((await (await fetch(`${tailnet}/api/remote/pair/${asked.id}`)).json()) as { token: string }).token
    // The browser pairs through serve: its cookie.
    const begun = (await (
      await browser('/api/remote/pair', { method: 'POST', body: '{"name":"Board in Chrome"}' })
    ).json()) as {
      id: string
    }
    expect((await local('approve', begun.id)).status).toBe(200)
    const answer = await browser(`/api/remote/pair/${begun.id}`)
    cookie = (answer.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toContain('__Host-board=')
    // The friend pairs through serve too, approved on the computer.
    const theirs = (await (
      await friend('/api/remote/pair', { method: 'POST', body: '{"name":"Friend in Chrome"}' })
    ).json()) as { id: string }
    expect((await local('approve', theirs.id)).status).toBe(200)
    const friendAnswer = await friend(`/api/remote/pair/${theirs.id}`)
    friendCookie = (friendAnswer.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(friendCookie).toContain('__Host-board=')
  }, 30_000)

  /**
   * What the owner's own phone may ask with the team on (#355); everything else under /api/team is
   * refused. `/api/./team` is `/api/team` by the time it leaves fetch.
   */
  const ownerMay = (path: string): boolean =>
    !!team && ['/api/team', '/api/./team', '/api/team/thread/x', '/api/team/unread', '/api/team/read'].includes(path)

  test(`/api/team on the tailnet and the serve listener, in both spellings: ${team ? "the owner's list for the owner's phone" : 'every route refused'}`, async () => {
    const before = configText()
    const filesBefore = teamFiles()
    for (const [name, ask] of [
      ['tailnet', phone],
      ['serve', browser],
      ['friend', friend],
    ] as const) {
      expect((await ask('/api/board')).status).toBe(200) // paired: the board itself answers
      for (const path of [
        '/api/team',
        '/api/team/',
        '/api/%74eam/send',
        '/api/team/thread/x',
        '/api/./team',
        '/api/team/unread',
        '/api/team/read',
        '/api/team/trust',
        '/api/team/draft',
        '/api/team/focus',
        '/api/team/agents',
      ])
        for (const init of [{}, { method: 'POST', body: '{"to":"x","text":"hi"}' }, { method: 'POST', body: '{}' }]) {
          const res = await ask(path, init)
          const refused = name === 'friend' || !ownerMay(path)
          const body = await res.json()
          const what = [name, path, init.method ?? 'GET']
          if (refused) expect([...what, res.status, body]).toEqual([...what, 403, { error: 'local' }])
          else expect([...what, res.status]).not.toEqual([...what, 403])
        }
      // /api/peers is what it was: its own answer, not the refusal.
      expect(await (await ask('/api/peers')).json()).toHaveProperty('peers')
    }
    expect(configText()).toBe(before)
    // Nothing of the team was written by asking: without `team` no file at all (with it, the board's
    // own key is there from its start, and no more).
    const files = teamFiles()
    expect(files).toEqual(filesBefore)
    if (!team) expect(files).toEqual([])
  })
})
