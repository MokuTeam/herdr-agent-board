import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { RoundOne, ServerFacts } from '../../src/core/server-facts.ts'
import { fenceDiff, lookScript1, lookScript2, readRoundOne, readServerFacts } from '../../src/core/server-look.ts'
import { shQuote } from '../../src/core/server-shell.ts'
import { keysLine } from '../../src/core/tunnel-snippets.ts'

const INPUT = { user: 'boardtunnel', socket: '/var/lib/boardtunnel/board.sock', domain: 'board.example.com' }
const WRITES =
  /\btee\b|\bmkdir\b|\binstall\b|\brm\b|\bmv\b|\bcp\b|docker (run|pull|start|stop|rm)|caddy validate|systemctl (reload|restart|start|stop)|>\s*\/(?!dev\/null)/

const ID = `${'c0ffee'.repeat(10)}beef`
const free = { kind: 'free' } as const
/** A round one with only what the second round looks at; the rest as on a bare server. */
function roundOne(over: Partial<RoundOne>): RoundOne {
  return {
    distro: { id: 'debian', version: '13', codename: 'trixie', arch: 'x86_64', supported: true },
    ports: { 80: free, 443: free, 8443: free, 8480: free, 8481: free },
    docker: null,
    systemd: true,
    units: { caddy: null, nginx: null },
    fence: {},
    folder: null,
    socket: null,
    record: null,
    lockHeld: false,
    host: {
      selinux: null,
      forwarding: false,
      forwarders: [],
      fetch: 'curl',
      missing: [],
      sudo: 'sudo',
      coreutils: 'gnu',
      conflicts: [],
    },
    dns: { domain: [], local: [] },
    ...over,
  }
}
const theirCaddy = (id: string, source: string): Partial<RoundOne> => ({
  ports: {
    80: { kind: 'container', id, program: 'caddy' },
    443: { kind: 'container', id, program: 'caddy' },
    8443: free,
    8480: free,
    8481: free,
  },
  docker: {
    version: '29.0.0',
    podman: false,
    rootless: false,
    userns: false,
    containers: [
      {
        id,
        name: 'web-caddy-1',
        image: 'caddy:2',
        cmd: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
        hostNetwork: false,
        networks: [{ name: 'web_default', driver: 'bridge', userDefined: true }],
        mounts: [{ type: 'bind', source, destination: '/etc/caddy/Caddyfile' }],
        ports: [{ private: 443, public: 443, ip: '0.0.0.0' }],
        labels: {},
      },
    ],
  },
})
const caddyUnit: Partial<RoundOne> = {
  ports: {
    80: { kind: 'unit', unit: 'caddy.service', program: 'caddy' },
    443: { kind: 'unit', unit: 'caddy.service', program: 'caddy' },
    8443: free,
    8480: free,
    8481: free,
  },
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
}
const nginxBoth: Partial<RoundOne> = {
  ports: {
    80: { kind: 'unit', unit: 'nginx.service', program: 'nginx' },
    443: { kind: 'unit', unit: 'nginx.service', program: 'nginx' },
    8443: free,
    8480: free,
    8481: free,
  },
  units: {
    caddy: null,
    nginx: {
      execStart: ['/usr/sbin/nginx', '-g', 'daemon', 'on;', 'master_process', 'on;'],
      execReload: ['/usr/sbin/nginx', '-g', 'daemon', 'on;', 'master_process', 'on;', '-s', 'reload'],
      user: '',
      group: '',
      active: 'active',
      workingDirectory: '',
    },
  },
}

