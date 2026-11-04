// The calendar's sources over the network (#328): an ICS address fetched, and an MCP server called
// over Streamable HTTP by the board itself (no model in the loop, so a sync costs no tokens). An
// error says what went wrong in words that never carry the address: an ICS address is a secret.
//
// MCP: `initialize` (the session id kept when the server gives one), `notifications/initialized`,
// then `tools/call`; an answer is JSON or an event stream whose `data:` lines carry it. A stateless
// server (no session id) is asked the same way. The session is ended (DELETE) when it had one.

/** How long one request may take. */
export const FETCH_TIMEOUT_MS = 30_000
/** The most an answer may be: a year of a busy calendar is far less. */
const MAX_BYTES = 25 * 1024 * 1024

export class FetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchError'
  }
}

/** The body as text, cut off past MAX_BYTES with an error. */
async function bodyOf(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new FetchError(`answer too large (${len} bytes)`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new FetchError('answer too large')
  return text
}

/** What a failed request says, without its address. */
function failure(err: unknown): FetchError {
  if (err instanceof FetchError) return err
  const e = err as { name?: string; code?: string; message?: string }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new FetchError('no answer in time')
  if (e?.code === 'ConnectionRefused' || /ECONNREFUSED|Unable to connect/i.test(String(e?.message)))
    return new FetchError('connection refused')
  if (e?.code) return new FetchError(`network error (${e.code})`)
  return new FetchError('network error')
}

/** An iCalendar file from its address; its text. */
export async function fetchIcs(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { Accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1', 'User-Agent': 'agent-board calendar' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw failure(err)
  }
  if (!res.ok) throw new FetchError(`HTTP ${res.status}`)
  const text = await bodyOf(res).catch(err => {
    throw failure(err)
  })
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) throw new FetchError('the answer is not a calendar')
  return text
}

/** A tool's answer: its text (every text part), its structured content when there is one, and whether it said it failed. */
export interface ToolAnswer {
  text: string
  structured: unknown
  isError: boolean
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string }
}

/** The message with `id` in an answer that is JSON or an event stream. */
function messageOf(contentType: string, text: string, id: number): RpcMessage | null {
  const candidates: unknown[] = []
  if (contentType.includes('text/event-stream')) {
    for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
      const data = block
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data) continue
      try {
        candidates.push(JSON.parse(data))
      } catch {}
    }
  } else {
    try {
      candidates.push(JSON.parse(text))
    } catch {
      throw new FetchError('the answer is not JSON')
    }
  }
  const flat = candidates.flatMap(c => (Array.isArray(c) ? c : [c])) as RpcMessage[]
  return flat.find(m => m && typeof m === 'object' && m.id === id) ?? null
}

const PROTOCOL = '2025-06-18'

/** One conversation with an MCP server: opened at the first call, closed by `close`. */
export class McpClient {
  private session: string | null = null
  /** The protocol revision the server answered initialize with: every request after it says it. */
  private version: string | null = null
  private opened = false
  private nextId = 1

  constructor(
    private readonly url: string,
    private readonly timeoutMs = FETCH_TIMEOUT_MS,
  ) {}

  private async post(body: unknown, expectAnswer: boolean): Promise<RpcMessage | null> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.version) headers['MCP-Protocol-Version'] = this.version
    if (this.session) headers['Mcp-Session-Id'] = this.session
    let res: Response
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      throw failure(err)
    }
    const session = res.headers.get('mcp-session-id')
    if (session) this.session = session
    if (!res.ok) {
      await res.text().catch(() => '')
      throw new FetchError(`HTTP ${res.status}`)
    }
    const text = await bodyOf(res).catch(err => {
      throw failure(err)
    })
    if (!expectAnswer) return null
    const id = (body as { id: number }).id
    const msg = messageOf(res.headers.get('content-type') ?? '', text, id)
    if (!msg) throw new FetchError('no answer to the request')
    if (msg.error) throw new FetchError(`server error: ${String(msg.error.message ?? msg.error.code ?? '')}`.trim())
    return msg
  }

  private async open(): Promise<void> {
    if (this.opened) return
    const init = await this.post(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'agent-board', version: '1' } },
      },
      true,
    )
    const said = (init?.result as { protocolVersion?: unknown } | undefined)?.protocolVersion
    this.version = typeof said === 'string' && said ? said : PROTOCOL
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
    this.opened = true
  }

  /** A tool called with its arguments; its answer. */
  async call(tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    await this.open()
    const msg = await this.post(
      { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name: tool, arguments: args } },
      true,
    )
    const result = (msg?.result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown }
    const parts = Array.isArray(result.content) ? result.content : []
    const text = parts
      .filter((p): p is { type: string; text: string } => !!p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n')
    return { text, structured: result.structuredContent ?? null, isError: result.isError === true }
  }

  /** The session ended at the server, when it had one; never throws. */
  async close(): Promise<void> {
    if (!this.session) return
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': this.session, 'MCP-Protocol-Version': this.version ?? PROTOCOL },
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
    this.session = null
  }
}
