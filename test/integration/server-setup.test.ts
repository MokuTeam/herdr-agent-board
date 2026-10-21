// The server setup end to end (the server-setup spec's "Integration: a test server in Docker
// Desktop"), off unless BOARD_SERVER_IT=1: real Debian 13 and Ubuntu 26.04 servers side by side
// (and Ubuntu 24.04; Debian 12 and Ubuntu 22.04 with BOARD_SERVER_IT_ALL=1), each scenario
// prepared on a fresh one, and a sandboxed board doing what the owner does in the panel: the key,
// step 1 as the one paste, Test connection (it pins the server's key), Look, Apply, Apply again,
// Undo, through POST /api/access, with Windows' own ssh and sudo's password on its stdin. The
// domain is served with a certificate from the lane's Pebble (BOARD_SETUP_ACME_CA*), and reaches a
// stand-in board through the tunnel's own ssh line; the test's own fetches come from the lane's
// client container, while a watcher there fetches their sites all along.
//
// The board's probe reaches https://board.example.com from this PC through the lane's CONNECT
// proxy (HTTPS_PROXY) and trusts Pebble's root (NODE_EXTRA_CA_CERTS): the Test connection after
// Apply passes as it would on the internet. Then case 2 and a single-file mount when things go
// wrong: a wrong sudo password (also in Russian), their file changed since Look, a brace-less last
// site, a failing reload, a site that answers otherwise, the run told to stop or killed, the board's
// ssh killed, and logind's KillUserProcesses=yes.
//
// Long: BOARD_SERVER_IT=1 bun test test/integration/server-setup.test.ts --timeout 3600000 (about
// an hour). `-t <name>` runs some tests, BOARD_SERVER_IT_LANES=debian13,… some distributions,
// BOARD_IT_KEEP=1 keeps the images and the mirror for the next run, BOARD_IT_RESULTS=<file> writes
// the results' lines there. The run's log is printed at the start (harness.ts's work()).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { protectKey } from '../../src/adapters/ssh.ts'
import { type AccessView, isAccessView } from '../../src/core/access.ts'
import type { Manual, Plan, SetupCase } from '../../src/core/server-plan.ts'
import { CADDY_IMAGE, SOCAT_IMAGE } from '../../src/core/server-texts.ts'
import type { ServerView } from '../../src/core/server-view.ts'
import { forwardAccepted, sshArgs, tunnelConfig } from '../../src/core/tunnel.ts'
import { serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'
import {
  buildImage,
  closeLane,
  type Distro,
  docker,
  dockerUp,
  type Lane,
  note,
  PEBBLE_DIR,
  PEBBLE_ROOT_ON_SERVER,
  removeRun,
  removeStale,
  run,
  scenarioScript,
  startLane,
  startMirror,
  startServer,
  stepOneScript,
  type TestServer,
  until,
  work,
} from './server/harness.ts'
import { readEcho, rightmost, startStandin } from './standin.ts'

const ON = process.env.BOARD_SERVER_IT === '1'
const ALL = process.env.BOARD_SERVER_IT_ALL === '1'
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const SSH_EXE = join(SYSTEM32, 'OpenSSH', 'ssh.exe')
const KEYGEN_EXE = join(SYSTEM32, 'OpenSSH', 'ssh-keygen.exe')
const DOMAIN = 'board.example.com'
/** admin's sudo password on every server: the sentinel of the spec's constraints. */
const SENTINEL = 'S3cr3t%$\'"`Ж'
const MIN = 60_000

/** Debian 13 and Ubuntu 26.04 side by side; Ubuntu 24.04 (and with ALL Debian 12, Ubuntu 22.04) for three scenarios. */
const MAIN: Distro[] = ['debian13', 'ubuntu2604']
const MORE: Distro[] = ['ubuntu2404', ...(ALL ? (['debian12', 'ubuntu2204'] as Distro[]) : [])]
const LANES: Distro[] = [...MAIN, ...MORE].filter(
  d => !process.env.BOARD_SERVER_IT_LANES || process.env.BOARD_SERVER_IT_LANES.split(',').includes(d),
)

type Admin = 'admin' | 'nopw' | 'root'
interface Site {
  host: string
  port: number
  scheme: 'http' | 'https'
  body: string
}
interface Scenario {
  /** Its script in scenarios/ ('bare' has nothing to run). */
  script: string
  name: string
  withDocker: boolean
  env?: Record<string, string>
  admin: Admin
  expect: { case: SetupCase } | { manual: Manual }
  sites: Site[]
  /** Their files: hashed before Apply, after it, after Apply again and after Undo. */
  files: string[]
  /** Run on the server after the scenario (as root), before the board looks. */
  after?: string
  lanes: Distro[]
}

const A: Site = { host: 'a.example.com', port: 443, scheme: 'https', body: 'site a' }
const B: Site = { host: 'b.example.com', port: 443, scheme: 'https', body: 'site b' }
const COMPOSE = ['/srv/my web/Caddyfile', '/srv/my web/compose.yaml']
const NGINX = ['/etc/nginx/nginx.conf', '/etc/nginx/conf.d/site.conf']

const scenario = (s: Omit<Scenario, 'withDocker' | 'admin' | 'lanes' | 'script'> & Partial<Scenario>): Scenario => ({
  withDocker: true,
  admin: 'admin',
  lanes: MAIN,
  script: s.name,
  ...s,
})

const SCENARIOS: Scenario[] = [
  scenario({ name: 'bare', expect: { case: '1' }, sites: [], files: [], admin: 'nopw', lanes: LANES }),
  scenario({ name: 'nodocker', withDocker: false, expect: { case: '1' }, sites: [], files: [], lanes: LANES }),
  scenario({
    name: 'dummy80',
    expect: { case: '1b' },
    admin: 'root',
    sites: [{ host: 'dummy.example.com', port: 80, scheme: 'http', body: 'dummy80' }],
    files: ['/etc/systemd/system/dummy80.service'],
  }),
  // Ubuntu 22.04 has no caddy package (Debian 12 has 2.6.2): case 2 there is Caddy's own repository's, not tried here
  scenario({
    name: 'caddy-unit',
    expect: { case: '2' },
    sites: [A, B],
    files: ['/etc/caddy/Caddyfile'],
    lanes: LANES.filter(d => d !== 'ubuntu2204'),
  }),
  scenario({ name: 'compose-folder', expect: { case: '3a' }, sites: [A, B], files: COMPOSE }),
  scenario({ name: 'compose-file', expect: { case: '3a' }, sites: [A, B], files: COMPOSE }),
  scenario({ name: 'caddy-host', expect: { case: '3b' }, sites: [A, B], files: COMPOSE }),
  scenario({ name: 'caddy-bridge', expect: { manual: 'bridge' }, sites: [A, B], files: ['/srv/bridge/Caddyfile'] }),
  scenario({
    name: 'nginx-443',
    expect: { case: '4a' },
    sites: [{ host: 'site.example.com', port: 443, scheme: 'https', body: 'site' }],
    files: NGINX,
  }),
  scenario({
    name: 'nginx-80-443',
    expect: { case: '4b' },
    sites: [
      { host: 'site.example.com', port: 443, scheme: 'https', body: 'site' },
      { host: 'site.example.com', port: 80, scheme: 'http', body: 'site' },
    ],
    files: [...NGINX, '/etc/nginx/sites-enabled/default'],
    // their conf.d not 755: the board's file goes in, the folder's mode stays theirs
    after: 'chmod 750 /etc/nginx/conf.d',
  }),
  scenario({
    name: 'apache',
    expect: { manual: 'other80' },
    sites: [{ host: 'apache.example.com', port: 80, scheme: 'http', body: 'Apache' }],
    files: [],
  }),
  scenario({
    name: 'podman',
    script: 'faked',
    env: { FAKE: 'podman' },
    expect: { manual: 'podman' },
    sites: [],
    files: [],
  }),
  scenario({
    name: 'rootless',
    script: 'faked',
    env: { FAKE: 'rootless' },
    expect: { manual: 'rootless' },
    sites: [],
    files: [],
  }),
  scenario({
    name: 'selinux',
    script: 'faked',
    env: { FAKE: 'selinux' },
    expect: { manual: 'selinux' },
    sites: [],
    files: [],
  }),
]

/** One line per scenario and distribution, for the spec's record (printed at the end). */
const rows: string[] = []
const lanes = new Map<Distro, Lane>()
let adminKey = ''

// --- The board, as the panel drives it ----------------------------------------------------------------

type Reply = Record<string, unknown>

interface Board {
  box: Sandbox
  state: string
  configPath: string
  view(): Promise<AccessView>
  server(): Promise<ServerView>
  op(body: Record<string, unknown>): Promise<[number, Reply]>
  /** The server part of the view once `ok` holds, within `ms`. */
  serverWhen(ok: (v: ServerView) => boolean, ms: number, what: string): Promise<ServerView>
  tunnel(): Record<string, unknown>
}

async function startBoard(newBox: () => Promise<Sandbox>, l: Lane, s: TestServer, admin: Admin): Promise<Board> {
  const box = await newBox()
  const web = await unusedPort()
  const configPath = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  const cfg = {
    language: 'en',
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    refreshSec: 3600,
    port: web,
    tunnel: {
      host: '127.0.0.1',
      sshPort: s.sshPort,
      user: 'boardtunnel',
      domain: DOMAIN,
      admin: { user: admin, key: adminKey },
    },
  }
  mkdirSync(join(configPath, '..'), { recursive: true })
  writeFileSync(configPath, JSON.stringify(cfg, null, 2))
  l.proxy.routes.set(`${DOMAIN}:443`, s.https)
  l.proxy.routes.set(`${DOMAIN}:8443`, s.alt)
  // Windows' ssh and ssh-keygen end at once (255, not a word) without %ProgramData%, which the
  // sandbox's environment leaves out: a real board has the user's whole environment
  const windows = Object.fromEntries(
    ['ProgramData', 'SystemDrive', 'windir', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME'].flatMap(k =>
      process.env[k] ? [[k, process.env[k] as string]] : [],
    ),
  )
  await serveBoard(box, cfg, {
    ...windows,
    TEST_LIVE_CONFIG: '1',
    BOARD_SSH_BIN_PATH: SSH_EXE,
    BOARD_SSH_KEYGEN_BIN_PATH: KEYGEN_EXE,
    BOARD_SETUP_ACME_CA: PEBBLE_DIR,
    BOARD_SETUP_ACME_CA_ROOT: PEBBLE_ROOT_ON_SERVER,
    HTTPS_PROXY: l.proxy.url,
    NO_PROXY: '127.0.0.1,localhost',
    NODE_EXTRA_CA_CERTS: l.rootFile,
  })
  const url = `http://127.0.0.1:${web}`
  const view = async (): Promise<AccessView> => {
    const v: unknown = await (await fetch(`${url}/api/access`)).json()
    if (!isAccessView(v)) throw new Error(`not a view: ${JSON.stringify(v).slice(0, 300)}`)
    return v
  }
  const server = async (): Promise<ServerView> => {
    const v = (await view()).server
    if (!v) throw new Error('no server view')
    return v
  }
  return {
    box,
    state: stateFolder(box),
    configPath,
    view,
    server,
    async op(body) {
      const res = await fetch(`${url}/api/access`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })
      const reply = (await res.json()) as Reply
      note(`board ${l.distro} ${String(body.op)} → ${res.status} ${JSON.stringify(reply).slice(0, 400)}`)
      return [res.status, reply]
    },
    async serverWhen(ok, ms, what) {
      let last: ServerView | null = null
      await until(
        what,
        async () => {
          last = await server()
          return ok(last)
        },
        ms,
        500,
      )
      return last as unknown as ServerView
    },
    tunnel() {
      const c = JSON.parse(readFileSync(configPath, 'utf8')) as { tunnel?: Record<string, unknown> }
      return c.tunnel ?? {}
    },
  }
}

