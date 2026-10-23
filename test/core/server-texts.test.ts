import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Wanted } from '../../src/core/server-plan.ts'
import {
  argsHash,
  boardCaddyfile,
  CADDY_IMAGE,
  caddyRunArgs,
  dockerInstall,
  FENCE_FILE,
  fenceBlock,
  fenceFile,
  IMPORT_LINE,
  markedBlock,
  nginxFile,
  SOCAT_IMAGE,
  siteFile,
  socatRunArgs,
} from '../../src/core/server-texts.ts'
import { sshdBlock } from '../../src/core/tunnel-snippets.ts'

const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
}
const ACME = { ca: 'https://pebble:14000/dir', root: '/etc/agent-board/pebble.pem' }

const CASE_1 = [
  'board.example.com {',
  '\treverse_proxy unix//var/lib/boardtunnel/board.sock',
  '\theader Strict-Transport-Security "max-age=31536000"',
  '}',
].join('\n')

const CASE_1B = [
  '{',
  '\tauto_https disable_redirects',
  '}',
  'board.example.com {',
  '\ttls {',
  '\t\tissuer acme {',
  '\t\t\tdisable_http_challenge',
  '\t\t}',
  '\t}',
  '\treverse_proxy unix//var/lib/boardtunnel/board.sock',
  '\theader Strict-Transport-Security "max-age=31536000"',
  '}',
].join('\n')

const CASE_4A = [
  '{',
  '\thttps_port 8443',
  '}',
  'board.example.com:8443 {',
  '\ttls {',
  '\t\tissuer acme {',
  '\t\t\tdisable_tlsalpn_challenge',
  '\t\t}',
  '\t}',
  '\treverse_proxy unix//var/lib/boardtunnel/board.sock',
  '\theader Strict-Transport-Security "max-age=31536000"',
  '}',
].join('\n')

/** An argv with its settings' hash label as `H`, for comparing with the spec's argv. */
const hashless = (args: string[]): string[] =>
  args.map(a => (a.startsWith('agent-board.args=') ? 'agent-board.args=H' : a))

describe('the board’s own Caddy’s config, per case', () => {
  test('case 1: the site to the socket, with HSTS (tabs, as the spec writes it)', () => {
    expect(boardCaddyfile('1', W)).toBe(CASE_1)
  })
  test('case 1b: the certificate check on 443 only, no redirects on 80', () => {
    expect(boardCaddyfile('1b', W)).toBe(CASE_1B)
  })
  test('case 4a: HTTPS on 8443, the check on 80', () => {
    expect(boardCaddyfile('4a', W)).toBe(CASE_4A)
  })
  test('case 4b: 4a’s, and the path nginx forwards answered on 80', () => {
    expect(boardCaddyfile('4b', W)).toBe(
      `${CASE_4A}\nhttp://board.example.com {\n\trespond /.well-known/acme-challenge/agent-board-check "agent-board"\n}`,
    )
  })
  test('a test CA: a global block with acme_ca and acme_ca_root first, merged into 1b’s and 4a’s own', () => {
    const acme = ['\tacme_ca https://pebble:14000/dir', '\tacme_ca_root /etc/agent-board/pebble.pem']
    expect(boardCaddyfile('1', W, ACME)).toBe(['{', ...acme, '}', CASE_1].join('\n'))
    expect(boardCaddyfile('1b', W, ACME)).toBe(['{', ...acme, CASE_1B.slice(2)].join('\n'))
    expect(boardCaddyfile('4a', W, ACME)).toBe(['{', ...acme, CASE_4A.slice(2)].join('\n'))
    expect(boardCaddyfile('4b', W, ACME).startsWith(['{', ...acme, '\thttps_port 8443', '}'].join('\n'))).toBe(true)
    for (const c of ['1', '1b', '4a', '4b'] as const) expect(boardCaddyfile(c, W)).not.toContain('acme_ca')
  })
  test('another socket and domain', () => {
    const text = boardCaddyfile('1', { ...W, socket: '/srv/t/x.sock', domain: 'a.example.org' })
    expect(text).toContain('a.example.org {\n\treverse_proxy unix//srv/t/x.sock\n')
  })
})

