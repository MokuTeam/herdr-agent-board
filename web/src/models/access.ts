// The Remote access panel's Tunnel part in words (components/access/TunnelSection.tsx): where the
// tunnel stands, Test connection's steps and their hints, what a field's edit sends, and the
// server's snippets filled in from the settings (core/tunnel-snippets.ts). The view itself is
// GET /api/access's, checked by core/access.ts.
import { isAccessView } from '../../../src/core/access.ts'
import {
  fieldProblem,
  type StepHint,
  type TestStep,
  TUNNEL_SOCKET,
  type TunnelConfig,
  type TunnelField,
  type TunnelStatus,
} from '../../../src/core/tunnel.ts'
import {
  caddyfile,
  keysFile,
  keysLine,
  nginxNote,
  serverCommands,
  sshdBlock,
} from '../../../src/core/tunnel-snippets.ts'
import type { Translator } from '../../../src/core/types.ts'
import { longWhen } from '../../../src/core/when-format.ts'

export { isAccessView }

/** The settings, in the order the panel has them. */
export const TUNNEL_FIELDS: readonly TunnelField[] = ['host', 'sshPort', 'user', 'key', 'socket', 'domain', 'port']

/** What the Tunnel part asks before it sends: replacing the key there, or a new domain the board warned about. */
export type TunnelAsk = { kind: 'key' } | { kind: 'domain'; domain: string } | null

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

/** What a hint says to do; '' for none. */
export function hintText(hint: StepHint | null | undefined, t: Translator): string {
  return hint ? t(`tunnel.hint.${hint}`) : ''
}

/** What an empty field means: the default, for the fields that have one. */
const DEFAULTS: Partial<Record<TunnelField, string | number | null>> = {
  sshPort: 22,
  socket: TUNNEL_SOCKET,
  port: null,
}

/** What a field's edit sends: null when unchanged; else { value }: numbers for the ports ('' gives null for `port`, clearing it), the domain lowercased, strings trimmed. */
export function fieldEdit(field: TunnelField, now: string | number | null, typed: string): { value: unknown } | null {
  const text = typed.trim()
  let value: string | number | null
  if (text === '' && field in DEFAULTS) value = null
  // Not a number is sent as typed, for the board to say why: NaN would go as JSON's null, clearing it.
  else if (field === 'sshPort' || field === 'port') value = /^\d+$/.test(text) ? Number(text) : text
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
  /** The tunnel's user and the socket's folder. */
  commands: string
  /** The keys file's path, and its line. */
  keysFile: string
  keysLine: string
  sshd: string
  caddy: string
  nginx: string
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
    commands: serverCommands(user, socket),
    keysFile: keysFile(user),
    keysLine: keysLine(publicKey ?? PUBLIC_KEY_EXAMPLE),
    sshd: sshdBlock(user),
    caddy: caddyfile(domain, socket),
    nginx: nginxNote(socket),
  }
}
