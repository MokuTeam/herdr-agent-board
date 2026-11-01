// Setting up the server's web server through the owner's admin connection (the server-setup spec's
// "The admin connection", "Look", "Apply" and "Undo"): the admin's fields in config.json; Look (a
// probe as the admin for the sudo it needs, then two rounds as root that only read) and the plan
// from what it found; Apply or Undo of that plan as one script the server runs by itself, followed
// line by line; config.json's summary of the setup (and case 4's public port) after; Test
// connection until the domain answers. Only the local board reaches this (remote-access.ts).
//
// The passwords are the page's (the simple-setup spec's "The admin login by password"): the
// login's (`password`, also sudo's, call 3) and sudo's own when it differs (`sudoPassword`). They
// come with each Look, Apply or Undo (typed in the panel, or the ones the local board remembers
// for 30 minutes, filled in by remote-access.ts: services/held-passwords.ts); the login's goes to
// ssh's askpass (adapters/ssh.ts), once per ssh, sudo's to ssh's stdin, once per spawn. Kept here
// in memory only while that request (or that run, to mask a line that would hold one) lasts;
// never in config.json, web.log, the view, an answer or a command line. ssh's lines are read as the
// server said them (a password like `debian` or `1` is a word Look and the run print too); a line
// that is shown (a step's output, an error) has it masked. Without a password the login is the
// keys' alone, its ssh line as before the password login.
//
// With the board's own public key, Look reads step 1's parts too and Apply makes what the server
// lacks of them (the tunnel user, the socket's folder, the keys file, sshd's fence). A run travels
// packed (gzip, then base64): the plans that make step 1 too are past a Windows command line else.
//
// "Install the board on this server" (path B of the board on a server, core/server-install.ts) is
// a Look of its own, for the server mode's target (the board's socket and user, no tunnel user),
// and an Apply that sends the board's install with the local checkout's pack over the same login
// and streams its output into the view. Its setup link is kept apart from that output, in memory
// only, until the panel lets it go; web.log has only that the install started and how it ended.
// That board answers on a domain of its own (`tunnel.install.domain`), never the tunnel's: its Look
// and Apply need the server and the login alone of the tunnel's settings, and change none of them.
import { gzipSync } from 'node:zlib'
import { type BoardPack, boardHead, boardPack } from '../adapters/board-pack.ts'
import { editTunnel, editTunnelAdmin, editTunnelInstall, mustEdit, setTunnelSetup } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import type { RemoteRun, spawnRemote } from '../adapters/ssh.ts'
import { lang, t } from '../core/lang.ts'
import {
  type Admin,
  type AskpassReport,
  adminConfig,
  adminHint,
  adminProblems,
  adminSshArgs,
  connectionLost,
  loginHint,
  needFor,
  PROBE_SCRIPT,
  readProbe,
  remoteCommand,
  SUDO_CHECK,
  takesAskpass,
} from '../core/server-admin.ts'
import {
  type BoardFacts,
  boardFactsScript,
  boardVersionOf,
  type LocalVersion,
  readBoardFacts,
  type UndoFacts,
  undoFactsOf,
  undoNothing,
} from '../core/server-board.ts'
import type { ServerFacts } from '../core/server-facts.ts'
import {
  BOARD_SOCKET,
  BOARD_USER,
  receiverScript,
  removerScript,
  serverWanted,
  setupLinkIn,
} from '../core/server-install.ts'
import { type LookInput, lookScript1, lookScript2, readRoundOne, readServerFacts } from '../core/server-look.ts'
import { oneLine, oneshotScripts } from '../core/server-oneshot.ts'
import {
  buildPlan,
  type Choice,
  chooseCase,
  type Plan,
  type SetupCase,
  type SetupRecord,
  setupRecord,
  undoPlan,
  type Wanted,
  whose,
} from '../core/server-plan.ts'
import { launchScript, type Progress, readProgress, runLine, runScript, startProgress } from '../core/server-script.ts'
import { type Acme, PORT_4 } from '../core/server-texts.ts'
import type {
  AdminHint,
  InstalledView,
  InstallView,
  RemoveView,
  ServerPhase,
  ServerView,
  SudoMode,
} from '../core/server-view.ts'
import { fieldProblem, type TestStep, type TunnelConfig, tunnelConfig } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'

export interface ServerSetupDeps {
  /** The live config (liveConfig). */
  cfg: Config
  webPort: number
  /** The ssh binary (adapters/ssh.ts sshBin); null when there is none. */
  ssh(): string | null
  /** That binary's `ssh -V` line (adapters/ssh.ts sshVersion): asked only for a login by password. */
  sshVersion(bin: string): Promise<string>
  /** The board's own known_hosts (its folder made), where Test connection or the first admin login pinned the server's key. */
  knownHosts(): string
  /** Whether that file pins the tunnel's server's key. */
  hostKeyPinned(): Promise<boolean>
  /** The pinned key's fingerprint, 'SHA256:… (ED25519)' (adapters/ssh.ts hostKeyFingerprint). */
  hostKeyFingerprint(): Promise<string | null>
  spawn: typeof spawnRemote
  /** Test connection (the supervisor's). */
  test(): Promise<TestStep[]>
  /** The view changed. */
  onChange(): void
  /** A line for web.log. */
  log(text: string): void
  now(): number
  /** A plan's or a run's id: it names files and labels on the server (letters, digits, `.`, `_`, `-`). */
  newId(): string
  /** A test CA for the board's own Caddy (BOARD_SETUP_ACME_CA and BOARD_SETUP_ACME_CA_ROOT). */
  acme?: Acme
  /** The board's public key (its tunnel key's), which Apply puts in place; null while there is none. */
  publicKey?(): Promise<string | null>
  /**
   * The tunnel on or off, as the panel's On and Off: on once Apply's domain answers, off after
   * Undo. On is left to the panel's button while something blocks it (no login set up yet).
   */
  tunnel?(on: boolean): Promise<void>
  /** The local checkout's pack for path B (adapters/board-pack.ts, the default); null when there is none. */
  pack?(): Promise<BoardPack | null>
  /** The local checkout's version without a pack (adapters/board-pack.ts boardHead, the default); null when there is none. */
  head?(): Promise<LocalVersion | null>
}

export type Answer = { status: number; body: unknown }

