// The board's HTTP API as the page uses it. POSTs carry the X-Board header the server asks for;
// every answer is checked by a narrowing function before the page uses it.
import type {
  ArchiveDoneOf,
  ArchivedOne,
  ArchiveFailure,
  ArchiveOp,
  ArchiveRequest,
  PublicArchiveRecord,
  RemovedOne,
  ReturnedOne,
} from '../../../src/core/archive.ts'
import type { PublicDialog } from '../../../src/core/dialogs/questions.ts'
import type { PublicHelper, WorkflowRun } from '../../../src/core/helpers.ts'
import type { BoardPayload, BoardProfile } from '../../../src/core/payload.ts'
import type { QueuedPrompt } from '../../../src/core/queue.ts'
import type { ConversationTurn } from '../../../src/core/transcript.ts'
import type { Item, Translator } from '../../../src/core/types.ts'

export type { BoardCategory, BoardLimits, BoardPayload, BoardProfile, Swatch } from '../../../src/core/payload.ts'

export type Guard<T> = (value: unknown) => value is T
/** A JSON object the server answered with. */
export type Reply = Record<string, unknown>

export const isReply: Guard<Reply> = (value): value is Reply =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ARRAYS = ['items', 'launches', 'categories', 'swatches', 'columns', 'schedules', 'scheduleLog'] as const

/** A list of what `each` accepts, or none at all (a reply from a board before it sent the list). */
const isListOf = <T>(value: unknown, each: Guard<T>): boolean =>
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
  // The program launch.claude types (a board before start commands did not say).
  (value.claudeProgram === undefined || typeof value.claudeProgram === 'string')

/** One session as GET /api/session/<key> answers it (src/server/routes/session.ts). */
export interface SessionDetail {
  item: Item
  /** Its latest turns, oldest first. */
  conversation: ConversationTurn[]
  /** The user's messages Claude has not taken in yet, oldest first (only while its Claude runs). */
  queued?: QueuedPrompt[]
  /** The terminal's screen while a dialog holds the session. */
  screen: string
  dialog: PublicDialog | null
  /** Its folder is in a git checkout: the sheet offers its changes. */
  checkout: boolean
  /** Its subagents, forks, workflow agents and teammates, newest first, and its workflow runs. */
  helpers?: PublicHelper[]
  workflows?: WorkflowRun[]
}

// A notice: a background task reporting back, a board reminder, or a MokuPilot call's results
// (core/notices.ts). A peer: a message from a session or teammate this one works with.
const ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'tool', 'notice', 'peer'])
export const isTurn = (value: unknown): value is ConversationTurn => isReply(value) && ROLES.has(value.role)

/** A message in the session's queue (src/core/queue.ts QueuedPrompt). */
export const isQueued: Guard<QueuedPrompt> = (value): value is QueuedPrompt =>
  isReply(value) && typeof value.text === 'string' && typeof value.at === 'number'

/** A helper as the server lists it (src/core/helpers.ts PublicHelper). */
export const isHelper: Guard<PublicHelper> = (value): value is PublicHelper =>
  isReply(value) && typeof value.id === 'string' && typeof value.kind === 'string' && typeof value.status === 'string'

/** A workflow run of the session (src/core/helpers.ts WorkflowRun). */
export const isWorkflowRun: Guard<WorkflowRun> = (value): value is WorkflowRun =>
  isReply(value) && typeof value.id === 'string' && typeof value.status === 'string'

export const isSessionDetail: Guard<SessionDetail> = (value): value is SessionDetail =>
  isReply(value) &&
  isReply(value.item) &&
  typeof value.item.key === 'string' &&
  Array.isArray(value.conversation) &&
  value.conversation.every(isTurn) &&
  // The session's queue (a board before it sent none).
  isListOf(value.queued, isQueued) &&
  typeof value.screen === 'string' &&
  (value.dialog === null || isReply(value.dialog)) &&
  typeof value.checkout === 'boolean' &&
  isListOf(value.helpers, isHelper) &&
  isListOf(value.workflows, isWorkflowRun)

/** The server said no (status, or `ok: false`); `message` is its `error` when it gave one. */
export class ApiError extends Error {
  readonly status: number
  readonly reply: Reply
  constructor(status: number, reply: Reply) {
    super(typeof reply.error === 'string' ? reply.error : '')
    this.status = status
    this.reply = reply
  }
}

/** The text a toast shows for a failed call, as the board words it. */
export function errorText(err: unknown, t: Translator): string {
  if (err instanceof ApiError) return err.message || t('err.status', { code: err.status })
  return t('err.offline', { why: err instanceof Error ? err.message : String(err) })
}

/** An answer's JSON, {} when it has none. */
export async function replyOf(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

/** The header the server asks of every POST (a page of another site cannot send it). */
const BOARD_HEADER = { 'x-board': '1' }

/** POST `body` as JSON, with the board's header. */
export const postJson = (path: string, body: unknown, init: RequestInit = {}): Promise<Response> =>
  fetch(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...BOARD_HEADER },
    body: JSON.stringify(body),
  })

async function get<T>(path: string, accept: Guard<T>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init)
  const value = await replyOf(res)
  if (!res.ok || !accept(value)) throw new ApiError(res.status, isReply(value) ? value : {})
  return value
}

