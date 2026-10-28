// ssh on this computer, for the tunnel (core/tunnel.ts builds its line): which ssh and ssh-keygen,
// the key the board generates and its rights, the server's key pinned on first use, the ssh
// process itself, and the record of its pid that lets a board end the ssh a killed one left. And
// the admin connection's ssh (core/server-admin.ts), with the login's password through an askpass
// of the board's. BOARD_SSH_BIN_PATH and BOARD_SSH_KEYGEN_BIN_PATH name other binaries (tests).
// Nothing here runs through a shell; System32's programs are run by their full path.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { type AskpassReport, pinnedIn, promptKind } from '../core/server-admin.ts'
import { sshHint, type TunnelConfig, type TunnelHint } from '../core/tunnel.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { ROOT, stateDir } from './paths.ts'
import { killTreePid, type RunResult, run } from './process.ts'

export interface BinOptions {
  env?: Record<string, string | undefined>
  platform?: string
  exists?: (p: string) => boolean
  onPath?: (name: string) => string | null
}

/**
 * The variable's binary as it is, never checked (a sandbox's missing file fails as ENOENT and
 * never reaches the real one); on Windows its own OpenSSH by full path, which the board's PATH
 * need not reach and which reads paths and rights as Windows does (Git's MSYS ssh does not); then PATH.
 */
function findBin(name: 'ssh' | 'ssh-keygen', variable: string, o: BinOptions): string | null {
  const { env = process.env, platform = process.platform, exists = existsSync, onPath = n => Bun.which(n) } = o
  const named = env[variable]
  if (named) return named
  if (platform === 'win32') {
    const own = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`)
    if (exists(own)) return own
  }
  return onPath(name)
}

export const sshBin = (o: BinOptions = {}): string | null => findBin('ssh', 'BOARD_SSH_BIN_PATH', o)
export const sshKeygenBin = (o: BinOptions = {}): string | null => findBin('ssh-keygen', 'BOARD_SSH_KEYGEN_BIN_PATH', o)

export const tunnelDir = (): string => join(stateDir(), 'tunnel')
export const generatedKey = (): string => join(tunnelDir(), 'id_ed25519')
/** The board's own known_hosts, never the user's. */
export const knownHostsFile = (): string => join(tunnelDir(), 'known_hosts')
/** knownHostsFile, its folder made: ssh pins a key there only when the folder exists. */
export function knownHostsReady(): string {
  mkdirSync(tunnelDir(), { recursive: true })
  return knownHostsFile()
}
export const sshPidFile = (): string => join(tunnelDir(), 'ssh-pid.json')
/** The key the owner points to (config.json's `tunnel.key`), else the one the board generated. */
export const keyPath = (conf: TunnelConfig): string => conf.key || generatedKey()

const system32 = (file: string): string => join(process.env.SystemRoot || 'C:\\Windows', 'System32', file)
/** What a program said when it failed (its stderr, else its stdout, else why it did not run), lines joined by \n. */
const failure = (r: RunResult): string =>
  (r.stderr.trim() || r.stdout.trim() || r.error?.message || `exit code ${String(r.code)}`).replaceAll('\r\n', '\n')
const NO_KEYGEN = 'ssh-keygen not found'

/**
 * A new Ed25519 pair with no passphrase in tunnel/, the old pair removed first (ssh-keygen would
 * ask before overwriting); on Windows the private key then made the user's alone. The public key.
 */
export async function generateKey(
  comment: string,
): Promise<{ ok: true; publicKey: string } | { ok: false; error: string }> {
  const bin = sshKeygenBin()
  if (!bin) return { ok: false, error: NO_KEYGEN }
  const key = generatedKey()
  mkdirSync(tunnelDir(), { recursive: true })
  rmSync(key, { force: true })
  rmSync(`${key}.pub`, { force: true })
  const made = await run(bin, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', key])
  if (made.code !== 0) return { ok: false, error: failure(made) }
  const rights = await protectKey(key)
  if (!rights.ok) return rights
  try {
    return { ok: true, publicKey: readFileSync(`${key}.pub`, 'utf8').trim() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Windows' ssh refuses a private key others can read ("UNPROTECTED PRIVATE KEY FILE"), and a file
 * inherits its folder's rights: inheritance off, full control to the user alone, named by SID
 * (a user name can be localized or carry a domain). The spike's recipe. Only for the key the
 * board generated (call 8). Elsewhere ssh-keygen's mode 600 does it.
 */
export async function protectKey(file: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (process.platform !== 'win32') return { ok: true }
  // One line: "<computer>\<user>","S-1-5-21-…"
  const who = await run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  const sid = /^"(?:[^"]|"")*","(S-1-[\d-]+)"/m.exec(who.stdout)?.[1]
  if (who.code !== 0 || !sid) return { ok: false, error: `whoami: ${failure(who)}` }
  const set = await run(system32('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`])
  return set.code === 0 ? { ok: true } : { ok: false, error: `icacls: ${failure(set)}` }
}

