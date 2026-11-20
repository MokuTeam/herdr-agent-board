// The slash commands of one session as the card's chat box offers them (#191): the agent's own
// (core/slash-commands.ts) and the ones its files add. Claude Code: the profile's commands/ and
// skills/ and the session folder's .claude/commands and .claude/skills. pi: its prompt templates
// and skills (pi's own folder, the session folder's .pi, ~/.agents and .agents). Read when the box
// asks (a leading /), only the head of each regular file, at most so many entries per folder;
// a folder that is not there adds nothing. Off the server's loop (fs/promises).
import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
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
/** The most entries one folder (its subfolders with it) is looked through for commands. */
const MAX_ENTRIES = 1000

/** The head of a regular file ('' for anything else: a folder, a pipe, a device, one not there). */
async function head(file: string): Promise<string> {
  try {
    if (!(await stat(file)).isFile()) return ''
    const fd = await open(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await fd.read(buf, 0, HEAD_BYTES, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fd.close()
    }
  } catch {
    return ''
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isDir(path: string, e: Dirent): Promise<boolean> {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Markdown files in `dir`, its subfolders too when `deep` (Claude Code's commands/frontend/x.md is /x). */
async function markdown(dir: string, deep: boolean): Promise<string[]> {
  const out: string[] = []
  let seen = 0
  const walk = async (at: string, depth: number): Promise<void> => {
    for (const e of await entries(at)) {
      if (++seen > MAX_ENTRIES) return
      const path = join(at, e.name)
      if (e.name.startsWith('.')) continue
      if (/\.md$/i.test(e.name) && !e.isDirectory()) out.push(path)
      else if (deep && depth < 3 && (await isDir(path, e))) await walk(path, depth + 1)
    }
  }
  await walk(dir, 0)
  return out
}

/** The files read at once: a folder of hundreds goes in batches, under any open-file limit. */
const BATCH = 32

/** `f` over `list`, BATCH at a time, in order; the nulls dropped. */
async function batched<T, R>(list: readonly T[], f: (x: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < list.length; i += BATCH)
    for (const r of await Promise.all(list.slice(i, i + BATCH).map(f))) if (r !== null) out.push(r)
  return out
}

const command = (name: string, text: string, source: SlashCommand['source']): SlashCommand => {
  const front = readFront(text)
  return { name, description: front.description ?? '', source, ...(front.hint && { hint: front.hint }) }
}

/** Prompt files (a command each, named after the file). */
async function commandsIn(dir: string, source: SlashCommand['source'], deep: boolean): Promise<SlashCommand[]> {
  const files = (await markdown(dir, deep))
    .map(file => ({ file, name: basename(file).replace(/\.md$/i, '') }))
    .filter(f => commandName(f.name))
  return batched(files, async ({ file, name }) => {
    const text = await head(file)
    return text ? command(name, text, source) : null
  })
}

/** Skill folders (`<name>/SKILL.md`), each named by its frontmatter or its folder; `prefix`: pi's "skill:". */
async function skillsIn(dir: string, source: SlashCommand['source'], prefix = ''): Promise<SlashCommand[]> {
  const folders = (await entries(dir)).slice(0, MAX_ENTRIES).filter(e => !e.name.startsWith('.'))
  return batched(folders, async e => {
    const path = join(dir, e.name)
    if (!(await isDir(path, e))) return null
    const text = await head(join(path, 'SKILL.md'))
    if (!text) return null
    const front = readFront(text)
    if (front.hidden) return null
    const own = front.name && commandName(front.name) ? front.name : e.name
    const name = `${prefix}${own}`
    return commandName(name) ? command(name, text, source) : null
  })
}

export interface CommandRoots {
  /** The Claude profile the session's records were read from (item.claudeRoot, else the board's). */
  claudeRoot: string
  env?: Record<string, string | undefined>
  home?: string
}

/** The commands the box offers for `item`; none for an agent the board knows no commands of. */
export async function sessionCommands(
  item: Pick<Item, 'agent' | 'session' | 'cwd'>,
  roots: CommandRoots,
): Promise<SlashCommand[]> {
  const env = roots.env ?? process.env
  const home = roots.home ?? homedir()
  const cwd = item.cwd
  if (isCodexItem(item)) return [...CODEX_BUILTINS]
  if (isPiItem(item)) {
    const own = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')
    const found = await Promise.all([
      cwd ? commandsIn(join(cwd, '.pi', 'prompts'), 'project', false) : [],
      commandsIn(join(own, 'prompts'), 'user', false),
      cwd ? skillsIn(join(cwd, '.pi', 'skills'), 'project', 'skill:') : [],
      cwd ? skillsIn(join(cwd, '.agents', 'skills'), 'project', 'skill:') : [],
      skillsIn(join(own, 'skills'), 'user', 'skill:'),
      skillsIn(join(home, '.agents', 'skills'), 'user', 'skill:'),
    ])
    return mergeCommands(...found, PI_BUILTINS)
  }
  if (item.agent !== 'claude') return []
  const found = await Promise.all([
    cwd ? commandsIn(join(cwd, '.claude', 'commands'), 'project', true) : [],
    cwd ? skillsIn(join(cwd, '.claude', 'skills'), 'project') : [],
    commandsIn(join(roots.claudeRoot, 'commands'), 'user', true),
    skillsIn(join(roots.claudeRoot, 'skills'), 'user'),
  ])
  return mergeCommands(...found, CLAUDE_BUILTINS)
}