describe('the board’s parts in their Caddy and their nginx', () => {
  test('case 2: the site file, and the one import line that is its own marker', () => {
    expect(siteFile(W)).toBe(
      [
        '# agent-board: the board through its tunnel. Added by "Set up the server"; its Undo removes it.',
        'board.example.com {',
        '\treverse_proxy unix//var/lib/boardtunnel/board.sock',
        '\theader Strict-Transport-Security "max-age=31536000"',
        '}',
      ].join('\n'),
    )
    expect(IMPORT_LINE).toBe('import /etc/caddy/agent-board/board.caddy # agent-board')
  })
  test('case 3: the marked block to the helper, by name (3a) or on the loopback (3b)', () => {
    expect(markedBlock(W, 'agent-board-socket:8080')).toBe(
      [
        '# >>> agent-board: the board through its tunnel. Added by "Set up the server"; its Undo removes it.',
        'board.example.com {',
        '\treverse_proxy agent-board-socket:8080',
        '\theader Strict-Transport-Security "max-age=31536000"',
        '}',
        '# <<< agent-board',
      ].join('\n'),
    )
    expect(markedBlock(W, '127.0.0.1:8481')).toContain('\treverse_proxy 127.0.0.1:8481\n')
  })
  test('case 4b: nginx forwards only the certificate checks for the domain', () => {
    expect(nginxFile(W, ['80', '[::]:80'])).toBe(
      [
        "# agent-board: certificate checks for board.example.com go to the board's own Caddy. Its Undo removes this file.",
        'server {',
        '    listen 80;',
        '    listen [::]:80;',
        '    server_name board.example.com;',
        '    location /.well-known/acme-challenge/ {',
        '        proxy_pass http://127.0.0.1:8480;',
        '        proxy_set_header Host $host;',
        '    }',
        '    location / {',
        '        return 301 https://$host:8443$request_uri;',
        '    }',
        '}',
      ].join('\n'),
    )
  })
  test('their listen lines’ addresses only: no default_server, no options, no twice; none read gives 80', () => {
    const text = nginxFile(W, ['80 default_server', '[::]:80 ipv6only=on', '80', '10.0.0.5:80'])
    expect(text).toContain('    listen 80;\n    listen [::]:80;\n    listen 10.0.0.5:80;\n    server_name')
    expect(text).not.toContain('default_server')
    expect(nginxFile(W, [])).toContain('    listen 80;\n    server_name')
  })
})