export interface ServerSetup {
  view(): ServerView
  admin(body: { user?: unknown; key?: unknown }): Answer
  look(o: Passwords): Promise<Answer>
  apply(o: Passwords & { plan?: unknown; docker?: unknown }): Promise<Answer>
  undoLook(o: Passwords): Promise<Answer>
  undo(o: Passwords & { plan?: unknown; removeDocker?: unknown; removeEdited?: unknown }): Promise<Answer>
  cancel(): Answer
  /**
   * "Do it myself" as one command (core/server-oneshot.ts) for the tunnel's settings and the
   * board's public key: 200 `{ command, script, undoCommand, undoScript }`, or 409 when the
   * settings do not check out. Made once per settings, key and language.
   */
  oneshot(publicKey: string | null): Answer
  /** Path B: Look for the board installed on the server (its own target), with the local checkout's pack. */
  installLook(o: Passwords): Promise<Answer>
  /** Path B: the install sent and run, its output streamed into the view. */
  install(o: Passwords & { plan?: unknown; docker?: unknown }): Promise<Answer>
  /** Path B: the setup link let go (the panel closed). */
  installForget(): Answer
  /**
   * The version of the board on the server, read again (one round as root that changes nothing):
   * the card's, kept in memory. Refused while something else runs; nothing in the view changes but
   * the version, whatever the answer.
   */
  installVersion(o: Passwords): Promise<Answer>
  /** "Remove the board from this server": its Look (what the install's --undo would take, nothing changed). */
  removeLook(o: Passwords): Promise<Answer>
  /** Its run: the install's --undo (with the user when ticked), its output streamed into the view. */
  remove(o: Passwords & { plan?: unknown; removeUser?: unknown }): Promise<Answer>
  /**
   * Path B's domain (`tunnel.install.domain`), the board on the server's own: `{ domain }`, '' or
   * null clearing it; 409 with `field` and `error` when it is no domain or the tunnel's own.
   */
  installDomain(body: { domain?: unknown }): Answer
}

/** What Look, Apply and Undo carry of the passwords: the login's (sudo's too), and sudo's own. */
export type Passwords = {
  password?: unknown
  sudoPassword?: unknown
}

/** Path B's install (Bun, herdr, Claude Code, Docker downloaded; the web server's run), and the output lines kept. */
const INSTALL_MS = 60 * 60_000
const INSTALL_KEPT = 600
/** How long each ssh may take: the probe, a round of Look, a run. */
const PROBE_MS = 30_000
const ROUND_MS = 60_000
/**
 * A run's ssh outlasts the run on the server, so the board never stops following first: its
 * overall timeout (core/server-script.ts RUN_MOST_S, 20 minutes), then the rollback a TERM lets
 * it do before the kill (`timeout -k`, KILL_AFTER_S: 5 minutes), the follower's minute past
 * those (its give-up count), and 2 minutes for ssh, sudo and the follower's own turns. Those
 * constants are not exported, so they are repeated here: a change there needs one here ("a run's
 * ssh" in the service's test reads them from the launch script and holds this to them).
 */
const RUN_MOST_S = 1200
const KILL_AFTER_S = 300
const FOLLOWER_MORE_S = 60
const RUN_MS = (RUN_MOST_S + KILL_AFTER_S + FOLLOWER_MORE_S + 120) * 1000
/** The launch's exit when it could not write the run, so never started it (core/server-script.ts LAUNCH_FAILED). */
const LAUNCH_FAILED = 70
/** After Apply, Test connection this often until the domain answers, for at most this long (the certificate, call 24). */
const TEST_EVERY_MS = 10_000
const TEST_MOST_MS = 120_000
const PASSWORD_MOST = 1024
/** ssh's or sudo's last lines kept as an error's detail; a run's last output lines read for a hint. */
const DETAIL_LINES = 6
const OUT_KEPT = 400
/** What a line holding the password shows instead. */
const MASK = '••••'
/** How a run travels in its launch (core/server-script.ts launchScript): gzip, then base64. */
const PACK = (text: string): string => gzipSync(text).toString('base64')
const CASES: readonly SetupCase[] = ['1', '1b', '2', '3a', '3b', '4a', '4b']
/** What the tunnel's Look, Apply and Undo need of its settings; path B's need the server alone. */
type Needed = 'host' | 'user' | 'socket' | 'domain'
const TUNNEL_NEEDS: readonly Needed[] = ['host', 'user', 'socket', 'domain']
const INSTALL_NEEDS: readonly Needed[] = ['host']

/** A domain as the board takes one (core/server-install.ts, --domain): trimmed, lowercased, a trailing dot dropped. */
const domainOf = (v: string): string => v.trim().toLowerCase().replace(/\.$/, '')

type Fields = Record<string, unknown>
type Setup = NonNullable<ServerView['setup']>

const ok = (): Answer => ({ status: 200, body: { ok: true } })
const malformed = (error: string): Answer => ({ status: 400, body: { ok: false, error } })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A password as the page sent it: null for none; false when it is no one-line string (malformed). */
function passwordOf(v: unknown): string | null | false {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || /[\r\n]/.test(v) || v.length > PASSWORD_MOST) return false
  return v
}

/** Both of a request's passwords, or the answer for the one that is malformed (its field's name). */
function passwordsOf(o: Fields): { password: string | null; sudoPassword: string | null } | Answer {
  const password = passwordOf(o.password)
  if (password === false) return malformed('password')
  const sudoPassword = passwordOf(o.sudoPassword)
  if (sudoPassword === false) return malformed('sudoPassword')
  return { password, sudoPassword }
}

/**
 * How one request logs in: the password its askpass gives (null: the keys alone, ssh's line as
 * before the password login), whether one was typed, and whether ssh is too old to take it
 * (then the keys alone, and a refusal says why).
 */
interface Login {
  password: string | null
  typed: boolean
  oldSsh: boolean
}

/** Where sudo's password came from: the login's (call 3), sudo's own field, or none went. */
type SudoFrom = 'login' | 'own' | null

/** Where sudo's password comes from when sudo asks one: sudo's own when the page has it, else the login's (call 3). */
const sudoFromOf = (mode: SudoMode, password: string | null, sudoPassword: string | null): SudoFrom =>
  mode !== 'password' ? null : sudoPassword !== null ? 'own' : password !== null ? 'login' : null

/** ssh's or sudo's last lines, for an error's detail; null without any. */
const detailOf = (lines: readonly string[]): string | null =>
  lines
    .filter(l => l.trim())
    .slice(-DETAIL_LINES)
    .join('\n') || null

/** What a Look leaves for its Apply or Undo (the plan's kind says which): the plan and what it was made from. */
interface Looked {
  plan: Plan
  facts: ServerFacts
  /** The record of this board's pair, when the server has one. */
  record: SetupRecord | null
  wanted: Wanted
  admin: Admin
  mode: SudoMode
  /** Look's login took the password (its askpass answered): Apply and Undo log in with it again. */
  password: boolean
  /** Path B: the pack of the local checkout this Look showed, which its Apply sends. */
  pack: BoardPack | null
}

