// The board's MCP server in every agent harness on this computer (#814, epic #812): one entry named
// `agent-board` that points at this board's own `/mcp` (#813), so that every session has the board's
// tools with nothing set by hand. Each call carries who calls (the herdr pane), so one entry serves
// every session of a profile:
//   - Claude Code: an HTTP server in the profile's user scope (.claude.json `mcpServers`), its
//     X-Board-Pane header `${HERDR_PANE_ID:-}`, which Claude Code expands from its own environment
//     (empty outside herdr: the board takes that as no pane).
//   - Codex: `[mcp_servers.agent-board]` in config.toml, the header from HERDR_PANE_ID through
//     `env_http_headers`.
//   - Antigravity CLI (agy) and pi: neither expands the environment in a header, so a stdio server,
//     `board mcp --http`, the thin client that sends the pane from its own environment.
// Pure: the reading, backing up and writing are adapters/mcp-register.ts's. Only the entry of that
// name is ever written or removed; every other server and every other key stays as it was.

/** The name of the board's server in every harness. */
export const BOARD_MCP = 'agent-board'
/** The header with the caller's herdr pane (#813). */
export const PANE_HEADER = 'X-Board-Pane'
/** The header with a session key, for a caller that names one (`board --session <key> mcp --http`). */
export const SESSION_HEADER = 'X-Board-Session'

type Rec = Record<string, unknown>
const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

/** The board's MCP endpoint on this computer: its own port (config.json `port`, 12422 when not set). */
export const boardMcpUrl = (port: unknown): string => `http://127.0.0.1:${Number(port) || 12422}/mcp`

/** Whether config.json turned the registration off (`install.ts --no-mcp`): `"boardMcp": false`. */
export const boardMcpOff = (raw: unknown): boolean => isRecord(raw) && raw.boardMcp === false

/** Claude Code's entry: HTTP, the pane from the session's environment, empty outside herdr. */
export function claudeMcpEntry(url: string): Rec {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it, not this code
  return { type: 'http', url, headers: { [PANE_HEADER]: '${HERDR_PANE_ID:-}' } }
}

