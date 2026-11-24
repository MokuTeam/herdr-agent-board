// A node's calls to its master (#508, docs/design/nodes 5, 6.2, 10 item 5): `board thread` in a
// session on this node hands its command to this board (`POST /api/node/call`, server/routes/node.ts,
// on this computer's own listener only), which keeps it in the outbox (adapters/node-outbox.ts) and
// waits; the master, which holds `GET /api/node/uplink` open on the door, takes each call, runs it
// and posts the result to `POST /api/node/uplink/<id>`; the waiting command gets it and prints it.
//
// - A write that can wait (core/node-uplink.ts KEPT_SUBS) waits KEPT_MS for the result, then the
//   command says it is kept; the call stays in the outbox until a master answers it, once (the
//   master remembers the ids it ran, services/nodes/uplink.ts).
// - Any other call waits READ_MS, and fails at once when no master's stream is open: it is not
//   kept, so nobody waits for a master that is not there.
// - A stream that opens gets every call waiting first, oldest first, then each new one; a ping
//   every PING_MS keeps it open through the forward.
// - A file a call names is copied into the outbox as it is now and registered by its number, with
//   its size and SHA-256; the master asks for it by that number (`GET /api/node/uplink/<id>/file/<n>`)
//   and never names a path.
// - A call that is not kept and was left in the outbox by a board that stopped is dropped when a
//   stream opens: its command is long gone, and a read is not run for nobody.
// Made by server/app.ts only once config.json has `node`.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { createOutbox, type Outbox, type OutboxCall } from '../../adapters/node-outbox.ts'
import { knobMs } from '../../adapters/pacing.ts'
import {
  fileTooBig,
  isCallId,
  isKeptCall,
  type UplinkCall,
  type UplinkResult,
  type UplinkSelf,
  uplinkCallOf,
  uplinkResultOf,
} from '../../core/node-uplink.ts'
import { FILES_MAX } from '../../core/work-threads.ts'

/** A write waits this long for the master before the command says it is kept. */
export const KEPT_MS = 20_000
/** Any other call waits this long while a master's stream is open. */
export const READ_MS = 10_000
const PING_MS = 20_000

/** A call as the stream carries it, as the board's other streams name an event (server/sse.ts). */
const callEvent = (c: UplinkCall): string => `event: call\ndata: ${JSON.stringify(c)}\n\n`

/** What `POST /api/node/call` answers: the master's result, kept for later, or not reachable. */
export type CallAnswer =
  | ({ state: 'answered' } & UplinkResult)
  | { state: 'kept'; id: string }
  | { state: 'unreachable' }

export interface NodeUplink {
  /** `POST /api/node/call`: a command of a session here, answered once the master has, or after the wait. */
  call(raw: unknown): Promise<{ status: number; body: unknown }>
  /** `GET /api/node/uplink`: the calls waiting, then each new one. */
  stream(req: Request): Response
  /** `GET /api/node/uplink/<id>/file/<n>`: a file the call registered, by its number. */
  file(id: string, n: number): Response
  /** `POST /api/node/uplink/<id>`: the master's result. */
  answer(id: string, raw: unknown): { status: number; body: unknown }
  close(): void
}

