// What the board's remote listeners share (server/remote.ts: Tailscale and serve; server/tunnel.ts:
// the owner's domain): a path decoded, what they refuse whoever calls, what a desk may ask of
// /api/remote, and event streams that end the moment the caller's pairing or login does.
import { isRecord } from '../adapters/json-store.ts'
import { DESK_REMOTE_OPS, deskFocus, desktopOnly, localOnly, ownerTeam, ownerThreads } from '../core/remote.ts'
import { json, readBody } from './http.ts'
import { namedEvent } from './sse.ts'

/** The path decoded; null when it does not decode (a 400). */
export function decoded(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * What a remote caller is refused, paired or signed in: what acts on this computer's screen
 * (403 desktop) and what is for the board on this computer only (403 local). The routes match a
 * string path decoded and a RegExp one as it came, so both spellings are checked, or an encoded
 * letter (/api/fs/%6Fpen, /api/%61ccess) would get by. A desk (RemoteDevice.desk) may focus herdr
 * and reach /api/remote, whose ops deskOpRefusal narrows for it (DESK_REMOTE_OPS): a listener that
 * passes `desk` must call deskOpRefusal right after this, or a desk gets every op of /api/remote.
 * The tunnel never passes it (test/server/tunnel.test.ts says so).
 */
export function remoteRefusal(
  raw: string,
  path: string,
  desk = false,
  teamOwner = false,
  owner = false,
  ownerAdmin = false,
): Response | null {
  const focus = desk && deskFocus(raw) && deskFocus(path)
  if (!focus && (desktopOnly(raw) || desktopOnly(path))) return json(403, { error: 'desktop' })
  // Headless master (#694): owner's own strong login with remote.ownerAdmin on may use localOnly admin routes.
  if (ownerAdmin) return null
  const pairing = desk && raw === '/api/remote' && path === '/api/remote'
  // The owner's own login, with the team on, reads and writes the team as on the computer (#355).
  const team = teamOwner && ownerTeam(raw) && ownerTeam(path)
  // The owner's own login reads and writes threads as on the computer (#392).
  const threads = owner && ownerThreads(raw) && ownerThreads(path)
  if (!pairing && !team && !threads && (localOnly(raw) || localOnly(path))) return json(403, { error: 'local' })
  return null
}

/**
 * What a desk is refused of POST /api/remote once remoteRefusal let it through: every op but
 * answering the phones that ask and unpairing (DESK_REMOTE_OPS). A body that is not a JSON object
 * (null, a string, a broken or oversized one) is no such op: refused like any other, never a 500.
 */
export async function deskOpRefusal(req: Request, raw: string): Promise<Response | null> {
  if (req.method !== 'POST' || raw !== '/api/remote') return null
  const body = await readBody(req.clone()).catch(() => null)
  return DESK_REMOTE_OPS.has(isRecord(body) ? body.op : undefined) ? null : json(403, { error: 'local' })
}

const SAFE_OP = /^[a-z0-9][a-z0-9._-]{0,47}$/i

/** Short `op` field from a mutating JSON request for the audit log, without reading or logging any other field (#694). */
export async function adminOpOf(req: Request): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const body = await readBody(req.clone()).catch(() => null)
  const op = isRecord(body) ? body.op : undefined
  return typeof op === 'string' && SAFE_OP.test(op) ? op : undefined
}

/**
 * `res` as it is, unless it is an event stream (the board's events, a terminal): then one that
 * ends, after an `unpaired` event, once `watch` says so; `headers` added to it. `watch(gone)`
 * calls `gone` when the caller's pairing or login ends, and returns its unwatch.
 */
export function endsWhenGone(
  res: Response,
  watch: (gone: () => void) => () => void,
  headers: Record<string, string> = {},
): Response {
  if (!res.body || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return res
  const reader = res.body.getReader()
  let unwatch = (): void => {}
  let done = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unwatch = watch(() => {
        if (done) return
        done = true
        try {
          controller.enqueue(new TextEncoder().encode(namedEvent('unpaired', {})))
          controller.close()
        } catch {}
        void reader.cancel().catch(() => {})
      })
    },
    async pull(controller) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (done) return
      if (next.done) {
        done = true
        unwatch()
        return controller.close()
      }
      controller.enqueue(next.value)
    },
    cancel() {
      done = true
      unwatch()
      return reader.cancel()
    },
  })
  const all = new Headers(res.headers)
  for (const [name, value] of Object.entries(headers)) all.set(name, value)
  return new Response(stream, { status: res.status, headers: all })
}
