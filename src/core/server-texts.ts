// What the board puts on the server when it sets up the web server in front of the tunnel, per
// case (the server-setup spec's "The cases"): its own Caddy's config, the site its owner's Caddy
// imports, the marked block, nginx's file for the certificate checks, the argv of its two
// containers and Docker's install; and step 1's (the simple-setup spec's "Step 1 by the board"):
// the tunnel user's marker, its keys file, sshd's fence in a file of its own or at the end of
// sshd_config. The plan (core/server-plan.ts) and "Do it myself" take them from here, as do the
// integration tests. Pure, with no node: import: the page imports it.
import type { Wanted } from './server-plan.ts'
import { socketFolder, sshdBlock } from './tunnel-snippets.ts'

/** The board's Caddy: the Caddy 2 release current when this was written, by tag and digest. */
export const CADDY_IMAGE = 'caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af'
/** The helper of case 3 (a byte pipe from TCP to the socket), by tag and digest. */
export const SOCAT_IMAGE =
  'alpine/socat:1.8.1.3@sha256:22d77becaeeea8ef56b8c4bb2312323acafe85354be6a85714ff5050e3537842'

/** A test CA for the board's Caddy: its directory URL and its root's PEM on the server (BOARD_SETUP_ACME_CA, BOARD_SETUP_ACME_CA_ROOT). */
export interface Acme {
  ca: string
  root: string
}

/** The cases that run the board's own Caddy. */
export type OwnCaddy = '1' | '1b' | '4a' | '4b'

/** Where the board keeps what it owns on the server. */
export const BOARD_DIR = '/etc/agent-board'
export const RECORD_FILE = `${BOARD_DIR}/setup.json`
export const LOCK_FILE = `${BOARD_DIR}/lock`
export const RUNS_DIR = `${BOARD_DIR}/runs`
export const BACKUPS_DIR = `${BOARD_DIR}/backups`
/** The board's own Caddy's config: the folder is mounted, so a rewrite reaches the container. */
export const CADDY_DIR = `${BOARD_DIR}/caddy`
export const CADDY_FILE = `${CADDY_DIR}/Caddyfile`
/** Case 2: the board's site, in a folder of its own beside their Caddyfile. */
export const SITE_DIR = '/etc/caddy/agent-board'
export const SITE_FILE = `${SITE_DIR}/board.caddy`
/** Case 4b: the board's file in a folder their nginx includes. */
export const NGINX_FILE = '/etc/nginx/conf.d/agent-board.conf'

/** sshd's own config, and the folder its `Include` reads on Debian 12+ and Ubuntu 22.04+. */
export const SSHD_CONFIG = '/etc/ssh/sshd_config'
export const SSHD_DIR = '/etc/ssh/sshd_config.d'
/**
 * sshd's fence in a file of its own. sshd ends a Match block at the end of the included file it is
 * in (it puts the including file's Match state back after each file: OpenSSH 8.9p1, 10.0p2 and
 * 10.2p1 checked), so it captures nothing after it. First by name: among Match blocks for the
 * tunnel user, the first one sshd reads sets each setting.
 */
export const FENCE_FILE = `${SSHD_DIR}/00-agent-board.conf`
/** The tunnel users' keys files' folder (tunnel-snippets.ts keysFile). */
export const KEYS_DIR = '/etc/ssh/authorized_keys'
/** The tunnel user's comment (GECOS) when the board made it: Undo removes only a user that has it. */
export const USER_COMMENT = 'agent-board tunnel'

export const CADDY_NAME = 'agent-board-caddy'
export const SOCKET_NAME = 'agent-board-socket'
export const VOLUMES = ['agent-board-caddy-data', 'agent-board-caddy-config'] as const
/** The labels on the board's containers and volumes: what it is, which run made it, a hash of its settings. */
export const ROLE_LABEL = 'agent-board.role'
export const SETUP_LABEL = 'agent-board.setup'
export const ARGS_LABEL = 'agent-board.args'
export const GID_LABEL = 'agent-board.gid'

