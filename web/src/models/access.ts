// The Remote access panel in words. Its Tunnel part (components/access/TunnelSection.tsx): where the
// tunnel stands, Test connection's steps and their hints (the domain's while the web server is not
// set up, Call 4), what a field's edit sends, and step 1 of "On the server": the snippets filled in
// from the settings (core/tunnel-snippets.ts); step 3 is models/server-setup.ts's. Its Login parts
// (LoginSection.tsx, LoginsSection.tsx): the TOTP key in groups, a passkey's, a login's and a
// failed attempt's line, where passkeys are added. What the panel asks or has open, one thing at a
// time. The view itself is GET /api/access's, checked by core/access.ts.
import {
  type AccessView,
  type Attempt,
  isAccessView,
  type PublicLogin,
  type PublicPasskey,
} from '../../../src/core/access.ts'
import {
  fieldProblem,
  publicOrigin,
  type StepHint,
  type TestStep,
  TUNNEL_SOCKET,
  type TunnelConfig,
  type TunnelField,
  type TunnelStatus,
} from '../../../src/core/tunnel.ts'
import { keysFile, keysLine, serverCommands, sshdBlock, stepOnePaste } from '../../../src/core/tunnel-snippets.ts'
import type { Translator } from '../../../src/core/types.ts'
import { longWhen, shortWhen } from '../../../src/core/when-format.ts'
import { ago } from './card.ts'

export { isAccessView }

/** The settings, in the order the panel has them. */
export const TUNNEL_FIELDS: readonly TunnelField[] = [
  'host',
  'sshPort',
  'user',
  'key',
  'socket',
  'domain',
  'publicPort',
  'port',
]

/** The fields that hold a port: their edits are sent as numbers. */
export const PORT_FIELDS: ReadonlySet<TunnelField> = new Set(['sshPort', 'publicPort', 'port'])

/** What the Tunnel part asks before it sends: replacing the key there, or a new domain the board warned about. */
export type TunnelAsk = { kind: 'key' } | { kind: 'domain'; domain: string } | null

/**
 * What the Login parts have open or ask before they send: the password form and what is typed in
 * it; the code's setup with the secret and URI from totp-begin, until it is checked or closed; a
 * passkey to remove, a login to end, or all of them, clicked once.
 */
export type LoginAsk =
  | { kind: 'password'; typed: string }
  | { kind: 'totp'; secret: string; uri: string; code: string }
  | { kind: 'passkey'; id: string }
  | { kind: 'login'; id: string }
  | { kind: 'logins' }
  | null

/** What the panel asks or has open, one thing at a time: the Tunnel part's or the Login parts'. */
export type AccessAsk = TunnelAsk | LoginAsk

/** The Tunnel part's share of what the panel asks; null while it is the Login parts'. */
export const tunnelAsk = (ask: AccessAsk): TunnelAsk => (ask?.kind === 'key' || ask?.kind === 'domain' ? ask : null)

/** The Login parts' share of what the panel asks; null while it is the Tunnel part's. */
export const loginAsk = (ask: AccessAsk): LoginAsk => (ask?.kind === 'key' || ask?.kind === 'domain' ? null : ask)

/** A TOTP key as the panel shows it, in groups of four for typing into an app: `ABCD EFGH …`. */
export const groupKey = (secret: string): string => secret.match(/.{1,4}/g)?.join(' ') ?? ''

/** "last used 5 min ago", or its word for a moment ago (`key` and `${key}Now`), through the board's `ago`. */
function agoLine(ms: number, now: number, t: Translator, key: 'access.used' | 'access.active'): string {
  const when = ago(ms, now, t)
  return when === t('ago.now') ? t(`${key}Now`) : t(key, { when })
}

/** A passkey's line: when it was added, when it was last used ("not used yet"). */
export function passkeyLine(p: PublicPasskey, t: Translator, now: number): string {
  const used = p.usedAt === null ? t('access.unused') : agoLine(p.usedAt, now, t, 'access.used')
  return `${t('access.added', { when: shortWhen(p.addedAt, t, now) })} · ${used}`
}

