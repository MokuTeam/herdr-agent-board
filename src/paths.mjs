// Where the board keeps things. The board command and the Claude Code hooks run outside the
// herdr plugin context (no HERDR_PLUGIN_* env), so every path is computed the same way herdr
// seeds them: config under %APPDATA%, runtime state under %LOCALAPPDATA%.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = 'agent-board'
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CONFIG_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID)
export const STATE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID)
export const CARDS_DIR = join(STATE_DIR, 'cards')
// Reminders and repeating pings for sessions (schedule.mjs), one file per entry.
export const SCHEDULE_DIR = join(STATE_DIR, 'schedule')
// Sessions taken off the board, one file per session (archive.mjs).
export const ARCHIVE_DIR = join(STATE_DIR, 'archive')
export const BOARD_FILE = join(STATE_DIR, 'board.json')
/**
 * Claude Code's config folders, the one this process runs with first: CLAUDE_CONFIG_DIR when set,
 * ~/.claude, and the profiles beside it (~/.claude-<name> with sessions or projects in it, each
 * started with CLAUDE_CONFIG_DIR). The board shows the sessions of all of them, and install
 * briefs them all, since the board itself runs under herdr, without the session's environment.
 */
export function claudeDirs(env = process.env, home = homedir()) {
  const tilde = p => (/^~(?=$|[\\/])/.test(p) ? home + p.slice(1) : p)
  const list = [env.CLAUDE_CONFIG_DIR && resolve(tilde(env.CLAUDE_CONFIG_DIR)), join(home, '.claude')]
  try {
    const names = readdirSync(home, { withFileTypes: true }).filter(e => e.isDirectory() && /^\.claude-[^.]+$/.test(e.name)).map(e => e.name)
    for (const name of names.sort()) {
      const dir = join(home, name)
      if (existsSync(join(dir, 'sessions')) || existsSync(join(dir, 'projects'))) list.push(dir)
    }
  } catch {}
  return [...new Set(list.filter(Boolean))]
}
export const CLAUDE_DIRS = claudeDirs()
export const CLAUDE_DIR = CLAUDE_DIRS[0]
/** The config folder a transcript is in (<dir>/projects/<project>/<id>.jsonl), or null. */
export const configDirOf = transcript => (transcript ? dirname(dirname(dirname(transcript))) : null)
/**
 * The environment Claude needs to run in config folder `dir` (to resume a session of it):
 * CLAUDE_CONFIG_DIR, or nothing for ~/.claude (set to that, Claude would look for .claude.json in
 * it rather than in the home folder) and for an unknown one.
 */
export const profileEnv = dir => (dir && resolve(dir) !== join(homedir(), '.claude') ? { CLAUDE_CONFIG_DIR: resolve(dir) } : {})
/** herdr's --env options for a new tab or workspace. */
export const envArgs = env => Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])
// From Claude Code's status line (statusline.mjs): the account's usage windows, each session's context.
export const USAGE_FILE = join(STATE_DIR, 'claude-limits-latest.json')
export const CONTEXT_DIR = join(STATE_DIR, 'context')