/** The key's public half, read by ssh-keygen as ssh would read the key (no passphrase, rights checked). */
export async function publicKeyOf(
  key: string,
): Promise<{ ok: true; publicKey: string } | { ok: false; error: string; hint: TunnelHint | null }> {
  const bin = sshKeygenBin()
  if (!bin) return { ok: false, error: NO_KEYGEN, hint: 'noSsh' }
  const r = await run(bin, ['-y', '-P', '', '-f', key])
  if (r.code === 0) return { ok: true, publicKey: r.stdout.trim() }
  if (r.code === 'ENOENT') return { ok: false, error: failure(r), hint: 'noSsh' }
  return { ok: false, error: failure(r), hint: sshHint(r.stderr.split(/\r?\n/)) }
}

/**
 * The fingerprint and type of the key the board's known_hosts pins for this server, 'SHA256:…
 * (ED25519)': the first line ssh-keygen finds for its name (`-F`, plain or hashed: `[host]:port`
 * off port 22, as ssh writes it), whatever other servers the file holds; null when none pins it.
 */
export async function hostKeyFingerprint(host: string, port: number): Promise<string | null> {
  const bin = sshKeygenBin()
  if (!bin || host === '' || !existsSync(knownHostsFile())) return null
  const name = (port === 22 ? host : `[${host}]:${port}`).toLowerCase()
  const r = await run(bin, ['-l', '-F', name, '-f', knownHostsFile()])
  if (r.code !== 0) return null
  // # Host ssh.example.com found: line 3
  // ssh.example.com ED25519 SHA256:…
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\S+\s+(\w+)\s+(SHA256:\S+)\s*$/.exec(line.trim())
    if (m) return `${m[2]} (${m[1]})`
  }
  return null
}

/** "Forget the server's key": the next connection pins the one it meets. */
export function forgetHostKey(): void {
  rmSync(knownHostsFile(), { force: true })
}

export interface SshChild {
  /** 0 when it could not start. */
  pid: number
  /** Each line ssh prints on stderr (its -v lines and its errors), as it comes. */
  onLine(fn: (line: string) => void): void
  /** Its exit code (null when a signal ended it), or why it could not start ('ENOENT'…). */
  exited: Promise<{ code: number | null; error: string | null }>
  /** It and everything it started. */
  kill(): void
  /** It alone, synchronously: for a process.on('exit') handler. */
  killNow(): void
}

/** ssh with this argument list, no shell; stdin and stdout unused. */
export function spawnSsh(bin: string, args: string[]): SshChild {
  const listeners: ((line: string) => void)[] = []
  let done = false
  let settle: (result: { code: number | null; error: string | null }) => void = () => {}
  const exited = new Promise<{ code: number | null; error: string | null }>(resolve => {
    settle = result => {
      if (done) return
      done = true
      resolve(result)
    }
  })
  let child: ChildProcess
  try {
    child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    settle({ code: null, error: String((err as NodeJS.ErrnoException).code ?? (err as Error).message) })
    return { pid: 0, onLine: () => {}, exited, kill: () => {}, killNow: () => {} }
  }
  let rest = ''
  const emit = (line: string): void => {
    if (line) for (const fn of listeners) fn(line)
  }
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) emit(line)
  })
  const finish = (code: number | null): void => {
    if (done) return
    emit(rest.replace(/\r$/, ''))
    rest = ''
    settle({ code, error: null })
  }
  child.on('error', err => settle({ code: null, error: String((err as NodeJS.ErrnoException).code ?? err.message) }))
  // Once its stderr is read to the end; a pipe something else holds open does not keep it waiting.
  child.on('exit', code => setTimeout(() => finish(code), 300).unref?.())
  child.on('close', code => finish(code))
  const pid = child.pid ?? 0
  return {
    pid,
    onLine: fn => listeners.push(fn),
    exited,
    kill: () => {
      if (!done) killTreePid(pid)
    },
    killNow: () => {
      if (done || !pid) return
      try {
        process.kill(pid)
      } catch {}
    },
  }
}

