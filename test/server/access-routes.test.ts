// Remote access on the local board (services/remote-access.ts, server/routes/access.ts): the panel's
// view from GET /api/access and every change through POST /api/access, both on the web board on
// 127.0.0.1 only; and the tunnel's ssh, run by the board that holds the web port. ssh and
// ssh-keygen are the fake (test/support/fake-ssh.ts), which also stands in for Caddy: with
// `ssh.proxyPort` in its state, it passes what comes to that port on to its -R target, as Caddy
// passes the domain on through the socket. The probe through the domain goes there too
// (BOARD_TUNNEL_PROBE_ORIGIN).
import { beforeAll, describe, expect, onTestFinished, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { type AccessView, isAccessView } from '../../src/core/access.ts'
import { REMOTE_API } from '../../src/core/remote.ts'
import { base32Bytes, totpCode, totpStep } from '../../src/core/totp.ts'
import { forwardSpec, sshArgs, tunnelConfig } from '../../src/core/tunnel.ts'
import { ACCESS_PUBLISH_MS } from '../../src/server/app.ts'
import { logged, serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import {
  DOMAIN,
  PASSWORD,
  seedAccess,
  seededLogin,
  startTunnelBoard,
  stateFolder,
  viaCaddy,
  writeState,
} from '../support/tunnel-board.ts'

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY'
const FINGERPRINT = 'SHA256:FAKEfingerprint (ED25519)'
const LOGIN = 'L'.repeat(43)

type Reply = Record<string, unknown>

/** A sandbox's fake ssh: its state, its log (one argv per line) and the pids of the ssh it ran (fake-ssh.ts). */
function fakeSsh(box: Sandbox, proxyPort: number) {
  const stateFile = join(box.dir, 'ssh-state.json')
  const log = join(box.dir, 'ssh-calls.jsonl')
  writeFileSync(stateFile, JSON.stringify({ ssh: { proxyPort, domain: DOMAIN } }))
  const lines = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  return {
    stateFile,
    log,
    /** The ssh calls (an argument list with -R), oldest first; ssh-keygen's are left out. */
    sshCalls: (): string[][] =>
      lines(log)
        .map(line => JSON.parse(line) as string[])
        .filter(a => a.includes('-R')),
    /** The ssh-keygen calls, oldest first. */
    keygenCalls: (): string[][] =>
      lines(log)
        .map(line => JSON.parse(line) as string[])
        .filter(a => !a.includes('-R')),
    /** Each ssh the fake ran, by its pid. */
    pids: (): number[] => lines(`${log}.pids`).map(Number),
  }
}

/** The environment a board needs for the fake as both programs, and the probe through its proxy. */
async function fakeEnv(box: Sandbox, proxyPort: number): Promise<Record<string, string>> {
  const bin = await fakeSshBin()
  const { stateFile, log } = fakeSsh(box, proxyPort)
  return {
    BOARD_SSH_BIN_PATH: bin,
    BOARD_SSH_KEYGEN_BIN_PATH: bin,
    FAKE_SSH_STATE: stateFile,
    FAKE_SSH_LOG: log,
    BOARD_TUNNEL_PROBE_ORIGIN: `http://127.0.0.1:${proxyPort}`,
  }
}

/** A process of ours runs under the pid. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Nothing listens on `base` (the connection is refused). */
const refuses = (base: string): Promise<boolean> =>
  fetch(`${base}/api/hello`, { headers: { host: DOMAIN, 'x-forwarded-proto': 'https' } }).then(
    () => false,
    () => true,
  )

/** Waits until `ok` resolves true, within `ms`. */
async function eventually(ok: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await Bun.sleep(25)
  }
}

/** The local board's Remote access, through `url`. */
function local(url: string) {
  const view = async (): Promise<AccessView> => {
    const v: unknown = await (await fetch(`${url}/api/access`)).json()
    if (!isAccessView(v)) throw new Error(`not a view: ${JSON.stringify(v)}`)
    return v
  }
  return {
    view,
    /** POST /api/access as the panel sends it: its status and its JSON. */
    async op(body: unknown): Promise<[number, Reply]> {
      const res = await fetch(`${url}/api/access`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })
      return [res.status, (await res.json()) as Reply]
    },
    /** The view once `ok` holds for it, within `ms`. */
    async viewWhen(ok: (v: AccessView) => boolean, ms = 15_000): Promise<AccessView> {
      const deadline = Date.now() + ms
      for (;;) {
        const v = await view()
        if (ok(v)) return v
        if (Date.now() > deadline) throw new Error(`the view never got there: ${JSON.stringify(v.tunnel.status)}`)
        await Bun.sleep(50)
      }
    },
    accessRev: async (): Promise<unknown> => ((await (await fetch(`${url}/api/board`)).json()) as Reply).accessRev,
  }
}

