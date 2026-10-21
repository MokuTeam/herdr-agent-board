// The board's tunnel listener in tests (server/tunnel.ts): the login set up in a sandbox's state
// folder as the board keeps it (adapters/access-store.ts), a board whose tunnel is on, with a port
// of its own, and requests shaped as Caddy forwards them from the domain. Also the board's route
// table (runner.ts with TEST_ROUTE_TABLE=1) and a raw path for each of its RegExp routes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_MS, type LoginMethod, type Passkey } from '../../src/core/access.ts'
import { hashToken } from '../../src/services/remote.ts'
import { serveBoard, unusedPort } from './board-server.ts'
import type { Child, Sandbox } from './sandbox.ts'

export const DOMAIN = 'board.example.com'
export const ORIGIN = 'https://board.example.com'
export const PASSWORD = 'correct horse battery'
/** RFC 6238's SHA-1 test secret ("12345678901234567890"), 20 bytes, in base32. */
export const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
/** access.json's WebAuthn user id (base64url), for a passkey's userHandle: 16 bytes, `test-user-id-001`. */
export const USER_ID = 'dGVzdC11c2VyLWlkLTAwMQ'
/** The caller's address Caddy puts in X-Forwarded-For. */
export const CALLER = '203.0.113.9'

/** The board's state folder in a sandbox (adapters/paths.ts's stateDir there). */
export const stateFolder = (box: Sandbox): string =>
  join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

/** A login as access-logins.json keeps it, for `token`: 30 days from now unless `expiresAt` says. */
export function seededLogin(l: { token: string; expiresAt?: number; method?: LoginMethod }): Record<string, unknown> {
  const at = Date.now()
  return {
    id: hashToken(l.token).slice(0, 12),
    tokenHash: hashToken(l.token),
    method: l.method ?? 'password',
    label: 'Safari on iPad',
    address: CALLER,
    signedInAt: at,
    expiresAt: l.expiresAt ?? at + LOGIN_MS,
    seenAt: null,
  }
}

/** Writes one of the board's files in the sandbox's state folder, mode 0o600. */
export function writeState(box: Sandbox, name: string, value: unknown): void {
  mkdirSync(stateFolder(box), { recursive: true })
  writeFileSync(join(stateFolder(box), name), JSON.stringify(value, null, 2), { mode: 0o600 })
}

/** Writes access.json (an argon2id hash of PASSWORD, SECRET_B32 with lastStep 0, USER_ID), and the logins (hashToken of each token, 30 days unless given) and passkeys asked for, mode 0o600. */
export async function seedAccess(
  box: Sandbox,
  o: {
    logins?: { token: string; expiresAt?: number; method?: LoginMethod }[]
    passkeys?: Passkey[]
    lockout?: { failures: number; until: number | null }
  } = {},
): Promise<void> {
  writeState(box, 'access.json', {
    passwordHash: await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }),
    totp: { secret: SECRET_B32, lastStep: 0 },
    userId: USER_ID,
    lockout: o.lockout ?? { failures: 0, until: null },
  })
  if (o.logins) writeState(box, 'access-logins.json', o.logins.map(seededLogin))
  if (o.passkeys) writeState(box, 'access-passkeys.json', o.passkeys)
}

/**
 * The board (serveBoard) with the tunnel on for DOMAIN: `cfg.tunnel`'s fields over a set that
 * checks out, and `tunnel.port` a port of its own unless `cfg` gives one. `tunnel` is the
 * listener's URL on 127.0.0.1, whether anything listens there or not.
 */
export async function startTunnelBoard(
  box: Sandbox,
  cfg: Record<string, unknown> = {},
  extra: Record<string, string> = {},
): Promise<{ url: string; tunnel: string; tunnelPort: number; proc: Child }> {
  const { tunnel, ...rest } = cfg
  const given = tunnel && typeof tunnel === 'object' ? (tunnel as Record<string, unknown>) : {}
  const tunnelPort = typeof given.port === 'number' ? given.port : await unusedPort()
  const settings = {
    on: true,
    host: 'ssh.example.com',
    user: 'boardtunnel',
    domain: DOMAIN,
    ...given,
    port: tunnelPort,
  }
  const { url, proc } = await serveBoard(box, { language: 'en', ...rest, tunnel: settings }, extra)
  return { url, tunnel: `http://127.0.0.1:${tunnelPort}`, tunnelPort, proc }
}