/** How the admin connection's ssh ended: its exit code (null when a signal ended it), or why it did not run ('ENOENT'…) or was ended ('timeout'). */
export interface RemoteEnd {
  code: number | null
  error: string | null
  /** A login by password: what its askpass did. */
  askpass?: AskpassReport
}

/** The admin connection's ssh (core/server-admin.ts): its lines as they come, how it ended, and ending it. */
export interface RemoteRun {
  /**
   * Each line as it comes: from stdout ('out'), all of them, empty ones too (a script's output is
   * data), or from stderr ('err': ssh's and sudo's words), empty ones left out.
   */
  onLine(fn: (line: string, from: 'out' | 'err') => void): void
  done: Promise<RemoteEnd>
  /** It and everything it started. */
  kill(): void
}

/** The askpass helper, run by this Bun (process.execPath): ssh runs SSH_ASKPASS with its prompt as the one argument. */
const ASKPASS_MAIN = join(ROOT, 'src', 'entrypoints', 'askpass.ts')
/**
 * What makes that Bun import the helper: fixed text (the helper's path is in a variable of its
 * own), and `--`, so a prompt is the helper's argument and never an option of Bun's, whatever the
 * server puts in it (`--eval=…`).
 */
const ASKPASS_BUN_OPTIONS = '-e import(process.env.BOARD_ASKPASS_MAIN) --'
/** The most a helper sends: one line, its token and ssh's prompt. */
const ASKPASS_MOST = 16_384

/** The askpass of one ssh: the variables that lead ssh's askpass to it, what it did, and its end. */
export interface Askpass {
  env: Record<string, string>
  report(): AskpassReport
  close(): void
}

/**
 * The channel the askpass helper (entrypoints/askpass.ts) asks on: a listener on loopback that
 * answers only a helper holding its one-time token, which ssh's environment carries to the helper
 * and nowhere else. The login's password goes to the first password prompt only (core/server-admin.ts
 * promptKind); a key's passphrase gets no answer (ssh skips that key); any other prompt, or a
 * second password prompt, gets none either and `refuse` ends ssh before it can send anything for
 * it (call 4). Nothing on disk, nothing in an argument.
 */
export function openAskpass(password: string, refuse: () => void, bun: string = process.execPath): Askpass {
  const token = Buffer.from(randomBytes(32).toString('hex'))
  let answered = 0
  let refused: string | null = null
  let closed = false
  // what each helper sent so far, as bytes: a character cut between two chunks is read whole
  const heard = new WeakMap<object, Buffer>()
  const theirs = (v: unknown): boolean => {
    if (typeof v !== 'string') return false
    const given = Buffer.from(v)
    return given.length === token.length && timingSafeEqual(given, token)
  }
  /** The answer: the password, null for none (the helper fails), undefined to say nothing (ssh is ended). */
  const answer = (prompt: string): string | null | undefined => {
    if (closed || refused !== null) return undefined
    const kind = promptKind(prompt)
    if (kind === 'passphrase') return null
    if (kind === 'password' && answered === 0) {
      answered++
      return password
    }
    refused = prompt
    refuse()
    return undefined
  }
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        const bytes = Buffer.concat([heard.get(socket) ?? Buffer.alloc(0), chunk])
        const at = bytes.indexOf(0x0a)
        if (at < 0) {
          if (bytes.length > ASKPASS_MOST) socket.end()
          else heard.set(socket, bytes)
          return
        }
        heard.delete(socket)
        let ask: unknown
        try {
          ask = JSON.parse(bytes.subarray(0, at).toString('utf8'))
        } catch {
          ask = null
        }
        if (!isRecord(ask) || !theirs(ask.token) || typeof ask.prompt !== 'string') {
          socket.end()
          return
        }
        const said = answer(ask.prompt)
        if (said !== undefined) socket.end(`${JSON.stringify({ answer: said })}\n`)
      },
      error() {},
    },
  })
  return {
    env: {
      SSH_ASKPASS: bun,
      SSH_ASKPASS_REQUIRE: 'force',
      BUN_OPTIONS: ASKPASS_BUN_OPTIONS,
      BOARD_ASKPASS_MAIN: ASKPASS_MAIN,
      BOARD_ASKPASS_PORT: String(listener.port),
      BOARD_ASKPASS_TOKEN: token.toString(),
    },
    report: () => ({ answered, refused }),
    close: () => {
      if (closed) return
      closed = true
      listener.stop(true)
    },
  }
}

