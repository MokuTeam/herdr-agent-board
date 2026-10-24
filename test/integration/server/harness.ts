// The integration tests' Docker Desktop (server-setup.test.ts, two-proxies.test.ts): the test
// servers built from this folder's Dockerfiles; per distribution a "lane": a Docker network with
// Pebble (Let's Encrypt's test CA), its challenge DNS server and a `client` container, the test's
// own window on the servers; a pull-through mirror of Docker Hub for the servers' own Docker; a
// server per scenario, its sshd on a free port of 127.0.0.1; and everything removed again, also
// after a failure. Never anything but containers on this PC: no host but these is ever reached.
//
// A command can also run in a terminal on a server (onTty), its prompts answered as a person would.
//
// Everything made here carries the label agent-board-it=<run>, and is removed by it. Scripts and
// Dockerfiles go to Docker with their \r removed: a Windows checkout with core.autocrlf gives them
// CRLF, which sh and the Dockerfile parser do not take.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Distro = 'debian13' | 'ubuntu2604' | 'ubuntu2404' | 'debian12' | 'ubuntu2204'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** A run's id: names and labels of what it makes. */
export const RUN = Math.random().toString(16).slice(2, 8)
export const LABEL_KEY = 'agent-board-it'
const LABEL = `${LABEL_KEY}=${RUN}`
/** BOARD_IT_KEEP=1: the built images and the mirror stay for the next run (while working on the tests). */
const KEEP = process.env.BOARD_IT_KEEP === '1'
const MIRROR = 'agent-board-it-mirror'
const MIRROR_LABEL = `${LABEL_KEY}=keep`

let workDir = ''

/** The run's own folder on this PC: its log, Pebble's config, its roots. Removed at the end unless kept. */
export function work(): string {
  if (!workDir || !existsSync(workDir)) workDir = mkdtempSync(join(tmpdir(), 'agent-board-it-'))
  return workDir
}

/** A line in the run's log (<work>/run.log): what ran where, and what it said. */
export function note(text: string): void {
  appendFileSync(join(work(), 'run.log'), `${new Date().toISOString()} ${text}\n`)
}

export const noCr = (text: string): string => text.replaceAll('\r', '')

export interface Out {
  code: number
  stdout: string
  stderr: string
}

/** A program with this argv, no shell; stdin written then closed. Throws on a non-zero exit when `check`. */
export async function run(
  argv: string[],
  o: { stdin?: string; timeoutMs?: number; check?: boolean; quiet?: boolean } = {},
): Promise<Out> {
  const proc = Bun.spawn(argv, {
    stdin: o.stdin === undefined ? 'ignore' : new TextEncoder().encode(o.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 120_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  const out = { code, stdout: noCr(stdout), stderr: noCr(stderr) }
  // an `-e NAME=value`'s value stays out of the log (the sudo password's sentinel is one)
  const shown = argv.map((a, i) => (argv[i - 1] === '-e' ? `${a.split('=')[0]}=…` : a))
  if (!o.quiet) note(`$ ${shown.join(' ').slice(0, 400)} → ${code}${code ? `\n${out.stderr.slice(-2000)}` : ''}`)
  if ((o.check ?? true) && code !== 0)
    throw new Error(`${shown.slice(0, 4).join(' ')}… exited ${code}: ${(out.stderr || out.stdout).slice(-1500)}`)
  return out
}

export const docker = (args: string[], o: Parameters<typeof run>[1] = {}): Promise<Out> => run(['docker', ...args], o)

/** Docker answers (Desktop is running). */
export async function dockerUp(): Promise<boolean> {
  return (await run(['docker', 'info', '--format', '{{.ServerVersion}}'], { check: false, quiet: true })).code === 0
}

/** The container's address on a network. */
export async function ipOn(container: string, network: string): Promise<string> {
  const out = await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container])
  const ip = out.stdout.trim()
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`no address for ${container} on ${network}: ${ip}`)
  return ip
}

