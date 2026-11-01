// The owner's Vaultwarden as the board sees it (core/vault.ts), on its own server: whether it has
// the owner's account yet (its database, read only), signups closed once it has (its environment
// file's SIGNUPS_ALLOWED to false and its unit restarted, the board's own refusal of a register
// meanwhile, server/tunnel.ts), and the official Bitwarden CLI that opens it for a login fill
// (services/login-fill.ts): its data in the board's state folder (0700), its server Vaultwarden on
// 127.0.0.1. The master password goes to `bw` on its stdin (no argument, no environment, no file),
// the session it gives back in its BW_SESSION only, kept in this process's memory; no value bw
// prints is logged or said, its errors in the board's words.
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import type { RunResult } from '../adapters/process.ts'
import type { FillMatch } from '../core/login-fill.ts'
import { envOn, envSetting, type VaultConfig, vaultServerUrl, withEnvSetting } from '../core/vault.ts'

export type Runner = (
  file: string,
  args: string[],
  o: { env: Record<string, string>; input?: string; timeout: number },
) => Promise<RunResult>

export interface VaultOptions {
  cfg(): VaultConfig | null
  log(line: string): void
  /** Programs (bw, systemctl): tests hand in their own. */
  run?: Runner
  /** bw's own folder (BITWARDENCLI_APPDATA_DIR); the state folder's vault/bw by default. */
  appdata?: string
}

/** Why bw did not open the vault, in the board's words: the master password, the account's two-step code, or anything else. */
export type BwRefusal = 'password' | 'code' | 'noaccount' | 'missing' | 'failed'

export type Unlocked = { ok: true; session: string } | { ok: false; why: BwRefusal }

export interface VaultItemSecret {
  username: string
  password: string
  /** The item has a TOTP secret (its code is read by bw get totp). */
  totp: boolean
}

export interface Vault {
  config(): VaultConfig | null
  /** Vaultwarden's port, for the domain's proxy; null without config.json's `vault`. */
  port(): number | null
  /** Its certificate on 127.0.0.1 (PEM), which the proxy trusts alone; null when it cannot be read. */
  ca(): string | null
  /** The accounts in it (its database), and the first one's e-mail; null when its database cannot be read. */
  accounts(): { count: number; email: string | null } | null
  /** No account yet (or no database yet): a register goes through. */
  signupsOpen(): boolean
  /** A register went through: signups close once the account is there. */
  registered(): void
  /** Signups off in Vaultwarden's settings once it has an account, and it restarted: whether it changed anything. */
  closeSignups(): Promise<boolean>
  /** Whether bw has signed in to the vault yet (unauthenticated: the first approval signs in, its two-step code maybe too). */
  signedIn(): Promise<boolean>
  /** Opens the vault with the owner's master password (and the account's two-step code, signing in the first time). */
  unlock(password: string, code?: string): Promise<Unlocked>
  sync(session: string): Promise<boolean>
  /** The vault's logins that match the page's address, as Bitwarden's own matching has them; null when bw failed. */
  matches(session: string, url: string): Promise<(FillMatch & { uris: string[] })[] | null>
  /** One item's username and password; null when bw failed. */
  secret(session: string, id: string): Promise<VaultItemSecret | null>
  /** The item's current TOTP code; null when it has none or bw failed. */
  totp(session: string, id: string): Promise<string | null>
  /** Locked again: the session bw gave is no use any more. */
  lock(): Promise<void>
  close(): void
}

/** How long bw may take for one command (a sync of a large vault, a login's key derivation). */
const BW_MS = 90_000
/** The database looked at again at most this often. */
const ACCOUNTS_MS = 3000
/** Signups looked at again this often while the board runs (an account made while it was down). */
const SIGNUPS_MS = 10 * 60_000

