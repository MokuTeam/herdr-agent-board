// The master door's own routes on a node (#498, #504, #506, #507, #508, docs/design/nodes 6.2): served
// by the door (server/node-listener.ts) only, never by the board's route table, so no other listener
// has them. The status, a start from the master, the profile bundle's three (services/node/bundle.ts):
// what the node has, a blob, the commit; the uplink's three (services/node/uplink.ts): the calls'
// stream, a file a call names, the master's result; and a secret the owner gives one of the node's
// sinks (services/secrets.ts giveSecret); the master's leave when it revokes this node (#510); and
// the plugin's update to the master's commit, its archive and then the update (#590).
// The door has checked the Host, the Origin, the master's token and X-Board before they run.
// `POST /api/node/call`, the other end of the uplink, is this computer's own: nodeCallRoutes,
// which only the web board's own listener serves (server/app.ts).
import { MAX_BLOB_BYTES } from '../../adapters/bundle-files.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import type { Answer, NodeBundle } from '../../services/node/bundle.ts'
import type { NodeLaunchAnswer } from '../../services/node/launch.ts'
import type { NodeUpdate } from '../../services/node/update.ts'
import type { NodeUplink } from '../../services/node/uplink.ts'
import { json, type Route } from '../http.ts'
import { doorMaster } from '../node-listener.ts'

export interface NodeDoorSources {
  /** `GET /api/node/status` (services/node/status.ts); null once `node` left config.json. */
  status(): Promise<unknown>
  /** `POST /api/node/launch` (services/node/launch.ts). */
  launch(body: unknown): Promise<NodeLaunchAnswer>
  /** `/api/node/bundle/...` (services/node/bundle.ts). */
  bundle: NodeBundle
  /** The uplink's stream, files and results (services/node/uplink.ts). */
  uplink: Pick<NodeUplink, 'stream' | 'file' | 'answer'>
  /** `POST /api/node/sink/<id>`: `{ values, fingerprint }` written to that sink (services/secrets.ts giveSecret). */
  sink(id: string, body: Record<string, unknown>): Promise<Answer>
  /**
   * `POST /api/node/leave` (#510, design 11.4): the node's awake sessions put to sleep when `sleep`,
   * then the master `master` forgotten (adapters/node-store.ts forget), which ends its streams.
   */
  leave?(master: string, sleep: boolean): Promise<{ slept: number; kept: number }>
  /** `PUT /api/node/update/blob` and `POST /api/node/update` (#590, services/node/update.ts). */
  update?: Pick<NodeUpdate, 'blob' | 'update'>
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
  const leave = o.leave
  const update = o.update
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
      method: 'POST',
      path: /^\/api\/node\/sink\/([a-z0-9][a-z0-9_-]{0,39})$/,
      async handle(_req, ctx) {
        // The values come here and go straight to the sink: no answer holds one, nothing logs the body.
        let body: unknown
        try {
          body = await ctx.rawBody()
        } catch {
          return json(400, { ok: false, error: t('secret.err.values') })
        }
        try {
          return answer(await o.sink(ctx.params[0] ?? '', isRecord(body) ? body : {}))
        } catch {
          // whatever threw may have held a value in its message: none of it goes out or into the log
          return json(500, { ok: false, error: t('secret.err.internal') })
        }
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
    ...(leave ? [leaveRoute(leave)] : []),
    ...(update ? updateRoutes(update) : []),
  ]
}

/** The plugin's archive as it comes, never read whole first, then the update itself (#590). */
function updateRoutes(update: NonNullable<NodeDoorSources['update']>): Route[] {
  return [
    {
      method: 'PUT',
      path: '/api/node/update/blob',
      async handle(req) {
        const told = Number(req.headers.get('content-length'))
        return answer(await update.blob(req.body, Number.isFinite(told) && told > 0 ? told : null))
      },
    },
    {
      method: 'POST',
      path: '/api/node/update',
      async handle(_req, ctx) {
        let body: unknown = null
        try {
          body = await ctx.rawBody()
        } catch {}
        return answer(await update.update(body))
      },
    },
  ]
}

/** `POST /api/node/leave` (#510): `{ sleep?: true }`, answered once the calling master is forgotten. */
function leaveRoute(leave: NonNullable<NodeDoorSources['leave']>): Route {
  return {
    method: 'POST',
    path: '/api/node/leave',
    async handle(req, ctx) {
      const master = doorMaster(req)
      if (!master) return json(401, { error: 'token' })
      const body = await ctx.body()
      const r = await leave(master.id, body.sleep === true)
      return json(200, { ok: true, ...r })
    },
  }
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
