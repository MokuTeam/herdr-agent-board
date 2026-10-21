import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { translator } from '../../src/core/i18n/translator.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { SetupCheck } from '../../src/core/setup.ts'
import {
  backoffMs,
  boardPorts,
  fieldProblem,
  forwardAccepted,
  isLasting,
  sshArgs,
  sshHint,
  sshPathArg,
  TUNNEL_SOCKET,
  type TunnelFacts,
  type TunnelProblem,
  tunnelChecks,
  tunnelConfig,
  tunnelPort,
  tunnelProblems,
} from '../../src/core/tunnel.ts'

const PORTS = { web: 12422, remote: null, pwa: 12423 }
const GOOD = tunnelConfig({ on: true, host: 'ssh.example.com', user: 'boardtunnel', domain: 'board.example.com' })

describe('the tunnel’s settings', () => {
  test('read from config.json with their defaults, never checked there', () => {
    expect(tunnelConfig(undefined)).toEqual({
      on: false,
      host: '',
      sshPort: 22,
      user: '',
      key: '',
      socket: TUNNEL_SOCKET,
      domain: '',
      port: null,
    })
    expect(
      tunnelConfig({
        on: true,
        host: ' ssh.example.com ',
        sshPort: 2222,
        user: 'boardtunnel',
        key: 'C:\\keys\\k',
        socket: '/srv/b/b.sock',
        domain: 'board.example.com',
        port: 12500,
        extra: 1,
      }),
    ).toEqual({
      on: true,
      host: 'ssh.example.com',
      sshPort: 2222,
      user: 'boardtunnel',
      key: 'C:\\keys\\k',
      socket: '/srv/b/b.sock',
      domain: 'board.example.com',
      port: 12500,
    })
    expect(tunnelConfig({ on: 'yes', sshPort: '22', port: 0, host: 3 })).toEqual(tunnelConfig(undefined))
    expect([tunnelPort(GOOD, 12422), tunnelPort({ ...GOOD, port: 12500 }, 12422)]).toEqual([12424, 12500])
  })
  test('what would turn into an ssh option, or split the forward, is refused', () => {
    useLanguage('en')
    for (const v of ['ssh.example.com', '203.0.113.5', '2001:db8::1']) expect(fieldProblem('host', v)).toBeNull()
    for (const v of ['-oProxyCommand=calc', 'a b', 'me@ssh.example.com', 'ssh.example.com\n'])
      expect(fieldProblem('host', v)).toBe(
        'The server is a host name or an address, without spaces, @ or a leading dash',
      )
    for (const v of ['boardtunnel', 'board_tunnel', 'b.t-1']) expect(fieldProblem('user', v)).toBeNull()
    for (const v of ['-l', 'a b', 'root@x', 'x:y'])
      expect(fieldProblem('user', v)).toBe('The user is a plain user name, without a leading dash')
    for (const v of [1, 22, 65535]) expect(fieldProblem('sshPort', v)).toBeNull()
    for (const v of [0, 65536, 1.5, '22', -1])
      expect(fieldProblem('sshPort', v)).toBe('SSH port is a whole number from 1 to 65535')
    for (const v of ['', 'C:\\Users\\Иван Петров\\keys\\id', '/home/me/.ssh/board'])
      expect(fieldProblem('key', v)).toBeNull()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ssh would expand ${USER} in the path, which is the point
    for (const v of ['-oX', 'C:\\a"b', '/home/${USER}/k'])
      expect(fieldProblem('key', v)).toBe('The key\'s path cannot start with a dash or hold " or ${')
  })
  test('the socket: absolute, plain characters, in a folder of its own, at most 100 bytes', () => {
    useLanguage('en')
    const exactly100 = `/srv/${'b'.repeat(88)}/x.sock`
    expect(exactly100.length).toBe(100)
    for (const v of [TUNNEL_SOCKET, '/srv/board/b.sock', exactly100]) expect(fieldProblem('socket', v)).toBeNull()
    for (const v of [
      'var/lib/x.sock',
      '/var/lib/a:b.sock',
      '/var/lib/a b.sock',
      '/var/lib/../x.sock',
      '/var/lib/./x.sock',
      '/var//x.sock',
      '/var/lib/x.sock/',
    ])
      expect([v, fieldProblem('socket', v)]).toEqual([
        v,
        'The socket is an absolute path of letters, digits and . _ - / only, with no empty, . or .. part',
      ])
    expect(fieldProblem('socket', `/srv/${'b'.repeat(89)}/x.sock`)).toBe("The socket's path is longer than 100 bytes")
    for (const [v, folder] of [
      ['/tmp/board.sock', '/tmp'],
      ['/run/board.sock', '/run'],
      ['/board.sock', '/'],
      ['/var/tmp/x.sock', '/var/tmp'],
      ['/dev/shm/x.sock', '/dev/shm'],
      ['/var/run/x.sock', '/var/run'],
    ])
      expect(fieldProblem('socket', v)).toBe(
        `The socket needs a folder of its own, not ${folder}, where anyone could take its name first`,
      )
  })
  test('the domain is a lowercase host name; the listener’s port is none of the board’s others', () => {
    useLanguage('en')
    expect(fieldProblem('domain', 'board.example.com')).toBeNull()
    for (const v of [
      'Board.example.com',
      'https://board.example.com',
      'board.example.com:443',
      'board.example.com/x',
      'localhost',
      'board..example.com',
    ])
      expect(fieldProblem('domain', v)).toBe(
        'The domain is a lowercase host name such as board.example.com, without https://, a path or a port',
      )
    expect(fieldProblem('port', null, PORTS)).toBeNull()
    expect(fieldProblem('port', 12500, PORTS)).toBeNull()
    for (const p of [12422, 12423])
      expect(fieldProblem('port', p, PORTS)).toBe(
        `Port ${p} is the board's already (the web board, phones, or the phone's browser)`,
      )
    expect(fieldProblem('port', 13000, { ...PORTS, remote: 13000 })).not.toBeNull()
    expect(boardPorts(undefined, 12422)).toEqual(PORTS)
    expect(boardPorts({ on: true, port: 13000, pwa: { on: true, port: 13001 } }, 12422)).toEqual({
      web: 12422,
      remote: 13000,
      pwa: 13001,
    })
  })
  test('missing fields are named, a good config has none, and the messages follow the language', () => {
    useLanguage('en')
    expect(tunnelProblems(tunnelConfig({}), PORTS)).toEqual([
      { field: 'host', message: 'Server: needed' },
      { field: 'user', message: 'User: needed' },
      { field: 'domain', message: 'Domain: needed' },
    ])
    expect(tunnelProblems(GOOD, PORTS)).toEqual([])
    expect(tunnelProblems({ ...GOOD, host: '-x', port: 12422 }, PORTS).map(p => p.field)).toEqual(['host', 'port'])
    useLanguage('ru')
    expect(tunnelProblems(tunnelConfig({}), PORTS)[0]?.message).not.toBe('Server: needed')
    useLanguage('en')
  })
  test('the default listener port (web + 2) is checked against the board’s other ports too', () => {
    const taken: TunnelProblem[] = [
      { field: 'port', message: "Port 12424 is the board's already (the web board, phones, or the phone's browser)" },
    ]
    expect(tunnelProblems(GOOD, { ...PORTS, pwa: 12424 })).toEqual(taken)
    expect(tunnelProblems(GOOD, { ...PORTS, remote: 12424 })).toEqual(taken)
    expect(tunnelProblems({ ...GOOD, port: 12500 }, { ...PORTS, pwa: 12424 })).toEqual([])
  })
})

