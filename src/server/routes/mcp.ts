// `/mcp` (#813, entrypoints/mcp-http.ts): the board's MCP over Streamable HTTP, stateless: each POST
// is one JSON-RPC message, answered with one JSON body (202 and none for a notification); no
// session id, no event stream (GET and DELETE: 405).
//
// Only this computer's own clients: refused through a remote listener (Tailscale, serve, tunnel), a
// relayed request (both mark it remote) and any peer that is not loopback; the master door never
// lists it (core/node-door.ts). A browser's Origin must be the board's own, and the body must say it
// is JSON, which a page of another site cannot send without a CORS preflight this server never
// grants. Who calls comes from X-Board-Pane or X-Board-Session, read on every request.
import { authenticateOwnerService } from '../../adapters/owner-services.ts'
import { isOwnerServiceKey, OWNER_SERVICE_HEADER } from '../../core/owner-services.ts'
import type { Caller, HttpMcp } from '../../entrypoints/mcp-http.ts'
import { json, type Route } from '../http.ts'

/** The largest message taken: a brief and a thread post fit many times over. */
const BODY_MAX = 1 << 20

/** A herdr pane id as herdr gives it (w5:p2P, 3, p_1). */
const PANE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}$/
/** A session key: a UUID, pane-<id>, a pi session's file; one line, never a flag. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a key is one line of printable characters
const SESSION = /^(?!-)[^\x00-\x1f\x7f]{1,512}$/

export const isLoopback = (peer: string): boolean =>
  peer === '' || peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.')

const rpcError = (status: number, message: string): Response =>
  json(status, { jsonrpc: '2.0', id: null, error: { code: -32600, message } })

/**
 * The session the board knows by this pane or key: its folder, its Claude folder, and its pane when
 * it runs on this computer.
 */
export type FindCaller = (ref: {
  pane?: string
  session?: string
}) => { pane?: string; cwd?: string; configDir?: string } | null

/** Who the request says it is from; a string when what it says cannot be read. */
export function callerOf(req: Request, find: FindCaller): Caller | null | string {
  const pane = req.headers.get('x-board-pane')?.trim() || undefined
  const session = req.headers.get('x-board-session')?.trim() || undefined
  if (pane !== undefined && !PANE.test(pane)) return 'X-Board-Pane is not a herdr pane id'
  if (session !== undefined && !SESSION.test(session)) return 'X-Board-Session is not a session key'
  if (pane === undefined && session === undefined) return null
  const known = find({ ...(pane && { pane }), ...(session && { session }) })
  const ownPane = pane ?? known?.pane
  return {
    ...(ownPane && { pane: ownPane }),
    ...(session && { session }),
    ...(known?.cwd && { cwd: known.cwd }),
    ...(known?.configDir && { configDir: known.configDir }),
  }
}

async function bodyText(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > BODY_MAX) return null
  if (!req.body) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for await (const chunk of req.body) {
    size += chunk.length
    if (size > BODY_MAX) return null
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

export function mcpRoutes(o: { mcp: HttpMcp; find: FindCaller; ownerServicesEnabled?: () => boolean }): Route[] {
  return [
    {
      method: 'ANY',
      path: '/mcp',
      async handle(req, ctx) {
        // The network side never reaches it, nor names a caller.
        if (ctx.remote || !isLoopback(ctx.peer())) return json(404, { error: 'not found' })
        const foreign = ctx.refuse('origin')
        if (foreign) return foreign
        if (req.method !== 'POST') {
          const res = json(405, { error: 'method' })
          res.headers.set('allow', 'POST')
          return res
        }
        if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? ''))
          return rpcError(415, 'Content-Type must be application/json')
        const token = req.headers.get(OWNER_SERVICE_HEADER)
        if (token !== null && o.ownerServicesEnabled?.() === false)
          return rpcError(404, 'Owner services use the master board')
        const session = req.headers.get('x-board-session')
        if (token === null && isOwnerServiceKey(session?.trim()))
          return rpcError(401, 'An owner service token is required')
        if (token !== null && (session !== null || req.headers.has('x-board-pane')))
          return rpcError(400, 'The owner service token supplies the caller identity')
        const caller = token === null ? callerOf(req, o.find) : null
        if (typeof caller === 'string') return rpcError(400, caller)
        const text = await bodyText(req)
        if (text === null) return rpcError(413, 'the message is too large')
        const service = token === null ? null : authenticateOwnerService(token)
        if (token !== null && !service) return rpcError(401, 'Invalid owner service token')
        const answer = await o.mcp.handle(text, service ? { session: service.key, ownerService: service } : caller)
        if (answer === null) return new Response(null, { status: 202 })
        return new Response(answer, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    },
  ]
}
