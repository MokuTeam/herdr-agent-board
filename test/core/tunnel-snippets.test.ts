import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import {
  caddyfile,
  caddyGroupLine,
  keysFile,
  keysLine,
  nginxNote,
  serverCommands,
  socketFolder,
  sshdBlock,
  stepOnePaste,
} from '../../src/core/tunnel-snippets.ts'
import { PUBLIC_KEY_EXAMPLE } from '../../web/src/models/access.ts'

describe('the server’s snippets, filled in', () => {
  test('the user with a group of its own, its account unlocked, the socket’s folder in that group, the keys’ folder', () => {
    expect(serverCommands('boardtunnel', TUNNEL_SOCKET)).toBe(
      [
        'sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \\',
        '    --shell /usr/sbin/nologin boardtunnel',
        '# useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not',
        "sudo usermod -p '*' boardtunnel",
        "# the socket's folder: the tunnel user makes the socket; its group is the reader's (step 3)",
        'sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel',
        "# the key's file belongs to root, out of the tunnel user's reach",
        'sudo install -d -m 755 /etc/ssh/authorized_keys',
      ].join('\n'),
    )
    // A group given: the folder takes it, the rest stays.
    const caddy = serverCommands('boardtunnel', TUNNEL_SOCKET, 'caddy')
    expect(caddy).toContain('\nsudo install -d -m 2750 -o boardtunnel -g caddy /var/lib/boardtunnel\n')
    expect(caddy.replace('-g caddy', '-g boardtunnel')).toBe(serverCommands('boardtunnel', TUNNEL_SOCKET))
  })
  test('another user, group and socket change the user, the group and the folder', () => {
    const text = serverCommands('tun', '/srv/b/x.sock', 'www-data')
    expect(text).toContain('    --shell /usr/sbin/nologin tun\n')
    expect(text).toContain("sudo usermod -p '*' tun\n")
    expect(text).toContain('sudo install -d -m 2750 -o tun -g www-data /srv/b\n')
    expect(text).not.toContain('boardtunnel')
    expect(text).not.toContain('caddy')
    expect(serverCommands('tun', '/srv/b/x.sock')).toContain('sudo install -d -m 2750 -o tun -g tun /srv/b\n')
  })
  test('all of step 1 in one paste: one subshell that stops at the first error, safe to paste twice', () => {
    const lines = [
      '( set -e',
      'id -u boardtunnel >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin boardtunnel',
      "sudo usermod -p '*' boardtunnel",
      '[ -d /var/lib/boardtunnel ] || sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel',
      'sudo install -d -m 755 /etc/ssh/authorized_keys',
      "echo 'restrict,port-forwarding ssh-ed25519 AAAA k' | sudo tee /etc/ssh/authorized_keys/boardtunnel >/dev/null",
      `grep -qx 'Match User boardtunnel' /etc/ssh/sshd_config || printf '\\n%s\\n' '${sshdBlock('boardtunnel')}' | sudo tee -a /etc/ssh/sshd_config >/dev/null`,
      'sudo sshd -t',
      '{ sudo systemctl try-reload-or-restart ssh 2>/dev/null || sudo systemctl try-reload-or-restart sshd; }',
      ')',
    ]
    expect(stepOnePaste('boardtunnel', TUNNEL_SOCKET, 'ssh-ed25519 AAAA k')).toBe(lines.join('\n'))
    // Another user and socket; the key trimmed, a quote in its comment kept inside one shell word.
    const other = stepOnePaste('tun', '/srv/b/x.sock', " ssh-ed25519 AAAA it's mine\n")
    expect(other).toContain("\nsudo usermod -p '*' tun\n")
    expect(other).toContain('\n[ -d /srv/b ] || sudo install -d -m 2750 -o tun -g tun /srv/b\n')
    expect(other).toContain(
      "\necho 'restrict,port-forwarding ssh-ed25519 AAAA it'\\''s mine' | sudo tee /etc/ssh/authorized_keys/tun >/dev/null\n",
    )
    expect(other).toContain("grep -qx 'Match User tun' /etc/ssh/sshd_config ||")
    expect(other).not.toContain('boardtunnel')
  })
  test('a host Caddy gets the socket’s folder by its group', () => {
    expect(caddyGroupLine(TUNNEL_SOCKET)).toBe(
      'sudo chgrp caddy /var/lib/boardtunnel && sudo chmod 2750 /var/lib/boardtunnel',
    )
    expect(caddyGroupLine('/srv/b/x.sock')).toBe('sudo chgrp caddy /srv/b && sudo chmod 2750 /srv/b')
  })
  test('the keys file’s line: the key trimmed, allowed to forward only', () => {
    expect(keysLine(' ssh-ed25519 AAAA agent-board@PC \n')).toBe(
      'restrict,port-forwarding ssh-ed25519 AAAA agent-board@PC',
    )
    expect(keysFile('tun')).toBe('/etc/ssh/authorized_keys/tun')
  })
  test('the socket’s folder is its path’s own folder', () => {
    expect(socketFolder(TUNNEL_SOCKET)).toBe('/var/lib/boardtunnel')
    expect(socketFolder('/srv/b/x.sock')).toBe('/srv/b')
  })
  test('the sshd block: no TCP forward either way, socket forwards to the PC only', () => {
    expect(sshdBlock('boardtunnel')).toBe(
      [
        'Match User boardtunnel',
        '    AuthorizedKeysFile /etc/ssh/authorized_keys/boardtunnel',
        '    AuthenticationMethods publickey',
        '    PasswordAuthentication no',
        '    KbdInteractiveAuthentication no',
        '    AllowTcpForwarding remote',
        '    PermitListen none',
        '    AllowStreamLocalForwarding remote',
        '    StreamLocalBindUnlink yes',
        '    StreamLocalBindMask 0117',
        '    X11Forwarding no',
        '    AllowAgentForwarding no',
        '    PermitTunnel no',
        '    PermitTTY no',
        '    ForceCommand /bin/false',
        '    ClientAliveInterval 15',
        '    ClientAliveCountMax 2',
      ].join('\n'),
    )
    const other = sshdBlock('tun')
    expect(other.split('\n').slice(0, 2)).toEqual([
      'Match User tun',
      '    AuthorizedKeysFile /etc/ssh/authorized_keys/tun',
    ])
  })
  test('the Caddyfile hands the domain to the socket', () => {
    expect(caddyfile('board.example.com', TUNNEL_SOCKET)).toBe(
      [
        'board.example.com {',
        '    reverse_proxy unix//var/lib/boardtunnel/board.sock',
        '    header Strict-Transport-Security "max-age=31536000"',
        '}',
      ].join('\n'),
    )
  })
  test('the nginx note: the socket, no buffering, the right headers', () => {
    expect(nginxNote(TUNNEL_SOCKET)).toBe(
      [
        'location / {',
        '    proxy_pass http://unix:/var/lib/boardtunnel/board.sock:;',
        '    proxy_http_version 1.1;',
        '    proxy_set_header Connection "";',
        '    proxy_buffering off;',
        '    proxy_read_timeout 1h;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Forwarded-For $remote_addr;',
        '    proxy_set_header X-Forwarded-Proto https;',
        '}',
      ].join('\n'),
    )
  })
  test('the page can import it: no node: import', () => {
    expect(readFileSync('src/core/tunnel-snippets.ts', 'utf8')).not.toMatch(/from 'node:/)
  })
})

describe('the README’s server steps are the panel’s snippets', () => {
  const readme = readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n')
  /** The text of every fenced block that opens at column 0, as a copy from the page would give it. */
  const fences = [...readme.matchAll(/^```[^\n]*\n([\s\S]*?)\n```$/gm)].map(m => m[1] ?? '')
  const heading = '## Another computer or a tablet, through your own domain'

  test('its own section, after the phone’s browser and before Language', () => {
    const lines = readme.split('\n')
    const at = lines.indexOf(heading)
    expect(at).toBeGreaterThan(lines.indexOf("### In a phone's browser"))
    expect(at).toBeLessThan(lines.indexOf('## Language'))
  })
  test('the user and the socket’s folder: serverCommands’ lines in order, whole, in one block', () => {
    // Whole lines: a README line with more before or after one of them is not that line.
    const lines = `\n${serverCommands('boardtunnel', TUNNEL_SOCKET)}\n`
    expect(fences.some(text => `\n${text}\n`.includes(lines))).toBe(true)
  })
  test('the keys file’s line, as the panel shows it before a key exists', () => {
    expect(fences).toContain(keysLine(PUBLIC_KEY_EXAMPLE))
  })
  test('the sshd block and the Caddyfile, word for word', () => {
    expect(fences).toContain(sshdBlock('boardtunnel'))
    expect(fences).toContain(caddyfile('board.example.com', TUNNEL_SOCKET))
  })
  test('the folder’s group for a host Caddy, word for word', () => {
    expect(fences).toContain(caddyGroupLine(TUNNEL_SOCKET))
  })
  test('the server is no longer said to be untouched by the board', () => {
    expect(readme).not.toContain('The board never touches the server')
  })
})