describe('the ssh line', () => {
  test('POSIX: the whole line, the forward always to 127.0.0.1', () => {
    const dir = '/home/me/.local/state/herdr/plugins/agent-board/tunnel'
    expect(
      sshArgs({
        conf: GOOD,
        key: `${dir}/id_ed25519`,
        knownHosts: `${dir}/known_hosts`,
        target: 12424,
        platform: 'linux',
      }),
    ).toEqual([
      '-F',
      'none',
      '-N',
      '-T',
      '-v',
      '-i',
      `${dir}/id_ed25519`,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'TCPKeepAlive=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile="${dir}/known_hosts"`,
      '-p',
      '22',
      '-R',
      '/var/lib/boardtunnel/board.sock:127.0.0.1:12424',
      'boardtunnel@ssh.example.com',
    ])
  })
  test('Windows: forward slashes, one value each for a path with spaces or Cyrillic, % doubled', () => {
    const args = sshArgs({
      conf: { ...GOOD, sshPort: 2222 },
      key: 'C:\\Users\\Иван Петров\\AppData\\Local\\herdr\\plugins\\agent-board\\tunnel\\id_ed25519',
      knownHosts: 'C:\\Users\\a b%c\\known_hosts',
      target: 12424,
      platform: 'win32',
    })
    expect(args[args.indexOf('-i') + 1]).toBe(
      'C:/Users/Иван Петров/AppData/Local/herdr/plugins/agent-board/tunnel/id_ed25519',
    )
    expect(args).toContain('UserKnownHostsFile="C:/Users/a b%%c/known_hosts"')
    expect(args.slice(-5)).toEqual([
      '-p',
      '2222',
      '-R',
      '/var/lib/boardtunnel/board.sock:127.0.0.1:12424',
      'boardtunnel@ssh.example.com',
    ])
    expect(sshPathArg('C:\\x%y\\k', 'win32')).toBe('C:/x%%y/k')
    expect(sshPathArg('/a\\b%c', 'linux')).toBe('/a\\b%%c')
  })
  test('what ssh says: the hint, whether it heals, whether the forward was taken', () => {
    expect(sshHint(['boardtunnel@ssh.example.com: Permission denied (publickey).'])).toBe('publickey')
    expect(sshHint(['Error: remote port forwarding failed for listen path /var/lib/boardtunnel/board.sock'])).toBe(
      'listenPath',
    )
    expect(sshHint(["Permissions for 'C:/k' are too open.", 'UNPROTECTED PRIVATE KEY FILE!'])).toBe('keyPermissions')
    expect(
      sshHint(['Bad permissions. Try removing permissions for user: BUILTIN\\Users (S-1-5-32-545) on file C:/k.']),
    ).toBe('keyPermissions')
    // ssh skips a key refused for its rights, then says the server refused it too: the key's rights are the cause
    expect(
      sshHint([
        "Permissions for 'C:/k' are too open.",
        'UNPROTECTED PRIVATE KEY FILE!',
        'Load key "C:/k": bad permissions',
        'boardtunnel@ssh.example.com: Permission denied (publickey).',
      ]),
    ).toBe('keyPermissions')
    expect(sshHint(['Host key verification failed.'])).toBe('hostKey')
    expect(sshHint(['Load key "C:/k": incorrect passphrase supplied to decrypt private key'])).toBe('passphrase')
    // likewise a key that needs a passphrase
    expect(
      sshHint([
        'Load key "C:/k": incorrect passphrase supplied to decrypt private key',
        'boardtunnel@ssh.example.com: Permission denied (publickey).',
      ]),
    ).toBe('passphrase')
    expect(sshHint(['ssh: connect to host ssh.example.com port 22: Connection timed out'])).toBe('network')
    expect(sshHint(['ssh: Could not resolve hostname nowhere: Name or service not known'])).toBe('network')
    expect(sshHint(['something else'])).toBeNull()
    // what Windows' ssh says on a good connect, without debug1:, is no failure
    expect(
      sshHint([
        'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2',
        "Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.",
        'Authenticated to 127.0.0.1 ([127.0.0.1]:2222) using "publickey".',
      ]),
    ).toBeNull()
    for (const h of ['publickey', 'listenPath', 'keyPermissions', 'hostKey', 'noSsh', 'passphrase'] as const)
      expect(isLasting(h)).toBe(true)
    expect([isLasting('network'), isLasting(null)]).toEqual([false, false])
    const ok = 'debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:12424'
    expect(forwardAccepted(ok, TUNNEL_SOCKET)).toBe(true)
    expect(forwardAccepted(ok, '/srv/other.sock')).toBe(false)
    expect(
      forwardAccepted('debug1: remote forward failure for: listen /var/lib/boardtunnel/board.sock:-2', TUNNEL_SOCKET),
    ).toBe(false)
    // the line Windows' ssh 9.5 printed against sshd in the trial, word for word
    const real =
      'debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:56072'
    expect(forwardAccepted(real, TUNNEL_SOCKET)).toBe(true)
    // the socket is matched whole: a path that only starts the same is another socket
    expect(forwardAccepted(real, '/var/lib/boardtunnel/board.so')).toBe(false)
    expect(forwardAccepted(real, '/var/lib/boardtunnel')).toBe(false)
    expect(forwardAccepted('debug1: remote forward success for: listen /srv/b.sock', '/srv/b.sock')).toBe(true)
    expect(forwardAccepted('debug1: remote forward success for: listen /srv/b.sock x', '/srv/b.sock')).toBe(true)
  })
  test('backoff: 1 s doubling to 60 s, ±20 %', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(n => backoffMs(n, () => 0.5))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ])
    expect([backoffMs(1, () => 0), backoffMs(1, () => 1), backoffMs(7, () => 1)]).toEqual([800, 1200, 60000])
  })
  test('the page can import it: no node: import', () => {
    expect(readFileSync('src/core/tunnel.ts', 'utf8')).not.toMatch(/from 'node:/)
  })
})

