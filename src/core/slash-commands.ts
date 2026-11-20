// The slash commands the card's chat box offers (#191): what each agent kind knows of its own, and
// what a command or skill file says of itself. adapters/slash-commands.ts reads the files; the page
// filters and orders them (web/src/models/slash.ts). Only names and descriptions, never a body.

/** One command as the box lists it: its name without the slash. */
export interface SlashCommand {
  name: string
  /** A line on what it does ('' when its file says nothing). */
  description: string
  /** What it takes after it, as Claude Code's menu shows it ("[instructions]"); absent when nothing. */
  hint?: string
  /** Where it comes from: the agent itself, the profile's (or pi's own) folder, the session's folder. */
  source: 'builtin' | 'user' | 'project'
}

const b = (name: string, description: string, hint?: string): SlashCommand => ({
  name,
  description,
  source: 'builtin',
  ...(hint && { hint }),
})

/**
 * Claude Code's own commands a message from the board can run. Left out: the ones that end the
 * session or its login (/exit, /logout, /login), which the board does otherwise.
 */
export const CLAUDE_BUILTINS: readonly SlashCommand[] = [
  b('add-dir', 'Add a working folder for this session', '<path>'),
  b('agents', 'Manage agent configurations'),
  b('btw', 'Ask a side question without adding it to the conversation', '<question>'),
  b('clear', 'Clear the conversation and start afresh'),
  b('compact', 'Compact the conversation, optionally with instructions for the summary', '[instructions]'),
  b('config', 'Open the settings'),
  b('context', 'Show what takes up the context window'),
  b('cost', 'Show the cost and duration of this session'),
  b('doctor', 'Check the Claude Code installation'),
  b('effort', 'Set the reasoning effort', '[low|medium|high|xhigh|max]'),
  b('export', 'Export the conversation to a file or the clipboard', '[filename]'),
  b('fast', 'Turn fast mode on or off'),
  b('help', 'Show help and the available commands'),
  b('hooks', 'Manage hooks for tool events'),
  b('init', 'Write a CLAUDE.md with notes on this codebase'),
  b('mcp', 'Manage MCP servers'),
  b('memory', 'Edit the memory files'),
  b('model', 'Set the model for this session', '[model]'),
  b('permissions', 'Manage tool permission rules'),
  b('plugin', 'Manage plugins'),
  b('pr-comments', 'Get the comments of a GitHub pull request'),
  b('release-notes', 'Show the release notes'),
  b('rename', 'Rename the session', '[name]'),
  b('resume', 'Resume another conversation', '[session]'),
  b('review', 'Review a pull request', '[pr]'),
  b('rewind', 'Rewind the conversation and code to an earlier point'),
  b('security-review', 'Review the pending changes for security issues'),
  b('skills', 'List the available skills'),
  b('status', 'Show the version, model, account and connections'),
  b('statusline', 'Set up the status line'),
  b('todos', 'List the current tasks'),
  b('usage', 'Show the plan usage limits'),
]

/** pi's built-ins (its docs/slash-commands.md); left out: /quit and /logout, as for Claude. */
export const PI_BUILTINS: readonly SlashCommand[] = [
  b('changelog', 'Show changelog entries'),
  b('clone', 'Duplicate the current session at its current position'),
  b('compact', 'Compact the current context, optionally with custom instructions', '[instructions]'),
  b('copy', 'Copy the last assistant message'),
  b('export', 'Export the session as HTML or JSONL', '[path]'),
  b('fork', 'Create a new session from an earlier user message'),
  b('hotkeys', 'Show active keyboard shortcuts'),
  b('mcp', 'Manage MCP servers'),
  b('model', 'Select a model', '[provider/model]'),
  b('name', 'Set the session display name, or show the current one', '[name]'),
  b('new', 'Start a new session'),
  b('reload', 'Reload keybindings, extensions, skills, templates, themes and context files'),
  b('resume', 'Resume another session'),
  b('scoped-models', 'Configure the models used by interactive cycling'),
  b('session', 'Show current session information and statistics'),
  b('settings', 'Open settings'),
  b('share', 'Upload the session and return a viewer link'),
  b('thinking', 'Set the thinking level', '[level]'),
  b('tree', 'Navigate the session tree'),
]

/** Codex CLI's built-ins; left out: /quit, /exit and /logout. */
export const CODEX_BUILTINS: readonly SlashCommand[] = [
  b('approvals', 'Choose what Codex may do without asking'),
  b('compact', 'Summarize the conversation to free context'),
  b('diff', 'Show the git diff, untracked files too'),
  b('init', 'Write an AGENTS.md with instructions for Codex'),
  b('mcp', 'List the configured MCP tools'),
  b('mention', 'Mention a file'),
  b('model', 'Choose the model and reasoning effort'),
  b('new', 'Start a new chat'),
  b('review', 'Review the current changes'),
  b('status', 'Show the session configuration and token usage'),
]

/** The fields of a Markdown file's frontmatter the list uses. */
export interface Front {
  name?: string
  description?: string
  hint?: string
  /** A skill with `user-invocable: false` is Claude's alone: no command. */
  hidden?: boolean
}

const unquote = (v: string): string => {
  const s = v.trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1)
  return s
}

/** A line of the list: one line, at most 160 characters. */
export const oneLine = (s: string): string => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

/**
 * The frontmatter of a command or skill file and, when it names no description, the body's first
 * line that is not a heading. YAML only as far as these files write it: a key and a value on its
 * line, quoted or not, or a block (`>`, `|`) on the indented lines after it.
 */
export function readFront(text: string): Front {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const out: Front = {}
  let body = src
  const head = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src)
  if (head) {
    body = src.slice(head[0].length)
    const lines = (head[1] ?? '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = /^([\w-]+):\s*(.*)$/.exec(lines[i] ?? '')
      if (!m) continue
      const key = (m[1] ?? '').toLowerCase()
      let value = m[2] ?? ''
      if (/^[>|][+-]?$/.test(value.trim()) || value.trim() === '') {
        const block: string[] = []
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) block.push((lines[++i] ?? '').trim())
        value = block.join(' ')
      }
      value = unquote(value)
      if (key === 'name') out.name = value
      else if (key === 'description') out.description = oneLine(value)
      else if (key === 'argument-hint') out.hint = oneLine(value)
      else if (key === 'user-invocable' && value.toLowerCase() === 'false') out.hidden = true
    }
  }
  if (!out.description) {
    const first = body.split('\n').find(l => l.trim() && !/^\s*#/.test(l))
    if (first) out.description = oneLine(first)
  }
  return out
}

/** A name a command can have: what Claude Code and pi accept after the slash. */
export const commandName = (s: string): boolean => /^[\w][\w.:-]{0,63}$/.test(s)

/**
 * The commands of one session: its own folder's first, then the profile's, then the agent's; a
 * name only once, the first one kept (a project command stands in for a user one of the same name).
 */
export function mergeCommands(...lists: readonly (readonly SlashCommand[])[]): SlashCommand[] {
  const seen = new Set<string>()
  const out: SlashCommand[] = []
  for (const list of lists)
    for (const c of list) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      out.push(c)
    }
  return out
}
