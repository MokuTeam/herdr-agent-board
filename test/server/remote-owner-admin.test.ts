// Remote access for an owner's own strong login on a headless master (#694).
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Passkey } from '../../src/core/access.ts'
import type { AdminEdge } from '../../src/core/links.ts'
import { base32Bytes, totpCode, totpStep } from '../../src/core/totp.ts'
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
  SECRET_B32,
  seedAccess,
  startTunnelBoard,
  stateFolder,
  USER_ID,
  viaCaddy,
} from '../support/tunnel-board.ts'

const PASSWORD_LOGIN = 'P'.repeat(43)
const PASSKEY_LOGIN = 'K'.repeat(43)
const PASSKEY_LOGIN_2 = 'Q'.repeat(43)
const SECRET_BYTES = base32Bytes(SECRET_B32) ?? new Uint8Array()
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
        { token: PASSKEY_LOGIN_2, method: 'passkey' },
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
      for (const path of [...adminPaths, '/api/team/agents']) {
        const res = await client.get(path)
        expect([path, res.status, await res.json()]).toEqual([path, 403, { error: 'local' }])
      }
      // /api/nodes* stays 404 for non-admin remote callers, as on main.
      for (const path of ['/api/nodes', '/api/nodes/setup']) {
        const res = await client.get(path)
        expect([path, res.status, await res.json()]).toEqual([path, 404, { error: 'not found' }])
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
        { token: PASSKEY_LOGIN_2, method: 'passkey' },
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
      for (const path of [...adminPaths, '/api/nodes', '/api/nodes/setup']) {
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

    // Edge log records mutating admin actions with op, who, and from where, without bodies/secrets;
    // read-only GETs and GET /api/links/log are NOT appended to the permanent edge log.
    const log1 = (await (await pk.get('/api/links/log')).json()) as { edges: AdminEdge[]; next: number }
    const adminEdges = log1.edges.filter(e => e.kind === 'admin')
    expect(adminEdges.length).toBe(2)
    expect(adminEdges.every(e => e.method === 'POST' && e.via === 'tunnel' && e.from === CALLER && e.at > 0)).toBe(true)
    expect(adminEdges.some(e => e.path === '/api/feature-settings' && e.op === undefined && e.status === 200)).toBe(
      true,
    )
    expect(adminEdges.some(e => e.path === '/api/backup' && e.op === 'passphrase' && e.status === 400)).toBe(true)
    expect(adminEdges.some(e => e.method === 'GET')).toBe(false)
    expect(adminEdges.some(e => e.path === '/api/links/log')).toBe(false)
    expect(JSON.stringify(log1)).not.toContain(secretSentinel)

    const log2 = (await (await pk.get('/api/links/log')).json()) as { edges: AdminEdge[]; next: number }
    expect(log2.next).toBe(log1.next)

    // Handover orchestration stays local-only even for an ownerAdmin session.
    expect((await pw.get('/api/nodes/handover')).status).toBe(404)
    expect((await pk.get('/api/nodes/handover')).status).toBe(404)
    expect((await pk.post('/api/nodes/handover', { op: 'check', to: 'server-1' })).status).toBe(405)

    // Step-up TOTP for remote credential changes (password, totp-confirm, lockout-lift):
    // missing or wrong code is refused; fresh code succeeds; replay of the same code is refused.
    expect((await pk.post('/api/access', { op: 'lockout-lift' })).status).toBe(403)
    expect((await pk.post('/api/access', { op: 'password', password: 'new strong password' })).status).toBe(403)
    const begun = (await (await pk.post('/api/access', { op: 'totp-begin' })).json()) as { secret: string }
    const newSecretBytes = base32Bytes(begun.secret) ?? new Uint8Array()
    const newCode = totpCode(newSecretBytes, totpStep(Date.now()))
    // Passing only the new secret's `code` without `totpCode` for the current secret is refused.
    expect((await pk.post('/api/access', { op: 'totp-confirm', code: newCode })).status).toBe(403)

    const stepNow = totpStep(Date.now())
    const step0 = totpCode(SECRET_BYTES, stepNow)
    const step1 = totpCode(SECRET_BYTES, stepNow + 1)
    expect((await pk.post('/api/access', { op: 'lockout-lift', totpCode: step0 })).status).toBe(200)
    // Replaying step0 fails.
    expect(
      (await pk.post('/api/access', { op: 'password', password: 'new strong password', totpCode: step0 })).status,
    ).toBe(403)
    // step1 succeeds for password change (which ends existing logins, so check using PASSKEY_LOGIN_2 via fresh login or check local + new step).
    const pk2 = viaCaddy(tunnel, `__Host-board-login=${PASSKEY_LOGIN_2}`)
    expect(
      (await pk2.post('/api/access', { op: 'password', password: 'another strong password', totpCode: step1 })).status,
    ).toBe(200)
    // Local board still changes password without step-up TOTP, and works as before.
    const localPw = await fetch(`${url}/api/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'password', password: 'correct horse battery' }),
    })
    expect(localPw.status).toBe(200)
    // Re-seed a fresh passkey login and test totp-confirm step-up succeeding, then turning owner-admin off.
    const RESEEDED = 'R'.repeat(43)
    const RESEEDED_2 = 'T'.repeat(43)
    await seedAccess(box, {
      logins: [{ token: RESEEDED, method: 'passkey' }],
      passkeys: [await seededPasskey()],
    })
    const pk3 = viaCaddy(tunnel, `__Host-board-login=${RESEEDED}`)
    const begun2 = (await (await pk3.post('/api/access', { op: 'totp-begin' })).json()) as { secret: string }
    const newCode2 = totpCode(base32Bytes(begun2.secret) ?? new Uint8Array(), totpStep(Date.now()))
    expect((await pk3.post('/api/access', { op: 'totp-confirm', code: newCode2, totpCode: step0 })).status).toBe(200)

    // totp-confirm ends existing logins; re-seed a fresh login to turn owner-admin off remotely.
    await seedAccess(box, {
      logins: [{ token: RESEEDED_2, method: 'passkey' }],
      passkeys: [await seededPasskey()],
    })
    const pk4 = viaCaddy(tunnel, `__Host-board-login=${RESEEDED_2}`)
    // An authorised remote owner-admin session can turn owner-admin off, and is immediately refused afterwards.
    const off = await pk4.post('/api/remote', { op: 'owner-admin', on: false })
    expect([off.status, await off.json()]).toEqual([200, { ok: true }])
    const refused = await pk4.get('/api/access')
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'local' }])
    expect('ownerAdmin' in ((await (await pk4.get('/api/hello')).json()) as Record<string, unknown>)).toBe(false)
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

    // Owner native app over tailnet: admin routes pass (non-desk /api/remote ops too), while pilot-call stays local-only.
    expect((await callApp('/api/access')).status).toBe(200)
    expect((await callApp('/api/nodes')).status).toBe(200)
    expect((await callApp('/api/remote')).status).toBe(200)
    expect((await callApp('/api/remote', 'POST', { op: 'deny', id: 'nope' })).status).toBe(404)
    const pilotCallRes = await callApp('/api/mokupilot/node-call/abcdefgh1234/start', 'POST', {})
    expect([pilotCallRes.status, await pilotCallRes.json()]).toEqual([405, { error: 'method' }])

    // Desk (owner's own Tailscale login, marked desk: true): still NO ownerAdmin, ALL localOnly admin routes refused,
    // while deskFocus and DESK_REMOTE_OPS continue working unchanged.
    const deskHello = (await (await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/hello')).json()) as Record<
      string,
      unknown
    >
    expect('ownerAdmin' in deskHello).toBe(false)
    expect(deskHello.desk).toBe(true)
    for (const path of ['/api/access', '/api/%61ccess', '/api/backup', '/api/wake', '/api/links/log']) {
      const r = await callServe(DESK_IP, OWNER_LOGIN, deskCookie, path)
      expect([path, r.status, await r.json()]).toEqual([path, 403, { error: 'local' }])
    }
    for (const path of ['/api/nodes', '/api/nodes/setup']) {
      const r = await callServe(DESK_IP, OWNER_LOGIN, deskCookie, path)
      expect([path, r.status, await r.json()]).toEqual([path, 404, { error: 'not found' }])
    }
    for (const op of ['owner-admin', 'off', 'desk']) {
      const r = await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/remote', 'POST', { op, on: false, id: 'x' })
      expect([op, r.status, await r.json()]).toEqual([op, 403, { error: 'local' }])
    }
    expect((await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/session/s1/focus', 'POST', {})).status).toBe(200)
    expect(
      (await callServe(DESK_IP, OWNER_LOGIN, deskCookie, '/api/remote', 'POST', { op: 'deny', id: 'nope' })).status,
    ).toBe(404)

    // Another Tailscale user in remote.allow (anna@example.com): NO ownerAdmin, ALL localOnly routes refused, /api/nodes* 404.
    const annaHello = (await (await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, '/api/hello')).json()) as Record<
      string,
      unknown
    >
    expect('ownerAdmin' in annaHello).toBe(false)
    for (const path of ['/api/access', '/api/remote', '/api/backup', '/api/wake']) {
      const r = await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, path)
      expect([path, r.status, await r.json()]).toEqual([path, 403, { error: 'local' }])
    }
    for (const path of ['/api/nodes', '/api/nodes/setup']) {
      const r = await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, path)
      expect([path, r.status, await r.json()]).toEqual([path, 404, { error: 'not found' }])
    }
    const annaOn = await callServe(ANNA_IP, ANNA_LOGIN, annaCookie, '/api/remote', 'POST', {
      op: 'owner-admin',
      on: true,
    })
    expect([annaOn.status, await annaOn.json()]).toEqual([403, { error: 'local' }])

    // Edge log recorded mutating serve and tailnet admin calls (with op) and omitted GETs.
    const edges = ((await (await fetch(`${localUrl}/api/links/log`)).json()) as { edges: AdminEdge[] }).edges.filter(
      e => e.kind === 'admin',
    )
    expect(edges.some(e => e.via === 'tailnet' && e.who.includes(OWNER_LOGIN) && e.op === 'deny')).toBe(true)
    expect(edges.some(e => e.method === 'GET')).toBe(false)
    expect(edges.some(e => e.who.includes(ANNA_LOGIN))).toBe(false)
    expect(edges.some(e => e.who.includes('ben-desk'))).toBe(false)

    // CLI turns owner-admin off cleanly.
    expect(await cli('owner-admin', 'off')).toBe('ok · owner-admin off')
    expect(existsSync(configPath(box))).toBe(true)
  }, 40_000)
})

describe('remote.ownerAdmin fail-closed audit and tagged Tailscale refusal (#694)', () => {
  const shared = sharedSandbox()

  test('if the edge log audit store is not writable, mutating remote admin actions fail closed (503) without mutating state', async () => {
    const box = await shared()
    box.state({
      'api snapshot': {
        result: { snapshot: { panes: [], tabs: [], workspaces: [] } },
      },
    })
    await seedAccess(box, { logins: [{ token: PASSKEY_LOGIN, method: 'passkey' }], passkeys: [await seededPasskey()] })
    // Place a regular file at edge-log so mkdirSync / openSync cannot write audit segments.
    mkdirSync(stateFolder(box), { recursive: true })
    writeFileSync(join(stateFolder(box), 'edge-log'), 'blocked')
    const { url, tunnel } = await startTunnelBoard(box, { remote: { ownerAdmin: true } })
    const pk = viaCaddy(tunnel, `__Host-board-login=${PASSKEY_LOGIN}`)

    const res = await pk.post('/api/feature-settings', { watches: true })
    expect([res.status, await res.json()]).toEqual([503, { ok: false, error: 'audit' }])
    // Config was not mutated.
    const board = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect(board.watches).toBeUndefined()
  }, 30_000)

  const pairTaggedTailscaleBoard = async (
    box: Awaited<ReturnType<typeof shared>>,
    opts: { ownerAdmin: boolean; threads?: boolean },
  ) => {
    const remotePort = await unusedPort()
    const pwaPort = await unusedPort()
    const taggedLogin = 'tagged-devices'
    const status = {
      BackendState: 'Running',
      Self: { DNSName: `${NAME}.`, OS: 'linux', UserID: 1, TailscaleIPs: ['127.0.0.1'], Online: true },
      Peer: {},
      User: { '1': { LoginName: taggedLogin } },
      CertDomains: [NAME],
    }
    const serve = {
      TCP: { '443': { HTTPS: true } },
      Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${pwaPort}` } } } },
    }
    box.state({
      'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } },
      'status --json': { text: JSON.stringify(status) },
      [`whois --json ${OWNER_IP}`]: {
        text: JSON.stringify({
          Node: { StableID: 'nTaggedCaller', ComputedName: 'tag-device', Hostinfo: { OS: 'linux' } },
          UserProfile: { LoginName: taggedLogin },
        }),
      },
      'serve status --json': { text: JSON.stringify(serve) },
    })
    const { url } = await serveBoard(
      box,
      {
        language: 'en',
        ...(opts.threads !== undefined && { threads: opts.threads }),
        remote: {
          on: true,
          port: remotePort,
          allow: [taggedLogin],
          pwa: { on: true, port: pwaPort },
          ownerAdmin: opts.ownerAdmin,
        },
      },
      { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string },
    )
    const serveUrl = `http://127.0.0.1:${pwaPort}`
    const deadline = Date.now() + 8000
    for (;;) {
      const view = (await (await fetch(`${url}/api/remote`)).json()) as { pwa?: { url?: string | null } }
      if (view.pwa?.url) break
      if (Date.now() > deadline) throw new Error('serve did not start')
      await Bun.sleep(25)
    }
    const taggedHeaders = {
      host: NAME,
      'x-forwarded-for': OWNER_IP,
      'x-forwarded-proto': 'https',
      'tailscale-user-login': taggedLogin,
    }
    const asked = await fetch(`${serveUrl}/api/remote/pair`, {
      method: 'POST',
      headers: {
        ...taggedHeaders,
        'content-type': 'application/json',
        'x-board': '1',
        origin: TAILNET_ORIGIN,
      },
      body: JSON.stringify({ name: 'Tagged Browser' }),
    })
    expect(asked.status).toBe(202)
    const { id } = (await asked.json()) as { id: string }
    expect(
      (
        await fetch(`${url}/api/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ op: 'approve', id }),
        })
      ).status,
    ).toBe(200)
    const poll = await fetch(`${serveUrl}/api/remote/pair/${id}`, { headers: taggedHeaders })
    const cookie = (poll.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const serveGet = (path: string) => fetch(`${serveUrl}${path}`, { headers: { ...taggedHeaders, cookie } })
    return { serveGet }
  }

  test('tagged Tailscale nodes (tagged-*) are refused ownerAdmin even when caller and self share the tagged login', async () => {
    const { serveGet } = await pairTaggedTailscaleBoard(await shared(), { ownerAdmin: true })
    const hello = (await (await serveGet('/api/hello')).json()) as Record<string, unknown>
    expect('ownerAdmin' in hello).toBe(false)
    const refused = await serveGet('/api/access')
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'local' }])
  }, 30_000)

  test('tagged master with remote.ownerAdmin off keeps remote Threads (#392) for owner device', async () => {
    const { serveGet } = await pairTaggedTailscaleBoard(await shared(), { ownerAdmin: false, threads: true })
    const hello = (await (await serveGet('/api/hello')).json()) as Record<string, unknown>
    expect(hello.threads).toBe(true)
    expect('ownerAdmin' in hello).toBe(false)
    expect((await serveGet('/api/threads')).status).toBe(200)
    const refused = await serveGet('/api/access')
    expect([refused.status, await refused.json()]).toEqual([403, { error: 'local' }])
  }, 30_000)
})
