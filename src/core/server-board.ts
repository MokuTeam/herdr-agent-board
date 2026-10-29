// The board installed on a server, as the local board's panel sees it (the board-on-own-server
// spec's path B, its card "The board on the server"): what is there of the install, read in one
// round as root that changes nothing (root's record, the board's user and its mark, its sudo,
// herdr's service); the version the server has against the local checkout's; and the plan of its
// Undo in plain words, the very lines the install's own `--undo` prints
// (services/server-install.ts `undo`). Pure, with no node: import: the page draws from it too.
import { t } from './lang.ts'
import {
  BOARD_USER,
  BOARD_USER_COMMENT,
  INSTALL_RECORD,
  type InstallRecord,
  installRecord,
  SERVICE,
  sudoersFile,
} from './server-install.ts'
import { shQuote } from './server-shell.ts'
import type { Translator } from './types.ts'

/** What the round as root found of the install. */
export interface BoardFacts {
  /** root's record of the install (core/server-install.ts INSTALL_RECORD); null: none, or not one. */
  record: InstallRecord | null
  /** The board's user (the record's, else `agent`), when the server has it. */
  user: { name: string; home: string; ours: boolean } | null
  /** Its sudo from the installer. */
  sudo: boolean
  /** herdr's service in its home. */
  service: boolean
}

/** What the Undo goes by, as the install's `--undo` finds it on the server. Nothing secret. */
export interface UndoFacts {
  /** The board's user: the record's, else the one asked for. */
  user: string
  /** Its home while the user is there; null when there is no such user. */
  home: string | null
  /** The user carries the installer's mark. */
  ours: boolean
  /** root's record of the install is there. */
  record: boolean
  sudo: boolean
  service: boolean
  /** What the install added for the agents' browsers (the record's): only Undo with the user takes them. */
  desktop: readonly string[]
  desktopLibs: readonly string[]
}

/** The version the server's board is at (root's record): no repository (a URL may carry a token), nothing secret. */
export interface BoardVersion {
  commit: string
  /** A copy of a local checkout with its uncommitted changes. */
  changes: boolean
  /** The branch, tag or commit a git install follows; null for a copy sent from a computer. */
  ref: string | null
  /** When it was installed (the record's, ISO). */
  at: string
}

/** The local checkout's version: the commit and whether it has uncommitted changes. */
export interface LocalVersion {
  commit: string
  changes: boolean
}

/**
 * Where the card stands: never looked at this server in this board's life ('unknown'), nothing
 * installed ('none'), the same version as this computer's ('current'), or another ('update').
 */
export type BoardState = 'unknown' | 'none' | 'current' | 'update'

const SUDOERS_PREFIX = sudoersFile('')
const NAME = '[A-Za-z0-9_][A-Za-z0-9_-]*'

/**
 * The round as root that reads what the install left, and changes nothing: its record on one line,
 * the user it names (else `agent`) as passwd has it, whether its sudo and herdr's service are there.
 * Never the tunnel's: its record and user are /etc/agent-board's and another name.
 */
export function boardFactsScript(): string {
  const r = shQuote(INSTALL_RECORD)
  return [
    '# agent-board: board',
    'set -u',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    "echo '@@facts 1'",
    'u=',
    `if [ -f ${r} ]; then`,
    `  printf '@@record %s\\n' "$(head -c 16384 ${r} | tr -d '\\r\\n')"`,
    `  u=$(sed -n 's/^{"v":1,"user":"\\(${NAME}\\)".*/\\1/p' ${r} | head -n 1)`,
    'fi',
    `[ -n "$u" ] || u=${BOARD_USER}`,
    'p=$(getent passwd "$u" | head -n 1)',
    `printf '@@user %s\\n' "$p"`,
    `[ -e "${SUDOERS_PREFIX}$u" ] && echo '@@sudo'`,
    'h=$(printf \'%s\' "$p" | cut -d: -f6)',
    `[ -n "$h" ] && [ -e "$h/.config/systemd/user/${SERVICE}" ] && echo '@@service'`,
    "echo '@@end'",
  ].join('\n')
}