/**
 * Free ports for the web board, the tunnel listener and the fake's proxy. The tunnel's is never
 * one the board takes itself (the web port, the phone's browser's next to it): the OS may hand
 * out free ports one after the other.
 */
async function freePorts(): Promise<{ web: number; tunnel: number; proxy: number }> {
  const web = await unusedPort()
  let tunnel = await unusedPort()
  while (tunnel === web || tunnel === web + 1) tunnel = await unusedPort()
  return { web, tunnel, proxy: await unusedPort() }
}

/** The number of times the board read config.json again (runner.ts with TEST_LIVE_CONFIG). */
const reloads = (proc: Child): number => proc.messages.filter(m => (m as { reloaded?: boolean }).reloaded).length

describe('Remote access, set up from the local board', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let proc: Child
  let url = ''
  let webPort = 0
  let tunnelPort = 0
  let proxyPort = 0
  let bin = ''
  let ssh: ReturnType<typeof fakeSsh>
  let configPath = ''
  let api: ReturnType<typeof local>
  let state = ''
  /** The tunnel's settings that check out, as the panel saves them. */
  let settings: Record<string, unknown> = {}

  /** config.json written by hand, then read again by the board. */
  async function writeConfig(value: unknown): Promise<void> {
    const before = reloads(proc)
    writeFileSync(configPath, JSON.stringify(value, null, 2))
    await until(() => reloads(proc) > before)
  }
  /** An op that writes config.json, and the board reading it again. */
  async function opReloaded(body: unknown): Promise<[number, Reply]> {
    const before = reloads(proc)
    const answer = await api.op(body)
    await until(() => reloads(proc) > before)
    return answer
  }

  beforeAll(async () => {
    box = await shared()
    ;({ web: webPort, tunnel: tunnelPort, proxy: proxyPort } = await freePorts())
    bin = await fakeSshBin()
    ssh = fakeSsh(box, proxyPort)
    state = stateFolder(box)
    settings = { host: 'ssh.example.com', user: 'boardtunnel', domain: DOMAIN, port: tunnelPort }
    // The board reads config.json as it changes, as the real one does (TEST_LIVE_CONFIG).
    const cfg = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      port: webPort,
    }
    configPath = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(join(configPath, '..'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))
    ;({ proc } = await serveBoard(box, cfg, { ...(await fakeEnv(box, proxyPort)), TEST_LIVE_CONFIG: '1' }))
    url = `http://127.0.0.1:${webPort}`
    api = local(url)
  }, 30_000)

  test('nothing set up: the default settings, what is missing, and On refused with the reason', async () => {
    const v = await api.view()
    expect(v.tunnel.settings).toEqual(tunnelConfig(undefined))
    expect(v.tunnel.problems.map(p => p.field)).toEqual(['host', 'user', 'domain'])
    expect(v.tunnel.blocked).toBe('Server: needed')
    expect(v.tunnel.listenPort).toBe(webPort + 2)
    expect(v.tunnel.status.state).toBe('off')
    expect(v.tunnel.ssh).toBe(bin)
    expect(v.tunnel.key).toEqual({
      path: join(state, 'tunnel', 'id_ed25519'),
      generated: true,
      exists: false,
      publicKey: null,
      error: null,
    })
    expect(v.tunnel.hostKey).toBeNull()
    expect(v.login).toEqual({ password: false, totp: false, passkeys: [], lockout: null })
    expect([v.logins, v.attempts]).toEqual([[], []])
    expect(await api.op({ op: 'on' })).toEqual([409, { ok: false, error: 'Server: needed' }])
    expect(await api.op({ op: 'sideways' })).toEqual([400, { ok: false, error: 'unknown op sideways' }])
    // A change needs the board's own page, as every POST on the web board.
    const bare = await fetch(`${url}/api/access`, { method: 'POST', body: JSON.stringify({ op: 'off' }) })
    expect(bare.status).toBe(403)
    expect(typeof (await api.accessRev())).toBe('number')
    expect(ssh.sshCalls()).toEqual([])
  })

  test('a field that fails its check is refused and nothing is written; the ones that check out are saved', async () => {
    const before = readFileSync(configPath, 'utf8')
    expect(await api.op({ op: 'tunnel', fields: { host: '-oProxyCommand=calc' } })).toEqual([
      409,
      {
        ok: false,
        field: 'host',
        error: 'The server is a host name or an address, without spaces, @ or a leading dash',
      },
    ])
    // the whole edit, the good fields with it
    const [status, refused] = await api.op({ op: 'tunnel', fields: { user: 'boardtunnel', socket: '/tmp/b.sock' } })
    expect([status, refused.field]).toEqual([409, 'socket'])
    // only the tunnel's fields: never `on` past its checks
    expect((await api.op({ op: 'tunnel', fields: { on: true } }))[0]).toBe(400)
    // the public port is one of them, checked as the SSH port
    expect(await api.op({ op: 'tunnel', fields: { publicPort: 0 } })).toEqual([
      409,
      { ok: false, field: 'publicPort', error: 'Public port is a whole number from 1 to 65535' },
    ])
    expect(readFileSync(configPath, 'utf8')).toBe(before)

    expect(await opReloaded({ op: 'tunnel', fields: { ...settings, domain: ' Board.Example.COM ' } })).toEqual([
      200,
      { ok: true },
    ])
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as Reply).tunnel).toEqual(settings)
    const v = await api.view()
    expect(v.tunnel.settings).toEqual(tunnelConfig(settings))
    expect(v.tunnel.problems).toEqual([])
    expect(v.tunnel.listenPort).toBe(tunnelPort)
    // the settings check out; the login is not set up yet
    expect(v.tunnel.blocked).toBe('Set up the password and the code first')
    expect(await api.op({ op: 'on' })).toEqual([409, { ok: false, error: 'Set up the password and the code first' }])

    // Another public port is saved and shown; emptied, it is 443 again and leaves config.json.
    expect(await opReloaded({ op: 'tunnel', fields: { publicPort: 8443 } })).toEqual([200, { ok: true }])
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as Reply).tunnel).toEqual({ ...settings, publicPort: 8443 })
    expect((await api.view()).tunnel.settings.publicPort).toBe(8443)
    expect(await opReloaded({ op: 'tunnel', fields: { publicPort: null } })).toEqual([200, { ok: true }])
    expect((JSON.parse(readFileSync(configPath, 'utf8')) as Reply).tunnel).toEqual(settings)
    expect((await api.view()).tunnel.settings.publicPort).toBeNull()
  })

  test('the code and the password, set up here: the secret goes out once, in its own answer only', async () => {
    const [status, begun] = await api.op({ op: 'totp-begin' })
    expect(status).toBe(200)
    expect(begun).toEqual({ ok: true, secret: expect.stringMatching(/^[A-Z2-7]{32}$/), uri: expect.any(String) })
    const secret = String(begun.secret)
    expect(String(begun.uri)).toStartWith('otpauth://totp/')
    expect(String(begun.uri)).toContain(`secret=${secret}`)
    expect(decodeURIComponent(String(begun.uri))).toContain(DOMAIN)
    expect(await (await fetch(`${url}/api/access`)).text()).not.toContain(secret)
    expect(await (await fetch(`${url}/api/board`)).text()).not.toContain(secret)
    const code = totpCode(base32Bytes(secret) ?? new Uint8Array(), totpStep(Date.now()))
    expect(await api.op({ op: 'totp-confirm', code })).toEqual([200, { ok: true }])
    expect((await api.view()).login).toMatchObject({ password: false, totp: true })
    // saved now, and still never shown
    expect(await (await fetch(`${url}/api/access`)).text()).not.toContain(secret)
    expect(await (await fetch(`${url}/api/board`)).text()).not.toContain(secret)

    expect(await api.op({ op: 'password', password: 'too short' })).toEqual([
      409,
      { ok: false, error: 'A password has at least 12 characters' },
    ])
    expect(await api.op({ op: 'password', password: PASSWORD })).toEqual([200, { ok: true }])
    const v = await api.view()
    expect(v.login).toMatchObject({ password: true, totp: true })
    expect(v.tunnel.blocked).toBeNull()
  })

  test('config.json edited by hand with a host that would reach ssh as an option: no ssh, no listener', async () => {
    const good = JSON.parse(readFileSync(configPath, 'utf8')) as Reply
    await writeConfig({ ...good, tunnel: { ...settings, on: true, host: '-oProxyCommand=calc' } })
    const v = await api.viewWhen(x => x.tunnel.settings.on)
    expect(v.tunnel.problems.map(p => p.field)).toEqual(['host'])
    expect(v.tunnel.blocked).toBe('The server is a host name or an address, without spaces, @ or a leading dash')
    await Bun.sleep(500)
    expect(await refuses(`http://127.0.0.1:${tunnelPort}`)).toBe(true)
    expect(ssh.sshCalls()).toEqual([])
    expect((await api.view()).tunnel.status.state).toBe('off')
    await writeConfig(good)
  })

  test('Generate key: the board’s own key, made once unless replaced', async () => {
    const publicKey = `${PUBLIC_KEY} agent-board@${hostname()}`
    expect(await api.op({ op: 'key-generate' })).toEqual([200, { ok: true, publicKey }])
    const v = await api.view()
    expect(v.tunnel.key).toEqual({
      path: join(state, 'tunnel', 'id_ed25519'),
      generated: true,
      exists: true,
      publicKey,
      error: null,
    })
    expect(await api.op({ op: 'key-generate' })).toEqual([
      409,
      {
        ok: false,
        confirm: 'key',
        error:
          'A new key replaces this one: the server needs its public key before the tunnel works again. Replace it?',
      },
    ])
    expect(await api.op({ op: 'key-generate', replace: true })).toEqual([200, { ok: true, publicKey }])
  })

  test('Test connection with the tunnel off: an ssh of its own, to a listener for its probe only, ended after', async () => {
    const before = ssh.sshCalls().length
    const pidsBefore = ssh.pids().length
    const [status, answer] = await api.op({ op: 'test' })
    expect(status).toBe(200)
    expect(answer.ok).toBe(true)
    const steps = answer.steps as { id: string; ok: boolean | null }[]
    expect(steps.map(s => [s.id, s.ok])).toEqual([
      ['ssh', true],
      ['forward', true],
      ['domain', true],
    ])
    expect(ssh.sshCalls().length - before).toBe(1)
    const ran = ssh.pids().slice(pidsBefore)
    expect(ran).toHaveLength(1)
    await until(() => !alive(ran[0] as number))
    expect(existsSync(join(state, 'tunnel', 'ssh-pid.json'))).toBe(false)
    // its first connection pinned the server's key
    expect((await api.view()).tunnel.hostKey).toBe(FINGERPRINT)
  }, 60_000)

  test('"Do it myself": its one command for these settings and the key, and Test finding the public port', async () => {
    const res = await fetch(`${url}/api/access/server-command`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Reply
    expect(body.ok).toBe(true)
    for (const line of [body.command, body.undoCommand])
      expect(line).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| gunzip \| sh$/)
    expect(body.script).toContain(`W_DOMAIN = "${DOMAIN}"`)
    expect(body.script).toContain(`W_KEY = "${PUBLIC_KEY} agent-board@${hostname()}"`)
    expect(body.undoScript).toContain(`W_DOMAIN = "${DOMAIN}"`)

    // no setup recorded: the domain tried on 443 first; the board answers there (the fake's proxy)
    const before = readFileSync(configPath, 'utf8')
    const [status, answer] = await api.op({ op: 'test', findPort: true })
    expect(status).toBe(200)
    expect((answer.steps as { id: string; ok: boolean | null }[]).map(s => [s.id, s.ok])).toEqual([
      ['ssh', true],
      ['forward', true],
      ['domain', true],
    ])
    expect(answer.publicPort).toBe(443)
    expect(readFileSync(configPath, 'utf8')).toBe(before)

    // a setup recorded: Test as it always is, the flag left aside
    const cfg = JSON.parse(before) as Record<string, Record<string, unknown>>
    await writeConfig({
      ...cfg,
      tunnel: { ...cfg.tunnel, setup: { case: '1', address: `https://${DOMAIN}`, at: 'x' } },
    })
    const [, plain] = await api.op({ op: 'test', findPort: true })
    expect(Object.keys(plain).sort()).toEqual(['ok', 'steps'])
    await writeConfig(cfg)
  }, 60_000)

  test('the view asks ssh-keygen again only once the key’s or the server key’s file changed', async () => {
    // The panel fetches the view on every change of the board's access (a failed sign-in through
    // the domain, say): the key and the pinned server key are read once while their files stay.
    const asked = (from: number): string[] =>
      ssh
        .keygenCalls()
        .slice(from)
        .map(a => a[0] ?? '')
    const v = await api.view()
    expect([v.tunnel.key.publicKey, v.tunnel.hostKey]).toEqual([`${PUBLIC_KEY} agent-board@${hostname()}`, FINGERPRINT])
    const before = ssh.keygenCalls().length
    expect(await api.view()).toEqual(v)
    expect(await api.view()).toEqual(v)
    expect(asked(before)).toEqual([])
    // The key's file changed: its public half is read again, the server's key is not.
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(state, 'tunnel', 'id_ed25519'), later, later)
    expect(await api.view()).toEqual(v)
    expect(asked(before)).toEqual(['-y'])
    // known_hosts changed: the server's key is read again.
    utimesSync(join(state, 'tunnel', 'known_hosts'), later, later)
    expect(await api.view()).toEqual(v)
    expect(await api.view()).toEqual(v)
    expect(asked(before)).toEqual(['-y', '-l'])
    // Generate key: the new key shows at once.
    expect((await api.op({ op: 'key-generate', replace: true }))[0]).toBe(200)
    const made = ssh.keygenCalls().length
    expect((await api.view()).tunnel.key.publicKey).toBe(`${PUBLIC_KEY} agent-board@${hostname()}`)
    expect(asked(made)).toEqual(['-y'])
  })

  test('On: the board runs the tunnel’s ssh, the domain reaches it, and Test runs no ssh of its own', async () => {
    const rev = await api.accessRev()
    const before = ssh.sshCalls().length
    expect(await opReloaded({ op: 'on' })).toEqual([200, { ok: true }])
    const v = await api.viewWhen(x => x.tunnel.status.state === 'connected')
    expect(v.tunnel.settings.on).toBe(true)
    expect(v.tunnel.hostKey).toBe(FINGERPRINT)
    expect(await api.accessRev()).not.toBe(rev)
    const conf = tunnelConfig({ ...settings, on: true })
    const line = sshArgs({
      conf,
      key: join(state, 'tunnel', 'id_ed25519'),
      knownHosts: join(state, 'tunnel', 'known_hosts'),
      target: tunnelPort,
    })
    expect(line).toContain(`/var/lib/boardtunnel/board.sock:127.0.0.1:${tunnelPort}`)
    expect(ssh.sshCalls().slice(before)).toEqual([line])
    const record = JSON.parse(readFileSync(join(state, 'tunnel', 'ssh-pid.json'), 'utf8')) as Reply
    expect(record).toMatchObject({ forward: forwardSpec(conf.socket, tunnelPort) })
    expect(alive(Number(record.pid))).toBe(true)

    // Through the fake's proxy (Caddy), the tunnel listener: the reduced hello before a login.
    const hello = await fetch(`http://127.0.0.1:${proxyPort}/api/hello`)
    expect(await hello.json()).toEqual({
      board: 'agent-board',
      api: REMOTE_API,
      auth: 'login',
      signedIn: false,
      language: 'en',
    })

    const [status, answer] = await api.op({ op: 'test' })
    expect(status).toBe(200)
    expect((answer.steps as { id: string; ok: boolean | null }[]).map(s => [s.id, s.ok])).toEqual([
      ['ssh', true],
      ['forward', true],
      ['domain', true],
    ])
    expect(ssh.sshCalls().slice(before)).toEqual([line])
  }, 60_000)

  test('the domain changed while passkeys or logins exist: asked first, then they all go', async () => {
    writeState(box, 'access-logins.json', [seededLogin({ token: LOGIN })])
    const passkey = {
      id: 'pk1',
      jwk: { kty: 'EC' },
      alg: -7,
      counter: 0,
      transports: [],
      label: 'Safari on iPad',
      addedAt: Date.now(),
      usedAt: null,
    }
    writeState(box, 'access-passkeys.json', [passkey])
    const tunnel = `http://127.0.0.1:${tunnelPort}`
    const cookie = `__Host-board-login=${LOGIN}`
    expect((await viaCaddy(tunnel, cookie).get('/api/board')).status).toBe(200)
    const before = readFileSync(configPath, 'utf8')
    expect(await api.op({ op: 'tunnel', fields: { domain: 'other.example.com' } })).toEqual([
      409,
      {
        ok: false,
        confirm: 'domain',
        error:
          'Changing the domain removes every passkey (they belong to the old one) and ends every login. Change it?',
      },
    ])
    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect((await api.view()).login.passkeys).toHaveLength(1)
    // The same domain again changes nothing that needs asking.
    expect(await api.op({ op: 'tunnel', fields: { domain: DOMAIN } })).toEqual([200, { ok: true }])

    expect(await opReloaded({ op: 'tunnel', fields: { domain: 'other.example.com' }, confirm: true })).toEqual([
      200,
      { ok: true },
    ])
    const v = await api.view()
    expect(v.tunnel.settings.domain).toBe('other.example.com')
    expect([v.login.passkeys, v.logins]).toEqual([[], []])
    // Once the listener answers for the new domain: the login ended with the old one.
    const asNew = () =>
      fetch(`${tunnel}/api/board`, { headers: { host: 'other.example.com', 'x-forwarded-proto': 'https', cookie } })
    await eventually(async () => (await asNew()).status !== 403)
    expect((await asNew()).status).toBe(401)
    expect(await opReloaded({ op: 'tunnel', fields: { domain: DOMAIN } })).toEqual([200, { ok: true }])
  })

  test("Off: the tunnel's ssh ends, nothing listens; Forget the server's key", async () => {
    const record = JSON.parse(readFileSync(join(state, 'tunnel', 'ssh-pid.json'), 'utf8')) as Reply
    const pid = Number(record.pid)
    expect(alive(pid)).toBe(true)
    expect(await opReloaded({ op: 'off' })).toEqual([200, { ok: true }])
    const v = await api.viewWhen(x => x.tunnel.status.state === 'off')
    expect(v.tunnel.settings.on).toBe(false)
    await until(() => !alive(pid))
    await eventually(() => refuses(`http://127.0.0.1:${tunnelPort}`))
    expect(existsSync(join(state, 'tunnel', 'ssh-pid.json'))).toBe(false)

    expect(await api.op({ op: 'hostkey-forget' })).toEqual([200, { ok: true }])
    expect((await api.view()).tunnel.hostKey).toBeNull()
  })

  test("setting up the server: the admin's fields checked as the tunnel's, and the first Look pins the server's key", async () => {
    const before = readFileSync(configPath, 'utf8')
    expect(await api.op({ op: 'server-admin', user: '-l' })).toEqual([
      409,
      { ok: false, hint: null, field: 'user', error: 'The user is a plain user name, without a leading dash' },
    ])
    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect(await opReloaded({ op: 'server-admin', user: 'admin' })).toEqual([200, { ok: true }])
    expect(((JSON.parse(readFileSync(configPath, 'utf8')) as Reply).tunnel as Reply).admin).toEqual({ user: 'admin' })
    expect((await api.view()).server).toMatchObject({ admin: { user: 'admin', key: '' }, phase: 'idle', plan: null })
    // the key was forgotten above: the admin's first login pins the one it meets (the fake's server
    // has nothing for Look to read)
    const [status, refused] = await api.op({ op: 'server-look' })
    expect([status, refused.ok, refused.hint]).toEqual([409, false, 'unreadable'])
    // the admin's line is the one with -T and no -R: the probe pinned the key, the round after held to it
    const strictness = ssh
      .keygenCalls()
      .filter(a => a.includes('-T'))
      .map(a => a.find(o => o.startsWith('StrictHostKeyChecking=')))
    expect(strictness).toEqual(['StrictHostKeyChecking=accept-new', 'StrictHostKeyChecking=yes'])
    const v = await api.view()
    expect(v.tunnel.hostKey).toBe(FINGERPRINT)
    expect(v.server).toMatchObject({ hostKey: { fingerprint: FINGERPRINT, pinnedNow: true }, hint: 'unreadable' })
    expect(await api.op({ op: 'server-apply', plan: 'r1' })).toMatchObject([409, { ok: false, hint: 'lookAgain' }])
    expect(await api.op({ op: 'server-look', password: 'a\nb' })).toEqual([400, { ok: false, error: 'password' }])
  })
})

