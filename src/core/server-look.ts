// Look: what the board reads on the server before it plans anything, in two rounds, and the parsers
// of what comes back. Both scripts only read (call 9): no file written, nothing pulled, started,
// stopped or reloaded; `caddy adapt` (it only prints) but never `caddy validate`. Their config's
// text never leaves the server: `caddy adapt`'s JSON and `nginx -T` are cut down there to the few
// facts the plan needs. Pure, with no node: import: the page renders "Do it myself" from the core.

import type {
  CaddyFacts,
  Container,
  Distro,
  DockerFacts,
  Holder,
  HostFacts,
  Mount,
  NginxFacts,
  Port,
  RoundOne,
  ServerFacts,
  StepOneFacts,
  Unit,
} from './server-facts.ts'
import { isContainerId, isPlainPath, shQuote } from './server-shell.ts'
import { KEYS_DIR, SSHD_CONFIG, SSHD_DIR } from './server-texts.ts'
import { keysFile, keysLine, socketFolder, sshdBlock } from './tunnel-snippets.ts'

/** The distributions Apply works on (owner, 2026-10-21); anything else is "Do it myself". */
export const SUPPORTED: Record<'debian' | 'ubuntu', string[]> = {
  debian: ['12', '13'],
  ubuntu: ['22.04', '24.04', '25.10', '26.04'],
}

/** The codenames Docker's apt repository serves for those (the spike checked each). */
export const DOCKER_CODENAMES: string[] = ['bookworm', 'trixie', 'jammy', 'noble', 'questing', 'resolute']

export interface LookInput {
  user: string
  socket: string
  domain: string
  /** The board's public key: Look says whether the tunnel user's keys file holds it alone. */
  publicKey?: string
}

const PORTS = [80, 443, 8443, 8480, 8481] as const

function prelude(kind: 'look-1' | 'look-2'): string[] {
  return [
    'exec </dev/null',
    `# agent-board: ${kind}`,
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
    'LC_ALL=C',
    'export PATH LC_ALL',
  ]
}

/** The sshd -T keys the tunnel spec's Match block sets, lowercased as sshd -T prints them, with their values. */
export function fenceWanted(user: string): Record<string, string> {
  const wanted: Record<string, string> = {}
  for (const line of sshdBlock(user).split('\n').slice(1)) {
    const [key = '', ...value] = line.trim().split(/\s+/)
    wanted[key.toLowerCase()] = value.join(' ')
  }
  return wanted
}

// One line per field (`{{println}}` ends each: a script line holds no newline), so a parser never
// has to split their values; the environment never leaves the server, nor labels other than
// compose's and the board's (they can hold anything).
const INSPECT = [
  '@@container {{.Id}}',
  'name {{json .Name}}',
  'image {{json .Config.Image}}',
  'path {{json .Path}}',
  'args {{json .Args}}',
  'netmode {{json .HostConfig.NetworkMode}}',
  '{{range $k, $v := .NetworkSettings.Networks}}network {{json $k}}{{println}}{{end}}mounts {{json .Mounts}}',
  'ports {{json .NetworkSettings.Ports}}',
  '{{range $k, $v := .Config.Labels}}label {{json $k}} {{json $v}}{{println}}{{end}}',
].join('{{println}}')

const SS_PORTS = `'( ${PORTS.map(p => `sport = :${p}`).join(' or ')} )'`
const PORTS_ALT = PORTS.join('|')

/**
 * Step 1's parts besides the fence and the folder, at the end of the fence section (a parser of
 * before reads past `@@` lines there): the tunnel user (`@@user <uid> <group>` or `@@user none`),
 * its keys file against the board's key line (`@@keys none|same|other`), /etc/ssh/authorized_keys
 * (`@@keys-dir`), and whether sshd_config includes sshd_config.d/*.conf before any Match line
 * (`@@include`), where sshd's fence goes in a file of its own.
 */
function stepOneLines(i: LookInput): string[] {
  const user = shQuote(i.user)
  const keys = shQuote(keysFile(i.user))
  const include = `tolower($1) == "match" { exit } tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") f = 1 } END { exit !f }`
  return [
    `if p=$(getent passwd ${user}); then echo "@@user $(printf '%s\\n' "$p" | cut -d: -f3) $(getent group "$(printf '%s\\n' "$p" | cut -d: -f4)" | cut -d: -f1)"; else echo '@@user none'; fi`,
    i.publicKey === undefined
      ? `if [ -e ${keys} ]; then echo '@@keys other'; else echo '@@keys none'; fi`
      : `if [ ! -e ${keys} ]; then echo '@@keys none'; elif [ "$(cat ${keys})" = ${shQuote(keysLine(i.publicKey))} ]; then echo '@@keys same'; else echo '@@keys other'; fi`,
    `if [ -d ${KEYS_DIR} ]; then echo '@@keys-dir'; fi`,
    `if [ -d ${SSHD_DIR} ] && awk '${include}' ${SSHD_CONFIG} 2>/dev/null; then echo '@@include'; fi`,
  ]
}

