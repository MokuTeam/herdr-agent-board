// The board's install on a server of the owner's, as root (the board-on-own-server spec's "The
// install script", calls 2-4 and 10-15): what server-install.sh hands over to, for path A in a
// terminal and path B from the local board's panel (its output streamed there). It looks first
// and changes nothing before a yes: the server, the board's user, and the web server through the
// tunnel setup's own Look, plan and run with the server mode's socket as their target
// (core/server-plan.ts `server`), run here as they run over ssh; then the plan in plain words and
// one question on the terminal (--yes: path B, where the panel asked). Then: the user (marked,
// lingering, sudo only with --sudo), as that user Bun, herdr and Claude Code from their own
// installers, the board's code (git at a ref, or path B's pack), herdr's plugin link and the
// board's install action, the server mode in its config, the web server's run (rolled back on a
// failure, recorded), herdr's systemd user service, and the setup link once. Safe to run again:
// what is there is kept; it then updates. Undo takes back the service, lingering, sudo, the web
// server from root's record, and the user only when asked.
//
// Nothing root runs here is the board's user's to change: root's Bun and copy of the board are
// root's own (core/server-install.ts INSTALL_HOME); the user's are run only as the user, in a
// session of its own (no terminal of root's to type into), and what goes into the user's home
// (its ssh keys, herdr's service) is written by the user, never by root through a link it made.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { ROOT } from '../adapters/paths.ts'
import { CHROME_BINS, CHROME_PACKAGE, CHROMIUM_PACKAGE, DESKTOP_PACKAGES } from '../core/desktop.ts'
import { t } from '../core/lang.ts'
import type { ServerFacts } from '../core/server-facts.ts'
import {
  ARCHIVE_MARK,
  archiveMark,
  BOARD_SOCKET,
  BOARD_USER_COMMENT,
  BUN_VERSION,
  CHECKOUT,
  desktopRemoveScript,
  desktopScript,
  INSTALL_RECORD,
  type InstallFacts,
  type InstallFlags,
  installRecord,
  installWill,
  SERVICE,
  type Source,
  serverWanted,
  serviceUnit,
  sourceLine,
  sudoersFile,
} from '../core/server-install.ts'
import { lookScript1, lookScript2, readRoundOne, readServerFacts, SUPPORTED } from '../core/server-look.ts'
import { plainPlan } from '../core/server-plain.ts'
import { buildPlan, type Plan, setupRecord, undoPlan, type Wanted, whose } from '../core/server-plan.ts'
import { launchScript, type Progress, readProgress, runScript, startProgress } from '../core/server-script.ts'
import { shQuote } from '../core/server-shell.ts'
import { type Acme, SERVER_NAMES } from '../core/server-texts.ts'
import { keyAdded } from '../core/setup.ts'
import { socketFolder } from '../core/tunnel-snippets.ts'

/** What the install says, line by line (a terminal, or ssh's stdout for the panel). */
export interface Io {
  say(...lines: string[]): void
  /** The one question, on the terminal: null when there is none to ask on. */
  ask(question: string): Promise<boolean | null>
}

interface Ran {
  code: number
  out: string
  err: string
}

/** The board's user as the server has it. */
interface User {
  name: string
  uid: number
  gid: number
  home: string
  comment: string
}

/** How often a download (an installer, the board's code, its packages) is tried: the internet fails now and then. */
const TRIES = Math.max(1, Math.min(50, Number(process.env.BOARD_INSTALL_TRIES) || 3))
/** What a server behind a proxy needs the user's downloads to have too. */
const PROXIES = ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
const PACK = (text: string): string => gzipSync(text).toString('base64')
const ARCHES = ['x86_64', 'aarch64']
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const lastLines = (text: string, n = 8): string =>
  text
    .split('\n')
    .map(l => l.replace(ANSI, '').trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n')

/** A program, no shell; its output whole. */
async function run(
  argv: string[],
  o: { stdin?: Blob | string; env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    stdin: o.stdin === undefined ? 'ignore' : typeof o.stdin === 'string' ? new TextEncoder().encode(o.stdin) : o.stdin,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(o.env && { env: o.env }),
    ...(o.cwd && { cwd: o.cwd }),
  })
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 30 * 60_000)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, out, err }
}

/** A script as root. */
const sh = (script: string, o: Parameters<typeof run>[1] = {}): Promise<Ran> => run(['sh', '-c', script], o)

