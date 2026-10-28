// What never crosses in the profile sync, in either direction (the board-on-own-server spec's
// "Next step: syncing the Claude profiles"): the files of one machine only, the secret files, a
// secret found in any file (cut out, its kind shown, never its value), and in the two settings
// files merged by key, settings.json and .claude.json, the keys and tokens in `env`, the OAuth
// part and the machine's own state, MCP servers' headers and env, the board's own hooks and its
// browser MCP server (each side's install writes its own; the agents' browser profiles live in the
// board's state folder, which the sync never reads), and hooks, status lines and MCP servers that hold a secret or
// cannot run on the other side (a Windows path or program going to Linux, a Linux path going to
// Windows). What remains is each file's shared part: the target merges it into its own. Pure.
import { BROWSER_MCP } from '../desktop.ts'
import type { Platform } from './paths.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A top-level name of a profile folder that is one machine's only (the spec's list, its caches, its locks). */
const ONE_MACHINE_TOP =
  /^(cache|statsig|shell-snapshots|session-env|sessions|ide|telemetry|debug|backups|plugins|daemon.*|stats-cache\.json|\.csa-usage-cache\.json|mcp-needs-auth-cache\.json|\.last-cleanup|\.last-update-result\.json)$/
/** Anywhere: a lock, the board's own backup of a settings file, a part the sync writes and renames. */
const ONE_MACHINE_ANY = /(\.lock|\.bak-agent-board|\.agent-board-sync)$/
/** herdr's own Claude hook script, and the board's skill for the agents (each side's install writes its own). */
const HERDR_HOOK_FILE = /^hooks\/herdr-agent-state\.[a-z0-9]+$|^skills\/herdr-agents\//i

/** A path in a profile folder ('/' between its parts) that belongs to its machine only: never synced, never listed. */
export const oneMachine = (rel: string): boolean =>
  ONE_MACHINE_TOP.test(rel.split('/')[0] ?? '') || ONE_MACHINE_ANY.test(rel) || HERDR_HOOK_FILE.test(rel)

/** A file that is a secret as a whole: Claude's credentials, and any copy of .claude.json (its OAuth part) but the profile's own. */
export const secretFile = (rel: string): boolean =>
  /^\.credentials\.json/.test(rel.split('/').at(-1) ?? '') || /^\.claude\.json.+/.test(rel)

/** The files merged by key on the target (settings and history), never replaced whole. */
export const MERGED: ReadonlySet<string> = new Set(['.claude.json', 'settings.json', 'history.jsonl'])

/** A secret's kind, and how it looks. Each is looked for only where its marker is in the text. */
const PATTERNS: readonly { kind: string; marker: string; re: RegExp; keep?: number }[] = [
  {
    kind: 'private key',
    marker: 'PRIVATE KEY-----',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'Anthropic key', marker: 'sk-ant-', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI key', marker: 'sk-', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{40,}/g },
  { kind: 'GitHub token', marker: 'gh', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'GitLab token', marker: 'glpat-', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'Slack token', marker: 'xox', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'AWS key', marker: 'A', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Google key', marker: 'AIza', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'npm token', marker: 'npm_', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'Telegram bot token', marker: ':AA', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { kind: 'JWT', marker: 'eyJ', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer token', marker: 'Bearer', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{24,}/g, keep: 1 },
]

/** What a secret is cut to: plain text, no quote or backslash, so a JSON line stays JSON. */
export const CUT = '[secret held back by agent-board]'

/** The secrets in a text, cut out: the text left, and each kind found with how many. */
export function cutSecrets(text: string): { text: string; found: Record<string, number> } {
  const found: Record<string, number> = {}
  let out = text
  for (const p of PATTERNS) {
    if (!out.includes(p.marker)) continue
    out = out.replace(p.re, (...m: string[]) => {
      found[p.kind] = (found[p.kind] ?? 0) + 1
      return `${p.keep ? (m[p.keep] ?? '') : ''}${CUT}`
    })
  }
  return { text: out, found }
}

/** Whether a text holds a secret of any kind. */
export const hasSecret = (text: string): boolean => Object.keys(cutSecrets(text).found).length > 0

/** An `env` name that holds a key or a token (ANTHROPIC_API_KEY, GITHUB_TOKEN, …; not MAX_OUTPUT_TOKENS). */
export const secretName = (name: string): boolean =>
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|COOKIE|PRIVATE)(_|$)/i.test(name) ||
  /(apikey|token|secret|password|credential)$/i.test(name)

/** A command of the board's own, or herdr's (each side's install writes its own). */
export const boardCommand = (command: string): boolean => /agent-board|herdr-wake|herdr-agent-state/i.test(command)

const WINDOWS_ONLY = /(^|[\s"'=(])[A-Za-z]:[\\/]|\.(exe|ps1|cmd|bat)\b|%[A-Za-z_]+%|\b(powershell|pwsh)\b/i
const POSIX_ONLY = /(^|[\s"'=(:])\/(home|Users|usr|opt|etc|var|root|tmp|srv|mnt|bin|sbin|snap)\//

/** How a command is carried to the other side: its source home moved to the target's (between Linux and macOS). */
export interface CarryTo {
  platform: Platform
  /** The source's system and home, and the target's. */
  from: Platform
  fromHome: string
  toHome: string
}

/** A command as it runs on the target (the source's home moved to the target's there), or null when it cannot run there. */
export function carried(command: string, to: CarryTo): string | null {
  if (to.platform === 'win32') return to.from === 'win32' ? command : POSIX_ONLY.test(command) ? null : command
  if (WINDOWS_ONLY.test(command)) return null
  if (to.from === 'win32' || to.fromHome === '' || to.fromHome === to.toHome) return command
  return command.split(`${to.fromHome}/`).join(`${to.toHome}/`)
}

/** A short form of a command for the preview: its first 80 characters. */
const shortly = (command: string): string => (command.length > 80 ? `${command.slice(0, 77)}…` : command)

/** A file's shared part: what goes to the target, and what stayed (secrets, held) or could not go. */
export interface Shared {
  value: Record<string, unknown>
  held: string[]
  cantGo: string[]
}

/** settings.json keys that run a program to fetch a secret: the machine's own. */
const SECRET_HELPERS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'])

/**
 * settings.json's shared part: `env` without its keys and tokens; no secret helpers; no hook or
 * status line of the board's (each side's own); a hook or status line holding a secret held back;
 * one that cannot run on the target (`to`) left behind. With no `to`: the part the hashes are of,
 * the same whichever side it goes to.
 */
export function shareSettings(settings: unknown, to: CarryTo | null): Shared {
  const held: string[] = []
  const cantGo: string[] = []
  const value: Record<string, unknown> = {}
  if (!isRecord(settings)) return { value, held, cantGo }
  const carry = (what: string, command: string): string | null => {
    if (hasSecret(command)) {
      held.push(`${what}: ${shortly(cutSecrets(command).text)}`)
      return null
    }
    if (!to) return command
    const c = carried(command, to)
    if (c === null) cantGo.push(`${what}: ${shortly(command)}`)
    return c
  }
  for (const [key, v] of Object.entries(settings)) {
    if (SECRET_HELPERS.has(key)) {
      held.push(key)
      continue
    }
    if (key === 'env' && isRecord(v)) {
      const env: Record<string, unknown> = {}
      for (const [name, val] of Object.entries(v)) {
        if (secretName(name) || (typeof val === 'string' && hasSecret(val))) held.push(`env ${name}`)
        else env[name] = val
      }
      value.env = env
      continue
    }
    if (key === 'statusLine' && isRecord(v)) {
      const command = typeof v.command === 'string' ? v.command : ''
      if (boardCommand(command)) continue
      const c = command ? carry('statusLine', command) : ''
      if (c !== null) value.statusLine = command ? { ...v, command: c } : v
      continue
    }
    if (key === 'hooks' && isRecord(v)) {
      const hooks: Record<string, unknown> = {}
      for (const [event, list] of Object.entries(v)) {
        if (!Array.isArray(list)) continue
        const entries: unknown[] = []
        for (const entry of list) {
          if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue
          const kept: unknown[] = []
          for (const h of entry.hooks) {
            const command = isRecord(h) && typeof h.command === 'string' ? h.command : ''
            if (boardCommand(command)) continue
            const c = command ? carry(`hook ${event}`, command) : ''
            if (c !== null) kept.push(command ? { ...(h as Record<string, unknown>), command: c } : h)
          }
          if (kept.length) entries.push({ ...entry, hooks: kept })
        }
        if (entries.length) hooks[event] = entries
      }
      value.hooks = hooks
      continue
    }
    value[key] = v
  }
  return { value, held, cantGo }
}

/** .claude.json's OAuth part and other keys that are secrets: held back, and shown. */
const CLAUDE_JSON_SECRET =
  /^(oauthAccount|primaryApiKey|customApiKeyResponses)$|(apikey|token|secret|password|credential)/i
/**
 * .claude.json's machine's own state: who it is (ids), its install and updates, counters, caches,
 * what it has seen and shown, its onboarding. Kept on each side, never listed one by one.
 */
const CLAUDE_JSON_OWN =
  /^(userID|anonymousId|machineID|installMethod|autoUpdates.*|numStartups|firstStartTime|claudeCodeFirstTokenDate|migrationVersion|githubRepoPaths|hasCompletedOnboarding|lastOnboardingVersion|lastReleaseNotesSeen|changelogLastFetched|seenNotifications|subscriptionNoticeCount|hasAvailableSubscription|isQualifiedForDataSharing|feedbackSurveyState|closedIssuesLastChecked|fallbackAvailableWarningThreshold|penguinModeOrgEnabled|claudeAiMcpEverConnected|lastPlanModeUse|replBridgePlaceholders|diffSidebarOpen|lastClawdEntranceVersion|agentLastUsed|toolUsage|skillUsage|tipsHistory.*|tipLifetime.*|announcement.*|promo.*|passes.*|groveC.*|officialMarketplaceAutoInstall.*|pluginUsage.*|metricsStatus.*|overageCreditGrant.*|clientDataCache.*|additionalModel.*|modelAccess.*|orgModelDefault.*|autoCompactWindows.*|githubWebConnection.*|apiCreditLink.*|promptSuggestion.*|rcLongTurn.*|unpin.*|effortCallout.*|birthdayHat.*|fotw.*|mcpNeedsAuthNoticed|remoteDialogSeen|transcriptShareDismissed)$|[Cc]ache|^cached|^statsig|^growthBook|Migration(Complete|Timestamp)?$|(Count|Seen|Shown|Dismissed)$|^has(Seen|Used|Opened|Visited|Shown|Reset|Ide)|Upsell|Nudge/

/**
 * An MCP server's shared part, or null when it stays: never its headers or env (the target keeps
 * its own); a local program that cannot run on the target, or a secret in its command, url or
 * args, keeps it here.
 */
function shareMcp(
  name: string,
  server: unknown,
  to: CarryTo | null,
  held: string[],
  cantGo: string[],
): Record<string, unknown> | null {
  if (!isRecord(server)) return null
  const { headers, env, ...rest } = server
  if (isRecord(headers) && Object.keys(headers).length) held.push(`MCP ${name}: headers`)
  if (isRecord(env) && Object.keys(env).length) held.push(`MCP ${name}: env`)
  const args = Array.isArray(rest.args) ? rest.args.map(String) : []
  const command = typeof rest.command === 'string' ? rest.command : ''
  const line = [command, ...args, typeof rest.url === 'string' ? rest.url : ''].join(' ')
  if (hasSecret(line)) {
    held.push(`MCP ${name}`)
    return null
  }
  if (!to || command === '') return rest
  const c = carried(command, to)
  const a = args.map(x => carried(x, to))
  if (c === null || a.includes(null)) {
    cantGo.push(`MCP ${name}: ${shortly([command, ...args].join(' '))}`)
    return null
  }
  return { ...rest, command: c, ...(Array.isArray(rest.args) && { args: a }) }
}

function shareMcps(
  v: unknown,
  to: CarryTo | null,
  held: string[],
  cantGo: string[],
  where: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRecord(v)) return out
  for (const [name, server] of Object.entries(v)) {
    // the board's own browser MCP server is each side's install's (the board's server only)
    if (name === BROWSER_MCP) continue
    const s = shareMcp(where ? `${name} (${where})` : name, server, to, held, cantGo)
    if (s) out[name] = s
  }
  return out
}

/**
 * .claude.json's shared part: no OAuth part or secret keys (held back, shown), none of the
 * machine's own state; MCP servers without headers and env; its `projects` as the target names
 * them (`project`: the source's path to the target's, null for one left out), unpaired ones
 * dropped. With no `to` and no `project`: the part the hashes are of.
 */
export function shareClaudeJson(
  cj: unknown,
  to: CarryTo | null,
  project: ((path: string) => string | null) | null = null,
): Shared {
  const held: string[] = []
  const cantGo: string[] = []
  const value: Record<string, unknown> = {}
  if (!isRecord(cj)) return { value, held, cantGo }
  for (const [key, v] of Object.entries(cj)) {
    if (CLAUDE_JSON_OWN.test(key)) continue
    if (CLAUDE_JSON_SECRET.test(key)) {
      held.push(key)
      continue
    }
    if (key === 'mcpServers') {
      value.mcpServers = shareMcps(v, to, held, cantGo, '')
      continue
    }
    if (key === 'projects' && isRecord(v)) {
      const projects: Record<string, unknown> = {}
      for (const [path, entry] of Object.entries(v)) {
        const there = project ? project(path) : path
        if (there === null || !isRecord(entry)) continue
        const { mcpServers, ...rest } = entry
        projects[there] = {
          ...rest,
          ...(mcpServers !== undefined && { mcpServers: shareMcps(mcpServers, to, held, cantGo, there) }),
        }
      }
      value.projects = projects
      continue
    }
    value[key] = v
  }
  return { value, held, cantGo }
}
