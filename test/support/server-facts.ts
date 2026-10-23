// What Look would find on a test server, per case, on Debian 13 (sudo, GNU coreutils) and Ubuntu
// 26.04 (sudo-rs, Rust coreutils): the facts the plan's tests build from. The shapes are
// core/server-facts.ts's; the values those of Task 20's scenarios (a Caddy unit with two sites,
// compose Caddy on `web_default` from `/srv/my web`, nginx with conf.d, …).
import type { Container, Holder, ServerFacts, StepOneFacts } from '../../src/core/server-facts.ts'
import type { SetupCase, SetupRecord } from '../../src/core/server-plan.ts'

export type TestDistro = 'debian13' | 'ubuntu2604'

const DISTROS: Record<
  TestDistro,
  Pick<ServerFacts, 'distro'> & { sudo: 'sudo' | 'sudo-rs'; coreutils: 'gnu' | 'rust' }
> = {
  debian13: {
    distro: { id: 'debian', version: '13', codename: 'trixie', arch: 'x86_64', supported: true },
    sudo: 'sudo',
    coreutils: 'gnu',
  },
  ubuntu2604: {
    distro: { id: 'ubuntu', version: '26.04', codename: 'resolute', arch: 'x86_64', supported: true },
    sudo: 'sudo-rs',
    coreutils: 'rust',
  },
}

export const FREE: Holder = { kind: 'free' }
/** Their Caddy's container, as compose names it. */
export const THEIR_ID = `7f3c${'0a'.repeat(30)}`
/** A sha256 Look read of their config. */
export const THEIR_SHA = 'e3'.repeat(32)
export const GID = 997

/** Their Caddy in compose on `web_default`, the Caddyfile's folder mounted from `/srv/my web`. */
export function composeCaddy(over: Partial<Container> = {}): Container {
  return {
    id: THEIR_ID,
    name: '/web-caddy-1',
    image: 'caddy:2',
    cmd: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    hostNetwork: false,
    networks: [{ name: 'web_default', driver: 'bridge', userDefined: true }],
    mounts: [
      { type: 'bind', source: '/srv/my web', destination: '/etc/caddy' },
      { type: 'volume', source: 'web_caddy_data', destination: '/data' },
    ],
    ports: [
      { private: 80, public: 80, ip: '0.0.0.0' },
      { private: 443, public: 443, ip: '0.0.0.0' },
    ],
    labels: { 'com.docker.compose.project': 'web', 'com.docker.compose.project.working_dir': '/srv/my web' },
    ...over,
  }
}

function base(distro: TestDistro): ServerFacts {
  const d = DISTROS[distro]
  return {
    distro: { ...d.distro },
    ports: { 80: FREE, 443: FREE, 8443: FREE, 8480: FREE, 8481: FREE },
    docker: { version: '29.0.1', podman: false, rootless: false, userns: false, containers: [] },
    systemd: true,
    units: { caddy: null, nginx: null },
    fence: {},
    folder: { mode: '2750', owner: 'boardtunnel', group: 'boardtunnel', gid: GID, members: [] },
    socket: null,
    record: null,
    lockHeld: false,
    host: {
      selinux: null,
      forwarding: false,
      forwarders: [],
      fetch: 'curl',
      missing: [],
      sudo: d.sudo,
      coreutils: d.coreutils,
      conflicts: [],
    },
    dns: { domain: ['203.0.113.7'], local: ['203.0.113.7', '127.0.0.1'] },
    caddy: null,
    nginx: null,
  }
}

const caddyUnit: Holder = { kind: 'unit', unit: 'caddy.service', program: 'caddy' }
const nginxUnit: Holder = { kind: 'unit', unit: 'nginx.service', program: 'nginx' }

