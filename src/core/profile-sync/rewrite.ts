// The profile sync's changes to what a file holds (the board-on-own-server spec's "Next step:
// syncing the Claude profiles"): on the source, the paths in it moved to the target's (`cwd` in a
// transcript, `project` in history.jsonl); on the target, the shared part of a file merged by key
// into its own (settings.json, .claude.json), or history.jsonl's lines joined with its own. The
// target's own secrets, state and hooks stay as they are. Pure.
import { BROWSER_MCP } from '../desktop.ts'
import { type Move, moved, type Platform } from './paths.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/g

/** A transcript's `cwd`s inside a paired project as the target writes them; how many were moved. */
export function rewriteCwd(
  text: string,
  moves: readonly Move[],
  from: Platform,
  to: Platform,
): { text: string; n: number } {
  if (!text.includes('"cwd":"') || moves.length === 0) return { text, n: 0 }
  let n = 0
  const out = text.replace(CWD, (whole, raw: string) => {
    let path: string
    try {
      path = JSON.parse(`"${raw}"`)
    } catch {
      return whole
    }
    const there = moved(path, moves, from, to)
    if (there === null) return whole
    n++
    return `"cwd":${JSON.stringify(there)}`
  })
  return { text: out, n }
}

/** history.jsonl as the target names its projects: a line of a paired project moved, a line of another left out. */
export function rewriteHistory(
  text: string,
  moves: readonly Move[],
  from: Platform,
  to: Platform,
): { text: string; n: number; dropped: number } {
  let n = 0
  let dropped = 0
  const lines: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      dropped++
      continue
    }
    const project = isRecord(entry) && typeof entry.project === 'string' ? entry.project : null
    const there = project === null ? null : moved(project, moves, from, to)
    if (there === null || !isRecord(entry)) {
      dropped++
      continue
    }
    n++
    lines.push(JSON.stringify({ ...entry, project: there }))
  }
  return { text: lines.length ? `${lines.join('\n')}\n` : '', n, dropped }
}

/** history.jsonl's lines and the shared ones, each once, in time order (a line with no time last, as it came). */
export function mergeHistory(own: string, shared: string): string {
  const seen = new Set<string>()
  const lines: { line: string; at: number; i: number }[] = []
  for (const line of `${own}\n${shared}`.split('\n')) {
    const l = line.replace(/\r$/, '')
    if (l.trim() === '' || seen.has(l)) continue
    seen.add(l)
    let at = Number.POSITIVE_INFINITY
    try {
      const e = JSON.parse(l)
      if (isRecord(e) && typeof e.timestamp === 'number') at = e.timestamp
    } catch {}
    lines.push({ line: l, at, i: lines.length })
  }
  lines.sort((a, b) => a.at - b.at || a.i - b.i)
  return lines.length ? `${lines.map(x => x.line).join('\n')}\n` : ''
}

/** A hook entry's commands, for telling one already there. */
export const hookKey = (event: string, entry: unknown, h: unknown): string =>
  JSON.stringify([event, isRecord(entry) ? (entry.matcher ?? null) : null, isRecord(h) ? (h.command ?? null) : null])

/**
 * settings.json merged: the shared keys over the target's own; its `env` names kept where the
 * shared one has none (its keys and tokens among them); its secret helpers, its board's hooks and
 * status line kept; each shared hook added where the target has no hook with that command.
 */
export function mergeSettings(own: unknown, shared: Record<string, unknown>): Record<string, unknown> {
  const mine = isRecord(own) ? own : {}
  const out: Record<string, unknown> = { ...mine }
  for (const [key, v] of Object.entries(shared)) {
    if (key === 'env' && isRecord(v)) out.env = { ...(isRecord(mine.env) ? mine.env : {}), ...v }
    else if (key === 'statusLine') {
      const theirs = isRecord(mine.statusLine) && typeof mine.statusLine.command === 'string'
      if (!theirs || !/agent-board/i.test(String((mine.statusLine as Record<string, unknown>).command)))
        out.statusLine = v
    } else if (key === 'hooks' && isRecord(v)) {
      const hooks: Record<string, unknown> = isRecord(mine.hooks) ? { ...mine.hooks } : {}
      const there = new Set<string>()
      for (const [event, list] of Object.entries(hooks))
        if (Array.isArray(list))
          for (const entry of list)
            if (isRecord(entry) && Array.isArray(entry.hooks))
              for (const h of entry.hooks) there.add(hookKey(event, entry, h))
      for (const [event, list] of Object.entries(v)) {
        if (!Array.isArray(list)) continue
        const added: unknown[] = []
        for (const entry of list) {
          if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue
          const fresh = entry.hooks.filter(h => !there.has(hookKey(event, entry, h)))
          if (fresh.length) added.push({ ...entry, hooks: fresh })
        }
        if (added.length) hooks[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []), ...added]
      }
      out.hooks = hooks
    } else out[key] = v
  }
  return out
}

/** MCP servers merged: the shared ones over the target's, each keeping the target's own headers and env. */
function mergeMcps(own: unknown, shared: unknown): Record<string, unknown> {
  const mine = isRecord(own) ? own : {}
  const out: Record<string, unknown> = { ...mine }
  if (!isRecord(shared)) return out
  for (const [name, server] of Object.entries(shared)) {
    // the board's own browser MCP server: the target's install's, whatever comes
    if (!isRecord(server) || name === BROWSER_MCP) continue
    const theirs = isRecord(mine[name]) ? (mine[name] as Record<string, unknown>) : {}
    out[name] = {
      ...server,
      ...(theirs.headers !== undefined && { headers: theirs.headers }),
      ...(theirs.env !== undefined && { env: theirs.env }),
    }
  }
  return out
}

/**
 * .claude.json merged: the shared keys over the target's own (its OAuth part, ids and state are
 * not among them, so they stay); MCP servers by name; each project's entry merged by key, its MCP
 * servers by name too; the target's projects the source has not kept.
 */
export function mergeClaudeJson(own: unknown, shared: Record<string, unknown>): Record<string, unknown> {
  const mine = isRecord(own) ? own : {}
  const out: Record<string, unknown> = { ...mine }
  for (const [key, v] of Object.entries(shared)) {
    if (key === 'mcpServers') out.mcpServers = mergeMcps(mine.mcpServers, v)
    else if (key === 'projects' && isRecord(v)) {
      const projects: Record<string, unknown> = isRecord(mine.projects) ? { ...mine.projects } : {}
      for (const [path, entry] of Object.entries(v)) {
        if (!isRecord(entry)) continue
        const theirs = isRecord(projects[path]) ? (projects[path] as Record<string, unknown>) : {}
        projects[path] = {
          ...theirs,
          ...entry,
          ...((entry.mcpServers !== undefined || theirs.mcpServers !== undefined) && {
            mcpServers: mergeMcps(theirs.mcpServers, entry.mcpServers),
          }),
        }
      }
      out.projects = projects
    } else out[key] = v
  }
  return out
}
