// What the board's remote listeners share (server/remote.ts: Tailscale and serve; server/tunnel.ts:
// the owner's domain): a path decoded, what they refuse whoever calls, and event streams that end
// the moment the caller's pairing or login does.
import { deskFocus, desktopOnly, localOnly, secretsPath } from '../core/remote.ts'
import { json } from './http.ts'
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
 * (403 desktop) and what is for the board on this computer only (403 local); the owner's secret
 * store too (403 local), unless `secrets` lets them by: the board's own server's login listener.
 * The routes match a string path decoded and a RegExp one as it came, so both spellings are
 * checked, or an encoded letter (/api/fs/%6Fpen, /api/%61ccess) would get by. A desk
 * (RemoteDevice.desk) may focus herdr and reach /api/remote, whose ops the listener narrows for it
 * (DESK_REMOTE_OPS).
 */
export function remoteRefusal(
  raw: string,
  path: string,
  { desk = false, secrets = false }: { desk?: boolean; secrets?: boolean } = {},
): Response | null {
  const focus = desk && deskFocus(raw) && deskFocus(path)
  if (!focus && (desktopOnly(raw) || desktopOnly(path))) return json(403, { error: 'desktop' })
  const pairing = desk && raw === '/api/remote' && path === '/api/remote'
  if (!pairing && (localOnly(raw) || localOnly(path))) return json(403, { error: 'local' })
  if (!secrets && (secretsPath(raw) || secretsPath(path))) return json(403, { error: 'local' })
  return null
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