/** The user's own environment, nothing of root's but a proxy. */
function userEnv(u: Pick<User, 'name' | 'uid' | 'home'>): string[] {
  const env: Record<string, string> = {
    HOME: u.home,
    USER: u.name,
    LOGNAME: u.name,
    SHELL: '/bin/bash',
    PATH: `${u.home}/.local/bin:${u.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_RUNTIME_DIR: `/run/user/${u.uid}`,
    LANG: 'C.UTF-8',
  }
  for (const p of PROXIES) if (process.env[p]) env[p] = process.env[p] as string
  return Object.entries(env).map(([k, v]) => `${k}=${v}`)
}

/**
 * A script as the board's user, in a session of its own (setsid -w: no controlling terminal, so
 * nothing it runs can open root's terminal and type into it, TIOCSTI); runuser: no password; the
 * user's own environment.
 */
export const userArgv = (u: Pick<User, 'name' | 'uid' | 'home'>, script: string): string[] => [
  'setsid',
  '-w',
  'runuser',
  '-u',
  u.name,
  '--',
  'env',
  '-i',
  ...userEnv(u),
  'sh',
  '-c',
  script,
]

/** A script as the board's user (userArgv), in its home. */
const asUser = (u: User, script: string, o: Parameters<typeof run>[1] = {}): Promise<Ran> =>
  run(userArgv(u, script), { cwd: u.home, ...o })

/** A file into the user's home as the user (its text on stdin): written whole beside it, then moved in place, `mode`. */
export const userFileScript = (path: string, mode: '600' | '644'): string => {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const part = `${path}.agent-board-new`
  return `set -e; umask 077; mkdir -p ${shQuote(dir)}; rm -f ${shQuote(part)}; cat > ${shQuote(part)}; chmod ${mode} ${shQuote(part)}; mv -f ${shQuote(part)} ${shQuote(path)}`
}

/** A file in the user's home read as the user before it is written whole: empty when not there, a failure when there but not read. */
export const userReadScript = (path: string): string =>
  `if [ -e ${shQuote(path)} ] || [ -L ${shQuote(path)} ]; then cat -- ${shQuote(path)}; fi`

/** The admin's keys as the user's own: ~/.ssh 0700, authorized_keys 0600. */
export const keysScript = (home: string): string =>
  `mkdir -p ${shQuote(`${home}/.ssh`)} && chmod 700 ${shQuote(`${home}/.ssh`)} && { ${userFileScript(`${home}/.ssh/authorized_keys`, '600')}; }`

/** Tries a run up to TRIES times while it fails. */
async function tried(fn: () => Promise<Ran>): Promise<Ran> {
  let r: Ran = { code: 1, out: '', err: '' }
  for (let i = 0; i < TRIES; i++) {
    r = await fn()
    if (r.code === 0) return r
    await Bun.sleep(2000)
  }
  return r
}

/** A download to a file, tried again on a failure (the official installers are fetched so, then run). */
const FETCH = `fetch() { curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 "$1" -o "$2"; }`

/** An official installer: fetched, then run with its arguments, in a folder of its own that goes after. */
const installer = (url: string, shell: 'sh' | 'bash', args: string): string =>
  `${FETCH}; d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && fetch ${shQuote(url)} "$d/install" && ${shQuote(shell)} "$d/install" ${args}`

/**
 * herdr: its installer; where that fails (it reads herdr.dev's manifest within 20 seconds, which a
 * slow link does not make), herdr's own release from GitHub, as its manual install has it: the
 * latest binary for this machine into ~/.local/bin.
 */
const HERDR = `( ${installer('https://herdr.dev/install.sh', 'sh', '')} ) || { ${FETCH}; case $(uname -m) in aarch64 | arm64) a=aarch64 ;; *) a=x86_64 ;; esac; mkdir -p "$HOME/.local/bin" && fetch "https://github.com/herdrdev/herdr/releases/latest/download/herdr-linux-$a" "$HOME/.local/bin/herdr.part" && chmod 755 "$HOME/.local/bin/herdr.part" && mv -f "$HOME/.local/bin/herdr.part" "$HOME/.local/bin/herdr"; }`

async function userOf(name: string): Promise<User | null> {
  const r = await run(['getent', 'passwd', name])
  if (r.code !== 0) return null
  const [, , uid, gid, comment, home] = r.out.trim().split(':')
  return { name, uid: Number(uid), gid: Number(gid), home: home ?? '', comment: comment ?? '' }
}

/** "1.4.3" ≥ "1.4.2": numeric parts compared in order. */
export function atLeast(version: string, min: string): boolean {
  const a = version.split(/[.-]/).map(Number)
  const b = min.split(/[.-]/).map(Number)
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (Number.isNaN(x)) return false
    if (x !== y) return x > y
  }
  return true
}

const versionIn = (text: string): string => /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? ''

/** The server's system: one the board installs on (Debian 12/13, Ubuntu 22.04 to 26.04, systemd, x86_64 or arm64). */
function systemOk(): boolean {
  let os = ''
  try {
    os = readFileSync('/etc/os-release', 'utf8')
  } catch {
    return false
  }
  const field = (k: string): string => new RegExp(`^${k}="?([^"\\n]*)"?$`, 'm').exec(os)?.[1] ?? ''
  const id = field('ID') as keyof typeof SUPPORTED
  const ok = SUPPORTED[id]?.includes(field('VERSION_ID')) ?? false
  return ok && existsSync('/run/systemd/system') && ARCHES.includes(process.arch === 'arm64' ? 'aarch64' : 'x86_64')
}