/** Round one: the distribution, who holds the web ports, Docker, the units, step 1 as the server has it. */
export function lookScript1(i: LookInput): string {
  const folder = shQuote(socketFolder(i.socket))
  const socket = shQuote(i.socket)
  const fenceKeys = Object.keys(fenceWanted(i.user)).join('|')
  return [
    ...prelude('look-1'),
    "echo '@@section os'",
    'cat /etc/os-release 2>/dev/null',
    'echo "@@arch $(uname -m)"',
    "echo '@@section ports'",
    `l=$(ss -H -ltnp ${SS_PORTS} 2>&1 | sed 's/[[:space:]]*$//')`,
    '[ -z "$l" ] || printf \'%s\\n\' "$l"',
    '# the cgroup of the first process on each socket: its unit or its container',
    `for p in $(printf '%s\\n' "$l" | sed -n 's/.*users:(("[^"]*",pid=\\([0-9]*\\),.*/\\1/p' | sort -u); do`,
    '  echo "@@pid $p"',
    '  cat "/proc/$p/cgroup" 2>/dev/null',
    'done',
    "echo '@@section docker'",
    'if command -v docker >/dev/null 2>&1; then',
    "  timeout 20 docker --version 2>&1 | sed -n '1,3s/^/@@cli /p'",
    `  echo "@@server $(timeout 20 docker version --format '{{.Server.Version}}' 2>/dev/null | head -n 1)"`,
    `  echo "@@security $(timeout 20 docker info --format '{{json .SecurityOptions}}' 2>/dev/null | head -n 1)"`,
    '  # a rootless daemon is not the one root talks to: its socket is under /run/user',
    '  for s in /run/user/*/docker.sock; do [ -S "$s" ] && echo "@@user-socket $s"; done',
    "  timeout 20 docker network ls --no-trunc --format '@@network {{json .Name}} {{json .Driver}}' 2>/dev/null",
    "  ids=$( { timeout 20 docker ps --no-trunc --format '{{.ID}} {{.Ports}}' \\",
    `      | grep -E ':(${PORTS_ALT})->' | cut -d ' ' -f 1`,
    '    timeout 20 docker ps -q --no-trunc --filter network=host',
    '    timeout 20 docker ps -q --no-trunc --filter label=agent-board.role; } 2>/dev/null | sort -u)',
    `  [ -z "$ids" ] || timeout 20 docker inspect --format ${shQuote(INSPECT)} $ids 2>/dev/null \\`,
    `    | sed -e '/^label "com\\.docker\\.compose\\./b' -e '/^label "agent-board\\./b' -e '/^label /d'`,
    'else',
    "  echo '@@none'",
    'fi',
    "echo '@@section systemd'",
    'if [ -d /run/systemd/system ]; then',
    "  echo '@@running'",
    '  timeout 20 systemctl show caddy.service nginx.service --no-pager \\',
    '    -p Id,LoadState,ActiveState,User,Group,WorkingDirectory,ExecStart,ExecReload 2>&1',
    'fi',
    "echo '@@section fence'",
    `sshd -T -C ${shQuote(`user=${i.user},host=localhost,addr=127.0.0.1`)} 2>&1 | grep -E '^(${fenceKeys}) '`,
    ...stepOneLines(i),
    "echo '@@section folder'",
    `stat -c '@@dir %a %U %G %g' ${folder} 2>&1`,
    `g=$(stat -c %g ${folder} 2>/dev/null) && getent group "$g" | sed 's/^/@@group /'`,
    `stat -c '@@socket %a %U %G %F' ${socket} 2>&1`,
    "echo '@@section record'",
    'if [ -f /etc/agent-board/setup.json ]; then',
    "  echo '@@file'",
    '  cat /etc/agent-board/setup.json',
    '  echo',
    'fi',
    'if [ -e /etc/agent-board/lock ]; then',
    '  i=$(stat -c %i /etc/agent-board/lock)',
    "  if grep -q \":$i \" /proc/locks; then echo '@@lock held'; else echo '@@lock free'; fi",
    'fi',
    "echo '@@section host'",
    'echo "@@selinux $(getenforce 2>/dev/null)"',
    'echo "@@forward $(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"',
    'for c in lxd libvirtd wg; do command -v "$c" >/dev/null 2>&1 && echo "@@forwarder $c"; done',
    'for c in curl wget; do command -v "$c" >/dev/null 2>&1 && echo "@@fetch $c"; done',
    'for c in flock setsid runuser timeout base64 sha256sum ss getent gzip; do',
    '  command -v "$c" >/dev/null 2>&1 || echo "@@missing $c"',
    'done',
    'echo "@@sudo $(sudo --version 2>/dev/null | head -n 1)"',
    'echo "@@ls $(ls --version 2>/dev/null | head -n 1)"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own ${field} syntax
    "dpkg-query -W -f '@@package ${Package} ${db:Status-Status}\\n' docker.io podman-docker containerd runc 2>/dev/null",
    "echo '@@section dns'",
    "echo '@@part domain'",
    `timeout 10 getent ahosts ${shQuote(i.domain)} 2>/dev/null`,
    "echo '@@part local'",
    'ip -o addr show 2>/dev/null',
    "echo '@@end'",
    '',
  ].join('\n')
}

