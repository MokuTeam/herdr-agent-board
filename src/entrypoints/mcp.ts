// `board mcp` (#394, docs/design/threads 5.4): the threads as an MCP server on stdio, for a harness
// whose sessions cannot run a command. Two tools, so that the schema a session carries stays small:
// `threads` reads (list, show, changes) and `thread` writes (new, post, ask, set, watch). Each call
// is the `board thread` command run in this process, as the session that started the server (or
// the one --session names; else the owner), and returns the same lines the command prints. The
// tool list is fixed when the server starts and never changes while it runs: a session's tools are
// part of its cached prefix.
//
// JSON-RPC 2.0, one message a line on stdin and stdout; stdout carries nothing else, logs go to
// stderr. Methods: initialize, notifications/initialized, ping, tools/list, tools/call.

/** One run of `board thread <argv>`: its exit code and the lines it printed. */
export interface ThreadRun {
  code: number
  out: string[]
  err: string[]
}

export interface McpOptions {
  version: string
  /** Runs `board thread <argv>` as the server's session; never throws for a refusal, only prints it. */
  run: (argv: string[]) => Promise<ThreadRun>
}

const STATUSES = ['next', 'doing', 'waiting', 'owner', 'done', 'dropped']

/** The two tools (5.4). Small on purpose: every session that has the server carries this text. */
export const TOOLS = [
  {
    name: 'threads',
    description:
      "Read the board's threads: list (open threads, one line each), show (a thread's head and its last entries), changes (what moved since you last asked). Returns the lines `board thread` prints.",
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'show', 'changes'] },
        key: { type: 'string', description: 'A thread key like atlas-12 (show)' },
        mine: { type: 'boolean', description: 'list: the threads you created, were given or watch' },
        lane: { type: 'string', description: 'list: a lane id' },
        last: { type: 'integer', minimum: 0, description: 'show: the last n entries' },
        since: { type: 'integer', minimum: 0, description: 'show: the entries after number n' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'thread',
    description:
      "Write to the board's threads: new (a thread), post (progress, status, summary, files), ask (a question for the owner), set (title, assignee, parent), watch. Returns the one line `board thread` prints.",
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['new', 'post', 'ask', 'set', 'watch'] },
        key: { type: 'string', description: 'The thread key (all but new)' },
        title: { type: 'string', description: 'new, set: one line, 80 characters at most' },
        text: { type: 'string', description: 'post: a note; ask: the question' },
        status: { type: 'string', enum: STATUSES },
        summary: { type: 'string', description: 'post: where it stands, one line' },
        to: { type: 'string', description: 'new, set: the session it goes to (none to clear, set)' },
        parent: { type: 'string', description: 'new, set: the parent thread key' },
        files: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'post: paths of reports' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
] as const

/** A call's refusal before the command runs: the argument named, and why. */
class Bad extends Error {}

const str = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Bad(`${name} must be a string`)
  return v
}

/** A key, lane, session or parent: a word, never one that would read as a flag. */
const word = (v: unknown, name: string): string | undefined => {
  const s = str(v, name)?.trim()
  if (s === undefined || s === '') return undefined
  if (s.startsWith('-') || /\s/.test(s)) throw new Bad(`${name}: "${s}" is not a ${name}`)
  return s
}

const count = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Bad(`${name} must be a whole number`)
  return String(v)
}

const need = (v: string | undefined, name: string, op: string): string => {
  if (v === undefined) throw new Bad(`${op} needs ${name}`)
  return v
}

/** `board thread …` for a call of `threads`. */
export function readArgv(a: Record<string, unknown>): string[] {
  const op = a.op
  if (op === 'list') {
    const lane = word(a.lane, 'lane')
    return ['list', ...(a.mine === true ? ['--mine'] : []), ...(lane ? ['--lane', lane] : [])]
  }
  if (op === 'show') {
    const key = need(word(a.key, 'key'), 'key', 'show')
    const last = count(a.last, 'last')
    const since = count(a.since, 'since')
    return ['show', key, ...(last ? ['--last', last] : []), ...(since ? ['--since', since] : [])]
  }
  if (op === 'changes') return ['changes']
  throw new Bad('op is list, show or changes')
}