/** The round's output read; null when it is garbled or cut ("Look could not read the server"). */
export function readBoardFacts(out: string): BoardFacts | null {
  const lines = out.split('\n').map(l => l.replace(/\r$/, ''))
  if (!lines.includes('@@facts 1') || !lines.includes('@@end')) return null
  let record: InstallRecord | null = null
  let passwd = ''
  for (const l of lines) {
    if (l.startsWith('@@record ')) {
      try {
        record = installRecord(JSON.parse(l.slice('@@record '.length)))
      } catch {
        record = null
      }
    } else if (l.startsWith('@@user ')) passwd = l.slice('@@user '.length)
  }
  const [name, , , , comment, home] = passwd.split(':')
  const wanted = record?.user ?? BOARD_USER
  const user =
    name === wanted && home !== undefined && home !== ''
      ? { name, home, ours: (comment ?? '') === BOARD_USER_COMMENT }
      : null
  return { record, user, sudo: lines.includes('@@sudo'), service: lines.includes('@@service') }
}

/** What the Undo goes by, from what the round found. */
export function undoFactsOf(b: BoardFacts): UndoFacts {
  return {
    user: b.record?.user ?? BOARD_USER,
    home: b.user?.home ?? null,
    ours: b.user?.ours === true,
    record: b.record !== null,
    sudo: b.sudo,
    service: b.service,
    desktop: b.record?.desktop ?? [],
    desktopLibs: b.record?.desktopLibs ?? [],
  }
}

/** The packages the Undo hands back: only with the user, and only one the installer made. */
export function undoPackages(f: UndoFacts, removeUser: boolean): { desktop: string[]; desktopLibs: string[] } {
  const all = removeUser && f.ours
  return { desktop: all ? [...f.desktop] : [], desktopLibs: all ? [...f.desktopLibs] : [] }
}

/** Nothing of the installer's there: the Undo has nothing to do (`web`: the web server has a part of the install's). */
export const undoNothing = (f: UndoFacts, removeUser: boolean, web: boolean): boolean =>
  !f.record && !web && !f.service && !f.sudo && !(removeUser && f.ours)

/**
 * The Undo in plain words, in the order it goes: herdr's service, sudo, the web server's part
 * (`web`: its lines; null: it has none), the packages, the user (gone, kept, or not the board's).
 */
export function undoWill(
  f: UndoFacts,
  removeUser: boolean,
  web: readonly string[] | null,
  tr: Translator = t,
): string[] {
  const user = { user: f.user }
  const there = f.home !== null
  const will: string[] = []
  if (there) will.push(tr('install.undo.will.service', user))
  if (f.sudo) will.push(tr('install.undo.will.sudo', user))
  if (web) will.push(...web)
  else will.push(tr('install.undo.will.webNone'))
  const { desktop, desktopLibs } = undoPackages(f, removeUser)
  if (desktop.length) will.push(tr('install.undo.will.desktop', { packages: desktop.join(', ') }))
  if (desktopLibs.length) will.push(tr('install.undo.will.libs', { packages: desktopLibs.join(', ') }))
  if (there && removeUser && f.ours) will.push(tr('install.undo.will.user', { ...user, home: f.home ?? '' }))
  else if (there && f.ours) will.push(tr('install.undo.will.keepUser', user))
  else if (there && removeUser) will.push(tr('install.undo.userKept', user))
  return will
}

/** The version root's record says the server's board is at. */
export const boardVersionOf = (r: InstallRecord): BoardVersion => ({
  commit: r.source.commit,
  changes: r.source.kind === 'archive' && r.source.changes,
  ref: r.source.kind === 'git' ? r.source.ref : null,
  at: r.at,
})

/**
 * Where the card stands, from the last look at the server (undefined or null: none in this
 * board's life; `version` null: nothing installed) and the local checkout's version (null: not a
 * checkout, so nothing to compare: as it is).
 */
export function boardState(
  installed: { version: BoardVersion | null } | null | undefined,
  local: LocalVersion | null | undefined,
): BoardState {
  if (!installed) return 'unknown'
  const v = installed.version
  if (!v) return 'none'
  if (!local) return 'current'
  return v.commit === local.commit && v.changes === local.changes ? 'current' : 'update'
}

/** A version in words: "version 1a2b3c4", "version 1a2b3c4 (with local changes)". */
export const versionLine = (v: LocalVersion, tr: Translator = t): string =>
  tr(v.changes ? 'install.panel.versionChanges' : 'install.panel.version', { commit: v.commit.slice(0, 7) })
