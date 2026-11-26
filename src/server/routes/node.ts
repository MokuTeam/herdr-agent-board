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
import { RELAY_ANSWER_MAX, RELAY_CHUNK_MAX } from '../../core/master-relay.ts'
import {
  MAX_BRIDGE_RESPONSE_BYTES,
  MAX_BRIDGE_STREAM_BATCH_BYTES,
  MAX_CALL_FILES_REQUEST_BYTES,
  MAX_MCP_BODY_BYTES,
  MAX_STDIN_LINE_BYTES,
} from '../../core/pilot-call.ts'
import type { MoveIn } from '../../services/move-in.ts'
import type { MoveOut } from '../../services/move-out.ts'
import type { Answer, NodeBundle } from '../../services/node/bundle.ts'
import type { NodeDesk } from '../../services/node/desk.ts'
import type { NodeHandover } from '../../services/node/handover.ts'
import type { NodeLaunchAnswer } from '../../services/node/launch.ts'
import type { NodeMasterFlags } from '../../services/node/master-flags.ts'
import type { MasterRelay } from '../../services/node/master-relay.ts'
import type { NodePilotBridge } from '../../services/node/pilot-bridge.ts'
import type { NodePilotCall } from '../../services/node/pilot-call.ts'
import type { NodeSecrets } from '../../services/node/secrets.ts'
import type { NodeTelegram } from '../../services/node/telegram.ts'
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
  /** `POST /api/node/bundle/<profile>/secrets` (#604, services/node/secrets.ts). */
  secrets?: NodeSecrets
  /**
   * Whether this node keeps its own profiles (#802, `node.ownProfiles`): every `/api/node/bundle/...`
   * is refused (409 `own-profiles`), so no master's bundle or secrets are written here. Absent: false.
   */
  ownProfiles?: () => boolean
  /** The uplink's stream, files and results (services/node/uplink.ts). */
  uplink: Pick<NodeUplink, 'stream' | 'file' | 'answer'>
  /** `POST /api/node/sink/<id>`: `{ values, fingerprint }` written to that sink (services/secrets.ts giveSecret). */
  sink(id: string, body: Record<string, unknown>): Promise<Answer>
  /**
   * `POST /api/node/leave` (#510, design 11.4): the node's awake sessions put to sleep when `sleep`,
   * then the master `master` forgotten (adapters/node-store.ts forget), which ends its streams.
   */
  leave?(
    master: string,
    sleep: boolean,
  ): Promise<{
    slept: number
    kept: number
    takenOut?: { env: string[]; files: string[]; identity: boolean; logins: string[]; failed?: string[] }
  }>
  /** `PUT /api/node/update/blob` and `POST /api/node/update` (#590, services/node/update.ts). */
  update?: Pick<NodeUpdate, 'blob' | 'update'>
  /** `/api/node/move/...` (#616): this board's halves of a session moved to or from another device. */
  move?: { out: MoveOut; in: MoveIn }
  /** `/api/node/pilot-call/...` (#618): MokuPilot call agent running on this node. */
  pilotCall?: NodePilotCall
  /** `/api/node/pilot-bridge...` (#700): reverse bridge for MokuPilot running on this node. */
  pilotBridge?: NodePilotBridge
  /** `/api/node/master-relay...` (#764): the stream the master holds for this node's requests to it, and their answers. */
  masterRelay?: MasterRelay
  /** `POST /api/node/master-flags` (#775, services/node/master-flags.ts): the master's feature flags. */
  masterFlags?: Pick<NodeMasterFlags, 'take'>
  /** `GET /api/node/desk` and `POST /api/node/desk-toast` (#788, services/node/desk.ts): the owner's desk. */
  desk?: NodeDesk
  /** `POST /api/node/relay-key` (#513): activates a staged fresh relay dial key after claim. */
  relayKey?(publicKey: string): Promise<Answer>
  /** `POST /api/node/telegram` (#701): routes a Telegram topic batch on this node. */
  telegram?: Pick<NodeTelegram, 'route'>
  /** `/api/node/handover/...` (#697): guided master handover target and peer-node routes. */
  handover?: NodeHandover
}

