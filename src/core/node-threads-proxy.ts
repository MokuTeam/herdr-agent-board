// Pure protocol validation for node-to-master threads read proxy (#759).
// No I/O here: used by both the node door/routes (services/node/threads-proxy.ts) and the
// master runner (services/nodes/threads-proxy.ts).

export const THREADS_PROXY_ID = /^[A-Za-z0-9_-]{8,64}$/
export const MAX_THREADS_PROXY_RESPONSE_BYTES = 8 * 1024 * 1024
export const THREADS_PROXY_TIMEOUT_MS = 10_000

export interface ThreadsProxyRequest {
  id: string
  path: string
  query: string
}

export interface ThreadsProxyResponse {
  status: number
  contentType: string
  body: string
}

export interface ThreadsProxyRev {
  on: boolean
  rev: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const hasControl = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function isThreadsProxyId(v: unknown): v is string {
  return typeof v === 'string' && THREADS_PROXY_ID.test(v)
}

/**
 * Only GET /api/threads and GET /api/threads/<single-segment> (excluding /api/threads/events)
 * are valid read paths over the proxy.
 */
export function isAllowedThreadsReadPath(rawPath: unknown): rawPath is string {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 512 || hasControl(rawPath)) return false
  if (rawPath === '/api/threads') return true
  const m = /^\/api\/threads\/([^/]+)$/.exec(rawPath)
  if (!m) return false
  let seg: string
  try {
    seg = decodeURIComponent(m[1] ?? '')
  } catch {
    return false
  }
  if (!seg || seg === 'events' || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\')) return false
  return !hasControl(seg)
}

export function isAllowedThreadsQuery(query: unknown): query is string {
  if (typeof query !== 'string' || query.length > 2048 || hasControl(query)) return false
  return query === '' || query.startsWith('?')
}

export function parseThreadsProxyRequest(raw: unknown): ThreadsProxyRequest | null {
  if (!isRecord(raw)) return null
  if (!isThreadsProxyId(raw.id)) return null
  if (!isAllowedThreadsReadPath(raw.path)) return null
  const query = raw.query === undefined ? '' : raw.query
  if (!isAllowedThreadsQuery(query)) return null
  return { id: raw.id, path: raw.path, query }
}

export function parseThreadsProxyResponse(raw: unknown): ThreadsProxyResponse | null {
  if (!isRecord(raw)) return null
  const status = raw.status
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) return null
  const contentType =
    typeof raw.contentType === 'string' && raw.contentType.trim() && !hasControl(raw.contentType)
      ? raw.contentType.trim().slice(0, 128)
      : 'application/json; charset=utf-8'
  const body = typeof raw.body === 'string' ? raw.body : ''
  if (Buffer.byteLength(body, 'utf8') > MAX_THREADS_PROXY_RESPONSE_BYTES) return null
  return { status: status as number, contentType, body }
}

export function parseThreadsProxyRev(raw: unknown): ThreadsProxyRev | null {
  if (!isRecord(raw)) return null
  if (typeof raw.on !== 'boolean') return null
  if (!Number.isSafeInteger(raw.rev) || (raw.rev as number) < 0) return null
  return { on: raw.on, rev: raw.rev as number }
}