/** A test CA for the board's own Caddy (BOARD_SETUP_ACME_CA and BOARD_SETUP_ACME_CA_ROOT), as the panel's. */
function acme(): Acme | undefined {
  const ca = process.env.BOARD_SETUP_ACME_CA
  const root = process.env.BOARD_SETUP_ACME_CA_ROOT
  return ca && root ? { ca, root } : undefined
}

const newId = (): string =>
  `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${Math.random().toString(16).slice(2, 6)}`

// ---------------------------------------------------------------------------------------------
// The web server: the tunnel setup's Look, plan and run, here

/** Look's two rounds, run as root on this server, read as the panel reads them over ssh. */
async function lookHere(w: Wanted): Promise<ServerFacts> {
  const input = { user: w.user, socket: w.socket, domain: w.domain, server: true as const }
  const one = await sh(lookScript1(input), { timeoutMs: 120_000 })
  const r1 = readRoundOne(one.out)
  if (!r1) throw new Error('Look could not read this server')
  const script2 = lookScript2(r1, input)
  const two = script2 ? (await sh(script2, { timeoutMs: 120_000 })).out : ''
  const f = readServerFacts(r1, two)
  if (!f) throw new Error('Look could not read this server')
  return f
}

/** A plan's run through its launch, as root here, each step said as it ends; true when it applied. */
async function runHere(io: Io, p: Plan, w: Wanted): Promise<boolean> {
  const runId = newId()
  const launch = launchScript(runId, runScript(p, w, { id: runId, at: new Date().toISOString() }), PACK, SERVER_NAMES)
  const proc = Bun.spawn(['sh', '-c', launch], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let pr: Progress = startProgress(p)
  const title = (n: number): string => {
    const s = p.steps[n - 1]
    return s ? t(s.title.key, s.title.params) : String(n)
  }
  const decoder = new TextDecoder()
  let rest = ''
  const said = new Set<number>()
  const line = (text: string): void => {
    pr = readProgress(pr, text, Date.now())
    for (const s of pr.steps) {
      if (said.has(s.n) || (s.state !== 'ok' && s.state !== 'fail')) continue
      said.add(s.n)
      io.say(t('install.web.step', { mark: s.state === 'ok' ? '✓' : '✗', title: title(s.n) }))
      if (s.state === 'fail') for (const l of s.out.slice(-8)) io.say(`      ${l}`)
    }
  }
  for await (const chunk of proc.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
    rest = lines.pop() ?? ''
    for (const l of lines) line(l)
  }
  if (rest) line(rest)
  await proc.exited
  if (pr.result === 'applied') return true
  io.say(
    t(
      pr.result === 'rollback-failed'
        ? 'server.oneshot.rollbackFailed'
        : pr.result === 'busy'
          ? 'server.oneshot.busy'
          : pr.result === 'changed'
            ? 'server.oneshot.changed'
            : pr.result === 'rolled-back'
              ? 'server.oneshot.rolledBack'
              : 'server.oneshot.lost',
    ),
  )
  return false
}

/** The plan in plain words, as the one command says it: what was found, what will be done, notes. */
function sayPlan(io: Io, found: string, will: string[], untouched: string, notes: string[]): void {
  io.say('', t('install.found'), `  ${found}`, '', t('install.plan'))
  for (const l of will) io.say(`  - ${l}`)
  if (untouched) io.say(`  ${untouched}`)
  if (notes.length) {
    io.say('', t('install.notes'))
    for (const n of notes) io.say(`  - ${n}`)
  }
  io.say('', t('install.unchanged'))
}

/** Asked once (path B: --yes, the panel asked); false stops with nothing changed. */
async function goAhead(io: Io, yes: boolean): Promise<boolean> {
  if (yes) return true
  const a = await io.ask(t('install.ask'))
  if (a === null) io.say('', t('install.noTerminal'))
  else if (!a) io.say('', t('install.no'))
  return a === true
}

// ---------------------------------------------------------------------------------------------
// The install

/** Whether a package is installed (dpkg). */
const installed = async (pkg: string): Promise<boolean> =>
  (await run(['dpkg-query', '-W', `-f=\${Status}`, pkg])).out.includes('install ok installed')

/**
 * The agents' browsers' packages not there yet (core/desktop.ts): Xvnc and the fonts, and a
 * browser where none is: Google Chrome on x86_64, Debian's Chromium on arm64 (none on Ubuntu's
 * arm64, whose Chromium is a snap: a gap, said by `board doctor`).
 */
async function desktopMissing(): Promise<string[]> {
  const missing: string[] = []
  for (const p of DESKTOP_PACKAGES) if (!(await installed(p))) missing.push(p)
  const PATH = '/usr/local/bin:/usr/bin:/bin:/opt/google/chrome'
  if (!CHROME_BINS.some(b => Bun.which(b, { PATH }))) {
    if (process.arch === 'x64') missing.push(CHROME_PACKAGE)
    else if (/^ID=debian$/m.test(readFileSync('/etc/os-release', 'utf8'))) missing.push(CHROMIUM_PACKAGE)
  }
  return missing
}

/** Where the board's code comes from: root's copy (path A's git, or path B's pack and its mark). */
async function sourceHere(f: InstallFlags): Promise<Source> {
  if (f.archive) {
    let mark: unknown = null
    try {
      mark = JSON.parse(readFileSync(`${ROOT}/${ARCHIVE_MARK}`, 'utf8'))
    } catch {}
    const m = archiveMark(mark)
    if (!m) throw new Error(`the pack has no ${ARCHIVE_MARK}`)
    return { kind: 'archive', ...m }
  }
  const head = await run(['git', '-C', ROOT, 'rev-parse', 'HEAD'])
  const commit = head.out.trim()
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`no commit in ${ROOT}`)
  return { kind: 'git', repo: f.repo, ref: f.ref, commit }
}