export interface NodeUplinkOptions {
  outbox?: Outbox
  log(text: string): void
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const answered = (r: UplinkResult): CallAnswer => ({ state: 'answered', ...r })
const failed = (line: string): CallAnswer => answered({ code: 1, out: [], err: [line] })
const bad = (error: string) => ({ status: 400, body: { error } })

/** What goes up the link: the call without where its files are here. */
const publicOf = (c: OutboxCall): UplinkCall => ({
  id: c.id,
  cmd: c.cmd,
  argv: c.argv,
  session: c.session,
  lane: c.lane,
  files: c.files.map(({ n, name, size, sha256 }) => ({ n, name, size, sha256 })),
  ...(c.self && { self: c.self }),
})

export function createNodeUplink(o: NodeUplinkOptions): NodeUplink {
  const outbox = o.outbox ?? createOutbox()
  const encoder = new TextEncoder()
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const waiters = new Map<string, Set<(r: UplinkResult) => void>>()
  let ping: ReturnType<typeof setInterval> | null = null
  let closed = false

  function write(client: ReadableStreamDefaultController<Uint8Array>, text: string): void {
    try {
      client.enqueue(encoder.encode(text))
    } catch {
      // Closed under us: the master went between two calls.
      leave(client)
    }
  }
  function leave(client: ReadableStreamDefaultController<Uint8Array>): void {
    clients.delete(client)
    if (!clients.size && ping) {
      clearInterval(ping)
      ping = null
    }
  }

  /** The result, or null after `ms`. */
  function wait(id: string, ms: number): Promise<UplinkResult | null> {
    return new Promise(resolve => {
      const mine = waiters.get(id) ?? new Set<(r: UplinkResult) => void>()
      waiters.set(id, mine)
      const done = (r: UplinkResult | null): void => {
        clearTimeout(timer)
        mine.delete(take)
        if (!mine.size && waiters.get(id) === mine) waiters.delete(id)
        resolve(r)
      }
      const take = (r: UplinkResult): void => done(r)
      const timer = setTimeout(() => done(null), ms)
      mine.add(take)
    })
  }

  /** The files a call names, copied and registered by their number; or why not, in the words a local post uses. */
  function register(id: string, paths: string[]): { files: OutboxCall['files'] } | { error: string } {
    if (paths.length > FILES_MAX) return { error: `${paths.length} files; ${FILES_MAX} at most` }
    const files: OutboxCall['files'] = []
    for (const [n, path] of paths.entries()) {
      let size: number
      try {
        const st = statSync(path)
        if (!st.isFile()) throw new Error('not a file')
        size = st.size
      } catch {
        return { error: `${path}: no such file` }
      }
      const big = fileTooBig(path, size)
      if (big) return { error: big }
      const bytes = readFileSync(path)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      files.push({ n, name: basename(path) || 'file', size: bytes.length, sha256, path: outbox.copy(id, n, bytes) })
    }
    return { files }
  }

  async function call(raw: unknown): Promise<{ status: number; body: unknown }> {
    if (closed) return { status: 503, body: { error: 'node' } }
    if (!isObject(raw)) return bad('body')
    const { id: given, cmd, argv, session, lane, files, self } = raw
    if (!isText(cmd) || !Array.isArray(argv) || !argv.every(isText) || !isText(session)) return bad('call')
    if (lane !== null && lane !== undefined && !isText(lane)) return bad('lane')
    if (files !== undefined && (!Array.isArray(files) || !files.every(isText))) return bad('files')
    if (given !== undefined && !isCallId(given)) return bad('id')
    let validatedSelf: UplinkSelf | undefined
    if (self !== undefined) {
      if ((cmd !== 'thread' && cmd !== 'threads') || argv[0] !== 'verdict') return bad('self')
      if (!isObject(self)) return bad('self')
      const hasKey = Object.hasOwn(self, 'key') && self.key !== undefined
      const hasWhy = Object.hasOwn(self, 'why') && self.why !== undefined
      if (hasKey === hasWhy) return bad('self')
      if (hasKey) {
        if (!isText(self.key) || !self.key) return bad('self')
        validatedSelf = { key: self.key }
      } else {
        if (!isText(self.why) || !self.why) return bad('self')
        validatedSelf = { why: self.why }
      }
    }
    // Kept or not by what the command is, not by what the caller says.
    const keep = isKeptCall(cmd, argv)
    if (!keep && !clients.size) return { status: 200, body: { state: 'unreachable' } satisfies CallAnswer }
    const id = given ?? randomUUID()
    // The same call again (a command that tried twice): it waits for the one already kept.
    if (!outbox.read(id)) {
      const got = register(id, (files as string[] | undefined) ?? [])
      if ('error' in got) {
        outbox.remove(id)
        return { status: 200, body: failed(got.error) }
      }
      const kept: OutboxCall = {
        id,
        cmd,
        argv: argv as string[],
        session,
        lane: (lane as string | null | undefined) ?? null,
        files: got.files,
        ...(validatedSelf && { self: validatedSelf }),
        keep,
        at: Date.now(),
      }
      // What the master would not take (too many or too long arguments, a session's key it cannot
      // read) is refused now, not kept to be refused later where nobody reads it.
      if (!uplinkCallOf(publicOf(kept))) {
        outbox.remove(id)
        return {
          status: 200,
          body: failed("the board's computer does not take this call: its words are too many or too long"),
        }
      }
      // Written before the command waits: a board that stops now still has it.
      outbox.write(kept)
      const event = callEvent(publicOf(kept))
      for (const client of [...clients]) write(client, event)
    }
    const verdict = (cmd === 'thread' || cmd === 'threads') && argv[0] === 'verdict'
    const ms = keep || verdict ? knobMs('BOARD_NODE_KEPT_MS', KEPT_MS) : knobMs('BOARD_NODE_READ_MS', READ_MS)
    const result = await wait(id, ms)
    if (result) return { status: 200, body: answered(result) }
    if (keep) return { status: 200, body: { state: 'kept', id } satisfies CallAnswer }
    // Not kept: no master takes it later.
    outbox.remove(id)
    return { status: 200, body: { state: 'unreachable' } satisfies CallAnswer }
  }

  return {
    call,
    stream(req) {
      let client: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          if (closed) return controller.close()
          write(controller, ': calls\n\n')
          // What waits goes first, oldest first; a read whose command is gone is not sent.
          for (const c of outbox.list()) {
            if (!c.keep && !waiters.has(c.id)) outbox.remove(c.id)
            else write(controller, callEvent(publicOf(c)))
          }
          clients.add(controller)
          ping ??= setInterval(
            () => {
              for (const c of [...clients]) write(c, ': ping\n\n')
            },
            knobMs('BOARD_EVENTS_PING_MS', PING_MS),
          )
        },
        cancel: () => {
          if (client) leave(client)
        },
      })
      req.signal.addEventListener('abort', () => client && leave(client), { once: true })
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
      })
    },
    file(id, n) {
      const c = isCallId(id) ? outbox.read(id) : null
      const f = c?.files.find(x => x.n === n)
      const none = new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
      if (!f) return none
      let bytes: Buffer
      try {
        bytes = readFileSync(f.path)
      } catch {
        return none
      }
      return new Response(new Uint8Array(bytes), {
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
      })
    },
    answer(id, raw) {
      const result = uplinkResultOf(raw)
      if (!result) return bad('result')
      if (!isCallId(id) || !outbox.read(id)) return { status: 404, body: { error: 'call' } }
      outbox.remove(id)
      const takers = [...(waiters.get(id) ?? [])]
      for (const take of takers) take(result)
      // A kept call that failed, its command long gone: the log is where it is read.
      if (!takers.length && result.code !== 0)
        o.log(`node uplink: call ${id} came back with exit ${result.code}: ${result.err[0] ?? ''}`)
      return { status: 200, body: { ok: true } }
    },
    close() {
      closed = true
      if (ping) clearInterval(ping)
      ping = null
      for (const c of clients) {
        try {
          c.close()
        } catch {}
      }
      clients.clear()
    },
  }
}