const passwordFor = (admin: Admin): Record<string, string> => (admin === 'admin' ? { password: SENTINEL } : {})

/** The board's key made, step 1 pasted on the server with it, Test connection (it pins the server's key). */
async function stepOneAndTest(b: Board, s: TestServer): Promise<void> {
  expect((await b.op({ op: 'key-generate' }))[0]).toBe(200)
  const publicKey = (await b.view()).tunnel.key.publicKey
  if (!publicKey) throw new Error('no public key')
  await s.sh(stepOneScript(), { args: [publicKey] })
  // the paste is safe twice
  await s.sh(stepOneScript(), { args: [publicKey] })
  const [status, reply] = await b.op({ op: 'test' })
  expect(status).toBe(200)
  const steps = reply.steps as { id: string; ok: boolean | null }[]
  expect(steps.find(x => x.id === 'ssh')?.ok).toBe(true)
  expect(steps.find(x => x.id === 'forward')?.ok).toBe(true)
}

async function look(b: Board, admin: Admin, op = 'server-look'): Promise<[number, Reply, ServerView]> {
  const [status, reply] = await b.op({ op, ...passwordFor(admin) })
  return [status, reply, await b.server()]
}

/** Apply (or Undo) of the plan the last Look made, followed to its end. */
async function runPlan(b: Board, admin: Admin, p: Plan, op = 'server-apply'): Promise<ServerView> {
  const [status, reply] = await b.op({
    op,
    plan: p.id,
    ...(p.ticks.includes('docker') ? { docker: true } : {}),
    ...passwordFor(admin),
  })
  if (status !== 200) throw new Error(`${op}: ${status} ${JSON.stringify(reply)}`)
  return b.serverWhen(v => v.phase === 'done' || v.phase === 'failed', 20 * MIN, `${op} ends`)
}

/** A run's story in one line: each step's state, the rollback, the result. */
const story = (v: ServerView): string =>
  `${v.progress?.steps.map(x => `${x.id}:${x.state}`).join(' ')} | undo ${JSON.stringify(v.progress?.undo)} | ${v.progress?.result} | hint ${v.hint} | ${v.error ?? ''}`