/** The admin's ssh keys, which the board's user gets when it has none (ssh <user>@server, call 13's "working with herdr directly"). */
function adminKeys(): { from: string; file: string } | null {
  const sudoUser = process.env.SUDO_USER
  const candidates: { from: string; file: string }[] = []
  if (sudoUser && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(sudoUser) && sudoUser !== 'root') {
    const entry = readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find(l => l.startsWith(`${sudoUser}:`))
    const home = entry?.split(':')[5]
    if (home) candidates.push({ from: sudoUser, file: `${home}/.ssh/authorized_keys` })
  }
  candidates.push({ from: 'root', file: '/root/.ssh/authorized_keys' })
  for (const c of candidates) {
    try {
      if (readFileSync(c.file, 'utf8').trim()) return c
    } catch {}
  }
  return null
}

/** The setup link (calls 9 and 12): `board login link` as the user; printed once, nowhere else. */
async function setupLink(io: Io, u: User, domain: string): Promise<void> {
  const r = await asUser(u, `${shQuote(`${u.home}/.local/bin/board`)} login link`, { timeoutMs: 60_000 })
  if (r.code === 0 && r.out.trim().startsWith('https://')) {
    io.say('', t('install.link'), '', `  ${r.out.trim().split('\n')[0]}`, '')
    return
  }
  if (r.code === 3) {
    io.say('', t('install.linkSet', { domain, user: u.name }))
    return
  }
  io.say('', t('install.linkFailed', { user: u.name, why: lastLines(r.err || r.out, 1) || `exit ${r.code}` }))
}

/** A step of the install's own: said when done; its failure stops the install with the last lines it printed. */
async function step(io: Io, what: string, fn: () => Promise<Ran | string | undefined>): Promise<boolean> {
  try {
    const r = await fn()
    if (r && typeof r === 'object' && r.code !== 0) {
      io.say(t('install.failed', { what }))
      const tail = lastLines(`${r.out}\n${r.err}`)
      if (tail) io.say(...tail.split('\n').map(l => `    ${l}`))
      return false
    }
    io.say(t('install.step', { what: typeof r === 'string' ? r : what }))
    return true
  } catch (err) {
    io.say(t('install.failed', { what }), `    ${messageOf(err)}`)
    return false
  }
}

/** The service's user manager is there (lingering started it): its control socket. */
async function managerUp(u: User): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(`/run/user/${u.uid}/systemd/private`)) return true
    await Bun.sleep(300)
  }
  return false
}

const systemctl = (u: User, args: string): Promise<Ran> => asUser(u, `systemctl --user ${args}`, { timeoutMs: 120_000 })

/** The pack's files as the user, into its checkout: what changed written over in place (the running board's watcher sees it), what is gone removed. */
export const syncInto = (from: string, to: string): string =>
  [
    `mkdir -p ${shQuote(to)}`,
    `(cd ${shQuote(to)} && find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print) | while IFS= read -r f; do [ -e ${shQuote(from)}/"$f" ] || rm -f ${shQuote(to)}/"$f"; done`,
    `cp -a ${shQuote(from)}/. ${shQuote(to)}/`,
  ].join(' && ')

