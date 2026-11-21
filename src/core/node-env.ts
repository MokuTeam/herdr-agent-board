// The variables a node's sessions get from their profile's env file (#507, docs/design/nodes 10 item
// 4): `<state>/node/env/<profile>.env`, as a file sink in `env` format writes it
// (adapters/secret-sinks.ts envContent, envValue). Pure: the file's text in, the variables and the
// names the board keeps for itself out. Read only on a board with `node` (adapters/node-env.ts).

/** Variables by name. */
export type EnvMap = Readonly<Record<string, string>>

/** A line that sets a variable, as the env sink writes and keeps them. */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([^\r\n]*)$/

/**
 * A name the board sets itself for a session (its profile's folder, herdr's own, where programs and
 * the home are): an env file does not override it. Upper-cased, as Windows' names are any case.
 */
export function boardOwnsName(name: string): boolean {
  const n = name.toUpperCase()
  return n === 'CLAUDE_CONFIG_DIR' || n === 'PATH' || n === 'HOME' || n.startsWith('HERDR_')
}

/**
 * The variables an env file sets, each value as the sink wrote it: as it is, or in the single or
 * double quotes that kept it literal. Comments, blank lines and anything else are left out; of a
 * name set twice, the last. A name the board owns (boardOwnsName) is not set, and is in `refused`.
 */
export function parseEnvFile(text: string): { vars: Record<string, string>; refused: string[] } {
  const vars = new Map<string, string>()
  const refused: string[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = ENV_LINE.exec(line)
    if (!m) continue
    const name = m[1] ?? ''
    if (boardOwnsName(name)) {
      if (!refused.includes(name)) refused.push(name)
      continue
    }
    const raw = (m[2] ?? '').trim()
    const quoted = /^'(.*)'$/.exec(raw) ?? /^"(.*)"$/.exec(raw)
    vars.set(name, quoted ? (quoted[1] ?? '') : raw)
  }
  // Object.fromEntries makes every name an own key, `__proto__` too.
  return { vars: Object.fromEntries(vars), refused }
}
