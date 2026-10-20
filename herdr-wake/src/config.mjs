// The router's settings: config.json in the plugin config dir over the defaults. The tg-mcp url
// and token default to the `telegram` MCP server in ~/.claude.json; without them the router runs
// without Telegram (sleep, wake and the local API only).

/**
 * @param file what config.json holds ({} when there is none)
 * @param claudeJson what ~/.claude.json holds ({} when there is none)
 */
export function resolveConfig(file, claudeJson) {
  const c = {
    server: 'telegram',
    port: 12421, // local API; also keeps the router single-instance
    wakeCommand: 'claude --resume {session}', // e.g. the claude-tg launcher: "claude-tg --resume {session}"
    wakeTimeoutSec: 120,
    pollTimeoutSec: 25,
    ...file,
    reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3, ...file.reaper },
  }
  if (!c.url || !c.authorization) {
    const mcp = claudeJson.mcpServers?.[c.server]
    c.url ??= mcp?.url?.replace(/\/mcp\/?$/, '')
    c.authorization ??= mcp?.headers?.Authorization
  }
  c.telegram = !!(c.url && c.authorization)
  return c
}