export function createVault(o: VaultOptions): Vault {
  const run: Runner = o.run ?? spawnRun
  const appdata = o.appdata ?? join(stateDir(), 'vault', 'bw')
  let cache: { at: number; value: { count: number; email: string | null } | null } | null = null
  let closing: Promise<boolean> | null = null
  /** Vaultwarden's certificate as last read, again when its file changes. */
  let cert: { path: string; mtime: number; pem: string } | null = null

  function accounts(): { count: number; email: string | null } | null {
    const c = o.cfg()
    if (!c) return null
    if (cache && Date.now() - cache.at < ACCOUNTS_MS) return cache.value
    const file = join(c.data, 'db.sqlite3')
    let value: { count: number; email: string | null } | null
    if (!existsSync(file)) value = { count: 0, email: null }
    else {
      let db: Database | null = null
      try {
        db = new Database(file, { readonly: true })
        const rows = db.query('SELECT email FROM users ORDER BY created_at').all() as { email: unknown }[]
        const first = rows[0]?.email
        value = { count: rows.length, email: typeof first === 'string' ? first : null }
      } catch (err) {
        // a database being made (no users table yet) has no account either
        value = /no such table/i.test(String(err)) ? { count: 0, email: null } : null
        if (!value) o.log(`vault: its database: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        db?.close()
      }
    }
    cache = { at: Date.now(), value }
    return value
  }

  async function closeNow(): Promise<boolean> {
    const c = o.cfg()
    if (!c) return false
    cache = null
    const a = accounts()
    if (!a || a.count === 0) return false
    let env: string
    try {
      env = readFileSync(c.env, 'utf8')
    } catch {
      return false
    }
    if (!envOn(envSetting(env, 'SIGNUPS_ALLOWED'))) return false
    const tmp = `${c.env}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, withEnvSetting(env, 'SIGNUPS_ALLOWED', 'false'), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, c.env)
    } catch (err) {
      o.log(`vault: signups not closed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    const r = await run(systemctl(), ['--user', 'restart', c.unit], { env: systemEnv(), timeout: 60_000 })
    o.log(
      r.code === 0
        ? `vault: the owner's account is there: signups closed, ${c.unit} restarted`
        : `vault: signups closed in ${c.env}; restarting ${c.unit} failed (${String(r.code)})`,
    )
    return true
  }

  function closeSignups(): Promise<boolean> {
    closing ??= closeNow().finally(() => {
      closing = null
    })
    return closing
  }

  const timer = setInterval(() => void closeSignups(), SIGNUPS_MS)
  timer.unref?.()
  // as the board starts: an account made while it was down; and the Bitwarden CLI's vault locked, which
  // a board before may have left open (kept unlocked as it ended: that session went with it)
  const first = setTimeout(() => {
    void closeSignups()
    if (o.cfg() && existsSync(join(appdata, 'data.json'))) void bw(['lock'])
  }, 2000)
  first.unref?.()

  function bwEnv(c: VaultConfig, session?: string): Record<string, string> {
    mkdirSync(appdata, { recursive: true, mode: 0o700 })
    try {
      chmodSync(appdata, 0o700)
    } catch {}
    return {
      HOME: process.env.HOME ?? homedir(),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      BITWARDENCLI_APPDATA_DIR: appdata,
      // Vaultwarden's own certificate on 127.0.0.1: the CLI takes HTTPS only
      NODE_EXTRA_CA_CERTS: c.cert,
      BW_NOINTERACTION: 'true',
      BW_NO_COLOR: 'true',
      NODE_NO_WARNINGS: '1',
      ...(session && { BW_SESSION: session }),
    }
  }

  /** One bw at a time: its data file is one. */
  let chain: Promise<unknown> = Promise.resolve()
  function bw(args: string[], r: { session?: string; input?: string } = {}): Promise<RunResult> {
    const next = chain.then(async (): Promise<RunResult> => {
      const c = o.cfg()
      if (!c) return { code: 'ENOENT', killed: false, error: null, stdout: '', stderr: '' }
      const res = await run(c.bw, args, {
        env: bwEnv(c, r.session),
        timeout: BW_MS,
        ...(r.input !== undefined && { input: r.input }),
      })
      return res.killed ? { ...res, code: 'timeout' } : res
    })
    chain = next.catch(() => {})
    return next
  }

  const jsonOf = (r: RunResult): unknown => {
    if (r.code !== 0) return null
    try {
      return JSON.parse(r.stdout)
    } catch {
      return null
    }
  }

  async function status(): Promise<{ status: string; serverUrl: string | null } | null> {
    const st = jsonOf(await bw(['status']))
    if (!isRecord(st) || typeof st.status !== 'string') return null
    return { status: st.status, serverUrl: typeof st.serverUrl === 'string' ? st.serverUrl : null }
  }

  /** bw's words for a refusal, read for its kind only. */
  const refusal = (r: RunResult): BwRefusal => {
    if (r.code === 'ENOENT') return 'missing'
    const said = `${r.stderr}\n${r.stdout}`
    if (/two-step|two factor|2fa|code is required|verification code|new device/i.test(said)) return 'code'
    if (/master password|password is incorrect|invalid.*password|username or password/i.test(said)) return 'password'
    return 'failed'
  }

  return {
    config: () => o.cfg(),
    port: () => o.cfg()?.port ?? null,
    ca() {
      const c = o.cfg()
      if (!c) return null
      try {
        const mtime = statSync(c.cert).mtimeMs
        if (cert?.path !== c.cert || cert.mtime !== mtime)
          cert = { path: c.cert, mtime, pem: readFileSync(c.cert, 'utf8') }
        return cert.pem.includes('BEGIN CERTIFICATE') ? cert.pem : null
      } catch {
        return null
      }
    },
    accounts,
    signupsOpen() {
      const a = accounts()
      return !!a && a.count === 0
    },
    registered() {
      cache = null
      setTimeout(() => void closeSignups(), 1500).unref?.()
    },
    closeSignups,

    async signedIn() {
      const st = await status()
      return !!st && st.status !== 'unauthenticated'
    },

    async unlock(password, code) {
      const c = o.cfg()
      if (!c) return { ok: false, why: 'missing' }
      if (!existsSync(c.bw)) return { ok: false, why: 'missing' }
      const st = await status()
      if (!st) return { ok: false, why: 'failed' }
      const input = `${password}\n`
      let r: RunResult
      if (st.status === 'unauthenticated') {
        const url = vaultServerUrl(c)
        if (st.serverUrl !== url) {
          const set = await bw(['config', 'server', url])
          if (set.code !== 0) return { ok: false, why: 'failed' }
        }
        const email = accounts()?.email
        if (!email) return { ok: false, why: 'noaccount' }
        const two = code?.trim() ? ['--method', '0', '--code', code.trim()] : []
        r = await bw(['login', email, '--passwordfile', '/dev/stdin', '--raw', ...two], { input })
      } else {
        r = await bw(['unlock', '--passwordfile', '/dev/stdin', '--raw'], { input })
      }
      const session = r.code === 0 ? r.stdout.trim() : ''
      if (!session || /\s/.test(session)) return { ok: false, why: refusal(r) }
      return { ok: true, session }
    },

    async sync(session) {
      return (await bw(['sync'], { session })).code === 0
    },

    async matches(session, url) {
      const list = jsonOf(await bw(['list', 'items', '--url', url], { session }))
      if (!Array.isArray(list)) return null
      const out: (FillMatch & { uris: string[] })[] = []
      for (const it of list) {
        if (!isRecord(it) || it.type !== 1 || typeof it.id !== 'string' || !isRecord(it.login)) continue
        if (it.deletedDate) continue
        const uris = Array.isArray(it.login.uris)
          ? it.login.uris.flatMap(u => (isRecord(u) && typeof u.uri === 'string' ? [u.uri] : []))
          : []
        out.push({
          id: it.id,
          name: typeof it.name === 'string' ? it.name : '',
          username: typeof it.login.username === 'string' ? it.login.username : '',
          totp: typeof it.login.totp === 'string' && it.login.totp !== '',
          uris,
        })
      }
      return out
    },

    async secret(session, id) {
      if (!/^[\w-]{1,64}$/.test(id)) return null
      const it = jsonOf(await bw(['get', 'item', id], { session }))
      if (!isRecord(it) || !isRecord(it.login)) return null
      return {
        username: typeof it.login.username === 'string' ? it.login.username : '',
        password: typeof it.login.password === 'string' ? it.login.password : '',
        totp: typeof it.login.totp === 'string' && it.login.totp !== '',
      }
    },

    async totp(session, id) {
      if (!/^[\w-]{1,64}$/.test(id)) return null
      const r = await bw(['get', 'totp', id], { session })
      const code = r.code === 0 ? r.stdout.trim() : ''
      return /^\d{4,10}$/.test(code) ? code : null
    },

    async lock() {
      await bw(['lock'])
    },

    close() {
      clearInterval(timer)
      clearTimeout(first)
    },
  }
}

/**
 * A program run to its end, its input (the master password) on a stdin it can open as a file
 * (`--passwordfile /dev/stdin`): a memory file of Bun's, never on disk (node's spawn gives a socket,
 * which /dev/stdin cannot open); ended at its timeout.
 */
async function spawnRun(
  file: string,
  args: string[],
  o: { env: Record<string, string>; input?: string; timeout: number },
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([file, ...args], {
      env: o.env,
      stdin: o.input === undefined ? 'ignore' : new Blob([o.input]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    const e = err as Error & { code?: string }
    return { code: e.code ?? 'ENOENT', killed: false, error: e, stdout: '', stderr: '' }
  }
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    proc.kill('SIGKILL')
  }, o.timeout)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, killed, error: null, stdout, stderr }
}

/** systemctl, also where the board's PATH does not have it. */
function systemctl(): string {
  return Bun.which('systemctl') ?? ['/usr/bin/systemctl', '/bin/systemctl'].find(p => existsSync(p)) ?? 'systemctl'
}

/** systemctl --user's environment: the user's own bus. */
function systemEnv(): Record<string, string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`
  return {
    HOME: process.env.HOME ?? homedir(),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${join(runtime, 'bus')}`,
  }
}