function failedOutput(v: ServerView): string {
  const bad = v.progress?.steps.find(x => x.state === 'fail')
  return bad ? `${bad.id}: ${bad.out.slice(-15).join('\n')}` : ''
}

// --- What the test checks on the server and from the client -------------------------------------------

const fetchCmd = (s: TestServer, site: Site, o = ''): string =>
  `curl -sk -m 10 ${o} --resolve ${site.host}:${site.port}:${s.ip} ${site.scheme}://${site.host}:${site.port}/`

/** Each of their sites answers 200 with its page, from the client. */
async function sitesAnswer(l: Lane, s: TestServer, sites: Site[]): Promise<string[]> {
  const bad: string[] = []
  for (const site of sites) {
    const r = await l.client(`${fetchCmd(s, site, "-w '\\n%{http_code}'")}`, { check: false })
    const lines = r.stdout.trimEnd().split('\n')
    const code = lines.at(-1)
    if (code !== '200' || !r.stdout.includes(site.body)) bad.push(`${site.scheme}://${site.host}:${site.port} ${code}`)
  }
  return bad
}

/** A loop in the client fetching their sites twice a second until stopped: what did not answer 200. */
async function watchSites(l: Lane, s: TestServer, sites: Site[], tag: string): Promise<() => Promise<string[]>> {
  if (!sites.length) return async () => []
  const file = `/tmp/watch-${tag}`
  const each = sites
    .map(
      site =>
        `printf '%s %s %s\\n' "$(date +%T.%N)" ${site.host}:${site.port} "$(${fetchCmd(s, site, "-o /dev/null -w '%{http_code}'")})"`,
    )
    .join('; ')
  await l.clientBackground(
    `rm -f ${file} ${file}.stop; while [ ! -e ${file}.stop ]; do { ${each}; } >> ${file}; sleep 0.5; done`,
  )
  return async () => {
    await l.client(`touch ${file}.stop; sleep 1.5; cat ${file}`)
    const out = (await l.client(`cat ${file}`)).stdout
    const lines = out.split('\n').filter(Boolean)
    note(`watch ${tag}: ${lines.length} fetches`)
    if (lines.length < sites.length) return ['the watcher did not fetch']
    return lines.filter(line => !line.endsWith(' 200'))
  }
}

/** The ids of every container on the server. */
async function containerIds(s: TestServer): Promise<string> {
  return (await s.sh('docker ps -aq --no-trunc | sort')).stdout.trim()
}

/** What of the board's is left on the server: containers, volumes, files, lines and blocks in their files. */
async function leftovers(s: TestServer, files: string[]): Promise<string> {
  const out = await s.sh(
    `{ docker ps -a --format '{{.Names}} {{.Labels}}' 2>/dev/null | grep agent-board
docker volume ls -q 2>/dev/null | grep agent-board
for f in /etc/agent-board /etc/caddy/agent-board /etc/nginx/conf.d/agent-board.conf; do [ -e "$f" ] && echo "$f"; done
for f in "$@"; do [ -f "$f" ] && grep -l agent-board "$f"; done; } || true`,
    { args: files },
  )
  return out.stdout.trim()
}

/** The sentinel in no file under /etc/agent-board or /var/log on the server. */
async function sentinelOnServer(s: TestServer): Promise<string> {
  const out = await s.sh('grep -rlaF -e "$S" /etc/agent-board /var/log 2>/dev/null || true', { env: { S: SENTINEL } })
  return out.stdout.trim()
}

/** The sentinel in no file under the board's sandbox on this PC. */
function sentinelInSandbox(dir: string): string[] {
  const found: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.size < 50 << 20 && readFileSync(p).includes(Buffer.from(SENTINEL))) found.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return found
}

/** The board's own ssh line (core/tunnel.ts sshArgs) to the stand-in: the domain reaches it through the socket. */
async function tunnelToStandin(b: Board, port: number): Promise<() => Promise<void>> {
  const conf = tunnelConfig(b.tunnel())
  const args = sshArgs({
    conf,
    key: join(b.state, 'tunnel', 'id_ed25519'),
    knownHosts: join(b.state, 'tunnel', 'known_hosts'),
    target: port,
  })
  const proc = Bun.spawn([SSH_EXE, ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', windowsHide: true })
  const reader = proc.stderr.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  let up = false
  const seen: string[] = []
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      const lines = (rest + decoder.decode(value, { stream: true })).split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (forwardAccepted(line, conf.socket)) up = true
        if (!line.startsWith('debug')) seen.push(line)
      }
    }
  })()
  await until(
    `the tunnel's forward (${seen.slice(-3).join(' | ')})`,
    async () => up || proc.exitCode !== null,
    30_000,
    100,
  )
  if (!up) throw new Error(`the tunnel did not come up: ${seen.join('\n')}`)
  return async () => {
    proc.kill()
    await proc.exited
    await drain.catch(() => {})
  }
}

/** https://board.example.com (or :8443) from the client, its certificate checked against Pebble's root: the stand-in's echo. */
async function domainFromClient(
  l: Lane,
  s: TestServer,
  port: number,
  ms = 3 * MIN,
): Promise<ReturnType<typeof readEcho>> {
  const url = `https://${DOMAIN}${port === 443 ? '' : `:${port}`}/echo`
  let echo: ReturnType<typeof readEcho> = null
  let last = ''
  await until(
    `${DOMAIN}:${port} answers from the client (${last})`,
    async () => {
      const r = await l.client(`curl -sS -m 10 --cacert /root.pem --resolve ${DOMAIN}:${port}:${s.ip} ${url}`, {
        check: false,
      })
      last = (r.stderr || r.stdout).trim().slice(0, 200)
      echo = readEcho(r.stdout)
      return echo !== null
    },
    ms,
    2000,
  )
  return echo
}

// --- One scenario on one server --------------------------------------------------------------------------

async function prepare(l: Lane, sc: Scenario, tag: string): Promise<TestServer> {
  const s = await startServer(l, { tag, withDocker: sc.withDocker, adminKey, password: SENTINEL })
  if (sc.script !== 'bare') {
    if (sc.script === 'faked') await s.sh(scenarioScript('bare'))
    await s.sh(scenarioScript(sc.script), {
      env: { THEIR_ACME: PEBBLE_DIR, THEIR_ACME_ROOT: PEBBLE_ROOT_ON_SERVER, ...sc.env },
      timeoutMs: 10 * MIN,
    })
  }
  if (sc.after) await s.sh(sc.after)
  await l.addA(DOMAIN, s.ip)
  return s
}

