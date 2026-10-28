// The profile sync's command on the server, as root over the admin's login (core/server-admin.ts
// remoteCommand): the board's user and home read from the install's record (root's own), then the
// board's sync program (entrypoints/profile-sync.ts) run as that user with its own Bun and
// checkout, in a session of its own (setsid -w, runuser: no terminal of root's, no password), its
// stdin and stdout the sync's frames. Root writes nothing in the user's home: every file the sync
// writes there, the user writes. Pure.
import { CHECKOUT, INSTALL_RECORD } from '../server-install.ts'

/** What the sync program does on the server: say what it has, send files, write them, record a sync. */
export type SyncOp = 'scan' | 'pack' | 'apply' | 'record'

/** What the command says on stderr when it cannot run the program: no board installed here, or one from before the sync. */
export const NO_BOARD = '@@sync none'
export const OLD_BOARD = '@@sync old'
/** Its exit codes for those two. */
export const NO_BOARD_CODE = 3
export const OLD_BOARD_CODE = 4

export function syncScript(op: SyncOp): string {
  return [
    '# agent-board: profile sync',
    'set -u',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `r=${INSTALL_RECORD}`,
    `u=$(sed -n 's/.*"user":"\\([a-z_][a-z0-9_-]*\\)".*/\\1/p' "$r" 2>/dev/null)`,
    `h=$(sed -n 's/.*"home":"\\(\\/[A-Za-z0-9._\\/-]*\\)".*/\\1/p' "$r" 2>/dev/null)`,
    `if [ -z "$u" ] || [ -z "$h" ] || ! id -u "$u" >/dev/null 2>&1; then echo '${NO_BOARD}' >&2; exit ${NO_BOARD_CODE}; fi`,
    `b="$h/${CHECKOUT}/src/entrypoints/profile-sync.ts"`,
    `if [ ! -f "$b" ] || [ ! -x "$h/.bun/bin/bun" ]; then echo '${OLD_BOARD}' >&2; exit ${OLD_BOARD_CODE}; fi`,
    `exec setsid -w runuser -u "$u" -- env -i HOME="$h" USER="$u" LOGNAME="$u" SHELL=/bin/bash PATH="$h/.local/bin:$h/.bun/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR="/run/user/$(id -u "$u")" LANG=C.UTF-8 "$h/.bun/bin/bun" "$b" ${op}`,
    '',
  ].join('\n')
}