describe('the board’s containers', () => {
  const caddyArgs = [
    'run',
    '-d',
    '--name',
    'agent-board-caddy',
    '--restart',
    'unless-stopped',
    '--label',
    'agent-board.role=caddy',
    '--label',
    'agent-board.setup=r1',
    '--label',
    'agent-board.args=H',
    '--label',
    'agent-board.gid=997',
    '-p',
    '80:80',
    '-p',
    '443:443',
    '--group-add',
    '997',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--security-opt',
    'no-new-privileges',
    '-v',
    '/etc/agent-board/caddy:/etc/caddy:ro',
    '-v',
    '/var/lib/boardtunnel:/var/lib/boardtunnel:ro',
    '-v',
    'agent-board-caddy-data:/data',
    '-v',
    'agent-board-caddy-config:/config',
    CADDY_IMAGE,
  ]
  const ports = (args: string[]): string[] => args.filter((_, i) => args[i - 1] === '-p')

  test('case 1: the spec’s docker run, root without its powers, the folder (not the socket) read-only', () => {
    expect(hashless(caddyRunArgs('1', W, 997, 'r1'))).toEqual(caddyArgs)
  })
  test('the ports per case: 1b on 443 alone, 4a on 80 and 8443, 4b’s check on the loopback only', () => {
    expect(ports(caddyRunArgs('1b', W, 997, 'r1'))).toEqual(['443:443'])
    expect(ports(caddyRunArgs('4a', W, 997, 'r1'))).toEqual(['80:80', '8443:8443'])
    expect(ports(caddyRunArgs('4b', W, 997, 'r1'))).toEqual(['127.0.0.1:8480:80', '8443:8443'])
  })
  test('a test CA’s root is mounted read-only where the Caddyfile names it', () => {
    const args = caddyRunArgs('1', W, 997, 'r1', ACME)
    expect(args).toContain('/etc/agent-board/pebble.pem:/etc/agent-board/pebble.pem:ro')
    expect(args.at(-1)).toBe(CADDY_IMAGE)
  })
  test('its settings’ hash: the same for another run, another for another case or test CA', () => {
    const label = (args: string[]): string | undefined => args.find(a => a.startsWith('agent-board.args='))
    const h = label(caddyRunArgs('1', W, 997, 'r1'))
    expect(h).toMatch(/^agent-board\.args=[0-9a-f]{16}$/)
    expect(label(caddyRunArgs('1', W, 997, 'r2'))).toBe(h)
    expect(label(caddyRunArgs('1b', W, 997, 'r1'))).not.toBe(h)
    expect(label(caddyRunArgs('1', W, 997, 'r1', ACME))).not.toBe(h)
    expect(argsHash(['a', 'b'])).not.toBe(argsHash(['ab']))
  })
  test('the folder’s gid in a label of its own, out of the hash: a run that makes the folder knows it only on the server', () => {
    const label = (args: string[], key: string): string | undefined =>
      args.find(a => a.startsWith(`${key}=`))?.slice(key.length + 1)
    for (const make of [
      (gid: number | string) => caddyRunArgs('1', W, gid, 'r1'),
      (gid: number | string) => socatRunArgs({ network: 'web_default' }, W, gid, 'r1'),
    ]) {
      const [a, b, run] = [make(997), make(998), make('$G')]
      expect(label(b, 'agent-board.args')).toBe(label(a, 'agent-board.args'))
      expect(label(run, 'agent-board.args')).toBe(label(a, 'agent-board.args'))
      expect([label(a, 'agent-board.gid'), label(b, 'agent-board.gid'), label(run, 'agent-board.gid')]).toEqual([
        '997',
        '998',
        '$G',
      ])
      expect(run.some(x => x === '$G' || x === '65534:$G')).toBe(true)
    }
  })
  test('the helper on their network, as nobody with the folder’s group, read-only (3a)', () => {
    expect(hashless(socatRunArgs({ network: 'web_default' }, W, 997, 'r1'))).toEqual([
      'run',
      '-d',
      '--name',
      'agent-board-socket',
      '--restart',
      'unless-stopped',
      '--label',
      'agent-board.role=socket',
      '--label',
      'agent-board.setup=r1',
      '--label',
      'agent-board.args=H',
      '--label',
      'agent-board.gid=997',
      '--network',
      'web_default',
      '--network-alias',
      'agent-board-socket',
      '--user',
      '65534:997',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-v',
      '/var/lib/boardtunnel:/var/lib/boardtunnel:ro',
      SOCAT_IMAGE,
      'TCP-LISTEN:8080,fork,reuseaddr',
      'UNIX-CONNECT:/var/lib/boardtunnel/board.sock',
    ])
  })
  test('the helper on the host network listens on the loopback only (3b)', () => {
    const args = socatRunArgs({ host: true }, W, 997, 'r1')
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'host'])
    expect(args).not.toContain('--network-alias')
    expect(args).toContain('TCP-LISTEN:8481,bind=127.0.0.1,fork,reuseaddr')
  })
  test('the images are pinned by tag and digest', () => {
    expect(CADDY_IMAGE).toMatch(/^caddy:2\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
    expect(SOCAT_IMAGE).toMatch(/^alpine\/socat:[\d.]+@sha256:[0-9a-f]{64}$/)
  })
})