async function fullRun(newBox: () => Promise<Sandbox>, l: Lane, sc: Scenario): Promise<void> {
  const row = [`${sc.name} on ${l.distro} (${sc.admin})`]
  const s = await prepare(l, sc, sc.name)
  try {
    if (sc.name === 'bare')
      row.push(
        (
          await s.sh(
            '. /etc/os-release; printf "%s, %s, %s, Docker %s (%s)" "$PRETTY_NAME" "$(sudo --version | head -n 1)" "$(ssh -V 2>&1)" "$(docker version --format "{{.Server.Version}}")" "$(docker info --format "{{index .DriverStatus 0}}")"',
          )
        ).stdout.trim(),
      )
    if (sc.name === 'caddy-unit')
      row.push(`their Caddy ${(await s.sh('STEPPATH=/ caddy version | cut -d " " -f 1')).stdout.trim()}`)
    const b = await startBoard(newBox, l, s, sc.admin)
    await stepOneAndTest(b, s)
    const [status, reply, seen] = await look(b, sc.admin)
    expect(status, JSON.stringify(reply)).toBe(200)
    if ('manual' in sc.expect) {
      expect(seen.choice?.case ?? null).toBeNull()
      expect(seen.choice?.why).toContain(sc.expect.manual)
      expect(seen.plan).toBeNull()
      expect(await sitesAnswer(l, s, sc.sites)).toEqual([])
      row.push(`Look: Do it myself (${JSON.stringify(seen.choice?.why)}), no plan to apply`)
      return
    }
    const want = sc.expect.case
    expect(seen.choice?.case).toBe(want)
    const p = seen.plan
    if (!p) throw new Error('no plan')
    expect(p.kind).toBe('apply')
    const four = want === '4a' || want === '4b'
    expect(p.address).toBe(four ? `https://${DOMAIN}:8443` : `https://${DOMAIN}`)
    expect(p.ticks.includes('docker')).toBe(!sc.withDocker)
    row.push(`Look: case ${want}`)

    const before = await s.hashes(sc.files)
    expect(await sitesAnswer(l, s, sc.sites)).toEqual([])
    const confMode = sc.after ? (await s.sh('stat -c %a /etc/nginx/conf.d')).stdout.trim() : ''
    const stopWatch = await watchSites(l, s, sc.sites, `${l.distro}-${sc.name}`)

    // Apply
    const applied = await runPlan(b, sc.admin, p)
    if (applied.progress?.result !== 'applied') throw new Error(`Apply: ${story(applied)}\n${failedOutput(applied)}`)
    expect(applied.phase).toBe('done')
    expect(applied.setup?.case).toBe(want)
    const domainStep = applied.testAfter?.find(x => x.id === 'domain')
    // Case 2's Caddy is the distribution's 2.6.2: when Pebble's finalize answers "processing", its
    // ACME client cannot read Pebble's Retry-After (an HTTP date) and tries again a minute later,
    // after the board's 2 minutes of Test now and then. A CA's seconds it reads; the newer Caddy of
    // the other cases reads both. There the client below waits for the certificate longer.
    const slowCert = want === '2' && domainStep?.ok !== true
    if (!slowCert) expect(domainStep?.ok, JSON.stringify(applied.testAfter)).toBe(true)
    expect(b.tunnel().publicPort).toBe(four ? 8443 : undefined)
    expect(await sitesAnswer(l, s, sc.sites)).toEqual([])
    if (sc.after) expect((await s.sh('stat -c %a /etc/nginx/conf.d')).stdout.trim()).toBe(confMode)

    // the domain through the tunnel's socket, from the client, with Pebble's certificate
    const standin = startStandin()
    const stopTunnel = await tunnelToStandin(b, standin.port)
    try {
      const port = four ? 8443 : 443
      const echo = await domainFromClient(l, s, port, slowCert ? 8 * MIN : 3 * MIN)
      expect(echo?.host).toBe(four ? `${DOMAIN}:8443` : DOMAIN)
      expect(echo?.proto).toBe('https')
      const caller = rightmost(echo?.forwardedFor ?? null)
      note(`${l.distro} ${sc.name}: the stand-in saw X-Forwarded-For ${echo?.forwardedFor} (client ${l.ip.client})`)
      expect(caller).toBe(l.ip.client)
      row.push(
        `Apply: applied, Test connection's domain ${slowCert ? `✗ (${domainStep?.detail}: their Caddy 2.6.2 and Pebble's Retry-After), later ✓ from the client` : '✓'}, ${DOMAIN}${four ? ':8443' : ''} → stand-in (Pebble's certificate, X-Forwarded-Proto https, caller ${caller})`,
      )
    } finally {
      await stopTunnel()
      standin.stop()
    }

    // Apply again: nothing to change
    const afterApply = await s.hashes(sc.files)
    const ids = await containerIds(s)
    const [againStatus, , again] = await look(b, sc.admin)
    expect(againStatus).toBe(200)
    expect(again.plan?.kind).toBe('nothing')
    const twice = await runPlan(b, sc.admin, again.plan as Plan)
    if (twice.progress?.result !== 'applied') throw new Error(`Apply again: ${story(twice)}`)
    expect(await s.hashes(sc.files)).toEqual(afterApply)
    expect(await containerIds(s)).toBe(ids)
    row.push('again: nothing to change (hashes, container ids the same)')

    // the sudo password: in no file of the server's records and logs
    expect(await sentinelOnServer(s)).toBe('')

    // Undo
    const [undoStatus, undoReply, undoSeen] = await look(b, sc.admin, 'server-undo-look')
    expect(undoStatus, JSON.stringify(undoReply)).toBe(200)
    const u = undoSeen.plan
    if (!u) throw new Error('no Undo plan')
    expect(u.kind).toBe('undo')
    const undone = await runPlan(b, sc.admin, u, 'server-undo')
    if (undone.progress?.result !== 'applied') throw new Error(`Undo: ${story(undone)}\n${failedOutput(undone)}`)
    expect(undone.setup).toBeNull()
    expect(b.tunnel().publicPort).toBeUndefined()
    expect(await s.hashes(sc.files)).toEqual(before)
    expect(await leftovers(s, sc.files)).toBe('')
    expect((await s.sh('stat -c %G /var/lib/boardtunnel')).stdout.trim()).toBe('boardtunnel')
    expect((await s.sh('docker version --format "{{.Server.Version}}"')).stdout.trim()).not.toBe('')
    // the board's images go when it pulled them (by tag and digest, under containerd's image store)
    const images = (await s.sh("docker image ls --digests --format '{{.Repository}}@{{.Digest}}'")).stdout
    if (!sc.script.startsWith('compose') && !sc.script.startsWith('caddy-'))
      expect(images).not.toContain((CADDY_IMAGE.split('@')[1] as string).slice(0, 20))
    expect(images).not.toContain((SOCAT_IMAGE.split('@')[1] as string).slice(0, 20))
    if (sc.after) expect((await s.sh('stat -c %a /etc/nginx/conf.d')).stdout.trim()).toBe(confMode)
    expect(await sitesAnswer(l, s, sc.sites)).toEqual([])
    row.push('Undo: their files as before, nothing of the board left, Docker kept')

    expect(await stopWatch()).toEqual([])
    expect(await sentinelOnServer(s)).toBe('')
    expect(sentinelInSandbox(b.box.dir)).toEqual([])
  } catch (err) {
    row.push(`FAILED: ${String(err).split('\n')[0]}`)
    await diagnose(s)
    throw err
  } finally {
    rows.push(row.join('; '))
    await s.stop()
  }
}

/** What the server says of its web servers and the board's runs, into the run's log, after a failure. */
async function diagnose(s: TestServer): Promise<void> {
  const out = await s.sh(
    `for u in caddy nginx; do systemctl is-active --quiet $u 2>/dev/null && journalctl -u $u --no-pager -n 30 -o cat; done
docker ps -a 2>/dev/null
for c in $(docker ps -aq --filter label=agent-board.role 2>/dev/null) $(docker ps -q --filter name=caddy 2>/dev/null); do docker logs --tail 30 "$c" 2>&1; done
tail -n 60 "$(ls -t /etc/agent-board/runs/*.log 2>/dev/null | head -n 1)" 2>/dev/null
cat /etc/agent-board/setup.json 2>/dev/null`,
    { check: false },
  )
  note(`diagnose ${s.name}:\n${out.stdout}\n${out.stderr}`)
}

/** Each lane's run at once; every lane's failure, after all of them ended. */
async function onLanes(all: Distro[], fn: (l: Lane) => Promise<void>): Promise<void> {
  // BOARD_SERVER_IT_LANES=ubuntu2404,…: only those distributions (while working on one)
  const only = process.env.BOARD_SERVER_IT_LANES?.split(',')
  const ds = only ? all.filter(d => only.includes(d)) : all
  const results = await Promise.allSettled(
    ds.map(d => {
      const l = lanes.get(d)
      if (!l) throw new Error(`no lane ${d}`)
      return fn(l)
    }),
  )
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [`${ds[i]}: ${String(r.reason?.stack ?? r.reason)}`] : [],
  )
  if (failed.length) throw new Error(failed.join('\n\n'))
}

// --- The tests ------------------------------------------------------------------------------------------

describe.skipIf(!ON)('the server setup on Debian and Ubuntu test servers', () => {
  const newBox = sharedSandbox()

  beforeAll(async () => {
    console.log(`server-setup: the run's log is ${join(work(), 'run.log')}`)
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    adminKey = join(work(), 'admin_ed25519')
    await run([KEYGEN_EXE, '-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board-it', '-f', adminKey])
    const rights = await protectKey(adminKey)
    if (!rights.ok) throw new Error(rights.error)
    await startMirror()
    // each distribution's two images at once, the distributions side by side
    await Promise.all(LANES.map(async d => Promise.all([buildImage(d, true), buildImage(d, false)])))
    for (const l of await Promise.all(LANES.map(d => startLane(d)))) lanes.set(l.distro, l)
  }, 60 * MIN)

  afterAll(async () => {
    for (const l of lanes.values()) closeLane(l)
    console.log(`server-setup results:\n${rows.join('\n')}`)
    if (process.env.BOARD_IT_RESULTS) writeFileSync(process.env.BOARD_IT_RESULTS, `${rows.join('\n')}\n`)
    await removeRun()
  }, 20 * MIN)

  for (const sc of SCENARIOS)
    test(
      `${sc.name}: ${'case' in sc.expect ? `case ${sc.expect.case}` : `Do it myself (${sc.expect.manual})`} on ${sc.lanes.join(', ')}`,
      () => onLanes(sc.lanes, l => fullRun(newBox, l, sc)),
      60 * MIN,
    )

  /**
   * Case 2 (their Caddy as a service, two sites) when things go wrong, one server per distribution
   * for all of them: each leaves their Caddy and its file as they were before it (what it changed
   * for itself, put back).
   */
  describe('when things go wrong (case 2)', () => {
    const at = new Map<Distro, { s: TestServer; b: Board; original: string }>()
    const CADDYFILE = '/etc/caddy/Caddyfile'
    const unit = SCENARIOS.find(x => x.name === 'caddy-unit') as Scenario

    beforeAll(
      () =>
        onLanes(MAIN, async l => {
          const s = await prepare(l, unit, 'failures')
          const b = await startBoard(newBox, l, s, 'admin')
          await stepOneAndTest(b, s)
          at.set(l.distro, { s, b, original: (await s.sh(`cat ${CADDYFILE}`)).stdout })
        }),
      30 * MIN,
    )
    afterAll(async () => {
      for (const { s } of at.values()) await s.stop()
    }, 10 * MIN)

    /** Each distribution's server and board; their Caddyfile (and Caddy) as at the start afterwards, whatever happened. */
    const eachServer = (fn: (x: { l: Lane; s: TestServer; b: Board; original: string }) => Promise<string>) =>
      onLanes(MAIN, async l => {
        const x = at.get(l.distro)
        if (!x) throw new Error('no server')
        try {
          rows.push(`${l.distro} (case 2): ${await fn({ l, ...x })}`)
        } finally {
          await theirCaddyfile(x.s, x.original)
        }
      })

    /** Their Caddyfile written (as root, as they would) and their Caddy restarted on it when it differs. */
    async function theirCaddyfile(s: TestServer, text: string, always = false): Promise<void> {
      const now = (await s.sh(`cat ${CADDYFILE}`)).stdout
      if (now === text && !always) return
      await s.sh(`printf '%s' "$T" > ${CADDYFILE} && systemctl restart caddy`, { env: { T: text } })
      await until(
        'their Caddy on 443',
        async () => (await s.sh("ss -H -ltn 'sport = :443'")).stdout.trim() !== '',
        30_000,
      )
    }

    const epoch = async (s: TestServer): Promise<string> => (await s.sh('date +%s')).stdout.trim()
    /** systemd's own lines for reloads of caddy.service since `t`. */
    const reloads = async (s: TestServer, t: string): Promise<number> =>
      Number((await s.sh(`journalctl _PID=1 --since @${t} -o cat | grep -ci 'reloading.*caddy' || true`)).stdout.trim())
    const record = async (s: TestServer): Promise<string> =>
      (await s.sh('cat /etc/agent-board/setup.json 2>/dev/null || true')).stdout
    const stepNo = (p: Plan, id: string): number => p.steps.findIndex(x => x.id === id) + 1

    /** Look, which must give case 2's plan. */
    async function planned(b: Board): Promise<Plan> {
      const [status, reply, v] = await look(b, 'admin')
      expect(status, JSON.stringify(reply)).toBe(200)
      expect(v.choice?.case).toBe('2')
      if (v.plan?.kind !== 'apply') throw new Error(`no Apply plan: ${JSON.stringify(v.plan?.kind)}`)
      return v.plan
    }

    /** A script on the server in the background: it watches the newest run's log (`$L`) as Apply goes. */
    async function onRunLog(s: TestServer, then: string): Promise<void> {
      await s.sh('rm -f /tmp/at-run; touch /tmp/at-run')
      await docker([
        'exec',
        '-d',
        s.name,
        'sh',
        '-c',
        `L=''; for _ in $(seq 1200); do L=$(find /etc/agent-board/runs -name '*.log' -newer /tmp/at-run 2>/dev/null | head -n 1); [ -n "$L" ] && break; sleep 0.1; done
${then}`,
      ])
    }
    const waitLine = (pattern: string): string =>
      `for _ in $(seq 1200); do grep -q '${pattern}' "$L" && break; sleep 0.05; done`

    /** The run held (SIGSTOP) once its log has `pattern`, until resume(): what a slow step would give the test. */
    async function pauseAt(
      s: TestServer,
      pattern: string,
    ): Promise<{ paused(): Promise<void>; resume(): Promise<void> }> {
      const run = "'^sh /etc/agent-board/runs/.*[.]sh$'"
      await s.sh('rm -f /tmp/paused')
      await onRunLog(s, `${waitLine(pattern)}; pkill -STOP -f ${run}; touch /tmp/paused`)
      return {
        paused: () =>
          until(
            'the run is held',
            async () => (await s.sh('test -e /tmp/paused', { check: false })).code === 0,
            5 * MIN,
            200,
          ),
        resume: async () => {
          await s.sh(`pkill -CONT -f ${run} || true`)
        },
      }
    }

    /** The run on the server ended: its exit file is there, or (killed outright) no run's process is left. */
    async function runEnded(s: TestServer): Promise<void> {
      try {
        await until(
          'the run ends on the server',
          async () =>
            (
              await s.sh(
                'f=$(ls -t /etc/agent-board/runs/*.exit 2>/dev/null | head -n 1); { [ -n "$f" ] && [ -s "$f" ] && ! [ /tmp/at-run -nt "$f" ]; } || ! pgrep -f \'^sh /etc/agent-board/run[s]/\' >/dev/null',
                { check: false },
              )
            ).code === 0,
          10 * MIN,
          1000,
        )
      } catch (err) {
        const ps = await s.sh(
          'ps -eo pid,stat,cgroup:60,cmd | grep -v "ps -eo"; tail -n 30 "$(ls -t /etc/agent-board/runs/*.log | head -n 1)"; cat /etc/agent-board/setup.json',
          { check: false },
        )
        note(`${s.name}: the run did not end:\n${ps.stdout}`)
        throw err
      }
    }

    async function caddyValid(s: TestServer): Promise<boolean> {
      const out = await s.sh(
        `runuser -u caddy -- env STEPPATH=/ caddy validate --config ${CADDYFILE} --adapter caddyfile >/dev/null 2>&1`,
        { check: false },
      )
      return out.code === 0
    }

    test(
      'a wrong sudo password: wrongPassword after one attempt, in sudo’s and sudo-rs’s own words',
      () =>
        eachServer(async ({ s, b }) => {
          const t = await epoch(s)
          const [status, reply] = await b.op({ op: 'server-look', password: 'not-the-password' })
          expect(status).toBe(409)
          expect(reply.hint).toBe('wrongPassword')
          const failures = Number(
            (await s.sh(`journalctl --since @${t} -o cat | grep -c 'authentication failure' || true`)).stdout.trim(),
          )
          expect(failures).toBe(1)
          expect(JSON.stringify(reply)).not.toContain('not-the-password')
          await planned(b)
          return `wrong password: 409 wrongPassword, ${failures} attempt in the journal, sudo said ${JSON.stringify(reply.error)}`
        }),
      20 * MIN,
    )

    test(
      'the admin’s logins in Russian (Debian 13’s sudo speaks it): the hints all the same',
      () =>
        eachServer(async ({ l, s, b }) => {
          if (l.distro !== 'debian13') return 'sudo in Russian: Debian 13 only (sudo-rs has no translations)'
          await s.sh(
            "apt-get install -y -qq locales >/dev/null && sed -i 's/^# *ru_RU.UTF-8 UTF-8/ru_RU.UTF-8 UTF-8/' /etc/locale.gen && locale-gen >/dev/null && echo 'LANG=ru_RU.UTF-8' > /etc/default/locale",
            { timeoutMs: 10 * MIN },
          )
          try {
            // what sudo says in that locale, as it would to the board without LC_ALL=C
            const said = await s.sh(
              "su admin -c \"printf 'wrong\\n' | LANG=ru_RU.UTF-8 sudo -S -k -p '' true\" 2>&1 || true",
            )
            const t = await epoch(s)
            const [status, reply] = await b.op({ op: 'server-look', password: 'not-the-password' })
            expect(status).toBe(409)
            expect(reply.hint).toBe('wrongPassword')
            expect(
              Number(
                (
                  await s.sh(`journalctl --since @${t} -o cat | grep -c 'authentication failure' || true`)
                ).stdout.trim(),
              ),
            ).toBe(1)
            await planned(b)
            return `logins in ru_RU.UTF-8 (sudo itself says ${JSON.stringify(said.stdout.trim().split('\n')[0])}): a wrong password still gives wrongPassword (${JSON.stringify(reply.error)}), the right one Looks`
          } finally {
            await s.sh('rm -f /etc/default/locale')
          }
        }),
      20 * MIN,
    )

    test(
      'their Caddyfile changed between Look and Apply: stopped before any change',
      () =>
        eachServer(async ({ s, b, original }) => {
          const p = await planned(b)
          const was = await record(s)
          const edited = `${original}# changed by hand\n`
          await s.sh(`printf '%s' "$T" > ${CADDYFILE}`, { env: { T: edited } })
          const v = await runPlan(b, 'admin', p)
          expect(v.phase).toBe('failed')
          expect(v.progress?.result).toBe('changed')
          expect(v.hint).toBe('changed')
          expect((await s.sh(`cat ${CADDYFILE}`)).stdout).toBe(edited)
          expect(await record(s)).toBe(was)
          expect(await s.sh('ls /etc/caddy/agent-board 2>/dev/null || true').then(o => o.stdout.trim())).toBe('')
          return `changed between Look and Apply: ${v.progress?.result}, hint ${v.hint}, their file untouched, nothing recorded`
        }),
      20 * MIN,
    )

    test(
      'their last site without braces: validate fails, nothing reloaded, their file as it was',
      () =>
        eachServer(async ({ l, s, b, original }) => {
          const global = original.slice(0, original.indexOf('}\n') + 2)
          await theirCaddyfile(s, `${global}\na.example.com\ntls internal\nrespond "site a"\n`)
          const p = await planned(b)
          const before = await s.hashes([CADDYFILE])
          const t = await epoch(s)
          const v = await runPlan(b, 'admin', p)
          expect(v.progress?.result, story(v)).toBe('rolled-back')
          const failed = v.progress?.steps.find(x => x.state === 'fail')
          expect(failed?.id).toBe('validate')
          expect(await s.hashes([CADDYFILE])).toEqual(before)
          expect(await reloads(s, t)).toBe(0)
          expect(await sitesAnswer(l, s, [A])).toEqual([])
          return `a brace-less last site: rolled back at ${failed?.id} (${failed?.out.filter(x => /rror|unrecognized/.test(x)).slice(-1)[0] ?? ''}), no reload, their file's hash as before`
        }),
      20 * MIN,
    )

    test(
      'their reload fails: rolled back, their Caddy on its old config',
      () =>
        eachServer(async ({ l, s, b }) => {
          await s.sh(
            "install -d /etc/systemd/system/caddy.service.d && printf '[Service]\\nExecReload=\\nExecReload=/bin/false\\n' > /etc/systemd/system/caddy.service.d/test-reload.conf && systemctl daemon-reload",
          )
          try {
            const p = await planned(b)
            const before = await s.hashes([CADDYFILE])
            const v = await runPlan(b, 'admin', p)
            expect(v.progress?.result, story(v)).toBe('rolled-back')
            expect(v.progress?.steps.find(x => x.state === 'fail')?.id).toBe('reload')
            expect(await s.hashes([CADDYFILE])).toEqual(before)
            expect((await s.sh('systemctl is-active caddy')).stdout.trim()).toBe('active')
            expect(await sitesAnswer(l, s, [A, B])).toEqual([])
            // the board's domain is not served: their Caddy runs the config it had
            const board = await l.client(
              `curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve ${DOMAIN}:443:${s.ip} https://${DOMAIN}/`,
              { check: false },
            )
            expect(board.stdout).not.toBe('200')
            return `their reload fails: rolled back at reload, their file's hash as before, their Caddy active on its old config, their sites answer`
          } finally {
            await s.sh('rm -f /etc/systemd/system/caddy.service.d/test-reload.conf && systemctl daemon-reload')
          }
        }),
      20 * MIN,
    )

    test(
      'a site answers otherwise after the reload: rolled back',
      () =>
        eachServer(async ({ l, s, b, original }) => {
          // their b.example.com from a file: gone while the run checks after the reload, back once it failed
          await s.sh("install -d -m 755 /srv/b && printf 'site b' > /srv/b/index.html")
          await theirCaddyfile(s, original.replace('\trespond "site b"', '\troot * /srv/b\n\tfile_server'))
          const p = await planned(b)
          const before = await s.hashes([CADDYFILE])
          await onRunLog(
            s,
            `${waitLine(`^@@step ${stepNo(p, 'fetch-before')} ok`)}; mv /srv/b/index.html /srv/b/off.html
${waitLine(`^@@step ${stepNo(p, 'fetch-after')} fail`)}; mv /srv/b/off.html /srv/b/index.html`,
          )
          const v = await runPlan(b, 'admin', p)
          expect(v.progress?.result, story(v)).toBe('rolled-back')
          const failed = v.progress?.steps.find(x => x.state === 'fail')
          expect(failed?.id).toBe('fetch-after')
          expect(await s.hashes([CADDYFILE])).toEqual(before)
          expect(await sitesAnswer(l, s, [A, B])).toEqual([])
          return `a site answers otherwise after the reload: rolled back (${failed?.out.filter(x => x.includes('answers')).join('; ')}), reloaded back, their file's hash as before`
        }),
      20 * MIN,
    )

    test(
      'the run told to stop (TERM) during the reload: rolled back, their Caddyfile valid',
      () =>
        eachServer(async ({ l, s, b }) => {
          const p = await planned(b)
          const before = await s.hashes([CADDYFILE])
          await onRunLog(
            s,
            `${waitLine(`^@@step ${stepNo(p, 'reload')} start`)}; pkill -TERM -f '^sh /etc/agent-board/runs/.*[.]sh$'`,
          )
          const v = await runPlan(b, 'admin', p)
          expect(v.progress?.result, story(v)).toBe('rolled-back')
          expect(await s.hashes([CADDYFILE])).toEqual(before)
          expect(await caddyValid(s)).toBe(true)
          expect((await s.sh(`grep -c agent-board ${CADDYFILE} || true`)).stdout.trim()).toBe('0')
          expect(await sitesAnswer(l, s, [A, B])).toEqual([])
          return `TERM during the reload: the step finished, then rolled back (${v.progress?.undo.length} undos), their file's hash as before and valid`
        }),
      20 * MIN,
    )

    test(
      'a run killed mid-step (KILL, as a reboot would): Look offers its Undo, which puts their files back byte for byte',
      () =>
        eachServer(async ({ l, s, b }) => {
          const p = await planned(b)
          const before = await s.hashes([CADDYFILE])
          await onRunLog(
            s,
            `${waitLine(`^@@step ${stepNo(p, 'fetch-before')} start`)}; pkill -KILL -f '^sh /etc/agent-board/runs/.*[.]sh$'`,
          )
          const v = await runPlan(b, 'admin', p)
          expect(v.phase).toBe('failed')
          await runEnded(s)
          expect(JSON.parse(await record(s)).state).toBe('running')
          // their file holds the import line now: the next Look offers the Undo of what the record names
          expect((await s.sh(`grep -c 'agent-board' ${CADDYFILE} || true`)).stdout.trim()).toBe('1')
          const [status, reply, seen] = await look(b, 'admin')
          expect(status, JSON.stringify(reply)).toBe(200)
          const u = seen.plan
          if (!u) throw new Error(`no plan after the killed run: ${JSON.stringify(seen.choice)}`)
          expect(u.kind).toBe('undo')
          const undone = await runPlan(b, 'admin', u, 'server-undo')
          expect(undone.progress?.result, story(undone)).toBe('applied')
          expect(await s.hashes([CADDYFILE])).toEqual(before)
          expect(await caddyValid(s)).toBe(true)
          expect(await leftovers(s, [CADDYFILE])).toBe('')
          expect((await s.sh('stat -c %G /var/lib/boardtunnel')).stdout.trim()).toBe('boardtunnel')
          expect(await sitesAnswer(l, s, [A, B])).toEqual([])
          return `KILL after the write: the record says running; Look offers its Undo (${seen.choice?.case ?? JSON.stringify(seen.choice?.why)}); Undo applied, their file byte for byte as before, the folder's group back`
        }),
      20 * MIN,
    )

    test(
      'the board’s ssh killed mid-Apply: the run ends by itself, the next Look reads it',
      () =>
        eachServer(async ({ l, s, b }) => {
          const p = await planned(b)
          const before = await s.hashes([CADDYFILE])
          // the run held at its validate (SIGSTOP) while the connection goes: a run takes seconds
          const run = await pauseAt(s, `^@@step ${stepNo(p, 'validate')} start`)
          const [status] = await b.op({ op: 'server-apply', plan: p.id, ...passwordFor('admin') })
          expect(status).toBe(200)
          await run.paused()
          expect(await killAdminSsh(s.sshPort)).toBeGreaterThan(0)
          const v = await b.serverWhen(x => x.phase === 'failed' || x.phase === 'done', 2 * MIN, 'the board notices')
          expect(v.phase).toBe('failed')
          expect(v.hint).toBe('lost')
          await run.resume()
          await runEnded(s)
          const state = JSON.parse(await record(s)).state as string
          const [lookStatus, , seen] = await look(b, 'admin')
          expect(lookStatus).toBe(200)
          if (state === 'applied') {
            expect(seen.plan?.kind).toBe('nothing')
            expect(seen.setup?.case).toBe('2')
            const [, , u] = await look(b, 'admin', 'server-undo-look')
            const undone = await runPlan(b, 'admin', u.plan as Plan, 'server-undo')
            expect(undone.progress?.result, story(undone)).toBe('applied')
          } else {
            expect(state).toBe('rolled-back')
            expect(seen.plan?.kind).toBe('apply')
          }
          expect(await s.hashes([CADDYFILE])).toEqual(before)
          expect(await sitesAnswer(l, s, [A, B])).toEqual([])
          return `the board's ssh killed while the run was held at its validate: the board says lost; the run on the server ended ${state}; the next Look read it (${seen.plan?.kind})`
        }),
      20 * MIN,
    )

    test(
      'logind with KillUserProcesses=yes and the connection cut mid-Apply: what the run does',
      () =>
        eachServer(async ({ l, s, b }) => {
          // their reload takes 8 s (a big config's would): the cut lands while a step of the run goes on
          await s.sh(
            "install -d /etc/systemd/logind.conf.d && printf '[Login]\\nKillUserProcesses=yes\\n' > /etc/systemd/logind.conf.d/test-kill.conf && systemctl restart systemd-logind && install -d /etc/systemd/system/caddy.service.d && printf '[Service]\\nExecReload=\\nExecReload=/bin/sh -c \"sleep 8; exec /usr/bin/caddy reload --config /etc/caddy/Caddyfile --force\"\\n' > /etc/systemd/system/caddy.service.d/test-slow.conf && systemctl daemon-reload",
          )
          try {
            const p = await planned(b)
            const before = await s.hashes([CADDYFILE])
            // the connection cut on the server's side as their reload starts (their file has the
            // line): sshd's session for the admin killed, as a dropped link ends it
            await onRunLog(
              s,
              `${waitLine(`^@@step ${stepNo(p, 'reload')} start`)}
for r in $(pgrep -f '^sh /etc/agent-board/runs/.*[.]sh$'); do cut -d: -f3 /proc/$r/cgroup; done | sed 's|.*/||' | head -n 1 > /tmp/run-scope
pkill -KILL -f 'ssh[d][-a-z]*: admin'`,
            )
            const [status] = await b.op({ op: 'server-apply', plan: p.id, ...passwordFor('admin') })
            expect(status).toBe(200)
            const cut = await b.serverWhen(
              x => x.phase === 'failed' || x.phase === 'done',
              2 * MIN,
              'the board notices',
            )
            expect(cut.phase, story(cut)).toBe('failed')
            // the run was in the admin's logind session (its scope), as on a server
            const scope = (await s.sh('cat /tmp/run-scope')).stdout.trim()
            expect(scope).toMatch(/^session-\w+\.scope$/)
            await runEnded(s)
            const log = (await s.sh('cat "$(ls -t /etc/agent-board/runs/*.log | head -n 1)"')).stdout
            const state = JSON.parse(await record(s)).state as string
            note(`${l.distro} logind KillUserProcesses=yes: record ${state}\n${log}`)
            const valid = await caddyValid(s)
            expect(valid).toBe(true)
            // whatever it did, Look and its plan put things right
            const [, , seen] = await look(b, 'admin')
            if (seen.plan?.kind === 'undo' || seen.plan?.kind === 'nothing') {
              const [, , u] = seen.plan.kind === 'undo' ? [0, {}, seen] : await look(b, 'admin', 'server-undo-look')
              const undone = await runPlan(b, 'admin', u.plan as Plan, 'server-undo')
              expect(undone.progress?.result, story(undone)).toBe('applied')
            }
            expect(await s.hashes([CADDYFILE])).toEqual(before)
            expect(await sitesAnswer(l, s, [A, B])).toEqual([])
            const told = log.includes('told to stop')
            return `logind KillUserProcesses=yes, the connection cut during their (8 s) reload (the run in ${scope}): the run ${told ? 'was told to stop (TERM) and' : 'was not stopped and'} ended ${state} (result ${/@@result (\S+)/.exec(log)?.[1] ?? 'none'}); their Caddyfile valid; Look then ${seen.plan?.kind ?? JSON.stringify(seen.choice?.why)}; the board saw: ${story(cut)}`
          } finally {
            await s.sh(
              'rm -f /etc/systemd/logind.conf.d/test-kill.conf /etc/systemd/system/caddy.service.d/test-slow.conf && systemctl daemon-reload && systemctl restart systemd-logind',
            )
          }
        }),
      20 * MIN,
    )
  })

  describe('when things go wrong (case 3a, a single-file mount)', () => {
    const file = SCENARIOS.find(x => x.name === 'compose-file') as Scenario
    test(
      'their last site without braces: written in place, refused inside, put back at once, never reloaded',
      () =>
        onLanes(MAIN, async l => {
          const s = await prepare(l, file, 'file-braceless')
          try {
            const CADDYFILE = '/srv/my web/Caddyfile'
            const original = (await s.sh(`cat '${CADDYFILE}'`)).stdout
            const global = original.slice(0, original.indexOf('}\n') + 2)
            await s.sh(
              `printf '%s' "$T" > '${CADDYFILE}' && docker exec web-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
              { env: { T: `${global}\na.example.com\ntls internal\nrespond "site a"\n` } },
            )
            const b = await startBoard(newBox, l, s, 'admin')
            await stepOneAndTest(b, s)
            const [status, reply, seen] = await look(b, 'admin')
            expect(status, JSON.stringify(reply)).toBe(200)
            expect(seen.choice?.case).toBe('3a')
            const before = await s.hashes([CADDYFILE])
            const id = (await s.sh('docker inspect -f {{.Id}} web-caddy-1')).stdout.trim()
            const t = (await s.sh('date -u +%Y-%m-%dT%H:%M:%SZ')).stdout.trim()
            const v = await runPlan(b, 'admin', seen.plan as Plan)
            expect(v.progress?.result, story(v)).toBe('rolled-back')
            const failed = v.progress?.steps.find(x => x.state === 'fail')
            expect(failed?.id).toBe('validate')
            expect(await s.hashes([CADDYFILE])).toEqual(before)
            expect((await s.sh('docker inspect -f {{.Id}} web-caddy-1')).stdout.trim()).toBe(id)
            const loads = (
              await s.sh(`docker logs --since ${t} web-caddy-1 2>&1 | grep -c '"load complete"' || true`)
            ).stdout.trim()
            expect(loads).toBe('0')
            expect(await sitesAnswer(l, s, [A])).toEqual([])
            rows.push(
              `${l.distro} (case 3a, file mount): a brace-less last site: written in place, refused at validate, put back at once (hash as before), their Caddy never reloaded, same container`,
            )
          } finally {
            await s.stop()
          }
        }),
      30 * MIN,
    )
  })
})

/** Windows' ssh of the board's admin connection to this server, ended as a lost connection would (the PC asleep). */
async function killAdminSsh(port: number): Promise<number> {
  const ps = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const out = await run([
    ps,
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match ' -p ${port} ' -and $_.CommandLine -match 'admin@127[.]0[.]0[.]1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`,
  ])
  return out.stdout.split('\n').filter(x => x.trim()).length
}
