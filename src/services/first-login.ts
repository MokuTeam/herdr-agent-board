// The first login on the board's own server (core/on-server.ts). `board login link` (the installer
// runs it) makes a one-time code: 24 random bytes, kept in the state folder as its hash only
// (adapters/access-store.ts), working once within an hour, one at a time. The link carries it in
// its fragment; the setup page (server/setup-page.ts) posts it to the login listener, which takes
// it up here and opens a setup of 10 minutes (as long as a TOTP secret being set up waits): a new
// TOTP secret to scan, then the password and the secret's first code together. Once both are set
// the login is the board's usual one (services/access.ts), and the setup page is closed until
// `board login reset` clears the password, the code and the passkeys, ends every login, and makes
// a new link. The code and the setup's token are never logged or written down as they are.
// Also what `board doctor` finds of the server mode.
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import {
  accessReady,
  clearSetupCode,
  clearSignIn,
  takeSetupCode,
  updateLogins,
  writeSetupCode,
} from '../adapters/access-store.ts'
import { isRecord } from '../adapters/json-store.ts'
import {
  SETUP_CODE,
  SETUP_CODE_BYTES,
  SETUP_CODE_MS,
  type ServerMode,
  type ServerModeFacts,
  serverModeProblems,
  setupLink,
} from '../core/on-server.ts'
import type { Access } from './access.ts'
import { hashToken } from './remote.ts'

/** A setup, once the link's code is taken, lasts as long as a TOTP secret being set up waits. */
const SETUP_MS = 10 * 60_000
const SETUP_TOKEN_BYTES = 32
/** How long `board doctor` and `board login reset` wait for the board's answer. */
const ANSWER_MS = 3000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export type SetupStart =
  | { ok: true; setup: string; secret: string; uri: string }
  | { ok: false; status: 401; error: 'link' }

export type SetupFinish =
  | { ok: true }
  | { ok: false; status: 401; error: 'setup' }
  | { ok: false; status: 400; error: 'password' | 'code'; message: string }

export interface FirstLogin {
  /**
   * The link's code, used up: a setup (its token, which the page keeps in memory only) and a new
   * TOTP secret for `domain`. A code that is unknown, used, expired or no code: one answer.
   */
  start(code: unknown): SetupStart
  /** The setup's token with the password and the new secret's first code: the login set. */
  finish(body: { setup?: unknown; password?: unknown; code?: unknown }): Promise<SetupFinish>
}

export interface FirstLoginOptions {
  access: Access
  /** The domain, for the TOTP code's name in the authenticator app. */
  domain: () => string
  now?: () => number
  random?: (n: number) => Uint8Array
}

export function createFirstLogin({
  access,
  domain,
  now = Date.now,
  random = n => randomBytes(n),
}: FirstLoginOptions): FirstLogin {
  /** The one setup under way: its token's hash and when it ends. A new start replaces it, as a new TOTP secret replaces the one before. */
  let setup: { hash: string; until: number } | null = null
  return {
    start(code) {
      if (typeof code !== 'string' || !SETUP_CODE.test(code) || !takeSetupCode(hashToken(code), now()))
        return { ok: false, status: 401, error: 'link' }
      const token = base64url(random(SETUP_TOKEN_BYTES))
      setup = { hash: hashToken(token), until: now() + SETUP_MS }
      const { secret, uri } = access.beginTotp(domain())
      return { ok: true, setup: token, secret, uri }
    },

    async finish(body) {
      const s = setup
      const token = isRecord(body) ? body.setup : undefined
      if (!s || typeof token !== 'string' || !token || hashToken(token) !== s.hash || now() > s.until)
        return { ok: false, status: 401, error: 'setup' }
      // The password first: its own checks, and saved. A wrong code then leaves the setup as it
      // was (the password alone is no login), to be sent again with the right one.
      const password = await access.setPassword(body.password)
      if (!password.ok) return { ok: false, status: 400, error: 'password', message: password.error }
      const totp = access.confirmTotp(body.code)
      if (!totp.ok) return { ok: false, status: 400, error: 'code', message: totp.error }
      setup = null
      // A link made meanwhile works no more: the login is set.
      clearSetupCode()
      return { ok: true }
    },
  }
}

/** A new code in place of any before it, its hash on file: the link to print. */
export function newSetupLink(
  domain: string,
  { now = Date.now, random = n => randomBytes(n) }: { now?: () => number; random?: (n: number) => Uint8Array } = {},
): string {
  const code = base64url(random(SETUP_CODE_BYTES))
  writeSetupCode({ codeHash: hashToken(code), expiresAt: now() + SETUP_CODE_MS })
  return setupLink(domain, code)
}

/**
 * `board login reset`: the password, the TOTP code and the passkeys go first (no sign-in from
 * here on), then the running board ends every login and the event streams open on them; with no
 * board answering, the logins go from the file all the same. Whether the board answered.
 */
export async function resetLogin(webPort: number): Promise<boolean> {
  clearSignIn()
  let answered = false
  try {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'logins-end-all' }),
      signal: AbortSignal.timeout(ANSWER_MS),
    })
    answered = res.ok
    await res.body?.cancel()
  } catch {}
  updateLogins(() => [])
  return answered
}

/** The socket's mode bits (0o660), or null where they cannot be read (Windows). */
function socketMode(path: string): number | null {
  if (process.platform === 'win32') return null
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

/** Whether the board's listener answers on the socket: hello once the login is set, 401 'setup' before. */
async function listenerOn(mode: ServerMode): Promise<ServerModeFacts['listener']> {
  try {
    const res = await fetch(`http://${mode.domain}/api/hello`, {
      unix: mode.socket,
      headers: { host: mode.domain, 'x-forwarded-proto': 'https' },
      signal: AbortSignal.timeout(ANSWER_MS),
    })
    const body: unknown = await res.json().catch(() => null)
    const board =
      (res.status === 200 && isRecord(body) && body.board === 'agent-board') ||
      (res.status === 401 && isRecord(body) && body.error === 'setup')
    return board ? { ok: true, mode: socketMode(mode.socket) } : { ok: false, error: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
}

/** What `board doctor` finds of the server mode: its settings, the listener on the socket (asked only when they check out), the login. */
export async function onServerFacts(mode: ServerMode): Promise<ServerModeFacts> {
  const problems = serverModeProblems(mode)
  return {
    mode,
    problems,
    listener: problems.length ? null : await listenerOn(mode),
    ready: accessReady(),
  }
}