describe('the board restarts: never two ssh, and none left behind', () => {
  /** The config of a board with the tunnel on, on these ports. */
  const boardConfig = (ports: { web: number; tunnel: number }) => ({
    language: 'en',
    port: ports.web,
    tunnel: { on: true, host: 'ssh.example.com', user: 'boardtunnel', domain: DOMAIN, port: ports.tunnel },
  })
  /** A board with the tunnel on and the login set up, on these ports, with the fake as ssh. */
  async function startBoard(box: Sandbox, ports: { web: number; tunnel: number; proxy: number }) {
    const { proc } = await serveBoard(box, boardConfig(ports), await fakeEnv(box, ports.proxy))
    return { proc, api: local(`http://127.0.0.1:${ports.web}`) }
  }

  test('a stray ssh a board before left (its pid recorded) is ended before the tunnel starts', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const at = await freePorts()
    const ssh = fakeSsh(box, at.proxy)
    const state = stateFolder(box)
    const conf = tunnelConfig({ host: 'ssh.example.com', user: 'boardtunnel', domain: DOMAIN, port: at.tunnel })
    const line = sshArgs({
      conf,
      key: join(state, 'tunnel', 'id_ed25519'),
      knownHosts: join(state, 'tunnel', 'known_hosts'),
      target: at.tunnel,
    })
    // The stray, planted: the tunnel's line, started by this test with an environment that would
    // not end it with its parent, so only the board can.
    const { BUN_FEATURE_FLAG_NO_ORPHANS: _, ...env } = box.env
    const stray = Bun.spawn([await fakeSshBin(), ...line], {
      env: { ...env, FAKE_SSH_STATE: ssh.stateFile, FAKE_SSH_LOG: ssh.log },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    onTestFinished(() => {
      if (alive(stray.pid)) stray.kill()
    })
    let said = ''
    void (async () => {
      for await (const chunk of stray.stderr) said += new TextDecoder().decode(chunk)
    })()
    await until(() => said.includes('remote forward success'), 10_000)
    mkdirSync(join(state, 'tunnel'), { recursive: true })
    writeFileSync(
      join(state, 'tunnel', 'ssh-pid.json'),
      JSON.stringify({ pid: stray.pid, forward: forwardSpec(conf.socket, at.tunnel), at: Date.now() }),
    )

    const { api, proc } = await startBoard(box, at)
    await api.viewWhen(v => v.tunnel.status.state === 'connected', 30_000)
    expect(alive(stray.pid)).toBe(false)
    expect(logged(proc, `tunnel: no ssh a board before left runs any more (pid ${stray.pid})`)).toBe(true)
    const running = ssh.pids().filter(alive)
    expect(running).toHaveLength(1)
    const record = JSON.parse(readFileSync(join(state, 'tunnel', 'ssh-pid.json'), 'utf8')) as Reply
    expect(running).toEqual([Number(record.pid)])
    expect(ssh.sshCalls()).toEqual([line, line])
  }, 60_000)

  test('a board killed hard, then another on the same ports and state: one ssh, the first one’s gone', async () => {
    // The sandbox's no-orphans flag alone ends board A's fake ssh with A; the planted stray above
    // is what shows the board ending one itself.
    const box = await sandbox()
    await seedAccess(box)
    const at = await freePorts()
    const ssh = fakeSsh(box, at.proxy)
    const a = await startBoard(box, at)
    await a.api.viewWhen(v => v.tunnel.status.state === 'connected', 30_000)
    const record = JSON.parse(readFileSync(join(stateFolder(box), 'tunnel', 'ssh-pid.json'), 'utf8')) as Reply
    const first = Number(record.pid)
    a.proc.kill()
    await a.proc.exited

    const b = await startBoard(box, at)
    const v = await b.api.viewWhen(x => x.tunnel.status.state === 'connected', 30_000)
    expect(v.tunnel.status.state).toBe('connected')
    expect(alive(first)).toBe(false)
    expect(ssh.pids().filter(alive)).toHaveLength(1)
  }, 60_000)

  test('a second board that cannot take the web port leaves the first one’s ssh and its record alone', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const at = await freePorts()
    const ssh = fakeSsh(box, at.proxy)
    const a = await startBoard(box, at)
    await a.api.viewWhen(v => v.tunnel.status.state === 'connected', 30_000)
    const recordFile = join(stateFolder(box), 'tunnel', 'ssh-pid.json')
    const record = readFileSync(recordFile, 'utf8')
    const pid = Number((JSON.parse(record) as Reply).pid)
    const calls = ssh.sshCalls().length

    // The same settings, state and web port: it cannot listen there, and ends.
    const b = box.run(
      'server',
      {
        categories: [{ id: 'other', title: 'Other', color: 'gray' }],
        wakeUrl: null,
        refreshSec: 3600,
        ...boardConfig(at),
      },
      await fakeEnv(box, at.proxy),
    )
    onTestFinished(() => b.kill())
    const ended = await Promise.race([b.exited, Bun.sleep(30_000).then(() => null)])
    expect(ended?.code).not.toBe(0)
    expect(b.messages.some(m => (m as { ready?: boolean }).ready)).toBe(false)
    // Its ssh and its record are the first board's still; it started none of its own.
    expect(alive(pid)).toBe(true)
    expect(readFileSync(recordFile, 'utf8')).toBe(record)
    expect(ssh.sshCalls()).toHaveLength(calls)
    expect(ssh.pids().filter(alive)).toEqual([pid])
    expect((await a.api.view()).tunnel.status.state).toBe('connected')
  }, 60_000)
})

