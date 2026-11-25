// `board` on a node for what is the master's (#786, epic #763 T4b): another machine's session
// (sleep, archive, fork) and Devices (board nodes, board update). These go to this computer's own
// board, whose relay hands them to the master (core/master-relay.ts); this computer's own sessions
// stay with the commands' own code, as before. Nothing here runs on a board without `node`.
import { parseNodeKey } from '../core/node-key.ts'

/** Whether one of `targets` is a session of another machine than `self` (`@<device>:<key>`). */
export function foreignTargets(targets: readonly string[], self: string): boolean {
  return targets.some(t => {
    const at = parseNodeKey(t)
    return !!at && at.device !== self
  })
}

/** The answer of this computer's board, or null when none answered. */
export async function boardCall(
  port: unknown,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; ms?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const base = `http://127.0.0.1:${typeof port === 'number' ? port : 12422}`
  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.ms ?? 30_000),
    })
    const body: unknown = await res.json().catch(() => null)
    return {
      status: res.status,
      body: typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
    }
  } catch {
    return null
  }
}

/** The relay's own refusal as one plain line (the master away, or its owner turned this computer off). */
export function relayLine(r: { status: number; body: Record<string, unknown> }): string | null {
  if (r.body.error === 'node-master-offline') return "the board's computer is not reachable from here now"
  if (
    typeof r.body.error === 'string' &&
    r.body.error.startsWith('master-relay-') &&
    typeof r.body.message === 'string'
  )
    return r.body.message
  return null
}