/** `board thread …` for a call of `thread`; text goes after a lone `--`, so it never reads as a flag. */
export function writeArgv(a: Record<string, unknown>): string[] {
  const op = a.op
  const key = word(a.key, 'key')
  const status = str(a.status, 'status')
  if (status !== undefined && !STATUSES.includes(status)) throw new Bad(`status is ${STATUSES.join(', ')}`)
  const to = word(a.to, 'to')
  const parent = word(a.parent, 'parent')
  const text = str(a.text, 'text')
  const title = str(a.title, 'title')
  const summary = str(a.summary, 'summary')
  const files = a.files === undefined ? [] : a.files
  if (!Array.isArray(files) || !files.every(f => typeof f === 'string')) throw new Bad('files must be paths')
  if (op === 'new') {
    if (!title?.trim()) throw new Bad('new needs a title')
    return [
      'new',
      ...(parent ? ['--parent', parent] : []),
      ...(to ? ['--to', to] : []),
      ...(status === 'doing' && !to ? ['--doing'] : []),
      '--',
      title,
    ]
  }
  if (op === 'post')
    return [
      'post',
      need(key, 'key', 'post'),
      ...(status ? ['--status', status] : []),
      ...(summary !== undefined ? ['--summary', summary] : []),
      ...files.flatMap(f => ['--file', f as string]),
      ...(text ? ['--', text] : []),
    ]
  if (op === 'ask') {
    if (!text?.trim()) throw new Bad('ask needs text: the question')
    return ['ask', need(key, 'key', 'ask'), '--', text]
  }
  if (op === 'set')
    return [
      'set',
      need(key, 'key', 'set'),
      ...(title !== undefined ? ['--title', title] : []),
      ...(to ? ['--assignee', to] : []),
      ...(parent ? ['--parent', parent] : []),
    ]
  if (op === 'watch') return ['watch', ...(key ? [key] : ['--mine'])]
  throw new Bad('op is new, post, ask, set or watch')
}

interface Request {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const PROTOCOL = '2025-06-18'

/** The server: one line in, the line to write back (null for a notification or nothing to say). */
export function createMcpServer(o: McpOptions): { handle(line: string): Promise<string | null> } {
  const reply = (id: unknown, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result })
  const error = (id: unknown, code: number, message: string): string =>
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  async function call(params: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
    const p = isObj(params) ? params : {}
    const args = isObj(p.arguments) ? p.arguments : {}
    let argv: string[]
    try {
      if (p.name === 'threads') argv = readArgv(args)
      else if (p.name === 'thread') argv = writeArgv(args)
      else throw new Bad(`no tool "${String(p.name)}": threads or thread`)
    } catch (err) {
      if (err instanceof Bad) return { content: [{ type: 'text', text: err.message }], isError: true }
      throw err
    }
    const r = await o.run(argv)
    const text = [...r.out, ...r.err].join('\n').trim() || (r.code === 0 ? 'ok' : 'failed')
    return { content: [{ type: 'text', text }], ...(r.code !== 0 && { isError: true as const }) }
  }

  return {
    async handle(line) {
      if (!line.trim()) return null
      let req: Request
      try {
        req = JSON.parse(line) as Request
      } catch {
        return error(null, -32700, 'parse error')
      }
      if (!isObj(req) || typeof req.method !== 'string')
        return error(isObj(req) ? req.id : null, -32600, 'invalid request')
      const notification = !('id' in req)
      const id = req.id
      try {
        switch (req.method) {
          case 'initialize': {
            const asked = isObj(req.params) ? req.params.protocolVersion : undefined
            return reply(id, {
              protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
              capabilities: { tools: {} },
              serverInfo: { name: 'agent-board', version: o.version },
            })
          }
          case 'notifications/initialized':
          case 'notifications/cancelled':
            return null
          case 'ping':
            return notification ? null : reply(id, {})
          case 'tools/list':
            return reply(id, { tools: TOOLS })
          case 'tools/call':
            return reply(id, await call(req.params))
          default:
            return notification ? null : error(id, -32601, `no method ${req.method}`)
        }
      } catch (err) {
        return error(id, -32603, err instanceof Error ? err.message : String(err))
      }
    },
  }
}

/**
 * Serves the lines of `input` one by one, in order, writing each answer as one line. Ends when
 * the input does.
 */
export async function serve(
  server: { handle(line: string): Promise<string | null> },
  input: AsyncIterable<string | Uint8Array>,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buf = ''
  const take = async (line: string): Promise<void> => {
    const answer = await server.handle(line.replace(/\r$/, ''))
    if (answer !== null) write(`${answer}\n`)
  }
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let i = buf.indexOf('\n')
    while (i >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      await take(line)
      i = buf.indexOf('\n')
    }
  }
  if (buf.trim()) await take(buf)
}
