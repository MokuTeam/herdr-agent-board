// The slash commands of one session as the card's chat box offers them (#191): the agent's own
// (core/slash-commands.ts) and the ones its files add. Claude Code: the profile's commands/ and
// skills/ and the session folder's .claude/commands and .claude/skills. pi: its prompt templates
// and skills (pi's own folder, the session folder's .pi, ~/.agents and .agents). Read when the box
// asks (a leading /), only the head of each file; a folder that is not there adds nothing.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isCodexItem } from '../core/codex.ts'
import { isPiItem } from '../core/pi.ts'
import {
  CLAUDE_BUILTINS,
  CODEX_BUILTINS,
  commandName,
  mergeCommands,
  PI_BUILTINS,
  readFront,
  type SlashCommand,
} from '../core/slash-commands.ts'
import type { Item } from '../core/types.ts'

/** The head of a file the frontmatter is looked for in. */
const HEAD_BYTES = 8192
/** The most files one folder gives, its subfolders with it. */
const MAX_FILES = 300

function head(file: string): string {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const isDir = (path: string, e: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean => {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Markdown files in `dir`, its subfolders too when `deep` (Claude Code's commands/frontend/x.md is /x). */
function markdown(dir: string, deep: boolean): string[] {
  const out: string[] = []
  const walk = (at: string, depth: number) => {
    for (const e of entries(at)) {
      if (out.length >= MAX_FILES) return
      const path = join(at, e.name)
      if (e.name.startsWith('.')) continue
      if (isDir(path, e)) {
        if (deep && depth < 3) walk(path, depth + 1)
      } else if (/\.md$/i.test(e.name)) out.push(path)
    }
  }
  walk(dir, 0)
  return out
}

/** Prompt files (a command each, named after the file). */
function commandsIn(dir: string, source: SlashCommand['source'], deep: boolean): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const file of markdown(dir, deep)) {
    const name = basename(file).replace(/\.md$/i, '')
    if (!commandName(name)) continue
    const front = readFront(head(file))
    out.push({ name, description: front.description ?? '', source, ...(front.hint && { hint: front.hint }) })
  }
  return out
}

/** Skill folders (`<name>/SKILL.md`), each named by its frontmatter or its folder; `prefix`: pi's "skill:". */
function skillsIn(dir: string, source: SlashCommand['source'], prefix = ''): SlashCommand[] {
  const out: SlashCommand[] = []
  for (const e of entries(dir)) {
    if (out.length >= MAX_FILES) break
    const path = join(dir, e.name)
    if (e.name.startsWith('.') || !isDir(path, e)) continue
    const text = head(join(path, 'SKILL.md'))
    if (!text) continue
    const front = readFront(text)
    if (front.hidden) continue
    const own = front.name && commandName(front.name) ? front.name : e.name
    const name = `${prefix}${own}`
    if (!commandName(name)) continue
    out.push({ name, description: front.description ?? '', source, ...(front.hint && { hint: front.hint }) })
  }
  return out
}

export interface CommandRoots {
  /** The Claude profile the session's records were read from (item.claudeRoot, else the board's). */
  claudeRoot: string
  env?: Record<string, string | undefined>
  home?: string
}

/** The commands the box offers for `item`; none for an agent the board knows no commands of. */
export function sessionCommands(item: Pick<Item, 'agent' | 'session' | 'cwd'>, roots: CommandRoots): SlashCommand[] {
  const env = roots.env ?? process.env
  const home = roots.home ?? homedir()
  const cwd = item.cwd
  if (isCodexItem(item)) return [...CODEX_BUILTINS]
  if (isPiItem(item)) {
    const own = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')
    return mergeCommands(
      cwd ? commandsIn(join(cwd, '.pi', 'prompts'), 'project', false) : [],
      commandsIn(join(own, 'prompts'), 'user', false),
      cwd ? skillsIn(join(cwd, '.pi', 'skills'), 'project', 'skill:') : [],
      cwd ? skillsIn(join(cwd, '.agents', 'skills'), 'project', 'skill:') : [],
      skillsIn(join(own, 'skills'), 'user', 'skill:'),
      skillsIn(join(home, '.agents', 'skills'), 'user', 'skill:'),
      PI_BUILTINS,
    )
  }
  if (item.agent !== 'claude') return []
  return mergeCommands(
    cwd ? commandsIn(join(cwd, '.claude', 'commands'), 'project', true) : [],
    cwd ? skillsIn(join(cwd, '.claude', 'skills'), 'project') : [],
    commandsIn(join(roots.claudeRoot, 'commands'), 'user', true),
    skillsIn(join(roots.claudeRoot, 'skills'), 'user'),
    CLAUDE_BUILTINS,
  )
}