/** What the Look of "Remove the board from this server" leaves for its run. */
interface RemoveLooked {
  id: string
  facts: UndoFacts
  admin: Admin
  mode: SudoMode
  /** Look's login took the password: the run logs in with it again. */
  password: boolean
}

/** An ssh's end, and its lines as the server said them (what is read); `secrets`, masked in any line that is shown. */
interface Heard {
  code: number | null
  error: string | null
  out: string[]
  err: string[]
  /** What the askpass did, for a login by password. */
  askpass: AskpassReport | null
  secrets: readonly string[]
}

export function createServerSetup(d: ServerSetupDeps): ServerSetup {
  const { cfg } = d
  let phase: ServerPhase = 'idle'
  let sudo: SudoMode | null = null
  let facts: ServerFacts | null = null
  let choice: Choice | null = null
  let plan: Plan | null = null
  let progress: Progress | null = null
  let hint: AdminHint | null = null
  let error: string | null = null
  let testAfter: TestStep[] | null = null
  let hostKey: ServerView['hostKey'] = null
  /** The last Look's plan: Apply and Undo take only its id (a board started anew has none). */
  let last: Looked | null = null
  /** A Look or a run (with its Test after) is going on: one at a time. */
  let busy = false
  let current: RemoteRun | null = null
  /** Counts Cancel: a Look it cut short leaves the view alone. */
  let generation = 0
  /** The one command last made, and what it was made from. */
  let oneshot: { from: string; body: Fields } | null = null
  /** What the last Look was for, and path B's run. */
  let target: 'tunnel' | 'install' | 'remove' = 'tunnel'
  let install: InstallView | null = null
  /** "Remove the board from this server": its Look's plan and run, and what its run goes by. */
  let remove: RemoveView | null = null
  let removeLooked: RemoveLooked | null = null
  /** The version of the board on the server as last seen, and the local checkout's then: memory only. */
  let installed: InstalledView | null = null
  let local: LocalVersion | null = null
  /** A look at that version going on (beside anything else: it reads only). */
  let reading = false

  const tunnel = (): Fields => (isRecord(cfg.tunnel) ? cfg.tunnel : {})
  const conf = (): TunnelConfig => tunnelConfig(cfg.tunnel)
  const admin = (): Admin => adminConfig(tunnel().admin)
  /** Path B's domain as config.json has it (`tunnel.install.domain`), taken as a domain is; '' without one. */
  const installDomainOf = (): string => {
    const i = tunnel().install
    return isRecord(i) && typeof i.domain === 'string' ? domainOf(i.domain) : ''
  }
  const changed = (): void => d.onChange()
  const hintText = (h: AdminHint): string => t(`server.hint.${h}`, { admin: admin().user || 'root' })

  /** A change written to config.json, in the live config at once (liveConfig reads the file again a moment later). */
  function mirror(edit: (tunnel: Fields) => void): void {
    const next = { ...tunnel() }
    edit(next)
    cfg.tunnel = next
  }

  function setupOf(): Setup | null {
    const s = tunnel().setup
    return isRecord(s) &&
      CASES.includes(s.case as SetupCase) &&
      typeof s.address === 'string' &&
      typeof s.at === 'string'
      ? { case: s.case as SetupCase, address: s.address, at: s.at }
      : null
  }

  // a refused write (config.json busy or unreadable) is thrown: the run says it failed, not done
  function writeSetup(s: Setup | null): void {
    mustEdit(setTunnelSetup(s))
    mirror(x => {
      if (s) x.setup = { ...(isRecord(x.setup) ? x.setup : {}), ...s }
      else delete x.setup
    })
  }

  function writePublicPort(port: number | null): void {
    mustEdit(editTunnel({ publicPort: port }))
    mirror(x => {
      if (port === null) delete x.publicPort
      else x.publicPort = port
    })
  }

  const wanted = (c: TunnelConfig, key: string | null): Wanted => ({
    user: c.user,
    socket: c.socket,
    domain: c.domain,
    publicPort: c.publicPort,
    ...(key !== null && { publicKey: key }),
    ...(d.acme && { acme: d.acme }),
  })

  /** The board's public key; null without one (step 1 is then the owner's, as before). */
  async function boardKey(): Promise<string | null> {
    try {
      return d.publicKey ? await d.publicKey() : null
    } catch {
      return null
    }
  }

  /**
   * A refusal: its hint, as its error the lines that matter or else the hint's own words, and the
   * password field the hint asks for (`need`: 'password', the login's; 'sudoPassword', sudo's own).
   */
  function refused(h: AdminHint | null, detail: string | null, more: Fields = {}): Answer {
    const need = needFor(h)
    return {
      status: 409,
      body: { ok: false, hint: h, error: detail ?? (h ? hintText(h) : ''), ...(need && { need }), ...more },
    }
  }

  const cancelled = (): Answer => refused(null, t('server.err.cancelled'))

  /** A Look that stopped: the view says why, as the answer does (the hint's own words once: the panel shows the hint). */
  function stopLook(h: AdminHint | null, detail: string | null, more: Fields = {}): Answer {
    phase = 'idle'
    hint = h
    error = detail
    changed()
    return refused(h, detail, more)
  }

  /**
   * What Look, Apply and Undo need before any ssh: the admin's fields, the tunnel's server and pair
   * (path B: the server alone), ssh itself.
   */
  function ready(needs: readonly Needed[] = TUNNEL_NEEDS): Answer | { bin: string; c: TunnelConfig; a: Admin } {
    const a = admin()
    const problem = adminProblems(a)[0]
    if (problem) return { status: 409, body: { ok: false, hint: null, field: problem.field, error: problem.message } }
    const c = conf()
    for (const field of needs) {
      const value = c[field]
      const message =
        value === '' ? t('tunnel.err.required', { field: t(`tunnel.field.${field}`) }) : fieldProblem(field, value)
      if (message) return refused(null, message)
    }
    const bin = d.ssh()
    if (!bin) return refused('noSsh', null)
    return { bin, c, a }
  }

  /**
   * How this request logs in: with a password typed, by its askpass when ssh takes one (OpenSSH
   * 8.4 and later: `ssh -V`, asked only then), else the keys alone; without one, the keys alone,
   * and ssh is asked nothing more than before.
   */
  async function loginOf(bin: string, password: string | null): Promise<Login> {
    if (password === null) return { password: null, typed: false, oldSsh: false }
    const ok = takesAskpass(await d.sshVersion(bin))
    return ok ? { password, typed: true, oldSsh: false } : { password: null, typed: true, oldSsh: true }
  }

  /** One ssh to the admin, its lines kept as they are (masked where shown); with `pin`, this login pins the server's key (call 2). */
  async function hear(
    to: { bin: string; c: TunnelConfig; a: Admin },
    command: string,
    stdin: string | null,
    ms: number,
    login: Login,
    secrets: readonly string[],
    pin = false,
    /** Cancel kills it (the view's Look or run); the version's look is no one's to cancel. */
    track = true,
  ): Promise<Heard> {
    const args = adminSshArgs({
      conf: to.c,
      admin: to.a,
      knownHosts: d.knownHosts(),
      command,
      ...(login.password !== null && { password: true }),
      ...(pin && { pin }),
    })
    const run = d.spawn(to.bin, args, stdin, ms, login.password === null ? null : { password: login.password })
    if (track) current = run
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null, secrets }
    run.onLine((line, from) => heard[from === 'err' ? 'err' : 'out'].push(line))
    const end = await run.done
    if (current === run) current = null
    return { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null }
  }

  const mask = (line: string, secrets: readonly string[]): string =>
    secrets.reduce((l, secret) => (secret ? l.replaceAll(secret, MASK) : l), line)
  /** ssh's lines as the view, an answer or an error shows them: a password in them masked. */
  const shown = (h: Heard, lines: readonly string[]): string[] => lines.map(l => mask(l, h.secrets))

  /**
   * Why an ssh that did not give its answer stopped: ssh missing (noSsh), or not started for
   * another reason (a command line longer than Windows takes…) in its own code; killed at its
   * limit; else the login (its askpass, ssh's refusal), else what its lines say, sudo refusing
   * the login's password being "sudo needs its own" (call 3). A prompt the askpass refused is
   * named in the detail.
   */
  function stopped(h: Heard, login: Login, sudoFrom: SudoFrom): { hint: AdminHint | null; detail: string | null } {
    if (h.code === null && h.error !== null && h.error !== 'timeout')
      return h.error === 'ENOENT'
        ? { hint: 'noSsh', detail: h.error }
        : { hint: null, detail: t('server.err.spawn', { code: h.error }) }
    const asked = h.askpass?.refused ?? null
    const detail = detailOf(
      shown(h, asked === null ? h.err : [...h.err, t('server.err.prompt', { prompt: asked.trim() })]),
    )
    const said =
      loginHint({
        lines: h.err,
        typed: login.typed,
        askpass: h.askpass,
        oldSsh: login.oldSsh,
        root: admin().user === 'root',
      }) ?? adminHint(h.err)
    const why = said === 'wrongPassword' && sudoFrom === 'login' ? 'sudoPassword' : said
    if (h.error === 'timeout')
      return { hint: why, detail: [t('server.err.timeout'), detail].filter(Boolean).join('\n') }
    return { hint: why, detail }
  }

  /** Why path B's domain will not do: none, no domain, or the tunnel's own; null when it does. */
  function installProblem(domain: string): string | null {
    if (domain === '') return t('install.err.domainNeeded')
    if (fieldProblem('domain', domain)) return t('install.err.domain')
    return domain === domainOf(conf().domain) ? t('install.err.sameDomain', { domain }) : null
  }

  /** The server's key for the view once a login met it: its fingerprint, and whether this Look pinned it. */
  async function keyMet(pinnedNow: boolean): Promise<ServerView['hostKey']> {
    const fingerprint = await d.hostKeyFingerprint()
    return fingerprint ? { fingerprint, pinnedNow } : null
  }

  async function lookAt(o: Fields, kind: 'look' | 'undo' | 'install' | 'remove'): Promise<Answer> {
    const pw = passwordsOf(o)
    if ('status' in pw) return pw
    const { password, sudoPassword } = pw
    if (busy) return refused('busy', null)
    // the board on the server (its install, or its removal) logs in to the server alone
    const board = kind === 'install' || kind === 'remove'
    const to = ready(board ? INSTALL_NEEDS : TUNNEL_NEEDS)
    if ('status' in to) return to
    const { c } = to
    busy = true
    const gen = generation
    const gone = (): boolean => gen !== generation
    phase = 'looking'
    facts = null
    choice = null
    plan = null
    progress = null
    hint = null
    error = null
    testAfter = null
    hostKey = null
    last = null
    target = kind === 'install' ? 'install' : kind === 'remove' ? 'remove' : 'tunnel'
    install = null
    remove = null
    removeLooked = null
    changed()
    try {
      // path B answers on a domain of its own, never the tunnel's: one that will do, before anything else
      const installDomain = kind === 'install' ? installDomainOf() : ''
      const why = kind === 'install' ? installProblem(installDomain) : null
      if (why) return stopLook(null, why)
      // path B sends the local checkout: there must be one
      const pack = kind === 'install' ? await (d.pack ?? boardPack)() : null
      if (gone()) return cancelled()
      if (kind === 'install' && !pack) return stopLook(null, t('install.panel.noCheckout'))
      const pinnedBefore = await d.hostKeyPinned()
      if (gone()) return cancelled()
      const login = await loginOf(to.bin, password)
      if (gone()) return cancelled()
      const secrets = [password ?? '', sudoPassword ?? '']
      // as the admin, without sudo and with nothing on stdin: which sudo it has. With no key
      // pinned yet, this first login pins the one it meets (call 2).
      const probe = await hear(to, remoteCommand(PROBE_SCRIPT, 'root'), null, PROBE_MS, login, secrets, !pinnedBefore)
      if (gone()) return cancelled()
      const pinnedNow = !pinnedBefore && (await d.hostKeyPinned())
      if (pinnedBefore || pinnedNow) hostKey = await keyMet(pinnedNow)
      if (gone()) return cancelled()
      const read = probe.code === 0 ? readProbe(probe.out) : null
      if (!read) {
        const why = stopped(probe, login, null)
        return stopLook(why.hint ?? (probe.code === 0 ? 'unreadable' : null), why.detail)
      }
      // logged in, and still no key pinned (known_hosts not written): the rounds would be refused
      if (!pinnedBefore && !pinnedNow) return stopLook('noHostKey', null)
      sudo = read.mode
      if (read.mode === 'requiretty') return stopLook('requiretty', null)
      if (read.mode === 'none') return stopLook(adminHint(probe.out) ?? 'notSudoer', null)
      const sudoFrom = sudoFromOf(read.mode, password, sudoPassword)
      if (read.mode === 'password' && sudoFrom === null) return stopLook('needPassword', null)
      const stdin = sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`
      // the server mode's target has no key of the board's to put in place
      const key = board ? null : await boardKey()
      if (gone()) return cancelled()
      const typed = (probe.askpass?.answered ?? 0) > 0
      // each round as root, sudo's password (when it asks one) on stdin once: one sudo try per click
      const round = async (script: string): Promise<string | Answer> => {
        const h = await hear(to, remoteCommand(script, read.mode), stdin, ROUND_MS, login, secrets)
        if (gone()) return cancelled()
        if (h.code === 0) return h.out.join('\n')
        const why = stopped(h, login, sudoFrom)
        return stopLook(why.hint, why.detail)
      }
      // the board on the server: what its install left (root's record, its user), its version with it
      let found: UndoFacts | null = null
      let removeDomain = ''
      if (board) {
        const out = await round(boardFactsScript())
        if (typeof out !== 'string') return out
        const b = readBoardFacts(out)
        if (!b) return stopLook('unreadable', null)
        await sawVersion(b, pack)
        if (gone()) return cancelled()
        found = undoFactsOf(b)
        // the web server's part is looked at for the domain the install had (else the card's)
        removeDomain = b.record?.domain ?? installDomainOf()
        if (kind === 'remove' && (removeDomain === '' || fieldProblem('domain', removeDomain)))
          return removePlan(null, found, '', to.a, read.mode, typed)
      }
      const input: LookInput =
        kind === 'install'
          ? { user: BOARD_USER, socket: BOARD_SOCKET, domain: installDomain, server: true }
          : kind === 'remove'
            ? { user: found?.user ?? BOARD_USER, socket: BOARD_SOCKET, domain: removeDomain, server: true }
            : {
                user: c.user,
                socket: c.socket,
                domain: c.domain,
                ...(key !== null && { publicKey: key }),
              }
      const one = await round(lookScript1(input))
      if (typeof one !== 'string') return one
      const r1 = readRoundOne(one)
      if (!r1) return stopLook('unreadable', null)
      const script2 = lookScript2(r1, input)
      const two = script2 ? await round(script2) : ''
      if (typeof two !== 'string') return two
      const f = readServerFacts(r1, two)
      if (!f) return stopLook('unreadable', null)
      if (kind === 'remove')
        return found ? removePlan(f, found, removeDomain, to.a, read.mode, typed) : stopLook(null, null)
      if (kind === 'install')
        return pack ? installPlan(f, installDomain, to.a, read.mode, pack, typed) : stopLook(null, null)
      return planFrom(f, c, to.a, read.mode, kind, key, typed)
    } catch (err) {
      // a plan refused (what the panel wants failed its check in core/server-plan.ts): nothing
      // half made stays in the view, the check's own words are the error
      if (gone()) return cancelled()
      facts = null
      choice = null
      plan = null
      return stopLook(null, messageOf(err))
    } finally {
      if (!gone()) busy = false
    }
  }

  /** The plan for what Look found (Apply's, or the Undo of this board's record). */
  function planFrom(
    f: ServerFacts,
    c: TunnelConfig,
    a: Admin,
    mode: SudoMode,
    kind: 'look' | 'undo',
    key: string | null,
    password: boolean,
  ): Answer {
    const w = wanted(c, key)
    const record = f.record === null || f.record === undefined ? null : setupRecord(f.record)
    const ours = record && whose(record, w) !== 'other' ? record : null
    // set up from another PC or before a reinstall: the panel's summary from the server's record,
    // and case 4's public port with it when the panel has none (Test connection looks for the port
    // only while there is no summary)
    if (ours?.state === 'applied' && !setupOf()) {
      writeSetup({ case: ours.case, address: ours.address, at: ours.at })
      if (ours.publicPort !== null && c.publicPort === null && whose(ours, w) === 'same')
        writePublicPort(ours.publicPort)
    }
    const id = d.newId()
    facts = f
    if (kind === 'look') {
      const made = buildPlan(f, w, { id, docker: false })
      plan = 'steps' in made ? made : null
      choice = 'steps' in made ? chooseCase(f, w) : made
    } else if (f.record === null || f.record === undefined) {
      // nothing of the board's there: the summary says so too
      if (setupOf()) writeSetup(null)
      return stopLook(null, t('server.err.noRecord'))
    } else if (!ours) {
      plan = null
      choice = { case: null, why: ['otherSetup'] }
    } else {
      plan = undoPlan(ours, f, { id, removeDocker: false, removeEdited: false })
      choice = null
    }
    phase = 'plan'
    last = plan ? { plan, facts: f, record: ours, wanted: w, admin: a, mode, password, pack: null } : null
    changed()
    return ok()
  }

  /** Path B's plan: the web server's for the server mode's target at its own domain, and the pack its Apply sends. */
  function installPlan(
    f: ServerFacts,
    domain: string,
    a: Admin,
    mode: SudoMode,
    pack: BoardPack,
    password: boolean,
  ): Answer {
    const w: Wanted = { ...serverWanted(domain, BOARD_USER), ...(d.acme && { acme: d.acme }) }
    const made = buildPlan(f, w, { id: d.newId(), docker: false })
    facts = f
    // a run of the web server's that did not finish: its Undo is the install's own (--undo)
    plan = 'steps' in made && made.kind !== 'undo' ? made : null
    choice = 'steps' in made ? chooseCase(f, w) : made
    install = { from: { commit: pack.commit, changes: pack.changes }, out: [], link: null, code: null }
    phase = 'plan'
    last = plan ? { plan, facts: f, record: null, wanted: w, admin: a, mode, password, pack } : null
    changed()
    return ok()
  }

  /** The board on the server as this Look or read found it: its version (none: not installed), and the local checkout's beside it. */
  async function sawVersion(b: BoardFacts, pack: LocalVersion | null): Promise<void> {
    installed = { version: b.record ? boardVersionOf(b.record) : null, seen: d.now() }
    if (pack) local = { commit: pack.commit, changes: pack.changes }
    else {
      try {
        local = await (d.head ?? boardHead)()
      } catch {
        local = null
      }
    }
  }

  /**
   * "Remove the board from this server"'s plan: what the install's --undo would take, from what the
   * round as root found and (`f`) the web server's part, the server mode's alone (its record, at
   * the install's domain; the tunnel's is another's and stays). Nothing there: said so.
   */
  function removePlan(
    f: ServerFacts | null,
    u: UndoFacts,
    domain: string,
    a: Admin,
    mode: SudoMode,
    password: boolean,
  ): Answer {
    let web: Plan | null = null
    let at = domain
    if (f) {
      const r = f.record === null || f.record === undefined ? null : setupRecord(f.record)
      // as the install's --undo: the web server's record of this user, at its own domain
      at = r?.domain ?? domain
      const w: Wanted = { ...serverWanted(at, u.user), ...(d.acme && { acme: d.acme }) }
      if (r && whose(r, w) !== 'other')
        web = undoPlan(r, f, { id: d.newId(), removeDocker: false, removeEdited: false })
    }
    if (undoNothing(u, true, web !== null)) return stopLook(null, t('install.undo.nothing'))
    const id = web?.id ?? d.newId()
    facts = f
    plan = web
    choice = null
    remove = { id, facts: u, domain: at, web: web !== null, removeUser: false, out: [], code: null }
    removeLooked = { id, facts: u, admin: a, mode, password }
    phase = 'plan'
    changed()
    return ok()
  }

  /**
   * The version of the board on the server, read again: the probe, then one round as root that
   * only reads. Nothing in the view changes but that version; a login the server refuses says why
   * in the answer alone.
   */
  async function readVersion(o: Fields): Promise<Answer> {
    const pw = passwordsOf(o)
    if ('status' in pw) return pw
    const { password, sudoPassword } = pw
    if (busy || reading) return refused('busy', null)
    const to = ready(INSTALL_NEEDS)
    if ('status' in to) return to
    // a server whose key no login met yet is Look's to meet (call 2), not a read's
    if (!(await d.hostKeyPinned())) return refused('noHostKey', null)
    if (busy || reading) return refused('busy', null)
    reading = true
    changed()
    try {
      const login = await loginOf(to.bin, password)
      const secrets = [password ?? '', sudoPassword ?? '']
      const probe = await hear(to, remoteCommand(PROBE_SCRIPT, 'root'), null, PROBE_MS, login, secrets, false, false)
      const read = probe.code === 0 ? readProbe(probe.out) : null
      if (!read) {
        const why = stopped(probe, login, null)
        return refused(why.hint ?? (probe.code === 0 ? 'unreadable' : null), why.detail)
      }
      if (read.mode === 'requiretty') return refused('requiretty', null)
      if (read.mode === 'none') return refused(adminHint(probe.out) ?? 'notSudoer', null)
      const sudoFrom = sudoFromOf(read.mode, password, sudoPassword)
      if (read.mode === 'password' && sudoFrom === null) return refused('needPassword', null)
      const stdin = sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`
      const script = remoteCommand(boardFactsScript(), read.mode)
      const h = await hear(to, script, stdin, ROUND_MS, login, secrets, false, false)
      if (h.code !== 0) {
        const why = stopped(h, login, sudoFrom)
        return refused(why.hint, why.detail)
      }
      const b = readBoardFacts(h.out.join('\n'))
      if (!b) return refused('unreadable', null)
      await sawVersion(b, null)
      return ok()
    } finally {
      reading = false
      changed()
    }
  }

  /**
   * Path B's runs, the install (its Apply) and the removal: the script as root, the pack on its
   * stdin after sudo's password; its output into the view. When sudo asks a password, it goes
   * alone first (SUDO_CHECK): one try, and a wrong one never has the pack read after it as more
   * tries. Each takes only its own Look's plan, with the admin it was made for.
   */
  async function runBoard(o: Fields, kind: 'install' | 'remove'): Promise<Answer> {
    const pw = passwordsOf(o)
    if ('status' in pw) return pw
    const { password, sudoPassword } = pw
    if (busy) return refused('busy', null)
    const l = last
    const r = removeLooked
    let looked: { mode: SudoMode; admin: Admin; password: boolean }
    if (kind === 'install') {
      if (!l?.pack || target !== 'install' || typeof o.plan !== 'string' || o.plan !== l.plan.id)
        return refused('lookAgain', null)
      if (l.plan.ticks.includes('docker') && o.docker !== true) return refused(null, t('server.err.docker'))
      looked = l
    } else {
      if (!r || target !== 'remove' || typeof o.plan !== 'string' || o.plan !== r.id) return refused('lookAgain', null)
      looked = r
    }
    const { mode } = looked
    const to = ready(INSTALL_NEEDS)
    if ('status' in to) return to
    // its domain or the admin changed since Look: its plan is not theirs
    if (JSON.stringify(to.a) !== JSON.stringify(looked.admin)) return refused('lookAgain', null)
    if (kind === 'install' && l) {
      const domain = installDomainOf()
      if (domain !== l.wanted.domain) return refused('lookAgain', null)
      const why = installProblem(domain)
      if (why) return refused(null, why)
    }
    if (looked.password && password === null) return refused('loginPassword', null)
    const sudoFrom = sudoFromOf(mode, password, sudoPassword)
    if (mode === 'password' && sudoFrom === null) return refused('needPassword', null)
    // the user and its home go only when ticked, and only one the installer made
    const removeUser = kind === 'remove' && o.removeUser === true && r?.facts.ours === true && r.facts.home !== null
    busy = true
    const gen = generation
    const stop = (a: Answer): Answer => {
      if (gen === generation) busy = false
      return a
    }
    // the removal sends the pack the install would: the bootstrap runs the server's own copy when it has one
    const pack = kind === 'install' && l?.pack ? l.pack : await (d.pack ?? boardPack)()
    if (gen !== generation) return cancelled()
    if (!pack) return stop(refused(null, t('install.panel.noCheckout')))
    const pinned = await d.hostKeyPinned()
    if (gen !== generation) return cancelled()
    if (!pinned) return stop(refused('noHostKey', null))
    const login = await loginOf(to.bin, password)
    if (gen !== generation) return cancelled()
    const secrets = [password ?? '', sudoPassword ?? '']
    const sudoLine = sudoFrom === null ? '' : `${sudoFrom === 'own' ? sudoPassword : password}\n`
    if (sudoFrom !== null) {
      const h = await hear(to, remoteCommand(SUDO_CHECK, mode), sudoLine, ROUND_MS, login, secrets)
      if (gen !== generation) return cancelled()
      if (h.code !== 0) {
        const why = stopped(h, login, sudoFrom)
        return stop(refused(why.hint, why.detail))
      }
    }
    let script: string
    try {
      script =
        kind === 'install' && l
          ? receiverScript({ domain: l.wanted.domain, lang: lang() })
          : removerScript({ removeUser, lang: lang() })
    } catch (err) {
      return stop(refused(null, messageOf(err)))
    }
    // a run changes the server: the next one needs a Look of its own
    last = null
    removeLooked = null
    phase = kind === 'install' ? 'applying' : 'undoing'
    if (kind === 'install' && l) plan = l.plan
    progress = null
    hint = null
    error = null
    testAfter = null
    let view: { out: string[]; code: number | null; link?: string | null }
    if (kind === 'install' || !remove) {
      const v: InstallView = { from: { commit: pack.commit, changes: pack.changes }, out: [], link: null, code: null }
      install = v
      view = v
    } else {
      const v: RemoveView = { ...remove, removeUser, out: [], code: null }
      remove = v
      view = v
    }
    changed()
    d.log(`server ${kind}: started`)
    const args = adminSshArgs({
      conf: to.c,
      admin: to.a,
      knownHosts: d.knownHosts(),
      command: remoteCommand(script, mode),
      ...(login.password !== null && { password: true }),
    })
    const stdin = `${sudoLine}${Buffer.from(pack.bytes).toString('base64')}\n`
    const child = d.spawn(
      to.bin,
      args,
      stdin,
      INSTALL_MS,
      login.password === null ? null : { password: login.password },
    )
    current = child
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null, secrets }
    // drawn again a moment after lines came, not once per line
    let soon: ReturnType<typeof setTimeout> | null = null
    const later = (): void => {
      soon ??= setTimeout(() => {
        soon = null
        changed()
      }, 250)
    }
    child.onLine((line, from) => {
      if (from === 'err') {
        heard.err.push(line)
        return
      }
      // the setup link: kept apart, in memory, never among the lines (nor in web.log)
      const link = setupLinkIn(line)
      if (link !== null) {
        if (link && kind === 'install') view.link = link
        later()
        return
      }
      view.out.push(mask(line, secrets))
      if (view.out.length > INSTALL_KEPT) view.out.shift()
      later()
    })
    void child.done.then(end => {
      if (soon) clearTimeout(soon)
      if (current === child) current = null
      view.code = end.code
      if (end.code === 0) {
        phase = 'done'
        // removed: nothing of the install's there now; installed: the pack's version, as its record says
        if (kind === 'remove') installed = { version: null, seen: d.now() }
        else {
          const at = d.now()
          const version = { commit: pack.commit, changes: pack.changes, ref: null, at: new Date(at).toISOString() }
          installed = { version, seen: at }
          local = { commit: pack.commit, changes: pack.changes }
        }
      } else {
        phase = 'failed'
        // the run's own words say why when it said any; else ssh's or sudo's
        if (view.out.length === 0) {
          const why = stopped(
            { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null },
            login,
            sudoFrom,
          )
          hint = why.hint
          error = why.detail
        }
      }
      d.log(`server ${kind}: ended ${end.code ?? end.error ?? '?'}`)
      busy = false
      changed()
    })
    return ok()
  }

  /** web.log: one line per step that ended (ok, fail or skip) and how long it took; never its output. */
  function logSteps(was: Progress, now: Progress, at: number): void {
    for (const s of now.steps) {
      if (was.steps.find(x => x.n === s.n)?.state === s.state) continue
      if (s.state !== 'ok' && s.state !== 'fail' && s.state !== 'skipped') continue
      const secs = s.since === null ? 0 : Math.max(0, Math.round((at - s.since) / 1000))
      d.log(`server setup ${s.id} ${s.state === 'skipped' ? 'skip' : s.state} ${secs}s`)
    }
  }

  /** Test connection after Apply, every 10 s until the domain answers, 2 minutes at most (its certificate). */
  async function testAfterApply(): Promise<void> {
    const start = d.now()
    for (;;) {
      try {
        testAfter = await d.test()
      } catch (err) {
        d.log(`server setup: Test connection: ${messageOf(err)}`)
        return
      }
      changed()
      if (testAfter.some(s => s.id === 'domain' && s.ok === true)) {
        await d.tunnel?.(true)
        return
      }
      if (d.now() - start + TEST_EVERY_MS > TEST_MOST_MS) return
      await new Promise(resolve => setTimeout(resolve, TEST_EVERY_MS))
    }
  }

  /** A run has ended: the summary and the public port after it, or why it failed. */
  async function finish(p: Plan, l: Looked, heard: Heard, at: string, login: Login, sudoFrom: SudoFrom): Promise<void> {
    current = null
    const result = progress?.result ?? null
    try {
      if (result === 'applied') {
        if (p.kind === 'undo') {
          writeSetup(null)
          if (l.record?.publicPort === PORT_4 && conf().publicPort === PORT_4) writePublicPort(null)
          await d.tunnel?.(false)
        } else {
          const kept = p.kind === 'nothing' ? setupOf() : null
          writeSetup({ case: p.case, address: p.address, at: kept?.at ?? at })
          if (p.publicPort !== null && conf().publicPort !== p.publicPort) writePublicPort(p.publicPort)
          changed()
          await testAfterApply()
        }
        phase = 'done'
      } else {
        phase = 'failed'
        error = detailOf(shown(heard, heard.err))
        if (result === 'busy' || result === 'changed') hint = result
        else if (result === null && progress?.exit === null) {
          // no end from the server: ssh could not start, was refused, or the connection went. Lost
          // once the run printed something, or when ssh (exit 255) says in its own words that the
          // connection went (the PC asleep before the run's first line); else (ssh or sudo refused,
          // in words the hints do not know) their own lines are the error.
          const why = stopped(heard, login, sudoFrom)
          const gone = heard.out.length > 0 || (heard.code === 255 && connectionLost(heard.err))
          hint = why.hint ?? (gone ? 'lost' : null)
          error = why.detail
        } else if (result === null && progress?.exit === LAUNCH_FAILED) {
          // the launch could not write the run: it never started
          hint = null
          error = [t('server.err.launch'), error].filter(Boolean).join('\n')
        } else hint = adminHint([...heard.err, ...heard.out])
      }
    } catch (err) {
      phase = 'failed'
      error = messageOf(err)
    }
    busy = false
    changed()
  }

  async function runPlan(o: Fields, kind: 'look' | 'undo'): Promise<Answer> {
    const pw = passwordsOf(o)
    if ('status' in pw) return pw
    const { password, sudoPassword } = pw
    if (busy) return refused('busy', null)
    const l = last
    // Undo runs an Undo plan, Apply any other: the plan's kind, whichever Look made it (Look offers
    // the Undo of a run cut short)
    if (!l || typeof o.plan !== 'string' || o.plan !== l.plan.id || (l.plan.kind === 'undo') !== (kind === 'undo'))
      return refused('lookAgain', null)
    if (kind === 'look' && l.plan.ticks.includes('docker') && o.docker !== true)
      return refused(null, t('server.err.docker'))
    const to = ready()
    if ('status' in to) return to
    // the settings or the admin changed since Look: its plan is not theirs
    const lookedKey = l.wanted.publicKey ?? null
    const same =
      JSON.stringify(wanted(to.c, lookedKey)) === JSON.stringify(l.wanted) &&
      JSON.stringify(to.a) === JSON.stringify(l.admin)
    if (!same) return refused('lookAgain', null)
    // Look logged in with the password and none came (the page reloaded, the panel opened anew):
    // the keys alone would be refused with the plan gone. Asked for, the plan kept for this Apply.
    if (l.password && password === null) return refused('loginPassword', null)
    const sudoFrom = sudoFromOf(l.mode, password, sudoPassword)
    if (l.mode === 'password' && sudoFrom === null) return refused('needPassword', null)
    const removeDocker = o.removeDocker === true
    const removeEdited = o.removeEdited === true
    let p: Plan
    try {
      p =
        kind === 'undo' && l.record && (removeDocker || removeEdited)
          ? undoPlan(l.record, l.facts, { id: l.plan.id, removeDocker, removeEdited })
          : l.plan
    } catch (err) {
      return refused(null, messageOf(err))
    }
    busy = true
    const gen = generation
    const pinned = await d.hostKeyPinned()
    const key = await boardKey()
    if (gen !== generation) return cancelled()
    if (!pinned) {
      busy = false
      return refused('noHostKey', null)
    }
    // the board's key made anew since Look: its plan would put the old one in place
    if (key !== lookedKey) {
      busy = false
      return refused('lookAgain', null)
    }
    const login = await loginOf(to.bin, password)
    if (gen !== generation) return cancelled()
    const runId = d.newId()
    const at = new Date(d.now()).toISOString()
    let script: string
    try {
      script = launchScript(runId, runScript(p, l.wanted, { id: runId, at }), PACK)
    } catch (err) {
      busy = false
      return refused(null, messageOf(err))
    }
    // a run changes the server: the next one needs a Look of its own
    last = null
    phase = p.kind === 'undo' ? 'undoing' : 'applying'
    plan = p
    progress = startProgress(p)
    hint = null
    error = null
    testAfter = null
    changed()
    const args = adminSshArgs({
      conf: to.c,
      admin: to.a,
      knownHosts: d.knownHosts(),
      command: remoteCommand(script, l.mode),
      ...(login.password !== null && { password: true }),
    })
    const stdin = sudoFrom === null ? null : `${sudoFrom === 'own' ? sudoPassword : password}\n`
    const child = d.spawn(to.bin, args, stdin, RUN_MS, login.password === null ? null : { password: login.password })
    current = child
    const secrets = [password ?? '', sudoPassword ?? '']
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null, secrets }
    child.onLine((line, from) => {
      if (from === 'err') {
        heard.err.push(line)
        return
      }
      heard.out.push(line)
      if (heard.out.length > OUT_KEPT) heard.out.shift()
      if (!progress) return
      const now = d.now()
      const was = progress
      // the run's own lines as it printed them; a step's output, which the view shows, masked
      progress = readProgress(was, runLine(line) ? line : mask(line, secrets), now)
      logSteps(was, progress, now)
      if (line.startsWith('@@')) changed()
    })
    void child.done.then(end =>
      finish(p, l, { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null }, at, login, sudoFrom),
    )
    return ok()
  }

  return {
    view: () => ({
      admin: admin(),
      sudo,
      phase,
      facts,
      choice,
      plan,
      progress,
      hint,
      error,
      setup: setupOf(),
      testAfter,
      hostKey,
      target,
      install,
      installDomain: installDomainOf(),
      remove,
      installed,
      local,
      reading,
    }),

    admin(body) {
      const patch: Partial<Admin> = {}
      for (const field of ['user', 'key'] as const) {
        const value = body[field]
        if (value === undefined) continue
        if (value === null || value === '') {
          patch[field] = ''
          continue
        }
        const problem = fieldProblem(field, value)
        if (problem || typeof value !== 'string')
          return { status: 409, body: { ok: false, hint: null, field, error: problem ?? '' } }
        patch[field] = value
      }
      const r = editTunnelAdmin(patch)
      if (!r.ok) return refused(null, r.error)
      mirror(x => {
        const a: Fields = isRecord(x.admin) ? { ...x.admin } : {}
        for (const [field, value] of Object.entries(patch)) {
          if (value === '') delete a[field]
          else a[field] = value
        }
        if (Object.keys(a).length) x.admin = a
        else delete x.admin
      })
      changed()
      return ok()
    },

    look: o => lookAt(o, 'look'),
    installLook: o => lookAt(o, 'install'),
    install: o => runBoard(o, 'install'),
    installVersion: o => readVersion(o),
    removeLook: o => lookAt(o, 'remove'),
    remove: o => runBoard(o, 'remove'),
    installForget() {
      if (install) install = { ...install, link: null }
      changed()
      return ok()
    },

    installDomain(body) {
      const given = body.domain
      if (given === undefined) return ok()
      // a domain as the board takes one; '' or null clears it
      const domain = typeof given === 'string' ? domainOf(given) : given === null ? '' : null
      const why = domain === null ? t('install.err.domain') : domain === '' ? null : installProblem(domain)
      if (domain === null || why) return { status: 409, body: { ok: false, hint: null, field: 'domain', error: why } }
      const r = editTunnelInstall({ domain })
      if (!r.ok) return refused(null, r.error)
      mirror(x => {
        const i: Fields = isRecord(x.install) ? { ...x.install } : {}
        if (domain === '') delete i.domain
        else i.domain = domain
        if (Object.keys(i).length) x.install = i
        else delete x.install
      })
      changed()
      return ok()
    },

    undoLook: o => lookAt(o, 'undo'),
    apply: o => runPlan(o, 'look'),
    undo: o => runPlan(o, 'undo'),

    oneshot(publicKey) {
      const c = conf()
      for (const field of ['user', 'socket', 'domain'] as const) {
        const value = c[field]
        const message =
          value === '' ? t('tunnel.err.required', { field: t(`tunnel.field.${field}`) }) : fieldProblem(field, value)
        if (message) return { status: 409, body: { ok: false, field, error: message } }
      }
      const w = wanted(c, publicKey)
      const from = JSON.stringify([w, publicKey, lang()])
      if (oneshot?.from !== from) {
        const s = oneshotScripts({ wanted: w, publicKey })
        const gzip = (bytes: Uint8Array): Uint8Array => gzipSync(bytes, { level: 9 })
        oneshot = {
          from,
          body: {
            command: oneLine(s.script, gzip),
            script: s.script,
            undoCommand: oneLine(s.undoScript, gzip),
            undoScript: s.undoScript,
          },
        }
      }
      return { status: 200, body: { ok: true, ...oneshot.body } }
    },

    cancel() {
      // a run goes on on the server whatever the board does: it is followed to its end
      if (phase === 'applying' || phase === 'undoing') return refused('busy', null)
      generation += 1
      current?.kill()
      current = null
      busy = false
      phase = 'idle'
      facts = null
      choice = null
      plan = null
      progress = null
      hint = null
      error = null
      testAfter = null
      hostKey = null
      last = null
      target = 'tunnel'
      install = null
      remove = null
      removeLooked = null
      changed()
      return ok()
    },
  }
}
