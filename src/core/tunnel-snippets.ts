// What the owner sets up on the server, with the tunnel's settings filled in: the panel shows these
// with Copy, and the README has the same text for the defaults. What gives the tunnel its rights
// there (the user, the socket's folder, the key, sshd's fence) stays in the owner's hands: the
// board never runs these itself. Pure, with no node: import: the page imports it.

/** The socket path's own folder: the tunnel's user makes the socket there, its reader opens it by the folder's group. */
export const socketFolder = (socket: string): string => socket.slice(0, socket.lastIndexOf('/')) || '/'

/** The tunnel user's keys file: root's, out of that user's reach. */
export const keysFile = (user: string): string => `/etc/ssh/authorized_keys/${user}`

/** One shell word: '…', a ' in it as '\''. */
const word = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * The user with no shell and no home, with a group of its own, its account unlocked (an sshd with
 * `UsePAM no` refuses a locked one), the socket's folder (setgid, so the socket takes the folder's
 * group: `group`, by default the tunnel user's own until its reader gets it) and the keys' folder.
 */
export function serverCommands(user: string, socket: string, group: string = user): string {
  return [
    'sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \\',
    `    --shell /usr/sbin/nologin ${user}`,
    '# useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not',
    `sudo usermod -p '*' ${user}`,
    "# the socket's folder: the tunnel user makes the socket; its group is the reader's (step 3)",
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
 * sshd reads its config again: Debian and Ubuntu name the unit `ssh`, others `sshd`. A
 * socket-activated sshd (Ubuntu 26.04) whose service has not run yet refuses a `reload` (exit 1,
 * which ends a `set -e` paste); this reloads a running one and leaves one that is not running to
 * read the config when it starts (the spike).
 */
export const SSHD_RELOAD =
  '{ sudo systemctl try-reload-or-restart ssh 2>/dev/null || sudo systemctl try-reload-or-restart sshd; }'

/**
 * The user and its folder, the keys file and sshd's block in one paste: a subshell that stops at
 * the first error, and is safe to paste twice (what is there is left; the keys file is written
 * anew; the `Match` block is added only when sshd_config has none for `user`). `/run/sshd` is made
 * when missing, as an sshd no one has connected to yet leaves it (Ubuntu 24.04 from the web
 * console: `sshd -t` stops without it). No comments in it: zsh takes a pasted `#` for a command.
 */
export function stepOnePaste(user: string, socket: string, publicKey: string): string {
  const folder = socketFolder(socket)
  const config = '/etc/ssh/sshd_config'
  return [
    '( set -e',
    `id -u ${user} >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${user}`,
    `sudo usermod -p '*' ${user}`,
    `[ -d ${folder} ] || sudo install -d -m 2750 -o ${user} -g ${user} ${folder}`,
    'sudo install -d -m 755 /etc/ssh/authorized_keys',
    `echo ${word(keysLine(publicKey))} | sudo tee ${keysFile(user)} >/dev/null`,
    `grep -qx ${word(`Match User ${user}`)} ${config} || printf '\\n%s\\n' ${word(sshdBlock(user))} | sudo tee -a ${config} >/dev/null`,
    '[ -d /run/sshd ] || sudo install -d -m 755 /run/sshd',
    'sudo sshd -t',
    SSHD_RELOAD,
    ')',
  ].join('\n')
}

/** A host Caddy (its package runs it as `caddy`) opens the socket by the folder's group; chmod puts back the setgid bit chgrp may clear. */
export function caddyGroupLine(socket: string): string {
  const folder = socketFolder(socket)
  return `sudo chgrp caddy ${folder} && sudo chmod 2750 ${folder}`
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
