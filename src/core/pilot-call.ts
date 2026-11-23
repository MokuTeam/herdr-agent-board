// MokuPilot call agent running on a remote node (#618): pure validation, CLI argument building,
// and environment sanitization shared between the node's door endpoints (services/node/pilot-call.ts)
// and the master's local bridge (services/nodes/pilot-call.ts). No I/O here.

export const PILOT_CALL_ID = /^[A-Za-z0-9_-]{8,64}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,120}$/
export const SAFE_EFFORT = /^[A-Za-z0-9._-]{1,40}$/
export const SAFE_MCP_NAME = /^[A-Za-z0-9._-]{1,64}$/
export const SAFE_TOOL = /^[A-Za-z0-9._:-]{1,120}$/

/** Claude settings passed via --settings so owner hooks never fire during a voice call. */
export const NO_HOOKS_SETTINGS = JSON.stringify({ disableAllHooks: true })

/** Maximum size of one NDJSON line sent to Claude stdin (turns may include base64 images). */
export const MAX_STDIN_LINE_BYTES = 16 * 1024 * 1024
/** Maximum size of one MCP HTTP request or response body (screenshots may be returned). */
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024
/** Maximum size of one uploaded call file (protocol, transcript, utterances). */
export const MAX_CALL_FILE_BYTES = 20 * 1024 * 1024
/** Maximum total payload size for a call files upload request (base64 overhead included). */
export const MAX_CALL_FILES_REQUEST_BYTES = 45 * 1024 * 1024
/** Maximum number of MCP tools allowed in one call. */
const MAX_MCP_TOOLS = 64

export type CallFileKind = 'protocol' | 'transcript' | 'utterances'
const FILE_KINDS: ReadonlySet<string> = new Set<CallFileKind>(['protocol', 'transcript', 'utterances'])

/** Env vars stripped before spawning headless claude on the node. */
const STRIP_ENV = [
  'HERDR_PANE_ID',
  'HERDR_TAB_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SIMPLE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const

export interface PilotMcpSpec {
  name: string
  tools: string[]
}

export interface PilotCallCheckRequest {
  session: string
  cwd: string
  profile: string
  profileFolder: string
}

export interface PilotCallStartRequest {
  session: string
  cwd: string
  profile: string
  profileFolder: string
  model: string
  effort: string
  fullAccess: boolean
  fork: boolean
  mcp: PilotMcpSpec | null
}

export interface PilotMcpReply {
  id: string
  status: number
  contentType: string
  body: string
}

export interface PilotCallFileInput {
  kind: CallFileKind
  name: string
  bytes: Buffer
}

export interface PilotCallReportRequest {
  session: string
  report: string
  reportId: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasControl = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function cleanPath(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!s || s.length > 4096 || hasControl(s)) return ''
  return s
}

function cleanWord(v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return s && pattern.test(s) ? s : ''
}

export function isPilotCallId(v: unknown): v is string {
  return typeof v === 'string' && PILOT_CALL_ID.test(v)
}

export function isSafeCallFileName(name: string): boolean {
  if (!name || name.length > 200 || hasControl(name)) return false
  if (name === '.' || name === '..' || name.startsWith('.') || /[/\\:]/.test(name)) return false
  return true
}

export function parseCheckRequest(raw: unknown): PilotCallCheckRequest | { error: string } {
  if (!isRecord(raw)) return { error: 'invalid request body' }
  const session = typeof raw.session === 'string' ? raw.session.trim() : ''
  if (!UUID.test(session)) return { error: 'session must be a UUID' }
  return {
    session,
    cwd: cleanPath(raw.cwd),
    profile: typeof raw.profile === 'string' && !hasControl(raw.profile) ? raw.profile.trim().slice(0, 128) : '',
    profileFolder: cleanPath(raw.profileFolder),
  }
}

export function parseStartRequest(raw: unknown): PilotCallStartRequest | { error: string } {
  if (!isRecord(raw)) return { error: 'invalid request body' }
  const session = typeof raw.session === 'string' ? raw.session.trim() : ''
  if (!UUID.test(session)) return { error: 'session must be a UUID' }
  const model = raw.model === undefined || raw.model === '' ? '' : cleanWord(raw.model, SAFE_MODEL)
  if (raw.model !== undefined && raw.model !== '' && !model) return { error: 'invalid model name' }
  const effort = raw.effort === undefined || raw.effort === '' ? '' : cleanWord(raw.effort, SAFE_EFFORT)
  if (raw.effort !== undefined && raw.effort !== '' && !effort) return { error: 'invalid effort value' }

  let mcp: PilotMcpSpec | null = null
  if (raw.mcp !== undefined && raw.mcp !== null) {
    if (!isRecord(raw.mcp)) return { error: 'invalid mcp spec' }
    const name = cleanWord(raw.mcp.name, SAFE_MCP_NAME)
    if (!name) return { error: 'invalid mcp server name' }
    const rawTools = raw.mcp.tools
    if (!Array.isArray(rawTools) || rawTools.length > MAX_MCP_TOOLS) return { error: 'invalid mcp tools list' }
    const tools: string[] = []
    for (const item of rawTools) {
      const tool = cleanWord(item, SAFE_TOOL)
      if (!tool) return { error: 'invalid mcp tool name' }
      tools.push(tool)
    }
    mcp = { name, tools }
  }

  return {
    session,
    cwd: cleanPath(raw.cwd),
    profile: typeof raw.profile === 'string' && !hasControl(raw.profile) ? raw.profile.trim().slice(0, 128) : '',
    profileFolder: cleanPath(raw.profileFolder),
    model,
    effort,
    fullAccess: raw.fullAccess === true,
    fork: raw.fork !== false,
    mcp,
  }
}

export function parseStdinRequest(raw: unknown): { line: string } | { error: string } {
  if (!isRecord(raw) || typeof raw.line !== 'string') return { error: 'line must be a string' }
  if (!raw.line || raw.line.includes('\n') || raw.line.includes('\r')) return { error: 'line must be a single line' }
  if (Buffer.byteLength(raw.line, 'utf8') > MAX_STDIN_LINE_BYTES) return { error: 'line too large' }
  return { line: raw.line }
}

export function parseMcpReply(raw: unknown): PilotMcpReply | { error: string } {
  if (!isRecord(raw)) return { error: 'invalid mcp reply' }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!isPilotCallId(id)) return { error: 'invalid mcp request id' }
  const status = raw.status
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599)
    return { error: 'invalid mcp status' }
  const contentType =
    typeof raw.contentType === 'string' && raw.contentType.trim() && !hasControl(raw.contentType)
      ? raw.contentType.trim().slice(0, 128)
      : 'application/json'
  const body = typeof raw.body === 'string' ? raw.body : ''
  if (Buffer.byteLength(body, 'utf8') > MAX_MCP_BODY_BYTES) return { error: 'mcp reply body too large' }
  return { id, status: status as number, contentType, body }
}

