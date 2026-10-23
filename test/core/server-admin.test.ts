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
  loginHint,
  needFor,
  PROBE_SCRIPT,
  pinnedIn,
  promptKind,
  readProbe,
  remoteCommand,
  takesAskpass,
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

  test('a password typed: no BatchMode; the keys first, then the password, one try (call 1); the rest as without', () => {
    const args = adminSshArgs({
      conf,
      admin: { user: 'ubuntu', key: '' },
      knownHosts: '/k',
      command: 'CMD',
      password: true,
    })
    expect(args).toEqual([
      '-F',
      'none',
      '-T',
      '-o',
      'PreferredAuthentications=publickey,keyboard-interactive,password',
      '-o',
      'NumberOfPasswordPrompts=1',
      ...rest('/k').slice(2),
    ])
    // with a key named, that key is offered first
    const keyed = adminSshArgs({
      conf,
      admin: { user: 'ubuntu', key: '/a' },
      knownHosts: '/k',
      command: 'CMD',
      password: true,
      platform: 'linux',
    })
    expect(keyed.slice(0, 9)).toEqual([
      '-F',
      'none',
      '-T',
      '-i',
      '/a',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'PreferredAuthentications=publickey,keyboard-interactive,password',
    ])
  })

  test('no key pinned yet: this first login pins the one it meets (accept-new), a changed one still refused', () => {
    const first = adminSshArgs({
      conf,
      admin: { user: 'ubuntu', key: '' },
      knownHosts: '/k',
      command: 'CMD',
      pin: true,
    })
    expect(first).toEqual([
      '-F',
      'none',
      '-T',
      ...rest('/k').map(a => (a === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=accept-new' : a)),
    ])
    expect(first).not.toContain('StrictHostKeyChecking=no')
  })
})

describe('the login by password: which prompts its askpass answers (call 4)', () => {
  const rows: [string, ReturnType<typeof promptKind>][] = [
    // ssh's own, for the password method (Windows' and Linux' alike), and keyboard-interactive's
    ["root@board.migontech.online's password: ", 'password'],
    ["ubuntu@203.0.113.7's password: ", 'password'],
    ["root@2001:db8::1's password: ", 'password'],
    ['(root@board.migontech.online) Password: ', 'password'],
    ['Password: ', 'password'],
    ['(admin@ssh.example.com) Password for admin@EXAMPLE.COM: ', 'password'],
    ['(admin@ssh.example.com) Пароль: ', 'password'],
    // a key's passphrase: no answer, the key is skipped
    ["Enter passphrase for key 'C:\\Users\\Иван/.ssh/id_ed25519': ", 'passphrase'],
    ["Enter passphrase for key '/home/me/.ssh/id_rsa': ", 'passphrase'],
    // ssh-keygen's own (Windows' 9.5 asks so through the askpass)
    ['Enter passphrase: ', 'passphrase'],
    // anything else ends the login
    ['(admin@ssh.example.com) Verification code: ', 'other'],
    ["(admin@ssh.example.com) One-time password (OATH) for `admin': ", 'other'],
    ["Enter admin@ssh.example.com's old password: ", 'other'],
    ['(admin@ssh.example.com) Current password: ', 'other'],
    ['(admin@ssh.example.com) New password: ', 'other'],
    ['(admin@ssh.example.com) Password for new user: ', 'other'],
    ['Enter PIN for ED25519-SK key /home/me/.ssh/id_ed25519_sk: ', 'other'],
    ['Are you sure you want to continue connecting (yes/no/[fingerprint])? ', 'other'],
    ['--eval=console.log(1)', 'other'],
    ['', 'other'],
  ]
  for (const [prompt, kind] of rows)
    test(`${kind}: ${JSON.stringify(prompt)}`, () => expect(promptKind(prompt)).toBe(kind))
})

