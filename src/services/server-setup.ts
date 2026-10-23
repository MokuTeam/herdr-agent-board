// Setting up the server's web server through the owner's admin connection (the server-setup spec's
// "The admin connection", "Look", "Apply" and "Undo"): the admin's fields in config.json; Look (a
// probe as the admin for the sudo it needs, then two rounds as root that only read) and the plan
// from what it found; Apply or Undo of that plan as one script the server runs by itself, followed
// line by line; config.json's summary of the setup (and case 4's public port) after; Test
// connection until the domain answers. Only the local board reaches this (remote-access.ts).
//
// The passwords are the page's (the simple-setup spec's "The admin login by password"): the
// login's (`password`, also sudo's, call 3) and sudo's own when it differs (`sudoPassword`). They
// come with each Look, Apply or Undo; the login's goes to ssh's askpass (adapters/ssh.ts), once
// per ssh, sudo's to ssh's stdin, once per spawn. Kept in memory only while that request (or that
// run, to mask a line that would hold one) lasts; never in config.json, web.log, the view, an
// answer or a command line. Without a password the login is the keys' alone, its ssh line as
// before the password login.
//
// With the board's own public key, Look reads step 1's parts too and Apply makes what the server
// lacks of them (the tunnel user, the socket's folder, the keys file, sshd's fence). A run travels
// packed (gzip, then base64): the plans that make step 1 too are past a Windows command line else.
import { gzipSync } from 'node:zlib'
import { editTunnel, editTunnelAdmin, setTunnelSetup } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import type { RemoteRun, spawnRemote } from '../adapters/ssh.ts'
import { t } from '../core/lang.ts'
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
  takesAskpass,
} from '../core/server-admin.ts'
import type { ServerFacts } from '../core/server-facts.ts'
import { type LookInput, lookScript1, lookScript2, readRoundOne, readServerFacts } from '../core/server-look.ts'
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
import { launchScript, type Progress, readProgress, runScript, startProgress } from '../core/server-script.ts'
import { type Acme, PORT_4 } from '../core/server-texts.ts'
import type { AdminHint, ServerPhase, ServerView, SudoMode } from '../core/server-view.ts'
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
}

/** What Look, Apply and Undo carry of the passwords: the login's (sudo's too), and sudo's own. */
export type Passwords = {
  password?: unknown
  sudoPassword?: unknown
}

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
}

interface Heard {
  code: number | null
  error: string | null
  out: string[]
  err: string[]
  /** What the askpass did, for a login by password. */
  askpass: AskpassReport | null
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

  const tunnel = (): Fields => (isRecord(cfg.tunnel) ? cfg.tunnel : {})
  const conf = (): TunnelConfig => tunnelConfig(cfg.tunnel)
  const admin = (): Admin => adminConfig(tunnel().admin)
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

  function writeSetup(s: Setup | null): void {
    setTunnelSetup(s)
    mirror(x => {
      if (s) x.setup = { ...(isRecord(x.setup) ? x.setup : {}), ...s }
      else delete x.setup
    })
  }

  function writePublicPort(port: number | null): void {
    editTunnel({ publicPort: port })
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

  /** What Look, Apply and Undo need before any ssh: the admin's fields, the tunnel's server and pair, ssh itself. */
  function ready(): Answer | { bin: string; c: TunnelConfig; a: Admin } {
    const a = admin()
    const problem = adminProblems(a)[0]
    if (problem) return { status: 409, body: { ok: false, hint: null, field: problem.field, error: problem.message } }
    const c = conf()
    for (const field of ['host', 'user', 'socket', 'domain'] as const) {
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

  /** One ssh to the admin, its lines kept (a line holding a password masked); with `pin`, this login pins the server's key (call 2). */
  async function hear(
    to: { bin: string; c: TunnelConfig; a: Admin },
    command: string,
    stdin: string | null,
    ms: number,
    login: Login,
    secrets: readonly string[],
    pin = false,
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
    current = run
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null }
    run.onLine((line, from) => heard[from === 'err' ? 'err' : 'out'].push(mask(line, secrets)))
    const end = await run.done
    if (current === run) current = null
    return { ...heard, code: end.code, error: end.error, askpass: end.askpass ?? null }
  }

  const mask = (line: string, secrets: readonly string[]): string =>
    secrets.reduce((l, secret) => (secret ? l.replaceAll(secret, MASK) : l), line)

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
    const detail = detailOf(asked === null ? h.err : [...h.err, t('server.err.prompt', { prompt: asked.trim() })])
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

  /** The server's key for the view once a login met it: its fingerprint, and whether this Look pinned it. */
  async function keyMet(pinnedNow: boolean): Promise<ServerView['hostKey']> {
    const fingerprint = await d.hostKeyFingerprint()
    return fingerprint ? { fingerprint, pinnedNow } : null
  }

  async function lookAt(o: Fields, kind: 'look' | 'undo'): Promise<Answer> {
    const pw = passwordsOf(o)
    if ('status' in pw) return pw
    const { password, sudoPassword } = pw
    if (busy) return refused('busy', null)
    const to = ready()
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
    changed()
    try {
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
      const key = await boardKey()
      if (gone()) return cancelled()
      const input: LookInput = {
        user: c.user,
        socket: c.socket,
        domain: c.domain,
        ...(key !== null && { publicKey: key }),
      }
      // each round as root, sudo's password (when it asks one) on stdin once: one sudo try per click
      const round = async (script: string): Promise<string | Answer> => {
        const h = await hear(to, remoteCommand(script, read.mode), stdin, ROUND_MS, login, secrets)
        if (gone()) return cancelled()
        if (h.code === 0) return h.out.join('\n')
        const why = stopped(h, login, sudoFrom)
        return stopLook(why.hint, why.detail)
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
      return planFrom(f, c, to.a, read.mode, kind, key)
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
  ): Answer {
    const w = wanted(c, key)
    const record = f.record === null || f.record === undefined ? null : setupRecord(f.record)
    const ours = record && whose(record, w) !== 'other' ? record : null
    // set up from another PC or before a reinstall: the panel's summary from the server's record
    if (ours?.state === 'applied' && !setupOf()) writeSetup({ case: ours.case, address: ours.address, at: ours.at })
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
    last = plan ? { plan, facts: f, record: ours, wanted: w, admin: a, mode } : null
    changed()
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
      if (testAfter.some(s => s.id === 'domain' && s.ok === true)) return
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
        error = detailOf(heard.err)
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
    const heard: Heard = { code: null, error: null, out: [], err: [], askpass: null }
    child.onLine((raw, from) => {
      const line = mask(raw, secrets)
      if (from === 'err') {
        heard.err.push(line)
        return
      }
      heard.out.push(line)
      if (heard.out.length > OUT_KEPT) heard.out.shift()
      if (!progress) return
      const now = d.now()
      const was = progress
      progress = readProgress(was, line, now)
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
    undoLook: o => lookAt(o, 'undo'),
    apply: o => runPlan(o, 'look'),
    undo: o => runPlan(o, 'undo'),

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
      changed()
      return ok()
    },
  }
}
