// The owner's password vault on the board's own server: a Vaultwarden of the board's user's, on
// 127.0.0.1 only, whose web vault the board serves at https://<domain>/vault behind its own login
// (server/vault-proxy.ts), and from which the agents' browsers get a login typed in once the owner
// approves it on the board (core/login-fill.ts, services/login-fill.ts). config.json's `vault`
// turns it on, in server mode only:
//   "vault": { "port": 8222 }
// and may say where its parts are (every one has a default):
//   data  Vaultwarden's data folder (its DATA_FOLDER), ~/.local/share/vaultwarden
//   env   its environment file (EnvironmentFile of its unit), ~/.config/vaultwarden/vaultwarden.env
//   unit  its systemd --user unit, vaultwarden.service
//   bw    the Bitwarden CLI, ~/.local/opt/bitwarden-cli/bw
//   cert  the certificate it serves on 127.0.0.1 (its ROCKET_TLS: the Bitwarden CLI takes nothing but
//         HTTPS), ~/.config/vaultwarden/tls/cert.pem: the board and the CLI trust that one alone
// Nothing of it is reachable without the board's login: no port but loopback's, no name of its
// own; every listener but the board's own server's domain refuses /vault (core/remote.ts
// vaultOwnerPath). Here the settings and the rules of the way through. Pure, with no node: import.

/** config.json's `vault`, with its defaults in. None of it is secret. */
export interface VaultConfig {
  /** Vaultwarden's port on 127.0.0.1. */
  port: number
  data: string
  env: string
  unit: string
  bw: string
  /** Its certificate on 127.0.0.1 (PEM), which the board's proxy and the Bitwarden CLI pin. */
  cert: string
}

/** Where the web vault is on the domain: Vaultwarden's DOMAIN ends with it, so it serves its routes under it. */
export const VAULT_PREFIX = '/vault'

const isPort = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) < 65536
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
/** A path as config.json gives it: absolute, `~/` the home folder; anything else is no path. */
function pathOf(v: unknown, home: string, fallback: string): string {
  const p = text(v)
  if (!p) return fallback
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return p.startsWith('/') ? p : fallback
}
const UNIT = /^[\w@.-]{1,80}\.service$/

/**
 * config.json's `vault` in server mode, its defaults in: null without a port (or no server mode,
 * or anything but an object), where nothing of the vault is there: no route, no tool.
 */
export function vaultConfig(value: unknown, o: { home: string; serverMode: boolean }): VaultConfig | null {
  if (!o.serverMode || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isPort(v.port)) return null
  const unit = text(v.unit)
  return {
    port: v.port,
    data: pathOf(v.data, o.home, `${o.home}/.local/share/vaultwarden`),
    env: pathOf(v.env, o.home, `${o.home}/.config/vaultwarden/vaultwarden.env`),
    unit: UNIT.test(unit) ? unit : 'vaultwarden.service',
    bw: pathOf(v.bw, o.home, `${o.home}/.local/opt/bitwarden-cli/bw`),
    cert: pathOf(v.cert, o.home, `${o.home}/.config/vaultwarden/tls/cert.pem`),
  }
}

/**
 * Vaultwarden's own address for the board (its proxy, the Bitwarden CLI): loopback over TLS with its
 * own certificate (the CLI refuses http), the prefix its DOMAIN gives.
 */
export const vaultOrigin = (c: Pick<VaultConfig, 'port'>): string => `https://127.0.0.1:${c.port}`
export const vaultServerUrl = (c: Pick<VaultConfig, 'port'>): string => `${vaultOrigin(c)}${VAULT_PREFIX}`

/** The web vault and its API, as a path: /vault, /vault/… (never /vaultx). */
export const vaultPath = (path: string): boolean => /^\/vault(\/|$)/.test(path)

/**
 * What of the vault only the board's own server answers, through its domain's login: the web vault
 * and its API, and the owner's answers to a login fill (/api/vault/…: the master password goes
 * there). Every other listener refuses them, in both spellings (core/remote.ts, server/streams.ts,
 * the local key's port in app.ts).
 */
export const vaultOwnerPath = (path: string): boolean => vaultPath(path) || /^\/api\/vault(\/|$)/.test(path)

