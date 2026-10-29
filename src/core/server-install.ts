// The board on a server of the owner's (the board-on-own-server spec): herdr, Claude Code and the
// board on the host as a user of their own, herdr as that user's systemd service, the board's
// login listener on a Unix socket, and the web server in front of it set up as the tunnel's server
// setup does, with the server mode's socket as its target (core/server-plan.ts, `server`).
//
// One install, two ways in: path A, the static bootstrap `server-install.sh` piped from GitHub
// into a root shell on the server; path B, the local board's "Install the board on this server",
// which sends the same bootstrap with a pack of the local checkout over the admin's login. The
// bootstrap fetches Bun and the board's code for root and hands over to the board's own install
// (entrypoints/server-install.ts, services/server-install.ts). Here: the names and paths the
// three share, the flags, the service, and where the board's code came from. Pure, with no node:
// import: the page shows the plan from it too.
import { CHROME_DEB, CHROME_PACKAGE, PLAYWRIGHT_VERSION } from './desktop.ts'
import { t } from './lang.ts'
import type { Wanted } from './server-plan.ts'
import { SERVER_NAMES } from './server-texts.ts'
import { fieldProblem } from './tunnel.ts'
import type { Lang, Translator } from './types.ts'

/** The board's own user, by default (call 4: no sudo unless --sudo). */
export const BOARD_USER = 'agent'
/** Its comment (GECOS): the mark of a user the installer made (call 12); the tunnel user's is another. */
export const BOARD_USER_COMMENT = 'agent-board server'
/**
 * The board's login listener's socket (calls 1 and 6). Its folder, 2750, the board's user's with
 * the web server's group, is made by the web server's plan as root, as the tunnel's folder is.
 */
export const BOARD_SOCKET = '/var/lib/agent-board/board.sock'
/**
 * Root's own Bun and copy of the board, which the bootstrap fetches and runs the install from:
 * nothing root runs is the board's user's to change (that user runs Claude Code).
 */
export const INSTALL_HOME = '/usr/local/lib/agent-board'
/**
 * What the install set up, for its Undo and the next run: root's, beside the web server's record in
 * the server mode's own folder, apart from the tunnel's /etc/agent-board (whose runs remove that
 * folder once its own setup is gone).
 */
export const INSTALL_RECORD = `${SERVER_NAMES.dir}/install.json`
/** Where path A fetches the board from (a fork's with --repo). */
export const REPO = 'https://github.com/MokuTeam/herdr-agent-board'
/** The bootstrap, at the repository's root: what path A's one line pipes into sh. */
export const BOOTSTRAP = 'server-install.sh'
/** The Bun the board is tried with (package.json's engines): Bun's installer takes a version, so it is pinned. */
export const BUN_VERSION = '1.4.3'
/** The board's checkout in its user's home. */
export const CHECKOUT = 'agent-board'
/** herdr's service, a systemd user service of the board's user (call 13). */
export const SERVICE = 'herdr.service'
/** In a pack of a local checkout (path B): which commit it is of, and whether it has local changes. */
export const ARCHIVE_MARK = '.agent-board-archive.json'
/** What the board's user's own config folder keeps of where its code came from (`board update` follows it). */
export const SOURCE_FILE = 'source.json'
/** sudo for the board's user, only with --sudo (call 4). */
export const sudoersFile = (user: string): string => `/etc/sudoers.d/agent-board-${user}`

/** Where the board's code came from (call 10): a git ref, or a pack of a local checkout. */
export type Source =
  | { kind: 'git'; repo: string; ref: string; commit: string }
  | { kind: 'archive'; commit: string; changes: boolean }

/** What the installer was asked for. */
export interface InstallFlags {
  domain: string | null
  ref: string
  repo: string
  user: string
  sudo: boolean
  undo: boolean
  removeUser: boolean
  yes: boolean
  archive: string | null
  lang: Lang | null
}