/** The stdio entry (agy, pi): `board mcp --http` run by the Bun that runs the board. */
export function stdioMcpEntry(bun: string, cli: string): Rec {
  return { command: bun, args: [cli, 'mcp', '--http'] }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * A JSON config (an object, or undefined when there is none) with the board's server in its
 * `mcpServers` set to `entry`, or removed with `entry` null; null when nothing changes. A config
 * that is not an object, or whose `mcpServers` is not one, throws: it is left as it was. An empty
 * `mcpServers` left by the removal is kept (Claude Code writes one itself). The input is not changed.
 */
export function planMcpServers(config: unknown, entry: Rec | null, name = 'the config'): Rec | null {
  if (config !== undefined && !isRecord(config)) throw new Error(`${name} is not a JSON object; left as it was`)
  if (config?.mcpServers !== undefined && !isRecord(config.mcpServers))
    throw new Error(`${name}: mcpServers is not an object; left as it was`)
  const servers = isRecord(config?.mcpServers) ? config.mcpServers : undefined
  if (entry === null) {
    if (!servers || !Object.hasOwn(servers, BOARD_MCP)) return null
    const next = structuredClone(config ?? {})
    delete (next.mcpServers as Rec)[BOARD_MCP]
    return next
  }
  if (servers && same(servers[BOARD_MCP], entry)) return null
  const next: Rec = structuredClone(config ?? {})
  next.mcpServers = { ...(isRecord(next.mcpServers) ? next.mcpServers : {}), [BOARD_MCP]: entry }
  return next
}

/** A TOML basic string. */
const tomlString = (s: string): string =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: TOML escapes control characters
    .replace(/[\u0000-\u001f\u007f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`

/** Codex's table for the board's server: the endpoint, the pane header from HERDR_PANE_ID. */
export function codexMcpBlock(url: string): string[] {
  return [
    `[mcp_servers.${BOARD_MCP}]`,
    `url = ${tomlString(url)}`,
    `env_http_headers = { ${tomlString(PANE_HEADER)} = "HERDR_PANE_ID" }`,
  ]
}

/** The parts of a TOML key (`a . "b"`, `'c'`), unquoted; null for one this reading does not take. */
function keyParts(key: string): string[] | null {
  const parts: string[] = []
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y
  let at = 0
  while (at < key.length) {
    re.lastIndex = at
    const m = re.exec(key)
    if (!m) return null
    parts.push(m[1] ?? m[2] ?? m[3] ?? '')
    at = re.lastIndex
    if (m[4] === '') break
  }
  return parts
}

const HEADER = /^\s*\[(?!\[)\s*([^\]]*?)\s*\]\s*(?:#.*)?$/
const ARRAY_HEADER = /^\s*\[\[/
const KEY_LINE =
  /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=/

/**
 * Codex's config.toml text (null when there is none) with the board's table (codexMcpBlock) in
 * place of an earlier one, or without it when `url` is null; null when nothing changes. Only the
 * board's tables (`[mcp_servers.agent-board]` and any `[mcp_servers.agent-board.<sub>]`) are
 * rewritten, where the first of them stood, or added at the end; the comments and blank lines that
 * end one stay for the table after it. The board's server defined some other way (a dotted key, an
 * inline table) throws: the file is left as it was. Line ends as the file has them.
 */
export function planCodexToml(text: string | null, url: string | null): string | null {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === null || text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  const kept: string[] = []
  let table: string[] = []
  let ours = false
  let at = -1
  let block: string[] = []
  let multiline: string | null = null
  const ourName = (parts: string[] | null): boolean => !!parts && parts[0] === 'mcp_servers' && parts[1] === BOARD_MCP
  const refuse = (): never => {
    throw new Error(`config.toml defines mcp_servers.${BOARD_MCP} another way; left as it was`)
  }
  const flush = (): void => {
    // The board's table ends at its last line that holds something: what follows is the next one's.
    let end = block.length
    while (end > 0 && /^\s*(#.*)?$/.test(block[end - 1] ?? '')) end--
    kept.push(...block.slice(end))
    block = []
  }
  for (const line of lines) {
    if (multiline) {
      ;(ours ? block : kept).push(line)
      if ((line.split(multiline).length - 1) % 2 === 1) multiline = null
      continue
    }
    const header = ARRAY_HEADER.test(line) ? null : HEADER.exec(line)
    if (header || ARRAY_HEADER.test(line)) {
      if (ours) flush()
      const parts = header ? keyParts(header[1] ?? '') : null
      table = parts ?? []
      ours = !!header && ourName(parts)
      if (ours) {
        if (at < 0) at = kept.length
        block.push(line)
        continue
      }
      if (!header && ourName(keyParts(line.replace(/^\s*\[\[\s*|\s*\]\].*$/g, '')))) refuse()
      kept.push(line)
      continue
    }
    ;(ours ? block : kept).push(line)
    for (const q of ['"""', "'''"]) if ((line.split(q).length - 1) % 2 === 1) multiline = q
    if (ours) continue
    const key = KEY_LINE.exec(line)
    if (key && ourName([...table, ...(keyParts(key[1] ?? '') ?? [])])) refuse()
    if (key && table.length === 0 && keyParts(key[1] ?? '')?.[0] === 'mcp_servers' && line.includes(BOARD_MCP)) refuse()
  }
  if (ours) flush()
  if (url === null && at < 0) return null
  let out: string[]
  if (url === null) {
    out = kept
    while (out.length && !out[out.length - 1]?.trim()) out.pop()
  } else if (at >= 0) out = [...kept.slice(0, at), ...codexMcpBlock(url), ...kept.slice(at)]
  else {
    out = [...kept]
    while (out.length && !out[out.length - 1]?.trim()) out.pop()
    out.push(...(out.length ? [''] : []), ...codexMcpBlock(url))
  }
  const next = out.length ? `${out.join(eol)}${eol}` : ''
  return next === (text ?? '') ? null : next
}
