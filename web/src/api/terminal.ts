// The terminal's routes as the page uses them (src/server/routes/terminal.ts): the screen as
// Server-Sent Events (EventSource sends no headers: the board's per-run token rides in the query),
// and the POSTs that open, close, focus and type, with the X-Board header.
import type { Translator } from '../../../src/core/types.ts'
import { isReply } from './client.ts'

/** How a POST went: the server's answer with `ok`, or why not (`timeout`: the page gave up waiting). */
export interface TermReply {
  ok: boolean
  error?: string
  timeout?: boolean
  [extra: string]: unknown
}

/** What the window reads of an EventSource. */
export interface TermStream {
  onmessage: ((e: { data: string }) => void) | null
  onerror: (() => void) | null
  readonly readyState: number
  close(): void
}

/** EventSource.CLOSED: the server said no, for good. */
export const STREAM_CLOSED = 2

export interface TerminalApi {
  /** The screen of session `key`'s agent pane or shell. */
  stream(key: string, target: string, token: string): TermStream
  /** POST /api/term/<key>/<target>/<op>; `timeout` (ms) gives up on it. */
  post(key: string, target: string, op: string, body: unknown, timeout?: number): Promise<TermReply>
}

export const termPath = (key: string, target: string, op: string): string =>
  `/api/term/${encodeURIComponent(key)}/${target}/${op}`

export function terminalApi(t: () => Translator): TerminalApi {
  return {
    stream(key, target, token) {
      const es = new EventSource(`${termPath(key, target, 'stream')}?t=${encodeURIComponent(token)}`)
      const stream: TermStream = {
        onmessage: null,
        onerror: null,
        get readyState() {
          return es.readyState
        },
        close: () => es.close(),
      }
      es.onmessage = e => stream.onmessage?.({ data: String(e.data) })
      es.onerror = () => stream.onerror?.()
      return stream
    },
    async post(key, target, op, body, timeout = 0) {
      try {
        const res = await fetch(termPath(key, target, op), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify(body),
          ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
        })
        const value: unknown = await res.json().catch(() => ({}))
        const r = isReply(value) ? value : {}
        return res.ok && r.ok !== false
          ? { ...r, ok: true }
          : {
              ...r,
              ok: false,
              error: (typeof r.error === 'string' && r.error) || t()('err.status', { code: res.status }),
            }
      } catch (err) {
        // A DOMException: an Error by its prototype in browsers, not always by instanceof elsewhere.
        const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : ''
        if (name === 'TimeoutError') return { ok: false, timeout: true, error: t()('term.slow') }
        const why = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err)
        return { ok: false, error: t()('err.offline', { why }) }
      }
    },
  }
}