const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/
const COMMIT = /^[0-9a-f]{40}$/
const isRepo = (s: string): boolean =>
  /^(https?|file|ssh|git):\/\/[^\s'"`$\\]+$/.test(s) || /^\/[A-Za-z0-9._/-]+$/.test(s)

/** The flags (call 11), or what is wrong with them. */
export function installFlags(argv: readonly string[]): InstallFlags | { error: string } {
  const f: InstallFlags = {
    domain: null,
    ref: 'main',
    repo: REPO,
    user: BOARD_USER,
    sudo: false,
    undo: false,
    removeUser: false,
    yes: false,
    archive: null,
    lang: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const value = (): string | null => {
      const v = argv[i + 1]
      i++
      return v === undefined || v.startsWith('--') ? null : v
    }
    switch (a) {
      case '--domain': {
        const v = value()?.toLowerCase().replace(/\.$/, '') ?? null
        if (v === null || fieldProblem('domain', v) || v === '') return { error: `--domain: ${t('tunnel.err.domain')}` }
        f.domain = v
        break
      }
      case '--ref': {
        const v = value()
        if (v === null || !REF.test(v)) return { error: '--ref takes a branch, a tag or a commit' }
        f.ref = v
        break
      }
      case '--repo': {
        const v = value()
        if (v === null || !isRepo(v)) return { error: '--repo takes a git URL' }
        f.repo = v
        break
      }
      case '--user': {
        // no dot: sudo skips a file in /etc/sudoers.d whose name has one, and --sudo's is named
        // after the user (sudoersFile); the tunnel's own user keeps its rule
        const v = value()
        if (v === null || v === '' || fieldProblem('user', v) || v === 'root' || v.includes('.'))
          return { error: '--user takes a user name: letters, digits, _ and -, not root' }
        f.user = v
        break
      }
      case '--archive': {
        const v = value()
        if (v === null || !/^\/[A-Za-z0-9._/-]+$/.test(v)) return { error: '--archive takes a file' }
        f.archive = v
        break
      }
      case '--lang': {
        const v = value()
        if (v !== 'en' && v !== 'ru') return { error: '--lang takes en or ru' }
        f.lang = v
        break
      }
      case '--sudo':
        f.sudo = true
        break
      case '--undo':
        f.undo = true
        break
      case '--remove-user':
        f.removeUser = true
        break
      case '--yes':
        f.yes = true
        break
      default:
        return { error: `unknown option ${a}` }
    }
  }
  if (f.removeUser && !f.undo) return { error: '--remove-user goes with --undo' }
  return f
}

/** What the web server's setup wants for the server mode: the board's socket, its user, the domain. */
export const serverWanted = (domain: string, user: string): Wanted => ({
  user,
  socket: BOARD_SOCKET,
  domain,
  publicPort: null,
  server: true,
})

/**
 * herdr's service (call 13): `herdr server` as the board's user, started with the user's manager
 * (lingering starts it with the server), again after a failure. herdr's startup hooks then open
 * the board and wake, as on a PC; the board's run.ts restarts the board when its code changes.
 */
export function serviceUnit(home: string): string {
  const path = [`${home}/.local/bin`, `${home}/.bun/bin`, '/usr/local/bin', '/usr/bin', '/bin'].join(':')
  return [
    "# agent-board: herdr as the board's user, with the server (server-install.sh; its --undo removes it)",
    '[Unit]',
    'Description=herdr server (agent-board)',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${home}`,
    `Environment=PATH=${path}`,
    `ExecStart=${home}/.local/bin/herdr server`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** A source read back (the user's source.json, root's record, a pack's mark); null for anything else. */
export function sourceOf(v: unknown): Source | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (s.kind === 'git' && typeof s.repo === 'string' && isRepo(s.repo) && typeof s.ref === 'string' && REF.test(s.ref))
    return typeof s.commit === 'string' && COMMIT.test(s.commit)
      ? { kind: 'git', repo: s.repo, ref: s.ref, commit: s.commit }
      : null
  if (s.kind === 'archive' && typeof s.commit === 'string' && COMMIT.test(s.commit) && typeof s.changes === 'boolean')
    return { kind: 'archive', commit: s.commit, changes: s.changes }
  return null
}

/** A pack's mark: the commit it is of and whether it has local changes. */
export function archiveMark(v: unknown): { commit: string; changes: boolean } | null {
  const s = sourceOf({ ...(typeof v === 'object' && v !== null ? v : {}), kind: 'archive' })
  return s?.kind === 'archive' ? { commit: s.commit, changes: s.changes } : null
}

/** Where the code came from, in words: "main (1a2b3c4)", "a copy of 1a2b3c4 with local changes". */
export function sourceLine(s: Source, tr: Translator = t): string {
  const commit = s.commit.slice(0, 7)
  if (s.kind === 'git')
    return tr('install.source.git', { ref: s.ref, commit, repo: s.repo === REPO ? 'GitHub' : s.repo })
  return tr(s.changes ? 'install.source.changes' : 'install.source.archive', { commit })
}

/** The install's record on the server (root's): what Undo and the next run need. */
export interface InstallRecord {
  v: 1
  user: string
  home: string
  domain: string
  socket: string
  source: Source
  sudo: boolean
  at: string
  /** The packages for the agents' browsers this install added (Undo with --remove-user takes them away); absent: none. */
  desktop?: string[]
  /** The libraries this install added for the board's own Chromium (Ubuntu's arm64); Undo with --remove-user hands them back to apt. */
  desktopLibs?: string[]
}

const PACKAGE = /^[a-z0-9][a-z0-9.+-]{1,60}$/

export function installRecord(v: unknown): InstallRecord | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const source = sourceOf(r.source)
  if (r.v !== 1 || !source) return null
  if (typeof r.user !== 'string' || r.user === '' || fieldProblem('user', r.user)) return null
  if (typeof r.home !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(r.home)) return null
  if (typeof r.domain !== 'string' || r.domain === '' || fieldProblem('domain', r.domain)) return null
  if (r.socket !== BOARD_SOCKET || typeof r.sudo !== 'boolean' || typeof r.at !== 'string') return null
  const packages = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && PACKAGE.test(p)) : []
  const desktop = packages(r.desktop)
  const desktopLibs = packages(r.desktopLibs)
  return {
    v: 1,
    user: r.user,
    home: r.home,
    domain: r.domain,
    socket: r.socket,
    source,
    sudo: r.sudo,
    at: r.at,
    ...(desktop.length && { desktop }),
    ...(desktopLibs.length && { desktopLibs }),
  }
}

/**
 * The agents' browsers' packages, as root (core/desktop.ts): from the system's own apt, and
 * Google Chrome from Google's .deb (which adds Google's repository, so apt updates it).
 */
export function desktopScript(add: readonly string[]): string {
  const apt = add.filter(p => p !== CHROME_PACKAGE && PACKAGE.test(p))
  const lines = ['set -e', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update -qq']
  if (apt.length) lines.push(`apt-get install -y -qq --no-install-recommends ${apt.join(' ')}`)
  if (add.includes(CHROME_PACKAGE))
    lines.push(
      `d=$(mktemp -d) && chmod 755 "$d" && trap 'rm -rf "$d"' EXIT && curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 ${CHROME_DEB} -o "$d/chrome.deb" && chmod 644 "$d/chrome.deb" && apt-get install -y -qq "$d/chrome.deb"`,
    )
  return lines.join('\n')
}

/** Undo's: the packages the install added for the agents' browsers, purged. */
export const desktopRemoveScript = (packages: readonly string[]): string =>
  `DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq ${packages.filter(p => PACKAGE.test(p)).join(' ')}`

/**
 * Undo's, for the board's own Chromium's libraries: marked as installed for another package's
 * sake (apt-mark auto), so `apt autoremove` takes them once nothing needs them, as it does a
 * removed package's; never purged, which would take with them what has come to need them since.
 */
export const desktopLibsUndoScript = (libs: readonly string[]): string =>
  `for p in ${libs.filter(p => PACKAGE.test(p)).join(' ')}; do dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' && apt-mark auto "$p" >/dev/null; done; true`

/** The install's own part of the plan, before the web server's (path A prints it, path B's panel shows it). */
export interface InstallFacts {
  user: string
  /** The user is there, made by the installer before. */
  userThere: boolean
  /** It has sudo from the installer now. */
  sudoThere: boolean
  sudo: boolean
  source: Source
  /** Whose ssh keys the user gets (none: no keys to copy, or it has its own). */
  keysFrom: string | null
  /** The packages the agents' browsers need that are not there yet (core/desktop.ts); absent: none. */
  desktop?: readonly string[]
  /** The board's own Chromium goes in place as the user (Ubuntu's arm64, core/desktop.ts). */
  chromium?: boolean
}

/** The install's own steps in plain words, in `tr`'s language. */
export function installWill(f: InstallFacts, tr: Translator = t): string[] {
  const user = { user: f.user }
  const will: string[] = []
  if (!f.userThere) will.push(tr(f.sudo ? 'install.will.userSudo' : 'install.will.user', user))
  else if (f.sudo && !f.sudoThere) will.push(tr('install.will.sudoOn', user))
  else if (!f.sudo && f.sudoThere) will.push(tr('install.will.sudoOff', user))
  if (f.keysFrom) will.push(tr('install.will.keys', { ...user, from: f.keysFrom }))
  will.push(tr('install.will.tools', { ...user, bun: BUN_VERSION }))
  will.push(tr('install.will.board', { from: sourceLine(f.source, tr) }))
  will.push(tr('install.will.key', user))
  will.push(tr('install.will.service', user))
  if (f.desktop?.length) will.push(tr('install.will.desktop', { packages: f.desktop.join(', ') }))
  if (f.chromium) will.push(tr('install.will.chromium', { ...user, version: PLAYWRIGHT_VERSION }))
  return will
}

/** What `board update` does for a source and a --ref (call 10): the ref to fetch, or why it will not. */
export function updateRef(s: Source | null, ref: string | null): { ref: string; repo: string } | { error: string } {
  if (ref !== null && !REF.test(ref)) return { error: t('update.badRef') }
  if (!s) return { error: t('update.notServer') }
  if (s.kind === 'archive')
    return ref === null ? { error: t('update.archive', { commit: s.commit.slice(0, 7) }) } : { ref, repo: REPO }
  return { ref: ref ?? s.ref, repo: s.repo }
}

/**
 * Path B's command on the server, as root (the admin's sudo): the pack read from stdin (base64,
 * after sudo's password when sudo asks one) into a folder of root's own, unpacked, and its
 * bootstrap run with it, without a question (the panel asked). The folder goes when it ends.
 */
export function receiverScript(o: { domain: string; lang: Lang }): string {
  if (fieldProblem('domain', o.domain) || o.domain === '') throw new Error(t('tunnel.err.domain'))
  return [
    '# agent-board: install',
    'set -u',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'd=$(mktemp -d /tmp/agent-board-install.XXXXXXXX) || exit 1',
    `trap 'rm -rf "$d"' EXIT`,
    "trap 'exit 1' HUP INT TERM",
    `base64 -d > "$d/pack.tar.gz" || { echo 'agent-board: the board’s code did not arrive whole.'; exit 1; }`,
    `mkdir "$d/src" && tar -xzf "$d/pack.tar.gz" -C "$d/src" || { echo 'agent-board: the board’s code could not be unpacked.'; exit 1; }`,
    `sh "$d/src/${BOOTSTRAP}" --archive "$d/pack.tar.gz" --domain ${o.domain} --lang ${o.lang} --yes </dev/null`,
  ].join('\n')
}

/**
 * The setup link in a line of the install's output (path B): the panel keeps it apart, in memory
 * only. Any line with a code in it is taken (its URL, or '' for one that is not the link), so none
 * reaches the output the panel keeps.
 */
export function setupLinkIn(line: string): string | null {
  if (!line.includes('#code=')) return null
  return /(https:\/\/[^\s/]+\/setup#code=\S+)/.exec(line)?.[1] ?? ''
}
