// What never crosses in the profile sync, in either direction (the board-on-own-server spec's
// "Next step: syncing the Claude profiles"): the files of one machine only, the secret files, a
// secret found in any file (cut out, its kind shown, never its value), and in the two settings
// files merged by key, settings.json and .claude.json, the keys and tokens in `env` (and the names
// that steer where a side's requests go), the OAuth part and the machine's own state, MCP servers'
// headers and env, the board's own hooks and its browser MCP server (each side's install writes its
// own; the agents' browser profiles live in the board's state folder, which the sync never reads),
// any key holding a secret, and hooks, status lines and MCP servers that hold a secret or cannot
// run on the other side (a Windows path or program going to Linux, a Linux path going to Windows). What remains is
// each file's shared part: the target merges it into its own. Of that part, what changes how the
// other side runs (env, hooks, the status line, MCP servers, helper programs and plugins) goes only
// in the groups the owner ticks; session and edit history only when ticked too. Pure.
import { BROWSER_MCP } from '../desktop.ts'
import type { Platform } from './paths.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A top-level name of a profile folder that is one machine's only (the spec's list, its caches, its locks). */
const ONE_MACHINE_TOP =
  /^(cache|statsig|shell-snapshots|session-env|sessions|ide|telemetry|debug|backups|plugins|channels|local|daemon.*|stats-cache\.json|\.csa-usage-cache\.json|mcp-needs-auth-cache\.json|\.last-cleanup|\.last-update-result\.json)$/
/** Anywhere: a lock, the board's own backups of a settings file, a part the sync writes and renames. */
const ONE_MACHINE_ANY = /(\.lock|\.bak-agent-board|\.bak-profile-sync|\.agent-board-sync)$/
/** herdr's own Claude hook script, and the board's skill for the agents (each side's install writes its own). */
const HERDR_HOOK_FILE = /^hooks\/herdr-agent-state\.[a-z0-9]+$|^skills\/herdr-agents\//i

/** A path in a profile folder ('/' between its parts) that belongs to its machine only: never synced, never listed. */
export const oneMachine = (rel: string): boolean =>
  ONE_MACHINE_TOP.test(rel.split('/')[0] ?? '') || ONE_MACHINE_ANY.test(rel) || HERDR_HOOK_FILE.test(rel)

/**
 * A file that is a secret as a whole, at any depth: Claude's credentials, any copy of .claude.json
 * (its OAuth part) but the profile's own, `.env*`, keys and certificates (`*.pem`, `*.key`, `id_*`),
 * and a settings file other than settings.json (settings.local.json: the machine's own, its keys).
 */
export function secretFile(rel: string): boolean {
  const name = rel.split('/').at(-1) ?? ''
  return (
    /^\.credentials\.json/.test(name) ||
    /^\.claude\.json.+/.test(rel) ||
    /^\.env/.test(name) ||
    /\.(pem|key|p12|pfx)$/i.test(name) ||
    /^id_[A-Za-z0-9_-]+$/.test(name) ||
    /^settings.+\.json$/i.test(name)
  )
}

/**
 * Session history and edit history: the transcripts and what sits beside them in a project's folder
 * (its memory not), file-history, paste-cache, history.jsonl. They may hold any password, database
 * URL or .env a session saw, which no shape finds: they go only when the owner ticks them.
 */
export const historyFile = (rel: string): boolean =>
  rel === 'history.jsonl' ||
  /^(file-history|paste-cache)\//.test(rel) ||
  (/^projects\/[^/]+\/./.test(rel) && !/^projects\/[^/]+\/memory\//.test(rel))

/** The files merged by key on the target (settings and history), never replaced whole. */
export const MERGED: ReadonlySet<string> = new Set(['.claude.json', 'settings.json', 'history.jsonl'])

/** Before a token: not inside a word, or just after a JSON escape (`\n`, `\t`, …) in a raw text. */
const B = String.raw`(?:(?<=\\[nrtbf])|(?<![A-Za-z0-9_]))`
const re = (body: string, flags = 'g'): RegExp => new RegExp(body, flags)

/** A secret's kind, and how it looks. */
const PATTERNS: readonly { kind: string; re: RegExp; keep?: number }[] = [
  {
    // within one string: to its END line, or (none there) over the base64 that follows its BEGIN
    kind: 'private key',
    re: re(
      String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]{0,16384}?-----END [A-Z ]*PRIVATE KEY-----|(?:\s|\\[nr]|[A-Za-z0-9+/=:,-])*)`,
    ),
  },
  { kind: 'Anthropic key', re: re(`${B}sk-ant-[A-Za-z0-9_-]{20,}`) },
  { kind: 'OpenAI key', re: re(`${B}sk-(?!ant-)[A-Za-z0-9_-]{40,}`) },
  { kind: 'GitHub token', re: re(`${B}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`) },
  { kind: 'GitLab token', re: re(`${B}glpat-[A-Za-z0-9_-]{20,}`) },
  { kind: 'Slack token', re: re(`${B}xox[abposr]-[A-Za-z0-9-]{10,}`) },
  { kind: 'AWS key', re: re(String.raw`${B}(?:AKIA|ASIA)[0-9A-Z]{16}\b`) },
  { kind: 'Google key', re: re(String.raw`${B}AIza[0-9A-Za-z_-]{35}\b`) },
  { kind: 'npm token', re: re(String.raw`${B}npm_[A-Za-z0-9]{36}\b`) },
  { kind: 'Telegram bot token', re: re(String.raw`${B}\d{8,10}:AA[A-Za-z0-9_-]{33}\b`) },
  { kind: 'JWT', re: re(`${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`) },
  { kind: 'bearer token', re: re(String.raw`${B}(Bearer\s+)[A-Za-z0-9._~+/=-]{24,}`), keep: 1 },
  {
    kind: 'password in a URL',
    re: re(String.raw`(?<![A-Za-z0-9_+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/:@"'<>\\]+:[^\s/@"'<>\\]+@`),
    keep: 1,
  },
]
/** A quick look first: a text with none of these holds none of the secrets above. */
const MAYBE =
  /PRIVATE KEY-----|sk-|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|AKIA|ASIA|AIza|npm_|:AA|eyJ|Bearer|:\/\/[^\s/@]+:[^\s/@]+@/

/** What a secret is cut to: plain text, no quote or backslash, so a JSON line stays JSON. */
export const CUT = '[secret held back by agent-board]'

type Found = Record<string, number>
const add = (to: Found, from: Found): void => {
  for (const [k, n] of Object.entries(from)) to[k] = (to[k] ?? 0) + n
}

/** The secrets in a text (a string as it is), cut out: the text left, and each kind found with how many. */
export function cutSecrets(text: string): { text: string; found: Found } {
  const found: Found = {}
  if (!MAYBE.test(text)) return { text, found }
  let out = text
  for (const p of PATTERNS)
    out = out.replace(p.re, (...m: string[]) => {
      found[p.kind] = (found[p.kind] ?? 0) + 1
      return `${p.keep ? (m[p.keep] ?? '') : ''}${CUT}`
    })
  return { text: out, found }
}

/** A JSON value with the secrets in its strings (keys too) cut: whether any was. */
function cutInValue(v: unknown, found: Found): { value: unknown; cut: boolean } {
  if (typeof v === 'string') {
    const r = cutSecrets(v)
    add(found, r.found)
    return { value: r.text, cut: r.text !== v }
  }
  if (Array.isArray(v)) {
    let cut = false
    const value = v.map(x => {
      const r = cutInValue(x, found)
      cut ||= r.cut
      return r.value
    })
    return { value, cut }
  }
  if (isRecord(v)) {
    let cut = false
    const value: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const key = cutInValue(k, found)
      const r = cutInValue(x, found)
      cut ||= key.cut || r.cut
      value[key.value as string] = r.value
    }
    return { value, cut }
  }
  return { value: v, cut: false }
}

/** The kinds of the secrets in a JSON value's strings. */
export const secretsIn = (v: unknown): string[] => {
  const found: Found = {}
  cutInValue(v, found)
  return Object.keys(found)
}

/** One line of JSON Lines, its secrets cut in its decoded strings (a line that is not JSON: as text, alone). */
function cutLine(line: string, found: Found): string {
  if (!MAYBE.test(line)) return line
  const cr = line.endsWith('\r') ? '\r' : ''
  const body = cr ? line.slice(0, -1) : line
  try {
    const v = JSON.parse(body)
    const r = cutInValue(v, found)
    return r.cut ? `${JSON.stringify(r.value)}${cr}` : line
  } catch {
    const r = cutSecrets(line)
    add(found, r.found)
    return r.text
  }
}

/**
 * A file's text with its secrets cut, as its kind reads: JSON and JSON Lines parsed and their
 * decoded strings looked through (a key within one string; a line never merged with another), any
 * other text as it is. Nothing found: the text as it was, byte for byte.
 */
export function cutSecretsInFile(rel: string, text: string): { text: string; found: Found } {
  const found: Found = {}
  if (!MAYBE.test(text)) return { text, found }
  if (rel.endsWith('.json')) {
    try {
      const r = cutInValue(JSON.parse(text), found)
      return { text: r.cut ? `${JSON.stringify(r.value, null, 2)}\n` : text, found }
    } catch {}
  }
  if (rel.endsWith('.json') || rel.endsWith('.jsonl')) {
    const out = text
      .split('\n')
      .map(l => cutLine(l, found))
      .join('\n')
    return { text: out, found }
  }
  return cutSecrets(text)
}

/** Whether a text holds a secret of any kind. */
export const hasSecret = (text: string): boolean => Object.keys(cutSecrets(text).found).length > 0

/** An `env` name that holds a key or a token (ANTHROPIC_API_KEY, GITHUB_TOKEN, MY_PAT, SENTRY_DSN, …; not MAX_OUTPUT_TOKENS). */
export const secretName = (name: string): boolean =>
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PAT|DSN|CREDENTIALS?|AUTH|COOKIE|PRIVATE|CONNECTION_STRING)(_|$)/i.test(
    name,
  ) || /(apikey|token|secret|password|credential|dsn)$/i.test(name)

/**
 * An `env` name never carried either way, secret or not: where a side's requests go and what
 * they carry (a base URL, a proxy, headers), and how its Node runs (NODE_OPTIONS).
 */
export const ownEnvName = (name: string): boolean => /_BASE_URL$|PROXY|^NODE_OPTIONS$|_HEADERS$/i.test(name)

/** A flag that passes a secret (`--api-key`, `--token`, `-p`-less `--password`): its words' parts. */
const SECRET_FLAG_PART = /^(token|key|apikey|secret|password|passwd|pwd|pat|auth|credentials?|bearer)$/i

/** The secret flags in a command's words (`--api-key x`, `--token=x`): the words with their values cut, and how many. */
export function cutArgs(words: readonly string[]): { words: string[]; n: number } {
  const out = [...words]
  let n = 0
  for (let i = 0; i < out.length; i++) {
    const m = /^--?([A-Za-z0-9_-]+?)(=(.*))?$/.exec(out[i] as string)
    if (!m || !(m[1] as string).split(/[-_]/).some(part => SECRET_FLAG_PART.test(part))) continue
    if (m[2] !== undefined) {
      if (m[3]) {
        out[i] = `--${m[1]}=${CUT}`
        n++
      }
    } else if (i + 1 < out.length && !(out[i + 1] as string).startsWith('-')) {
      out[i + 1] = CUT
      n++
      i++
    }
  }
  return { words: out, n }
}

/** A URL's query parameters that pass a secret (`?token=`, `&api_key=`, `#access_token=`): how many. */
const secretQuery = (url: string): number =>
  [
    ...url.matchAll(
      /[?&;#]([^=&#;\s]*(?:token|key|secret|password|passwd|pwd|auth|sig|signature|credential|code)[^=&#;\s]*)=[^&#;\s]+/gi,
    ),
  ].length

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
export const shortly = (command: string): string => (command.length > 80 ? `${command.slice(0, 77)}…` : command)

/** A command with its secrets cut (shapes and flags), as the preview may show it; how many were. */
function cutCommand(command: string): { text: string; n: number } {
  const shapes = cutSecrets(command)
  const args = cutArgs(shapes.text.split(/\s+/))
  return { text: args.n ? args.words.join(' ') : shapes.text, n: Object.keys(shapes.found).length + args.n }
}

/** A file's shared part: what goes to the target, and what stayed (secrets, held) or could not go. */
export interface Shared {
  value: Record<string, unknown>
  held: string[]
  cantGo: string[]
}

/** settings.json keys that run a program to fetch a secret: the machine's own. */
const SECRET_HELPERS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'])

/** A key holding a secret anywhere in it (other than those looked at closer): held back, its kinds shown. */
function holdSecretKey(where: string, v: unknown, held: string[]): boolean {
  const kinds = secretsIn(v)
  if (kinds.length) held.push(`${where}: ${kinds.join(', ')}`)
  return kinds.length > 0
}

/**
 * settings.json's shared part: `env` without its keys and tokens, base URLs, proxies, headers and
 * NODE_OPTIONS; no secret helpers; no hook or status line of the board's (each side's own); a hook
 * or status line holding a secret held back; one that cannot run on the target (`to`) left behind;
 * any other key holding a secret held back. With no `to`: the part the hashes are of, the same
 * whichever side it goes to.
 */
export function shareSettings(settings: unknown, to: CarryTo | null): Shared {
  const held: string[] = []
  const cantGo: string[] = []
  const value: Record<string, unknown> = {}
  if (!isRecord(settings)) return { value, held, cantGo }
  const carry = (what: string, command: string, whole: unknown): string | null => {
    const c = cutCommand(command)
    if (c.n || secretsIn(whole).length) {
      held.push(`${what}: ${shortly(c.text)}`)
      return null
    }
    if (!to) return command
    const there = carried(command, to)
    if (there === null) cantGo.push(`${what}: ${shortly(command)}`)
    return there
  }
  for (const [key, v] of Object.entries(settings)) {
    if (SECRET_HELPERS.has(key)) {
      held.push(key)
      continue
    }
    if (key === 'env' && isRecord(v)) {
      const env: Record<string, unknown> = {}
      for (const [name, val] of Object.entries(v)) {
        if (secretName(name) || ownEnvName(name) || secretsIn(val).length) held.push(`env ${name}`)
        else env[name] = val
      }
      value.env = env
      continue
    }
    if (key === 'statusLine' && isRecord(v)) {
      const command = typeof v.command === 'string' ? v.command : ''
      if (boardCommand(command)) continue
      const c = carry('statusLine', command, v)
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
            const c = carry(`hook ${event}`, command, h)
            if (c !== null) kept.push(command ? { ...(h as Record<string, unknown>), command: c } : h)
          }
          if (kept.length) entries.push({ ...entry, hooks: kept })
        }
        if (entries.length) hooks[event] = entries
      }
      value.hooks = hooks
      continue
    }
    if (holdSecretKey(key, v, held)) continue
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
/** A project entry's machine state in .claude.json: its last session and its costs, its onboarding, its old prompt history. */
const PROJECT_OWN =
  /^(lastSessionId|last[A-Z]\w*|projectOnboardingSeenCount|hasCompletedProjectOnboarding|exampleFiles\w*|reactVulnerabilityCache|hasClaudeMdExternalIncludes\w*|history)$/

/**
 * An MCP server's shared part, or null when it stays: never its headers or env (the target keeps
 * its own); a local program that cannot run on the target, or a secret in its command, url (its
 * query), args (`--api-key x`) or anywhere else in it, keeps it here.
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
  const url = typeof rest.url === 'string' ? rest.url : ''
  const kinds = [
    ...secretsIn(rest),
    ...(secretQuery(url) ? ['a key in its url'] : []),
    ...(cutArgs([...command.split(/\s+/), ...args]).n ? ['a key in its args'] : []),
  ]
  if (kinds.length) {
    held.push(`MCP ${name}: ${[...new Set(kinds)].join(', ')}`)
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
 * machine's own state (a project's either); MCP servers without headers and env; its `projects` as
 * the target names them (`project`: the source's path to the target's, null for one left out),
 * unpaired ones dropped; any other key holding a secret held back. With no `to` and no `project`:
 * the part the hashes are of.
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
        const kept: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(entry)) {
          if (PROJECT_OWN.test(k)) continue
          if (k === 'mcpServers') kept.mcpServers = shareMcps(x, to, held, cantGo, there)
          else if (!holdSecretKey(`projects ${there}: ${k}`, x, held)) kept[k] = x
        }
        projects[there] = kept
      }
      value.projects = projects
      continue
    }
    if (holdSecretKey(key, v, held)) continue
    value[key] = v
  }
  return { value, held, cantGo }
}

// ---------------------------------------------------------------------------------------------
// The groups that change how the other side runs: each goes only when the owner ticks it

/** What a merge may change in how the target runs: its env, hooks, status line, MCP servers, and other programs (helpers, plugins). */
export type RunGroup = 'env' | 'hooks' | 'statusLine' | 'mcp' | 'helpers'
export const RUN_GROUPS: readonly RunGroup[] = ['env', 'hooks', 'statusLine', 'mcp', 'helpers']

/** What the owner ticked: each run group, and session history. None ticked: none goes. */
export type Allow = Readonly<Partial<Record<RunGroup | 'history', boolean>>>

/** A settings.json key's group; null for one that runs nothing. */
export function settingsGroup(key: string, v: unknown): RunGroup | null {
  if (key === 'env') return 'env'
  if (/hook/i.test(key)) return 'hooks'
  if (/statusLine/i.test(key)) return 'statusLine'
  if (/mcp/i.test(key)) return 'mcp'
  if (
    /(Helper|Command)$|^(enabledPlugins|extraKnownMarketplaces)$/i.test(key) ||
    (isRecord(v) && typeof v.command === 'string')
  )
    return 'helpers'
  return null
}

/** A whole file's group: a hook's script (hooks/), the status line's (a top-level statusline* file); null for the rest. */
export const fileGroup = (rel: string): RunGroup | null =>
  /^hooks\//.test(rel) ? 'hooks' : /^statusline[^/]*$/i.test(rel) ? 'statusLine' : null

/** A .claude.json key's group (its own, or a project entry's); null for one that runs nothing. */
export const claudeJsonGroup = (key: string): RunGroup | null => (/mcp/i.test(key) ? 'mcp' : null)

const empty = (v: unknown): boolean =>
  v === undefined || v === null || (isRecord(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0)

/**
 * A merged file's shared part without the groups not ticked; `withheld`: the groups that held
 * something. Nothing withheld: the very part it was given (so its hash is the one the scan made).
 */
export function withhold(
  rel: string,
  shared: Record<string, unknown>,
  allow: Allow,
): { value: Record<string, unknown>; withheld: RunGroup[] } {
  const withheld = new Set<RunGroup>()
  const off = (g: RunGroup | null): g is RunGroup => g !== null && allow[g] !== true
  if (rel === 'settings.json') {
    const value: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(shared)) {
      const g = settingsGroup(key, v)
      if (off(g)) {
        if (!empty(v)) withheld.add(g)
      } else value[key] = v
    }
    return withheld.size ? { value, withheld: [...withheld] } : { value: shared, withheld: [] }
  }
  if (rel === '.claude.json') {
    const value: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(shared)) {
      if (key === 'projects' && isRecord(v)) {
        const projects: Record<string, unknown> = {}
        for (const [path, entry] of Object.entries(v)) {
          if (!isRecord(entry)) continue
          const kept: Record<string, unknown> = {}
          for (const [k, x] of Object.entries(entry)) {
            const g = claudeJsonGroup(k)
            if (off(g)) {
              if (!empty(x)) withheld.add(g)
            } else kept[k] = x
          }
          projects[path] = kept
        }
        value.projects = projects
        continue
      }
      const g = claudeJsonGroup(key)
      if (off(g)) {
        if (!empty(v)) withheld.add(g)
      } else value[key] = v
    }
    return withheld.size ? { value, withheld: [...withheld] } : { value: shared, withheld: [] }
  }
  return { value: shared, withheld: [] }
}
