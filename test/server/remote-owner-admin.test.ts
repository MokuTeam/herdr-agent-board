// Remote access for an owner's own strong login on a headless master (#694).
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Passkey } from '../../src/core/access.ts'
import type { AdminEdge } from '../../src/core/links.ts'
import { verifyRegistration } from '../../src/core/webauthn.ts'
import { hashToken } from '../../src/services/remote.ts'
import { serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'
import { softAuthenticator } from '../support/soft-authenticator.ts'
import {
  CALLER,
  DOMAIN,
  ORIGIN,
  routeTable,
  seedAccess,
  startTunnelBoard,
  USER_ID,
  viaCaddy,
} from '../support/tunnel-board.ts'

const PASSWORD_LOGIN = 'P'.repeat(43)
const PASSKEY_LOGIN = 'K'.repeat(43)
const NAME = 'box.tail0.ts.net'
const TAILNET_ORIGIN = `https://${NAME}`
const OWNER_IP = '100.78.86.80'
const DESK_IP = '100.78.86.81'
const ANNA_IP = '100.78.86.82'
const OWNER_LOGIN = 'me@example.com'
const ANNA_LOGIN = 'anna@example.com'

async function seededPasskey(): Promise<Passkey> {
  const challenge = 'c'.repeat(43)
  const auth = await softAuthenticator(-7)
  const reg = auth.register({ challenge, origin: ORIGIN, rpId: DOMAIN })
  const checked = verifyRegistration(reg.response, { challenge, origin: ORIGIN, rpId: DOMAIN })
  if (!checked.ok) throw new Error(`registration refused: ${checked.why}`)
  const { id, jwk, alg, counter } = checked.credential
  return { id, jwk, alg, counter, transports: ['internal'], label: 'Passkey on Mac', addedAt: Date.now(), usedAt: null }
}

const adminPaths = [
  '/api/access',
  '/api/remote',
  '/api/wake',
  '/api/backup',
  '/api/time-settings',
  '/api/calendar-settings',
  '/api/threads-settings',
  '/api/self-update',
  '/api/housekeeping',
  '/api/process',
  '/api/links/log',
  '/api/nodes/setup',
] as const

const configPath = (box: Sandbox) =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

function seedTailscale(box: Sandbox, pwaPort: number) {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: `${NAME}.`, OS: 'linux', UserID: 1, TailscaleIPs: ['127.0.0.1'], Online: true },
    Peer: {},
    User: { '1': { LoginName: OWNER_LOGIN } },
    CertDomains: [NAME],
  }
  const serve = {
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
    [`whois --json ${OWNER_IP}`]: {
      text: JSON.stringify({
        Node: { StableID: 'nOwner', ComputedName: 'atlas-phone', Hostinfo: { OS: 'iOS' } },
        UserProfile: { LoginName: OWNER_LOGIN },
      }),
    },
    [`whois --json ${DESK_IP}`]: {
      text: JSON.stringify({
        Node: { StableID: 'nDesk', ComputedName: 'ben-desk', Hostinfo: { OS: 'macOS' } },
        UserProfile: { LoginName: OWNER_LOGIN },
      }),
    },
    [`whois --json ${ANNA_IP}`]: {
      text: JSON.stringify({
        Node: { StableID: 'nAnna', ComputedName: 'anna-phone', Hostinfo: { OS: 'android' } },
        UserProfile: { LoginName: ANNA_LOGIN },
      }),
    },
    'whois --json 127.0.0.1': {
      text: JSON.stringify({
        Node: { StableID: 'nOwner', ComputedName: 'atlas-phone', Hostinfo: { OS: 'iOS' } },
        UserProfile: { LoginName: OWNER_LOGIN },
      }),
    },
    'serve status --json': { text: JSON.stringify(serve) },
    'agent focus': { text: '' },
  })
}

