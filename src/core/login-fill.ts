// A login typed into an agent's browser from the owner's vault (core/vault.ts), on the board's own
// server: the agent focuses the field and asks (browser_fill_login, `board browser login`) for a
// subset of the login (its username, its password, its current TOTP code, in its order, a Tab
// between them, Return after if asked); the board reads which page has the focus itself, and the
// card goes under "needs you" with that site, what will be typed and the vault's matches (names and
// usernames only, once the vault is open). The owner approves with the vault's master password
// (never kept; the vault may stay open in the board's memory for 15 minutes) or declines; the board
// types the values by keys and locks the vault again. The agent learns ok, declined, expired, no
// match, or why it did not go through, never a value. The rules here; the life of a request is
// services/login-fill.ts. Pure, with no node: import: the page uses its types.
import { DESK_KEYED } from './desktop.ts'

export const FILL_FIELDS = ['username', 'password', 'totp'] as const
export type FillField = (typeof FILL_FIELDS)[number]

/** How long a request waits for the owner. */
export const FILL_EXPIRES_MS = 10 * 60_000
/** The vault kept open after an approval with "keep unlocked". */
export const HOLD_MS = 15 * 60_000
/** The vault open while the owner picks among several matches, then locked again. */
export const PICK_MS = 5 * 60_000

/** A request's end: typed, declined, expired, the vault has no login for the site, or why not. */
export type FillStatus = 'pending' | 'ok' | 'declined' | 'expired' | 'nomatch' | 'failed'

/** A vault item that matched, as the card shows it: never more of it. */
export interface FillMatch {
  id: string
  name: string
  username: string
  totp: boolean
}

/** A request as the card shows it (the payload's `loginFill`): no value, ever. */
export interface LoginFillView {
  id: string
  /** The site as the board read it from the browser: the page's host. */
  site: string
  /** The page's title, as Chrome has it. */
  title: string
  /** What has the focus there: password, email, username, code, text. */
  field: string
  fields: FillField[]
  /** Return after the last one. */
  submit: boolean
  /** The username the agent asked for; '' for any. */
  username: string
  at: number
  expires: number
  /** asked: waits for the owner; pick: the vault is open and several match; busy: unlocking or typing. */
  stage: 'asked' | 'pick' | 'busy'
  /** The matches once the vault was open for this request (or is kept open); null: not known yet. */
  matches: FillMatch[] | null
  /** The vault is open in the board's memory until then (no master password asked); null: locked. */
  unlockedUntil: number | null
  /** The board has not signed in to the vault yet: the first approval may need the account's two-step code too. */
  firstLogin: boolean
  /** Why the last try did not go through (wrong password, the owner has the browser), for the owner. */
  error: string
}

const isField = (v: unknown): v is FillField => FILL_FIELDS.includes(v as FillField)

/** The fields asked for, in their order, each once: a list or "username,password"; null when that is none. */
export function fillFields(v: unknown): FillField[] | null {
  const list = typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : Array.isArray(v) ? v : null
  if (!list?.length || list.length > FILL_FIELDS.length) return null
  if (!list.every(isField) || new Set(list).size !== list.length) return null
  return list as FillField[]
}

/** The host a site names: a domain or an address (https:// taken when it has no scheme); null when it is none. */
export function siteHost(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > 2048 || /\s/.test(s)) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

/** A page's host from its address (http and https only); null for anything else (about:blank, chrome://). */
export function pageHost(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

/** The page's address as the vault's matching takes it: no query or fragment (a token there stays out of any command line). */
export function matchUrl(url: string): string {
  const u = new URL(url)
  return `${u.origin}${u.pathname}`
}

/** Whether the page is on the site the agent named: the same host, or one under it. */
export const onSite = (page: string, site: string): boolean => page === site || page.endsWith(`.${site}`)

/** What the board says of a field that has the focus: its kind for the card, or why there is nothing to type into. */
export const fieldWord = (f: { editable: boolean; kind: string; crossFrame: boolean }): string | null =>
  f.editable && f.kind ? f.kind : null

/** A request as the agent sends it, checked: what to type, Return or not, the username it wants, the site it names. */
export interface FillAsk {
  fields: FillField[]
  submit: boolean
  username: string
  site: string | null
}

export function fillAsk(body: Record<string, unknown>): { ok: true; ask: FillAsk } | { ok: false; error: string } {
  const fields = fillFields(body.fields ?? ['username', 'password'])
  if (!fields)
    return { ok: false, error: 'fields: username, password and totp, each at most once, in the order to type' }
  const username = body.username === undefined || body.username === null ? '' : body.username
  if (typeof username !== 'string' || username.length > 256 || /[\r\n]/.test(username))
    return { ok: false, error: 'username: one line' }
  let site: string | null = null
  if (body.site !== undefined && body.site !== null && body.site !== '') {
    site = siteHost(body.site)
    if (!site) return { ok: false, error: 'site: a domain or an http(s) address' }
  }
  return { ok: true, ask: { fields, submit: body.submit === true, username: username.trim(), site } }
}

/** X keysyms of the keys a login fill presses. */
export const TAB = 0xff09
export const RETURN = 0xff0d

/** A character's X keysym: Latin-1 as it is, any other by its code point (as web/src/models/desk-input.ts). */
export function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x01000000 + cp
}