/** The 127.0.0.1 port Docker published a container's port on. */
export async function publishedPort(container: string, port: number): Promise<number> {
  const out = await docker(['port', container, `${port}/tcp`])
  const m = /127\.0\.0\.1:(\d+)/.exec(out.stdout)
  if (!m) throw new Error(`${container}: ${port} is not published on 127.0.0.1: ${out.stdout}`)
  return Number(m[1])
}

/** Waits until `ok` resolves true, within `ms`; `what` names it in the error. */
export async function until(what: string, ok: () => Promise<boolean>, ms = 60_000, every = 500): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await ok().catch(() => false)) return
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await Bun.sleep(every)
  }
}

// --- What a run leaves, and its removal ----------------------------------------------------------

/** Everything of a run (this one, or one before that was cut off): containers with their anonymous volumes, networks, volumes. */
async function removeLabelled(filter: string): Promise<void> {
  const ids = (await docker(['ps', '-aq', '--filter', `label=${filter}`], { quiet: true })).stdout
    .split('\n')
    .filter(Boolean)
  if (ids.length) await docker(['rm', '-f', '-v', ...ids], { check: false, timeoutMs: 300_000 })
  const nets = (await docker(['network', 'ls', '-q', '--filter', `label=${filter}`], { quiet: true })).stdout
    .split('\n')
    .filter(Boolean)
  for (const n of nets) {
    await docker(['network', 'disconnect', '-f', n, MIRROR], { check: false, quiet: true })
    await docker(['network', 'rm', n], { check: false })
  }
  const vols = (await docker(['volume', 'ls', '-q', '--filter', `label=${filter}`], { quiet: true })).stdout
    .split('\n')
    .filter(Boolean)
  if (vols.length) await docker(['volume', 'rm', '-f', ...vols], { check: false })
}

/** Which process a run is: one whose process is gone was cut off, and what it left is removed by the next. */
const RUNS = join(tmpdir(), 'agent-board-it-runs')
mkdirSync(RUNS, { recursive: true })
writeFileSync(join(RUNS, RUN), String(process.pid))

function alive(run: string): boolean {
  try {
    process.kill(Number(readFileSync(join(RUNS, run), 'utf8')), 0)
    return true
  } catch {
    return false
  }
}

/** What an earlier run that was cut off left (anything with the label but the kept mirror and a run still going). */
export async function removeStale(): Promise<void> {
  const out = await docker(['ps', '-a', '--filter', `label=${LABEL_KEY}`, '--format', '{{.Label "agent-board-it"}}'], {
    quiet: true,
  })
  const runs = new Set(out.stdout.split('\n').filter(r => r && r !== 'keep'))
  const nets = await docker(
    ['network', 'ls', '--filter', `label=${LABEL_KEY}`, '--format', '{{.Label "agent-board-it"}}'],
    { quiet: true },
  )
  for (const r of nets.stdout.split('\n')) if (r && r !== 'keep') runs.add(r)
  for (const r of runs) {
    if (alive(r)) continue
    await removeLabelled(`${LABEL_KEY}=${r}`)
    rmSync(join(RUNS, r), { force: true })
  }
}

const built = new Set<string>()

/** The end of a run: every container, network and volume it made; its images and the mirror unless kept. */
export async function removeRun(): Promise<void> {
  await removeLabelled(LABEL)
  rmSync(join(RUNS, RUN), { force: true })
  if (!KEEP) {
    await docker(['rm', '-f', '-v', MIRROR], { check: false, quiet: true })
    for (const tag of built) await docker(['image', 'rm', tag], { check: false })
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    workDir = ''
  }
}

// --- The images ------------------------------------------------------------------------------------

export const imageTag = (d: Distro, withDocker: boolean): string => `agent-board-it/${d}:docker${withDocker ? 1 : 0}`

