// What a merge of settings.json or .claude.json would add or change on the target, key by key, for
// the preview (the board-on-own-server spec's "Next step: syncing the Claude profiles"): the
// source's shared part as it goes (carried, its projects named as the target names them) against
// the target's, both without their secrets, each key in the group that says how it changes the way
// the target runs (env, hooks, the status line, MCP servers, other programs), or in none. Pure.
import { hookKey } from './rewrite.ts'
import { claudeJsonGroup, type RunGroup, settingsGroup, shortly } from './secrets.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A key a merge adds or changes on the target. */
export interface KeyChange {
  group: RunGroup | null
  key: string
  how: 'add' | 'change'
}

/** A value as text with its objects' keys in order: two that hold the same are the same text. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'undefined'
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b)

/** An MCP server as the merge compares it: the target keeps its own headers and env. */
const server = (v: unknown): unknown => {
  if (!isRecord(v)) return v
  const { headers: _h, env: _e, ...rest } = v
  return rest
}

function mcpChanges(src: unknown, tgt: unknown, where: string, out: KeyChange[]): void {
  if (!isRecord(src)) return
  const there = isRecord(tgt) ? tgt : {}
  for (const [name, s] of Object.entries(src))
    if (!same(server(s), server(there[name])))
      out.push({ group: 'mcp', key: `MCP ${name}${where}`, how: name in there ? 'change' : 'add' })
}

/**
 * settings.json: each env name, each hook added (the target has none with its command), the
 * status line (none when the target's is the board's: it stays), each other key.
 */
export function settingsChanges(
  src: Record<string, unknown>,
  tgt: Record<string, unknown>,
  boardStatusLine: boolean,
): KeyChange[] {
  const out: KeyChange[] = []
  for (const [key, v] of Object.entries(src)) {
    const t = tgt[key]
    if (key === 'env' && isRecord(v)) {
      const env = isRecord(t) ? t : {}
      for (const [name, val] of Object.entries(v))
        if (!same(val, env[name])) out.push({ group: 'env', key: `env ${name}`, how: name in env ? 'change' : 'add' })
    } else if (key === 'hooks' && isRecord(v)) {
      const there = new Set<string>()
      if (isRecord(t))
        for (const [event, list] of Object.entries(t))
          if (Array.isArray(list))
            for (const entry of list)
              if (isRecord(entry) && Array.isArray(entry.hooks))
                for (const h of entry.hooks) there.add(hookKey(event, entry, h))
      for (const [event, list] of Object.entries(v)) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue
          for (const h of entry.hooks) {
            if (there.has(hookKey(event, entry, h))) continue
            const command = isRecord(h) && typeof h.command === 'string' ? h.command : JSON.stringify(h)
            out.push({ group: 'hooks', key: `hook ${event}: ${shortly(command)}`, how: 'add' })
          }
        }
      }
    } else if (key === 'statusLine') {
      if (boardStatusLine || same(v, t)) continue
      const command = isRecord(v) && typeof v.command === 'string' ? `: ${shortly(v.command)}` : ''
      out.push({ group: 'statusLine', key: `statusLine${command}`, how: t === undefined ? 'add' : 'change' })
    } else if (!same(v, t)) out.push({ group: settingsGroup(key, v), key, how: t === undefined ? 'add' : 'change' })
  }
  return out
}

/** .claude.json: each MCP server (its headers and env the target's), each project's keys, each other key. */
export function claudeJsonChanges(src: Record<string, unknown>, tgt: Record<string, unknown>): KeyChange[] {
  const out: KeyChange[] = []
  for (const [key, v] of Object.entries(src)) {
    const t = tgt[key]
    if (key === 'mcpServers') mcpChanges(v, t, '', out)
    else if (key === 'projects' && isRecord(v)) {
      const projects = isRecord(t) ? t : {}
      for (const [path, entry] of Object.entries(v)) {
        if (!isRecord(entry)) continue
        const theirs = isRecord(projects[path]) ? (projects[path] as Record<string, unknown>) : {}
        for (const [k, x] of Object.entries(entry)) {
          if (k === 'mcpServers') mcpChanges(x, theirs.mcpServers, ` (${path})`, out)
          else if (!same(x, theirs[k]))
            out.push({ group: claudeJsonGroup(k), key: `projects ${path}: ${k}`, how: k in theirs ? 'change' : 'add' })
        }
      }
    } else if (!same(v, t)) out.push({ group: claudeJsonGroup(key), key, how: t === undefined ? 'add' : 'change' })
  }
  return out
}