describe('config.json edited by hand while the tunnel is connected', () => {
  test('a host that fails its checks ends the ssh, and no ssh gets it, Test connection’s neither', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const at = await freePorts()
    const ssh = fakeSsh(box, at.proxy)
    const settings = { on: true, host: 'ssh.example.com', user: 'boardtunnel', domain: DOMAIN, port: at.tunnel }
    const good = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      port: at.web,
      tunnel: settings,
    }
    // The board reads config.json as it changes, as the real one does (TEST_LIVE_CONFIG).
    const configPath = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(join(configPath, '..'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(good, null, 2))
    const { proc } = await serveBoard(box, good, { ...(await fakeEnv(box, at.proxy)), TEST_LIVE_CONFIG: '1' })
    const api = local(`http://127.0.0.1:${at.web}`)
    await api.viewWhen(v => v.tunnel.status.state === 'connected', 30_000)
    // A key, so that Test connection gets past its first step.
    expect((await api.op({ op: 'key-generate' }))[0]).toBe(200)
    const recordFile = join(stateFolder(box), 'tunnel', 'ssh-pid.json')
    const state = stateFolder(box)
    const line = sshArgs({
      conf: tunnelConfig(settings),
      key: join(state, 'tunnel', 'id_ed25519'),
      knownHosts: join(state, 'tunnel', 'known_hosts'),
      target: at.tunnel,
    })

    for (const bad of ['-oProxyCommand=calc', 'a b', 'x@y']) {
      const pid = Number((JSON.parse(readFileSync(recordFile, 'utf8')) as Reply).pid)
      expect(alive(pid)).toBe(true)
      const before = reloads(proc)
      writeFileSync(configPath, JSON.stringify({ ...good, tunnel: { ...settings, host: bad } }, null, 2))
      await until(() => reloads(proc) > before)
      const v = await api.viewWhen(x => x.tunnel.status.state === 'off')
      expect(v.tunnel.problems.map(p => p.field)).toEqual(['host'])
      await until(() => !alive(pid))
      await until(() => !existsSync(recordFile))
      // Test connection takes the same settings (app.ts lineTo): no ssh of its own with them either.
      const [status, answer] = await api.op({ op: 'test' })
      expect(status).toBe(200)
      const steps = answer.steps as { id: string; ok: boolean | null; detail: string }[]
      expect(steps.map(s => [s.id, s.ok])).toEqual([
        ['ssh', true],
        ['forward', false],
        ['domain', null],
      ])
      expect(steps[1]?.detail).toBe('the settings do not check out')
      // A moment for an ssh that would start late.
      await Bun.sleep(500)
      expect(ssh.pids().filter(alive)).toEqual([])
      expect(ssh.sshCalls().filter(args => args.some(arg => arg.includes(bad)))).toEqual([])
      // Put right: the tunnel is back.
      writeFileSync(configPath, JSON.stringify(good, null, 2))
      await api.viewWhen(x => x.tunnel.status.state === 'connected', 30_000)
    }
    // Every ssh the board ran had the line that checks out.
    expect([...new Set(ssh.sshCalls().map(args => JSON.stringify(args)))]).toEqual([JSON.stringify(line)])
    expect(ssh.pids().filter(alive)).toHaveLength(1)
  }, 120_000)
})