describe('sshd’s fence for the tunnel user, as the board puts it in place', () => {
  test('in a file of its own: the Match block unchanged, after one comment line', () => {
    const text = fenceFile('boardtunnel')
    expect(FENCE_FILE).toBe('/etc/ssh/sshd_config.d/00-agent-board.conf')
    expect(text.split('\n')[0]).toMatch(/^# agent-board: /)
    expect(text.split('\n').slice(1).join('\n')).toBe(sshdBlock('boardtunnel'))
    // nothing else: a line outside the Match block would be a setting for every user
    expect(text.split('\n').filter(l => !l.startsWith('#') && !l.startsWith('    '))).toEqual([
      'Match User boardtunnel',
    ])
  })
  test('at the end of sshd_config, between markers, `Match all` after it: what is added later is for everyone again', () => {
    const lines = fenceBlock('boardtunnel').split('\n')
    expect(lines[0]).toMatch(/^# >>> agent-board: /)
    expect(lines.at(-1)).toBe('# <<< agent-board')
    expect(lines.at(-2)).toBe('Match all')
    expect(lines.slice(1, -2).join('\n')).toBe(sshdBlock('boardtunnel'))
  })
})

describe('installing Docker from Docker’s own repository', () => {
  const lines = (distro: 'debian' | 'ubuntu'): string[] => [
    'sudo apt-get -o DPkg::Lock::Timeout=300 update',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y ca-certificates curl',
    'sudo install -m 0755 -d /etc/apt/keyrings',
    `sudo curl -fsSL https://download.docker.com/linux/${distro}/gpg -o /etc/apt/keyrings/docker.asc`,
    "# the key must be Docker's: 9DC8 5822 9FC7 DD38 854A  E2D8 8D81 803C 0EBF CD88 (its first packet's SHA-1, no gpg needed)",
    "k=$(sudo sed -e '1,/^$/d' -e '/^=/,$d' /etc/apt/keyrings/docker.asc)",
    String.raw`set -- $(printf '%s\n' "$k" | base64 -d | od -An -tu1 -N3)`,
    String.raw`[ "$1" = 153 ] && [ "$(printf '%s\n' "$k" | base64 -d | head -c $((3 + $2 * 256 + $3)) | sha1sum | cut -c1-40)" = 9dc858229fc7dd38854ae2d88d81803c0ebfcd88 ] || { echo "This is not Docker's key: stop here."; false; }`,
    'sudo chmod a+r /etc/apt/keyrings/docker.asc',
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null`,
    'sudo apt-get -o DPkg::Lock::Timeout=300 update',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y docker-ce docker-ce-cli containerd.io',
  ]
  test('the documented steps, the distribution in the URLs, apt’s lock waited for, the key’s fingerprint checked', () => {
    expect(dockerInstall('debian')).toEqual(lines('debian'))
    expect(dockerInstall('ubuntu')).toEqual(lines('ubuntu'))
  })

  // The check where gpg is missing (neither trial server had it): a v4 key's fingerprint is the
  // SHA-1 of its first packet (99 02 0d: 3 + 525 bytes for Docker's), which the armored file holds
  // after its header lines and before its checksum line. Run here on an armored key of that shape,
  // with sh, od and this computer's coreutils.
  const SH = Bun.which('dash') ?? Bun.which('sh')
  test.skipIf(!SH)('the fingerprint line takes the first packet’s SHA-1 out of the armored file', () => {
    const packet = new Uint8Array(528 + 40)
    packet.set([0x99, 0x02, 0x0d])
    for (let i = 3; i < packet.length; i++) packet[i] = (i * 31 + 7) % 256
    const b64 = Buffer.from(packet).toString('base64')
    const body = b64.match(/.{1,64}/g) ?? []
    const dir = mkdtempSync(join(tmpdir(), 'docker-key-'))
    const file = join(dir, 'docker.asc').replaceAll('\\', '/')
    writeFileSync(
      file,
      [
        '-----BEGIN PGP PUBLIC KEY BLOCK-----',
        'Comment: a test key',
        '',
        ...body,
        '=AbCd',
        '-----END PGP PUBLIC KEY BLOCK-----',
        '',
      ].join('\n'),
    )
    const own = createHash('sha1').update(packet.subarray(0, 528)).digest('hex')
    const install = dockerInstall('debian')
    const from = install.findIndex(l => l.startsWith('k=$('))
    const line = install.slice(from, install.findIndex(l => l.includes('sha1sum')) + 1).join('\n')
    expect(line.split('\n')).toHaveLength(3)
    const run = (text: string) =>
      Bun.spawnSync([SH ?? 'sh', '-c', `sudo() { "$@"; }\n${text.replaceAll('/etc/apt/keyrings/docker.asc', file)}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    try {
      // not Docker's key: refused
      const refused = run(line)
      expect(refused.exitCode).toBe(1)
      expect(refused.stdout.toString()).toContain("This is not Docker's key")
      // the same line with this key's fingerprint: passes
      expect(run(line.replace('9dc858229fc7dd38854ae2d88d81803c0ebfcd88', own)).exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('the page can import it: no node: import', () => {
  expect(readFileSync('src/core/server-texts.ts', 'utf8')).not.toMatch(/from 'node:/)
})

describe('the README describes the server setup with the board’s own texts', () => {
  const readme = readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n')
  const lines = readme.split('\n')
  /** The text of every fenced block that opens at column 0, as a copy from the page would give it. */
  const fences = [...readme.matchAll(/^```[^\n]*\n([\s\S]*?)\n```$/gm)].map(m => m[1] ?? '')

  test('case 2’s import line and case 3’s marked block for the defaults, word for word', () => {
    expect(lines.map(l => l.trim())).toContain(IMPORT_LINE)
    expect(fences).toContain(markedBlock(W, 'agent-board-socket:8080'))
  })

  const en = translator('en')
  /** "On the server", each run of spaces one (a README line wraps where it likes, the panel's words do not). */
  const onServer = readme
    .slice(readme.indexOf('\n### On the server\n'), readme.indexOf('\n### On this computer\n'))
    .replace(/\s+/g, ' ')

  test('On the server: Set up the server, what it makes, how a run goes, the steps by hand, the one command, in order', () => {
    const at = (heading: string): number => lines.indexOf(heading)
    const parts = [
      `#### ${en('server.panel.setUpServer')}`,
      '#### What the board makes on the server',
      '#### How a run goes',
      `#### ${en('server.panel.byHandFold')}`,
      `#### ${en('server.panel.oneshot')}`,
    ].map(at)
    expect(parts.every(n => n > at('### On the server'))).toBe(true)
    expect(parts).toEqual([...parts].sort((a, b) => a - b))
    expect(parts.every(n => n < at('### On this computer'))).toBe(true)
  })

  test('the panel’s fields, folds and buttons in the panel’s own words; what it says, as it says it', () => {
    const named = [
      'server.panel.signin',
      'server.panel.domain',
      'server.panel.host',
      'server.panel.sshPort',
      'server.panel.login',
      'server.panel.password',
      'server.panel.keyFold',
      'server.panel.setUpServer',
      'server.panel.details',
      'server.panel.dockerOk',
      'server.panel.apply',
      'server.panel.undo',
      'server.panel.undoSure',
      'server.panel.byHandFold',
      'server.panel.pickCase',
      'server.panel.pick.none',
      'server.panel.pick.service',
      'server.panel.pick.docker',
      'server.panel.pick.other',
      'server.panel.manualEnd',
      'server.panel.oneshot',
      'access.copy',
      'server.panel.oneshotUndo',
      'server.panel.oneshotInside',
      'access.test',
    ]
    // in bold, as a step's lead too ("**Apply.**")
    const bold = (words: string): boolean => onServer.includes(`**${words}**`) || onServer.includes(`**${words}.**`)
    expect(named.filter(key => !bold(en(key)))).toEqual([])
    const said = [
      en('server.plain.docker'),
      en('server.panel.undoAsks', { admin: 'root' }),
      en('server.panel.needDomain'),
      en('server.panel.setUp', { when: 'Oct 23, 10:04 AM', case: en('server.panel.caseName.3a') }),
    ]
    expect(said.filter(words => !onServer.includes(`"${words}"`))).toEqual([])
  })

  test('the plan in plain words, line for line as the panel draws it', () => {
    const from = lines.findIndex(l => l.trim() === en('server.panel.plainFound'))
    const sites = en('server.plain.sites', { sites: 'a.example.com, b.example.com' })
    const who = en('server.plain.who.docker', { name: 'Caddy' })
    expect(lines.slice(from, from + 6).map(l => l.trim())).toEqual([
      en('server.panel.plainFound'),
      en('server.plain.found', { system: 'Debian 13', web: en('server.plain.web.both', { who, sites }) }),
      en('server.panel.plainWill'),
      en('server.plain.will.login', { user: W.user }),
      en('server.plain.will.case.3a', { domain: W.domain }),
      en('server.plain.untouched.sitesChecked'),
    ])
  })
})
