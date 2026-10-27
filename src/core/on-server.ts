// The board on a server of the owner's own (server mode): herdr, Claude Code and the board run on
// the host, and the web server there (Caddy) hands the owner's domain to the board's login listener
// (server/tunnel.ts) on a Unix socket, with no ssh and no tunnel. config.json's `serverMode` turns
// it on and says where:
//   "serverMode": { "domain": "workbench.example.com", "socket": "/var/lib/agent-board/board.sock" }
// Its presence (an object) is the server mode; a board without it is a board on a PC, as before.
// The socket's folder is the installer's: the board's user, the web server's group, 2750. The
// first login is set through a one-time link (services/first-login.ts). Here: the settings and
// their checks, the link, and `board doctor`'s checks. Pure, with no node: import.

import { t } from './lang.ts'
import type { SetupCheck } from './setup.ts'
import { fieldProblem } from './tunnel.ts'
import type { Translator } from './types.ts'

/** config.json's `serverMode`. None of it is secret. */
export interface ServerMode {
  /** A bare host name, such as workbench.example.com: the board is https://<domain>/. */
  domain: string
  /** The Unix socket the login listener makes, in the installer's folder. */
  socket: string
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** config.json's `serverMode`, strings trimmed ('' for a missing one); null when it has none, or no object: a board on a PC. */
export function serverModeOf(value: unknown): ServerMode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Record<string, unknown>
  return { domain: text(c.domain), socket: text(c.socket) }
}

/** Whether the board runs in server mode (config.json has `serverMode`). */
export const onServer = (cfg: { serverMode?: unknown }): boolean => serverModeOf(cfg.serverMode) !== null

export interface ServerModeProblem {
  field: 'domain' | 'socket'
  message: string
}

/** The settings' checks, the tunnel's own for a domain and a socket (core/tunnel.ts); an empty domain is named as missing. */
export function serverModeProblems(s: ServerMode): ServerModeProblem[] {
  const problems: ServerModeProblem[] = []
  const domain = s.domain
    ? fieldProblem('domain', s.domain)
    : t('tunnel.err.required', { field: t('tunnel.field.domain') })
  if (domain) problems.push({ field: 'domain', message: domain })
  const socket = fieldProblem('socket', s.socket)
  if (socket) problems.push({ field: 'socket', message: socket })
  return problems
}

/** The domain's own origin: the web server serves it on 443. */
export const serverOrigin = (s: ServerMode): string => `https://${s.domain}`

/** The Host the listener accepts: '<domain>' and '<domain>:443'. */
export const serverHosts = (s: ServerMode): string[] => [s.domain, `${s.domain}:443`]

/** The setup page's path; its calls are under /api/setup/. */
export const SETUP_PATH = '/setup'
/** A setup link's code lasts an hour from when it was made, and works once. */
export const SETUP_CODE_MS = 3_600_000
/** 24 random bytes (192 bits), base64url: 32 characters. */
export const SETUP_CODE_BYTES = 24
export const SETUP_CODE = /^[\w-]{32}$/

/** The one-time link: the code rides in the fragment, which a browser never sends (no web server's log, no Referer). */
export const setupLink = (domain: string, code: string): string => `https://${domain}${SETUP_PATH}#code=${code}`

/** What `board doctor` finds of the server mode (services/first-login.ts onServerFacts). */
export interface ServerModeFacts {
  mode: ServerMode
  problems: ServerModeProblem[]
  /** Whether something answers on the socket as the board's listener does, or why not; null: not asked (the settings do not check out). */
  listener: { ok: true; mode: number | null } | { ok: false; error: string } | null
  /** Password and TOTP are set (adapters/access-store.ts accessReady). */
  ready: boolean
}

/** `board doctor`'s checks of the server mode: the settings and the domain, the listener on its socket, the login. */
export function serverModeChecks(f: ServerModeFacts, tr: Translator): SetupCheck[] {
  const check = (c: Partial<SetupCheck> & Pick<SetupCheck, 'id' | 'level' | 'title'>): SetupCheck => ({
    detail: '',
    fix: '',
    code: '',
    ...c,
  })
  const { domain, socket } = f.mode
  const checks: SetupCheck[] = [
    f.problems.length
      ? check({
          id: 'server-mode',
          level: 'error',
          title: tr('onServer.check.fieldsBad'),
          detail: f.problems.map(p => p.message).join('\n'),
        })
      : check({ id: 'server-mode', level: 'ok', title: tr('onServer.check.fields'), detail: serverOrigin(f.mode) }),
  ]
  const l = f.listener
  if (l?.ok)
    checks.push(
      check({
        id: 'server-listener',
        level: 'ok',
        title: tr('onServer.check.listener'),
        detail: l.mode === null ? socket : `${socket} (${l.mode.toString(8)})`,
      }),
    )
  else if (l)
    checks.push(
      check({
        id: 'server-listener',
        level: 'error',
        title: tr('onServer.check.noListener', { socket }),
        detail: l.error,
        fix: tr('onServer.check.noListenerFix'),
      }),
    )
  checks.push(
    f.ready
      ? check({ id: 'server-login', level: 'ok', title: tr('onServer.check.login') })
      : check({
          id: 'server-login',
          level: 'warn',
          title: tr('onServer.check.noLogin'),
          detail: domain ? `https://${domain}${SETUP_PATH}` : '',
          fix: tr('onServer.check.noLoginFix'),
          code: 'board login link',
        }),
  )
  return checks
}