/** `ssh -V`'s line (ssh says it on stderr), or why it did not say it; asked each time (an ssh may be updated). */
export async function sshVersion(bin: string): Promise<string> {
  const r = await run(bin, ['-V'], { timeout: 10_000 })
  return (r.stderr.trim() || r.stdout.trim() || r.error?.message || '').split(/\r?\n/)[0] ?? ''
}

/**
 * The ssh of each login by password now running: in a session of its own on POSIX (spawnRemote),
 * so the board's end, or a Ctrl+C in its terminal, does not reach it by itself.
 */
const loginPids = new Set<number>()

/**
 * The board stops: the ssh of each login by password still running ended, its askpass helper with
 * it (also from a process.on('exit') handler). Any other ssh is left as before.
 */
export function endLogins(): void {
  for (const pid of loginPids) killTreePid(pid)
  loginPids.clear()
}

/**
 * ssh with this argument list, no shell: stdout and stderr read by line; `stdin` written, then
 * closed (null: closed at once), so the sudo password is on ssh's stdin and nowhere else; ended
 * after `timeoutMs`. With `login`, its password goes to ssh through the board's askpass
 * (openAskpass), and ssh runs in the board's tunnel folder (no .env or bunfig of another folder
 * for the helper's Bun) and, on POSIX, in a session of its own: no terminal to prompt on, and its
 * end ends the helper too.
 */
export function spawnRemote(
  bin: string,
  args: string[],
  stdin: string | null,
  timeoutMs: number,
  login: { password: string } | null = null,
): RemoteRun {
  const listeners: ((line: string, from: 'out' | 'err') => void)[] = []
  let done = false
  let why: string | null = null
  let deadline: ReturnType<typeof setTimeout> | undefined
  let askpass: Askpass | null = null
  let settle: (result: RemoteEnd) => void = () => {}
  const ended = new Promise<RemoteEnd>(resolve => {
    settle = result => {
      if (done) return
      done = true
      clearTimeout(deadline)
      loginPids.delete(pid)
      askpass?.close()
      resolve(askpass ? { ...result, askpass: askpass.report() } : result)
    }
  })
  let child: ChildProcess
  let pid = 0
  try {
    if (login) {
      askpass = openAskpass(login.password, () => {
        if (!done && pid) killTreePid(pid)
      })
      mkdirSync(tunnelDir(), { recursive: true })
    }
    child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(askpass && {
        env: { ...process.env, ...askpass.env },
        cwd: tunnelDir(),
        detached: process.platform !== 'win32',
      }),
    })
  } catch (err) {
    settle({ code: null, error: String((err as NodeJS.ErrnoException).code ?? (err as Error).message) })
    return { onLine: () => {}, done: ended, kill: () => {} }
  }
  pid = child.pid ?? 0
  if (askpass && pid && !done) loginPids.add(pid)
  const kill = (): void => {
    if (!done && pid) killTreePid(pid)
  }
  deadline = setTimeout(() => {
    why = 'timeout'
    kill()
  }, timeoutMs)
  const rest = { out: '', err: '' }
  const emit = (line: string, from: 'out' | 'err'): void => {
    if (line || from === 'out') for (const fn of listeners) fn(line, from)
  }
  const read = (from: 'out' | 'err') => (chunk: string) => {
    const lines = (rest[from] + chunk).split(/\r?\n/)
    rest[from] = lines.pop() ?? ''
    for (const line of lines) emit(line, from)
  }
  const out = read('out')
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    // the server's first output: ssh is logged in, no prompt is to come, so the askpass's channel
    // closes now rather than at ssh's end (a run's ssh lasts minutes); what it did is kept
    askpass?.close()
    out(chunk)
  })
  child.stderr?.setEncoding('utf8').on('data', read('err'))
  // ssh may end before it reads stdin (a refused key): that write's EPIPE is no error of ours
  child.stdin?.on('error', () => {})
  if (stdin !== null) child.stdin?.write(stdin)
  child.stdin?.end()
  const finish = (code: number | null): void => {
    if (done) return
    // what came after the last line break is a line too, when there is any
    for (const from of ['out', 'err'] as const) {
      const tail = rest[from].replace(/\r$/, '')
      rest[from] = ''
      if (tail) emit(tail, from)
    }
    settle({ code, error: why })
  }
  child.on('error', err => settle({ code: null, error: String((err as NodeJS.ErrnoException).code ?? err.message) }))
  // Once its output is read to the end; a pipe something else holds open does not keep it waiting.
  child.on('exit', code => setTimeout(() => finish(code), 300).unref?.())
  child.on('close', code => finish(code))
  return { onLine: fn => listeners.push(fn), done: ended, kill }
}