// --- What the second round reads, from round one --------------------------------------------------

interface CaddyTarget {
  where: 'unit' | 'container'
  container: string | null
  /**
   * The shell words that run their caddy (30 s at most): its unit's binary, or `docker exec <id>
   * caddy`. STEPPATH=/: Caddy 2.6 (its smallstep part) makes `$HOME/.step` on any run, even
   * `caddy version`; pointed at a folder that exists, it writes nothing (the spike checked).
   */
  run: string
  config: string
  hostPath: string | null
  mount: CaddyFacts['mount']
  adapter: string
  resume: boolean
}

interface NginxTarget {
  run: string
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** `--name value` or `--name=value` from an argv; '' when absent. */
function flag(argv: readonly string[], name: string): string {
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n] ?? ''
    if (a === name) return argv[n + 1] ?? ''
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1)
  }
  return ''
}

/** Caddy's own rule: an explicit --adapter, else a file named Caddyfile… (or *.caddyfile) is a Caddyfile. */
function adapterOf(argv: readonly string[], config: string): string {
  const given = flag(argv, '--adapter')
  if (given) return given
  if (!config) return ''
  const name = base(config)
  return name.startsWith('Caddyfile') || name.endsWith('.caddyfile') ? 'caddyfile' : 'json'
}

/** The program a container runs: its command, past an entrypoint script. */
function containerProgram(c: Pick<Container, 'cmd'>): string {
  const first = base(c.cmd[0] ?? '')
  return first.endsWith('.sh') && c.cmd[1] ? base(c.cmd[1]) : first
}

function caddyTarget(r: RoundOne): CaddyTarget | null {
  const h = r.ports[443]
  if (h.kind === 'unit' && h.unit === 'caddy.service' && h.program === 'caddy' && r.units.caddy) {
    const argv = r.units.caddy.execStart
    const given = flag(argv, '--config')
    const wd = r.units.caddy.workingDirectory
    const config = given && !given.startsWith('/') && wd.startsWith('/') ? `${wd.replace(/\/$/, '')}/${given}` : given
    const bin = argv[0] ?? ''
    return {
      where: 'unit',
      container: null,
      run: `STEPPATH=/ timeout 30 ${shQuote(isPlainPath(bin) ? bin : 'caddy')}`,
      config,
      hostPath: isPlainPath(config) ? config : null,
      mount: null,
      adapter: adapterOf(argv, config),
      resume: argv.includes('--resume'),
    }
  }
  if (h.kind !== 'container' || h.program !== 'caddy' || !isContainerId(h.id)) return null
  const c = r.docker?.containers.find(x => x.id === h.id)
  if (!c) return null
  const config = flag(c.cmd, '--config')
  if (/[\n\r\0]/.test(config) || /[\n\r\0]/.test(c.cmd[0] ?? '')) return null
  let mount: CaddyFacts['mount'] = null
  let hostPath: string | null = null
  if (config.startsWith('/')) {
    const file = c.mounts.find(m => m.type === 'bind' && m.destination === config)
    const folder = c.mounts
      .filter(m => config.startsWith(`${m.destination.replace(/\/$/, '')}/`))
      .sort((a, b) => b.destination.length - a.destination.length)[0]
    if (file) {
      mount = 'file'
      hostPath = file.source
    } else if (folder) {
      mount = folder.type === 'bind' ? 'folder' : 'volume'
      hostPath = `${folder.source.replace(/\/$/, '')}${config.slice(folder.destination.replace(/\/$/, '').length)}`
    }
  }
  return {
    where: 'container',
    container: c.id,
    run: `timeout 30 docker exec -e STEPPATH=/ ${c.id} ${shQuote(c.cmd[0] || 'caddy')}`,
    config,
    hostPath: hostPath && isPlainPath(hostPath) ? hostPath : null,
    mount,
    adapter: adapterOf(c.cmd, config),
    resume: c.cmd.includes('--resume'),
  }
}

