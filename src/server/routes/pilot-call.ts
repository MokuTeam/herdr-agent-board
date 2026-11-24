// Local-only HTTP bridge for MokuPilot calls (#618, #700).
// Served ONLY on the web board's own 127.0.0.1 listener (server/app.ts), never on the phones
// listener, never through the tunnel, and never on a node's door. Every grant route requires its
// per-call Bearer token; /open requires X-Board: 1; every route rejects browser Origin headers.
import { MAX_CALL_FILES_REQUEST_BYTES, MAX_MCP_BODY_BYTES, MAX_STDIN_LINE_BYTES } from '../../core/pilot-call.ts'
import type { NodeBridgeGrant, NodePilotBridge } from '../../services/node/pilot-bridge.ts'
import type { NodePilotCallGrant, NodePilotCalls } from '../../services/nodes/pilot-call.ts'
import { json, type Route } from '../http.ts'

const MAX_SMALL_JSON = 1024 * 1024

export interface PilotCallRouteSources {
  master?: NodePilotCalls | null
  node?: NodePilotBridge | null
}

async function readTextUpTo(req: Request, max: number): Promise<string | null> {
  const told = Number(req.headers.get('content-length'))
  if (Number.isFinite(told) && told > max) return null
  if (!req.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req.body) {
    size += chunk.byteLength
    if (size > max) return null
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function refuseBrowser(req: Request): Response | null {
  // Native MokuPilot client sends no Origin; refuse any browser cross-origin/same-origin attempt.
  if (req.headers.has('origin')) return json(403, { ok: false, error: 'origin not allowed' })
  return null
}

const OPEN = '/api/mokupilot/node-call/open'
const SESSIONS = '/api/mokupilot/node-call/sessions'
const START = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/start$/
const EVENTS = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/runs\/([A-Za-z0-9_-]{8,64})\/events$/
const RUN_POST =
  /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/runs\/([A-Za-z0-9_-]{8,64})\/(stdin|mcp-reply|close)$/
const FILES = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/files$/
const REPORT = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/report$/
const END = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/end$/

type Authorized =
  | { kind: 'master'; grant: NodePilotCallGrant; master: NodePilotCalls }
  | { kind: 'node'; grant: NodeBridgeGrant; node: NodePilotBridge }

export function pilotCallRoutes(input: PilotCallRouteSources | NodePilotCalls): Route[] {
  const sources: PilotCallRouteSources = 'startForItem' in input ? { master: input } : input

  const auth = (req: Request, grantId: string): { err: Response } | Authorized => {
    const originErr = refuseBrowser(req)
    if (originErr) return { err: originErr }
    const header = req.headers.get('authorization')
    if (sources.master) {
      const grant = sources.master.authorize(grantId, header)
      if (grant) return { kind: 'master', grant, master: sources.master }
    }
    if (sources.node) {
      const grant = sources.node.authorize(grantId, header)
      if (grant) return { kind: 'node', grant, node: sources.node }
    }
    return { err: json(401, { ok: false, error: 'unauthorized' }) }
  }

  return [
    {
      method: 'POST',
      path: OPEN,
      async handle(req) {
        const originErr = refuseBrowser(req)
        if (originErr) return originErr
        if (req.headers.get('x-board') !== '1') return json(403, { ok: false, error: 'header' })
        const raw = await readTextUpTo(req, MAX_SMALL_JSON)
        if (raw === null) return json(413, { ok: false, error: 'too large' })
        let body: unknown
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          return json(400, { ok: false, error: 'invalid json' })
        }
        if (sources.master) return sources.master.openLocal(body)
        if (sources.node) return sources.node.open(body)
        return json(404, { ok: false, error: 'not found' })
      },
    },
    {
      method: 'GET',
      path: SESSIONS,
      async handle(req) {
        const originErr = refuseBrowser(req)
        if (originErr) return originErr
        if (sources.master) return json(200, { ok: true, sessions: sources.master.listSessions(), masterOnline: true })
        if (sources.node) return sources.node.sessions()
        return json(404, { ok: false, error: 'not found' })
      },
    },
    {
      method: 'POST',
      path: START,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        const raw = await readTextUpTo(req, MAX_SMALL_JSON)
        if (raw === null) return json(413, { ok: false, error: 'too large' })
        let body: unknown
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          return json(400, { ok: false, error: 'invalid json' })
        }
        return a.kind === 'master' ? a.master.startRun(a.grant, body) : a.node.startRun(a.grant, body)
      },
    },
    {
      method: 'GET',
      path: EVENTS,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        const runId = ctx.params[1] ?? ''
        return a.kind === 'master' ? a.master.events(a.grant, runId, req) : a.node.events(a.grant, runId, req)
      },
    },
    {
      method: 'POST',
      path: RUN_POST,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        const action = (ctx.params[2] ?? '') as 'stdin' | 'mcp-reply' | 'close'
        const limit =
          action === 'stdin'
            ? MAX_STDIN_LINE_BYTES + 4096
            : action === 'mcp-reply'
              ? MAX_MCP_BODY_BYTES + 4096
              : MAX_SMALL_JSON
        const raw = await readTextUpTo(req, limit)
        if (raw === null) return json(413, { ok: false, error: 'too large' })
        const runId = ctx.params[1] ?? ''
        return a.kind === 'master'
          ? a.master.runPost(a.grant, runId, action, raw || '{}')
          : a.node.runPost(a.grant, runId, action, raw || '{}')
      },
    },
    {
      method: 'POST',
      path: FILES,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        const raw = await readTextUpTo(req, MAX_CALL_FILES_REQUEST_BYTES)
        if (raw === null) return json(413, { ok: false, error: 'too large' })
        return a.kind === 'master'
          ? a.master.uploadFiles(a.grant, raw || '{}')
          : a.node.uploadFiles(a.grant, raw || '{}')
      },
    },
    {
      method: 'POST',
      path: REPORT,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        const raw = await readTextUpTo(req, MAX_SMALL_JSON)
        if (raw === null) return json(413, { ok: false, error: 'too large' })
        let body: unknown
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          return json(400, { ok: false, error: 'invalid json' })
        }
        return a.kind === 'master' ? a.master.deliverReport(a.grant, body) : a.node.deliverReport(a.grant, body)
      },
    },
    {
      method: 'POST',
      path: END,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        return a.kind === 'master' ? a.master.end(a.grant) : a.node.end(a.grant)
      },
    },
  ]
}