describe('board doctor’s checks of the tunnel', () => {
  const en = translator('en')
  const ru = translator('ru')
  const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  const FINE: TunnelFacts = {
    ssh: SSH,
    key: { ok: true },
    problems: [],
    ready: true,
    status: { state: 'connected', since: 1, probe: { ok: true, at: 2, detail: '' } },
  }
  const levels = (checks: SetupCheck[]): string[] => checks.map(c => `${c.id}:${c.level}`)
  const byId = (checks: SetupCheck[], id: string): SetupCheck => {
    const found = checks.find(c => c.id === id)
    if (!found) throw new Error(`no check ${id}`)
    return found
  }

  test('all fine, connected, the probe through the domain reached the board: six ok', () => {
    const checks = tunnelChecks(FINE, en)
    expect(levels(checks)).toEqual([
      'tunnel-ssh:ok',
      'tunnel-key:ok',
      'tunnel-fields:ok',
      'tunnel-login:ok',
      'tunnel-state:ok',
      'tunnel-probe:ok',
    ])
    expect(byId(checks, 'tunnel-ssh').detail).toBe(SSH)
  })
  test('no ssh: an error with how to get one', () => {
    const c = byId(tunnelChecks({ ...FINE, ssh: null }, en), 'tunnel-ssh')
    expect(c.level).toBe('error')
    expect(c.fix).toBe(en('tunnel.hint.noSsh'))
  })
  test('a key ssh refuses for its rights: ssh’s words and the hint', () => {
    const error = "Permissions for 'C:/k' are too open.\nUNPROTECTED PRIVATE KEY FILE!"
    const c = byId(tunnelChecks({ ...FINE, key: { ok: false, error, hint: 'keyPermissions' } }, en), 'tunnel-key')
    expect(c.level).toBe('error')
    expect(c.detail).toBe(error)
    expect(c.fix).toBe(en('tunnel.hint.keyPermissions'))
  })
  test('settings that do not check out: each problem’s message', () => {
    const problems: TunnelProblem[] = [
      { field: 'host', message: en('tunnel.err.host') },
      { field: 'socket', message: en('tunnel.err.socketShared', { folder: '/tmp' }) },
    ]
    const c = byId(tunnelChecks({ ...FINE, problems }, en), 'tunnel-fields')
    expect(c.level).toBe('error')
    expect(c.detail.split('\n')).toEqual(problems.map(p => p.message))
  })
  test('the login not set up: where to set it up', () => {
    const c = byId(tunnelChecks({ ...FINE, ready: false }, en), 'tunnel-login')
    expect(c.level).toBe('error')
    expect(c.fix).toBe('Set up the password and the code: Settings → Remote access…')
  })
  test('reconnecting: a warning with ssh’s last words; no probe without one', () => {
    const error = 'ssh: connect to host ssh.example.com port 22: Connection timed out'
    const checks = tunnelChecks(
      { ...FINE, status: { state: 'reconnecting', since: 1, attempt: 3, nextAt: 9, error, hint: 'network' } },
      en,
    )
    expect(levels(checks).slice(4)).toEqual(['tunnel-state:warn'])
    expect(byId(checks, 'tunnel-state').detail).toBe(error)
    expect(byId(checks, 'tunnel-state').fix).toBe(en('tunnel.hint.network'))
    expect(byId(tunnelChecks({ ...FINE, status: { state: 'connecting', since: 1 } }, en), 'tunnel-state').level).toBe(
      'warn',
    )
  })
  test('an error that does not heal by itself: an error with its hint', () => {
    const error = 'boardtunnel@ssh.example.com: Permission denied (publickey).'
    const c = byId(
      tunnelChecks({ ...FINE, status: { state: 'error', since: 1, error, hint: 'publickey', nextAt: 9 } }, en),
      'tunnel-state',
    )
    expect(c.level).toBe('error')
    expect(c.detail).toBe(error)
    expect(c.fix).toBe(en('tunnel.hint.publickey'))
  })
  test('no board answering: a warning, and nothing to say of the probe', () => {
    const checks = tunnelChecks({ ...FINE, status: null }, en)
    expect(levels(checks).slice(4)).toEqual(['tunnel-state:warn'])
    expect(byId(checks, 'tunnel-state').title).toBe(en('tunnel.check.noBoard'))
  })
  test('a probe through the domain that failed: a warning with what came back', () => {
    const checks = tunnelChecks(
      { ...FINE, status: { state: 'connected', since: 1, probe: { ok: false, at: 2, detail: 'HTTP 502' } } },
      en,
    )
    expect(levels(checks).slice(4)).toEqual(['tunnel-state:ok', 'tunnel-probe:warn'])
    expect(byId(checks, 'tunnel-probe').detail).toContain('502')
  })
  test('the titles follow the language', () => {
    const facts: TunnelFacts = { ...FINE, ssh: null, key: { ok: false, error: 'x', hint: null }, ready: false }
    const a = tunnelChecks(facts, en)
    const b = tunnelChecks(facts, ru)
    expect(b.map(c => c.id)).toEqual(a.map(c => c.id))
    for (const [i, c] of a.entries()) expect(b[i]?.title).not.toBe(c.title)
  })
})