/** Whether the board's known_hosts pins the server's key for this host and port (Test connection pinned it). */
export async function hostKeyPinned(host: string, port: number): Promise<boolean> {
  try {
    return pinnedIn(await readFile(knownHostsFile(), 'utf8'), host, port)
  } catch {
    return false
  }
}

/** The tunnel's ssh, recorded so the next board can end it if this one dies without doing so. */
export interface PidRecord {
  pid: number
  /** `-R`'s value: what tells this ssh from another program that got its pid later. */
  forward: string
  at: number
}

const isPidRecord = (v: unknown): v is PidRecord =>
  isRecord(v) &&
  Number.isInteger(v.pid) &&
  Number(v.pid) > 0 &&
  typeof v.forward === 'string' &&
  v.forward !== '' &&
  typeof v.at === 'number'

export function readPidRecord(): PidRecord | null {
  return readJson(sshPidFile(), isPidRecord)
}

/** The record, or none (null). */
export function writePidRecord(r: PidRecord | null): void {
  if (r) mkdirSync(tunnelDir(), { recursive: true })
  else if (!existsSync(sshPidFile())) return
  updateJson<PidRecord>(sshPidFile(), () => r, isPidRecord, { mode: 0o600 })
}

/** The command line a process runs with; null when it is gone (or cannot be read). */
export async function commandLineOf(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() || null
    } catch {
      return null
    }
  }
  const r =
    process.platform === 'win32'
      ? await run(system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe')), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ])
      : await run('/bin/ps', ['-p', String(pid), '-o', 'command='])
  return (r.code === 0 && r.stdout.trim()) || null
}

/** A process of ours runs under the pid (another user's, which we may not signal, counts as none). */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a command line carries `forward` as an argument of its own: after a space, a quote or
 * the start, and before a space, a quote or the end (port 1242 is not 12420, nor /a.sock /x/a.sock).
 */