/** Case 4's public port; where 4b's Caddy takes the checks nginx forwards; 3b's helper on the loopback; 3a's helper inside its network. */
export const PORT_4 = 8443
export const PORT_4B_CHECK = 8480
export const PORT_3B = 8481
export const PORT_3A = 8080
/** The path 4b's run fetches through nginx to see the checks reach the board's Caddy. */
export const CHECK_PATH = '/.well-known/acme-challenge/agent-board-check'

/** The one line case 2 adds to their Caddyfile: its comment is its marker. */
export const IMPORT_LINE = `import ${SITE_FILE} # agent-board`
/** Case 3's block in their Caddyfile starts with a line that starts so, and ends with this line. */
export const BLOCK_BEGIN = '# >>> agent-board'
export const BLOCK_END = '# <<< agent-board'

const ADDED = 'the board through its tunnel. Added by "Set up the server"; its Undo removes it.'

/** The site block, tab-indented as `caddy fmt` writes it. */
function site(address: string, upstream: string, tls: string[] = []): string[] {
  return [
    `${address} {`,
    ...tls,
    `\treverse_proxy ${upstream}`,
    '\theader Strict-Transport-Security "max-age=31536000"',
    '}',
  ]
}

const issuer = (option: string): string[] => ['\ttls {', '\t\tissuer acme {', `\t\t\t${option}`, '\t\t}', '\t}']

/** The board's own Caddy's Caddyfile for a case; a test CA's lines in its global block first. */
export function boardCaddyfile(c: OwnCaddy, w: Wanted, acme?: Acme): string {
  const upstream = `unix/${w.socket}`
  const global = acme ? [`\tacme_ca ${acme.ca}`, `\tacme_ca_root ${acme.root}`] : []
  let own: string[]
  let sites: string[]
  if (c === '1') {
    own = []
    sites = site(w.domain, upstream)
  } else if (c === '1b') {
    // 80 is someone else's: the certificate check on 443 alone (TLS-ALPN), no redirects on 80
    own = ['\tauto_https disable_redirects']
    sites = site(w.domain, upstream, issuer('disable_http_challenge'))
  } else {
    // 443 is someone else's: HTTPS on 8443, the check on 80 (HTTP-01)
    own = [`\thttps_port ${PORT_4}`]
    sites = site(`${w.domain}:${PORT_4}`, upstream, issuer('disable_tlsalpn_challenge'))
    if (c === '4b') sites.push(`http://${w.domain} {`, `\trespond ${CHECK_PATH} "agent-board"`, '}')
  }
  const options = [...global, ...own]
  return [...(options.length ? ['{', ...options, '}'] : []), ...sites].join('\n')
}

/** Case 2: the board's site for their Caddy, in its own file their Caddyfile imports. */
export function siteFile(w: Wanted): string {
  return [`# agent-board: ${ADDED}`, ...site(w.domain, `unix/${w.socket}`)].join('\n')
}

/** Case 3: the board's block at the end of their Caddyfile, to the helper ('agent-board-socket:8080' in 3a, '127.0.0.1:8481' in 3b). */
export function markedBlock(w: Wanted, upstream: string): string {
  return [`${BLOCK_BEGIN}: ${ADDED}`, ...site(w.domain, upstream), BLOCK_END].join('\n')
}

const FENCE_NOTE = `sshd's fence for the board's tunnel user. Added by "Set up the server"; its Undo removes it.`

/** sshd's fence in its own file under sshd_config.d: one comment line, then the Match block as it is. */
export function fenceFile(user: string): string {
  return [`# agent-board: ${FENCE_NOTE}`, sshdBlock(user)].join('\n')
}

/**
 * sshd's fence at the end of sshd_config (no Include there), between the board's markers. A Match
 * block runs to the next Match line or the end of the file: `Match all` after it makes what someone
 * adds below it later a setting for everyone again, not one for the tunnel user alone.
 */
