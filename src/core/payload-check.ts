// The board payload's shape as a reader relies on it: the page (web/src/api/client.ts), and a
// master reading a node's event stream (services/nodes/link.ts). Pure, and the page imports it, so
// both take one check: a payload the page would refuse is refused by the master too.
import type { BoardPayload, BoardProfile } from './payload.ts'

export type Guard<T> = (value: unknown) => value is T
/** A JSON object the server answered with. */
export type Reply = Record<string, unknown>

export const isReply: Guard<Reply> = (value): value is Reply =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ARRAYS = ['items', 'launches', 'categories', 'swatches', 'columns', 'schedules', 'scheduleLog'] as const

/** A list of what `each` accepts, or none at all (a reply from a board before it sent the list). */
export const isListOf = <T>(value: unknown, each: Guard<T>): boolean =>
  value === undefined || (Array.isArray(value) && value.every(each))

/**
 * A profile's usage (src/core/payload.ts BoardLimits): none, or a reading with its list of windows.
 * The usage pill reads it as the board's own (models/limits.ts limitInfo), leaving out a window it
 * cannot read and taking a reading of unknown age as an old one.
 */
const isProfileLimits = (value: unknown): boolean => value === null || (isReply(value) && Array.isArray(value.windows))

/**
 * A Claude profile as the board sends it (src/core/payload.ts BoardProfile), as far as the page
 * relies on it: the profile switch and the cards' tags read its id, title, color, folder and
 * whether it is hidden; the usage pill and its popover read its usage; the Profiles panel reads
 * whether its folder is there, whether the board's hooks are in it (none read for a hidden one),
 * its sessions now and its start command (a board before start commands sent none).
 */
export const isBoardProfile: Guard<BoardProfile> = (value): value is BoardProfile =>
  isReply(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.color === 'string' &&
  typeof value.dir === 'string' &&
  typeof value.hidden === 'boolean' &&
  typeof value.exists === 'boolean' &&
  (typeof value.hooks === 'boolean' || value.hooks === null) &&
  typeof value.sessions === 'number' &&
  isProfileLimits(value.limits) &&
  (value.command === undefined || typeof value.command === 'string')

const isNodeMaster = (value: unknown): boolean =>
  isReply(value) &&
  typeof value.nodeId === 'string' &&
  typeof value.name === 'string' &&
  (value.url === null || typeof value.url === 'string') &&
  typeof value.online === 'boolean'

/** The board payload's shape, as far as the page relies on it (src/core/payload.ts). */
export const isBoardPayload: Guard<BoardPayload> = (value): value is BoardPayload =>
  isReply(value) &&
  ARRAYS.every(key => Array.isArray(value[key])) &&
  typeof value.version === 'string' &&
  typeof value.stale === 'boolean' &&
  // The terminal's (a board before it sent neither): whether it is on, the sessions with a shell.
  (value.terminal === undefined || typeof value.terminal === 'boolean') &&
  (value.shells === undefined || (Array.isArray(value.shells) && value.shells.every(s => typeof s === 'string'))) &&
  // Whether MokuPilot is here for calls (a board before it did not say).
  (value.mokupilot === undefined || typeof value.mokupilot === 'boolean') &&
  // Whether the board can fork a session (a board before forks did not say).
  (value.fork === undefined || typeof value.fork === 'boolean') &&
  // Whether the board can ask side questions (a board before them did not say).
  (value.aside === undefined || typeof value.aside === 'boolean') &&
  // The Claude profiles (a board before them sent none).
  isListOf(value.profiles, isBoardProfile) &&
  // Antigravity (Gemini) usage (#647): omitted when agy is not installed, null when unknown, else a reading with windows.
  (value.agyLimits === undefined || isProfileLimits(value.agyLimits)) &&
  // The program launch.claude types (a board before start commands did not say).
  (value.claudeProgram === undefined || typeof value.claudeProgram === 'string') &&
  // The Remote access view's revision (a board before it did not send one).
  (value.accessRev === undefined || typeof value.accessRev === 'number') &&
  // The peer network's revision (only a board with `team` in config.json sends one).
  (value.teamRev === undefined || typeof value.teamRev === 'number') &&
  // The team's unread messages (#355), likewise.
  (value.teamUnread === undefined || typeof value.teamUnread === 'number') &&
  // What the owner's phone asked and waits for the passkey here (#377), only while some does.
  (value.teamWaiting === undefined || typeof value.teamWaiting === 'number') &&
  // Master info on a node's local board (#744).
  (value.nodeMaster === undefined || isNodeMaster(value.nodeMaster))