async function seedPairedDevices(
  box: Sandbox,
  url: { local: string; serve: string },
  remoteUrl: string,
): Promise<{
  ownerToken: string
  deskToken: string
  annaToken: string
  ownerId: string
  deskId: string
  annaId: string
}> {
  void remoteUrl
  // Use whois by IP via serve listener for distinct StableIDs.
  const serveUrl = url.serve
  const askServe = async (ip: string, login: string, name: string) => {
    const r = await fetch(`${serveUrl}/api/remote/pair`, {
      method: 'POST',
      headers: {
        host: NAME,
        'x-forwarded-for': ip,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': login,
        'content-type': 'application/json',
        'x-board': '1',
        origin: TAILNET_ORIGIN,
      },
      body: JSON.stringify({ name }),
    })
    expect(r.status).toBe(202)
    return ((await r.json()) as { id: string }).id
  }
  const ownerReq = await askServe(OWNER_IP, OWNER_LOGIN, 'Owner Browser')
  const deskReq = await askServe(DESK_IP, OWNER_LOGIN, 'Desk Browser')
  const annaReq = await askServe(ANNA_IP, ANNA_LOGIN, 'Anna Browser')

  for (const id of [ownerReq, deskReq, annaReq]) {
    const res = await fetch(`${url.local}/api/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'approve', id }),
    })
    expect(res.status).toBe(200)
  }

  const pollCookie = async (reqId: string, ip: string, login: string) => {
    const res = await fetch(`${serveUrl}/api/remote/pair/${reqId}`, {
      headers: {
        host: NAME,
        'x-forwarded-for': ip,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': login,
      },
    })
    expect(res.status).toBe(200)
    const set = res.headers.get('set-cookie') ?? ''
    const cookie = set.split(';')[0] ?? ''
    expect(cookie).toContain('__Host-board=')
    return cookie
  }

  const ownerToken = await pollCookie(ownerReq, OWNER_IP, OWNER_LOGIN)
  const deskToken = await pollCookie(deskReq, DESK_IP, OWNER_LOGIN)
  const annaToken = await pollCookie(annaReq, ANNA_IP, ANNA_LOGIN)

  const view = (await (await fetch(`${url.local}/api/remote`)).json()) as {
    devices: { id: string; device: string }[]
  }
  const ownerId = view.devices.find(d => d.device === 'atlas-phone')?.id ?? ''
  const deskId = view.devices.find(d => d.device === 'ben-desk')?.id ?? ''
  const annaId = view.devices.find(d => d.device === 'anna-phone')?.id ?? ''
  expect([ownerId, deskId, annaId].every(Boolean)).toBe(true)

  const markDesk = await fetch(`${url.local}/api/remote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'desk', id: deskId }),
  })
  expect(markDesk.status).toBe(200)
  void box
  void hashToken
  void USER_ID
  return { ownerToken, deskToken, annaToken, ownerId, deskId, annaId }
}

describe('remote.ownerAdmin off by default through the tunnel', () => {
  const shared = sharedSandbox()
  let url = ''
  let tunnel = ''
  let box: Sandbox
  let proc: Awaited<ReturnType<typeof startTunnelBoard>>['proc']

  beforeAll(async () => {
    box = await shared()
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir },
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    await seedAccess(box, {
      logins: [
        { token: PASSWORD_LOGIN, method: 'password' },
        { token: PASSKEY_LOGIN, method: 'passkey' },
      ],
      passkeys: [await seededPasskey()],
    })
    ;({ url, tunnel, proc } = await startTunnelBoard(box, {}, { TEST_ROUTE_TABLE: '1' }))
  }, 30_000)

  test('with flag off, every localOnly admin route and enabling owner-admin remotely stay refused; no nodes route added', async () => {
    const pw = viaCaddy(tunnel, `__Host-board-login=${PASSWORD_LOGIN}`)
    const pk = viaCaddy(tunnel, `__Host-board-login=${PASSKEY_LOGIN}`)

    for (const client of [pw, pk]) {
      const hello = (await (await client.get('/api/hello')).json()) as Record<string, unknown>
      expect('ownerAdmin' in hello).toBe(false)
      for (const path of [...adminPaths, '/api/nodes', '/api/team/agents']) {
        const res = await client.get(path)
        expect([path, res.status, await res.json()]).toEqual([path, 403, { error: 'local' }])
      }
      const turnOn = await client.post('/api/remote', { op: 'owner-admin', on: true })
      expect([turnOn.status, await turnOn.json()]).toEqual([403, { error: 'local' }])
    }

    // Board without nodes/node has no /api/nodes route on the local board either.
    expect((await fetch(`${url}/api/nodes`)).status).toBe(404)
    expect(routeTable(proc).filter(r => r.path.includes('nodes'))).toEqual([])
    const logRes = (await (await fetch(`${url}/api/links/log`)).json()) as { edges: AdminEdge[] }
    expect(logRes.edges.filter(e => e.kind === 'admin')).toEqual([])
  })
})

