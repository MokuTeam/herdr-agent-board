// Master's local-only HTTP bridge for MokuPilot calls with node sessions (#618).
// Served ONLY on the web board's own 127.0.0.1 listener (server/app.ts), never on the phones
// listener, never through the tunnel, and never on a node's door. Every route requires the
// per-call Bearer token minted by services/nodes/pilot-call.ts and rejects browser Origin headers.
import { MAX_CALL_FILES_REQUEST_BYTES, MAX_MCP_BODY_BYTES, MAX_STDIN_LINE_BYTES } from '../../core/pilot-call.ts'
import type { NodePilotCalls } from '../../services/nodes/pilot-call.ts'
import { json, type Route } from '../http.ts'

const MAX_SMALL_JSON = 1024 * 1024

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

const START = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/start$/
const EVENTS = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/runs\/([A-Za-z0-9_-]{8,64})\/events$/
const RUN_POST =
  /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/runs\/([A-Za-z0-9_-]{8,64})\/(stdin|mcp-reply|close)$/
const FILES = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/files$/
const REPORT = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/report$/
const END = /^\/api\/mokupilot\/node-call\/([A-Za-z0-9_-]{8,64})\/end$/

export function pilotCallRoutes(bridge: NodePilotCalls): Route[] {
  const auth = (req: Request, grantId: string) => {
    const originErr = refuseBrowser(req)
    if (originErr) return { err: originErr }
    const grant = bridge.authorize(grantId, req.headers.get('authorization'))
    if (!grant) return { err: json(401, { ok: false, error: 'unauthorized' }) }
    return { grant }
  }

  return [
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
        return bridge.startRun(a.grant, body)
      },
    },
    {
      method: 'GET',
      path: EVENTS,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        return bridge.events(a.grant, ctx.params[1] ?? '', req)
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
        return bridge.runPost(a.grant, ctx.params[1] ?? '', action, raw || '{}')
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
        return bridge.uploadFiles(a.grant, raw || '{}')
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
        return bridge.deliverReport(a.grant, body)
      },
    },
    {
      method: 'POST',
      path: END,
      async handle(req, ctx) {
        const a = auth(req, ctx.params[0] ?? '')
        if ('err' in a) return a.err
        return bridge.end(a.grant)
      },
    },
  ]
}