describe('Look’s scripts write nothing', () => {
  const scripts = [
    ['look-1', lookScript1(INPUT)],
    ['look-2', lookScript2(roundOne(caddyUnit), INPUT)],
    ['look-2', lookScript2(roundOne(theirCaddy(ID, '/srv/my web/Caddyfile')), INPUT)],
    ['look-2', lookScript2(roundOne(nginxBoth), INPUT)],
  ] as const
  for (const [kind, script] of scripts) {
    test(`${kind}: no write, stdin closed first, its marker second`, () => {
      expect(script).not.toBeNull()
      const text = script ?? ''
      expect(text).not.toMatch(WRITES)
      const lines = text.split('\n')
      expect(lines[0]).toBe('exec </dev/null')
      expect(lines[1]).toBe(`# agent-board: ${kind}`)
    })
  }
  test('round one: every section once, @@end last', () => {
    const text = lookScript1(INPUT)
    for (const name of ['os', 'ports', 'docker', 'systemd', 'fence', 'folder', 'record', 'host', 'dns']) {
      expect(text.split(`echo '@@section ${name}'`).length).toBe(2)
    }
    expect(text.trimEnd().endsWith("echo '@@end'")).toBe(true)
  })
  test('round one: the owner’s values as one shell word each', () => {
    const text = lookScript1({ user: 'tun', socket: "/srv/it's Ж/b.sock", domain: "b$`%'.example.com" })
    expect(text).toContain("'user=tun,host=localhost,addr=127.0.0.1'")
    expect(text).toContain("stat -c '@@dir %a %U %G %g' '/srv/it'\\''s Ж' ")
    expect(text).toContain("stat -c '@@socket %a %U %G %F' '/srv/it'\\''s Ж/b.sock' ")
    expect(text).toContain("getent ahosts 'b$`%'\\''.example.com' ")
  })
  test('round one names the tools a run needs that are missing, gzip among them (a packed run)', () => {
    expect(lookScript1(INPUT)).toMatch(/for c in [a-z0-9 ]*gzip[a-z0-9 ]*; do/)
  })
  test('a value with a newline never becomes a script', () => {
    expect(() => lookScript1({ ...INPUT, domain: 'a\nb' })).toThrow()
  })
})

describe('Look’s second round', () => {
  test('nothing needs it on a bare server', () => {
    expect(lookScript2(roundOne({}), INPUT)).toBeNull()
  })
  test('their Caddy in a container whose id is not 64 hex characters: no second round', () => {
    expect(lookScript2(roundOne(theirCaddy('abc', '/srv/my web/Caddyfile')), INPUT)).toBeNull()
  })
  test('a config path with a quote reaches the script as one word', () => {
    const script = lookScript2(roundOne(theirCaddy(ID, "/srv/it's/Caddyfile")), INPUT) ?? ''
    expect(script).toContain("'/srv/it'\\''s/Caddyfile'")
    expect(script).toContain(`docker exec -e STEPPATH=/ ${ID} 'caddy' version`)
  })
  test('a Caddy unit: its own binary, its config', () => {
    const script = lookScript2(roundOne(caddyUnit), INPUT) ?? ''
    // Caddy 2.6 makes $HOME/.step on any run unless STEPPATH names a folder that exists
    expect(script).toContain("STEPPATH=/ timeout 30 '/usr/bin/caddy' version")
    expect(script).toContain("--config '/etc/caddy/Caddyfile' --adapter 'caddyfile'")
    expect(script).toContain("echo '@@section caddy'")
    expect(script).not.toContain("echo '@@section nginx'")
  })
  test('nginx on 80: its include, listen and server_name lines only', () => {
    const script = lookScript2(roundOne(nginxBoth), INPUT) ?? ''
    expect(script).toContain("'/usr/sbin/nginx' -T")
    expect(script).toContain("echo '@@section nginx'")
    expect(script).not.toContain("echo '@@section caddy'")
  })
})

test('no node: import in Look’s module and the shared files', () => {
  for (const file of ['src/core/server-look.ts', 'src/core/server-shell.ts', 'src/core/server-facts.ts']) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/from 'node:/)
  }
})

// --- The parsers, on what the trial servers printed (test/fixtures/server-look, recorded by the spike) ---

const fixture = (path: string): string =>
  readFileSync(new URL(`../fixtures/server-look/${path}`, import.meta.url), 'utf8')
const SERVERS = {
  debian13: {
    distro: { id: 'debian', version: '13', codename: 'trixie', supported: true },
    sudo: 'sudo',
    coreutils: 'gnu',
  },
  ubuntu2604: {
    distro: { id: 'ubuntu', version: '26.04', codename: 'resolute', supported: true },
    sudo: 'sudo-rs',
    coreutils: 'rust',
  },
} as const
type Server = keyof typeof SERVERS