export function fenceBlock(user: string): string {
  return [`${BLOCK_BEGIN}: ${FENCE_NOTE}`, sshdBlock(user), 'Match all', BLOCK_END].join('\n')
}

/**
 * Case 4b: their nginx sends the certificate checks for the domain, and nothing else, to the
 * board's Caddy. It listens where their own port-80 servers do (the address only: no
 * default_server, no options), 80 when Look read none.
 */
export function nginxFile(w: Wanted, listen80: string[]): string {
  // an address nginx takes, and nothing else of their line (no `;`, no options)
  const addresses = [
    ...new Set(listen80.map(l => l.trim().split(/\s+/)[0] ?? '').filter(a => /^[\w.:[\]*-]+$/.test(a))),
  ]
  return [
    `# agent-board: certificate checks for ${w.domain} go to the board's own Caddy. Its Undo removes this file.`,
    'server {',
    ...(addresses.length ? addresses : ['80']).map(a => `    listen ${a};`),
    `    server_name ${w.domain};`,
    '    location /.well-known/acme-challenge/ {',
    `        proxy_pass http://127.0.0.1:${PORT_4B_CHECK};`,
    '        proxy_set_header Host $host;',
    '    }',
    '    location / {',
    `        return 301 https://$host:${PORT_4}$request_uri;`,
    '    }',
    '}',
  ].join('\n')
}

/**
 * A short hash of a container's settings (FNV-1a, 64 bits, in hex), kept in its ARGS_LABEL: a
 * container whose label says the same is left as it is, another is recreated. Not for security.
 */