/** Builds a test server's image from its Dockerfile (on stdin, without \r; no context). */
export async function buildImage(d: Distro, withDocker: boolean): Promise<string> {
  const tag = imageTag(d, withDocker)
  const dockerfile = noCr(readFileSync(join(HERE, `${d}.Dockerfile`), 'utf8'))
  // a mirror's 502 fails a build now and then: up to three times (the steps done stay cached)
  for (let attempt = 1; ; attempt++) {
    const out = await docker(['build', '-q', '-t', tag, '--build-arg', `DOCKER=${withDocker ? 1 : 0}`, '-'], {
      stdin: dockerfile,
      timeoutMs: 30 * 60_000,
      check: attempt >= 3,
    })
    if (out.code === 0) break
  }
  built.add(tag)
  return tag
}

// --- The mirror ------------------------------------------------------------------------------------

/** A pull-through cache of Docker Hub (registry:2): the servers pull through it, Docker Hub sees each image once. */
export async function startMirror(): Promise<void> {
  const exists = await docker(['inspect', '-f', '{{.State.Running}}', MIRROR], { check: false, quiet: true })
  if (exists.code === 0) {
    if (exists.stdout.trim() !== 'true') await docker(['start', MIRROR])
    return
  }
  await docker([
    'run',
    '-d',
    '--name',
    MIRROR,
    '--label',
    KEEP ? MIRROR_LABEL : LABEL,
    '-e',
    'REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io',
    'registry:2',
  ])
}

// --- A lane: Pebble, its DNS, the client ---------------------------------------------------------------

/** Pebble's VA checks the domain on the ports a CA uses: 80 and 443. */
const PEBBLE_CONFIG = {
  pebble: {
    listenAddress: '0.0.0.0:14000',
    managementListenAddress: '0.0.0.0:15000',
    certificate: 'test/certs/localhost/cert.pem',
    privateKey: 'test/certs/localhost/key.pem',
    httpPort: 80,
    tlsPort: 443,
    ocspResponderURL: '',
    externalAccountBindingRequired: false,
    retryAfter: { authz: 1, order: 1 },
  },
}

export const PEBBLE_DIR = 'https://pebble:14000/dir'
/** Where a server keeps the root of Pebble's own HTTPS (BOARD_SETUP_ACME_CA_ROOT, their Caddy's acme_ca_root). */
export const PEBBLE_ROOT_ON_SERVER = '/opt/pebble/pebble.minica.pem'

/** A CONNECT proxy on 127.0.0.1 for this PC's fetches: `host:port` to a port of 127.0.0.1 (a server's published one), as DNS would. */
export interface ConnectProxy {
  url: string
  routes: Map<string, number>
  close(): void
}

