// `board mcp --http` (#814): the board's MCP on stdio for a harness that cannot send a header of
// the session's own over HTTP (Antigravity CLI, pi): a thin client of the board's `/mcp` (#813).
// Each JSON-RPC line from stdin goes to the endpoint as it is, with the caller's herdr pane from
// this process's environment (the harness starts it in the session's pane) or the session
// `--session` names; the answer goes back as one line. No tool of its own: the tools, their rules
// and who may do what are the board's, as for every other caller.

import { PANE_HEADER, SESSION_HEADER } from '../core/mcp-register.ts'

type Env = Record<string, string | undefined>

export interface HttpRelayOptions {
  /** The board's endpoint (core/mcp-register.ts boardMcpUrl). */
  url: string
  /** Who calls (httpRelayHeaders). */
  headers: Record<string, string>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** How long one call may take: a start or a send waits on the board. */
  timeoutMs?: number
}

/** The caller's header: the session `--session` names, else the herdr pane this runs in, else none (the owner). */
export function httpRelayHeaders(env: Env, session?: string): Record<string, string> {
  if (session) return { [SESSION_HEADER]: session }
  return env.HERDR_PANE_ID ? { [PANE_HEADER]: env.HERDR_PANE_ID } : {}
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The ids of a request (or a batch) that wait for an answer. */
function idsOf(msg: unknown): unknown[] {
  const list = Array.isArray(msg) ? msg : [msg]
  return list.filter(m => isObj(m) && 'id' in m && typeof m.method === 'string').map(m => (m as { id: unknown }).id)
}

/** The JSON-RPC messages of a text/event-stream body: each event's data. */
function eventData(body: string): string[] {
  const out: string[] = []
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).replace(/^ /, ''))
    if (data.length) out.push(data.join('\n'))
  }
  return out
}

/** One line per JSON value, so that stdout carries one message a line. */
const oneLine = (text: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return null
  }
}

/** The relay: one line in, the line(s) to write back (null for a notification or nothing to say). */
export function createHttpRelay(o: HttpRelayOptions): { handle(line: string): Promise<string | null> } {
  const call = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const timeoutMs = o.timeoutMs ?? 300_000
  return {
    async handle(line) {
      if (!line.trim()) return null
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      }
      const ids = idsOf(msg)
      const fail = (message: string): string | null =>
        ids.length
          ? ids.map(id => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })).join('\n')
          : null
      let res: Response
      try {
        res = await call(o.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...o.headers,
          },
          body: line,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        return fail(`the board does not answer at ${o.url}: ${err instanceof Error ? err.message : String(err)}`)
      }
      const body = await res.text().catch(() => '')
      if (res.status === 202 || !body.trim())
        return res.ok ? null : fail(`the board answered ${res.status} at ${o.url}`)
      const type = res.headers.get('content-type') ?? ''
      const answers = (type.includes('text/event-stream') ? eventData(body) : [body]).map(oneLine)
      // A refusal the board words as JSON-RPC goes back as it is; anything else is said in one line.
      if (answers.every(a => a !== null) && answers.length) return answers.join('\n')
      return fail(`the board answered ${res.status} at ${o.url}: ${body.split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`)
    },
  }
}
