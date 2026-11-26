// The local Workdesk adapter speaks MCP over newline-delimited JSON-RPC on stdio.
import { object, type WorkdeskMcpConfig } from '../core/workdesk.ts'

const RPC_TIMEOUT_MS = 15_000
const MAX_FRAME = 8 * 1024 * 1024

export function supportsTopology(schema: unknown): boolean {
  const topology = object(object(object(schema)?.properties)?.topology)
  const versions = object(object(topology?.properties)?.version)?.enum
  return Array.isArray(versions) && versions.includes(1)
}

export class WorkdeskToolError extends Error {
  readonly conflict: boolean
  readonly code: 'assignment_mismatch' | 'conflict' | 'role_denied' | 'invalid_cursor' | null
  /** The tool's error body as Workdesk sent it (its `code` and `status`). */
  readonly body: Record<string, unknown> | null

  constructor(result: unknown) {
    super('Workdesk tool failed')
    const body = object(result)
    this.body = body
    const code = body?.code
    this.conflict = code === 'conflict' && body?.status === 409
    this.code =
      code === 'assignment_mismatch' || code === 'conflict' || code === 'role_denied' || code === 'invalid_cursor'
        ? code
        : null
  }
}

async function* messages(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  let pending = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    let end = pending.indexOf('\n')
    while (end !== -1) {
      if (end > MAX_FRAME) throw new Error('Workdesk MCP frame too large')
      const line = pending.slice(0, end).trim()
      pending = pending.slice(end + 1)
      if (line) {
        const message = object(JSON.parse(line))
        if (message?.jsonrpc !== '2.0') throw new Error('Invalid Workdesk MCP response')
        yield message
      }
      end = pending.indexOf('\n')
    }
    if (pending.length > MAX_FRAME) throw new Error('Workdesk MCP frame too large')
  }
}

export async function withWorkdeskMcp<T>(
  config: WorkdeskMcpConfig,
  signal: AbortSignal,
  run: (mcp: {
    tools(): Promise<Map<string, unknown>>
    call(name: string, args: Record<string, unknown>): Promise<unknown>
  }) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const child = Bun.spawn([config.executable, ...config.args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    signal,
    ...(config.caFile && { env: { ...process.env, NODE_EXTRA_CA_CERTS: config.caFile } }),
  })
  const kill = () => child.kill('SIGKILL')
  signal.addEventListener('abort', kill, { once: true })
  if (signal.aborted) kill()
  const input = messages(child.stdout)
  // Pipe writes can settle later (a Promise on Windows): await them, so a write to an adapter
  // that has gone (EPIPE) rejects its own request instead of escaping as an unhandled rejection.
  const write = async (message: Record<string, unknown>) => {
    signal.throwIfAborted()
    await child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    await child.stdin.flush()
  }
  let nextId = 0
  async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++nextId
    // Closing the subprocess also ends the read (or a stuck write) when the adapter stays silent.
    const timeout = setTimeout(kill, RPC_TIMEOUT_MS)
    try {
      await write({ id, method, params })
      for (;;) {
        const next = await input.next()
        if (next.done) throw new Error('Workdesk MCP disconnected')
        const reply = next.value
        if (reply.id !== id) continue
        const result = object(reply.result)
        if (!result) throw new Error('Workdesk MCP request failed')
        return result
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-board-workdesk', version: '1' },
    })
    if (typeof init.protocolVersion !== 'string') throw new Error('Invalid Workdesk MCP initialization')
    await write({ method: 'notifications/initialized' })
    return await run({
      async tools() {
        const catalog = new Map<string, unknown>()
        let cursor: unknown
        const seen = new Set<string>()
        do {
          const result = await rpc('tools/list', typeof cursor === 'string' ? { cursor } : {})
          if (!Array.isArray(result.tools)) throw new Error('Invalid Workdesk MCP tool list')
          for (const tool of result.tools) {
            const entry = object(tool)
            if (typeof entry?.name === 'string') catalog.set(entry.name, entry.inputSchema)
          }
          cursor = result.nextCursor
          if (typeof cursor === 'string') {
            if (seen.has(cursor) || seen.size >= 100) throw new Error('Invalid Workdesk MCP tool cursor')
            seen.add(cursor)
          }
        } while (typeof cursor === 'string')
        return catalog
      },
      async call(name, args) {
        const result = await rpc('tools/call', { name, arguments: args })
        const body = result.structuredContent
        if (result.isError === true) throw new WorkdeskToolError(body)
        return body
      },
    })
  } finally {
    signal.removeEventListener('abort', kill)
    kill()
    await input.return(undefined)
    await child.exited
  }
}