function nginxTarget(r: RoundOne): NginxTarget | null {
  const held = [r.ports[80], r.ports[443]].some(
    h => (h.kind === 'unit' || h.kind === 'process') && h.program === 'nginx',
  )
  if (!held) return null
  const argv = r.units.nginx?.execStart ?? []
  const bin = argv[0] ?? ''
  const conf = flag(argv, '-c')
  const run = [shQuote(isPlainPath(bin) ? bin : 'nginx')]
  if (conf && isPlainPath(conf)) run.push('-c', shQuote(conf))
  return { run: run.join(' ') }
}

const ADAPT_FACTS = `'"host":\\[[^]]*\\]|"admin":\\{"disabled":true|"automatic_https":\\{"disable":true|^@@adapt-exit [0-9]+$'`
const NGINX_LINES = `'^[[:space:]]*(include|listen|server_name)[[:space:]]|^# configuration file |^@@nginx-exit '`

/** Round two, for the holder of 443 (and nginx on 80); null when nothing needs it. */
export function lookScript2(r: RoundOne, _i: LookInput): string | null {
  const caddy = caddyTarget(r)
  const nginx = nginxTarget(r)
  if (!caddy && !nginx) return null
  const lines = prelude('look-2')
  if (caddy) {
    lines.push("echo '@@section caddy'", `echo "@@version $(${caddy.run} version 2>&1 | head -n 1)"`)
    if (caddy.config && caddy.adapter === 'caddyfile' && !caddy.resume) {
      const config = caddy.where === 'unit' ? (caddy.hostPath ?? caddy.config) : caddy.config
      lines.push(
        "echo '@@part adapt'",
        `{ ${caddy.run} adapt --config ${shQuote(config)} --adapter ${shQuote(caddy.adapter)} 2>/dev/null; e=$?; echo; echo "@@adapt-exit $e"; } \\`,
        `  | grep -oE ${ADAPT_FACTS}`,
      )
    }
    if (caddy.hostPath) {
      lines.push(
        `f=${shQuote(caddy.hostPath)}`,
        'echo "@@sha256 $(sha256sum < "$f" 2>&1)"',
        'echo "@@newline $(tail -c 1 "$f" 2>/dev/null | wc -l)"',
      )
    }
    lines.push("echo '@@part listen'", "ss -H -ltn 'sport = :443' 2>/dev/null")
  }
  if (nginx) {
    lines.push(
      "echo '@@section nginx'",
      `{ timeout 30 ${nginx.run} -T 2>/dev/null; echo "@@nginx-exit $?"; } | grep -E ${NGINX_LINES}`,
    )
  }
  lines.push("echo '@@end'", '')
  return lines.join('\n')
}

// --- Reading what came back -----------------------------------------------------------------------

const ROUND_ONE = ['os', 'ports', 'docker', 'systemd', 'fence', 'folder', 'record', 'host', 'dns']
const HEX64 = /^[0-9a-f]{64}$/
const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"'

class Unreadable extends Error {}

/** The lines of each `@@section`; null when one is missing, twice or unknown, or `@@end` never came. */
function sections(out: string, names: readonly string[]): Map<string, string[]> | null {
  const found = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of out.replaceAll('\r', '').split('\n')) {
    if (line === '@@end') return found.size === names.length ? found : null
    const name = /^@@section (\S+)$/.exec(line)?.[1]
    if (name !== undefined) {
      if (!names.includes(name) || found.has(name)) return null
      current = []
      found.set(name, current)
    } else current?.push(line)
  }
  return null
}

const lines = (s: Map<string, string[]>, name: string): string[] => s.get(name) ?? []

/** The value of an `@@<key> <value>` line ('' when the line is there, empty), or null. */
function at(ls: readonly string[], key: string): string | null {
  for (const l of ls) {
    if (l === `@@${key}`) return ''
    if (l.startsWith(`@@${key} `)) return l.slice(key.length + 3)
  }
  return null
}
const all = (ls: readonly string[], key: string): string[] =>
  ls.filter(l => l.startsWith(`@@${key} `)).map(l => l.slice(key.length + 3))

