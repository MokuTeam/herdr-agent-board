// Where the board keeps things. The board command and the Claude Code hooks run outside the
// herdr plugin context (no HERDR_PLUGIN_* env), so every path is computed the same way herdr
// seeds them: config under %APPDATA%, runtime state under %LOCALAPPDATA%. Computed at call time,
// so a process (or a test) that sets the env first gets its own folders.
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = 'agent-board'
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const configDir = (): string =>
  join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID)
export const stateDir = (): string =>
  join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID)
export const cardsDir = (): string => join(stateDir(), 'cards')
// Reminders and repeating pings for sessions (schedule-store.ts), one file per entry.
export const scheduleDir = (): string => join(stateDir(), 'schedule')
export const boardFile = (): string => join(stateDir(), 'board.json')
export const uploadsDir = (): string => join(stateDir(), 'uploads')
// From Claude Code's status line (statusline.mjs): the account's usage windows, each session's context.
export const usageFile = (): string => join(stateDir(), 'claude-limits-latest.json')
export const contextDir = (): string => join(stateDir(), 'context')
// Until Task 13 replaces it with ClaudeHome.
export const claudeDir = (): string => join(homedir(), '.claude')
