// Antigravity CLI hooks live in `~/.gemini/config/hooks.json`, MCP in `~/.gemini/config/mcp_config.json`,
// and statusLine in `~/.gemini/antigravity-cli/settings.json`.
// Each top-level hook key is a named hook group (e.g. `"herdr"`, `"agent-board"`), and
// `SessionStart` / `PreInvocation` are flat arrays of command handler objects.
import { normPath, quote } from './install-plan.ts'
import { stdioMcpEntry } from './mcp-register.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export const AGY_HOOK_KEY = 'agent-board'
export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation'] as const
export const AGY_MCP_KEY = 'agent-board'

// An argv marker survives a moved checkout without adding non-schema fields to hooks.json.
const MARKER = '--herdr-agent-board-hook'
const installedCommand =
  /^bun(?:\.exe)?[ \t]+(?:"([^"\r\n]+)"|([^\s"'`$();&|<>]+))(?:[ \t]+(--herdr-agent-board-hook))?[ \t]*$/i

function ourCommand(command: string, script: string): boolean {
  const match = installedCommand.exec(command)
  if (!match) return false
  const path = normPath(match[1] ?? match[2])
  if (!path.endsWith('/entrypoints/agy-hook.ts')) return false
  return !!match[3] || path === normPath(script) || /agent-board.*\/entrypoints\/agy-hook\.ts$/.test(path)
}

function isOurHandler(entry: unknown, ours: (cmd: string) => boolean): boolean {
  if (!isRecord(entry)) return false
  if (entry.type !== undefined && entry.type !== 'command') return false
  return typeof entry.command === 'string' && ours(entry.command)
}

/**
 * Plan the next `~/.gemini/config/hooks.json` with agent-board's `SessionStart` and
 * `PreInvocation` hooks under the `"agent-board"` key, preserving `"herdr"` and every
 * other user or plugin hook untouched.
 */
export function planAgyHooks(settings: unknown, script: string): Record<string, unknown> {
  if (settings !== undefined && !isRecord(settings)) throw new Error('hooks.json is not a JSON object; left as it was')
  const next: Record<string, unknown> = structuredClone(settings ?? {})
  if (next[AGY_HOOK_KEY] !== undefined && !isRecord(next[AGY_HOOK_KEY]))
    throw new Error(`hooks.json ${AGY_HOOK_KEY} is not an object; left as it was`)
  const group: Record<string, unknown> = isRecord(next[AGY_HOOK_KEY]) ? next[AGY_HOOK_KEY] : {}
  next[AGY_HOOK_KEY] = group

  const ours = (command: string): boolean => ourCommand(command, script)
  // Antigravity CLI runs hook commands via `sh -c` on Unix and `cmd /c` on Windows; unquoted `bun`
  // avoids cmd.exe outer-quote stripping and works in cmd, PowerShell, Git Bash, and POSIX sh.
  const command = `bun ${quote(script)} ${MARKER}`
  const handler = { type: 'command', command, timeout: 10 }

  for (const event of AGY_HOOK_EVENTS) {
    if (group[event] !== undefined && !Array.isArray(group[event]))
      throw new Error(`hooks.json ${AGY_HOOK_KEY}.${event} is not a list; left as it was`)
    const entries: unknown[] = Array.isArray(group[event]) ? group[event] : []
    const owned = entries.filter(e => isOurHandler(e, ours))
    if (owned.length === 1 && isRecord(owned[0]) && owned[0].command === command) continue
    const kept = entries.filter(e => !isOurHandler(e, ours))
    group[event] = [...kept, handler]
  }
  return next
}

/**
 * Plan the next `~/.gemini/config/mcp_config.json` with agent-board's stdio MCP server, preserving
 * every other MCP server and top-level key untouched: `board mcp --http` (#814), the thin client of
 * the board's /mcp with every board tool as this pane's session (agy sends no header of a session's
 * own over HTTP); it replaces `board mcp --agents` (#628), whose two tools the board's `agents` has.
 */
export function planAgyMcp(config: unknown, bun: string, cli: string): Record<string, unknown> {
  if (config !== undefined && !isRecord(config)) throw new Error('mcp_config.json is not a JSON object; left as it was')
  const next: Record<string, unknown> = structuredClone(config ?? {})
  if (next.mcpServers !== undefined && !isRecord(next.mcpServers))
    throw new Error('mcp_config.json mcpServers is not an object; left as it was')
  const servers: Record<string, unknown> = isRecord(next.mcpServers) ? next.mcpServers : {}
  next.mcpServers = servers
  servers[AGY_MCP_KEY] = stdioMcpEntry(bun, cli)
  return next
}

const OUR_AGY_STATUS_LINE = /agent-board.*[\\/]entrypoints[\\/]agy-statusline\.ts/

function isOurAgyStatusLine(cmd: string, script: string): boolean {
  const n = normPath(cmd)
  return (!!script && n.includes(normPath(script))) || OUR_AGY_STATUS_LINE.test(cmd)
}

/**
 * Plan the next `~/.gemini/antigravity-cli/settings.json` with agent-board's statusLine command
 * (`stack_with_default: true` so agy's built-in status bar stays intact, #647). If the user already
 * configured a non-board statusLine (including a non-command object), leave it untouched (`statusLineSet: false`).
 */
export function planAgySettings(
  settings: unknown,
  bun: string,
  statusline: string,
): { settings: Record<string, unknown>; statusLineSet: boolean } {
  if (settings !== undefined && !isRecord(settings))
    throw new Error('settings.json is not a JSON object; left as it was')
  const next: Record<string, unknown> = structuredClone(settings ?? {})
  const cur = next.statusLine
  const curCmd = isRecord(cur) && typeof cur.command === 'string' ? cur.command : ''
  const ours = !cur || (!!curCmd && isOurAgyStatusLine(curCmd, statusline))
  if (!ours) return { settings: next, statusLineSet: false }
  next.statusLine = {
    type: 'command',
    command: `${quote(bun)} ${quote(statusline)}`,
    stack_with_default: true,
  }
  return { settings: next, statusLineSet: true }
}
