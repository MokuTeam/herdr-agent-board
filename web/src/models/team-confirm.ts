// The owner's confirmation by passkey (#224) on the page. The board holds back what sends as the
// owner or widens what agents may do (src/core/team-confirm.ts): it answers 428 with the address
// of a confirmation window on http://localhost:<port> (WebAuthn takes no IP, and the board is
// opened on 127.0.0.1). ownerPost opens that window, waits for its answer, and gives back what the
// action answered. A confirmed send comes with an unlock token: kept here, in this page's memory
// only, and sent with the next sends for 30 minutes (a reload or a restart of the board ends it).
//
// The window's side: confirmPage() says whether this page is one (main.tsx then draws
// ConfirmScreen instead of the board), and confirmed() tells the page that opened it.
import { ApiError, isReply, type Reply, replyOf } from '../api/client.ts'

/** What the window posts to the page that opened it. */
export const CONFIRMED = 'agent-board:confirmed'
/** How long a confirmed send unlocks sending (src/core/team-confirm.ts UNLOCK_MS). */
const UNLOCK_MS = 30 * 60_000
/** The window waits this long at most (the board forgets the action after 2 minutes). */
const WAIT_MS = 3 * 60_000
const ID = /^[A-Za-z0-9_-]{22}$/

export interface Confirmed {
  type: typeof CONFIRMED
  id: string
  status: number
  reply: Reply
  unlock?: string
}

export const isConfirmed = (v: unknown): v is Confirmed =>
  isReply(v) &&
  v.type === CONFIRMED &&
  typeof v.id === 'string' &&
  typeof v.status === 'number' &&
  isReply(v.reply) &&
  (v.unlock === undefined || typeof v.unlock === 'string')

export interface ConfirmDeps {
  fetch(url: string, init: RequestInit): Promise<Response>
  /** window.open; null when the browser blocked it. */
  open(url: string): { closed: boolean } | null
  /** Listens for messages to this page; gives back the way to stop. */
  listen(fn: (e: { origin: string; data: unknown }) => void): () => void
  now(): number
  /** The origin of the confirmation window: http://localhost:<this page's port>. */
  windowOrigin(): string
  /** Waits `ms`, then calls `fn`; gives back the way to stop. */
  poll(fn: () => void, ms: number): () => void
}

const browser = (): ConfirmDeps => ({
  fetch: (url, init) => fetch(url, init),
  // A window of its own each time: one named and reused could stay behind the board, unseen.
  open: url => window.open(url, '_blank', 'popup,width=460,height=560'),
  listen(fn) {
    const on = (e: MessageEvent) => fn(e)
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  },
  now: () => Date.now(),
  windowOrigin: () => `http://localhost:${location.port}`,
  poll(fn, ms) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  },
})

let unlock: { token: string; until: number } | null = null

/** Forgets the unlock (the tests start each one without). */
export function forgetUnlock(): void {
  unlock = null
}

/** Waits for the window's answer about `id`; a window closed first, or one never answering, is a refusal. */
function answerOf(deps: ConfirmDeps, id: string, win: { closed: boolean }): Promise<{ status: number; reply: Reply }> {
  return new Promise(resolve => {
    const started = deps.now()
    const stops: (() => void)[] = []
    const settle = (r: { status: number; reply: Reply }) => {
      for (const stop of stops) stop()
      resolve(r)
    }
    stops.push(
      deps.listen(e => {
        if (e.origin !== deps.windowOrigin() || !isConfirmed(e.data) || e.data.id !== id) return
        if (e.data.unlock) unlock = { token: e.data.unlock, until: deps.now() + UNLOCK_MS }
        settle({ status: e.data.status, reply: e.data.reply })
      }),
      deps.poll(() => {
        if (win.closed || deps.now() - started > WAIT_MS)
          settle({ status: 0, reply: { ok: false, error: 'cancelled' } })
      }, 500),
    )
  })
}

/**
 * POST an owner action. Answered at once (unlocked, or nothing to confirm): that answer. Held
 * back (428): the answer once the window confirmed it, or { error: 'cancelled' } when it was
 * closed, { error: 'blocked' } when the browser would not open it. Throws ApiError as api.post does.
 */
export async function ownerPost(path: string, body: unknown, deps: ConfirmDeps = browser()): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-board': '1' }
  if (unlock && unlock.until > deps.now()) headers['x-board-unlock'] = unlock.token
  const res = await deps.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
  const value = await replyOf(res)
  let r = { status: res.status, reply: isReply(value) ? value : {} }
  const url = r.reply.confirm
  const id = r.reply.id
  if (
    r.status === 428 &&
    typeof url === 'string' &&
    typeof id === 'string' &&
    url.startsWith(`${deps.windowOrigin()}/`)
  ) {
    const win = deps.open(url)
    r = win ? await answerOf(deps, id, win) : { status: 0, reply: { ok: false, error: 'blocked' } }
  }
  if (r.status < 200 || r.status > 299 || r.reply.ok === false) throw new ApiError(r.status, r.reply)
  return r.reply
}

/** The words for a refusal of the confirmation itself (no passkey, window closed or blocked, ::1 held); null for any other. */
export function confirmError(err: unknown, t: (key: string) => string): string | null {
  const code = err instanceof ApiError ? err.reply.error : null
  return code === 'passkey' || code === 'blocked' || code === 'cancelled' || code === 'loopback'
    ? t(`team.err.${code}`)
    : null
}

/** This page is a confirmation window: its id, else null. Only on localhost, where the passkeys are. */
export function confirmPage(loc: { hostname: string; search: string } = location): string | null {
  if (loc.hostname !== 'localhost') return null
  const id = new URLSearchParams(loc.search).get('confirm')
  return id && ID.test(id) ? id : null
}

/** Tells the page that opened this window: on the board's own origins only, never another site. */
export function confirmed(message: Omit<Confirmed, 'type'>, port: string, opener: Window | null = window.opener): void {
  if (!opener) return
  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
    try {
      opener.postMessage({ type: CONFIRMED, ...message }, origin)
    } catch {}
}