/** The local board's event stream: each payload it pushed, oldest first. */
async function payloadsOf(url: string): Promise<{ payloads: Reply[]; close(): Promise<void> }> {
  const res = await fetch(`${url}/api/events`)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const payloads: Reply[] = []
  let rest = ''
  const read = (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (chunk.done) return
      rest += decoder.decode(chunk.value, { stream: true })
      const events = rest.split('\n\n')
      rest = events.pop() ?? ''
      for (const event of events)
        for (const line of event.split('\n'))
          if (line.startsWith('data: ')) payloads.push(JSON.parse(line.slice('data: '.length)) as Reply)
    }
  })()
  return {
    payloads,
    async close() {
      await reader.cancel().catch(() => {})
      await read
    },
  }
}

describe('failed sign-ins through the domain, many at once', () => {
  /** A passkey sign-in with no challenge of the board's: refused, and recorded as a failed one. */
  const WRONG_PASSKEY = { id: 'x', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } }

  test('the board goes out once for the burst and once after it, with the latest revision', async () => {
    const box = await sandbox()
    await seedAccess(box)
    // No ssh here: its error is retried in a minute, after this test.
    const { url, tunnel } = await startTunnelBoard(box)
    await eventually(async () => !(await refuses(tunnel)), 10_000)
    const stream = await payloadsOf(url)
    try {
      // The board's start (the listener, ssh not found) has gone out: nothing more for a while.
      for (let seen = -1; seen !== stream.payloads.length; ) {
        seen = stream.payloads.length
        await Bun.sleep(ACCESS_PUBLISH_MS + 500)
      }
      const from = stream.payloads.length
      const rev = Number(((await (await fetch(`${url}/api/board`)).json()) as Reply).accessRev)
      const caddy = viaCaddy(tunnel)
      const n = 30
      const started = Date.now()
      const statuses = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          caddy
            .post('/api/login/passkey', WRONG_PASSKEY, { 'x-forwarded-for': `198.51.100.${i + 1}` })
            .then(r => r.status),
        ),
      )
      const took = Date.now() - started
      expect(statuses).toEqual(Array<number>(n).fill(401))
      // The window after the last one: its change goes out too.
      await Bun.sleep(ACCESS_PUBLISH_MS + 700)
      const pushed = stream.payloads.slice(from)
      // Once at the first change and once at the end of its window: 2 for a burst within one
      // window (one more for each further window a slow machine took).
      expect(pushed.length).toBeGreaterThanOrEqual(1)
      expect(pushed.length).toBeLessThanOrEqual(1 + Math.max(1, Math.ceil(took / ACCESS_PUBLISH_MS)))
      // Each recorded failure counted; the last payload out carries them all.
      const last = Number(pushed.at(-1)?.accessRev)
      expect(last - rev).toBeGreaterThanOrEqual(n)
      expect(((await (await fetch(`${url}/api/board`)).json()) as Reply).accessRev).toBe(last)
      expect((await local(url).view()).attempts).toHaveLength(20)
    } finally {
      await stream.close()
    }
  }, 60_000)
})