const KEYED = new Set([...DESK_KEYED])
/** Whether the display's keyboard types it as a key: printable Latin-1, or what the board's keymap adds (core/desktop.ts). */
export const typable = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || KEYED.has(ch)
}

/**
 * The keys of a fill: each value's characters, a Tab between values, Return after if asked; null
 * when a value has a character no key types (a line break, an emoji): then nothing is typed.
 */
export function fillKeys(values: readonly string[], submit: boolean): number[] | null {
  const keys: number[] = []
  for (const [i, v] of values.entries()) {
    if (i > 0) keys.push(TAB)
    for (const ch of v) {
      if (!typable(ch)) return null
      keys.push(charKeysym(ch))
    }
  }
  if (submit) keys.push(RETURN)
  return keys
}

/** A request's words to the agent once it ended (the board's reminder, `board browser login`): never a value. */
export function fillResult(r: {
  status: FillStatus
  site: string
  fields: readonly FillField[]
  submit: boolean
  reason?: string
}): string {
  const what = `${r.fields.join(', Tab, ')}${r.submit ? ', Return' : ''}`
  switch (r.status) {
    case 'ok':
      return `ok · the owner approved: typed ${what} into the field that had the focus on ${r.site}. Check the page and go on.`
    case 'declined':
      return `declined · the owner declined the login fill on ${r.site}: nothing was typed.`
    case 'expired':
      return `expired · nobody answered the login fill on ${r.site}: nothing was typed.`
    case 'nomatch':
      return `no match · the owner's vault has no login for ${r.site}${r.reason ? ` (${r.reason})` : ''}: nothing was typed.`
    case 'failed':
      return `not done · the login fill on ${r.site} did not go through (${r.reason || 'unknown'}).`
    default:
      return `pending · the login fill on ${r.site} waits for the owner on the board.`
  }
}

/** `board browser login`'s exit codes by how the fill ended. */
export const LOGIN_CODES: Record<string, number> = {
  ok: 0,
  pending: 2,
  declined: 3,
  expired: 3,
  failed: 3,
  nomatch: 4,
}

/**
 * `board browser login [--fields username,password,totp] [--enter] [--username <name>] [--site
 * <domain>] [--no-wait]`'s words: what the board's /api/browser/login takes, and whether to wait.
 */
export function loginArgs(
  words: readonly string[],
):
  | { ok: true; args: { fields: FillField[]; submit: boolean; username?: string; site?: string; wait: boolean } }
  | { ok: false; error: string } {
  const args = [...words]
  const value = (flag: string): string | undefined | null => {
    const i = args.indexOf(flag)
    if (i < 0) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v === undefined || v.startsWith('--') ? null : v
  }
  const flag = (name: string): boolean => {
    const i = args.indexOf(name)
    if (i >= 0) args.splice(i, 1)
    return i >= 0
  }
  const submit = flag('--enter')
  const wait = !flag('--no-wait')
  const fieldsGiven = value('--fields')
  const username = value('--username')
  const site = value('--site')
  if (fieldsGiven === null || username === null || site === null) return { ok: false, error: 'a flag needs its value' }
  if (args.length) return { ok: false, error: `unexpected: ${args.join(' ')}` }
  const fields = fillFields(fieldsGiven ?? 'username,password')
  if (!fields)
    return { ok: false, error: '--fields: username, password and totp, each at most once, in the order to type' }
  return {
    ok: true,
    args: {
      fields,
      submit,
      wait,
      ...(username !== undefined && { username }),
      ...(site !== undefined && { site }),
    },
  }
}