function one(server: Server, scenario: string): RoundOne {
  const r = readRoundOne(fixture(`${server}/${scenario}/round1.txt`))
  if (!r) throw new Error(`${server}/${scenario}: round one unreadable`)
  return r
}
function facts(server: Server, scenario: string): ServerFacts {
  const r = one(server, scenario)
  const two = lookScript2(r, INPUT) ? fixture(`${server}/${scenario}/round2.txt`) : ''
  const f = readServerFacts(r, two)
  if (!f) throw new Error(`${server}/${scenario}: round two unreadable`)
  return f
}
const HEX64 = /^[0-9a-f]{64}$/
const SCENARIOS = [
  'bare',
  'nodocker',
  'dummy80',
  'caddy-unit',
  'compose-folder',
  'compose-file',
  'caddy-host',
  'caddy-bridge',
  'nginx-443',
  'nginx-80-443',
  'apache',
]

for (const server of Object.keys(SERVERS) as Server[]) {
  const want = SERVERS[server]
  describe(`Look on ${server}`, () => {
    test('bare: the distribution, every port free, Docker, sudo and coreutils, step 1 as the panel has it', () => {
      const r = one(server, 'bare')
      expect(r.distro).toMatchObject(want.distro)
      expect(r.distro.arch).toBe('x86_64')
      for (const port of [80, 443, 8443, 8480, 8481] as const) expect(r.ports[port]).toEqual({ kind: 'free' })
      expect(r.docker).not.toBeNull()
      expect(r.docker?.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(r.docker).toMatchObject({ podman: false, rootless: false, userns: false })
      expect(r.systemd).toBe(true)
      expect(r.host.sudo).toBe(want.sudo)
      expect(r.host.coreutils).toBe(want.coreutils)
      expect(r.host.missing).toEqual([])
      expect(r.host.conflicts).toEqual([])
      expect(r.host.fetch).toBe('curl')
      expect(r.host.selinux).toBeNull()
      expect(fenceDiff(r.fence, 'boardtunnel')).toEqual([])
      expect(r.folder).toMatchObject({ mode: '2750', owner: 'boardtunnel', group: 'boardtunnel', members: [] })
      expect(Number.isInteger(r.folder?.gid)).toBe(true)
      expect(r.socket).toEqual({ mode: '660', owner: 'boardtunnel', group: 'boardtunnel' })
      expect(r.record).toBeNull()
      expect(r.lockHeld).toBe(false)
      expect(r.units).toEqual({ caddy: null, nginx: null })
      expect(r.dns.domain).toEqual(['203.0.113.10'])
      expect(r.dns.local).toContain('127.0.0.1')
      expect(lookScript2(r, INPUT)).toBeNull()
      expect(readServerFacts(r, '')).toEqual({ ...r, caddy: null, nginx: null })
    })
    test('nodocker: no Docker, nothing on the ports', () => {
      const r = one(server, 'nodocker')
      expect(r.docker).toBeNull()
      expect(r.ports[443]).toEqual({ kind: 'free' })
      expect(r.host.conflicts).toEqual([])
    })
    test('dummy80: python3 holds 80, 443 is free', () => {
      const r = one(server, 'dummy80')
      expect(r.ports[80]).toMatchObject({ program: 'python3' })
      expect(['unit', 'process']).toContain(r.ports[80].kind)
      expect(r.ports[443]).toEqual({ kind: 'free' })
      expect(lookScript2(r, INPUT)).toBeNull()
    })
    test('caddy-unit: Caddy as a service, its config from systemd, its two sites', () => {
      const r = one(server, 'caddy-unit')
      expect(r.ports[443]).toEqual({ kind: 'unit', unit: 'caddy.service', program: 'caddy' })
      expect(r.ports[80]).toEqual({ kind: 'unit', unit: 'caddy.service', program: 'caddy' })
      expect(r.units.caddy?.execStart).toContain('--config')
      expect(r.units.caddy?.execStart).toContain('/etc/caddy/Caddyfile')
      expect(r.units.caddy).toMatchObject({ user: 'caddy', group: 'caddy', active: 'active' })
      const f = facts(server, 'caddy-unit')
      expect(f.caddy).toMatchObject({
        where: 'unit',
        container: null,
        config: '/etc/caddy/Caddyfile',
        hostPath: '/etc/caddy/Caddyfile',
        mount: null,
        adapter: 'caddyfile',
        resume: false,
        hosts: ['a.example.com', 'b.example.com'],
        adminOff: false,
        autoHttpsOff: false,
        endsWithNewline: true,
        address: '127.0.0.1',
      })
      expect(f.caddy?.version).toMatch(/^2\.\d+\.\d+/)
      expect(f.caddy?.sha256).toMatch(HEX64)
      expect(f.nginx).toBeNull()
    })
    for (const [scenario, mount] of [
      ['compose-file', 'file'],
      ['compose-folder', 'folder'],
    ] as const) {
      test(`${scenario}: their Caddy in compose on web_default, the Caddyfile on a ${mount} mount`, () => {
        const r = one(server, scenario)
        const h = r.ports[443]
        expect(h).toMatchObject({ kind: 'container', program: 'caddy' })
        const id = h.kind === 'container' ? h.id : ''
        expect(id).toMatch(HEX64)
        expect(r.ports[80]).toEqual(h)
        const c = r.docker?.containers.find(x => x.id === id)
        expect(c?.name).toBe('web-caddy-1')
        expect(c?.hostNetwork).toBe(false)
        expect(c?.networks).toEqual([{ name: 'web_default', driver: 'bridge', userDefined: true }])
        expect(c?.labels['com.docker.compose.project']).toBe('web')
        expect(c?.labels['com.docker.compose.project.working_dir']).toBe('/srv/my web')
        expect(c?.ports).toContainEqual({ private: 443, public: 443, ip: '0.0.0.0' })
        const f = facts(server, scenario)
        expect(f.caddy).toMatchObject({
          where: 'container',
          container: id,
          config: '/etc/caddy/Caddyfile',
          hostPath: '/srv/my web/Caddyfile',
          mount,
          adapter: 'caddyfile',
          hosts: ['a.example.com', 'b.example.com'],
          adminOff: false,
          autoHttpsOff: false,
          endsWithNewline: true,
          address: '127.0.0.1',
        })
        expect(f.caddy?.sha256).toMatch(HEX64)
      })
    }
    test('compose-file: their compose files and every other label stay on the server', () => {
      const c = one(server, 'compose-file').docker?.containers[0]
      for (const key of Object.keys(c?.labels ?? {})) expect(key).toMatch(/^(com\.docker\.compose\.|agent-board\.)/)
    })
    test('caddy-host: their Caddy on the host network, found through its cgroup', () => {
      const r = one(server, 'caddy-host')
      const h = r.ports[443]
      expect(h).toMatchObject({ kind: 'container', program: 'caddy' })
      const c = r.docker?.containers.find(x => h.kind === 'container' && x.id === h.id)
      expect(c?.hostNetwork).toBe(true)
      expect(c?.ports).toEqual([])
      expect(facts(server, 'caddy-host').caddy).toMatchObject({
        where: 'container',
        mount: 'file',
        address: '127.0.0.1',
      })
    })
    test('caddy-bridge: their Caddy on Docker’s default bridge only', () => {
      const r = one(server, 'caddy-bridge')
      const h = r.ports[443]
      expect(h).toMatchObject({ kind: 'container', program: 'caddy' })
      const c = r.docker?.containers.find(x => h.kind === 'container' && x.id === h.id)
      expect(c?.networks).toEqual([{ name: 'bridge', driver: 'bridge', userDefined: false }])
      expect(facts(server, 'caddy-bridge').caddy).toMatchObject({ mount: 'file', hostPath: '/srv/bridge/Caddyfile' })
    })
    test('nginx-443: nginx holds 443, 80 is free', () => {
      const r = one(server, 'nginx-443')
      expect(r.ports[443]).toEqual({ kind: 'unit', unit: 'nginx.service', program: 'nginx' })
      expect(r.ports[80]).toEqual({ kind: 'free' })
      expect(facts(server, 'nginx-443').nginx).toMatchObject({ confD: true, listen80: [] })
    })
    test('nginx-80-443: nginx holds both, includes conf.d, listens on 80 as its own lines say', () => {
      const r = one(server, 'nginx-80-443')
      expect(r.ports[443]).toEqual({ kind: 'unit', unit: 'nginx.service', program: 'nginx' })
      expect(r.ports[80]).toEqual({ kind: 'unit', unit: 'nginx.service', program: 'nginx' })
      expect(r.units.nginx?.active).toBe('active')
      const f = facts(server, 'nginx-80-443')
      expect(f.nginx).toMatchObject({ confD: true, listen80: ['80', '[::]:80'] })
      expect(f.nginx?.serverNames).toContain('site.example.com')
      expect(f.caddy).toBeNull()
    })
    test('apache: Apache holds 80 and 443', () => {
      const r = one(server, 'apache')
      expect(r.ports[443]).toEqual({ kind: 'unit', unit: 'apache2.service', program: 'apache2' })
      expect(r.ports[80]).toEqual({ kind: 'unit', unit: 'apache2.service', program: 'apache2' })
      expect(lookScript2(r, INPUT)).toBeNull()
    })
    test('every second round writes nothing either', () => {
      for (const scenario of SCENARIOS) {
        const script = lookScript2(one(server, scenario), INPUT)
        if (!script) continue
        expect(script).not.toMatch(WRITES)
        expect(script.split('\n').slice(0, 2)).toEqual(['exec </dev/null', '# agent-board: look-2'])
        for (const line of script.split('\n').filter(l => /caddy' (version|adapt)/.test(l))) {
          expect(line).toContain('STEPPATH=/')
        }
      }
    })
    test('a second round cut short is unreadable', () => {
      const r = one(server, 'compose-file')
      const two = fixture(`${server}/compose-file/round2.txt`)
      expect(readServerFacts(r, two.slice(0, two.indexOf('@@end')))).toBeNull()
      expect(readServerFacts(r, '')).toBeNull()
    })
  })
}

describe('Look on outputs written by hand', () => {
  test('Podman behind the docker command (podman-docker), and its package a conflict', () => {
    const r = readRoundOne(fixture('hand/podman.txt'))
    expect(r?.docker?.podman).toBe(true)
    expect(r?.host.conflicts).toEqual(['podman-docker'])
  })
  test('rootless Docker: only a user’s daemon, or a daemon that says so', () => {
    expect(readRoundOne(fixture('hand/rootless.txt'))?.docker).toMatchObject({ version: '', rootless: true })
    const said = fixture('debian13/bare/round1.txt').replace('"name=cgroupns"', '"name=rootless","name=cgroupns"')
    expect(readRoundOne(said)?.docker?.rootless).toBe(true)
  })
  test('Docker with user namespaces', () => {
    expect(readRoundOne(fixture('hand/userns.txt'))?.docker?.userns).toBe(true)
  })
  test('Docker’s userland proxy off: dockerd holds the port, the binding names the container', () => {
    const r = readRoundOne(fixture('hand/userland-proxy-off.txt'))
    expect(r?.ports[443]).toMatchObject({ kind: 'container', program: 'caddy' })
  })
  test('the cgroupfs driver: /docker/<id>', () => {
    const r = readRoundOne(fixture('hand/cgroupfs.txt'))
    expect(r?.ports[443]).toMatchObject({ kind: 'container', program: 'caddy' })
  })
  test('IPv4 and IPv6 held by two programs: split', () => {
    expect(readRoundOne(fixture('hand/split.txt'))?.ports[443]).toEqual({ kind: 'split', programs: ['nginx', 'caddy'] })
  })
  test('a record and its lock', () => {
    const r = readRoundOne(fixture('hand/record.txt'))
    expect(r?.record).toMatchObject({ v: 1, state: 'running', pair: { user: 'boardtunnel' } })
    expect(r?.lockHeld).toBe(true)
  })
  test('cut in half, a section twice, or nothing at all: Look could not read the server', () => {
    expect(readRoundOne(fixture('hand/cut.txt'))).toBeNull()
    expect(readRoundOne(fixture('hand/doubled.txt'))).toBeNull()
    expect(readRoundOne('')).toBeNull()
    expect(readRoundOne('garbage\n@@end\n')).toBeNull()
  })
  test('a distribution outside the list is read, and not supported', () => {
    const text = fixture('debian13/bare/round1.txt').replace('VERSION_ID="13"', 'VERSION_ID="11"')
    expect(readRoundOne(text)?.distro).toMatchObject({ id: 'debian', version: '11', supported: false })
  })
})

describe('the second round from a round one edited by hand', () => {
  const r = one('debian13', 'compose-file')
  const h = r.ports[443]
  const id = h.kind === 'container' ? h.id : ''
  const edit = (newId: string, source: string): RoundOne => ({
    ...r,
    ports: {
      ...r.ports,
      80: { kind: 'container', id: newId, program: 'caddy' },
      443: { kind: 'container', id: newId, program: 'caddy' },
    },
    docker: r.docker && {
      ...r.docker,
      containers: r.docker.containers.map(c =>
        c.id === id
          ? {
              ...c,
              id: newId,
              mounts: c.mounts.map(m => (m.destination === '/etc/caddy/Caddyfile' ? { ...m, source } : m)),
            }
          : c,
      ),
    },
  })
  test('a container id that is not 64 hex characters: no second round', () => {
    expect(lookScript2(edit('abc', '/srv/my web/Caddyfile'), INPUT)).toBeNull()
  })
  test('a host path with a quote: one shell word', () => {
    expect(lookScript2(edit(id, "/srv/it's/Caddyfile"), INPUT)).toContain("'/srv/it'\\''s/Caddyfile'")
  })
})

describe('the fence', () => {
  test('a key missing or set otherwise is named', () => {
    const fence = one('debian13', 'bare').fence
    const { permitlisten: _, ...without } = fence
    expect(fenceDiff({ ...without, allowtcpforwarding: 'yes' }, 'boardtunnel')).toEqual([
      'allowtcpforwarding',
      'permitlisten',
    ])
    expect(fenceDiff(fence, 'other')).toEqual(['authorizedkeysfile'])
  })
})

describe('step 1 as Look reads it: what the board makes itself (the simple-setup spec)', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQ2Ym9hcmRrZXlleGFtcGxlZXhhbXBsZWV4YW1wbGU board@pc'
  test('round one reads the tunnel user, its keys file against the board’s key line, sshd’s Include', () => {
    const text = lookScript1({ ...INPUT, publicKey: KEY })
    expect(text).not.toMatch(WRITES)
    expect(text).toContain("getent passwd 'boardtunnel'")
    expect(text).toContain(`= ${shQuote(keysLine(KEY))} ]`)
    expect(text).toContain("'/etc/ssh/authorized_keys/boardtunnel'")
    expect(text).toContain('/etc/ssh/sshd_config.d/*.conf')
    // all of it in the fence section, which older parsers read past
    const fence = text.slice(text.indexOf("echo '@@section fence'"), text.indexOf("echo '@@section folder'"))
    for (const marker of [
      '@@user',
      '@@user-shell',
      '@@user-ours',
      '@@user-admin',
      '@@user-group',
      '@@keys',
      '@@keys-dir',
      '@@include',
    ])
      expect([marker, fence.includes(marker)]).toEqual([marker, true])
    // no key to compare with: the file is only said to be there
    const without = lookScript1(INPUT)
    expect(without).not.toContain('restrict,port-forwarding')
    expect(without).toContain("echo '@@keys other'")
  })
  test('the tunnel user’s lines, run by a real sh: its uid and group, its shell, the board’s or not, the admin’s or not; none, a group of its name left', () => {
    const sh = Bun.which('sh')
    if (!sh) return
    const text = lookScript1(INPUT)
    const from = text.indexOf('if p=$(getent passwd')
    const part = text.slice(from, text.indexOf('\nfi\n', from) + '\nfi'.length)
    // getent and id stand in for the server's: the passwd line given, a group by gid (by name only
    // when one is left)
    const run = (passwd: string | null, o: { me?: string; sudo?: string; left?: boolean } = {}): string[] => {
      const group = `case "$2" in [0-9]*) echo "tunnelgroup:x:$2:" ;; *) ${o.left ? 'echo "$2:x:990:"' : 'return 2'} ;; esac`
      const stubs = [
        `getent() { case "$1" in passwd) ${passwd === null ? 'return 2' : `printf '%s\\n' ${shQuote(passwd)}`} ;; group) ${group} ;; esac; }`,
        `id() { echo ${shQuote(o.me ?? 'root')}; }`,
      ]
      const r = Bun.spawnSync([sh, '-c', `${stubs.join('\n')}\n${part}`], {
        env: { PATH: process.env.PATH ?? '', ...(o.sudo !== undefined && { SUDO_USER: o.sudo }) },
      })
      return r.stdout.toString().split('\n').filter(Boolean)
    }
    expect(run(null)).toEqual(['@@user none'])
    expect(run(null, { left: true })).toEqual(['@@user none', '@@user-group'])
    expect(run('boardtunnel:x:995:995:agent-board tunnel:/nonexistent:/usr/sbin/nologin')).toEqual([
      '@@user 995 tunnelgroup',
      '@@user-shell /usr/sbin/nologin',
      '@@user-ours',
    ])
    expect(run('boardtunnel:x:1000:1000:Migo,,,:/home/boardtunnel:/bin/bash', { me: 'admin' })).toEqual([
      '@@user 1000 tunnelgroup',
      '@@user-shell /bin/bash',
    ])
    // passwd's empty shell (/bin/sh), and the login sudo runs Look for
    expect(run('boardtunnel:x:1000:1000::/home/boardtunnel:', { sudo: 'boardtunnel' })).toEqual([
      '@@user 1000 tunnelgroup',
      '@@user-shell ',
      '@@user-admin',
    ])
    expect(run('boardtunnel:x:996:996::/home/boardtunnel:/bin/sh', { me: 'boardtunnel' })).toEqual([
      '@@user 996 tunnelgroup',
      '@@user-shell /bin/sh',
      '@@user-admin',
    ])
  })
  test('read from the fence section; a Look that did not read them has none (step 1 taken as done by hand)', () => {
    const base = fixture('debian13/bare/round1.txt')
    const add = (lines: string[]): string => base.replace('@@section folder', `${lines.join('\n')}\n@@section folder`)
    expect(readRoundOne(base)?.stepOne).toBeUndefined()
    expect(
      readRoundOne(
        add(['@@user 995 boardtunnel', '@@user-shell /usr/sbin/nologin', '@@keys same', '@@keys-dir', '@@include']),
      )?.stepOne,
    ).toEqual({
      user: { uid: 995, group: 'boardtunnel', shell: '/usr/sbin/nologin', ours: false, admin: false },
      keys: 'same',
      keysDir: true,
      include: true,
    })
    expect(
      readRoundOne(add(['@@user 1000 migo', '@@user-shell /bin/bash', '@@user-ours', '@@user-admin']))?.stepOne?.user,
    ).toEqual({ uid: 1000, group: 'migo', shell: '/bin/bash', ours: true, admin: true })
    expect(readRoundOne(add(['@@user none', '@@keys none']))?.stepOne).toEqual({
      user: null,
      keys: 'none',
      keysDir: false,
      include: false,
    })
    // no user, a group of its name left
    expect(readRoundOne(add(['@@user none', '@@user-group', '@@keys none']))?.stepOne).toEqual({
      user: null,
      groupLeft: true,
      keys: 'none',
      keysDir: false,
      include: false,
    })
    // a user whose group has no name, its shell passwd's empty one, and a keys line Look did not
    // give: there, not the board's
    expect(readRoundOne(add(['@@user 1001 ', '@@user-shell ']))?.stepOne).toEqual({
      user: { uid: 1001, group: '', shell: '', ours: false, admin: false },
      keys: 'other',
      keysDir: false,
      include: false,
    })
    // the fence's own keys are read as before
    expect(fenceDiff(readRoundOne(add(['@@user none']))?.fence ?? {}, 'boardtunnel')).toEqual([])
  })
  test('the Include check: before any Match line, the board’s folder or its relative name (run by a real awk)', () => {
    const awk = Bun.which('awk')
    if (!awk) return
    const program = lookScript1(INPUT).match(/awk '(tolower[^']*)'/)?.[1]
    expect(program).toBeDefined()
    const run = (config: string): number =>
      Bun.spawnSync([awk, program ?? '', '-'], { stdin: new TextEncoder().encode(config) }).exitCode
    expect(run('# a comment\nInclude /etc/ssh/sshd_config.d/*.conf\nPort 22\n')).toBe(0)
    expect(run('include sshd_config.d/*.conf\n')).toBe(0)
    expect(run('  Include /etc/ssh/sshd_config.d/*.conf\n')).toBe(0)
    expect(run('#Include /etc/ssh/sshd_config.d/*.conf\n')).toBe(1)
    expect(run('Port 22\n')).toBe(1)
    expect(run('Match User x\n  Include /etc/ssh/sshd_config.d/*.conf\n')).toBe(1)
    expect(run('Include /etc/ssh/other.d/*.conf\n')).toBe(1)
  })
})
