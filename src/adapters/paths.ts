// Where the board keeps things. The board command and the Claude Code hooks run outside the
// herdr plugin context (no HERDR_PLUGIN_* env), so every path is computed the same way herdr
// seeds them: config under %APPDATA%, runtime state under %LOCALAPPDATA%. Computed at call time,
// so a process (or a test) that sets the env first gets its own folders.
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cardStore } from '../core/card-store.ts'

export const PLUGIN_ID = 'agent-board'
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const configDir = (): string =>
  join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID)
export const stateDir = (): string =>
  join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID)
export const cardsDir = (): string => cardStore(process.env, homedir(), process.platform).cards
// Reminders and repeating pings for sessions (schedule-store.ts), one file per entry.
export const scheduleDir = (): string => join(stateDir(), 'schedule')
// Sessions taken off the board, one file per session (archive-store.ts).
export const archiveDir = (): string => join(stateDir(), 'archive')
export const boardFile = (): string => join(stateDir(), 'board.json')
export const uploadsDir = (): string => join(stateDir(), 'uploads')
// First messages for a launcher's {messageFile}, there only while the launcher runs.
export const launchDir = (): string => join(stateDir(), 'launch')
// From Claude Code's status line (entrypoints/statusline.ts): the account's usage windows, each session's context.
export const usageFile = (): string => join(stateDir(), 'claude-limits-latest.json')
// A profile id as part of a file name: lower-case letters, digits, `_` and `-` as they are, every
// other character (upper-case letters too) as %XX, or %uXXXX past FF. Two ids never share a file,
// on a file system blind to case as well.
const fileId = (id: string): string =>
  id.replace(/[^a-z0-9_-]/g, c => {
    const hex = c.charCodeAt(0).toString(16).toUpperCase()
    return hex.length > 2 ? `%u${hex.padStart(4, '0')}` : `%${hex.padStart(2, '0')}`
  })
// The usage windows per Claude profile: the default profile's in usageFile(), as before; another's
// in its own file, named apart from it (a profile with the id `latest` included).
export const usageFileFor = (id: string): string =>
  id === 'default' ? usageFile() : join(stateDir(), `claude-limits-profile-${fileId(id)}.json`)
export const contextDir = (): string => join(stateDir(), 'context')
// The shells the board opened (services/terminals.ts), so a board that restarts finds them again.
export const terminalsFile = (): string => join(stateDir(), 'terminals.json')
// The panes opened with a profile's CLAUDE_CONFIG_DIR (adapters/profile-panes.ts).
export const profilePanesFile = (): string => join(stateDir(), 'profile-panes.json')
// The peer network (#231, config.json's `team`): this board's Ed25519 key, the messages in and out,
// the keys of the peers it has seen, and a log without bodies. Written only by `board team join`
// and by the running board with `team` set (adapters/team-store.ts).
export const teamKeyFile = (): string => join(stateDir(), 'team-key.json')
export const teamInboxFile = (): string => join(stateDir(), 'team-inbox.json')
export const teamOutboxFile = (): string => join(stateDir(), 'team-outbox.json')
export const teamPinsFile = (): string => join(stateDir(), 'team-pins.json')
export const teamAuditFile = (): string => join(stateDir(), 'team-audit.jsonl')
// What agents drafted for a person to send (`board team draft`); the running board with `team` set writes it.
export const teamDraftsFile = (): string => join(stateDir(), 'team-drafts.json')