export async function connectProxy(): Promise<ConnectProxy> {
  const routes = new Map<string, number>()
  const sockets = new Set<net.Socket>()
  const server = http.createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    const to = routes.get(req.url ?? '')
    if (!to) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const up = net.connect(to, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(client)
      client.pipe(up)
    })
    sockets.add(up)
    up.on('close', () => {
      sockets.delete(up)
      client.destroy()
    })
    up.on('error', () => client.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    routes,
    close() {
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}

export interface Lane {
  distro: Distro
  net: string
  ip: { pebble: string; dns: string; client: string }
  /** Pebble's own HTTPS root (its directory's certificate): for the servers. */
  minica: string
  /** The root of what Pebble issues, in a file on this PC (NODE_EXTRA_CA_CERTS), and in the client at /root.pem. */
  rootFile: string
  /** The client container: `sh -c` there. */
  client(script: string, o?: { check?: boolean; timeoutMs?: number }): Promise<Out>
  /** The same, left running in the background. */
  clientBackground(script: string): Promise<void>
  /** The challenge DNS answers `host` with `ip` (and nothing else). */
  addA(host: string, ip: string): Promise<void>
  proxy: ConnectProxy
}

export async function startLane(d: Distro): Promise<Lane> {
  const name = `abit-${RUN}-${d}`
  const net = name
  await docker(['network', 'create', '--label', LABEL, net])
  await docker(['network', 'connect', '--alias', 'mirror', net, MIRROR])
  // the challenge DNS: on 53, so that a server's Docker can name it as its containers' DNS
  await docker([
    'run',
    '-d',
    '--name',
    `${name}-dns`,
    '--label',
    LABEL,
    '--network',
    net,
    '--network-alias',
    'challtestsrv',
    'ghcr.io/letsencrypt/pebble-challtestsrv:latest',
    '-dnsserver',
    ':53',
    '-doh',
    '',
    '-http01',
    '',
    '-https01',
    '',
    '-tlsalpn01',
    '',
    '-defaultIPv6',
    '',
  ])
  const dns = await ipOn(`${name}-dns`, net)
  const config = join(work(), `pebble-${d}.json`)
  writeFileSync(config, JSON.stringify(PEBBLE_CONFIG, null, 2))
  await docker([
    'run',
    '-d',
    '--name',
    `${name}-pebble`,
    '--label',
    LABEL,
    '--network',
    net,
    '--network-alias',
    'pebble',
    '-e',
    'PEBBLE_VA_NOSLEEP=1',
    '-e',
    'PEBBLE_WFE_NONCEREJECT=0',
    '-v',
    `${config}:/pebble.json:ro`,
    'ghcr.io/letsencrypt/pebble:latest',
    '-config',
    '/pebble.json',
    '-dnsserver',
    `${dns}:53`,
  ])
  const pebble = await ipOn(`${name}-pebble`, net)
  // the client: the distribution's own server image (it has curl), doing nothing but wait
  await docker([
    'run',
    '-d',
    '--name',
    `${name}-client`,
    '--label',
    LABEL,
    '--network',
    net,
    '--entrypoint',
    'sleep',
    imageTag(d, true),
    'infinity',
  ])
  const client = await ipOn(`${name}-client`, net)
  const inClient = (script: string, o: { check?: boolean; timeoutMs?: number } = {}): Promise<Out> =>
    docker(['exec', `${name}-client`, 'sh', '-c', noCr(script)], o)
  const addA = async (host: string, ip: string): Promise<void> => {
    const body = (v: unknown): string => JSON.stringify(JSON.stringify(v))
    await inClient(
      `curl -sf -d ${body({ host })} http://challtestsrv:8055/clear-a && curl -sf -d ${body({ host, addresses: [ip] })} http://challtestsrv:8055/add-a`,
    )
  }
  await addA('pebble', pebble)
  // the root of what Pebble issues (made anew at each start)
  let root = ''
  await until(
    'Pebble answers',
    async () => {
      root = (await inClient('curl -sk https://pebble:15000/roots/0', { check: false })).stdout
      return root.includes('BEGIN CERTIFICATE')
    },
    60_000,
  )
  await inClient(`printf '%s' '${root}' > /root.pem`)
  const rootFile = join(work(), `pebble-root-${d}.pem`)
  writeFileSync(rootFile, root)
  return {
    distro: d,
    net,
    ip: { pebble, dns, client },
    minica: await minicaFromImage(),
    rootFile,
    client: inClient,
    async clientBackground(script) {
      await docker(['exec', '-d', `${name}-client`, 'sh', '-c', noCr(script)])
    },
    addA,
    proxy: await connectProxy(),
  }
}

let minica: Promise<string> | null = null

/** Pebble's own HTTPS root, from its image (distroless: no cat, so `docker cp`), once. */
function minicaFromImage(): Promise<string> {
  minica ??= (async () => {
    const id = `abit-${RUN}-minica`
    await docker(['create', '--name', id, '--label', LABEL, 'ghcr.io/letsencrypt/pebble:latest'])
    try {
      const file = join(work(), 'pebble.minica.pem')
      await docker(['cp', `${id}:/test/certs/pebble.minica.pem`, file])
      return readFileSync(file, 'utf8')
    } finally {
      await docker(['rm', '-f', id], { check: false })
    }
  })()
  return minica
}

export function closeLane(l: Lane): void {
  l.proxy.close()
}

// --- A test server ------------------------------------------------------------------------------------

export interface TestServer {
  lane: Lane
  name: string
  ip: string
  sshPort: number
  /** Its 443 and 8443 on 127.0.0.1 of this PC. */
  https: number
  alt: number
  /** A script as root, `sh -c` with its \r removed; args after it. */
  sh(
    script: string,
    o?: { args?: string[]; env?: Record<string, string>; check?: boolean; timeoutMs?: number },
  ): Promise<Out>
  /** A program as root, its argv as it is, `stdin` written to it (a password: no file, no shell). */
  exec(argv: string[], o?: { stdin?: string; check?: boolean; timeoutMs?: number }): Promise<Out>
  /** sha256 of each file ('' for one that is not there). */
  hashes(paths: string[]): Promise<Record<string, string>>
  stop(): Promise<void>
}

const SCRIPTS = join(HERE, 'scenarios')

/** A scenario's script (test/integration/server/scenarios/<name>.sh) without \r. */
export const scenarioScript = (name: string): string => noCr(readFileSync(join(SCRIPTS, `${name}.sh`), 'utf8'))
/** Step 1, the one paste (step1.sh), without \r. */
export const stepOneScript = (): string => noCr(readFileSync(join(HERE, 'step1.sh'), 'utf8'))

/**
 * A server of the lane's distribution, systemd up, Docker up (when it has it) pulling through the
 * mirror, its containers' DNS the lane's challenge DNS, Pebble's HTTPS root at PEBBLE_ROOT_ON_SERVER,
 * the key in `adminKey` for root, admin and nopw, and admin's sudo password `password`.
 */
export async function startServer(
  l: Lane,
  o: { tag: string; withDocker: boolean; adminKey: string; password: string },
): Promise<TestServer> {
  const name = `abit-${RUN}-${l.distro}-${o.tag}`
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    o.tag.slice(0, 60),
    '--label',
    LABEL,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/var/lib/docker',
    '-v',
    '/var/lib/containerd',
    '--network',
    l.net,
    '-p',
    '127.0.0.1::22',
    '-p',
    '127.0.0.1::443',
    '-p',
    '127.0.0.1::8443',
    imageTag(l.distro, o.withDocker),
  ])
  const sh: TestServer['sh'] = (script, so = {}) =>
    docker(
      [
        'exec',
        ...Object.entries(so.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        name,
        'sh',
        '-c',
        noCr(script),
        'sh',
        ...(so.args ?? []),
      ],
      { check: so.check ?? true, timeoutMs: so.timeoutMs ?? 300_000 },
    )
  const exec: TestServer['exec'] = (argv, eo = {}) =>
    docker(['exec', ...(eo.stdin === undefined ? [] : ['-i']), name, ...argv], {
      ...(eo.stdin === undefined ? {} : { stdin: eo.stdin }),
      check: eo.check ?? true,
      timeoutMs: eo.timeoutMs ?? 120_000,
      quiet: eo.stdin !== undefined,
    })
  await until(
    `${name}: systemd up`,
    async () => /^(running|degraded)/.test((await sh('systemctl is-system-running', { check: false })).stdout),
    120_000,
    1000,
  )
  // sshd as after the owner's first login: a socket-activated one (Ubuntu) starts its service at
  // the first connection, which makes /run/sshd; without it Ubuntu 24.04's `sshd -t` (step 1) says
  // "Missing privilege separation directory: /run/sshd"
  await sh(
    'for _ in $(seq 40); do [ -d /run/sshd ] && exit 0; curl -s -m 2 telnet://127.0.0.1:22 </dev/null >/dev/null 2>&1; sleep 0.5; done; exit 1',
    { timeoutMs: 120_000 },
  )
  const pub = noCr(readFileSync(`${o.adminKey}.pub`, 'utf8')).trim()
  await sh(
    `for h in /root /home/admin /home/nopw; do printf '%s\\n' "$K" > "$h/.ssh/authorized_keys"; done
install -d -m 755 /opt/pebble /etc/docker
printf '%s' "$M" > ${PEBBLE_ROOT_ON_SERVER}
chmod 644 ${PEBBLE_ROOT_ON_SERVER}
printf '{"dns": ["%s"], "registry-mirrors": ["http://mirror:5000"]}\\n' "$D" > /etc/docker/daemon.json`,
    { env: { K: pub, M: l.minica, D: l.ip.dns } },
  )
  // the password on chpasswd's stdin: never in a file, an argv or a shell
  await exec(['chpasswd'], { stdin: `admin:${o.password}\n` })
  if (o.withDocker) {
    await sh('systemctl restart docker && docker info >/dev/null', { timeoutMs: 120_000 })
  }
  const ip = await ipOn(name, l.net)
  const s: TestServer = {
    lane: l,
    name,
    ip,
    sshPort: await publishedPort(name, 22),
    https: await publishedPort(name, 443),
    alt: await publishedPort(name, 8443),
    sh,
    exec,
    async hashes(paths) {
      const out = await sh('for f in "$@"; do if [ -f "$f" ]; then sha256sum "$f"; else echo "- $f"; fi; done', {
        args: paths,
      })
      const map: Record<string, string> = {}
      for (const line of out.stdout.split('\n').filter(Boolean)) {
        const m = /^(\S+)\s+(.*)$/.exec(line)
        if (m) map[m[2] as string] = m[1] === '-' ? '' : (m[1] as string)
      }
      return map
    },
    async stop() {
      await docker(['rm', '-f', '-v', name], { check: false, timeoutMs: 300_000 })
    },
  }
  return s
}