/** A login's line: its method, when it signed in, when it was last active (signing in is), from where. */
export function loginLine(l: PublicLogin, t: Translator, now: number): string {
  return [
    t(`access.method.${l.method}`),
    t('access.signedIn', { when: shortWhen(l.signedInAt, t, now) }),
    agoLine(l.seenAt ?? l.signedInAt, now, t, 'access.active'),
    l.address,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** A failed sign-in: when, from where (when the proxy said), the browser, and why in words. */
export function attemptLine(a: Attempt, t: Translator, now: number): string {
  return [shortWhen(a.at, t, now), a.address, a.label, t(`access.reason.${a.reason}`)].filter(Boolean).join(' · ')
}

/** Where passkeys are added: through the domain (with its public port, when not 443), when it checks out; its placeholder until then. */
export function passkeyHint(settings: TunnelConfig, t: Translator): string {
  const { domain } = settings
  const shown =
    domain !== '' && fieldProblem('domain', domain) === null
      ? publicOrigin(settings).slice('https://'.length)
      : '<domain>'
  return t('access.passkeysHint', { domain: shown })
}

/** While sign-in with password and code is locked: until when. */
export const lockoutLine = (until: number, t: Translator, now: number): string =>
  t('access.locked', { when: longWhen(until, t, now) })

const STEP_IDS: ReadonlySet<unknown> = new Set(['ssh', 'forward', 'domain'])

/** One step of Test connection as the board answers it (core/tunnel.ts TestStep). */
export function isTestStep(v: unknown): v is TestStep {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    STEP_IDS.has(s.id) &&
    (typeof s.ok === 'boolean' || s.ok === null) &&
    typeof s.detail === 'string' &&
    (typeof s.hint === 'string' || s.hint === null)
  )
}

const clock = (ms: number, t: Translator): string =>
  new Date(ms).toLocaleTimeString(t.lang, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

/** Where the tunnel stands, with since when: "Connected since 14:05", "Error since 14:05: <ssh's words>". */
export function statusLine(s: TunnelStatus, t: Translator, now: number): string {
  const since = longWhen(s.since, t, now)
  switch (s.state) {
    case 'off':
      return t('access.state.off')
    case 'connecting':
      return t('access.state.connecting')
    case 'connected':
      return t('access.state.connected', { since })
    case 'reconnecting': {
      const line =
        s.attempt !== undefined && s.nextAt !== undefined
          ? t('access.state.reconnecting', { attempt: s.attempt, next: clock(s.nextAt, t) })
          : t('access.state.reconnectingSoon')
      return s.error ? `${line} ${s.error}` : line
    }
    case 'error': {
      const line = t('access.state.error', { since })
      return s.error ? `${line}: ${s.error}` : line
    }
  }
}

const MARKS = { true: '✓', false: '✗', null: '–' } as const

/** A step of Test connection: "✓ SSH to the server", "✗ …: what went wrong", "– …" (not run). */
export function stepLine(s: TestStep, t: Translator): string {
  const line = `${MARKS[`${s.ok}`]} ${t(`access.step.${s.id}`)}`
  return s.ok === false && s.detail ? `${line}: ${s.detail}` : line
}

/** Test connection's steps in one line, as "On the server" sums them up: "✓ SSH to the server · ✗ …". */
export const stepMarks = (steps: readonly TestStep[], t: Translator): string =>
  steps.map(s => `${MARKS[`${s.ok}`]} ${t(`access.step.${s.id}`)}`).join(' · ')

/**
 * Call 4: the domain's step failed while no setup of the web server is on record, so it says that
 * it fails until step 3 is done; '' otherwise.
 */
export const notSetUpLine = (s: TestStep, view: AccessView, t: Translator): string =>
  s.id === 'domain' && s.ok === false && !view.server?.setup ? t('server.panel.domainNotSetUp') : ''

/** What a hint says to do; '' for none. */
export function hintText(hint: StepHint | null | undefined, t: Translator): string {
  return hint ? t(`tunnel.hint.${hint}`) : ''
}

/** What an empty field means: the default, for the fields that have one. */
const DEFAULTS: Partial<Record<TunnelField, string | number | null>> = {
  sshPort: 22,
  socket: TUNNEL_SOCKET,
  publicPort: null,
  port: null,
}

/** What a field's edit sends: null when unchanged; else { value }: numbers for the ports ('' gives null for `port` and `publicPort`, clearing them), the domain lowercased, strings trimmed. */
export function fieldEdit(field: TunnelField, now: string | number | null, typed: string): { value: unknown } | null {
  const text = typed.trim()
  let value: string | number | null
  if (text === '' && field in DEFAULTS) value = null
  // Not a number is sent as typed, for the board to say why: NaN would go as JSON's null, clearing it.
  else if (PORT_FIELDS.has(field)) value = /^\d+$/.test(text) ? Number(text) : text
  else value = field === 'domain' ? text.toLowerCase() : text
  const meant = value === null ? DEFAULTS[field] : value
  return meant === now ? null : { value }
}

/** What the board's own key looks like until there is one: the keys file's line shows its shape. */
export const PUBLIC_KEY_EXAMPLE = 'ssh-ed25519 AAAA… agent-board@<PC>'

export interface ServerSnippets {
  /** The values the snippets were filled in with. */
  user: string
  socket: string
  domain: string
  /** All of step 1 in one paste; null until there is a key whose line it can write. */
  paste: string | null
  /** The tunnel's user and the socket's folder. */
  commands: string
  /** The keys file's path, and its line. */
  keysFile: string
  keysLine: string
  sshd: string
}

/** A value that passes its field's own check; else its default (these go into a root shell on the server). */
const checked = (field: TunnelField, value: string, fallback: string): string =>
  value !== '' && fieldProblem(field, value) === null ? value : fallback

/**
 * The server's snippets, filled in. Only from settings that pass their checks: a hand-edited value
 * that fails one shows the default in its place, never its own text.
 */
export function serverSnippets(settings: TunnelConfig, publicKey: string | null): ServerSnippets {
  const user = checked('user', settings.user, 'boardtunnel')
  const socket = checked('socket', settings.socket, TUNNEL_SOCKET)
  const domain = checked('domain', settings.domain, 'board.example.com')
  return {
    user,
    socket,
    domain,
    paste: publicKey ? stepOnePaste(user, socket, publicKey) : null,
    commands: serverCommands(user, socket),
    keysFile: keysFile(user),
    keysLine: keysLine(publicKey ?? PUBLIC_KEY_EXAMPLE),
    sshd: sshdBlock(user),
  }
}