/** The secrets of one profile's bundle, at most this many bytes of JSON. */
export const MAX_SECRETS_BYTES = 4 * 1024 * 1024

/** A commit's manifest, at most this many bytes of JSON. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

const answer = (a: Answer): Response => json(a.status, a.body)
/** A node with its own profiles refuses a master's bundle and its secrets (#802). */
const ownProfiles = (): Response => json(409, { error: 'own-profiles' })

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
  // A node with its own profiles takes no bundle (#802): refused before anything is read or written.
  const own = (): boolean => o.ownProfiles?.() === true
  const secrets = o.secrets
  const leave = o.leave
  const update = o.update
  const telegram = o.telegram
  const relayKey = o.relayKey
  return [
    ...(o.move ? moveRoutes(o.move) : []),
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
      handle: (_req, ctx) => (own() ? ownProfiles() : answer(bundle.have(ctx.params[0] ?? ''))),
    },
    {
      method: 'PUT',
      path: /^\/api\/node\/bundle\/([^/]+)\/blob\/([0-9a-f]{64})$/,
      async handle(req, ctx) {
        if (own()) return ownProfiles()
        const bytes = await bytesUpTo(req, MAX_BLOB_BYTES)
        if (!bytes) return json(413, { error: 'too-big' })
        return answer(bundle.putBlob(ctx.params[0] ?? '', ctx.params[1] ?? '', bytes))
      },
    },
    {
      method: 'POST',
      path: /^\/api\/node\/bundle\/([^/]+)\/commit$/,
      async handle(req, ctx) {
        if (own()) return ownProfiles()
        // A manifest of a few thousand files is more than the board's usual 192 KB of JSON.
        const bytes = await bytesUpTo(req, MAX_MANIFEST_BYTES)
        if (!bytes) return json(413, { error: 'bundle' })
        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          return json(400, { error: 'bundle' })
        }
        return answer(await bundle.commit(ctx.params[0] ?? '', body, doorMaster(req)?.id))
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
    ...(secrets ? [secretsRoute(secrets, own)] : []),
    ...(leave ? [leaveRoute(leave)] : []),
    ...(update ? updateRoutes(update) : []),
    ...(o.pilotCall ? pilotCallDoorRoutes(o.pilotCall) : []),
    ...(o.pilotBridge ? pilotBridgeDoorRoutes(o.pilotBridge) : []),
    ...(o.masterRelay ? masterRelayDoorRoutes(o.masterRelay) : []),
    ...(o.masterFlags ? [masterFlagsDoorRoute(o.masterFlags)] : []),
    ...(o.desk ? deskDoorRoutes(o.desk) : []),
    ...(relayKey
      ? [
          {
            method: 'POST' as const,
            path: '/api/node/relay-key',
            async handle(req: Request) {
              const body = await jsonUpTo(req, 4096)
              if (!isRecord(body) || typeof body.publicKey !== 'string') return json(400, { ok: false, error: 'body' })
              return answer(await relayKey(body.publicKey))
            },
          },
        ]
      : []),
    ...(telegram
      ? [
          {
            method: 'POST' as const,
            path: '/api/node/telegram',
            async handle(req: Request) {
              const body = await jsonUpTo(req, 512 * 1024)
              if (body === undefined) return json(413, { ok: false, error: 'too-big' })
              return answer(await telegram.route(body))
            },
          },
        ]
      : []),
    ...(o.handover ? handoverDoorRoutes(o.handover) : []),
  ]
}

const HANDOVER_JSON_MAX = 2 * 1024 * 1024

