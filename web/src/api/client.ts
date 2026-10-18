// The board's HTTP API as the page uses it. POSTs carry the X-Board header the server asks for;
// every answer is checked by a narrowing function before the page uses it.
import type { PublicDialog } from '../../../src/core/dialogs/questions.ts'
import type { PublicHelper, WorkflowRun } from '../../../src/core/helpers.ts'
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { ConversationTurn } from '../../../src/core/transcript.ts'
import type { Item, Translator } from '../../../src/core/types.ts'

export type { BoardCategory, BoardLimits, BoardPayload, Swatch } from '../../../src/core/payload.ts'

export type Guard<T> = (value: unknown) => value is T
/** A JSON object the server answered with. */
export type Reply = Record<string, unknown>

export const isReply: Guard<Reply> = (value): value is Reply =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ARRAYS = ['items', 'launches', 'categories', 'swatches', 'columns', 'schedules', 'scheduleLog'] as const

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
  (value.mokupilot === undefined || typeof value.mokupilot === 'boolean')

/** One session as GET /api/session/<key> answers it (src/server/routes/session.ts). */
export interface SessionDetail {
  item: Item
  /** Its latest turns, oldest first. */
  conversation: ConversationTurn[]
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

/** A list of what `each` accepts, or none at all (a reply from before helpers were read). */
const isListOf = <T>(value: unknown, each: Guard<T>): boolean =>
  value === undefined || (Array.isArray(value) && value.every(each))

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

async function replyOf(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

async function get<T>(path: string, accept: Guard<T>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init)
  const value = await replyOf(res)
  if (!res.ok || !accept(value)) throw new ApiError(res.status, isReply(value) ? value : {})
  return value
}

function post(path: string, body?: unknown): Promise<Reply>
function post<T>(path: string, body: unknown, accept: Guard<T>): Promise<T>
async function post(path: string, body: unknown = {}, accept: Guard<unknown> = isReply): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
  const value = await replyOf(res)
  const reply = isReply(value) ? value : {}
  if (!res.ok || reply.ok === false || !accept(value)) throw new ApiError(res.status, reply)
  return value
}

/** The latest board, uncached (a page coming back must not see an old one). */
function board(signal?: AbortSignal): Promise<BoardPayload> {
  return get('/api/board', isBoardPayload, { cache: 'no-store', ...(signal && { signal }) })
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
      'x-board': '1',
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

export const api = { board, get, post, session, upload }
