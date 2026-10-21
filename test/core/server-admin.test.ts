// The admin connection (core/server-admin.ts): its settings and their checks, the ssh line, the
// remote command that carries a script in base64 behind the sudo the admin needs, the probe that
// finds which, and the hints for what ssh, sudo and sudo-rs say, as the spike recorded them on
// Debian 13 (sudo 1.9.16p2) and Ubuntu 26.04 (sudo-rs 0.2.13).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  adminConfig,
  adminHint,
  adminProblems,
  adminSshArgs,
  connectionLost,
  PROBE_SCRIPT,
  pinnedIn,
  readProbe,
  remoteCommand,
} from '../../src/core/server-admin.ts'
import type { AdminHint } from '../../src/core/server-view.ts'
import { tunnelConfig } from '../../src/core/tunnel.ts'

const conf = tunnelConfig({ host: 'ssh.example.com', sshPort: 2222, user: 'boardtunnel', domain: 'board.example.com' })

const decode = (command: string): string => {
  const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command)?.[1]
  if (!b64) throw new Error(`no base64 in ${command}`)
  return Buffer.from(b64, 'base64').toString('utf8')
}

describe('the admin line', () => {
  const rest = (knownHosts: string): string[] => [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile="${knownHosts}"`,
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ClearAllForwardings=yes',
    '-p',
    '2222',
    'ubuntu@ssh.example.com',
    'CMD',
  ]

  test('POSIX: no user config, no prompt, the pinned key strictly, the tunnel’s host and port, the command last', () => {
    const args = adminSshArgs({
      conf,
      admin: { user: 'ubuntu', key: '/home/me/.ssh/admin key' },
      knownHosts: '/home/me/.local/state/tunnel/known_hosts',
      command: 'CMD',
      platform: 'linux',
    })
    expect(args).toEqual([
      '-F',
      'none',
      '-T',
      '-i',
      '/home/me/.ssh/admin key',
      '-o',
      'IdentitiesOnly=yes',
      ...rest('/home/me/.local/state/tunnel/known_hosts'),
    ])
  })

  test('Windows: a key under a name with a space, Cyrillic and % is one -i value, forward slashes, % doubled', () => {
    const args = adminSshArgs({
      conf,
      admin: { user: 'ubuntu', key: 'C:\\Users\\Иван Петров\\keys\\a b%c' },
      knownHosts: 'C:\\Users\\a b%c\\AppData\\Local\\herdr\\tunnel\\known_hosts',
      command: 'CMD',
      platform: 'win32',
    })
    expect(args.slice(0, 7)).toEqual([
      '-F',
      'none',
      '-T',
      '-i',
      'C:/Users/Иван Петров/keys/a b%%c',
      '-o',
      'IdentitiesOnly=yes',
    ])
    expect(args.slice(7)).toEqual(rest('C:/Users/a b%%c/AppData/Local/herdr/tunnel/known_hosts'))
  })

  test('no key: what ssh does by default (the agent, ~/.ssh), so no -i and no IdentitiesOnly', () => {
    const args = adminSshArgs({ conf, admin: { user: 'ubuntu', key: '' }, knownHosts: '/k', command: 'CMD' })
    expect(args).toEqual(['-F', 'none', '-T', ...rest('/k')])
    expect(args).not.toContain('-i')
    expect(args).not.toContain('IdentitiesOnly=yes')
  })
})

describe('the remote command: fixed text and the script in base64, behind the sudo the admin needs', () => {
  const script = 'exec </dev/null\n# agent-board: look-1\necho "it\'s $ ` % Ж \\"q\\""\n'
  const root = remoteCommand(script, 'root')

  test('root: sh alone', () => {
    expect(root).toMatch(/^sh -c 'eval "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d\)"'$/)
    expect(decode(root)).toBe(script)
  })
  // sudo speaks the admin's login locale (pam_env's /etc/default/locale): LC_ALL=C makes its lines
  // the English ones the hints know; `env` is a program, so any login shell runs it alike
  test('NOPASSWD: sudo -n, nothing on stdin, its lines in English', () => {
    expect(remoteCommand(script, 'nopasswd')).toBe(`env LC_ALL=C sudo -n -- ${root}`)
  })
  test("a password: sudo -S -p '' reads it on stdin, prints no prompt, its lines in English", () => {
    expect(remoteCommand(script, 'password')).toBe(`env LC_ALL=C sudo -S -p '' -- ${root}`)
  })
  test('requiretty and no sudo: no way to run the script', () => {
    expect(() => remoteCommand(script, 'requiretty')).toThrow()
    expect(() => remoteCommand(script, 'none')).toThrow()
  })
  test('standard base64 of the UTF-8 text in one word, a long script too', () => {
    const long = `# agent-board: run\n${'printf "%s\\n" "Ж…"\n'.repeat(3000)}`
    const command = remoteCommand(long, 'root')
    expect(command).not.toContain('\n')
    expect(decode(command)).toBe(long)
    expect(command.split(' ').length).toBe(remoteCommand('x', 'root').split(' ').length)
  })
})

describe('the probe: as the admin, without sudo, which sudo the admin has', () => {
  test('the script: stdin closed, its marker, the uid, sudo -n and sudo --version', () => {
    const lines = PROBE_SCRIPT.split('\n')
    expect(lines.slice(0, 2)).toEqual(['exec </dev/null', '# agent-board: probe'])
    expect(PROBE_SCRIPT).toContain('id -u')
    expect(PROBE_SCRIPT).toContain('sudo -n true')
    expect(PROBE_SCRIPT).toContain('sudo --version')
    // run with sh alone: sudo is only what it asks about
    expect(remoteCommand(PROBE_SCRIPT, 'root').startsWith('sh -c ')).toBe(true)
  })

  const SUDO = '@@flavor Sudo version 1.9.16p2'
  const RS = '@@flavor sudo-rs 0.2.13-0ubuntu1.2'
  const cases: [string, string[], ReturnType<typeof readProbe>][] = [
    ['root', ['@@uid 0', '@@sudo ok', SUDO], { mode: 'root', flavor: 'sudo' }],
    ['NOPASSWD, sudo', ['@@uid 1000', '@@sudo ok', SUDO], { mode: 'nopasswd', flavor: 'sudo' }],
    ['NOPASSWD, sudo-rs', ['@@uid 1000', '@@sudo ok', RS], { mode: 'nopasswd', flavor: 'sudo-rs' }],
    [
      'a password, sudo',
      ['@@uid 1000', '@@sudo sudo: a password is required', SUDO],
      { mode: 'password', flavor: 'sudo' },
    ],
    [
      'a password, sudo-rs',
      ['@@uid 1000', '@@sudo sudo: interactive authentication is required', RS],
      { mode: 'password', flavor: 'sudo-rs' },
    ],
    [
      'requiretty, sudo',
      ['@@uid 1000', '@@sudo sudo: sorry, you must have a tty to run sudo', SUDO],
      { mode: 'requiretty', flavor: 'sudo' },
    ],
    [
      'requiretty, sudo-rs: ignored, warned of, then a password asked',
      [
        '@@uid 1000',
        "@@sudo /etc/sudoers.d/admin:1:10: unknown setting: 'requiretty'",
        '@@sudo Defaults requiretty',
        '@@sudo          ^~~~~~~~~~',
        '@@sudo sudo: interactive authentication is required',
        RS,
      ],
      { mode: 'password', flavor: 'sudo-rs' },
    ],
    [
      'not in sudoers, sudo-rs',
      ['@@uid 1001', "@@sudo sudo: I'm sorry nosudo. I'm afraid I can't do that", RS],
      { mode: 'none', flavor: 'sudo-rs' },
    ],
    // classic sudo says so only once it has the password
    [
      'not in sudoers, sudo',
      ['@@uid 1001', '@@sudo sudo: a password is required', SUDO],
      { mode: 'password', flavor: 'sudo' },
    ],
    ['no sudo', ['@@uid 1000', '@@sudo none', '@@flavor '], { mode: 'none', flavor: null }],
  ]
  for (const [name, lines, want] of cases) test(name, () => expect(readProbe(lines)).toEqual(want))

  test('garbled or cut: unreadable', () => {
    expect(readProbe([])).toBeNull()
    expect(readProbe(['@@uid x', '@@sudo ok'])).toBeNull()
    expect(readProbe(['@@uid 1000'])).toBeNull()
  })
})

describe('the hint for what ssh, sudo and sudo-rs said (first match)', () => {
  const rows: [AdminHint, string[]][] = [
    ['publickey', ['admin@ssh.example.com: Permission denied (publickey).']],
    ['tooMany', ['Received disconnect from 203.0.113.5 port 22:2: Too many authentication failures']],
    ['hostKey', ['Host key verification failed.']],
    [
      'hostKey',
      [
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
        '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
        'Host key verification failed.',
      ],
    ],
    // sudo -n, then nothing on stdin: Debian 13's sudo, Ubuntu 26.04's sudo-rs
    ['needPassword', ['sudo: a password is required']],
    ['needPassword', ['', 'sudo: no password was provided', 'sudo: a password is required']],
    ['needPassword', ['sudo: interactive authentication is required']],
    ['needPassword', ['', 'sudo: Authentication required but not attempted']],
    [
      'wrongPassword',
      ['Sorry, try again.', '', 'sudo: no password was provided', 'sudo: 1 incorrect password attempt'],
    ],
    [
      'wrongPassword',
      ['', 'sudo: Authentication failed, try again.', '', 'sudo: Authentication required but not attempted'],
    ],
    ['requiretty', ['sudo: sorry, you must have a tty to run sudo']],
    ['notSudoer', ['nosudo is not in the sudoers file.']],
    ['notSudoer', ["sudo: I'm sorry nosudo. I'm afraid I can't do that"]],
    ['notSudoer', ['sh: 1: sudo: not found']],
    ['aptLock', ['E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 812 (unattended-upgr)']],
    ['aptLock', ['Waiting for cache lock: Could not get lock /var/lib/dpkg/lock-frontend.']],
    ['pullLimit', ['Error response from daemon: toomanyrequests: You have reached your pull rate limit.']],
    ['changed', ['@@changed holder443']],
    ['busy', ['@@busy']],
    ['network', ['ssh: connect to host ssh.example.com port 22: Connection timed out']],
    ['network', ['ssh: Could not resolve hostname ssh.example.com: Name or service not known']],
  ]
  for (const [hint, lines] of rows)
    test(`${hint}: ${lines.filter(Boolean).at(-1)}`, () => expect(adminHint(lines)).toBe(hint))

  test('sudo-rs only warns of requiretty: no hint for its warning alone, nor for lines of no matter', () => {
    expect(adminHint(["/etc/sudoers.d/admin:1:10: unknown setting: 'requiretty'", 'Defaults requiretty'])).toBeNull()
    expect(adminHint(['all fine', '@@step 1 ok'])).toBeNull()
  })
})

describe('ssh’s own words for a connection that went (a run goes on on the server then)', () => {
  const lost: string[][] = [
    ['Connection to ssh.example.com closed by remote host.'],
    ['client_loop: send disconnect: Broken pipe'],
    ['client_loop: send disconnect: Connection reset'],
    ['packet_write_wait: Connection to 203.0.113.7 port 22: Broken pipe'],
    ['Read from remote host ssh.example.com: Connection reset by peer'],
    ['Timeout, server ssh.example.com not responding.'],
  ]
  for (const lines of lost) test(lines[0] ?? '', () => expect(connectionLost(lines)).toBe(true))
  test('a connection refused before the login, or refused at it: not lost', () => {
    expect(
      connectionLost([
        'kex_exchange_identification: read: Connection reset by peer',
        'Connection reset by 203.0.113.7 port 22',
      ]),
    ).toBe(false)
    expect(connectionLost(['ssh_exchange_identification: Connection closed by remote host'])).toBe(false)
    expect(connectionLost(['admin@ssh.example.com: Permission denied (publickey).'])).toBe(false)
    expect(connectionLost(['ssh: connect to host ssh.example.com port 22: Connection refused'])).toBe(false)
    expect(connectionLost(['Connection closed by 203.0.113.7 port 22'])).toBe(false)
    expect(connectionLost([])).toBe(false)
  })
})

describe('the admin’s settings', () => {
  test('config.json’s tunnel.admin: strings trimmed, anything else empty', () => {
    expect(adminConfig(undefined)).toEqual({ user: '', key: '' })
    expect(adminConfig({ user: ' ubuntu ', key: 5 })).toEqual({ user: 'ubuntu', key: '' })
    expect(adminConfig({ user: 'root', key: 'C:\\keys\\admin', extra: 1 })).toEqual({
      user: 'root',
      key: 'C:\\keys\\admin',
    })
  })
  test('checked as the tunnel’s user and key: nothing that reaches ssh as an option; a user needed', () => {
    expect(adminProblems({ user: '-l', key: '' })).toEqual([
      { field: 'user', message: 'The user is a plain user name, without a leading dash' },
    ])
    expect(adminProblems({ user: '', key: '' })).toEqual([{ field: 'user', message: 'Admin user: needed' }])
    expect(adminProblems({ user: 'ubuntu', key: '-oProxyCommand=calc' }).map(p => p.field)).toEqual(['key'])
    expect(adminProblems({ user: 'root', key: '' })).toEqual([])
  })
})

test('a pinned server key: its host on 22, [host]:port on another port; a hashed line may be it', () => {
  const line = 'ssh.example.com ssh-ed25519 AAAAFAKEHOST'
  expect(pinnedIn(`${line}\n`, 'ssh.example.com', 22)).toBe(true)
  expect(pinnedIn(`${line}\n`, 'other.example.com', 22)).toBe(false)
  expect(pinnedIn(`${line}\n`, 'ssh.example.com', 2222)).toBe(false)
  expect(pinnedIn('[ssh.example.com]:2222 ssh-ed25519 AAAA\n', 'ssh.example.com', 2222)).toBe(true)
  expect(pinnedIn('a.example.com,ssh.example.com ssh-ed25519 AAAA\r\n', 'ssh.example.com', 22)).toBe(true)
  expect(pinnedIn('|1|abc=|def= ssh-ed25519 AAAA\n', 'ssh.example.com', 22)).toBe(true)
  expect(pinnedIn('# ssh.example.com\n@revoked ssh.example.com ssh-ed25519 AAAA\n', 'ssh.example.com', 22)).toBe(false)
  expect(pinnedIn('', 'ssh.example.com', 22)).toBe(false)
})

test('the page can import it: no node: import', () => {
  expect(readFileSync('src/core/server-admin.ts', 'utf8')).not.toMatch(/from 'node:/)
})
