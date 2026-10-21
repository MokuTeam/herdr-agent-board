import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import {
  caddyfile,
  keysFile,
  keysLine,
  nginxNote,
  serverCommands,
  socketFolder,
  sshdBlock,
} from '../../src/core/tunnel-snippets.ts'
import { PUBLIC_KEY_EXAMPLE } from '../../web/src/models/access.ts'

describe('the server’s snippets, filled in', () => {
  test('the user, its account unlocked, the socket’s folder and the keys’ folder', () => {
    expect(serverCommands('boardtunnel', TUNNEL_SOCKET)).toBe(
      [
        'sudo useradd --system --no-create-home --home-dir /nonexistent \\',
        '    --shell /usr/sbin/nologin boardtunnel',
        '# useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not',
        "sudo usermod -p '*' boardtunnel",
        "# the socket's folder: the tunnel user makes the socket, Caddy's group opens it, no one else",
        'sudo install -d -m 2750 -o boardtunnel -g caddy /var/lib/boardtunnel',
        "# the key's file belongs to root, out of the tunnel user's reach",
        'sudo install -d -m 755 /etc/ssh/authorized_keys',
      ].join('\n'),
    )
  })
  test('another user, group and socket change the user, the group and the folder', () => {
    const text = serverCommands('tun', '/srv/b/x.sock', 'www-data')
    expect(text).toContain('    --shell /usr/sbin/nologin tun\n')
    expect(text).toContain("sudo usermod -p '*' tun\n")
    expect(text).toContain('sudo install -d -m 2750 -o tun -g www-data /srv/b\n')
    expect(text).not.toContain('boardtunnel')
    expect(text).not.toContain('caddy')
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
})