/** The board's code at the source, as the user, in its checkout. */
function boardCode(u: User, s: Source, archive: string | null, dir: string): Promise<Ran> {
  const d = shQuote(dir)
  const dirty = `if [ -d ${d}/.git ] && [ -n "$(git -C ${d} status --porcelain --untracked-files=no 2>/dev/null)" ]; then echo ${shQuote(t('update.changes', { dir }))}; exit 1; fi`
  if (s.kind === 'archive' && archive) {
    const tmp = shQuote(`${dir}.new`)
    return asUser(
      u,
      `set -e; ${dirty}; rm -rf ${tmp}; mkdir -p ${tmp}; tar -xzf - -C ${tmp}; rm -f ${tmp}/${ARCHIVE_MARK}; [ ! -d ${d}/.git ] || rm -rf ${d}/.git; ${syncInto(`${dir}.new`, dir)}; rm -rf ${tmp}`,
      { stdin: Bun.file(archive) },
    )
  }
  if (s.kind !== 'git') throw new Error('no pack to install from')
  const repo = shQuote(s.repo)
  const ref = shQuote(s.ref)
  const fresh = `rm -rf ${shQuote(`${dir}.new`)} && git init -q ${shQuote(`${dir}.new`)} && git -C ${shQuote(`${dir}.new`)} remote add origin ${repo} && git -C ${shQuote(`${dir}.new`)} fetch -q --depth 1 origin ${ref} && git -C ${shQuote(`${dir}.new`)} checkout -q --detach FETCH_HEAD && ${syncInto(`${dir}.new`, dir)} && rm -rf ${shQuote(`${dir}.new`)}`
  const update = `git -C ${d} remote set-url origin ${repo} && git -C ${d} fetch -q --depth 1 origin ${ref} && git -C ${d} checkout -q --detach FETCH_HEAD`
  return tried(() =>
    asUser(u, `set -e; ${dirty}; if [ -d ${d}/.git ]; then ${update}; else ${fresh}; fi`, { timeoutMs: 600_000 }),
  )
}

