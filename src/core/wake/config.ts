// Wake's settings: config.json's `wake` section over the defaults (#119). The section is `true`,
// `false` or an object; a setting of the wrong type is its default, but for the switch itself: a
// `wake`, or its `enabled`, of the wrong type is off (a kill switch that cannot be read fails
// closed). The reaper and the Telegram router are off unless the section turns them on, so wake
// does nothing by itself. Telegram takes tg-mcp's url and token from the section, else from the
// `<server>` MCP server in ~/.claude.json, as the old herdr-wake plugin did. There is no
// `wakeCommand`: every wake is `board resume`.

/** Whether wake is on without a `wake` section: it starts with the board on every install. */
export const WAKE_SHIPPED: boolean = true
/** Wake's port on 127.0.0.1: its API, and what keeps it to one process. */
export const WAKE_PORT = 12421

export type TelegramMode = 'off' | 'auto'

export interface ReaperConfig {
  enabled: boolean
  idleMinutes: number
  exclude: string[]
  maxPerRound: number
}

export interface WakeConfig {
  enabled: boolean
  reaper: ReaperConfig
  /** `auto`: on when a tg-mcp url and token are found (telegramTarget). */
  telegram: TelegramMode
  port: number
  /** The herdr workspace of wake's pane. */
  workspace: string
  /** tg-mcp's url and token; null: the `server` MCP server's in ~/.claude.json. */
  url: string | null
  authorization: string | null
  /** The MCP server in ~/.claude.json that tg-mcp is. */
  server: string
  wakeTimeoutSec: number
  pollTimeoutSec: number
  listSleepingDays: number
  /**
   * A session put to sleep gives its pane back, and its tab when only herdr-sidebar's panes are
   * beside it, and wakes in a new tab of its workspace (#204); false: its pane stays, `💤 <name>`.
   */
  closePanes: boolean
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const count = (v: unknown, otherwise: number, max = Number.MAX_SAFE_INTEGER): number =>
  Number.isInteger(v) && Number(v) >= 1 && Number(v) <= max ? Number(v) : otherwise

function reaperConfig(value: unknown): ReaperConfig {
  const r = record(value) ?? {}
  return {
    enabled: r.enabled === true,
    idleMinutes: count(r.idleMinutes, 60),
    exclude: Array.isArray(r.exclude) ? r.exclude.filter(e => typeof e === 'string') : [],
    maxPerRound: count(r.maxPerRound, 3),
  }
}

/**
 * Whether wake is on: `true`/`false`, else the section's `enabled`; no section, or one without
 * `enabled`, is the default. Anything else (a string, a number, a list, null) is off, never on.
 */
function switchOf(section: unknown): boolean {
  if (section === undefined) return WAKE_SHIPPED
  if (typeof section === 'boolean') return section
  const w = record(section)
  if (!w) return false
  if (w.enabled === undefined) return WAKE_SHIPPED
  return w.enabled === true
}

/** config.json's `wake` (undefined, true, false or an object) with the defaults; a wrong type is the default, but a wrong switch is off. */
export function wakeConfig(section: unknown): WakeConfig {
  const w = record(section) ?? {}
  const enabled = switchOf(section)
  return {
    enabled,
    reaper: reaperConfig(w.reaper),
    telegram: w.telegram === 'auto' ? 'auto' : 'off',
    port: count(w.port, WAKE_PORT, 65535),
    workspace: filled(w.workspace) ? w.workspace : 'Wake',
    url: filled(w.url) ? w.url : null,
    authorization: filled(w.authorization) ? w.authorization : null,
    server: filled(w.server) ? w.server : 'telegram',
    wakeTimeoutSec: count(w.wakeTimeoutSec, 120),
    pollTimeoutSec: count(w.pollTimeoutSec, 25),
    listSleepingDays: count(w.listSleepingDays, 7),
    closePanes: w.closePanes !== false,
  }
}

/** The kill switch, read before anything else: config.json missing → WAKE_SHIPPED; there but not an object (does not parse) → off. */
export function wakeSwitch(file: { exists: boolean; raw: unknown }): boolean {
  if (!file.exists) return WAKE_SHIPPED
  const raw = record(file.raw)
  return raw ? wakeConfig(raw.wake).enabled : false
}

export interface TelegramEnvSource {
  /** Source name only (never a value or absolute path), e.g. `node/env/default.env`. */
  name: string
  vars: Readonly<Record<string, string | undefined>>
}

export interface TelegramTargetOptions {
  /** Process environment preferred when expanding `${VAR}` in MCP headers. */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * Fallback profile env files (`node/env/default.env`, then other `*.env`),
   * evaluated lazily only when a `${VAR}` in the header is missing from `env`.
   */
  envFiles?: readonly TelegramEnvSource[] | (() => readonly TelegramEnvSource[])
}

export interface TelegramTarget {
  url: string
  authorization: string
  /** The url's host and port. */
  host: string
  /** Source name when `${VAR}` in the Authorization header was expanded (never the value); omitted for literal tokens. */
  tokenSource?: string
}

const ENV_VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

function resolveHeaderAuthorization(
  raw: string,
  o?: TelegramTargetOptions,
): { value: string; tokenSource?: string } | null {
  if (!raw.includes('${')) return { value: raw }
  const env = o?.env
  let cachedFiles: readonly TelegramEnvSource[] | undefined
  const files = (): readonly TelegramEnvSource[] => {
    if (cachedFiles === undefined) {
      cachedFiles = typeof o?.envFiles === 'function' ? o.envFiles() : (o?.envFiles ?? [])
    }
    return cachedFiles
  }
  const sources: string[] = []
  let missing = false
  const value = raw.replace(ENV_VAR_REF, (_match, name: string, fallback: string | undefined) => {
    if (env && Object.hasOwn(env, name)) {
      const v = env[name]
      if (typeof v === 'string' && v !== '') {
        if (!sources.includes('env')) sources.push('env')
        return v
      }
    }
    for (const file of files()) {
      if (Object.hasOwn(file.vars, name)) {
        const v = file.vars[name]
        if (typeof v === 'string' && v !== '') {
          if (!sources.includes(file.name)) sources.push(file.name)
          return v
        }
      }
    }
    if (fallback !== undefined) return fallback
    missing = true
    return ''
  })
  if (missing || !filled(value)) return null
  return sources.length > 0 ? { value, tokenSource: sources.join(', ') } : { value }
}

/** tg-mcp's url and token: the section's, else the `<server>` MCP server in ~/.claude.json (`/mcp` taken off the url); null when Telegram is off or either is missing. */
export function telegramTarget(cfg: WakeConfig, claudeJson: unknown, o?: TelegramTargetOptions): TelegramTarget | null {
  if (cfg.telegram !== 'auto') return null
  const mcp = record(record(record(claudeJson)?.mcpServers)?.[cfg.server])
  const mcpUrl = filled(mcp?.url) ? mcp.url.replace(/\/mcp\/?$/, '') : null
  const headers = record(mcp?.headers)
  const rawAuth =
    headers?.Authorization ??
    (headers ? Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] : undefined)
  const url = cfg.url ?? (filled(mcpUrl) ? mcpUrl : null)
  const auth = cfg.authorization
    ? { value: cfg.authorization }
    : filled(rawAuth)
      ? resolveHeaderAuthorization(rawAuth, o)
      : null
  if (!url || !auth) return null
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  return host
    ? { url, authorization: auth.value, host, ...(auth.tokenSource && { tokenSource: auth.tokenSource }) }
    : null
}