function handoverDoorRoutes(h: NodeHandover): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/node/handover/check',
      handle: async (_req, ctx) => answer(await h.check(ctx.url.searchParams.get('masterHost'))),
    },
    {
      method: 'POST',
      path: '/api/node/handover/prepare',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.prepare(body))
      },
    },
    {
      method: 'PUT',
      path: '/api/node/handover/bundle',
      async handle(req) {
        const id = req.headers.get('x-handover-id') ?? ''
        const sha = req.headers.get('x-handover-sha256') ?? ''
        return answer(await h.putBundle(id, sha, req.body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/apply',
      async handle(req) {
        const body = await jsonUpTo(req, HANDOVER_JSON_MAX)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.apply(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/verify',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.verify(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/commit',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.commit(body, doorMaster(req)?.id))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/rollback',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.rollback(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/pair',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.pair(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/unpair',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.unpair(body, doorMaster(req)?.id))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/probe',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.probe(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/handover/relay',
      async handle(req) {
        const body = await jsonUpTo(req, 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await h.relay(body))
      },
    },
  ]
}

const PILOT_RUN = /^\/api\/node\/pilot-call\/([A-Za-z0-9_-]{8,64})\/(stdin|mcp-reply|close)$/
const PILOT_EVENTS = /^\/api\/node\/pilot-call\/([A-Za-z0-9_-]{8,64})\/events$/

async function jsonUpTo(req: Request, max: number): Promise<unknown> {
  const bytes = await bytesUpTo(req, max)
  if (!bytes) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** Node door routes for running a MokuPilot call agent on this node (#618). */
function pilotCallDoorRoutes(pc: NodePilotCall): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/node/pilot-call/check',
      async handle(req) {
        const body = await jsonUpTo(req, 1024 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await pc.check(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/pilot-call/start',
      async handle(req) {
        const body = await jsonUpTo(req, 1024 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await pc.start(body))
      },
    },
    {
      method: 'GET',
      path: PILOT_EVENTS,
      handle: (req, ctx) => pc.events(ctx.params[0] ?? '', req),
    },
    {
      method: 'POST',
      path: PILOT_RUN,
      async handle(req, ctx) {
        const runId = ctx.params[0] ?? ''
        const op = ctx.params[1] ?? ''
        const max =
          op === 'stdin' ? MAX_STDIN_LINE_BYTES + 4096 : op === 'mcp-reply' ? MAX_MCP_BODY_BYTES + 4096 : 1024 * 1024
        const body = await jsonUpTo(req, max)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        if (op === 'stdin') return answer(pc.stdin(runId, body))
        if (op === 'mcp-reply') return answer(pc.mcpReply(runId, body))
        return answer(pc.close(runId, body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/pilot-call/files',
      async handle(req) {
        const body = await jsonUpTo(req, MAX_CALL_FILES_REQUEST_BYTES)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(pc.uploadFiles(body))
      },
    },
    {
      method: 'POST',
      path: '/api/node/pilot-call/report',
      async handle(req) {
        const body = await jsonUpTo(req, 1024 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await pc.deliverReport(body))
      },
    },
  ]
}

const PILOT_BRIDGE_BODY = /^\/api\/node\/pilot-bridge\/req\/([A-Za-z0-9_-]{8,64})\/body$/
const PILOT_BRIDGE_RES = /^\/api\/node\/pilot-bridge\/res\/([A-Za-z0-9_-]{8,64})$/
const PILOT_BRIDGE_STREAM = /^\/api\/node\/pilot-bridge\/stream\/([A-Za-z0-9_-]{8,64})$/

/** Node door routes for MokuPilot running on this node reaching a remote master (#700). */
function pilotBridgeDoorRoutes(pb: NodePilotBridge): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/node/pilot-bridge',
      handle: req => pb.stream(req),
    },
    {
      method: 'GET',
      path: PILOT_BRIDGE_BODY,
      handle: (_req, ctx) => pb.reqBody(ctx.params[0] ?? ''),
    },
    {
      method: 'POST',
      path: PILOT_BRIDGE_RES,
      async handle(req, ctx) {
        const body = await jsonUpTo(req, MAX_BRIDGE_RESPONSE_BYTES + 4096)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(pb.respond(ctx.params[0] ?? '', body))
      },
    },
    {
      method: 'POST',
      path: PILOT_BRIDGE_STREAM,
      async handle(req, ctx) {
        const body = await jsonUpTo(req, MAX_BRIDGE_STREAM_BATCH_BYTES + 4096)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await pb.streamChunk(ctx.params[0] ?? '', body, req.signal))
      },
    },
  ]
}

const MASTER_RELAY_BODY = /^\/api\/node\/master-relay\/req\/([A-Za-z0-9_-]{8,64})\/body$/
const MASTER_RELAY_RES = /^\/api\/node\/master-relay\/res\/([A-Za-z0-9_-]{8,64})$/
const MASTER_RELAY_STREAM = /^\/api\/node\/master-relay\/stream\/([A-Za-z0-9_-]{8,64})$/

/** The master's feature flags (#775): a small JSON body, kept by the node beside its config. */
function masterFlagsDoorRoute(flags: Pick<NodeMasterFlags, 'take'>): Route {
  return {
    method: 'POST',
    path: '/api/node/master-flags',
    async handle(req) {
      const body = await jsonUpTo(req, 16 * 1024)
      if (body === undefined) return json(413, { ok: false, error: 'too-big' })
      return answer(flags.take(body))
    },
  }
}

/** The owner's desk (#788): the master's ask for this computer's idle time, and its notifications. */
function deskDoorRoutes(desk: NodeDesk): Route[] {
  return [
    { method: 'GET', path: '/api/node/desk', handle: async () => json(200, await desk.answer()) },
    {
      method: 'POST',
      path: '/api/node/desk-toast',
      async handle(req) {
        const body = await jsonUpTo(req, 16 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(desk.toast(body))
      },
    },
  ]
}

/** The door's side of the relay to the master (#764, services/node/master-relay.ts): the master's stream and its answers. */
function masterRelayDoorRoutes(relay: MasterRelay): Route[] {
  return [
    { method: 'GET', path: '/api/node/master-relay', handle: req => relay.stream(req) },
    { method: 'GET', path: MASTER_RELAY_BODY, handle: (_req, ctx) => relay.reqBody(ctx.params[0] ?? '') },
    {
      method: 'POST',
      path: MASTER_RELAY_RES,
      async handle(req, ctx) {
        // A whole answer, base64, and its head.
        const body = await jsonUpTo(req, Math.ceil(RELAY_ANSWER_MAX / 3) * 4 + 64 * 1024)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(relay.respond(ctx.params[0] ?? '', body))
      },
    },
    {
      method: 'POST',
      path: MASTER_RELAY_STREAM,
      async handle(req, ctx) {
        const body = await jsonUpTo(req, Math.ceil(RELAY_CHUNK_MAX / 3) * 4 + 4096)
        if (body === undefined) return json(413, { ok: false, error: 'too-big' })
        return answer(await relay.chunk(ctx.params[0] ?? '', body, req.signal))
      },
    },
  ]
}

/**
 * The master relay's route on a node (#764): first in the board's own route table, which the phones'
 * listener and the tunnel share; a request that is not the relay's goes on to the next route.
 */
export function masterRelayRoute(
  relay: MasterRelay,
  /** What went up and how the master answered it (#784: a decision's change shows on the page at once). */
  relayed?: (method: string, rawPath: string, status: number) => void,
): Route {
  return {
    method: 'ANY',
    path: /^\/api\//,
    async handle(req, ctx) {
      const res = await relay.relay(req, {
        rawPath: ctx.rawPath,
        search: ctx.url.search,
        remote: ctx.remote,
        refuse: guard => ctx.refuse(guard),
      })
      if (res && relayed) relayed(req.method, ctx.rawPath, res.status)
      return res
    },
  }
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

/**
 * `POST /api/node/bundle/<profile>/secrets` (#604): the values come here and go straight to the
 * node's env file and files. No answer holds one, nothing logs the body, and a parse error's text,
 * which may quote it, is not passed on.
 */
function secretsRoute(secrets: NodeSecrets, own: () => boolean): Route {
  return {
    method: 'POST',
    path: /^\/api\/node\/bundle\/([^/]+)\/secrets$/,
    async handle(req, ctx) {
      if (own()) return ownProfiles()
      const bytes = await bytesUpTo(req, MAX_SECRETS_BYTES)
      if (!bytes) return json(413, { error: 'too-big' })
      let body: unknown
      try {
        body = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        return json(400, { error: 'secrets' })
      }
      try {
        return answer(await secrets.give(ctx.params[0] ?? '', body, doorMaster(req)?.id))
      } catch {
        return json(500, { error: 'server' })
      }
    },
  }
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

/** A JSON body of at most MAX_MANIFEST_BYTES (a move's pack lists every file of a session), or undefined. */
async function bigJson(req: Request): Promise<unknown> {
  const bytes = await bytesUpTo(req, MAX_MANIFEST_BYTES)
  if (!bytes) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

const SESSION = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'

/**
 * A session moved to or from another device (#616, services/move-out.ts, services/move-in.ts): the
 * source's pack, a file of it, the call-off and the finish; the target's check, a blob by its hash,
 * the commit, the settle and its start's state. The master carries the files between them.
 */
function moveRoutes(m: { out: MoveOut; in: MoveIn }): Route[] {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return [
    {
      method: 'POST',
      path: '/api/node/move/out',
      async handle(_req, ctx) {
        const body = await ctx.rawBody().catch(() => null)
        if (!isRecord(body)) return json(400, { ok: false, why: 'body' })
        return json(200, await m.out.pack(text(body.key), text(body.from), body.dryRun === true))
      },
    },
    {
      method: 'GET',
      path: new RegExp(`^/api/node/move/out/${SESSION}/file/(\\d{1,5})$`),
      async handle(_req, ctx) {
        const abs = m.out.file(ctx.params[0] ?? '', Number(ctx.params[1]))
        if (!abs) return json(404, { ok: false, why: 'file' })
        return new Response(Bun.file(abs).stream(), { headers: { 'content-type': 'application/octet-stream' } })
      },
    },
    {
      method: 'POST',
      path: new RegExp(`^/api/node/move/out/${SESSION}/abort$`),
      handle: async (_req, ctx) => json(200, await m.out.abort(ctx.params[0] ?? '')),
    },
    {
      method: 'POST',
      path: new RegExp(`^/api/node/move/out/${SESSION}/finish$`),
      async handle(_req, ctx) {
        const body = await ctx.rawBody().catch(() => null)
        return json(200, await m.out.finish(ctx.params[0] ?? '', isRecord(body) ? text(body.to) : ''))
      },
    },
    {
      method: 'POST',
      path: '/api/node/move/in/check',
      async handle(req) {
        const body = await bigJson(req)
        return json(200, await m.in.check(isRecord(body) ? body.pack : undefined))
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/node\/move\/in\/blob\/([0-9a-f]{64})$/,
      handle: async (req, ctx) => json(200, await m.in.put(ctx.params[0] ?? '', req.body)),
    },
    {
      method: 'POST',
      path: '/api/node/move/in/commit',
      async handle(req) {
        const body = await bigJson(req)
        return json(200, await m.in.commit(isRecord(body) ? body.pack : undefined))
      },
    },
    {
      method: 'POST',
      path: '/api/node/move/in/settle',
      async handle(req) {
        const body = await bigJson(req)
        return json(200, m.in.settle(isRecord(body) ? body.pack : undefined))
      },
    },
    {
      method: 'GET',
      path: /^\/api\/node\/move\/in\/launch\/([\w-]{1,64})$/,
      handle: (_req, ctx) => json(200, { state: m.in.launchState(ctx.params[0] ?? '') }),
    },
  ]
}