/**
 * Requests as Caddy forwards them: Host DOMAIN, X-Forwarded-Proto https, X-Forwarded-For CALLER;
 * POSTs (and send's other methods) with X-Board and ORIGIN. `headers` go over these; one given as
 * '' is left out.
 */
export function viaCaddy(
  tunnel: string,
  cookie?: string,
): {
  get(path: string, headers?: Record<string, string>): Promise<Response>
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>
  /** Any method, with `text` as the body as it stands (JSON or not), or none. */
  send(method: string, path: string, text?: string, headers?: Record<string, string>): Promise<Response>
} {
  const headersOf = (more: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries({
        host: DOMAIN,
        'x-forwarded-proto': 'https',
        'x-forwarded-for': CALLER,
        ...(cookie ? { cookie } : {}),
        ...more,
      }).filter(([, value]) => value !== ''),
    )
  const send = (method: string, path: string, text?: string, headers: Record<string, string> = {}) =>
    fetch(tunnel + path, {
      method,
      headers: headersOf({ 'content-type': 'application/json', 'x-board': '1', origin: ORIGIN, ...headers }),
      ...(text === undefined ? {} : { body: text }),
    })
  return {
    get: (path, headers = {}) => fetch(tunnel + path, { headers: headersOf(headers) }),
    post: (path, body, headers = {}) => send('POST', path, JSON.stringify(body), headers),
    send,
  }
}

export interface TableRoute {
  method: string
  /** A string route's path, or a RegExp route's `source`. */
  path: string
}

/** The board's route table, as the runner sends it with TEST_ROUTE_TABLE=1. */
export function routeTable(proc: Child): TableRoute[] {
  const found = proc.messages.find(m => !!m && typeof m === 'object' && 'routes' in m) as
    | { routes: TableRoute[] }
    | undefined
  if (!found) throw new Error('No route table: start the board with TEST_ROUTE_TABLE=1')
  return found.routes
}

/**
 * One raw path for each RegExp route, by its source: a session `s1`, a launch `l1`, a day's upload.
 * Desktop-only spellings are avoided, so that a route reached with a login is the route itself.
 */
export const SAMPLES: Record<string, string> = Object.fromEntries(
  (
    [
      [/^\/api\/fs\//, '/api/fs/list'],
      [/^\/api\/launch\/([\w-]+)\/dismiss$/, '/api/launch/l1/dismiss'],
      [/^\/api\/launch\/([\w-]+)\/(focus|trust|close)$/, '/api/launch/l1/trust'],
      [/^\/api\/launch/, '/api/launch/l1'],
      [/^\/api\/session\/([^/]+)(?:\/(\w+))?$/, '/api/session/s1/wake'],
      [/^\/api\/session\/([^/]+)\/changes$/, '/api/session/s1/changes'],
      [/^\/api\/session\/([^/]+)\/history$/, '/api/session/s1/history'],
      [/^\/api\/session\/([^/]+)$/, '/api/session/s1'],
      [/^\/api\/session\/([^/]+)\/helper\/([A-Za-z0-9-]{1,120})$/, '/api/session/s1/helper/h1'],
      [/^\/api\/session\/([^/]+)\/(answer|permit|archive|workspace|fork)$/, '/api/session/s1/permit'],
      [/^\/api\/session\/([^/]+)\/(mokupilot)$/, '/api/session/s1/mokupilot'],
      [/^\/api\/session\/([^/]+)\/aside$/, '/api/session/s1/aside'],
      [/^\/api\/session\/([^/]+)\/(focus|wake|sleep|restart|message)$/, '/api/session/s1/message'],
      [/^\/api\/session\/([^/]+)\/(\w+)$/, '/api/session/s1/rename'],
      [/^\/api\/term\//, '/api/term/s1/agent/stream'],
      [/^\/uploads\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/, '/uploads/2026-10-20/a.png'],
    ] as const
  ).map(([re, raw]) => [re.source, raw]),
)
