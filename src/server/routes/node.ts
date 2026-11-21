// The master door's own routes on a node (#498, #504, #506, #508, docs/design/nodes 6.2): served by
// the door (server/node-listener.ts) only, never by the board's route table, so no other listener has
// them. The status, a start from the master, the profile bundle's three (services/node/bundle.ts):
// what the node has, a blob, the commit; and the uplink's three (services/node/uplink.ts): the calls'
// stream, a file a call names, the master's result. The door has checked the Host, the Origin, the
// master's token and X-Board before they run. `POST /api/node/call`, the other end of the uplink, is
// this computer's own: nodeCallRoutes, which only the web board's own listener serves (server/app.ts).
import { MAX_BLOB_BYTES } from '../../adapters/bundle-files.ts'
import type { Answer, NodeBundle } from '../../services/node/bundle.ts'
import type { NodeLaunchAnswer } from '../../services/node/launch.ts'
import type { NodeUplink } from '../../services/node/uplink.ts'
import { json, type Route } from '../http.ts'

export interface NodeDoorSources {
  /** `GET /api/node/status` (services/node/status.ts); null once `node` left config.json. */
  status(): Promise<unknown>
  /** `POST /api/node/launch` (services/node/launch.ts). */
  launch(body: unknown): Promise<NodeLaunchAnswer>
  /** `/api/node/bundle/...` (services/node/bundle.ts). */
  bundle: NodeBundle
  /** The uplink's stream, files and results (services/node/uplink.ts). */
  uplink: Pick<NodeUplink, 'stream' | 'file' | 'answer'>
}

/** A commit's manifest, at most this many bytes of JSON. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

const answer = (a: Answer): Response => json(a.status, a.body)

/** A body of at most `max` bytes, or null when it is longer: counted as it comes, never read whole first. */
async function bytesUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  const told = Number(req.headers.get('content-length'))
  if (Number.isFinite(told) && told > max) return null
  if (!req.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req.body) {
    size += chunk.length
    if (size > max) return null
    chunks.push(chunk)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** A call's result: more than the board's usual 192 KB of JSON (a thread shown whole), and still bounded. */
const MAX_RESULT_BYTES = 8 * 1024 * 1024

export function nodeDoorRoutes(o: NodeDoorSources): Route[] {
  const bundle = o.bundle
  return [
    {
      method: 'GET',
      path: '/api/node/status',
      async handle() {
        const status = await o.status()
        // `node` went from config.json meanwhile: this door is closing.
        return status === null ? json(503, { error: 'node' }) : json(200, status)
      },
    },
    {
      method: 'POST',
      path: '/api/node/launch',
      async handle(_req, ctx) {
        const r = await o.launch(await ctx.rawBody())
        return json(r.status, r.body)
      },
    },
    {
      method: 'GET',
      path: /^\/api\/node\/bundle\/([^/]+)$/,
      handle: (_req, ctx) => answer(bundle.have(ctx.params[0] ?? '')),
    },
    {
      method: 'PUT',
      path: /^\/api\/node\/bundle\/([^/]+)\/blob\/([0-9a-f]{64})$/,
      async handle(req, ctx) {
        const bytes = await bytesUpTo(req, MAX_BLOB_BYTES)
        if (!bytes) return json(413, { error: 'too-big' })
        return answer(bundle.putBlob(ctx.params[0] ?? '', ctx.params[1] ?? '', bytes))
      },
    },
    {
      method: 'POST',
      path: /^\/api\/node\/bundle\/([^/]+)\/commit$/,
      async handle(req, ctx) {
        // A manifest of a few thousand files is more than the board's usual 192 KB of JSON.
        const bytes = await bytesUpTo(req, MAX_MANIFEST_BYTES)
        if (!bytes) return json(413, { error: 'bundle' })
        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          return json(400, { error: 'bundle' })
        }
        return answer(await bundle.commit(ctx.params[0] ?? '', body))
      },
    },
    {
      method: 'GET',
      path: '/api/node/uplink',
      handle: req => o.uplink.stream(req),
    },
    {
      method: 'GET',
      path: /^\/api\/node\/uplink\/([A-Za-z0-9_-]{1,64})\/file\/(\d{1,2})$/,
      handle: (_req, ctx) => o.uplink.file(ctx.params[0] ?? '', Number(ctx.params[1])),
    },
    {
      method: 'POST',
      path: /^\/api\/node\/uplink\/([A-Za-z0-9_-]{1,64})$/,
      async handle(req, ctx) {
        const bytes = await bytesUpTo(req, MAX_RESULT_BYTES)
        if (!bytes) return json(413, { error: 'too-big' })
        let body: unknown = null
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {}
        const r = o.uplink.answer(ctx.params[0] ?? '', body)
        return json(r.status, r.body)
      },
    },
  ]
}

/**
 * `POST /api/node/call` (#508): `board thread` in a session of this node hands its command here
 * (entrypoints/thread-cli.ts). Served by the web board's own listener only: not on the door, not
 * to a phone, not through the tunnel.
 */
export function nodeCallRoutes(uplink: Pick<NodeUplink, 'call'>): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/node/call',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const r = await uplink.call(await ctx.rawBody())
        return json(r.status, r.body)
      },
    },
  ]
}
