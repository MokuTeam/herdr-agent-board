// What the owner sets up on the server, with the tunnel's settings filled in: the panel shows these
// with Copy, and the README has the same text for the defaults. The board never touches the
// server itself. Pure, with no node: import: the page imports it.

/** The socket path's own folder: the tunnel's user makes the socket there, Caddy's group opens it. */
export const socketFolder = (socket: string): string => socket.slice(0, socket.lastIndexOf('/')) || '/'

/** The tunnel user's keys file: root's, out of that user's reach. */
export const keysFile = (user: string): string => `/etc/ssh/authorized_keys/${user}`

/**
 * The user with no shell and no home, its account unlocked (an sshd with `UsePAM no` refuses a
 * locked one), the socket's folder (setgid, so the socket takes the group `group` opens it with)
 * and the keys' folder.
 */
export function serverCommands(user: string, socket: string, group = 'caddy'): string {
  return [
    'sudo useradd --system --no-create-home --home-dir /nonexistent \\',
    `    --shell /usr/sbin/nologin ${user}`,
    '# useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not',
    `sudo usermod -p '*' ${user}`,
    "# the socket's folder: the tunnel user makes the socket, Caddy's group opens it, no one else",
    `sudo install -d -m 2750 -o ${user} -g ${group} ${socketFolder(socket)}`,
    "# the key's file belongs to root, out of the tunnel user's reach",
    'sudo install -d -m 755 /etc/ssh/authorized_keys',
  ].join('\n')
}

/** The keys file's line: the public key, allowed to forward only. */
export function keysLine(publicKey: string): string {
  return `restrict,port-forwarding ${publicKey.trim()}`
}

/**
 * sshd's second fence for the tunnel's user: no TCP forward either way (`AllowTcpForwarding no`
 * would refuse the socket forward too, so `remote` and `PermitListen none`), socket forwards from
 * the server to the PC only, no command. Needs OpenSSH 7.8 or newer on the server (PermitListen).
 */
export function sshdBlock(user: string): string {
  const settings = [
    `AuthorizedKeysFile ${keysFile(user)}`,
    'AuthenticationMethods publickey',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'AllowTcpForwarding remote',
    'PermitListen none',
    'AllowStreamLocalForwarding remote',
    'StreamLocalBindUnlink yes',
    'StreamLocalBindMask 0117',
    'X11Forwarding no',
    'AllowAgentForwarding no',
    'PermitTunnel no',
    'PermitTTY no',
    'ForceCommand /bin/false',
    'ClientAliveInterval 15',
    'ClientAliveCountMax 2',
  ]
  return [`Match User ${user}`, ...settings.map(s => `    ${s}`)].join('\n')
}

/** Caddy hands the domain to the socket; it gets the certificate and flushes the event streams itself. */
export function caddyfile(domain: string, socket: string): string {
  return [
    `${domain} {`,
    `    reverse_proxy unix/${socket}`,
    '    header Strict-Transport-Security "max-age=31536000"',
    '}',
  ].join('\n')
}

/** For those who use nginx: the socket, no buffering for the event streams, the right headers. */
export function nginxNote(socket: string): string {
  return [
    'location / {',
    `    proxy_pass http://unix:${socket}:;`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Connection "";',
    '    proxy_buffering off;',
    '    proxy_read_timeout 1h;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $remote_addr;',
    '    proxy_set_header X-Forwarded-Proto https;',
    '}',
  ].join('\n')
}
