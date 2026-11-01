// The owner's own sign-in offered to their vault (core/vault.ts), on the board's own server: while
// the owner holds an agent's browser (desktop/control: "the owner has it") and signs in to a site
// by typing a password, the board catches that one sign-in in a world of its own (services/
// login-watch.ts), and offers to save it to the owner's Vaultwarden — a card "Save the login for
// <site> (<username>)?", or "Update the password?" when the vault already has a login for that site
// and username with another password (nothing when it is the same). The owner approves with the
// vault's master password (or without it while the vault is kept unlocked, the login fill's own
// feature) or declines; the board then creates or edits the item with the Bitwarden CLI
// (services/login-save.ts). The rules here; the life of an offer is services/login-save.ts.
//
// The caught password lives in the board's memory only, dropped on an answer, on a decline, after
// SAVE_EXPIRES_MS, or when the board restarts. It is never in web.log, the audit, the card text,
// any API answer, the agent's messages or on disk: the card shows the site and the username only.
// Pure, with no node: import; the page uses its types.

/** How long an offer waits for the owner, and how long the caught password lives. */
export const SAVE_EXPIRES_MS = 5 * 60_000

/** An offer's end: saved as a new login, an existing one's password updated, the same already, declined, nobody answered, or the Bitwarden CLI failed. */
export type SaveStatus = 'pending' | 'saved' | 'updated' | 'same' | 'declined' | 'expired' | 'failed'

/** Whether the vault has this site and username already: a new login, an update of its password, or not known yet (the vault was locked when it was caught). */
export type SaveKind = 'new' | 'update' | 'unknown'

/** An offer as the card shows it (the payload's `loginSave`): no value, ever. */
export interface LoginSaveView {
  id: string
  /** The site the owner signed in to, its host, as the board read it from Chrome. */
  site: string
  /** The username the owner typed (never the password). */
  username: string
  kind: SaveKind
  at: number
  expires: number
  /** busy: the board is unlocking the vault or writing the item. */
  stage: 'asked' | 'busy'
  /** The vault is open in the board's memory until then (no master password asked); null: locked. */
  unlockedUntil: number | null
  /** The board has not signed in to the vault yet: the first approval may need the account's two-step code too. */
  firstLogin: boolean
  /** Why the last try did not go through, for the owner. */
  error: string
}

/** A sign-in the watcher caught, as it hands it on: the page's address from Chrome, and what was typed. */
export interface Caught {
  /** The page's address as Chrome had it (services/login-watch.ts reads it, not the page's script). */
  url: string
  username: string
  password: string
}

/** A domain or an http(s) host as a vault item matches on (the fill's matchUrl does the same): no query or fragment, so no token of the address is ever on a command line. */
export function saveMatchUrl(url: string): string {
  const u = new URL(url)
  return `${u.origin}${u.pathname}`
}

/** Whether a host is the machine's own (http is allowed only for it; everything else must be https). */
export const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')

/**
 * A caught sign-in checked: its site (host), the address the vault matches on, and the username
 * and password. null when the page is no https one (nor http on the machine's own host), the
 * username has a line break or is too long, or the password is empty or too long.
 */
export function caughtLogin(
  c: Caught,
): { ok: true; site: string; url: string; username: string; password: string } | { ok: false } {
  let u: URL
  try {
    u = new URL(c.url)
  } catch {
    return { ok: false }
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(host))) return { ok: false }
  const password = typeof c.password === 'string' ? c.password : ''
  if (!password || password.length > 4096) return { ok: false }
  const username = (typeof c.username === 'string' ? c.username : '')
    .replace(/[\r\n]/g, '')
    .trim()
    .slice(0, 256)
  return { ok: true, site: host, url: saveMatchUrl(c.url), username, password }
}

/** A login a match has, as far as the save needs it: its id, and its current password (to tell an update from the same). */
export interface SaveMatch {
  id: string
  username: string
  password: string
}

/**
 * Which of the vault's logins for the site is this sign-in's, and what it means: the one with the
 * same username (case-insensitive), its password the same (no offer) or another (an update), or
 * none of them (a new login).
 */
export function saveKindOf(
  matches: readonly SaveMatch[],
  username: string,
  password: string,
): { kind: 'new' } | { kind: 'update'; id: string } | { kind: 'same'; id: string } {
  const want = username.toLowerCase()
  const hit = matches.find(m => (m.username ?? '').toLowerCase() === want)
  if (!hit) return { kind: 'new' }
  return hit.password === password ? { kind: 'same', id: hit.id } : { kind: 'update', id: hit.id }
}

/** A new login item for the Bitwarden CLI (bw create item): a login of type 1 with the site's host as its name, the username, the password and the page's origin as its one URI. */
export function newLoginItem(o: {
  name: string
  username: string
  password: string
  uri: string
}): Record<string, unknown> {
  return {
    type: 1,
    name: o.name,
    notes: null,
    favorite: false,
    fields: [],
    login: {
      username: o.username || null,
      password: o.password,
      totp: null,
      uris: [{ match: null, uri: o.uri }],
    },
  }
}

/** An existing item with its login password set to `password`, the rest of it left as it is (bw edit item). */
export function itemWithPassword(item: Record<string, unknown>, password: string): Record<string, unknown> {
  const login = (item.login && typeof item.login === 'object' ? item.login : {}) as Record<string, unknown>
  return { ...item, login: { ...login, password } }
}

/** The origin a page's address names (scheme://host[:port]), for a new item's URI; the address itself when it has none. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}