export async function install(f: InstallFlags, io: Io): Promise<number> {
  if (process.getuid?.() !== 0) {
    io.say(t('install.stop.root'))
    return 1
  }
  if (!systemOk()) {
    io.say(t('install.stop.os'))
    return 1
  }
  const domain = f.domain
  if (!domain) {
    io.say(t('install.stop.domain'))
    return 1
  }
  io.say(t('install.looking'))
  // what is there: the installer's record, the user, its sudo and keys
  let record = null
  try {
    record = installRecord(JSON.parse(readFileSync(INSTALL_RECORD, 'utf8')))
  } catch {}
  if (record && record.user !== f.user) {
    io.say(t('install.stop.otherUser', { other: record.user }))
    return 1
  }
  const there = await userOf(f.user)
  if (there && there.comment !== BOARD_USER_COMMENT) {
    io.say(t('install.stop.userTaken', { user: f.user }))
    return 1
  }
  const keys = there && existsSync(`${there.home}/.ssh/authorized_keys`) ? null : adminKeys()
  let source: Source
  try {
    source = await sourceHere(f)
  } catch (err) {
    io.say(t('install.failed', { what: 'the board’s code' }), `    ${messageOf(err)}`)
    return 1
  }
  const facts: InstallFacts = {
    user: f.user,
    userThere: there !== null,
    sudoThere: existsSync(sudoersFile(f.user)),
    sudo: f.sudo,
    source,
    keysFrom: keys?.from ?? null,
    desktop: await desktopMissing(),
  }
  // the web server's plan, the tunnel setup's, with the board's socket as its target
  const a = acme()
  const w: Wanted = { ...serverWanted(domain, f.user), ...(a && { acme: a }) }
  let sf: ServerFacts
  try {
    sf = await lookHere(w)
  } catch (err) {
    io.say(messageOf(err))
    return 1
  }
  const made = buildPlan(sf, w, { id: newId(), docker: true })
  const plain = plainPlan(sf, made, w, t)
  if (!('steps' in made) || made.kind === 'undo') {
    io.say('', t('install.found'), `  ${plain.found}`, '')
    io.say('steps' in made ? t('install.stop.interrupted') : (plain.stop ?? ''), t('install.no'))
    return 1
  }
  const will = [...installWill(facts), ...plain.will, ...(plain.docker ? [plain.docker] : [])]
  const notes = made.warnings.map(x => t(x.key, x.params))
  sayPlan(io, plain.found, will, plain.untouched, notes)
  if (!(await goAhead(io, f.yes))) return 1
  io.say('')

  // the user, marked as the installer's (call 12), with no password of its own; its services
  // start with the server (lingering)
  let u = there
  if (!u) {
    const ok = await step(io, t('install.step.user', { user: f.user }), () =>
      sh(
        `useradd --create-home --shell /bin/bash --comment ${shQuote(BOARD_USER_COMMENT)} ${shQuote(f.user)} && usermod -p '*' ${shQuote(f.user)}`,
      ),
    )
    if (!ok) return 1
    u = await userOf(f.user)
    if (!u) return 1
  }
  const user = u
  if (
    !(await step(io, t('install.step.linger', { user: user.name }), async () => {
      const r = await run(['loginctl', 'enable-linger', user.name])
      if (r.code !== 0) return r
      if (!(await managerUp(user))) throw new Error(`no systemd user manager for ${user.name}`)
      return undefined
    }))
  )
    return 1
  // sudo only with --sudo (call 4); without it, the installer's sudo of an earlier run goes
  const sudoers = sudoersFile(user.name)
  if (f.sudo !== facts.sudoThere) {
    const ok = await step(io, t('install.step.sudo', { user: user.name }), () =>
      f.sudo
        ? sh(
            `printf '%s\\n' ${shQuote(`${user.name} ALL=(ALL:ALL) NOPASSWD: ALL`)} > ${sudoers}.new && chmod 440 ${sudoers}.new && { ! command -v visudo >/dev/null || visudo -cqf ${sudoers}.new; } && mv -f ${sudoers}.new ${sudoers}`,
          )
        : sh(`rm -f ${sudoers}`),
    )
    if (!ok) return 1
  }
  if (keys) {
    // read by root (the admin's own file), written by the user: root never writes into its home
    const ok = await step(io, t('install.step.keys', { user: user.name }), () =>
      asUser(user, keysScript(user.home), { stdin: readFileSync(keys.file, 'utf8'), timeoutMs: 60_000 }),
    )
    if (!ok) return 1
  }

  // the agents' browsers (core/desktop.ts): their packages as root; the board goes on without them
  const desktopAdded: string[] = [...(record?.desktop ?? [])]
  const toAdd = facts.desktop ?? []
  if (toAdd.length) {
    await step(io, t('install.step.desktop', { packages: toAdd.join(', ') }), () =>
      tried(() => sh(desktopScript(toAdd), { timeoutMs: 30 * 60_000 })),
    )
    for (const p of toAdd) if (!desktopAdded.includes(p) && (await installed(p))) desktopAdded.push(p)
  }

  // as the user: Bun (pinned), herdr and Claude Code from their own installers; what is there stays
  const home = user.home
  const bun = `${home}/.bun/bin/bun`
  const have = async (bin: string): Promise<string> => {
    const r = await asUser(user, `${shQuote(bin)} --version 2>/dev/null`, { timeoutMs: 60_000 })
    return r.code === 0 ? versionIn(r.out) : ''
  }
  const tool = async (bin: string, key: string, need: (v: string) => boolean, script: string): Promise<boolean> =>
    step(io, t(key, { version: '' }).trim(), async () => {
      let v = await have(bin)
      if (!v || !need(v)) {
        const r = await tried(() => asUser(user, script, { timeoutMs: 15 * 60_000 }))
        if (r.code !== 0) return r
        v = await have(bin)
        if (!v) throw new Error(`${bin} is not there after its installer`)
      }
      return t(key, { version: v })
    })
  if (
    !(await tool(
      bun,
      'install.step.bun',
      v => atLeast(v, BUN_VERSION),
      installer('https://bun.sh/install', 'bash', `bun-v${BUN_VERSION}`),
    ))
  )
    return 1
  const minHerdr =
    /^min_herdr_version\s*=\s*"([^"]+)"/m.exec(readFileSync(`${ROOT}/herdr-plugin.toml`, 'utf8'))?.[1] ?? '0'
  if (!(await tool(`${home}/.local/bin/herdr`, 'install.step.herdr', v => atLeast(v, minHerdr), HERDR))) return 1
  if (
    !(await tool(
      `${home}/.local/bin/claude`,
      'install.step.claude',
      () => true,
      installer('https://claude.ai/install.sh', 'bash', 'stable'),
    ))
  )
    return 1

  // the board: its code, its packages, herdr's plugin, its install action, its server mode
  const dir = `${home}/${CHECKOUT}`
  const d = shQuote(dir)
  if (
    !(await step(io, t('install.step.board', { from: sourceLine(source) }), () =>
      boardCode(user, source, f.archive, dir),
    ))
  )
    return 1
  if (source.kind === 'git') {
    // the commit the user's checkout is at (the ref may have moved since root's copy was fetched)
    const at = (await asUser(user, `git -C ${d} rev-parse HEAD`)).out.trim()
    if (/^[0-9a-f]{40}$/.test(at)) source = { ...source, commit: at }
  }
  if (
    !(await step(io, t('install.step.deps'), () =>
      tried(() => asUser(user, `cd ${d} && ${shQuote(bun)} install --production`, { timeoutMs: 600_000 })),
    ))
  )
    return 1
  const herdr = shQuote(`${home}/.local/bin/herdr`)
  if (
    !(await step(io, t('install.step.link'), async () => {
      const list = await asUser(user, `${herdr} plugin list 2>/dev/null`)
      if (!list.out.includes(dir)) {
        const r = await asUser(user, `${herdr} plugin link ${d}`)
        if (r.code !== 0) return r
      }
      return asUser(user, `cd ${d} && ${shQuote(bun)} src/entrypoints/install.ts`, { timeoutMs: 300_000 })
    }))
  )
    return 1
  const mode = JSON.stringify({ domain, socket: BOARD_SOCKET })
  if (
    !(await step(io, t('install.step.config', { domain }), () =>
      asUser(
        user,
        `cd ${d} && ${shQuote(bun)} src/entrypoints/server-install.ts --user-part on ${shQuote(mode)} ${shQuote(JSON.stringify(source))}`,
      ),
    ))
  )
    return 1

  // herdr's key for the board, as the user, only where none is bound to it (nobody has pasted the
  // snippet into this herdr's config by hand): read, then written whole with the key after it; a
  // config there but not read fails the step, so nothing is written over what was not read
  const herdrConfig = `${home}/.config/herdr/config.toml`
  let keyNew = false
  if (
    !(await step(io, t('install.step.key', { key: 'prefix+a' }), async () => {
      const now = await asUser(user, userReadScript(herdrConfig))
      if (now.code !== 0) return now
      const next = keyAdded(now.out)
      if (next === null) return t('install.step.key', { key: t('install.key.kept') })
      keyNew = true
      return asUser(user, userFileScript(herdrConfig, '644'), { stdin: next })
    }))
  )
    return 1

  // the web server, as the tunnel's setup does it (its own record, lock, rollback and checks)
  io.say('', t('install.web'))
  if (!(await runHere(io, made, w))) return 1
  io.say('')

  // herdr's service: written, enabled, started (a running one is left running: its sessions go on)
  const unitDir = `${home}/.config/systemd/user`
  const unit = serviceUnit(home)
  if (
    !(await step(io, t('install.step.service'), async () => {
      const old = await asUser(user, `cat ${shQuote(`${unitDir}/${SERVICE}`)} 2>/dev/null`)
      const changed = old.out !== unit
      if (changed) {
        const w2 = await asUser(user, userFileScript(`${unitDir}/${SERVICE}`, '644'), { stdin: unit })
        if (w2.code !== 0) return w2
        const r = await systemctl(user, 'daemon-reload')
        if (r.code !== 0) return r
      }
      const en = await systemctl(user, `enable ${SERVICE}`)
      if (en.code !== 0) return en
      return systemctl(user, `${changed && old.out ? 'restart' : 'start'} ${SERVICE}`)
    }))
  )
    return 1
  // a herdr that ran already reads the key now; one that just started read it as it started
  if (keyNew) await asUser(user, `${herdr} server reload-config`, { timeoutMs: 60_000 })
  // the board's listener: the board makes its socket once herdr has opened it
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    up = (await sh(`test -S ${shQuote(BOARD_SOCKET)}`)).code === 0
    if (!up) await Bun.sleep(1000)
  }
  if (up) io.say(t('install.step', { what: t('install.step.listener') }))
  else io.say(t('install.listenerLate', { socket: BOARD_SOCKET, user: user.name }))

  writeFileSync(
    INSTALL_RECORD,
    `${JSON.stringify({ v: 1, user: user.name, home, domain, socket: BOARD_SOCKET, source, sudo: f.sudo, at: new Date().toISOString(), ...(desktopAdded.length && { desktop: desktopAdded }) })}\n`,
    { mode: 0o600 },
  )
  io.say('', t('install.done', { domain }))
  await setupLink(io, user, domain)
  io.say(t('install.after', { user: user.name }))
  return 0
}