export function argsHash(args: readonly string[]): string {
  let h = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(JSON.stringify(args))) {
    h ^= BigInt(byte)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/** The word for the folder's gid in the settings the hash is of. */
const ANY_GID = '<gid>'

/**
 * `docker run`'s argv with the board's labels. The settings' hash is of everything but the run's id
 * and the socket folder's gid, which has a label of its own: a run that makes the folder learns its
 * gid only on the server, and its settings must hash as a later Look's do.
 */
function labelled(
  name: string,
  role: string,
  runId: string,
  gid: number | string,
  settings: (gid: string) => string[],
  image: string,
  cmd: string[],
): string[] {
  const hash = argsHash([name, role, ...settings(ANY_GID), image, ...cmd])
  return [
    'run',
    '-d',
    '--name',
    name,
    '--restart',
    'unless-stopped',
    '--label',
    `${ROLE_LABEL}=${role}`,
    '--label',
    `${SETUP_LABEL}=${runId}`,
    '--label',
    `${ARGS_LABEL}=${hash}`,
    '--label',
    `${GID_LABEL}=${gid}`,
    ...settings(String(gid)),
    image,
    ...cmd,
  ]
}

/** The ports the board's Caddy publishes, per case. */
function caddyPorts(c: OwnCaddy): string[] {
  if (c === '1') return ['80:80', '443:443']
  if (c === '1b') return ['443:443']
  if (c === '4a') return ['80:80', `${PORT_4}:${PORT_4}`]
  return [`127.0.0.1:${PORT_4B_CHECK}:80`, `${PORT_4}:${PORT_4}`]
}

/**
 * The board's Caddy (call 18): root in its container without its powers (it opens the socket only
 * through the folder's group), the socket's folder, not the socket, mounted read-only, its config
 * folder read-only, its certificates in volumes of its own. The argv after `docker`.
 */
export function caddyRunArgs(c: OwnCaddy, w: Wanted, gid: number | string, runId: string, acme?: Acme): string[] {
  const folder = socketFolder(w.socket)
  const settings = (g: string): string[] => [
    ...caddyPorts(c).flatMap(p => ['-p', p]),
    '--group-add',
    g,
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${CADDY_DIR}:/etc/caddy:ro`,
    '-v',
    `${folder}:${folder}:ro`,
    ...(acme ? ['-v', `${acme.root}:${acme.root}:ro`] : []),
    '-v',
    `${VOLUMES[0]}:/data`,
    '-v',
    `${VOLUMES[1]}:/config`,
  ]
  return labelled(CADDY_NAME, 'caddy', runId, gid, settings, CADDY_IMAGE, [])
}

/**
 * Case 3's helper (call 13): socat from a TCP port to the socket, as nobody with the folder's
 * group, read-only, no powers. On their Caddy's user-defined network by name, with no port on the
 * host (3a), or on the host network listening on the loopback only (3b). The argv after `docker`.
 */
export function socatRunArgs(
  on: { network: string } | { host: true },
  w: Wanted,
  gid: number | string,
  runId: string,
): string[] {
  const folder = socketFolder(w.socket)
  const network = 'network' in on ? ['--network', on.network, '--network-alias', SOCKET_NAME] : ['--network', 'host']
  const settings = (g: string): string[] => [
    ...network,
    '--user',
    `65534:${g}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${folder}:${folder}:ro`,
  ]
  const listen =
    'network' in on ? `TCP-LISTEN:${PORT_3A},fork,reuseaddr` : `TCP-LISTEN:${PORT_3B},bind=127.0.0.1,fork,reuseaddr`
  return labelled(SOCKET_NAME, 'socket', runId, gid, settings, SOCAT_IMAGE, [listen, `UNIX-CONNECT:${w.socket}`])
}

/** Docker's key, as Docker publishes its fingerprint. */
const DOCKER_KEY = '9DC8 5822 9FC7 DD38 854A  E2D8 8D81 803C 0EBF CD88'
/** apt waits up to 5 minutes for its lock (unattended-upgrades often holds it). */
const APT = 'apt-get -o DPkg::Lock::Timeout=300'
/** What Docker's install adds, for the record and Undo. */
export const DOCKER_PACKAGES = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-ce-rootless-extras']
export const DOCKER_FILES = ['/etc/apt/sources.list.d/docker.list', '/etc/apt/keyrings/docker.asc']

/**
 * Docker from its own apt repository by the steps Docker documents (call 19). Where they differ:
 * apt waits for its lock; `sudo env …` sets apt's frontend, so the line runs the same in the
 * board's script, where `sudo` is a function; the key's fingerprint is checked without gpg (often
 * missing): a v4 fingerprint is the SHA-1 of the key's first packet, which an armored key file
 * holds after its header and before its checksum line.
 */
export function dockerInstall(distro: 'debian' | 'ubuntu'): string[] {
  const repo = `https://download.docker.com/linux/${distro}`
  const fingerprint = DOCKER_KEY.replaceAll(' ', '').toLowerCase()
  return [
    `sudo ${APT} update`,
    `sudo env DEBIAN_FRONTEND=noninteractive ${APT} install -y ca-certificates curl`,
    'sudo install -m 0755 -d /etc/apt/keyrings',
    `sudo curl -fsSL ${repo}/gpg -o /etc/apt/keyrings/docker.asc`,
    `# the key must be Docker's: ${DOCKER_KEY} (its first packet's SHA-1, no gpg needed)`,
    "k=$(sudo sed -e '1,/^$/d' -e '/^=/,$d' /etc/apt/keyrings/docker.asc)",
    `set -- $(printf '%s\\n' "$k" | base64 -d | od -An -tu1 -N3)`,
    `[ "$1" = 153 ] && [ "$(printf '%s\\n' "$k" | base64 -d | head -c $((3 + $2 * 256 + $3)) | sha1sum | cut -c1-40)" = ${fingerprint} ] || { echo "This is not Docker's key: stop here."; false; }`,
    'sudo chmod a+r /etc/apt/keyrings/docker.asc',
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] ${repo} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null`,
    `sudo ${APT} update`,
    `sudo env DEBIAN_FRONTEND=noninteractive ${APT} install -y docker-ce docker-ce-cli containerd.io`,
  ]
}