/** Vaultwarden's admin page: never through the board, whatever its settings (without ADMIN_TOKEN it is off too). */
export const vaultAdminPath = (path: string): boolean => /^\/vault\/admin(\/|$)/i.test(path)

/**
 * A new account's calls (the web vault's register, with or without its e-mail step, and the
 * API's older one): refused by the board once the vault has an account, whatever Vaultwarden's
 * SIGNUPS_ALLOWED says while it restarts.
 */
export const vaultRegisterPath = (path: string): boolean =>
  /^\/vault\/(identity|api)\/accounts\/register(\/|$)/i.test(path)

/** The notifications' WebSockets (the web vault's live sync): the only upgrade the proxy makes. */
export const vaultSocketPath = (path: string): boolean => /^\/vault\/notifications\/(hub|anonymous-hub)$/.test(path)

/** Headers that are the connection's own, never passed on (RFC 9110 7.6.1), with what the board adds itself. */
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'accept-encoding',
  'content-length',
])
/** What of Vaultwarden's answer is the domain's to say, not its: HSTS (Rocket adds it once it has TLS). */
const DOMAINS_OWN = new Set(['strict-transport-security', 'alt-svc'])

/** A Cookie header without the board's login (`name`), or null when nothing is left. */
export function cookieWithout(header: string | null, name: string): string | null {
  const kept = (header ?? '')
    .split(';')
    .map(p => p.trim())
    .filter(p => p && p.split('=')[0]?.trim() !== name)
  return kept.length ? kept.join('; ') : null
}

/**
 * What goes to Vaultwarden of a request's headers: the caller's own but the connection's, the
 * board's login cookie never (Vaultwarden has no use for it); the domain as the Host, https as the
 * scheme, the caller's address in X-Real-IP (Vaultwarden's IP_HEADER, for its login limits and
 * log), and no compression (the answer goes on as it comes).
 */
export function upstreamHeaders(
  given: Headers,
  o: { domain: string; address: string; cookie: string },
  extraHop: readonly string[] = [],
): Headers {
  const out = new Headers()
  const skip = new Set([...HOP, ...extraHop.map(h => h.toLowerCase())])
  for (const [name, value] of given) {
    const n = name.toLowerCase()
    if (skip.has(n) || n === 'cookie' || n.startsWith('sec-websocket-')) continue
    out.append(name, value)
  }
  const cookie = cookieWithout(given.get('cookie'), o.cookie)
  if (cookie) out.set('cookie', cookie)
  out.set('host', o.domain)
  out.set('x-forwarded-proto', 'https')
  out.set('x-forwarded-host', o.domain)
  if (o.address) {
    out.set('x-real-ip', o.address)
    out.set('x-forwarded-for', o.address)
  }
  out.set('accept-encoding', 'identity')
  return out
}

/**
 * What comes back of Vaultwarden's headers: its own but the connection's and the domain's (HSTS stays
 * Caddy's to say), and never a cookie of the board's login's name.
 */
export function downstreamHeaders(given: Headers, cookie: string): Headers {
  const out = new Headers()
  for (const [name, value] of given) {
    const n = name.toLowerCase()
    if (n === 'set-cookie' || DOMAINS_OWN.has(n)) continue
    if (HOP.has(n) && n !== 'content-length') continue
    out.append(name, value)
  }
  for (const c of given.getSetCookie()) if (c.split('=')[0]?.trim() !== cookie) out.append('set-cookie', c)
  return out
}

/** Vaultwarden's environment file, a line a setting: SIGNUPS_ALLOWED's value in it, or null when it has none. */
export function envSetting(env: string, name: string): string | null {
  let found: string | null = null
  for (const line of env.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && m[1] === name) found = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
  return found
}

/** The file with `name` set to `value`: its line changed where it is, or added at the end. */
export function withEnvSetting(env: string, name: string, value: string): string {
  const lines = env.split(/\r?\n/)
  let set = false
  const out = lines.map(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line)
    if (m && m[1] === name) {
      if (set) return `# ${line}`
      set = true
      return `${name}=${value}`
    }
    return line
  })
  if (!set) {
    if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${name}=${value}`)
    else out.push(`${name}=${value}`)
  }
  return out.join('\n')
}

/** Whether an env value is on, as Vaultwarden reads a boolean. */
export const envOn = (v: string | null): boolean => !!v && /^(true|1|yes|on)$/i.test(v.trim())