export function parseCallFilesRequest(raw: unknown): { files: PilotCallFileInput[] } | { error: string } {
  if (!isRecord(raw) || !Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 3)
    return { error: 'files must contain 1 to 3 entries' }
  const seen = new Set<string>()
  const files: PilotCallFileInput[] = []
  for (const item of raw.files) {
    if (!isRecord(item)) return { error: 'invalid file entry' }
    const kind = typeof item.kind === 'string' ? item.kind : ''
    if (!FILE_KINDS.has(kind) || seen.has(kind)) return { error: 'invalid or duplicate file kind' }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!isSafeCallFileName(name)) return { error: `invalid file name: ${name}` }
    if (typeof item.contentBase64 !== 'string') return { error: 'missing contentBase64' }
    const bytes = Buffer.from(item.contentBase64, 'base64')
    if (bytes.byteLength > MAX_CALL_FILE_BYTES) return { error: `file too large: ${name}` }
    seen.add(kind)
    files.push({ kind: kind as CallFileKind, name, bytes })
  }
  return { files }
}

export function parseReportRequest(raw: unknown): PilotCallReportRequest | { error: string } {
  if (!isRecord(raw)) return { error: 'invalid report request' }
  const session = typeof raw.session === 'string' ? raw.session.trim() : ''
  if (!UUID.test(session)) return { error: 'session must be a UUID' }
  const report =
    typeof raw.report === 'string'
      ? raw.report
          .replace(/^\uFEFF/, '')
          .replace(/\r\n?/g, '\n')
          .trim()
      : ''
  if (!report) return { error: 'report is empty' }
  let reportId: string | null = null
  if (raw.reportId !== undefined && raw.reportId !== null && raw.reportId !== '') {
    if (typeof raw.reportId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.reportId))
      return { error: 'invalid reportId' }
    reportId = raw.reportId
  }
  return { session, report, reportId }
}

/** Command-line arguments for headless Claude Code running as a MokuPilot call agent. */
export function claudePilotArgs(o: {
  session: string
  fork: boolean
  model?: string
  effort?: string
  fullAccess: boolean
  mcpConfigPath?: string
  mcpName?: string
  mcpTools?: readonly string[]
}): string[] {
  const args = [
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
  ]
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.fullAccess) args.push('--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions')
  else args.push('--permission-mode', 'acceptEdits')
  args.push('--resume', o.session)
  if (o.fork) args.push('--fork-session')
  args.push('--settings', NO_HOOKS_SETTINGS)
  if (o.mcpConfigPath) {
    args.push('--mcp-config', o.mcpConfigPath)
    if (o.mcpName && o.mcpTools?.length) {
      args.push('--allowedTools', o.mcpTools.map(tool => `mcp__${o.mcpName}__${tool}`).join(','))
    }
  }
  return args
}

/** Sanitized environment for headless Claude Code on a node, with its profile's CLAUDE_CONFIG_DIR. */
export function claudePilotEnv(
  base: Record<string, string | undefined>,
  profileDir: string | null | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const key of STRIP_ENV) delete env[key]
  if (profileDir === null) delete env.CLAUDE_CONFIG_DIR
  else if (typeof profileDir === 'string' && profileDir) env.CLAUDE_CONFIG_DIR = profileDir
  return env
}