/** A prompt a person at the terminal answers: once the output since the last answer ends with it, the answer and Enter. */
export interface TtyAnswer {
  name: string
  prompt: RegExp
  answer: string
}

/**
 * A command in a terminal of its own on the server, as a user (root by default): util-linux's
 * `script` gives it one, as an ssh session would, so what it reads from /dev/tty comes from there.
 * Each prompt is answered at most once, on the terminal and nowhere else (an answer is never in
 * the log). Its output as the terminal showed it (\r removed), its exit code, and the prompts it
 * asked, in order.
 */
export async function onTty(
  s: TestServer,
  command: string,
  o: { user?: string; answers: TtyAnswer[]; timeoutMs?: number },
): Promise<Out & { asked: string[] }> {
  const argv = [
    'docker',
    'exec',
    '-i',
    ...(o.user ? ['-u', o.user] : []),
    '-w',
    '/tmp',
    s.name,
    'script',
    '-qfec',
    command,
    '/dev/null',
  ]
  const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 20 * 60_000)
  const asked: string[] = []
  const decoder = new TextDecoder()
  let out = ''
  let since = 0
  const reading = (async () => {
    for await (const chunk of proc.stdout) {
      out += decoder.decode(chunk, { stream: true })
      const tail = noCr(out.slice(since))
      const a = o.answers.find(x => !asked.includes(x.name) && x.prompt.test(tail))
      if (!a) continue
      asked.push(a.name)
      since = out.length
      proc.stdin.write(`${a.answer}\n`)
      proc.stdin.flush()
    }
  })()
  const stderr = new Response(proc.stderr).text()
  const code = await proc.exited
  await reading
  clearTimeout(timer)
  proc.stdin.end()
  const result = { code, stdout: noCr(out), stderr: noCr(await stderr), asked }
  note(
    `$ ${argv.join(' ')} (on a terminal, asked: ${asked.join(', ') || 'nothing'}) → ${code}\n${result.stdout.slice(-4000)}`,
  )
  return result
}