/** The lines under each `@@part <name>`. */
function parts(ls: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  let current: string[] | null = null
  for (const l of ls) {
    const name = /^@@part (\S+)$/.exec(l)?.[1]
    if (name !== undefined) {
      current = []
      found.set(name, current)
    } else current?.push(l)
  }
  return found
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Unreadable(text.slice(0, 80))
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** os-release's values: quoted or not, with its backslash escapes. */
function osValue(raw: string): string {
  const q = raw[0]
  if ((q === '"' || q === "'") && raw.endsWith(q) && raw.length > 1) return raw.slice(1, -1).replace(/\\(.)/g, '$1')
  return raw
}

function readDistro(ls: readonly string[]): Distro {
  const kv = new Map<string, string>()
  for (const l of ls) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l)
    if (m) kv.set(m[1] ?? '', osValue(m[2] ?? ''))
  }
  const id = kv.get('ID') ?? ''
  const version = kv.get('VERSION_ID') ?? ''
  const list = id === 'debian' || id === 'ubuntu' ? SUPPORTED[id] : []
  return {
    id,
    version,
    codename: kv.get('VERSION_CODENAME') || kv.get('UBUNTU_CODENAME') || '',
    arch: (at(ls, 'arch') ?? '').trim(),
    supported: list.includes(version),
  }
}

interface Listen {
  port: number
  address: string
  procs: { name: string; pid: number }[]
}

/** `ss -H -ltn(p)` lines: the local address and port, and the processes on the socket. */
function readListens(ls: readonly string[]): Listen[] {
  const found: Listen[] = []
  for (const l of ls) {
    const fields = l.trim().split(/\s+/)
    const state = fields.indexOf('LISTEN')
    const local = state < 0 ? undefined : fields[state + 3]
    if (!local) continue
    const colon = local.lastIndexOf(':')
    const port = Number(local.slice(colon + 1))
    if (colon < 0 || !Number.isInteger(port)) continue
    const procs = [...l.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g)].map(m => ({
      name: m[1] ?? '',
      pid: Number(m[2]),
    }))
    found.push({ port, address: local.slice(0, colon), procs })
  }
  return found
}

type Place = { kind: 'unit'; unit: string } | { kind: 'container'; id: string } | { kind: 'other' }

/**
 * Where a process runs, from its /proc/<pid>/cgroup: a container (`docker-<id>.scope` with systemd's
 * cgroup driver, `/docker/<id>` with cgroupfs), a unit (`….service`), or anything else. The deepest
 * part decides, so a server that is itself a container (`/docker/<id>/system.slice/caddy.service`)
 * reads as the server it is.
 */
function place(cgroup: readonly string[]): Place {
  const line =
    cgroup.find(l => l.startsWith('0::')) ?? cgroup.find(l => l.includes(':name=systemd:')) ?? cgroup[0] ?? ''
  const path = line.split(':').slice(2).join(':')
  const p = path.split('/').filter(Boolean)
  for (let n = p.length - 1; n >= 0; n--) {
    const part = p[n] ?? ''
    const scope = /^docker-([0-9a-f]{64})\.scope$/.exec(part)?.[1]
    if (scope) return { kind: 'container', id: scope }
    if (HEX64.test(part) && p[n - 1] === 'docker') return { kind: 'container', id: part }
    if (part.endsWith('.service')) return { kind: 'unit', unit: part }
    if (part.endsWith('.scope')) return { kind: 'other' }
  }
  return { kind: 'other' }
}

function readPids(ls: readonly string[]): Map<number, string[]> {
  const found = new Map<number, string[]>()
  let current: string[] | null = null
  for (const l of ls) {
    const pid = /^@@pid (\d+)$/.exec(l)?.[1]
    if (pid !== undefined) {
      current = []
      found.set(Number(pid), current)
    } else if (current && /^\d+:/.test(l)) current.push(l)
  }
  return found
}

/** Who holds a port: what `ss` names, its cgroup, or Docker's binding (docker-proxy, or dockerd with the userland proxy off). */
function holderOf(
  port: Port,
  listens: readonly Listen[],
  pids: Map<number, string[]>,
  docker: DockerFacts | null,
): Holder {
  const bound = (): Container | undefined => docker?.containers.find(c => c.ports.some(b => b.public === port))
  const fromBinding = (c: Container): Holder => ({ kind: 'container', id: c.id, program: containerProgram(c) })
  const mine = listens.filter(l => l.port === port)
  if (!mine.length) {
    const c = bound()
    return c ? fromBinding(c) : { kind: 'free' }
  }
  const holders = new Map<string, Holder>()
  for (const l of mine) {
    const proc = l.procs[0]
    let h: Holder
    if (!proc) h = { kind: 'process', program: '' }
    else {
      const c = proc.name === 'docker-proxy' || proc.name === 'dockerd' ? bound() : undefined
      const where = place(pids.get(proc.pid) ?? [])
      if (c) h = fromBinding(c)
      else if (where.kind === 'container') h = { kind: 'container', id: where.id, program: proc.name }
      else if (where.kind === 'unit') h = { kind: 'unit', unit: where.unit, program: proc.name }
      else h = { kind: 'process', program: proc.name }
    }
    holders.set(JSON.stringify(h), h)
  }
  const found = [...holders.values()]
  if (found.length === 1 && found[0]) return found[0]
  const programs = found.map(h => ('program' in h ? h.program : ''))
  return { kind: 'split', programs: [...new Set(programs)] }
}

