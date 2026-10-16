// The board's HTTP API as the page uses it. POSTs carry the X-Board header the server asks for;
// every answer is checked by a narrowing function before the page uses it.
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { Translator } from '../../../src/core/types.ts'

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
  typeof value.stale === 'boolean'

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

export const api = { board, get, post }
