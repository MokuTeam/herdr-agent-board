// ssh on this computer, for the tunnel (core/tunnel.ts builds its line): which ssh and ssh-keygen,
// the key the board generates and its rights, the server's key pinned on first use, the ssh
// process itself, and the record of its pid that lets a board end the ssh a killed one left.
// BOARD_SSH_BIN_PATH and BOARD_SSH_KEYGEN_BIN_PATH name other binaries (tests). Nothing here runs
// through a shell; System32's programs are run by their full path.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { sshHint, type TunnelConfig, type TunnelHint } from '../core/tunnel.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'
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

/** The pinned server key's fingerprint and type, 'SHA256:… (ED25519)'; null before the first connection. */
export async function hostKeyFingerprint(): Promise<string | null> {
  const bin = sshKeygenBin()
  if (!bin || !existsSync(knownHostsFile())) return null
  const r = await run(bin, ['-l', '-f', knownHostsFile()])
  if (r.code !== 0) return null
  // 256 SHA256:… ssh.example.com (ED25519)
  const first = r.stdout.split(/\r?\n/).find(line => line.trim())
  const m = first && /(SHA256:\S+)\s.*\((\w+)\)\s*$/.exec(first)
  return m ? `${m[1]} (${m[2]})` : null
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

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Ends a recorded ssh that still runs with this forward (its tree), waiting up to `waitMs` for it
 * to go; true once it is gone. False: another program has the pid, nothing does, or the ssh still
 * runs. `kill` is for tests.
 */
export async function endStraySsh(
  r: PidRecord,
  o: { kill?: (pid: number) => void; waitMs?: number } = {},
): Promise<boolean> {
  const { kill = killTreePid, waitMs = 5000 } = o
  const line = await commandLineOf(r.pid)
  if (!line?.includes(r.forward)) return false
  kill(r.pid)
  for (const deadline = Date.now() + waitMs; running(r.pid) && Date.now() < deadline; )
    await new Promise(resolve => setTimeout(resolve, 50))
  return !running(r.pid)
}