// ---------------------------------------------------------------------------------------------
// Undo

export async function undo(f: InstallFlags, io: Io): Promise<number> {
  if (process.getuid?.() !== 0) {
    io.say(t('install.stop.root'))
    return 1
  }
  io.say(t('install.looking'))
  let record = null
  try {
    record = installRecord(JSON.parse(readFileSync(INSTALL_RECORD, 'utf8')))
  } catch {}
  const name = record?.user ?? f.user
  const u = await userOf(name)
  const ours = u?.comment === BOARD_USER_COMMENT
  // the web server's record, when it is the server mode's of this user
  let setup = null
  try {
    setup = setupRecord(JSON.parse(readFileSync(SERVER_NAMES.record, 'utf8')))
  } catch {}
  const domain = setup?.domain ?? record?.domain ?? null
  const w = domain ? serverWanted(domain, name) : null
  let web: { plan: Plan; facts: ServerFacts } | null = null
  if (setup && w && whose(setup, w) !== 'other') {
    try {
      const facts = await lookHere(w)
      const r = facts.record ? setupRecord(facts.record) : null
      if (r && whose(r, w) !== 'other')
        web = { plan: undoPlan(r, facts, { id: newId(), removeDocker: false, removeEdited: false }), facts }
    } catch (err) {
      io.say(messageOf(err))
      return 1
    }
  }
  const sudoers = sudoersFile(name)
  const sudo = existsSync(sudoers)
  const service = u ? `${u.home}/.config/systemd/user/${SERVICE}` : null
  const serviceThere = service !== null && existsSync(service)
  if (!record && !web && !serviceThere && !sudo && !(f.removeUser && ours)) {
    io.say(t('install.undo.nothing'))
    return 0
  }
  const will: string[] = []
  if (u) will.push(t('install.undo.will.service', { user: name }))
  if (sudo) will.push(t('install.undo.will.sudo', { user: name }))
  let found = ''
  let untouched = ''
  if (web && w) {
    const plain = plainPlan(web.facts, web.plan, w, t)
    found = plain.found
    will.push(...plain.will)
    untouched = plain.untouched
  } else will.push(t('install.undo.will.webNone'))
  // the agents' browsers' packages the install added: only with the user, as its Bun and herdr
  const packages = f.removeUser && ours ? (record?.desktop ?? []) : []
  if (packages.length) will.push(t('install.undo.will.desktop', { packages: packages.join(', ') }))
  if (u && f.removeUser && ours) will.push(t('install.undo.will.user', { user: name, home: u.home }))
  else if (u && ours) will.push(t('install.undo.will.keepUser', { user: name }))
  else if (u && f.removeUser) will.push(t('install.undo.userKept', { user: name }))
  sayPlan(io, found || '-', will, untouched, web ? web.plan.warnings.map(x => t(x.key, x.params)) : [])
  if (!(await goAhead(io, f.yes))) return 1
  io.say('')

  if (u && (await managerUp(u))) {
    const ok = await step(io, t('install.undo.will.service', { user: name }), async () => {
      await systemctl(u, `disable --now ${SERVICE}`)
      // the user's own file, taken away by the user: root follows no link it may have made there
      if (service) await asUser(u, `rm -f ${shQuote(service)}`)
      return systemctl(u, 'daemon-reload')
    })
    if (!ok) return 1
  }
  if (web && w) {
    io.say('', t('install.web'))
    if (!(await runHere(io, web.plan, w))) return 1
    io.say('')
  }
  if (u) {
    await run(['loginctl', 'disable-linger', name])
    if (!f.removeUser || !ours) {
      // the board on this user back to a PC's: no server mode
      const dir = `${u.home}/${CHECKOUT}`
      const bun = `${u.home}/.bun/bin/bun`
      if (existsSync(`${dir}/src/entrypoints/server-install.ts`) && existsSync(bun))
        await asUser(u, `cd ${shQuote(dir)} && ${shQuote(bun)} src/entrypoints/server-install.ts --user-part off`)
    }
  }
  if (sudo) await sh(`rm -f ${sudoers}`)
  if (u && f.removeUser && ours) {
    const ok = await step(io, t('install.undo.will.user', { user: name, home: u.home }), () =>
      sh(
        `loginctl terminate-user ${shQuote(name)} 2>/dev/null; for i in 1 2 3 4 5; do pkill -KILL -u ${shQuote(name)} 2>/dev/null; if userdel --remove ${shQuote(name)} 2>/dev/null; then exit 0; fi; sleep 1; done; userdel --remove ${shQuote(name)}`,
      ),
    )
    if (!ok) return 1
  }
  if (packages.length)
    await step(io, t('install.undo.will.desktop', { packages: packages.join(', ') }), () =>
      sh(desktopRemoveScript(packages), { timeoutMs: 15 * 60_000 }),
    )
  await sh(
    `rm -f ${INSTALL_RECORD}; [ -e ${SERVER_NAMES.record} ] || rmdir ${shQuote(socketFolder(BOARD_SOCKET))} 2>/dev/null; true`,
  )
  io.say('', t('install.undo.done'))
  return 0
}
