// The board's own probe through the owner's domain (spec, "And that the domain reaches this
// board", Test connection's step 3): a GET of https://<domain>/api/probe/<nonce> (with the public
// port, when it is not 443) from the PC, which only this board answers, with that nonce.
// BOARD_TUNNEL_PROBE_ORIGIN names another origin (tests).
import { type ProbeResult, publicOrigin, type TunnelConfig } from '../core/tunnel.ts'
import { isRecord } from './json-store.ts'

export const PROBE_TIMEOUT_MS = 10_000
/** The answer is a few dozen bytes: more than this is read no further. */
const BODY_BYTES = 16 << 10
/** How much of another answer the detail keeps. */
const DETAIL_CHARS = 200

/** Where the probe goes: BOARD_TUNNEL_PROBE_ORIGIN, else the domain's own origin (publicOrigin). */
export const probeOrigin = (c: TunnelConfig, env: Record<string, string | undefined> = process.env): string =>
  env.BOARD_TUNNEL_PROBE_ORIGIN || publicOrigin(c)

/**
 * Where a Test that finds the public port ("Do it myself") probes on `port`: BOARD_TUNNEL_PROBE_ORIGIN
 * as it is, else https://<domain>, with the port unless it is 443.
 */
export const probeOriginAt = (
  c: TunnelConfig,
  port: number,
  env: Record<string, string | undefined> = process.env,
): string => env.BOARD_TUNNEL_PROBE_ORIGIN || (port === 443 ? `https://${c.domain}` : `https://${c.domain}:${port}`)

/** The body's first BODY_BYTES at most, as text. */
async function bodyStart(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    text += decoder.decode(value, { stream: true })
    if (size >= BODY_BYTES) {
      void reader.cancel().catch(() => {})
      break
    }
  }
  return text + decoder.decode()
}

function isAnswer(text: string, nonce: string): boolean {
  try {
    const v: unknown = JSON.parse(text)
    return isRecord(v) && v.board === 'agent-board' && v.probe === nonce
  } catch {
    return false
  }
}

/** The error's code and message, once each. */
function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = isRecord(err) && typeof err.code === 'string' ? err.code : ''
  return code && !message.includes(code) ? `${code}: ${message}` : message
}

/**
 * GET <origin>/api/probe/<nonce>, redirects not followed, within `timeoutMs`: ok when this board
 * answered with that nonce; else what came back (another status, another answer, a TLS error, or
 * none at all). Never throws. `host`: the Host to send instead of the origin's (a probe on another
 * port than the one the tunnel listener takes the domain on).
 */
export async function fetchProbe(
  origin: string,
  nonce: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  host?: string,
): Promise<ProbeResult> {
  const url = `${origin.replace(/\/+$/, '')}/api/probe/${encodeURIComponent(nonce)}`
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...(host !== undefined && { headers: { host } }),
    })
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {})
      return { ok: false, kind: 'status', status: res.status, detail: String(res.status) }
    }
    const text = await bodyStart(res)
    if (isAnswer(text, nonce)) return { ok: true }
    const said = text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_CHARS)
    return { ok: false, kind: 'answer', detail: said || 'an empty answer' }
  } catch (err) {
    const detail = errorDetail(err)
    return { ok: false, kind: /cert|ssl|tls/i.test(detail) ? 'tls' : 'network', detail }
  }
}
