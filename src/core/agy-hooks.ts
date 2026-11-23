// Antigravity CLI hooks live in `~/.gemini/config/hooks.json`.
// Each top-level key is a named hook group (e.g. `"herdr"`, `"agent-board"`), and
// `SessionStart` / `PreInvocation` are flat arrays of command handler objects.
import { normPath, quote } from './install-plan.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export const AGY_HOOK_KEY = 'agent-board'
export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation'] as const
export const AGY_MCP_KEY = 'agent-board'

// An argv marker survives a moved checkout without adding non-schema fields to hooks.json.
const MARKER = '--herdr-agent-board-hook'
const installedCommand = /^bun[ \t]+(?:"([^"\r\n]+)"|([^\s"'`$();&|<>]+))(?:[ \t]+(--herdr-agent-board-hook))?[ \t]*$/

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
 * Plan the next `~/.gemini/config/mcp_config.json` with agent-board's stdio MCP server
 * (`ListAgents` and `SendMessage` via `board mcp --agents`, #628), preserving every other
 * MCP server and top-level key untouched.
 */
export function planAgyMcp(config: unknown, bun: string, cli: string): Record<string, unknown> {
  if (config !== undefined && !isRecord(config)) throw new Error('mcp_config.json is not a JSON object; left as it was')
  const next: Record<string, unknown> = structuredClone(config ?? {})
  if (next.mcpServers !== undefined && !isRecord(next.mcpServers))
    throw new Error('mcp_config.json mcpServers is not an object; left as it was')
  const servers: Record<string, unknown> = isRecord(next.mcpServers) ? next.mcpServers : {}
  next.mcpServers = servers
  servers[AGY_MCP_KEY] = {
    command: bun,
    args: [cli, 'mcp', '--agents'],
  }
  return next
}