describe('remote.ownerAdmin enabled on a headless master through the tunnel (#694)', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let tunnel = ''

  beforeAll(async () => {
    box = await shared()
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir },
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    await seedAccess(box, {
      logins: [
        { token: PASSWORD_LOGIN, method: 'password' },
        { token: PASSKEY_LOGIN, method: 'passkey' },
      ],
      passkeys: [await seededPasskey()],
    })
    const webPort = await unusedPort()
    const tunnelPort = await unusedPort()
    const cfg = {
      language: 'en',
      port: webPort,
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      tunnel: { on: true, host: 'ssh.example.com', user: 'boardtunnel', domain: DOMAIN, port: tunnelPort },
      nodes: { id: 'master-1', devices: {} },
    }
    mkdirSync(join(configPath(box), '..'), { recursive: true })
    writeFileSync(configPath(box), JSON.stringify(cfg, null, 2))
    await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
    url = `http://127.0.0.1:${webPort}`
    tunnel = `http://127.0.0.1:${tunnelPort}`
    // Turn ownerAdmin on from the local board (liveConfig applies it).
    const on = await fetch(`${url}/api/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'owner-admin', on: true }),
    })
    expect([on.status, await on.json()]).toEqual([200, { ok: true }])
    const deadline = Date.now() + 5000
    for (;;) {
      const view = (await (await fetch(`${url}/api/remote`)).json()) as { ownerAdmin?: boolean }
      if (view.ownerAdmin) break
      if (Date.now() > deadline) throw new Error('ownerAdmin did not become active via liveConfig')
      await Bun.sleep(25)
    }
  }, 30_000)

  test('unauthenticated caller still sees nothing; strong logins (password+TOTP and passkey) use admin panels and are logged; desktopOnly stays refused', async () => {
    const anon = viaCaddy(tunnel)
    const anonHello = (await (await anon.get('/api/hello')).json()) as Record<string, unknown>
    expect('ownerAdmin' in anonHello).toBe(false)
    expect((await anon.get('/api/access')).status).toBe(401)
    expect((await anon.get('/api/nodes')).status).toBe(401)

    const pw = viaCaddy(tunnel, `__Host-board-login=${PASSWORD_LOGIN}`)
    const pk = viaCaddy(tunnel, `__Host-board-login=${PASSKEY_LOGIN}`)

    for (const [label, client] of [
      ['password', pw],
      ['passkey', pk],
    ] as const) {
      const hello = (await (await client.get('/api/hello')).json()) as Record<string, unknown>
      expect([label, hello.ownerAdmin]).toEqual([label, true])
      for (const path of [...adminPaths, '/api/nodes']) {
        const res = await client.get(path)
        expect([label, path, res.status]).toEqual([label, path, 200])
      }
      // Percent-encoded admin route works too and is audited.
      const encoded = await client.get('/api/%61ccess')
      expect([label, encoded.status]).toEqual([label, 200])
    }

    // Write admin action with a secret-like field in the body: succeeds, and body values never enter edge log.
    const featureRes = await pk.post('/api/feature-settings', { watches: true })
    expect(featureRes.status).toBe(200)
    const secretSentinel = 'super-secret-passphrase-never-logged'
    const backupRes = await pk.post('/api/backup', { op: 'passphrase', passphrase: secretSentinel, again: 'mismatch' })
    expect(backupRes.status).toBe(400)

    // desktopOnly and Tailscale-only routes stay refused.
    for (const path of ['/api/open-url', '/api/fs/open', '/api/reveal', '/api/session/s1/focus']) {
      const res = await pk.post(path, { url: 'https://example.com', path: '/', key: 's1' })
      expect([path, res.status, await res.json()]).toEqual([path, 403, { error: 'desktop' }])
    }
    expect((await pk.get('/api/peers')).status).toBe(404)
    expect((await pk.post('/api/remote/pair', { name: 'x' })).status).toBe(404)

    // Edge log records admin actions with who and from where, without bodies/secrets, and GET /api/links/log does not self-append.
    const log1 = (await (await pk.get('/api/links/log')).json()) as { edges: AdminEdge[]; next: number }
    const adminEdges = log1.edges.filter(e => e.kind === 'admin')
    expect(adminEdges.length).toBeGreaterThanOrEqual(adminPaths.length * 2 + 4)
    expect(adminEdges.every(e => e.via === 'tunnel' && e.from === CALLER && e.at > 0)).toBe(true)
    expect(adminEdges.some(e => e.path === '/api/access' && e.who.startsWith('password:'))).toBe(true)
    expect(adminEdges.some(e => e.path === '/api/nodes' && e.who.startsWith('passkey:'))).toBe(true)
    expect(adminEdges.some(e => e.path === '/api/backup' && e.method === 'POST' && e.status === 400)).toBe(true)
    expect(adminEdges.some(e => e.path === '/api/links/log')).toBe(false)
    expect(JSON.stringify(log1)).not.toContain(secretSentinel)

    const log2 = (await (await pk.get('/api/links/log')).json()) as { edges: AdminEdge[]; next: number }
    expect(log2.next).toBe(log1.next)

    // An authorised remote owner-admin session can turn owner-admin off, and is immediately refused afterwards.
    const off = await pk.post('/api/remote', { op: 'owner-admin', on: false })
    expect([off.status, await off.json()]).toEqual([200, { ok: true }])
    const refused = await pk.get('/api/access')
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'local' }])
    expect('ownerAdmin' in ((await (await pk.get('/api/hello')).json()) as Record<string, unknown>)).toBe(false)
  }, 30_000)
})

describe('remote.ownerAdmin over Tailscale and CLI (#694)', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let localUrl = ''
  let serveUrl = ''
  let remotePort = 0
  let pwaPort = 0
  let ownerCookie = ''
  let deskCookie = ''
  let annaCookie = ''
  let appBearer = ''

  beforeAll(async () => {
    box = await shared()
    remotePort = await unusedPort()
    pwaPort = await unusedPort()
    seedTailscale(box, pwaPort)
    const webPort = await unusedPort()
    const cfg = {
      language: 'en',
      port: webPort,
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      raiseTerminal: false,
      remote: {
        on: true,
        port: remotePort,
        allow: [ANNA_LOGIN],
        pwa: { on: true, port: pwaPort },
        ownerAdmin: false,
      },
      nodes: { id: 'master-1', devices: {} },
    }
    mkdirSync(join(configPath(box), '..'), { recursive: true })
    writeFileSync(configPath(box), JSON.stringify(cfg, null, 2))
    await serveBoard(box, cfg, {
      TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string,
      TEST_LIVE_CONFIG: '1',
    })
    localUrl = `http://127.0.0.1:${webPort}`
    serveUrl = `http://127.0.0.1:${pwaPort}`
    const deadline = Date.now() + 8000
    for (;;) {
      const view = (await (await fetch(`${localUrl}/api/remote`)).json()) as {
        url?: string | null
        pwa?: { url?: string | null }
      }
      const board = (await (await fetch(`${localUrl}/api/board`)).json()) as { stale: boolean }
      if (view.url && view.pwa?.url && !board.stale) break
      if (Date.now() > deadline) throw new Error('tailscale remote/pwa did not start')
      await Bun.sleep(25)
    }

    const paired = await seedPairedDevices(box, { local: localUrl, serve: serveUrl }, `http://127.0.0.1:${remotePort}`)
    ownerCookie = paired.ownerToken
    deskCookie = paired.deskToken
    annaCookie = paired.annaToken

    // Also pair an owner native app device over tailnet.
    const askApp = await fetch(`http://127.0.0.1:${remotePort}/api/remote/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ name: 'Owner App' }),
    })
    expect(askApp.status).toBe(202)
    const { id: appReqId } = (await askApp.json()) as { id: string }
    expect(
      (
        await fetch(`${localUrl}/api/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ op: 'approve', id: appReqId }),
        })
      ).status,
    ).toBe(200)
    const appPoll = (await (await fetch(`http://127.0.0.1:${remotePort}/api/remote/pair/${appReqId}`)).json()) as {
      status: string
      token: string
    }
    expect(appPoll.status).toBe('approved')
    appBearer = appPoll.token
  }, 30_000)

  const callServe = (ip: string, login: string, cookie: string, path: string, method = 'GET', body?: unknown) =>
    fetch(`${serveUrl}${path}`, {
      method,
      headers: {
        host: NAME,
        'x-forwarded-for': ip,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': login,
        cookie,
        ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-board': '1', origin: TAILNET_ORIGIN } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const callApp = (path: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${remotePort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${appBearer}`,
        ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-board': '1' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  test('owner non-desk devices (serve + app) get admin access once CLI turns owner-admin on; desk and remote.allow users stay refused', async () => {
    const cli = async (...args: string[]) => {
      const out = await box.run('cli', { args: ['remote', ...args], env: {} }).exited
      return `${out.stdout}${out.stderr}`.trim()
    }

    // With flag off: owner non-desk browser is refused.
    expect((await callServe(OWNER_IP, OWNER_LOGIN, ownerCookie, '/api/access')).status).toBe(403)
    expect(await cli()).not.toContain('owner-admin: on')

    // Turn flag on via CLI.
    expect(await cli('owner-admin', 'on')).toBe('ok · owner-admin on')
    const deadline = Date.now() + 5000
    for (;;) {
      const view = (await (await fetch(`${localUrl}/api/remote`)).json()) as { ownerAdmin?: boolean }
      if (view.ownerAdmin) break
      if (Date.now() > deadline) throw new Error('ownerAdmin did not sync from CLI')
      await Bun.sleep(25)
    }
    expect(await cli()).toContain('owner-admin: on')

    // Owner non-desk serve browser: hello has ownerAdmin: true, admin routes pass, desktopOnly refused.
    const ownerHello = (await (await callServe(OWNER_IP, OWNER_LOGIN, ownerCookie, '/api/hello')).json()) as Record<
      string,
      unknown
    >
    expect(ownerHello.ownerAdmin).toBe(true)
    for (const path of ['/api/access', '/api/remote', '/api/wake', '/api/backup', '/api/nodes', '/api/nodes/setup']) {
      const r = await callServe(OWNER_IP, OWNER_LOGIN, ownerCookie, path)
      expect([path, r.status]).toEqual([path, 200])
    }
    const focusOwner = await callServe(OWNER_IP, OWNER_LOGIN, ownerCookie, '/api/session/s1/focus', 'POST', {})
    expect([focusOwner.status, await focusOwner.json()]).toEqual([403, { error: 'desktop' }])

    // Owner native app over tailnet: admin routes pass (non-desk /api/remote ops too!).
    expect((await callApp('/api/access')).status).toBe(200)
    expect((await callApp('/api/nodes')).status).toBe(200)
    expect((await callApp('/api/remote')).status).toBe(200)
    expect((await callApp('/api/remote', 'POST', { op: 'deny', id: 'nope' })).status).toBe(404)

    // Desk (owner's own Tailscale login, marked desk: true): still NO ownerAdmin, ALL localOnly admin routes refused,
    // while deskFocus and DESK_REMOTE_OPS continue working unchanged.
    const deskHello = (await (await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/hello')).json()) as Record<
      string,
      unknown
    >
    expect('ownerAdmin' in deskHello).toBe(false)
    expect(deskHello.desk).toBe(true)
    for (const path of [
      '/api/access',
      '/api/%61ccess',
      '/api/backup',
      '/api/wake',
      '/api/nodes',
      '/api/nodes/setup',
      '/api/links/log',
    ]) {
      const r = await callServe(DESK_IP, OWNER_LOGIN, deskCookie, path)
      expect([path, r.status, await r.json()]).toEqual([path, 403, { error: 'local' }])
    }
    for (const op of ['owner-admin', 'off', 'desk']) {
      const r = await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/remote', 'POST', { op, on: false, id: 'x' })
      expect([op, r.status, await r.json()]).toEqual([op, 403, { error: 'local' }])
    }
    expect((await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/session/s1/focus', 'POST', {})).status).toBe(200)
    expect(
      (await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/remote', 'POST', { op: 'deny', id: 'nope' })).status,
    ).toBe(404)

    // Another Tailscale user in remote.allow (anna@example.com): NO ownerAdmin, ALL localOnly routes refused.
    const annaHello = (await (await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, '/api/hello')).json()) as Record<
      string,
      unknown
    >
    expect('ownerAdmin' in annaHello).toBe(false)
    for (const path of ['/api/access', '/api/remote', '/api/backup', '/api/wake', '/api/nodes', '/api/nodes/setup']) {
      const r = await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, path)
      expect([path, r.status, await r.json()]).toEqual([path, 403, { error: 'local' }])
    }
    const annaOn = await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, '/api/remote', 'POST', {
      op: 'owner-admin',
      on: true,
    })
    expect([annaOn.status, await annaOn.json()]).toEqual([403, { error: 'local' }])

    // Edge log recorded serve and tailnet admin calls with who and from.
    const edges = ((await (await fetch(`${localUrl}/api/links/log`)).json()) as { edges: AdminEdge[] }).edges.filter(
      e => e.kind === 'admin',
    )
    expect(edges.some(e => e.via === 'serve' && e.from === OWNER_IP && e.who.includes(OWNER_LOGIN))).toBe(true)
    expect(edges.some(e => e.via === 'tailnet' && e.who.includes(OWNER_LOGIN))).toBe(true)
    expect(edges.some(e => e.who.includes(ANNA_LOGIN))).toBe(false)
    expect(edges.some(e => e.who.includes('ben-desk'))).toBe(false)

    // CLI turns owner-admin off cleanly.
    expect(await cli('owner-admin', 'off')).toBe('ok · owner-admin off')
    expect(existsSync(configPath(box))).toBe(true)
  }, 40_000)
})