function readContainer(id: string, ls: readonly string[], drivers: Map<string, string>): Container {
  if (!isContainerId(id)) throw new Unreadable(id)
  const one = (key: string): unknown => {
    const l = ls.find(x => x.startsWith(`${key} `))
    return l === undefined ? null : json(l.slice(key.length + 1))
  }
  const netmode = str(one('netmode'))
  const names = ls.filter(l => l.startsWith('network ')).map(l => str(json(l.slice(8))))
  const mounts: Mount[] = []
  const rawMounts = one('mounts')
  for (const m of Array.isArray(rawMounts) ? rawMounts : []) {
    if (!isRecord(m) || (m.Type !== 'bind' && m.Type !== 'volume')) continue
    mounts.push({ type: m.Type, source: str(m.Source), destination: str(m.Destination) })
  }
  const ports: Container['ports'] = []
  const rawPorts = one('ports')
  for (const [key, bindings] of Object.entries(isRecord(rawPorts) ? rawPorts : {})) {
    const m = /^(\d+)\/tcp$/.exec(key)
    if (!m || !Array.isArray(bindings)) continue
    for (const b of bindings) {
      if (isRecord(b)) ports.push({ private: Number(m[1]), public: Number(str(b.HostPort)), ip: str(b.HostIp) })
    }
  }
  const labels: Record<string, string> = {}
  for (const l of ls) {
    const m = new RegExp(`^label (${JSON_STRING}) (.*)$`).exec(l)
    if (m) labels[str(json(m[1] ?? ''))] = str(json(m[2] ?? ''))
  }
  const args = one('args')
  return {
    id,
    name: str(one('name')).replace(/^\//, ''),
    image: str(one('image')),
    cmd: [str(one('path')), ...(Array.isArray(args) ? args.map(str) : [])],
    hostNetwork: netmode === 'host',
    networks: names.map(name => ({
      name,
      driver: drivers.get(name) ?? '',
      userDefined: !['bridge', 'host', 'none'].includes(name),
    })),
    mounts,
    ports,
    labels,
  }
}

function readDocker(ls: readonly string[]): DockerFacts | null {
  if (ls.includes('@@none')) return null
  const server = (at(ls, 'server') ?? '').trim()
  const security = (at(ls, 'security') ?? '').trim()
  let options: string[] = []
  if (security.startsWith('[')) {
    const v = json(security)
    options = Array.isArray(v) ? v.map(str) : []
  }
  const named = (name: string): boolean => options.some(o => o.split(',').includes(`name=${name}`))
  const version = /^\d+\.\d+/.test(server) ? server : ''
  const drivers = new Map<string, string>()
  for (const l of all(ls, 'network')) {
    const m = new RegExp(`^(${JSON_STRING}) (${JSON_STRING})$`).exec(l)
    if (m) drivers.set(str(json(m[1] ?? '')), str(json(m[2] ?? '')))
  }
  const containers: Container[] = []
  let id: string | null = null
  let block: string[] = []
  const flush = (): void => {
    if (id !== null) containers.push(readContainer(id, block, drivers))
  }
  for (const l of ls) {
    const next = /^@@container (\S+)$/.exec(l)?.[1]
    if (next !== undefined) {
      flush()
      id = next
      block = []
    } else if (id !== null && l && !l.startsWith('@@')) block.push(l)
  }
  flush()
  return {
    version,
    podman: all(ls, 'cli').some(l => /podman/i.test(l)),
    // root's docker talks to the system's daemon; a rootless one shows as its socket under /run/user
    rootless: named('rootless') || (!version && all(ls, 'user-socket').length > 0),
    userns: named('userns'),
    containers,
  }
}

/** `argv[]=` of a `systemctl show` Exec value (systemd joins it with spaces). */
function argvOf(value: string): string[] {
  const m = /argv\[\]=(.*?) ; ignore_errors=/.exec(value)
  return m ? (m[1] ?? '').split(' ').filter(Boolean) : []
}

function readUnits(ls: readonly string[]): { caddy: Unit | null; nginx: Unit | null } {
  const units = new Map<string, Unit | null>()
  let kv = new Map<string, string>()
  const flush = (): void => {
    const id = kv.get('Id')
    if (id) {
      units.set(
        id,
        kv.get('LoadState') === 'not-found'
          ? null
          : {
              execStart: argvOf(kv.get('ExecStart') ?? ''),
              execReload: argvOf(kv.get('ExecReload') ?? ''),
              user: kv.get('User') ?? '',
              group: kv.get('Group') ?? '',
              active: kv.get('ActiveState') ?? '',
              workingDirectory: kv.get('WorkingDirectory') ?? '',
            },
      )
    }
    kv = new Map()
  }
  for (const l of ls) {
    if (l.startsWith('@@')) continue
    if (!l.trim()) flush()
    else {
      const eq = l.indexOf('=')
      if (eq > 0) kv.set(l.slice(0, eq), l.slice(eq + 1))
    }
  }
  flush()
  return { caddy: units.get('caddy.service') ?? null, nginx: units.get('nginx.service') ?? null }
}

function readFence(ls: readonly string[]): Record<string, string> {
  const fence: Record<string, string> = {}
  for (const l of ls) {
    const m = /^([a-z0-9]+) (.*)$/.exec(l)
    if (m) fence[m[1] ?? ''] = m[2] ?? ''
  }
  return fence
}

/** Step 1's parts from the fence section; undefined when Look did not read them (no `@@user` line). */
function readStepOne(ls: readonly string[]): StepOneFacts | undefined {
  const user = at(ls, 'user')
  if (user === null) return undefined
  const m = /^(\d+)(?:\s+(\S+))?\s*$/.exec(user)
  const keys = at(ls, 'keys')
  return {
    user: m ? { uid: Number(m[1]), group: m[2] ?? '' } : null,
    keys: keys === 'none' || keys === 'same' ? keys : 'other',
    keysDir: ls.includes('@@keys-dir'),
    include: ls.includes('@@include'),
  }
}

function readFolder(ls: readonly string[]): Pick<RoundOne, 'folder' | 'socket'> {
  const dir = /^(\d+) (\S+) (\S+) (\d+)$/.exec(at(ls, 'dir') ?? '')
  const members = (at(ls, 'group') ?? '').split(':')[3] ?? ''
  const sock = /^(\d+) (\S+) (\S+) socket$/.exec(at(ls, 'socket') ?? '')
  return {
    folder: dir
      ? {
          mode: dir[1] ?? '',
          owner: dir[2] ?? '',
          group: dir[3] ?? '',
          gid: Number(dir[4]),
          members: members.split(',').filter(Boolean),
        }
      : null,
    socket: sock ? { mode: sock[1] ?? '', owner: sock[2] ?? '', group: sock[3] ?? '' } : null,
  }
}

function readRecord(ls: readonly string[]): Pick<RoundOne, 'record' | 'lockHeld'> {
  const start = ls.indexOf('@@file')
  let record: unknown = null
  if (start >= 0) {
    const body: string[] = []
    for (const l of ls.slice(start + 1)) {
      if (l.startsWith('@@lock')) break
      body.push(l)
    }
    const text = body.join('\n').trim()
    try {
      record = JSON.parse(text)
    } catch {
      record = text
    }
  }
  return { record, lockHeld: ls.includes('@@lock held') }
}

function readHost(ls: readonly string[]): HostFacts {
  const selinux = (at(ls, 'selinux') ?? '').trim().toLowerCase()
  const sudo = at(ls, 'sudo') ?? ''
  const coreutils = at(ls, 'ls') ?? ''
  const fetch = all(ls, 'fetch')[0]
  return {
    selinux: selinux === 'enforcing' || selinux === 'permissive' || selinux === 'disabled' ? selinux : null,
    forwarding: (at(ls, 'forward') ?? '').trim() === '1',
    forwarders: all(ls, 'forwarder'),
    fetch: fetch === 'curl' || fetch === 'wget' ? fetch : null,
    missing: all(ls, 'missing'),
    sudo: sudo.startsWith('sudo-rs') ? 'sudo-rs' : sudo.startsWith('Sudo version') ? 'sudo' : null,
    coreutils: /uutils/.test(coreutils) ? 'rust' : /GNU coreutils/.test(coreutils) ? 'gnu' : null,
    conflicts: all(ls, 'package')
      .map(l => l.split(' '))
      .filter(([, status]) => status === 'installed')
      .map(([name]) => name ?? ''),
  }
}

function readDns(ls: readonly string[]): RoundOne['dns'] {
  const p = parts(ls)
  const first = (l: string, n: number): string => l.trim().split(/\s+/)[n] ?? ''
  const domain = (p.get('domain') ?? []).map(l => first(l, 0)).filter(Boolean)
  const local = (p.get('local') ?? []).map(l => first(l, 3).split('/')[0] ?? '').filter(Boolean)
  return { domain: [...new Set(domain)], local: [...new Set(local)] }
}

/** Round one's output; null when it is garbled, cut, or has a section missing or twice ("Look could not read the server"). */
export function readRoundOne(out: string): RoundOne | null {
  const s = sections(out, ROUND_ONE)
  if (!s) return null
  try {
    const docker = readDocker(lines(s, 'docker'))
    const ports = lines(s, 'ports')
    const listens = readListens(ports.filter(l => !l.startsWith('@@')))
    const pids = readPids(ports)
    const holders = {} as Record<Port, Holder>
    for (const port of PORTS) holders[port] = holderOf(port, listens, pids, docker)
    const systemd = lines(s, 'systemd')
    const stepOne = readStepOne(lines(s, 'fence'))
    return {
      distro: readDistro(lines(s, 'os')),
      ports: holders,
      docker,
      systemd: systemd.includes('@@running'),
      units: readUnits(systemd),
      fence: readFence(lines(s, 'fence')),
      ...readFolder(lines(s, 'folder')),
      ...(stepOne && { stepOne }),
      ...readRecord(lines(s, 'record')),
      host: readHost(lines(s, 'host')),
      dns: readDns(lines(s, 'dns')),
    }
  } catch (e) {
    if (e instanceof Unreadable) return null
    throw e
  }
}

/** The address their proxy answers 443 on, for `curl --resolve`: a wildcard is the loopback. */
function fetchAddress(r: RoundOne, listens: readonly Listen[], container: string | null): string {
  const near = (a: string): string => (['0.0.0.0', '*', '[::]', '::', ''].includes(a) ? '127.0.0.1' : a)
  const l = listens.find(x => x.port === 443)
  if (l) return near(l.address)
  const c = r.docker?.containers.find(x => x.id === container)
  const b = c?.ports.find(x => x.public === 443)
  return b ? near(b.ip) : '127.0.0.1'
}

function readCaddy(r: RoundOne, t: CaddyTarget, ls: readonly string[]): CaddyFacts {
  const p = parts(ls)
  const adapt = p.get('adapt') ?? []
  const hosts: string[] = []
  for (const l of adapt) {
    if (!l.startsWith('"host":[')) continue
    const v = json(`{${l}}`)
    if (isRecord(v) && Array.isArray(v.host)) hosts.push(...v.host.map(str))
  }
  const sha = (at(ls, 'sha256') ?? '').trim().split(/\s+/)[0] ?? ''
  return {
    where: t.where,
    container: t.container,
    config: t.config,
    hostPath: t.hostPath,
    mount: t.mount,
    adapter: t.adapter,
    resume: t.resume,
    version: /v?(\d+\.\d+\.\d+\S*)/.exec(at(ls, 'version') ?? '')?.[1] ?? '',
    hosts: [...new Set(hosts)],
    adminOff: adapt.includes('"admin":{"disabled":true'),
    autoHttpsOff: adapt.includes('"automatic_https":{"disable":true'),
    sha256: HEX64.test(sha) ? sha : '',
    endsWithNewline: (at(ls, 'newline') ?? '').trim() === '1',
    address: fetchAddress(r, readListens(p.get('listen') ?? []), t.container),
  }
}

function readNginx(ls: readonly string[]): NginxFacts {
  const words = (l: string): string[] => l.trim().replace(/;$/, '').split(/\s+/)
  const listen80: string[] = []
  const serverNames: string[] = []
  let confD = false
  for (const l of ls) {
    const [directive, ...rest] = words(l)
    if (directive === 'include' && rest[0] === '/etc/nginx/conf.d/*.conf') confD = true
    if (directive === 'listen' && rest[0]) {
      const a = rest[0]
      const port = /^\d+$/.test(a) ? a : a.slice(a.lastIndexOf(':') + 1)
      if (port === '80' && !listen80.includes(a)) listen80.push(a)
    }
    if (directive === 'server_name') {
      for (const n of rest) if (n !== '_' && n !== '""' && !serverNames.includes(n)) serverNames.push(n)
    }
  }
  return { confD, listen80, serverNames }
}

/** Round one with round two's facts; '' for round two when lookScript2 gave null. Null when round two is unreadable. */
export function readServerFacts(r: RoundOne, out: string): ServerFacts | null {
  const caddy = caddyTarget(r)
  const nginx = nginxTarget(r)
  if (!caddy && !nginx) return { ...r, caddy: null, nginx: null }
  const s = sections(out, [...(caddy ? ['caddy'] : []), ...(nginx ? ['nginx'] : [])])
  if (!s) return null
  try {
    return {
      ...r,
      caddy: caddy ? readCaddy(r, caddy, lines(s, 'caddy')) : null,
      nginx: nginx ? readNginx(lines(s, 'nginx')) : null,
    }
  } catch (e) {
    if (e instanceof Unreadable) return null
    throw e
  }
}

/** The sshd -T keys the tunnel spec's Match block sets that differ from sshdBlock(user)'s, in its order. */
export function fenceDiff(fence: Record<string, string>, user: string): string[] {
  return Object.entries(fenceWanted(user))
    .filter(([key, value]) => fence[key] !== value)
    .map(([key]) => key)
}