/** The facts Look would find for a case (`bare`: Docker and nothing on the ports; `nodocker`: no Docker either). */
export function factsFor(c: SetupCase | 'bare' | 'nodocker', distro: TestDistro = 'debian13'): ServerFacts {
  const f = base(distro)
  switch (c) {
    case 'bare':
    case '1':
      return f
    case 'nodocker':
      return { ...f, docker: null }
    case '1b':
      return { ...f, ports: { ...f.ports, 80: { kind: 'unit', unit: 'dummy80.service', program: 'python3' } } }
    case '2':
      return {
        ...f,
        ports: { ...f.ports, 80: caddyUnit, 443: caddyUnit },
        units: {
          caddy: {
            execStart: ['/usr/bin/caddy', 'run', '--environ', '--config', '/etc/caddy/Caddyfile'],
            execReload: ['/usr/bin/caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--force'],
            user: 'caddy',
            group: 'caddy',
            active: 'active',
            workingDirectory: '',
          },
          nginx: null,
        },
        caddy: {
          where: 'unit',
          container: null,
          config: '/etc/caddy/Caddyfile',
          hostPath: '/etc/caddy/Caddyfile',
          mount: null,
          adapter: 'caddyfile',
          resume: false,
          version: 'v2.6.2',
          hosts: ['blog.example.org', 'shop.example.org'],
          adminOff: false,
          autoHttpsOff: false,
          sha256: THEIR_SHA,
          endsWithNewline: true,
          address: '127.0.0.1',
        },
      }
    case '3a':
    case '3b': {
      const host = c === '3b'
      const container = composeCaddy(
        host
          ? {
              hostNetwork: true,
              networks: [{ name: 'host', driver: 'host', userDefined: false }],
              mounts: [{ type: 'bind', source: '/srv/caddy/Caddyfile', destination: '/etc/caddy/Caddyfile' }],
              ports: [],
            }
          : {},
      )
      const holder: Holder = { kind: 'container', id: THEIR_ID, program: host ? 'caddy' : 'docker-proxy' }
      return {
        ...f,
        ports: { ...f.ports, 80: holder, 443: holder },
        docker: { version: '29.0.1', podman: false, rootless: false, userns: false, containers: [container] },
        caddy: {
          where: 'container',
          container: THEIR_ID,
          config: '/etc/caddy/Caddyfile',
          hostPath: host ? '/srv/caddy/Caddyfile' : '/srv/my web/Caddyfile',
          mount: host ? 'file' : 'folder',
          adapter: 'caddyfile',
          resume: false,
          version: 'v2.10.2',
          hosts: ['shop.example.org'],
          adminOff: false,
          autoHttpsOff: false,
          sha256: THEIR_SHA,
          endsWithNewline: true,
          address: '127.0.0.1',
        },
      }
    }
    case '4a':
    case '4b':
      return {
        ...f,
        ports: { ...f.ports, 443: nginxUnit, 80: c === '4b' ? nginxUnit : FREE },
        units: {
          caddy: null,
          nginx: {
            execStart: ['/usr/sbin/nginx', '-g', 'daemon on; master_process on;'],
            execReload: ['/usr/sbin/nginx', '-g', 'daemon on; master_process on;', '-s', 'reload'],
            user: '',
            group: '',
            active: 'active',
            workingDirectory: '',
          },
        },
        nginx:
          c === '4b'
            ? { confD: true, listen80: ['80', '[::]:80'], serverNames: ['shop.example.org'] }
            : { confD: true, listen80: [], serverNames: ['shop.example.org'] },
      }
  }
}

/** A record of a setup applied earlier on the server, for the default pair and domain. */
export function recordFor(c: SetupCase, over: Partial<SetupRecord> = {}): SetupRecord {
  const four = c === '4a' || c === '4b'
  return {
    v: 1,
    id: 'r0',
    at: '2026-10-21T10:04:00.000Z',
    state: 'applied',
    case: c,
    pair: { user: 'boardtunnel', socket: '/var/lib/boardtunnel/board.sock' },
    domain: 'board.example.com',
    publicPort: four ? 8443 : null,
    address: four ? 'https://board.example.com:8443' : 'https://board.example.com',
    items: [],
    ...over,
  }
}

/** The board's public key, as ssh-keygen -y gives it. */
export const BOARD_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQ2Ym9hcmRrZXlleGFtcGxlZXhhbXBsZWV4YW1wbGU board@pc'

/**
 * A server with none of step 1 (the simple-setup spec): no tunnel user, socket folder, keys file
 * or fence; sshd includes sshd_config.d. `over` says what Look found otherwise.
 */
export function stepOneMissing(
  c: Parameters<typeof factsFor>[0],
  distro: TestDistro = 'debian13',
  over: Partial<StepOneFacts> = {},
): ServerFacts {
  return {
    ...factsFor(c, distro),
    fence: {},
    folder: null,
    socket: null,
    stepOne: { user: null, keys: 'none', keysDir: false, include: true, ...over },
  }
}