function hasArgument(line: string, forward: string): boolean {
  for (let at = line.indexOf(forward); at >= 0; at = line.indexOf(forward, at + 1)) {
    const before = at === 0 ? '' : (line[at - 1] ?? '')
    const after = line[at + forward.length] ?? ''
    if (/^[\s"']?$/.test(before) && /^[\s"']?$/.test(after)) return true
  }
  return false
}

/**
 * Ends a recorded ssh that still runs with this forward (its tree), waiting up to `waitMs` for it
 * to go. True: no ssh of ours runs under the pid (it is gone, or another program has the pid).
 * False: ours still runs, or something runs under the pid and its command line could not be read.
 * `kill` and `commandLine` are for tests.
 */
export async function endStraySsh(
  r: PidRecord,
  o: { kill?: (pid: number) => void; commandLine?: (pid: number) => Promise<string | null>; waitMs?: number } = {},
): Promise<boolean> {
  const { kill = killTreePid, commandLine = commandLineOf, waitMs = 5000 } = o
  const line = await commandLine(r.pid)
  if (line === null) return !running(r.pid)
  if (!hasArgument(line, r.forward)) return true
  kill(r.pid)
  for (const deadline = Date.now() + waitMs; running(r.pid) && Date.now() < deadline; )
    await new Promise(resolve => setTimeout(resolve, 50))
  return !running(r.pid)
}

/** The admin connection's ssh with its stdin and stdout as streams of bytes (the profile sync's frames). */
export interface RemoteStream {
  /** ssh's stdin: written, then ended. */
  stdin: Writable
  /** ssh's stdout, as the server sends it. */
  stdout: Readable
  /** Each line ssh (or sudo) says on stderr, empty ones left out. */
  onErr(fn: (line: string) => void): void
  done: Promise<RemoteEnd>
  /** It and everything it started. */
  kill(): void
}

/**
 * ssh with this argument list, no shell, as spawnRemote runs one (its askpass, its own session,
 * its end with the board's, its limit), with stdin and stdout left to the caller as bytes. The
 * askpass's channel closes with the server's first bytes. spawnRemote stays as it is.
 */
export function spawnRemoteStream(
  bin: string,
  args: string[],
  timeoutMs: number,
  login: { password: string } | null = null,
): RemoteStream {
  const listeners: ((line: string) => void)[] = []
  const stdout = new PassThrough()
  let done = false
  let why: string | null = null
  let deadline: ReturnType<typeof setTimeout> | undefined
  let askpass: Askpass | null = null
  let pid = 0
  let settle: (result: RemoteEnd) => void = () => {}
  const ended = new Promise<RemoteEnd>(resolve => {
    settle = result => {
      if (done) return
      done = true
      clearTimeout(deadline)
      loginPids.delete(pid)
      askpass?.close()
      resolve(askpass ? { ...result, askpass: askpass.report() } : result)
    }
  })
  let child: ChildProcess
  try {
    if (login) {
      askpass = openAskpass(login.password, () => {
        if (!done && pid) killTreePid(pid)
      })
      mkdirSync(tunnelDir(), { recursive: true })
    }
    child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(askpass && {
        env: { ...process.env, ...askpass.env },
        cwd: tunnelDir(),
        detached: process.platform !== 'win32',
      }),
    })
  } catch (err) {
    settle({ code: null, error: String((err as NodeJS.ErrnoException).code ?? (err as Error).message) })
    stdout.end()
    const sink = new PassThrough()
    sink.resume()
    return { stdin: sink, stdout, onErr: () => {}, done: ended, kill: () => {} }
  }
  pid = child.pid ?? 0
  if (askpass && pid && !done) loginPids.add(pid)
  const kill = (): void => {
    if (!done && pid) killTreePid(pid)
  }
  deadline = setTimeout(() => {
    why = 'timeout'
    kill()
  }, timeoutMs)
  child.stdout?.on('data', (chunk: Buffer) => {
    askpass?.close()
    if (!stdout.write(chunk)) {
      child.stdout?.pause()
      stdout.once('drain', () => child.stdout?.resume())
    }
  })
  child.stdout?.on('end', () => stdout.end())
  let rest = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) if (line) for (const fn of listeners) fn(line)
  })
  // ssh may end before it reads all of stdin (a refused login): that write's EPIPE is no error of ours
  child.stdin?.on('error', () => {})
  const finish = (code: number | null): void => {
    if (done) return
    const tail = rest.replace(/\r$/, '')
    rest = ''
    if (tail) for (const fn of listeners) fn(tail)
    stdout.end()
    settle({ code, error: why })
  }
  child.on('error', err => {
    stdout.end()
    settle({ code: null, error: String((err as NodeJS.ErrnoException).code ?? err.message) })
  })
  // once its output is read to the end (the reader may be slower than ssh); a pipe something else
  // holds open does not keep it waiting past 10 seconds
  child.on('exit', code => setTimeout(() => finish(code), 10_000).unref?.())
  child.on('close', code => finish(code))
  return { stdin: child.stdin as Writable, stdout, onErr: fn => listeners.push(fn), done: ended, kill }
}