function post(path: string, body?: unknown): Promise<Reply>
function post<T>(path: string, body: unknown, accept: Guard<T>): Promise<T>
async function post(path: string, body: unknown = {}, accept: Guard<unknown> = isReply): Promise<unknown> {
  const res = await postJson(path, body)
  const value = await replyOf(res)
  const reply = isReply(value) ? value : {}
  if (!res.ok || reply.ok === false || !accept(value)) throw new ApiError(res.status, reply)
  return value
}

/**
 * The latest board, uncached (a page coming back must not see an old one), as it came: the live
 * connection checks it (models/lifecycle.ts), so one this page cannot read still says by its
 * version that the plugin was updated.
 */
function board(signal?: AbortSignal): Promise<Reply> {
  return get('/api/board', isReply, { cache: 'no-store', ...(signal && { signal }) })
}

/** One session's detail, uncached; a 404 says the session is gone. */
function session(key: string, signal: AbortSignal): Promise<SessionDetail> {
  return get(`/api/session/${encodeURIComponent(key)}`, isSessionDetail, { signal, cache: 'no-store' })
}

/** A file into the board's uploads folder, under its own name; resolves where it was saved. */
async function upload(name: string, file: Blob): Promise<string> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      ...BOARD_HEADER,
      'x-filename': encodeURIComponent(name),
      'content-type': file.type || 'application/octet-stream',
    },
    body: file,
  })
  const value = await replyOf(res)
  const reply = isReply(value) ? value : {}
  if (!res.ok || !reply.ok) throw new ApiError(res.status, reply)
  return typeof reply.path === 'string' ? reply.path : ''
}

/** A line for the board's log (POST /api/log): what the page could not do; a failure to send it is dropped. */
export function pageLog(text: string): void {
  void postJson('/api/log', { text }).catch(() => {})
}

export const api = { board, get, post, session, upload }

// ---------------------------------------------------------------- the archive

/** A record as GET /api/archive lists it (src/core/archive.ts PublicArchiveRecord), as far as the page relies on it. */
export const isArchiveRecord: Guard<PublicArchiveRecord> = (value): value is PublicArchiveRecord =>
  isReply(value) &&
  typeof value.key === 'string' &&
  typeof value.name === 'string' &&
  typeof value.category === 'string' &&
  typeof value.archivedAt === 'number'

/** GET /api/archive: what the archive holds, newest first, and how long a session keeps its pane for Return. */
export interface ArchiveListing {
  records: PublicArchiveRecord[]
  /** Absent from a board that did not say. */
  undoMs?: number
}

const isArchiveListing: Guard<ArchiveListing> = (value): value is ArchiveListing =>
  isReply(value) &&
  Array.isArray(value.records) &&
  value.records.every(isArchiveRecord) &&
  (value.undoMs === undefined || typeof value.undoMs === 'number')

/** A session a POST /api/archive did, by its op (src/core/archive.ts ArchiveDoneOf), or did not do. */
const isNamed = (value: unknown): value is Reply & { key: string; name: string } =>
  isReply(value) && typeof value.key === 'string' && typeof value.name === 'string'
const DONE: { [O in ArchiveOp]: Guard<ArchiveDoneOf[O]> } = {
  archive: (value): value is ArchivedOne =>
    isNamed(value) && typeof value.held === 'number' && typeof value.closeAt === 'number',
  return: (value): value is ReturnedOne => isNamed(value) && value.ok === true,
  remove: (value): value is RemovedOne => isNamed(value),
}
const isArchiveFailure: Guard<ArchiveFailure> = (value): value is ArchiveFailure =>
  isReply(value) && typeof value.key === 'string' && typeof value.error === 'string'

/** POST /api/archive's answer as the page reads it: what it did, what it did not, and the first error as text. */
export interface ArchiveReply<O extends ArchiveOp> {
  ok: boolean
  done: ArchiveDoneOf[O][]
  failed: ArchiveFailure[]
  error: string
}

/** The answer's lists; an entry it cannot read is left out. */
function archiveLists<O extends ArchiveOp>(op: O, reply: Reply): Pick<ArchiveReply<O>, 'done' | 'failed'> {
  const accept: Guard<ArchiveDoneOf[O]> = DONE[op]
  return {
    done: Array.isArray(reply.done) ? reply.done.filter(accept) : [],
    failed: Array.isArray(reply.failed) ? reply.failed.filter(isArchiveFailure) : [],
  }
}

/** GET /api/archive, uncached. */
function archiveList(): Promise<ArchiveListing> {
  return get('/api/archive', isArchiveListing, { cache: 'no-store' })
}

/**
 * POST /api/archive: archive, bring back or remove sessions, one or many. Never throws: a refusal
 * (409 with what it did and did not do) or a failed request comes back as `ok: false` with its text.
 */
async function archivePost<O extends ArchiveOp>(
  op: O,
  keys: readonly string[],
  t: Translator,
): Promise<ArchiveReply<O>> {
  const body: ArchiveRequest = { op, keys: [...keys] }
  try {
    const reply = await post('/api/archive', body)
    return { ...archiveLists(op, reply), ok: true, error: typeof reply.error === 'string' ? reply.error : '' }
  } catch (err) {
    const reply = err instanceof ApiError ? err.reply : {}
    return { ...archiveLists(op, reply), ok: false, error: errorText(err, t) }
  }
}

export const archiveApi = { list: archiveList, post: archivePost }