describe('an ssh that takes the askpass without a terminal: OpenSSH 8.4 and later (SSH_ASKPASS_REQUIRE)', () => {
  const rows: [string, boolean][] = [
    ['OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2', true],
    ['OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3', true],
    ['OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2', false],
    ['OpenSSH_for_Windows_7.7p1, LibreSSL 2.6.5', false],
    ['OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024', true],
    ['OpenSSH_8.4p1 Debian-5+deb11u3, OpenSSL 1.1.1w  11 Sep 2023', true],
    ['OpenSSH_8.3p1, OpenSSL 1.1.1g', false],
    ['OpenSSH_10.0p2, LibreSSL 3.3.6', true],
    ['', false],
    ['spawn ENOENT', false],
  ]
  for (const [line, ok] of rows) test(`${ok}: ${line || '(nothing)'}`, () => expect(takesAskpass(line)).toBe(ok))
})

describe('why the login itself failed (before ssh’s other words)', () => {
  const denied = (methods: string): string[] => [`admin@ssh.example.com: Permission denied (${methods}).`]
  const base = { lines: [] as string[], typed: false, askpass: null, oldSsh: false, root: false }
  const rows: [string, Parameters<typeof loginHint>[0], ReturnType<typeof loginHint>][] = [
    ['no password typed, the server takes one', { ...base, lines: denied('publickey,password') }, 'loginPassword'],
    ['… by keyboard-interactive', { ...base, lines: denied('publickey,keyboard-interactive') }, 'loginPassword'],
    ['no password typed, keys only: as before', { ...base, lines: denied('publickey') }, 'publickey'],
    ['typed, keys only', { ...base, typed: true, lines: denied('publickey') }, 'keyOnly'],
    [
      'typed and answered, refused',
      { ...base, typed: true, askpass: { answered: 1, refused: null }, lines: denied('publickey,password') },
      'wrongLogin',
    ],
    [
      'root’s, refused (or PermitRootLogin prohibit-password)',
      {
        ...base,
        typed: true,
        root: true,
        askpass: { answered: 1, refused: null },
        lines: denied('publickey,password'),
      },
      'rootLogin',
    ],
    [
      'the password asked again',
      { ...base, typed: true, askpass: { answered: 1, refused: "admin@ssh.example.com's password: " } },
      'wrongLogin',
    ],
    [
      'a one-time code',
      { ...base, typed: true, askpass: { answered: 1, refused: '(admin@ssh.example.com) Verification code: ' } },
      'otherPrompt',
    ],
    [
      'a new password asked',
      { ...base, typed: true, askpass: { answered: 0, refused: '(admin@ssh.example.com) New password: ' } },
      'otherPrompt',
    ],
    [
      'typed, ssh too old, the server takes passwords',
      { ...base, typed: true, oldSsh: true, lines: denied('publickey,password') },
      'sshOld',
    ],
    ['typed, ssh too old, keys only', { ...base, typed: true, oldSsh: true, lines: denied('publickey') }, 'keyOnly'],
    [
      'logged in (sudo’s lines after)',
      { ...base, typed: true, askpass: { answered: 1, refused: null }, lines: ['Sorry, try again.'] },
      null,
    ],
    [
      'too many keys: ssh’s own words say better',
      {
        ...base,
        typed: true,
        askpass: { answered: 0, refused: null },
        lines: ['Received disconnect from 203.0.113.5 port 22:2: Too many authentication failures'],
      },
      null,
    ],
    ['a file a script could not read is no refusal', { ...base, lines: ['cat: /etc/shadow: Permission denied'] }, null],
  ]
  for (const [name, o, want] of rows) test(`${String(want)}: ${name}`, () => expect(loginHint(o)).toBe(want))
})

test('the field each hint asks for: the login’s password (sudo’s too), or sudo’s own', () => {
  expect(['needPassword', 'loginPassword', 'wrongLogin', 'rootLogin'].map(h => needFor(h as AdminHint))).toEqual(
    Array(4).fill('password'),
  )
  expect(needFor('sudoPassword')).toBe('sudoPassword')
  expect(needFor('wrongPassword')).toBe('sudoPassword')
  expect(needFor('otherPrompt')).toBeNull()
  expect(needFor(null)).toBeNull()
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
